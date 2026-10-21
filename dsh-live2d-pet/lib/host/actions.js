/**
 * AI 指令的归一化与校验 —— P3「AI 控制闭环」的契约层。
 *
 * ⚠️ 硬约束：**不碰任何 `node:` 内置模块**（唯一的 import 见下）。
 *
 * 理由与 `capabilities.js` 完全相同，但这一份更严重：客户端 bundle 会**内联**这个文件，
 * 一旦有人在这里写 `import fs from 'node:fs'`，esbuild 会当场构建失败。这是刻意选的
 * 失败方式 —— 构建时炸掉，而不是运行时让桌宠消失（方案文档 §9.2 那次白屏事故）。
 *
 * 唯一的 import 是 `./emotions.js`（情绪预设表）：它同样是**纯数据 + 纯函数、零
 * import**，内联进客户端 bundle 只是几 KB 常量。情绪名在这里解析而不是放在
 * `lib/index.js` 的工具回调里，是为了守住本文件开头那条规矩 ——「这条指令合不合法」
 * 只能有一个地方说了算，别的层（工具、门禁、渲染端）只许转述它的结论。
 *
 * 分成 Host / Client 两份实现是不行的：Host 用同一份函数决定「这条指令能不能发」，
 * 客户端用同一份决定「收到这条指令该怎么落地」。两份一旦漂移，症状是
 * 「Host 说这条指令合法、客户端照着做却什么都不发生」——而它不报任何错。
 *
 * 这一层回答的是**方案 §4.1 的硬规则**：
 *   1. `ParamMouthOpenY` / `ParamMouthForm` 由 TTS 口型通道独占，AI 写入一律丢弃；
 *   2. 错误必须「可自愈」（`E_EXPRESSION_NOT_FOUND` 必须带可用表达式列表）；
 *   3. 工具立即返回（本模块不涉及等待，只负责判断）。
 */

import { canonicalEmotionName, emotionCatalogText, resolveEmotion } from './emotions.js';

/**
 * 内部指令类型。`say` 由 `live2d_speak` 产生，其余对应 §4.1 的各个工具。
 *
 * `microMotion` 是 §13.30 新加的一种：微动作包（`lib/host/micro-motions.js`）里
 * 的一条，由 AI 或面板「试演」按钮点名演出。它**不引用模型能力**（参数表在
 * 生成包的时候已经核对过），所以校验只到「id 是不是个像样的短串」为止 ——
 * 「这个模型有没有这一条」由 Host 拿着包回答（`playMicroMotionById()`）。
 */
export const ACTION_KINDS = Object.freeze([
  'say', 'motion', 'expression', 'look', 'emotion', 'param', 'microMotion', 'stop', 'idle',
]);

/** `microMotion` 的 id 长度上限。生成器用 kebab-case，24 字符已经很长了。 */
export const MAX_MICRO_MOTION_ID_CHARS = 64;

/**
 * 优先级：50 = 表达性动作（可以排队、可以被覆盖），100 = 必须立即执行（打断）。
 *
 * 这两个数字直接来自方案 §4.1 的 ActionCommand 示例。中间值留给以后
 * （例如「用户直接说的话」应该比「AI 自发的动作」高）。
 */
export const PRIORITY = Object.freeze({ EXPRESSIVE: 50, INTERRUPT: 100 });

/**
 * TTL：指令过期作废。
 *
 * 存在的意义是防止队列堆积执行「迟到的动作」—— 网络卡了 8 秒之后，桌宠突然
 * 开始做 8 秒前 AI 想让它做的事，比什么都不做更糟。4 秒是「一句话的长度」量级。
 */
export const DEFAULT_TTL_MS = 4000;
export const MIN_TTL_MS = 100;
export const MAX_TTL_MS = 60000;

export const DEFAULT_FADE_MS = 300;
export const MAX_FADE_MS = 5000;
/**
 * 视线转过去的默认时长。
 *
 * 400ms 大约就是人转头看一眼的节奏，也接近框架原本那套写死速度
 * （约 4 单位/秒 + 0.15 秒加速）扫完一次的时间 —— 也就是说，默认值下
 * 新旧行为看起来差不多，只有显式传了别的值才分得出来。
 *
 * 提到这里当常量是因为**渲染端也需要同一个数字**：契约里写了默认 400，
 * 两端各写一个 400，某天改了一边，症状是「AI 说慢慢转，实际按旧默认转」。
 */
export const DEFAULT_LOOK_DURATION_MS = 400;
export const MAX_LOOK_DURATION_MS = 5000;
export const MAX_HOLD_MS = 60000;

/*
 * 一句话的文本上限。**这是唯一的定义处。**
 *
 * 它有两个使用者，而这两条路径各自都要拒一次超长文本：
 *   1. `buildAction()`（本文件）—— 工具路径，LLM 交上来的一句话；
 *   2. `synthesize()`（`edge-tts.js`）—— `/speak` 路由，可以绕过工具直接 POST。
 *
 * `edge-tts.js` 原来自己声明了一份同名的 `2000`。两份都写着 2000 的时候看不出
 * 问题，而一旦只改一边，症状是「工具回了一句『已排队』，然后那句话一个字都
 * 没说出来」—— 中间那一层的失败不会回到工具那里。所以它必须只有一份，
 * 由需要的人 import。
 */
export const MAX_TEXT_CHARS = 2000;

/**
 * 一条逃生通道（`params`）里最多几个参数。
 *
 * 上限存在的理由和 `capabilities.js` 的 `MAX_PARAMETERS` 一样：这是要进
 * LLM 上下文的东西，一条指令塞 130 个参数不会有任何好结果，但会让日志与
 * 调试界面变得没法看。
 */
export const MAX_ACTION_PARAMETERS = 32;

/**
 * `live2d_speak` 的 `voice` / `rate` 取值规则 —— **两半区唯一的一份**。
 *
 * 为什么这些正则在这里而不是 `edge-tts.js` 里：
 *   - Host 的**工具入口**（`buildAction()`）要拿它当场告诉 AI「格式不对」，
 *     而不是等 1.2 秒后由 TTS 那一层回一句笼统的网络错误；
 *   - Host 的**适配器**（`lib/host/edge-tts.js`）要拿它做最后一道边界，
 *     因为 `/.dsh-live2d-pet/speak` 是一条公开路由，可以绕过工具直接 POST。
 *   - 本文件零 import、会被内联进客户端 bundle，所以渲染端也能用同一份。
 *
 * 格式从哪来：实测（`tools/_probe-speak.mjs`，已删）打真实 Edge-TTS，
 * `+10%` / `-10%` / `10%`（无符号）都生效且**无符号与带符号的结果逐字节相同**，
 * 所以 `%` 前面的正负号是可选的。`+0%` 与不传 rate 的结果逐字节相同 ——
 * 服务端的默认值就是 `+0%`。
 *
 * 而这些值有一个共同点：**它们要进 SSML 的 XML 属性**。校验只管格式，
 * 真正的安全边界是 `edge-tts.js` 的 `buildSsml()` 对属性值做转义（见那里的注释）。
 */
export const SPEECH_RATE_PATTERN = /^[+-]?\d{1,3}%$/;
export const SPEECH_PITCH_PATTERN = /^[+-]?\d{1,4}Hz$/;
/**
 * 音色 ShortName，例如 `zh-CN-XiaoxiaoNeural`。
 *
 * 刻意**不**按微软的命名规则写死（`^[a-z]{2}-[A-Z]{2}-\w+Neural$`）：那种正则
 * 会在微软改名 / 加新后缀的那天开始误伤，而误伤的代价是「一个本来能用的音色
 * 被判成非法」。这里只保证它是一个「由连字符分段、只含字母数字」的短标识符 ——
 * 足够挡掉注入和明显的垃圾，又不假装我们知道对方的命名规则。
 */
export const VOICE_NAME_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;
export const MAX_VOICE_NAME_CHARS = 64;

export const SPEECH_RATE_HINT = "语速要写成百分比，例如 '+15%' 或 '-10%'";
export const SPEECH_PITCH_HINT = "音高要写成赫兹，例如 '+0Hz' 或 '-50Hz'";
export const VOICE_NAME_HINT = "音色要写成 ShortName，例如 'zh-CN-XiaoxiaoNeural'";

/**
 * 读一个 `say` 的可选字符串字段，并判断它是不是**能安全地送去合成**。
 *
 * 返回 `{ ok, value, detail }`：
 *   - 没给（`undefined` / `null` / 空串）→ `{ ok: true, value: undefined }`，用默认值；
 *   - 给了但不合格式 → `{ ok: false, value: undefined, detail: '<给人看的说明>' }`。
 *
 * **不合格式时是「丢掉这个字段」而不是「拒绝整句话」**：句子本身还能念，
 * 而「换一种语速」只是修饰。让整句话失败等于因为一个形容词就不说话，
 * 对用户更糟。丢掉的字段会进 `droppedParameters`，由 `dispatch()` 翻成人话
 * 回给 LLM —— 这就是 §4.1 硬规则 2「错误必须可自愈」在这条路上的形态。
 *
 * @param {unknown} value
 * @param {RegExp} pattern
 * @param {string} hint
 * @param {number} [maxChars]
 * @returns {{ ok: boolean, value: string | undefined, detail: string }}
 */
export function readSpeechField(value, pattern, hint, maxChars = 0) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined, detail: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, value: undefined, detail: `${hint}（收到的是 ${typeof value}，不是字符串）` };
  }
  if (maxChars > 0 && value.length > maxChars) {
    return { ok: false, value: undefined, detail: `${hint}（收到 ${value.length} 个字符，上限 ${maxChars}）` };
  }
  if (!pattern.test(value)) {
    return { ok: false, value: undefined, detail: `${hint}（收到的是 ${JSON.stringify(value)}，格式不对）` };
  }
  return { ok: true, value, detail: '' };
}

/** `readSpeechField` 的三个具体用法 —— 调用方不必自己记正则与提示语。 */
export function readSpeechRate(value) {
  return readSpeechField(value, SPEECH_RATE_PATTERN, SPEECH_RATE_HINT);
}

export function readSpeechPitch(value) {
  return readSpeechField(value, SPEECH_PITCH_PATTERN, SPEECH_PITCH_HINT);
}

export function readVoiceName(value) {
  return readSpeechField(value, VOICE_NAME_PATTERN, VOICE_NAME_HINT, MAX_VOICE_NAME_CHARS);
}

/**
 * 口型通道独占的参数。
 *
 * ⚠️ 比较时必须**同时忽略大小写和下划线**：官方样本 Wanko 的参数名是全大写的
 * （`PARAM_ANGLE_X`），而 Haru 是驼峰（`ParamAngleX`）。写死精确匹配的话，
 * 这条例外规则会在那些模型上**静默失效** —— AI 写的口型参数被放行，然后与
 * TTS 每帧写入的值打架，症状是「嘴巴抽搐」，而且只在部分模型上出现。
 *
 * 下划线也要吃掉，是因为从别的格式转换过来的模型会写 `PARAM_MOUTH_OPEN_Y` ——
 * 它与 `ParamMouthOpenY` **不**是单纯的大小写差异（中间多四个下划线），
 * 只转小写是拦不住的。门禁第一次跑就抓到了这一点。
 */
export const EXCLUSIVE_PARAMETER_IDS = Object.freeze(['ParamMouthOpenY', 'ParamMouthForm']);

/** 参数名归一化：小写 + 去掉下划线。只用于**比较**，绝不用于回写。 */
export function normalizeParameterKey(id) {
  return typeof id === 'string' ? id.toLowerCase().replace(/_/g, '') : '';
}

export function isExclusiveParameter(id) {
  const needle = normalizeParameterKey(id);
  if (needle === '') return false;
  return EXCLUSIVE_PARAMETER_IDS.some((item) => normalizeParameterKey(item) === needle);
}

/** 工具名 → 指令类型的映射（Host 注册工具与门禁共用，避免两处写错一个字母）。 */
export const TOOL_KINDS = Object.freeze({
  live2d_speak: 'say',
  live2d_play_motion: 'motion',
  live2d_set_expression: 'expression',
  live2d_look_at: 'look',
  live2d_emote: 'emotion',
  live2d_param: 'param',
  live2d_stop_speaking: 'stop',
});

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clampNumber(value, min, max, fallback) {
  return clamp(finiteOr(value, fallback), min, max);
}

export function normalizePriority(value) {
  const raw = finiteOr(value, PRIORITY.EXPRESSIVE);
  // 只认两个档位：中间值一律向上取到 INTERRUPT 更危险，向下取到 EXPRESSIVE
  // 更安全 —— 一条本该打断的指令降级成排队，用户看到的是「慢了一点」；
  // 反过来则会打断用户正在听的那句话。
  return raw >= PRIORITY.INTERRUPT ? PRIORITY.INTERRUPT : PRIORITY.EXPRESSIVE;
}

export function normalizeTtl(value) {
  return Math.round(clampNumber(value, MIN_TTL_MS, MAX_TTL_MS, DEFAULT_TTL_MS));
}

/**
 * 能力清单里有没有这个名字的表达式（大小写敏感）。
 *
 * 大小写**必须敏感**：Cubism 的表达式名是模型作者写的字面量，`Smile` 和
 * `smile` 是两个不同的字符串。这里「宽容」等于把错误推迟到用户面前。
 */
export function findExpression(capabilities, name) {
  const list = Array.isArray(capabilities?.expressions) ? capabilities.expressions : [];
  return list.find((item) => item?.name === name) ?? null;
}

export function findMotionGroup(capabilities, name) {
  const list = Array.isArray(capabilities?.motionGroups) ? capabilities.motionGroups : [];
  return list.find((item) => item?.name === name) ?? null;
}

export function findParameter(capabilities, id) {
  const list = Array.isArray(capabilities?.parameters) ? capabilities.parameters : [];
  return list.find((item) => item?.id === id) ?? null;
}

function nameList(items, pick, limit = 12) {
  const names = items.map(pick).filter((name) => typeof name === 'string' && name !== '');
  if (names.length === 0) return '（无）';
  if (names.length <= limit) return names.join('、');
  return `${names.slice(0, limit).join('、')}…（共 ${names.length} 个）`;
}

/** 出错时给 LLM 看的「你其实可以用这些」。可自愈的关键（§4.1 硬规则 2）。 */
export function availableExpressions(capabilities) {
  const list = Array.isArray(capabilities?.expressions) ? capabilities.expressions : [];
  return nameList(list, (item) => item?.name);
}

export function availableMotionGroups(capabilities) {
  const list = Array.isArray(capabilities?.motionGroups) ? capabilities.motionGroups : [];
  return nameList(list, (item) => `${item?.name}(${item?.count ?? 0} 个动作)`);
}

function fail(code, detail, extra) {
  return { ok: false, code, detail, command: null, ...extra };
}

/**
 * 把一条原始工具调用归一化成内部指令。
 *
 * 返回**扁平形状** `{ ok, code, detail, command, droppedParameters, clampedParameters }`
 * 而不是判别联合：`tsconfig.json` 是 `strict: false`，布尔字面量会被放宽成
 * `boolean`，判别式失效之后 `if (result.ok)` 的 else 分支拿 `result.command`
 * 会报 TS2339。这一条已经在 `PickDecision` 上踩过一次。
 *
 * `capabilities` 为 `null` 时的行为是**刻意设计**的，不是遗漏：
 *   - `say` / `stop` 照常放行 —— 它们不需要知道模型有什么；
 *   - 其余一律 `E_ACTION_NO_CAPABILITIES` 拒绝。
 * 理由：`null` 的意思是「渲染端还没报过清单」（页面没开、模型还在加载），
 * 与「模型确实没有表情」是两件事。此时放行一个 `set_expression("smile")`，
 * 我们既不知道 smile 存不存在、也不知道该给谁看 —— 那是**假成功**。
 * AI 收到这个错误码应该稍后再试，而不是换一个名字继续猜。
 *
 * `options.bindings` 是用户的「角色 → 参数 id」覆盖表（`emotions.js` 的
 * `normalizeEmotionBindings()` 产出）。它只影响 `kind: 'emotion'`，而且只在这个
 * id 真的在模型上时生效 —— 见 `pickRoleParameter()`。默认空对象，所以老调用点
 * 不传也照旧。
 */
export function buildAction(raw, capabilities, options = {}) {
  const kind = typeof raw?.kind === 'string' ? raw.kind : '';
  if (!ACTION_KINDS.includes(kind)) {
    return fail('E_ACTION_UNKNOWN_KIND', `不认识的指令类型 ${JSON.stringify(raw?.kind ?? null)}。`);
  }

  const priority = normalizePriority(raw?.priority);
  const ttlMs = normalizeTtl(raw?.ttlMs);
  const base = { kind, priority, ttlMs, at: Date.now() };

  if (kind === 'stop') {
    return { ok: true, code: '', detail: '', command: { ...base, payload: {} }, droppedParameters: [], clampedParameters: [] };
  }

  if (kind === 'say') {
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (text === '') return fail('E_ACTION_EMPTY_TEXT', '要念的文本是空的。');
    if (text.length > MAX_TEXT_CHARS) {
      return fail('E_ACTION_TEXT_TOO_LONG', `文本 ${text.length} 字，超过上限 ${MAX_TEXT_CHARS} 字。`);
    }

    /*
     * `voice` / `rate` 是**可选修饰**，所以格式不对时丢掉字段、照念句子，
     * 并把原因回给 LLM（见 `readSpeechField` 的注释）。
     *
     * 这两个值最终要插进 SSML 的 XML 属性里（`edge-tts.js` 的 `buildSsml()`），
     * 而这条链原来只检查了「是不是非空字符串」—— 于是一个带单引号的 rate
     * 会让整句话以一句笼统的「语音服务出错了」告终。校验放在这里，
     * AI 当场就能知道该怎么改。
     */
    const dropped = [];
    const voice = readVoiceName(raw?.voice);
    if (!voice.ok) dropped.push({ id: 'voice', reason: 'E_ACTION_SPEECH_VALUE_DROPPED', detail: voice.detail });
    const rate = readSpeechRate(raw?.rate);
    if (!rate.ok) dropped.push({ id: 'rate', reason: 'E_ACTION_SPEECH_VALUE_DROPPED', detail: rate.detail });

    return {
      ok: true,
      code: '',
      detail: '',
      command: {
        ...base,
        payload: {
          text,
          voice: voice.value,
          rate: rate.value,
          interrupt: raw?.interrupt !== false,
        },
      },
      droppedParameters: dropped,
      clampedParameters: [],
    };
  }

  if (kind === 'idle') {
    return {
      ok: true,
      code: '',
      detail: '',
      command: { ...base, payload: { intensity: clampNumber(raw?.intensity, 0, 1, 1) } },
      droppedParameters: [],
      clampedParameters: [],
    };
  }

  if (kind === 'look') {
    /*
     * `look` 和 `say` 一样，**不需要能力清单**：它的参数是一个方向向量，
     * 不引用模型的任何名字。落到哪个参数（`ParamAngleX` / `ParamEyeBallX` /
     * 都没有）由客户端按模型决定；没有对应参数的模型就什么都不发生 ——
     * 那不是假成功，因为「让她看这边」这个意图本身没有指名任何东西。
     *
     * 对比 `expression`：`{name: "smile"}` 必须知道模型有没有 smile，
     * 否则我们就是在对一个不存在的名字宣称成功。
     */
    return {
      ok: true,
      code: '',
      detail: '',
      command: {
        ...base,
        payload: {
          look: {
            x: clampNumber(raw?.x, -1, 1, 0),
            y: clampNumber(raw?.y, -1, 1, 0),
            durationMs: Math.round(
              clampNumber(raw?.durationMs, 0, MAX_LOOK_DURATION_MS, DEFAULT_LOOK_DURATION_MS),
            ),
          },
        },
      },
      droppedParameters: [],
      clampedParameters: [],
    };
  }

  /*
   * `microMotion`：点名演微动作包里的一条。
   *
   * 和 `look` 一样**不需要能力清单** —— 但理由不同：`look` 的意图不指名任何模型
   * 细节；`microMotion` 指名的是**我们自己生成的包**里的一条，而那个包在生成时
   * 就已经按模型参数表裁过了。能力清单在这里再核一遍只会多一个「什么时候该信
   * 谁」的问题。
   *
   * id 只做形状校验（1–64 字符、允许 kebab-case / 下划线 / 点）。**存在性**必须
   * 由调用方拿着当前包回答：这一层没有包，编一个「大概有吧」的成功出来，症状是
   * AI 自信地说「她歪了下头」而画面什么都没发生。
   */
  if (kind === 'microMotion') {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (id === '') {
      return fail('E_ACTION_BAD_VALUE', '这条微动作指令没说要演哪一条（id 是空的）。');
    }
    if (id.length > MAX_MICRO_MOTION_ID_CHARS || !/^[A-Za-z0-9_.-]+$/.test(id)) {
      return fail(
        'E_ACTION_BAD_VALUE',
        `微动作 id ${JSON.stringify(id.slice(0, 80))} 不像我们生成的那种名字（字母数字加 - _ .，最长 ${MAX_MICRO_MOTION_ID_CHARS}）。`,
      );
    }
    return {
      ok: true,
      code: '',
      detail: '',
      command: { ...base, payload: { microMotion: { id } } },
      droppedParameters: [],
      clampedParameters: [],
    };
  }

  // 从这里往下都需要能力清单。
  if (capabilities === null || capabilities === undefined) {
    return fail(
      'E_ACTION_NO_CAPABILITIES',
      '还没读到当前模型的能力清单（模型可能还在加载），所以没法校验这条指令。'
      + '稍后再试，或者先调 live2d_status 看看渲染端是否在线。'
    );
  }

  /*
   * kind === 'emotion'：把「开心」这种词翻译成一组参数**增量**。
   *
   * 与 `param` 的关键差别（也是这一层存在的唯一理由）：
   *   - `param` 是**硬覆盖**，写在每一帧的最后，会盖掉眨眼 / 表情 / 动作自带的
   *     脸部曲线；`emotion` 是**加法**，渲染端用 `addParameterValueById()` 叠上去，
   *     所以「开心」和「正在眨眼」「正在点头」可以同时成立。
   *   - `param` 要求 AI 知道参数名；`emotion` 只要求它知道情绪名。
   *
   * 校验仍然在这里做完：情绪名 → 角色 → 参数 id（按当前模型的能力清单挑）、
   * 按 Core 报的 min/max/def 夹取、口型独占参数一个都不许出现（`emotions.js`
   * 的预设表里本来就没有它们，这里再兜一次底）。
   */
  if (kind === 'emotion') {
    /*
     * 两种用法，**互斥**：
     *   · `name`    —— 装一层新的（「开心一点」）；
     *   · `release` —— 按名字收掉指定的层（「把思考态收掉」）。
     *
     * 为什么 release 必须存在：在这之前「让她脸上少点东西」只有两条路 ——
     * 装一层新的、或者「平静」，两个都是**一把全收**。于是「每一步结束时收掉思考态」
     * 顺手把我点名让她保持 30 秒的「开心」也抹了，一句自动情绪也常常是被下一步的
     * 清空剪断的。该收哪一层本来就知道，缺的只是「只收它」这个说法。
     *
     * 为什么两者不能同时给：装一层新的本来就会让其他所有层退场，再加一句
     * 「收掉某某」是自相矛盾（刚装的那层要不要收？）。要收思考态就别再给名字。
     */
    const releaseNames = [];
    for (const item of Array.isArray(raw?.release) ? raw.release : []) {
      const asked = typeof item === 'string' ? item.trim() : '';
      if (asked === '') continue;
      const canonical = canonicalEmotionName(asked);
      if (canonical === null) {
        return fail(
          'E_EMOTION_UNKNOWN',
          `没有叫「${asked}」的情绪 —— 收一层也要求名字对得上。可用的是：${emotionCatalogText()}。`,
        );
      }
      if (!releaseNames.includes(canonical)) releaseNames.push(canonical);
    }

    if (releaseNames.length > 0) {
      const named = typeof raw?.name === 'string' ? raw.name.trim() : '';
      if (named !== '') {
        return fail(
          'E_ACTION_BAD_VALUE',
          '一条指令里 name 和 release 不能同时给：name 是装一层新的（它本来就会让别的层退场），'
          + 'release 是按名字收掉指定的层。要收思考态就别再给名字。',
        );
      }
      return {
        ok: true,
        code: '',
        detail: `收掉「${releaseNames.join('」「')}」这一层（只收它${releaseNames.length > 1 ? '们' : ''}，别的层不动）。`,
        command: { ...base, payload: { emotion: { release: releaseNames, params: {} } } },
        droppedParameters: [],
        clampedParameters: [],
      };
    }

    const outcome = resolveEmotion(raw?.name, {
      intensity: raw?.intensity,
      holdMs: raw?.holdMs,
      // D 期加的：思考态要 420ms 的慢淡入（思考是渐起的），而「说完回正」要一个
      // 更短的退场。默认值仍是 180/500（`emotions.js` 的常量），这里只做转发。
      attackMs: raw?.attackMs,
      releaseMs: raw?.releaseMs,
      /*
       * ★ 退场形状（§13.33）：`decayMs` 是「hold 之后按指数尾慢慢松掉」的
       * 时间常数，不传就用 `EMOTION_DECAY_MS`（7 秒）。显式给了 `releaseMs`
       * 的旧调用方仍然走老的线性淡出 —— 换算在 `resolveEmotion()` 里做，
       * 这里只转发，不重复判断。
       */
      decayMs: raw?.decayMs,
      parameters: capabilities?.parameters,
      // 用户在面板里攒的「角色 → 参数 id」覆盖表。只有情绪这一条路用得上，
      // 但它是 `buildAction()` 的入参（不是 capabilities 的字段）—— 绑定是
      // **人的决定**，随 settings.json 走，不随模型清单走。
      bindings: options?.bindings,
    });
    if (!outcome.ok) return fail(outcome.code, outcome.detail);

    const emotion = outcome.emotion;
    const clampedParameters = Array.isArray(emotion?.clamped)
      ? emotion.clamped.map((item) => ({ id: item.id, from: item.from, to: item.to }))
      : [];

    // 兜底：预设表里不该有口型参数，但如果以后有人手滑加了一个，这里必须拦下来
    // —— 让它溜过去的症状是她说话时嘴被情绪层按住，而且不报错。
    const exclusive = Object.keys(emotion?.params ?? {}).filter((id) => isExclusiveParameter(id));
    if (exclusive.length > 0) {
      return fail(
        'E_ACTION_PARAMETER_EXCLUSIVE',
        `情绪「${emotion.name}」里含有口型参数 ${exclusive.join(' / ')} —— 那几个由语音通道独占。`
        + '这是预设表写错了，请修 lib/host/emotions.js。',
        { droppedParameters: exclusive.map((id) => ({ id, reason: 'E_ACTION_PARAMETER_EXCLUSIVE' })) },
      );
    }

    return {
      ok: true,
      code: '',
      detail: outcome.detail,
      command: {
        ...base,
        payload: {
          emotion: {
            name: emotion.name,
            intensity: emotion.intensity,
            holdMs: emotion.holdMs,
            attackMs: emotion.attackMs,
            releaseMs: emotion.releaseMs,
            /*
             * ★ `decayMs` 必须**原样**送到渲染端（§13.33）：渲不渲染得好看它。
             *
             * `0` 是有意义的值（「这一条要线性淡出」），所以不能用真值判断把它
             * 吞掉 —— 渲染端收到 `0` 会走 `releaseMs`，收到 `undefined` 才用它
             * 自己的默认值（同样是线性，给旧 Host 留的那条路）。
             */
            decayMs: emotion.decayMs,
            params: emotion.params,
          },
        },
      },
      droppedParameters: [],
      clampedParameters,
    };
  }

  if (kind === 'expression') {
    const name = typeof raw?.name === 'string' ? raw.name : '';
    if (name === '') return fail('E_ACTION_BAD_VALUE', '表达式名是空的。');
    const hit = findExpression(capabilities, name);
    if (hit === null) {
      const available = availableExpressions(capabilities);
      return fail(
        'E_EXPRESSION_NOT_FOUND',
        `这个模型没有叫「${name}」的表达式。可用表达式：${available}`,
        { available: Array.isArray(capabilities?.expressions) ? capabilities.expressions.map((item) => item?.name).filter(Boolean) : [] }
      );
    }
    return {
      ok: true,
      code: '',
      detail: '',
      command: {
        ...base,
        payload: {
          /*
           * 这里**没有** `weight`。
           *
           * 契约表（§4.1）写的是 `live2d_set_expression(name, weight?, holdMs?)`，
           * 但 weight 兑现不了：Framework 的 `CubismExpressionMotionManager` 没有
           * 「按权重混合单个表情」这条路 —— `ACubismMotion.setWeight()` 只影响
           * **两个表情交叉淡入时**的混合比例（`cubismexpressionmotion.ts:207` 的
           * `if (expressionIndex == 0)` 分支根本不用 fadeWeight），而真正写进模型的
           * 权重是 `cubismexpressionmotionmanager.ts:207-213` 那个**只由淡入时间算出**
           * 的 `expressionWeight`。更糟的是把 `_weight` 设成小于 1 会让
           * `latestFadeWeight >= 1.0` 这个回收条件永远不成立
           * （`cubismexpressionmotionmanager.ts:230-243`），上一个表情再也退不掉。
           *
           * 所以 weight 不是「忘了接」，是**接不上**。留着一个永远不生效的参数，
           * LLM 会一直用它、一直得不到反馈，所以整条链上一个字都不留。
           * 详见方案 §4.2.8。
           */
          expression: {
            name,
            holdMs: Math.round(clampNumber(raw?.holdMs, 0, MAX_HOLD_MS, 0)),
          },
        },
      },
      droppedParameters: [],
      clampedParameters: [],
    };
  }

  if (kind === 'motion') {
    const group = typeof raw?.group === 'string' ? raw.group : '';
    if (group === '') {
      return fail('E_ACTION_BAD_VALUE', `动作组名是空的。可用的动作组：${availableMotionGroups(capabilities)}`);
    }
    const hit = findMotionGroup(capabilities, group);
    if (hit === null) {
      return fail(
        'E_MOTION_GROUP_NOT_FOUND',
        `这个模型没有叫「${group}」的动作组。可用的动作组：${availableMotionGroups(capabilities)}`,
        { available: Array.isArray(capabilities?.motionGroups) ? capabilities.motionGroups.map((item) => item?.name).filter(Boolean) : [] }
      );
    }
    const count = Math.max(0, Math.trunc(finiteOr(hit.count, 0)));
    // index 省略时随机挑一个：同一句话重复触发同一个动作会显得机械。
    // 由 Host 定 index 而不是交给端上随机，是为了让日志里的指令是可复现的。
    const index = raw?.index === undefined || raw?.index === null
      ? (count > 0 ? Math.floor(Math.random() * count) : 0)
      : Math.trunc(finiteOr(raw.index, 0));
    if (index < 0 || (count > 0 && index >= count)) {
      return fail(
        'E_MOTION_INDEX_OUT_OF_RANGE',
        `动作组「${group}」只有 ${count} 个动作，序号 ${index} 越界（从 0 开始）。`
      );
    }
    return {
      ok: true,
      code: '',
      detail: '',
      command: {
        ...base,
        payload: {
          motion: {
            group,
            index,
            fadeMs: Math.round(clampNumber(raw?.fadeMs, 0, MAX_FADE_MS, DEFAULT_FADE_MS)),
            loop: raw?.loop === true,
          },
        },
      },
      droppedParameters: [],
      clampedParameters: [],
    };
  }

  // kind === 'param'：逃生通道，只在能力清单声明的范围内生效。
  const input = raw?.params;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('E_ACTION_BAD_VALUE', 'params 必须是一个「参数名 → 数值」的对象。');
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_ACTION_PARAMETERS) {
    return fail('E_ACTION_BAD_VALUE', `一条指令最多带 ${MAX_ACTION_PARAMETERS} 个参数，收到 ${entries.length} 个。`);
  }

  const params = {};
  const droppedParameters = [];
  const clampedParameters = [];

  for (const [id, value] of entries) {
    // 硬规则 1：口型通道独占。丢弃而不是夹取 —— 夹取之后它仍会和 TTS
    // 每帧写入的值打架，只是幅度小一点。
    if (isExclusiveParameter(id)) {
      droppedParameters.push({ id, reason: 'E_ACTION_PARAMETER_EXCLUSIVE' });
      continue;
    }
    const declared = findParameter(capabilities, id);
    if (declared === null) {
      droppedParameters.push({ id, reason: 'E_ACTION_PARAMETER_NOT_FOUND' });
      continue;
    }
    const min = finiteOr(declared.min, -1);
    const max = finiteOr(declared.max, 1);
    const wanted = finiteOr(value, declared.def ?? 0);
    const final = clamp(wanted, min, max);
    if (final !== wanted) clampedParameters.push({ id, from: wanted, to: final });
    params[id] = final;
  }

  if (Object.keys(params).length === 0 && droppedParameters.length > 0) {
    const first = droppedParameters[0];
    const detail = first.reason === 'E_ACTION_PARAMETER_EXCLUSIVE'
      ? `参数「${first.id}」由语音口型通道独占（${EXCLUSIVE_PARAMETER_IDS.join(' / ')}），AI 不能写它 —— 否则会和正在说的话打架。`
      : `这个模型没有参数「${first.id}」。可写的参数见 live2d_status 的 capabilitiesDetail。`;
    return fail(first.reason, `${detail}（这条指令里没有任何一个参数被接受）`, { droppedParameters, clampedParameters });
  }

  /*
   * 成功也要说话。
   *
   * 这条通道是**硬写**（每帧最后落笔，会盖掉眨眼、呼吸和动作自带的脸部曲线），
   * 而 AI 唯一能确认「到底写进去了什么」的地方就是这个返回值：夹取与丢弃各自
   * 记在 `clampedParameters` / `droppedParameters` 里，但那是两个附加字段 ——
   * 主句里不列出参数名的话，「写进去 3 个、丢了 2 个」和「5 个全写进去了」
   * 在 AI 眼里一模一样。
   *
   * `保持` 报的是 `ttlMs`：渲染端拿指令自己的 TTL 当保持时长（`action-runner.ts`
   * 的 `case 'param'`），所以这里报的不是另一个数字，而是同一个。
   */
  return {
    ok: true,
    code: '',
    detail: `硬写 ${Object.entries(params).map(([id, value]) => `${id}=${value}`).join('、')}`
      + `，保持 ${base.ttlMs}ms（硬写会盖掉眨眼/呼吸/动作曲线；口型参数写不进来）。`,
    command: { ...base, payload: { params } },
    droppedParameters,
    clampedParameters,
  };
}

/** 一条指令给日志看的一行摘要。 */
export function actionSummary(command) {
  if (command === null || command === undefined) return '（空指令）';
  const payload = command.payload ?? {};
  switch (command.kind) {
    case 'say': return `say ${payload.text?.length ?? 0} 字「${String(payload.text ?? '').slice(0, 16)}…」`;
    case 'motion': return `motion ${payload.motion?.group}#${payload.motion?.index}`;
    case 'expression': return `expression ${payload.expression?.name}`;
    case 'look': return `look (${payload.look?.x}, ${payload.look?.y})`;
    case 'emotion': return Array.isArray(payload.emotion?.release) && payload.emotion.release.length > 0
      ? `emotion −${payload.emotion.release.join('/')}（只收这几层）`
      : `emotion ${payload.emotion?.name} ×${payload.emotion?.intensity}`
        + `（${Object.keys(payload.emotion?.params ?? {}).length} 个参数，保持 ${payload.emotion?.holdMs}ms）`;
    case 'param': return `param ${Object.keys(payload.params ?? {}).length} 个`;
    case 'stop': return 'stop';
    case 'idle': return 'idle';
    default: return String(command.kind ?? '（未知）');
  }
}

/**
 * 队列裁剪：TTL 过期 + 数量上限。
 *
 * 纯函数，不改传入的数组 —— 它同时被 Host（入队后裁剪）和门禁（断言裁剪规则）
 * 使用。返回 `{ kept, expired, overflow }`，三个都要报出来：只报「丢了 N 条」
 * 的日志在排查「我说的话为什么没播」时毫无用处。
 *
 * **丢最旧的**而不是最新的，与 `/pending` 的既有策略一致（`MAX_PENDING = 8`）：
 * Agent 连发十句话时，让桌宠念最后八句远比念最前面八句符合直觉。
 *
 * 「最旧」按 `command.at` 判定，**不是按数组下标** —— 队列理论上就是按到达
 * 顺序 push 的，但依赖这件事等于把一个隐含约定埋进一个纯函数里：门禁按
 * 「时间戳更旧」构造夹具，而它并不保证数组顺序，于是同一个函数在两处
 * 表现得不一样（第一次跑就是这么红的）。按时间戳挑，怎么排都对。
 *
 * TTL 判定必须发生在数量裁剪**之前**：一条 10 秒前排队的动作，不该因为
 * 「队列还有空位」而被留下来执行。
 */
export function pruneQueue(queue, now, maxLength) {
  const list = Array.isArray(queue) ? queue : [];
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.trunc(maxLength) : 8;
  const atOf = (item) => finiteOr(item?.command?.at, now);

  const alive = [];
  const expired = [];
  for (const item of list) {
    const ttl = finiteOr(item?.command?.ttlMs, DEFAULT_TTL_MS);
    if (now - atOf(item) > ttl) expired.push(item);
    else alive.push(item);
  }

  const overflow = [];
  while (alive.length > limit) {
    let oldestIndex = 0;
    for (let i = 1; i < alive.length; i += 1) {
      if (atOf(alive[i]) < atOf(alive[oldestIndex])) oldestIndex = i;
    }
    overflow.push(alive.splice(oldestIndex, 1)[0]);
  }
  return { kept: alive, expired, overflow };
}

/*
 * 这里原来有一个 `shouldInterrupt(incoming, current)`，按 §4.1 的 priority 语义
 * 判断「新指令该不该打断正在执行的那一条」。它**从来没有被任何地方调用过**，
 * 已于 P3 收尾时删除（见方案 §4.2.12）。
 *
 * 原因是它没有立足点：Host 只知道队列里有什么，**不知道渲染端此刻在播什么** ——
 * 「正在执行的指令」这个状态活在渲染端的轮询循环里。硬要接上，就得让 Host 猜，
 * 而猜错的后果比不判断更糟。优先级真正能落地的地方只有一个：
 * 渲染端在用「自动待机」顶掉「AI 要的动作」之前先问一句
 * `currentMotionPriority()`（`src/client/action-runner.ts` 的 `shouldAutoIdle()`）。
 */
