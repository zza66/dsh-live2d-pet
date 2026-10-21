/*
 * 情绪预设表 —— 把「开心」这种词翻译成一组参数**增量**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么需要这一层，而不是让 AI 直接写参数（`param` 这个动作种类早就存在）
 * ─────────────────────────────────────────────────────────────────────────
 * 1. AI 不知道 `ParamEyeLSmile` 这种名字，也**不该**知道。参数名是模型的实现
 *    细节，把它暴露给 AI，等于把「插件没做好」变成「AI 用错了」。
 * 2. 情绪必须是**加法**。`param` 通道是硬覆盖（渲染端 `_parameterOverrides`
 *    写在每一帧的最后、权重 1），它会盖掉眨眼、表情、动作自带的脸部曲线。
 *    而「开心」应当和「正在眨眼」「正在点头」同时成立。这里给出的增量由渲染端
 *    用 `addParameterValueById()` 叠上去，天然可共存。
 * 3. 四只模型自带的 `expressions/` 是**道具和漫画叠层**，不是情绪（§8.34 的
 *    审计：`空` 那个是去水印，`miku` 的 8 个是葱/水枪之类的开关，`hiyori` 一个
 *    都没有）。所以「情绪」这个词在插件里必须由我们自己定义，不能指望模型自带。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 三条硬约束（都来自真机实测，不是设计偏好）
 * ─────────────────────────────────────────────────────────────────────────
 * - **嘴不许碰**：`ParamMouthOpenY` / `ParamMouthForm` 由 TTS 口型通道独占
 *   （方案 §4.1 硬规则 1）。所以「笑」只能靠眼睛、眉毛和脸颊做出来 —— 这也是
 *   为什么下面每一条都没有「嘴角上扬」。
 * - **角色 → 参数 id 是候选列表，不是等号**：不同模型对同一个概念用不同的 id
 *   （`空` 的笑眼叫 `ParamEyeSmile`，多数模型叫 `ParamEyeLSmile`）。取第一个
 *   **在当前模型的能力清单里真实存在**的候选；一个都没有就跳过这个角色并在
 *   detail 里说出来。静默无效是这个项目里最贵的一类缺陷（§8.33 / §8.34）。
 * - **增量以 Core 报的默认值为基准**：`ParamEyeLOpen` 的默认是 1（睁开），
 *   区间 [0, 1.2]。绝对值和增量在这里不是风格问题 —— 动作与眨眼都在改同一个
 *   参数，只有增量是可叠加的那一种。渲染端拿到的 `def` 来自
 *   `describeParameters()`（也就是 Cubism Core），不是我们猜的。
 *
 * 本文件**零 import**：Host 半区直接用，门禁也能直接 import 它（不必进客户端
 * bundle）。纯数据 + 纯函数，没有任何 I/O。
 */

/** 角色 → 候选参数 id（按优先级排列，取第一个存在的）。 */
export const ROLE_PARAMETER_IDS = Object.freeze({
  eyeSmileL: Object.freeze(['ParamEyeLSmile', 'ParamEyeSmile']),
  eyeSmileR: Object.freeze(['ParamEyeRSmile', 'ParamEyeSmileR']),
  eyeOpenL: Object.freeze(['ParamEyeLOpen']),
  eyeOpenR: Object.freeze(['ParamEyeROpen']),
  eyeBallX: Object.freeze(['ParamEyeBallX']),
  eyeBallY: Object.freeze(['ParamEyeBallY']),
  browLY: Object.freeze(['ParamBrowLY', 'ParamBrowLY7']),
  browRY: Object.freeze(['ParamBrowRY', 'ParamBrowRY7']),
  browLForm: Object.freeze(['ParamBrowLForm', 'ParamBrowLForm2']),
  browRForm: Object.freeze(['ParamBrowRForm', 'ParamBrowRForm2']),
  cheek: Object.freeze(['ParamCheek']),
  angleX: Object.freeze(['ParamAngleX']),
  angleY: Object.freeze(['ParamAngleY']),
  angleZ: Object.freeze(['ParamAngleZ']),
  bodyAngleX: Object.freeze(['ParamBodyAngleX']),
  bodyAngleZ: Object.freeze(['ParamBodyAngleZ']),
  shoulder: Object.freeze(['ParamShoulder']),
  hairAhoge: Object.freeze(['ParamHairAhoge']),
});

/**
 * 角色 → 面板与报错里给用户看的中文名。
 *
 * 为什么和 `ROLE_PARAMETER_IDS` 挤在同一个文件：工具返回值、面板下拉、文档里说的
 * 必须是**同一批名字**。分成两份的那一天，就会出现「面板上写『左眼笑』、报错里写
 * `eyeSmileL`、文档里写『笑眼』」这种三个人互相看不懂的句子。
 */
export const ROLE_LABELS = Object.freeze({
  eyeSmileL: '左眼笑眼',
  eyeSmileR: '右眼笑眼',
  eyeOpenL: '左眼开合',
  eyeOpenR: '右眼开合',
  eyeBallX: '视线左右',
  eyeBallY: '视线上下',
  browLY: '左眉高度',
  browRY: '右眉高度',
  browLForm: '左眉形状',
  browRForm: '右眉形状',
  cheek: '脸红',
  angleX: '头部左右',
  angleY: '头部上下',
  angleZ: '头部倾斜',
  bodyAngleX: '身体左右',
  bodyAngleZ: '身体倾斜',
  shoulder: '肩膀',
  hairAhoge: '呆毛',
});

/** 全部角色名（面板的表格行、绑定文档的合法键）。顺序与 `ROLE_PARAMETER_IDS` 一致。 */
export function emotionRoleNames() {
  return Object.keys(ROLE_PARAMETER_IDS);
}

/**
 * 规范化一份「角色 → 参数 id」绑定表。
 *
 * 三件事都不许静默：不认识的**角色**（拼错了）回 `ignored`，空值/非字符串回
 * `ignored`，认识的留成 trim 过的 id。**参数 id 在不在这个模型上，这里不判断**
 * —— 那要模型的参数清单，是 `pickRoleParameter()` 的活。分成两步的理由：绑定表
 * 是**给人攒的**（可能先写、模型后到），而「这个模型上有没有」是每一次解析都要
 * 重新回答的问题。
 *
 * @returns {{roles: object, ignored: Array<{role: string, reason: string}>}}
 */
export function normalizeEmotionBindings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const roles = {};
  const ignored = [];
  for (const [role, value] of Object.entries(source)) {
    if (!Object.prototype.hasOwnProperty.call(ROLE_PARAMETER_IDS, role)) {
      ignored.push({ role, reason: 'unknown-role' });
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      ignored.push({ role, reason: 'bad-value' });
      continue;
    }
    roles[role] = value.trim();
  }
  return { roles, ignored };
}

/**
 * 一个角色在这个模型上**最终**该写哪个参数。
 *
 * 优先级：绑定（且这个 id 真的在模型里）> 候选表里第一个存在的 > 没有。
 * 绑定了但模型没有那个参数时**退回候选**而不是跳过 —— 退回是「你写的绑定现在
 * 不适用」，跳过是「这个情绪有一块做不出来」，后者严重得多。两种情况都必须能被
 * 说出来，所以 `bindingMissing` 是返回值的一部分，不是日志。
 *
 * @param {string} role
 * @param {Map<string, object>} declared 模型参数表（id → {id,min,max,def}）
 * @param {object} bindings 规范化过的绑定表（role → param id）
 * @returns {{id: string|null, source: 'binding'|'auto'|'none', boundId: string|null, bindingMissing: boolean}}
 */
export function pickRoleParameter(role, declared, bindings) {
  const candidates = ROLE_PARAMETER_IDS[role] ?? [];
  const boundId = typeof bindings?.[role] === 'string' ? bindings[role] : null;
  if (boundId !== null && declared.has(boundId)) {
    return { id: boundId, source: 'binding', boundId, bindingMissing: false };
  }
  const auto = candidates.find((item) => declared.has(item));
  if (auto !== undefined) {
    return { id: auto, source: 'auto', boundId, bindingMissing: boundId !== null };
  }
  return { id: null, source: 'none', boundId, bindingMissing: boundId !== null };
}

/*
 * 情绪表。数值单位是**模型自己的单位**，基准是 Core 的默认值：
 *   ParamAngle*     [-30, 30]   默认 0
 *   ParamBodyAngle* [-10, 10]   默认 0
 *   ParamEye*Open   [0, 1.2]    默认 1     ← 注意默认是 1，不是 0
 *   ParamEye*Smile  [0, 1]      默认 0
 *   ParamBrow*      [-1, 1]     默认 0
 *   ParamCheek      [-1, 1]     默认 0
 *   ParamShoulder   [-1, 1]     默认 0
 *   ParamHairAhoge  [-10, 10]   默认 0
 * 上面这些区间是 `work/probe-param-ranges.mjs` 从 hiyori 的 moc3 里读出来的
 * （cdi3 里**没有** Min/Max/Def —— VTS 导出把它们省掉了）。门禁
 * `tools/test-emotions.mjs` 会拿真实 moc3 的区间逐条核对，越界就变红。
 */
const EMOTION_TABLE = Object.freeze({
  平静: Object.freeze({
    summary: '回到中性 —— 清空情绪层，不是「摆一张平静的脸」',
    roles: Object.freeze({}),
  }),
  开心: Object.freeze({
    summary: '笑眼 + 脸红 + 眉毛微抬 + 头微倾',
    roles: Object.freeze({
      eyeSmileL: 0.7, eyeSmileR: 0.7, cheek: 0.5,
      browLY: 0.15, browRY: 0.15, angleZ: 2, hairAhoge: 1.5,
    }),
  }),
  好奇: Object.freeze({
    summary: '歪头 + 一边眉毛挑起来 + 眼睛睁大一点 + 视线偏向一侧',
    roles: Object.freeze({
      angleZ: 10, angleY: 3, browRY: 0.35, browLY: -0.1,
      eyeOpenL: 0.1, eyeOpenR: 0.1, eyeBallX: 0.35, hairAhoge: -1,
    }),
  }),
  思考: Object.freeze({
    summary: '眉心和眉毛往里收 + 眼睛半闭 + 视线往上飘 + 头微低',
    roles: Object.freeze({
      browLY: -0.25, browRY: -0.25, browLForm: 0.35, browRForm: 0.35,
      eyeOpenL: -0.25, eyeOpenR: -0.25, eyeBallY: 0.45, eyeBallX: -0.35,
      angleY: -3, angleZ: 4,
    }),
  }),
  认真: Object.freeze({
    summary: '眉毛压低 + 眼睛略微收窄 + 头微低 —— 没有笑意的那张脸',
    roles: Object.freeze({
      browLY: -0.35, browRY: -0.35, eyeOpenL: -0.12, eyeOpenR: -0.12,
      angleY: -4, bodyAngleX: -1.5,
    }),
  }),
  惊讶: Object.freeze({
    summary: '眼睛睁大 + 眉毛抬高 + 头微仰 + 肩膀一耸',
    roles: Object.freeze({
      eyeOpenL: 0.2, eyeOpenR: 0.2, browLY: 0.55, browRY: 0.55,
      angleY: 4, eyeBallY: 0.1, shoulder: 0.25,
    }),
  }),
  抱歉: Object.freeze({
    summary: '八字眉 + 低头 + 视线向下 + 肩膀塌下来',
    roles: Object.freeze({
      browLForm: 0.5, browRForm: 0.5, browLY: -0.1, browRY: -0.1,
      angleY: -9, eyeBallY: -0.45, shoulder: -0.25,
      eyeOpenL: -0.15, eyeOpenR: -0.15, cheek: 0.15,
    }),
  }),
  难过: Object.freeze({
    summary: '八字眉 + 更深的低头 + 视线向下 + 肩膀塌下来',
    roles: Object.freeze({
      browLForm: 0.45, browRForm: 0.45, browLY: -0.2, browRY: -0.2,
      angleY: -11, eyeBallY: -0.55, shoulder: -0.3,
      eyeOpenL: -0.2, eyeOpenR: -0.2,
    }),
  }),
  得意: Object.freeze({
    summary: '下巴微抬 + 笑眼 + 肩膀一挺 + 呆毛翘起来',
    roles: Object.freeze({
      angleY: 6, eyeSmileL: 0.4, eyeSmileR: 0.4, shoulder: 0.2,
      bodyAngleX: 1.5, hairAhoge: 2,
    }),
  }),
});

/** 别名（小写）→ 正名。英文名是给「AI 用英文思考」留的门，不是另一套情绪。 */
const EMOTION_ALIASES = Object.freeze({
  neutral: '平静', calm: '平静', reset: '平静', clear: '平静',
  happy: '开心', joy: '开心', smile: '开心', glad: '开心', 高兴: '开心',
  curious: '好奇', interest: '好奇', wonder: '好奇',
  thinking: '思考', think: '思考', ponder: '思考', 思索: '思考',
  serious: '认真', focused: '认真', 严肃: '认真', 专注: '认真',
  surprised: '惊讶', surprise: '惊讶', shock: '惊讶', amazed: '惊讶', 吃惊: '惊讶',
  sorry: '抱歉', apologetic: '抱歉', apologize: '抱歉', 对不起: '抱歉', 歉意: '抱歉',
  sad: '难过', sorrow: '难过', upset: '难过', 伤心: '难过', 沮丧: '难过',
  proud: '得意', smug: '得意', confident: '得意', 自豪: '得意',
});

/**
 * ★ 情绪「族」（§13.33 的余波判据）。
 *
 * 余波只在同族之间留：开心 → 得意 该带着笑，难过 → 抱歉 该带着垂眼；
 * 而 难过 → 开心 若也留残影，脸上会是一张似笑非笑的八字眉 —— 那不是细腻，
 * 那是两张脸叠在一起。平静不进任何一族（它是「清空」，没有可留的东西）。
 */
const EMOTION_FAMILY = Object.freeze({
  开心: 'warm', 得意: 'warm', 好奇: 'warm',
  惊讶: 'alert',
  思考: 'focus', 认真: 'focus',
  抱歉: 'down', 难过: 'down',
  平静: 'calm',
});

export const EMOTION_DEFAULT_HOLD_MS = 2500;
export const EMOTION_MAX_HOLD_MS = 30000;
export const EMOTION_MAX_INTENSITY = 1.5;
/** 淡入时长。快进慢出：情绪要「起得来」，退场要「不着痕迹」。 */
export const EMOTION_ATTACK_MS = 180;
/**
 * ★ 显式淡出时长（**旧形状**，仍是默认退回值）。
 *
 * 从 §13.33 起，情绪到期后默认不再走这条 500ms 的线性淡出，而是走下面的
 * `EMOTION_DECAY_MS` 指数尾。这个常量保留有两个用处：调用方**明确**传
 * `releaseMs` 时按线性淡出（有些一次性表演要「说没就没」），以及
 * `releaseEmotionLayers()` 的退场时长兜底。
 */
export const EMOTION_RELEASE_MS = 500;

/**
 * ★ 情绪的自然退场：hold 结束后按**指数**衰减，时间常数 τ = 7 秒（§13.33）。
 *
 * 为什么改这个（原来到点后 500ms 线性淡出、然后归零）：
 *  - 500ms 让「情绪」看起来像一个开关 —— 说完立刻回到出厂设置，没有余温；
 *  - 真实的表情是**几分钟内慢慢淡**的，但对话节奏又不能等那么久。
 *    7 秒是折中：1 秒后还剩 87%，3 秒 65%，7 秒 37%，15 秒 12%，约 27 秒到 2%。
 *
 * 和 `holdMs` 的分工：`holdMs` 是「保持不动」的时长（表情的稳定期），
 * 这段指数尾是「开始松掉」之后还要多久才真的看不见。两者相乘才是完整寿命。
 */
export const EMOTION_DECAY_MS = 7000;
/** 指数尾低于这个权重就算这一层结束（不然它会永远「还活着一点点」）。 */
export const EMOTION_DECAY_FLOOR = 0.02;
/**
 * ★ 余波：换情绪时，旧的那层不直接剪掉，而是留一个**很淡的残影**（§13.33）。
 *
 * 18% 的依据是它在画面上刚好还能被看见（`ParamAngleZ` 十度的情绪剩 1.8 度），
 * 又不至于让新情绪「染上」旧情绪的颜色。只留给**同一族**的情绪（见
 * `EMOTION_FAMILY`）：从「难过」切到「开心」时脸上不该还挂着八字眉。
 */
export const EMOTION_RESIDUE_WEIGHT = 0.18;
/** 余波的淡出时长（线性，短 —— 它只是交接时的那一口气）。 */
export const EMOTION_RESIDUE_MS = 1500;

/**
 * ★ 静息漂移的默认强度（§13.33）。
 *
 * 这一层是**背景**，不是表演：`strength = 1` 就是「按 `AMBIENT_DRIFT_WAVES`
 * 里写的那样漂」，调小是收着点，调大最多到 2。真正的幅度在动作表里按
 * **参数量程的比例**给（0.6%–2.4%），所以 ±30 度的头和 ±10 度的头一样轻。
 */
export const EMOTION_AMBIENT_STRENGTH = 1;

export function emotionNames() {
  return Object.keys(EMOTION_TABLE);
}

/**
 * 情绪层的包络：0 → 1（淡入）→ 保持 → 1 → 0（淡出）。
 *
 * 返回 `0` 的含义是**这一层已经结束**，调用方据此把它摘掉（而不是继续写 0 增量 ——
 * 写 0 和「不在场」看起来一样，但前者会永久占着那张表，让「当前有没有情绪」这个
 * 问题永远答「有」）。
 *
 * `holdMs === 0` 表示一直保持到换一个情绪；`attackMs === 0` / `releaseMs === 0`
 * 表示硬进 / 硬出。
 */
export function emotionEnvelope(elapsedMs, holdMs, attackMs, releaseMs, decayMs = 0) {
  const t = finiteOr(elapsedMs, 0);
  if (t <= 0) return 0;
  const attack = Math.max(0, finiteOr(attackMs, EMOTION_ATTACK_MS));
  const release = Math.max(0, finiteOr(releaseMs, EMOTION_RELEASE_MS));
  const hold = Math.max(0, finiteOr(holdMs, EMOTION_DEFAULT_HOLD_MS));
  const decay = Math.max(0, finiteOr(decayMs, 0));

  if (t < attack) return attack === 0 ? 1 : t / attack;
  if (hold === 0) return 1;
  const held = t - attack;
  if (held < hold) return 1;
  /*
   * ★ 两条退场路（§13.33）：默认走指数尾（`decayMs > 0`），显式给了
   * `releaseMs` 的调用方仍走线性（把 5 个参数都给全了才轮到这条）。
   *
   * 指数尾必须有**地板**：`exp()` 永远不归零，留着 0.001 的层会让「她现在
   * 有没有情绪」这个问题的答案永远是「有」。掉到 2% 就摘掉，人眼看不出来。
   */
  if (decay > 0) {
    const weight = Math.exp(-(held - hold) / decay);
    return weight <= EMOTION_DECAY_FLOOR ? 0 : weight;
  }
  if (release === 0) return 0;
  const out = (held - hold) / release;
  return out >= 1 ? 0 : 1 - out;
}

/** 名字或别名 → 正名；不认识返回 null（大小写不敏感）。 */
export function canonicalEmotionName(name) {
  if (typeof name !== 'string') return null;
  const raw = name.trim();
  if (raw === '') return null;
  if (Object.prototype.hasOwnProperty.call(EMOTION_TABLE, raw)) return raw;
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EMOTION_ALIASES, lower)) return EMOTION_ALIASES[lower];
  // 别名表里也允许直接写中文正名的小写形式（中文没有大小写，这条只为对称）。
  const hit = Object.keys(EMOTION_TABLE).find((item) => item.toLowerCase() === lower);
  return hit ?? null;
}

/** 给工具描述 / 错误信息用的一行目录。 */
export function emotionCatalogText() {
  return emotionNames().map((name) => `${name}（${EMOTION_TABLE[name].summary}）`).join('；');
}

/** 正名 → 族名（认不出返回 null）。 */
export function emotionFamily(name) {
  const canonical = canonicalEmotionName(name);
  if (canonical === null) return null;
  return EMOTION_FAMILY[canonical] ?? null;
}

/**
 * 两层情绪算不算「同一个来路」—— 余波只在这种关系里留（见 `EMOTION_FAMILY`）。
 * 「平静」永远不算：它是清空，不是一种情绪。
 */
export function emotionsRelated(a, b) {
  const left = emotionFamily(a);
  const right = emotionFamily(b);
  if (left === null || right === null) return false;
  if (left === 'calm' || right === 'calm') return false;
  return left === right;
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return value < min ? min : (value > max ? max : value);
}

/**
 * 把一次情绪请求解析成「一串参数增量」。
 *
 * @param {string} name 情绪名（或别名）
 * @param {object} options
 * @param {number} [options.intensity] 0–1.5，默认 1
 * @param {number} [options.holdMs] 保持多久开始退场，默认 2500；0 表示一直保持
 * @param {Array<{id:string,min:number,max:number,def:number}>} [options.parameters]
 *        当前模型的能力清单参数表 —— 唯一能在这一步做校验的事实用来源
 * @param {object} [options.bindings]
 *        用户在面板里攒的「角色 → 参数 id」覆盖表（`normalizeEmotionBindings()` 的
 *        `roles`）。绑定优先于候选表，但只在这个 id 真的存在于模型上时生效。
 * @returns {{ok:boolean, code:string, detail:string, emotion:object|null}}
 */
export function resolveEmotion(name, options) {
  const raw = typeof name === 'string' ? name.trim() : '';
  const canonical = canonicalEmotionName(raw);
  if (canonical === null) {
    /*
     * 「没给名字」和「名字不认识」是两件事，但对调用者来说都只要一个结果：重试。
     * 所以这里分成两句**不同的话**，却用同一个错误码 —— 多一个码不会让 AI 更聪明，
     * 而「没有叫「undefined」的情绪」这种句子会。
     */
    const detail = raw === ''
      ? `要给一个情绪名字（没收到）。可用的是：${emotionCatalogText()}。`
      : `没有叫「${raw}」的情绪。可用的是：${emotionCatalogText()}。`;
    return {
      ok: false,
      code: 'E_EMOTION_UNKNOWN',
      detail: detail
        + '英文别名同样可用（happy / curious / thinking / serious / surprised / sorry / sad / proud / neutral）。',
      emotion: null,
    };
  }

  const table = EMOTION_TABLE[canonical];
  const intensity = Math.round(clamp(finiteOr(options?.intensity, 1), 0, EMOTION_MAX_INTENSITY) * 100) / 100;
  const holdMs = Math.round(clamp(finiteOr(options?.holdMs, EMOTION_DEFAULT_HOLD_MS), 0, EMOTION_MAX_HOLD_MS));
  /*
   * 淡入淡出可以逐次指定（D 期的思考态用 420ms 淡入 —— 思考是渐起的，情绪是反应）。
   *
   * 两个值都**照实写进 detail**，不因为「反正是默认值」就省掉：上一次改这条
   * detail 的理由是同一个 —— 她脸上发生的事，正文里必须能读到。
   */
  const attackMs = Math.round(clamp(finiteOr(options?.attackMs, EMOTION_ATTACK_MS), 0, EMOTION_MAX_FADE_MS));
  const releaseMs = Math.round(clamp(finiteOr(options?.releaseMs, EMOTION_RELEASE_MS), 0, EMOTION_MAX_FADE_MS));
  /*
   * ★ 退场形状（§13.33）：调用方**显式**给了 `releaseMs` 就按老的线性淡出走
   * （一次性表演要「说没就没」）；没给就走 7 秒的指数尾 —— 那是「有惯性」的
   * 那一半，也是默认行为。两条路互斥，`decayMs === 0` 表示走线性。
   */
  const releaseGiven = typeof options?.releaseMs === 'number' && Number.isFinite(options.releaseMs);
  const decayMs = Math.round(clamp(
    finiteOr(options?.decayMs, releaseGiven ? 0 : EMOTION_DECAY_MS),
    0,
    120000,
  ));

  const declared = new Map();
  const list = Array.isArray(options?.parameters) ? options.parameters : [];
  for (const item of list) {
    if (item !== null && typeof item === 'object' && typeof item.id === 'string') declared.set(item.id, item);
  }

  const params = {};
  const applied = [];
  const skipped = [];
  const clamped = [];
  const bound = [];
  const bindingMisses = [];
  const bindings = normalizeEmotionBindings(options?.bindings).roles;

  for (const [role, delta] of Object.entries(table.roles)) {
    const pick = pickRoleParameter(role, declared, bindings);
    if (pick.id === null) {
      skipped.push(role);
      if (pick.bindingMissing) bindingMisses.push({ role, boundId: pick.boundId });
      continue;
    }
    if (pick.source === 'binding') bound.push({ role, id: pick.id });
    else if (pick.bindingMissing) bindingMisses.push({ role, boundId: pick.boundId });
    const id = pick.id;
    const info = declared.get(id);
    const min = finiteOr(info.min, -1);
    const max = finiteOr(info.max, 1);
    const def = finiteOr(info.def, 0);
    const wanted = delta * intensity;
    // 夹取的是**目标值**（def + 增量），落回增量 —— 这样即使预设写大了，
    // 渲染端拿到的仍是「相对默认值」的安全增量，而不是一个会被 Core 静默
    // 夹掉的绝对值。
    const target = clamp(def + wanted, min, max);
    const final = target - def;
    if (Math.abs(final - wanted) > 1e-6) clamped.push({ id, from: wanted, to: final });
    params[id] = final;
    applied.push({ role, id, source: pick.source, delta: final });
  }

  const base = { name: canonical, intensity, holdMs, attackMs, releaseMs, decayMs, params, applied, skipped, clamped, bound, bindingMisses };

  if (applied.length === 0 && skipped.length === 0) {
    return {
      ok: true,
      code: '',
      detail: `情绪层已清空（回到「${canonical}」）。`,
      emotion: base,
    };
  }

  if (applied.length === 0) {
    return {
      ok: false,
      code: 'E_EMOTION_NO_PARAMETER',
      detail: `这个模型没有任何一个「${canonical}」需要的参数（缺 ${skipped.join(' / ')}）—— 它的参数表里一个都没匹配上。`,
      emotion: base,
    };
  }

  const parts = applied.map((item) => `${item.id} ${item.delta >= 0 ? '+' : ''}${item.delta.toFixed(2)}`);
  const tail = [];
  if (holdMs === 0) tail.push('会一直保持到你换一个情绪');
  else if (decayMs > 0) tail.push(`保持 ${holdMs}ms 后按 τ=${(decayMs / 1000).toFixed(1)}s 衰减（${attackMs}ms 淡入）`);
  else tail.push(`保持 ${holdMs}ms 后淡出（${attackMs}ms 淡入 / ${releaseMs}ms 淡出）`);
  if (skipped.length > 0) tail.push(`本模型没有对应参数、已跳过：${skipped.join(' / ')}`);
  if (clamped.length > 0) tail.push(`已夹到模型范围：${clamped.map((item) => item.id).join(' / ')}`);
  if (bound.length > 0) {
    tail.push(`绑定生效：${bound.map((item) => `${ROLE_LABELS[item.role] ?? item.role}→${item.id}`).join('，')}`);
  }
  if (bindingMisses.length > 0) {
    tail.push(`绑定指向的参数这个模型没有：${bindingMisses.map((item) => `${ROLE_LABELS[item.role] ?? item.role}→${item.boundId}`).join('，')}（已退回默认候选）`);
  }

  return {
    ok: true,
    code: '',
    detail: `情绪「${canonical}」×${intensity}：${parts.join('，')}。${tail.join('；')}。`,
    emotion: base,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 情绪层状态机 —— D 期的「惯性 / 衰减」就住在这里
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 上面那些函数回答的是「**这一条指令**要往脸上加什么」（Host 半区，一条指令
 * 算一次）。这一段回答的是另一个问题：「**此刻这张脸上有几层东西，各占多重**」
 * —— 它跑在渲染端，每帧一次。
 *
 * 为什么要有「几层」：B 期的实现是**单层**，换情绪时旧的被直接丢掉。后果是
 * 「开心 → 难过」会在一帧之内从 +0.7 的眼笑跳到 −0.5 的眉，中间什么都不经过 ——
 * 那不是表情，那是换脸。真实的表情是**化过去**的：旧的那层退，新的那层进，
 * 中间有几十毫秒两种都有一点。
 *
 * 为什么这段是纯函数：渲染端（`pet-model.ts`）在 Node 里跑不起来（要 Cubism
 * Core 与 DOM），而「两层叠加时每一帧到底写什么」恰恰是最该被断言的东西。
 * 放在这里，门禁可以直接喂 delta 进去、逐帧对账。
 */

/** 换一种情绪时的交叉淡出：旧的那层化进新的那层，而不是被剪掉。 */
export const EMOTION_SWITCH_FADE_MS = 260;
/** 「回正」的淡出：比换情绪慢一点 —— 它是退场，不是让位。 */
export const EMOTION_CLEAR_FADE_MS = 320;
/** 一次调用可以自定义淡入淡出，但不能把她的脸慢成幻灯片。 */
export const EMOTION_MAX_FADE_MS = 5000;
/**
 * 同一层被同名的情绪重复命中时，只要它**已经基本在场**就不重来（惯性）。
 *
 * 这一条修的是一个很具体的抖动：我连说两句都判成「开心」，第二句到达时
 * 旧的那层已经淡到 0.95 —— 重来的话它会掉到 0 再涨回来，脸上是眨一下眼似的
 * 一次抽搐。改成「续上保持时间」，第二句表现为「笑得更久」。
 */
export const EMOTION_REUSE_WEIGHT = 0.9;

/** 一个空的脸（没有任何层）。 */
export function createEmotionLayers() {
  return { layers: [], active: [] };
}

/**
 * 把一层推进退场：记下「从这一刻起开始化掉」，**不改变它当前的权重**。
 *
 * 关键在于不是在改 `holdMs`：那样只能让**已经到 1** 的层平滑退场，一个还在
 * 淡入途中（权重 0.4）的层会被瞬间抬到 1 再退 —— 换情绪时那一下比直接剪掉
 * 还明显。所以退场是一个**乘在包络上的因子**，从哪里开始化，就从哪里化。
 */
function releaseLayer(layer, fadeMs) {
  if (layer.fadeAt !== null && layer.fadeAt !== undefined) return layer; // 已经在退场
  return { ...layer, fadeAt: finiteOr(layer.elapsedMs, 0), fadeMs: clamp(finiteOr(fadeMs, EMOTION_CLEAR_FADE_MS), 0, EMOTION_MAX_FADE_MS) };
}

/** 某一层此刻的权重（包络 × 退场因子）。0 表示这一层已经结束。 */
function layerWeight(layer, elapsedMs) {
  const base = emotionEnvelope(
    elapsedMs,
    layer?.holdMs,
    layer?.attackMs,
    layer?.releaseMs,
    layer?.decayMs,
  );
  if (base <= 0) return 0;
  if (layer?.fadeAt === null || layer?.fadeAt === undefined) return base;
  const fadeMs = finiteOr(layer.fadeMs, EMOTION_SWITCH_FADE_MS);
  if (fadeMs <= 0) return 0;
  const factor = 1 - (elapsedMs - finiteOr(layer.fadeAt, 0)) / fadeMs;
  return factor <= 0 ? 0 : clamp(base * Math.min(1, factor), 0, 1);
}

/**
 * ★ 余波层（§13.33）：把「正在被替换的那一层」压成一层很淡的残影。
 *
 * 为什么是「再叠一层」而不是「不把旧层推去退场」：旧层按完整幅度退场，会和新
 * 情绪在同一个参数上打架（五度的头 + 十度的头 = 十五度）；而把它压到 18%，
 * 它就从「表达」变成了「余味」—— 画面上的差别是「她换表情时脸上还有上一种
 * 情绪的痕迹」，而不是「两种情绪在抢她的脸」。
 *
 * 只在**同族**之间留（`emotionsRelated()`）。返回 null 表示这次不接余波。
 */
function buildResidue(current, incoming) {
  const candidates = current.filter((item) => item?.residue !== true && item?.name);
  if (candidates.length === 0) return null;
  let strongest = null;
  let strongestWeight = 0;
  for (const item of candidates) {
    const weight = layerWeight(item, finiteOr(item.elapsedMs, 0));
    if (weight > strongestWeight) {
      strongest = item;
      strongestWeight = weight;
    }
  }
  if (strongest === null || strongestWeight < 0.2) return null;
  /*
   * 同名不算「换情绪」—— 那是同一层淡到阈值以下之后重新装一次（惯性续不上时的
   * 退路）。这时留余波等于让同一种情绪叠在自己身上：画面没变化，层数却多了
   * 一层，面板上还会读出「开心 + 开心·余」。
   */
  if (strongest.name === incoming?.name) return null;
  if (!emotionsRelated(strongest.name, incoming?.name)) return null;
  const params = {};
  for (const [id, raw] of Object.entries(strongest.params ?? {})) {
    const scaled = finiteOr(raw, 0) * EMOTION_RESIDUE_WEIGHT;
    if (scaled !== 0) params[id] = scaled;
  }
  if (Object.keys(params).length === 0) return null;
  return {
    name: strongest.name,
    params,
    elapsedMs: 0,
    // `holdMs: 0` 是「一直保持」，乘上 `fadeAt: 0` 就是「立刻开始线性化掉」——
    // 两个现成机制拼出来的余波，不需要给包络再加一种形状。
    holdMs: 0,
    attackMs: 0,
    releaseMs: 0,
    decayMs: 0,
    fadeAt: 0,
    fadeMs: EMOTION_RESIDUE_MS,
    residue: true,
  };
}

/**
 * 装一层新的情绪（`layer` 来自 `resolveEmotion().emotion`）。
 *
 * 返回 `{state, released, reused}`：`released` 是有几层被推进了退场，
 * `reused` 表示这一条被并进了已在场的同一层（没有重来）。
 */
export function setEmotionLayers(state, layer, options = {}) {
  const current = Array.isArray(state?.layers) ? state.layers : [];
  const incoming = layer !== null && typeof layer === 'object' ? layer : null;
  if (incoming === null) return { state: { layers: current, active: [] }, released: 0, reused: false };

  const sameName = typeof incoming.name === 'string' && incoming.name !== ''
    ? current.find((item) => item?.name === incoming.name
      && layerWeight(item, finiteOr(item.elapsedMs, 0)) >= EMOTION_REUSE_WEIGHT)
    : undefined;
  if (sameName !== undefined) {
    const extended = {
      ...sameName,
      /*
       * ★ 已经**在退场**的同一层，被这一条救回来。
       *
       * 没有这两行会出一个很轻但看得见的毛病：「收掉思考态」与「推上思考态」
       * 现在只隔一次工具调用（每一步各一次），而正在化掉的那一层如果还被算作
       * 「基本在场」，它就会带着退场因子被续命 —— 表现是她脸上的思考态化到一半
       * 停住，然后慢慢shrink，比化干净或者续上都不自然。撤掉退场因子才是
       * 「这一层还在场」的正确表达。
       */
      fadeAt: null,
      fadeMs: 0,
      // 续上它的保持时间；`holdMs === 0` 的层本来就是「一直保持」，不用动。
      holdMs: sameName.holdMs === 0 || incoming.holdMs === 0
        ? 0
        : finiteOr(sameName.holdMs, 0) + finiteOr(incoming.holdMs, EMOTION_DEFAULT_HOLD_MS),
    };
    return {
      state: { layers: current.map((item) => (item === sameName ? extended : item)), active: [] },
      released: 0,
      reused: true,
      // 续命路径没有「旧层退场」，所以也没有余波 —— 但字段要一直在（调用方按它分支）。
      residue: '',
    };
  }

  const fadeMs = clamp(finiteOr(options?.fadeMs, EMOTION_SWITCH_FADE_MS), 0, EMOTION_MAX_FADE_MS);
  const released = current.map((item) => releaseLayer(item, fadeMs));
  const residue = buildResidue(current, incoming);
  return {
    state: {
      layers: [
        ...released,
        ...(residue === null ? [] : [residue]),
        {
          name: incoming.name,
          params: incoming.params ?? {},
          elapsedMs: 0,
          holdMs: finiteOr(incoming.holdMs, EMOTION_DEFAULT_HOLD_MS),
          attackMs: finiteOr(incoming.attackMs, EMOTION_ATTACK_MS),
          releaseMs: finiteOr(incoming.releaseMs, EMOTION_RELEASE_MS),
          decayMs: finiteOr(incoming.decayMs, EMOTION_DECAY_MS),
          fadeAt: null,
          fadeMs: 0,
        },
      ],
      active: [],
    },
    released: released.length,
    reused: false,
    residue: residue === null ? '' : residue.name,
  };
}

/** 把所有活着的层推进退场（「平静」与「回正」走这条路）。 */
export function clearEmotionLayers(state, options = {}) {
  const current = Array.isArray(state?.layers) ? state.layers : [];
  const fadeMs = clamp(finiteOr(options?.fadeMs, EMOTION_CLEAR_FADE_MS), 0, EMOTION_MAX_FADE_MS);
  return { state: { layers: current.map((item) => releaseLayer(item, fadeMs)), active: [] }, cleared: current.length };
}

/**
 * ★ 按**名字**把某几层推进退场 —— 「一层一层地收」，而不是一把全清。
 *
 * 在这之前只有两条路能让她脸上少点东西：「装一层新的」（会把**其他所有层**
 * 一起推去退场）与「平静」（把所有层推去退场）。两处需要「只收自己那一层」
 * 的地方因此都收过了头，而且都发生在**每一步结束**的那个瞬间：
 *   · 思考态那层是每一步结束时收的，而它顺手把我刚点名让她保持 30 秒的「开心」
 *     一起抹了 —— 用户看到的不是我失约，是她笑了一下就收；
 *   · 一句自动情绪（保持 5 秒）往往不是自己淡出的，是被**下一步结束时的清空
 *     剪断**的 —— 屏幕上就是「刚笑半秒就没了」，日志里一个字都没有。
 * 两件事的共同点：该收的那一层是知道的，只是当时没有「只收它」这个说法。
 *
 * `names` 里认不出、或此刻不在场的名字**不当错误**：收一层本来就没挂上的层
 * 是正常情况（比如思考态已经自己到期了），调用方只管要，结果如实回报在
 * `unknown` 里 —— 诊断要能看出「我要求收，但当时不在了」这个区别。
 */
export function releaseEmotionLayers(state, names, options = {}) {
  const current = Array.isArray(state?.layers) ? state.layers : [];
  const wanted = [...new Set(
    (Array.isArray(names) ? names : [names])
      .map((name) => (typeof name === 'string' ? name.trim() : ''))
      .filter((name) => name !== ''),
  )];
  if (wanted.length === 0) return { state: { layers: current, active: [] }, released: [], unknown: [] };

  const fadeMs = clamp(finiteOr(options?.fadeMs, EMOTION_CLEAR_FADE_MS), 0, EMOTION_MAX_FADE_MS);
  const released = [];
  const layers = current.map((item) => {
    const name = typeof item?.name === 'string' ? item.name : '';
    if (!wanted.includes(name)) return item;
    if (item?.fadeAt !== null && item?.fadeAt !== undefined) return item; // 已经在退场，从原来那一刻继续化
    released.push(name);
    return releaseLayer(item, fadeMs);
  });
  const unknown = wanted.filter((name) => !current.some((item) => item?.name === name));
  return { state: { layers, active: [] }, released, unknown };
}

/**
 * 过一帧：把 `deltaMs` 加进每一层的寿命，算出这一帧要往脸上叠什么。
 *
 * 返回 `{state, values, active, dropped}`：
 *   · `values` —— 参数 id → 这一帧的**增量之和**（渲染端直接 `addParameterValue`）；
 *   · `active` —— 还活着的层与它们此刻的权重（面板与诊断读它）；
 *   · `dropped` —— 这一帧结束掉的层数。
 *
 * 权重到 0 的层**从表里摘掉**，不停留：留着它会让「她现在有没有情绪」永远答「有」。
 */
export function advanceEmotionLayers(state, deltaMs) {
  const delta = Math.max(0, finiteOr(deltaMs, 0));
  const layers = [];
  const active = [];
  const values = {};
  let dropped = 0;

  for (const layer of Array.isArray(state?.layers) ? state.layers : []) {
    const elapsedMs = finiteOr(layer?.elapsedMs, 0) + delta;
    const weight = layerWeight(layer, elapsedMs);
    if (weight <= 0) {
      dropped += 1;
      continue;
    }
    for (const [id, raw] of Object.entries(layer?.params ?? {})) {
      const add = finiteOr(raw, 0) * weight;
      if (add === 0) continue;
      values[id] = (values[id] ?? 0) + add;
    }
    layers.push({ ...layer, elapsedMs });
    active.push({ name: layer?.name ?? '', weight, residue: layer?.residue === true });
  }

  return { state: { layers, active }, values, active, dropped };
}

/**
 * 这张脸上此刻是什么 —— 一句话，给面板与诊断用。
 *
 * 两层同时在场时**两层都写**（`难过+开心`）：「她现在是开心的」这种单值答案在
 * 交叉淡出的那 260ms 里本来就是假的，而面板恰好在那些时刻最需要说真话。
 */
export function describeEmotionLayers(state) {
  const active = Array.isArray(state?.active) ? state.active : [];
  if (active.length === 0) return '';
  return active
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((item) => {
      // 余波不是「她现在是什么情绪」，是「刚过去的那层留下的味道」—— 名字后面
      // 加个「·余」，面板与日志才不会把它读成第二层同时在场的主情绪。
      const name = item.residue === true ? `${item.name}·余` : item.name;
      return active.length > 1 ? `${name}(${item.weight.toFixed(2)})` : name;
    })
    .join('+');
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★ 静息漂移（§13.33）—— 「没有任何情绪时，脸上仍然有的那一点东西」
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 问题不是「表情不够」，是「不动的时候像一张图」。微动作（`idle-garnish` /
 * `micro-motion`）解决的是「每隔几秒来一下」，但两次之间她是完全静止的 ——
 * 真实的活人不是这样：呼吸、重心、视线总在极慢地游移。
 *
 * 这一层就是那个「游移」：两条不同周期的正弦叠起来（周期 9–32 秒 + 4–13 秒），
 * 幅度按**参数量程的比例**给，所以 ±30 度的头和 ±10 度的头看起来一样轻。
 *
 * 三条边界：
 *  - **不碰嘴、不碰眨眼、不碰眼睛开合**：那三样各有主人（口型通道 / 眨眼系统 /
 *    情绪层），漂移只借「头、视线、眉毛」这几根不会被别人按住的轴；
 *  - **幅度上限是「量程的 2–3%」**：比微动作小一个量级。它是背景，不该被看见，
 *    只该在「关掉它」的那一刻被发现；
 *  - **纯函数**：时间由调用方给（渲染端的帧时钟），所以门禁可以喂任意时刻断言，
 *    也不会因为跑得慢而漂移变快。
 */

/** 角色 → 波形的比例/频率/相位。`ratio` 是「占该参数全量程的几分之几」。 */
const AMBIENT_DRIFT_WAVES = Object.freeze({
  angleZ: Object.freeze({ ratio: 0.024, f1: 0.047, f2: 0.113, phase: 0.9 }),
  angleX: Object.freeze({ ratio: 0.016, f1: 0.037, f2: 0.089, phase: 2.1 }),
  angleY: Object.freeze({ ratio: 0.014, f1: 0.031, f2: 0.071, phase: 4.2 }),
  eyeBallX: Object.freeze({ ratio: 0.010, f1: 0.071, f2: 0.163, phase: 1.3 }),
  eyeBallY: Object.freeze({ ratio: 0.008, f1: 0.061, f2: 0.137, phase: 3.4 }),
  browLY: Object.freeze({ ratio: 0.006, f1: 0.043, f2: 0.097, phase: 0.2 }),
  browRY: Object.freeze({ ratio: 0.006, f1: 0.039, f2: 0.091, phase: 1.7 }),
});

/** 漂移用到哪些角色（顺序即写入顺序，便于门禁对账）。 */
export function ambientDriftRoles() {
  return Object.keys(AMBIENT_DRIFT_WAVES);
}

/**
 * 把角色解析成这个模型上的真实参数 id 与幅度（每只模型解析一次就够）。
 *
 * @param {Array<{id:string,min:number,max:number,def:number}>|Map} parameters 能力清单
 * @param {object} [bindings] 面板里攒的「角色 → 参数 id」覆盖表
 * @returns {Record<string, {id: string, amp: number}>}
 */
export function resolveAmbientDrift(parameters, bindings) {
  const declared = parameters instanceof Map ? parameters : new Map();
  if (!(parameters instanceof Map) && Array.isArray(parameters)) {
    for (const item of parameters) {
      if (item !== null && typeof item === 'object' && typeof item.id === 'string') declared.set(item.id, item);
    }
  }
  const roles = normalizeEmotionBindings(bindings).roles;
  const resolved = {};
  for (const [role, wave] of Object.entries(AMBIENT_DRIFT_WAVES)) {
    const pick = pickRoleParameter(role, declared, roles);
    if (pick.id === null) continue;
    const info = declared.get(pick.id) ?? {};
    const min = finiteOr(info.min, -1);
    const max = finiteOr(info.max, 1);
    const span = Math.abs(max - min);
    if (!(span > 0)) continue;
    resolved[role] = { id: pick.id, amp: span * wave.ratio };
  }
  return resolved;
}

/**
 * 某一刻的漂移增量（参数 id → 增量）。
 *
 * @param {number} timeMs 渲染端的累计毫秒（不是墙钟 —— 暂停时不该继续走）
 * @param {Record<string,{id:string,amp:number}>} resolved `resolveAmbientDrift()` 的产物
 * @param {{factor?: number, strength?: number}} [options]
 *        `factor` 是「收着点」的折扣（思考/安静时），`strength` 是全局强度
 *        （0 表示关掉这一层，面板以后要开关就用它）。
 */
export function ambientDriftValues(timeMs, resolved, options = {}) {
  const t = finiteOr(timeMs, 0) / 1000;
  const factor = clamp(finiteOr(options?.factor, 1), 0, 1) * clamp(finiteOr(options?.strength, EMOTION_AMBIENT_STRENGTH), 0, 2);
  const values = {};
  if (factor <= 0) return values;
  for (const [role, entry] of Object.entries(resolved ?? {})) {
    const wave = AMBIENT_DRIFT_WAVES[role];
    if (wave === undefined || entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
    const shape = Math.sin(2 * Math.PI * wave.f1 * t + wave.phase)
      + 0.45 * Math.sin(2 * Math.PI * wave.f2 * t + wave.phase * 1.7);
    const delta = (entry.amp * shape / 1.45) * factor;
    if (Math.abs(delta) <= 1e-6) continue;
    values[entry.id] = (values[entry.id] ?? 0) + delta;
  }
  return values;
}
