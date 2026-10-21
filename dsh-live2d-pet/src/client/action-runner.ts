/**
 * AI 指令的**执行层**（渲染端）。
 *
 * 为什么单独一个文件、而不是塞进 `plugin.ts` 的轮询回调里：
 * 「这条指令该调哪个方法、参数该怎么取、过期了要不要丢」全是能断言的判断题，
 * 而 `plugin.ts` 里的代码跑在 React 的 effect 里 —— 那里只能靠「我在浏览器里
 * 点了一下，看着是对的」来验收。搬到纯函数里，`tools/test-action-runner.mjs`
 * 才能用一个**假 target** 把每个分支都跑一遍。
 *
 * 三条硬约束（每一轮改动都要守住）：
 * ① **绝不抛异常。** 调用方是每 1.2 秒跑一次的轮询；抛出去就是在 React 的
 *    effect 里炸，而客户端半区抛错会拖着整个外壳一起白屏（方案 §9.2）。
 *    所以失败是返回值。
 * ② **不认得的指令要如实说「没处理」**，不能假装成功。Host 与渲染端是两半，
 *    新 Host 可能发来渲染端还不认识的 kind —— 那时「什么都没发生」必须能从
 *    日志里看出来，否则排查方向会跑到「AI 是不是没说话」上去。
 * ③ **口型参数不在这里拦。** 拦截在 `lib/host/actions.js` 与 `PetModel` 内部
 *    各有一道（同一份 `isExclusiveParameter()`），这里只负责把 `payload.params`
 *    原样递过去，不重复实现一遍判断 —— 三处各写一份规则迟早会有一处写漏。
 */

/** 指令的形状。字段全是 `unknown`：它来自网线，不是我们自己造的。 */
export interface ActionCommand {
  kind?: unknown;
  priority?: unknown;
  ttlMs?: unknown;
  payload?: {
    text?: unknown;
    /** §4.1：缺省为 true（`interruptOf()` 只看它是不是明确的 `false`）。 */
    interrupt?: unknown;
    voice?: unknown;
    rate?: unknown;
    motion?: { group?: unknown; index?: unknown; fadeMs?: unknown; loop?: unknown };
    expression?: { name?: unknown; holdMs?: unknown };
    look?: { x?: unknown; y?: unknown; durationMs?: unknown };
    /**
     * 情绪层。`params` 是**增量**（相对模型默认值），不是绝对值 ——
     * 它的解析已经在 Host 半区完成（`lib/host/emotions.js`），这里只负责落地。
     */
    emotion?: {
      name?: unknown;
      intensity?: unknown;
      holdMs?: unknown;
      attackMs?: unknown;
      releaseMs?: unknown;
      /**
       * ★ 退场形状（§13.33）：`> 0` 走指数尾（单位毫秒的 τ），`0` 走线性。
       * 新 Host 一定带这个字段；旧 Host 只有 `releaseMs`（那时按老的线性走）。
       */
      decayMs?: unknown;
      params?: Record<string, unknown>;
      /**
       * ★ 「按名字收掉指定的层」——和 `name` **互斥**（Host 半区会拦同时给的那种）。
       * 它是一条**没有名字也没有参数**的指令：只收 `release` 里点到的层，别的
       * 一律不动（`平静` 那种一把全清会把我点名让她保持的情绪也抹掉）。
       */
      release?: unknown;
    };
    params?: Record<string, unknown>;
    /**
     * 单条微动作（§13.30）。`id` 由 Host 拿着当前模型那一份包校验过，
     * 渲染端只负责在**自己那份包**里找到它并立刻起演 —— 找不到就如实报错，
     * 不能假装演过了（她的脸没动，而 AI 那边已经拿到「成功」）。
     */
    microMotion?: { id?: unknown };
  } | null;
  /** 旧 Host 的兼容垫片会把它放在顶层（`{kind:'speak', text}`）。 */
  text?: unknown;
}

/**
 * 目标方法自己的返回形状（`PetModel` 那一侧的 `MotionResult` 就是它）。
 *
 * 刻意与 `ActionResult` 分开：`handled` 是「这条指令归不归这个执行器管」，
 * 是执行层才知道的事；目标方法只回答「我做成了没有」。让它们共用一个类型，
 * 就得逼 `PetModel` 也去表态一件它无权判断的事。
 */
export interface TargetResult {
  ok: boolean;
  code: string;
  detail: string;
}

/**
 * `playMotion()` 的返回形状 —— 比 {@link TargetResult} 多两个**只有播放成功
 * 才有意义**的数（§13.31）。
 *
 * 为什么要这两个数：自动待机要按「这一条的片段时长」决定什么时候换下一条，
 * 还要记住「这次演的是第几号」以便下一次避开它。把它们塞进 `detail` 字符串里
 * 再解析，是一层没人维护得住的隐式契约。
 *
 * 两个字段都是可选的：老 bundle / 假 target 没有它们时，调用方必须退回
 * 20 秒一刀切的老节奏，而不是崩掉。
 */
export interface MotionTargetResult extends TargetResult {
  /** 这一次真正播的是组内第几号（`index` 省略、由渲染端随机挑时才知道）。 */
  motionIndex?: number;
  /** 这一条的片段时长（毫秒）。循环播放时它是**一个循环**的长度。 */
  motionDurationMs?: number;
}

/**
 * 渲染端真正干活的那半边。
 *
 * 抽成接口而不是直接收 `PetModel`：`PetModel` 需要在浏览器里、要 WebGL、要
 * Cubism Core 才能构造，那样这个文件就永远只能靠肉眼看。一个记下调用的假对象
 * 就足够把每条分支钉住。
 */
export interface ActionTarget {
  playMotion(
    group: string,
    index?: number,
    options?: {
      fadeMs?: number;
      loop?: boolean;
      priority?: number;
      /**
       * 别挑这一个序号（§13.31）。
       *
       * 只在 `index` 省略、由渲染端随机挑时生效：给 `1/count` 的重演概率打上
       * 一个「刚演过的那条不选」的补丁。显式给了 `index` 时它必须被忽略 ——
       * AI 点名要第 3 个动作，不能因为「上次也是第 3 个」就改成第 4 个。
       */
      avoidIndex?: number;
    },
  ): Promise<MotionTargetResult>;
  /**
   * 换表情。
   *
   * 契约表 §4.1 里这个方法的第二个参数写了 `weight?`，**实现里没有** ——
   * Framework 兑现不了「按权重混合单个表情」，留着它只会让调用方以为设过。
   * 详见方案 §4.2.8。`holdMs` 是真能生效的那个（到点硬切回无表情）。
   */
  setExpression(name: string, options?: { holdMs?: number }): Promise<TargetResult>;
  /**
   * 看向 `(x, y)`，两个分量都在 `[-1, 1]`。
   *
   * `options.durationMs` 是 §4.1 契约里的第三个参数（默认 400，上限 5000）。
   * 它曾经在这里被丢掉 —— 见方案 §4.2.7。**别再让它变成可选装饰**。
   */
  lookAt(x: number, y: number, options?: { durationMs?: number }): TargetResult;
  /** 模型里有哪些动作组 —— 自动待机要在里面挑一个。 */
  motionGroupNames(): string[];
  /**
   * 正在播的那一段动作的优先级（`0` = 什么都没在播）。
   *
   * 直接回框架的 `CubismMotionManager.getCurrentPriority()` —— 框架在动作播完时
   * 自己会把它清回 `0`（`cubismmotionmanager.ts:89-91`），所以它同时回答了
   * 「有没有在播」和「在播的是谁要的」两个问题。自动待机就靠它避免
   * 把 AI 要的动作顶掉（见 `shouldAutoIdle()`）。
   */
  currentMotionPriority(): number;
  /**
   * 「她正在想事情」这个事实，从指令层传到渲染层。
   *
   * 它不是一条 §4.1 的指令 —— 没有 payload、没有过期时间，也不该被用户看见。
   * 来源是 Host 在 `/pending` 里顺带报的 `mood.state`（`lib/host/mood.js` 的状态机），
   * 渲染端据此把待机动作的**幅度**收小（细节在 `motion-calm.ts`）。
   *
   * 可选：没有新版 Host 时它不存在，渲染端就该完全不收 —— 这也正是
   * 「行为改变必须能被一条不存在的字段挡住」的意思。
   */
  setMotionCalm?(active: boolean): void;
  stopMotion(): void;
  clearExpression(): void;
  setParameterOverride(
    values: Record<string, number>,
    holdMs?: number,
  ): { applied: string[]; dropped: string[]; ignored: string[] };
  clearParameterOverrides(): void;
  /**
   * 叠一层情绪（参数**增量**）。
   *
   * 与 `setParameterOverride` 的根本差别是**加法**：那个是硬覆盖（写在每一帧的
   * 最后、权重 1），会盖掉眨眼、表情和动作自带的脸部曲线；这个是
   * `addParameterValueById()`，和它们共存 —— 「开心」与「正在眨眼」必须能同时
   * 成立，否则她一笑就不眨眼了（而眨眼恰恰是我们唯一一直开着的生气信号）。
   *
   * `holdMs` 到了之后是**淡出**（`releaseMs`），不是硬切；`holdMs === 0` 表示
   * 一直保持到下一个情绪或 `clearEmotion()`。
   */
  setEmotion(
    values: Record<string, number>,
    options?: { holdMs?: number; attackMs?: number; releaseMs?: number; decayMs?: number; name?: string },
  ): { applied: string[]; ignored: string[] };
  clearEmotion(): void;
  /**
   * ★ 按**名字**收掉某几层 —— 与 `clearEmotion()` 的差别就是「只收它」。
   *
   * `clearEmotion()` 是一把全收（「平静」「回正」用它），而这一步结束时该做的
   * 只是「把思考态收掉」：它顺手把当时还挂着的别的层（比如我点名让她保持
   * 30 秒的「开心」）一起抹掉，用户看到的是她笑了一下就收。名字对不上、
   * 或者那一层已经自己到期了都不算错，如实回报在 `unknown` 里 —— 诊断要能
   * 区分「我要求收，但当时它已经不在了」。
   */
  releaseEmotion(names: string[]): { released: string[]; unknown: string[] };
  /**
   * 立刻演一条微动作（§13.30）。
   *
   * 为什么放在 `ActionTarget` 而不是塞进 `setParameterOverride`：微动作不是一组
   * 静态参数，它有**自己的包络与节奏**（`attack/hold/release`、trailing 延迟、
   * 语速档的挑选权重）。用硬覆盖去模拟它，等于把 `micro-motion.ts` 那一层
   * 重写一遍 —— 而且是在两个地方各写一遍。
   *
   * **可选**：旧渲染端（刷新前的那个 `client.js`）没有它。可选方法让
   * 「新 Host + 旧页面」这条时间窗走 `E_ACTION_UNSUPPORTED` 而不是 undefined 崩掉。
   */
  playMicroMotion?(id: string): TargetResult;
}

/** 说话那一半（`speech.ts` 的播放器）—— 与模型无关，所以单独一组。 */
export interface ActionHooks {
  /**
   * 说一句。
   *
   * 三个可选参数**全部**来自 §4.1 的 `live2d_speak` 契约，而它们曾经有三个
   * 不同的下场 —— 这正好是一张「参数是怎么丢的」的标本：
   *
   * - `interrupt`（默认 true）—— **一路传到渲染端、在最后一步被丢掉**：
   *   `lib/host/actions.js` 老实把它写进 `payload`，`lib/index.js` 的工具描述也向
   *   LLM 承诺了「默认 true，设为 false 会排在它后面」，而 `say` 分支只把文本交给
   *   播放器。于是两个值表现**完全一样**、且**不报任何错**。
   * - `voice` / `rate` —— **连这一步都没走到**：工具 schema 里 advertises 着、Host 的
   *   `/speak` 路由也真的收（`lib/index.js` 把它们交给 `tts.synthesize()`，Edge-TTS
   *   的缓存键 `voice|rate|pitch|text` 也把它们算进去了），只有渲染端没读。
   *   LLM 接到「说快一点」会传 `rate: '+30%'`，然后什么都不会发生。
   *
   * 三者是同一类缺陷：**契约写在两端、中间那一层没实现**，而两端的测试各自都是绿的。
   * 所以这里的签名把三个都列出来，`[3b]` 段对三个都断言。
   */
  speak(text: string, options?: { interrupt?: boolean; voice?: string; rate?: string }): Promise<void>;
  stopSpeech(): void;
}

export interface ActionResult {
  /** `false` = 这条指令不是给这个执行器的（不认得的 kind），而不是「失败了」。 */
  handled: boolean;
  ok: boolean;
  code: string;
  detail: string;
}

/**
 * 渲染端认识的指令种类。
 *
 * `gesture` 不在里面：§4.1 的 ActionCommand 表里它是 `payload` 的一个字段
 * （`gesture{nod,intensity}`），不是独立的 kind。渲染端目前忽略它 ——
 * 那是一个**已知的缺口**，写在方案 §4.1.1 里，而不是悄悄当它不存在。
 */
export const HANDLED_KINDS = Object.freeze([
  'say',
  'motion',
  'expression',
  'look',
  'emotion',
  'param',
  'microMotion',
  'stop',
  'idle',
]);

// ---------------------------------------------------------------------------
// 当前生效的执行目标（插件级单例）
// ---------------------------------------------------------------------------

/**
 * 为什么是模块级单例：`Live2DStage`（模型在这里）与 `Live2DOverlay`（轮询在这里）
 * 是父子组件，但它们之间只隔着一层 props，而模型的实例活在 `Live2DStage` 的
 * effect 里、每次换装都会被替换。让渲染循环在 activate 之后把新实例登记到这里，
 * 轮询那边每次现取 —— 这样「换装中收到的指令」和「换装后收到的指令」都作用于
 * 正确的那一只模型，不需要把模型实例提升成 React state（那会让每次换装都
 * 触发整棵树重渲染）。
 */
let currentTarget: ActionTarget | null = null;

export function setActionTarget(target: ActionTarget | null): void {
  currentTarget = target;
}

export function getActionTarget(): ActionTarget | null {
  return currentTarget;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/** 失败结果。所有分支都经过它，保证形状恒定。 */
function fail(code: string, detail: string): ActionResult {
  return { handled: true, ok: false, code, detail };
}

function done(detail: string): ActionResult {
  return { handled: true, ok: true, code: '', detail };
}

/**
 * 旧 Host 的垫片把 `say` 写成 `speak`（见 `lib/index.js` 的 `pushCommand`）。
 * 两种拼写都认 —— 那段窗口里浏览器可能还跑着刷新前的 `client.js`，
 * 而这次反过来：Host 已经是新版、页面还是旧版。
 */
function normalizedKind(command: ActionCommand | null | undefined): string {
  const kind = command === null || command === undefined ? undefined : command.kind;
  if (kind === 'speak') {
    return 'say';
  }
  return typeof kind === 'string' ? kind : '';
}

function textOf(command: ActionCommand): string {
  const payload = command.payload;
  if (payload !== null && payload !== undefined && typeof payload.text === 'string') {
    return payload.text;
  }
  // 兼容垫片的形状：`{kind:'speak', text}`。
  return typeof command.text === 'string' ? command.text : '';
}

/**
 * §4.1：`interrupt` **缺省为 true**。
 *
 * 只在明确写了 `false` 的时候才不打断 —— 旧垫片的 `{kind:'speak', text}` 没有
 * 这个字段，按契约它也该是「打断」。
 */
function interruptOf(command: ActionCommand): boolean {
  const payload = command.payload;
  if (payload === null || payload === undefined) {
    return true;
  }
  return payload.interrupt !== false;
}

/**
 * §4.1：`voice` / `rate` 是可选的，缺省由 Host 的 Edge-TTS 适配器决定
 * （`zh-CN-XiaoxiaoNeural` / `+0%`）。
 *
 * 只接受**非空字符串**，其余一律当「没写」交给 Host 兜底 —— 传一个空串过去会让
 * `tts.synthesize()` 里的 `options.voice || DEFAULT_VOICE` 走到默认分支（那里的
 * 行为是对的），真正的问题是空串还会进缓存键，等于白占一格缓存。
 */
function textOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function voiceOf(command: ActionCommand): string | undefined {
  return textOption(command.payload?.voice);
}

function rateOf(command: ActionCommand): string | undefined {
  return textOption(command.payload?.rate);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && isFinite(value) ? value : undefined;
}

/**
 * 框架侧的动作优先级（`PetModel` 的 `MOTION_PRIORITY`）。
 *
 * 与 §4.1 的**指令**优先级（50 / 100）是两个刻度，别混：
 * 指令优先级说的是「这条指令与其他指令比，该不该插队」；这个说的是
 * 「这一段动作与正在播的那一段比，谁压得住谁」。
 *
 * ⚠️ 这里曾经写着「真正干活的是框架的 `MotionQueueManager`，`startMotionPriority`
 * 里会比较当前条目的优先级、低的直接被顶掉」—— **那句话是错的**。
 * 读过框架源码之后：`CubismMotionManager.startMotionPriority()`
 * （`framework/src/motion/cubismmotionmanager.ts:62-74`）只做两件事 ——
 * 记下 `_currentPriority`，然后无条件调 `super.startMotion(motion, autoDelete)`；
 * 而 `CubismMotionQueueManager.startMotion()`（`cubismmotionqueuemanager.ts:56-84`）
 * 无条件把新条目推进队列、并把已有条目全部标成淡出。**优先级不参与任何判断**，
 * 只有官方 `LAppModel.startMotion()` 那个包装里才会先问一句
 * `reserveMotion(priority)`（`cubismmotionmanager.ts:103-114`）——
 * 而 `PetModel.playMotion()` 直接调的是 `startMotionPriority()`，没走那一层。
 *
 * 所以：**任何一段动作都会顶掉任何一段动作**，无论优先级。
 * `motionPriorityFor()` 的映射因此不是为了「让新动作压得住旧的」（那本来就成立），
 * 而是为了让 `_currentPriority` 这个**可读回来的数字**能区分
 * 「正在播的是我们自己的待机动作」与「正在播的是 AI 要的动作」——
 * 自动待机靠它决定该不该出手（见 `shouldAutoIdle()` 的第四个条件）。
 * 详见方案 §4.2.12。
 */
export const FRAMEWORK_PRIORITY = Object.freeze({ IDLE: 1, NORMAL: 2, FORCE: 3 });

export function motionPriorityFor(commandPriority: unknown): number {
  return typeof commandPriority === 'number' && isFinite(commandPriority) && commandPriority >= 100
    ? FRAMEWORK_PRIORITY.FORCE
    : FRAMEWORK_PRIORITY.NORMAL;
}

/**
 * 指令过期了没有。
 *
 * **必须在渲染端也判一次**：Host 的 `pruneQueue()` 只在**入队时**裁剪，所以
 * 「面板折叠了 30 秒、期间 AI 连发八句」的结果是，轮询拿到的八条里有七条早就
 * 过期了。Host 那边的裁剪不是替代品，只是让队列不至于无限长。
 *
 * `stop` 是**唯一的例外**，它永远不过期：一条 4 秒前的 `stop` 最坏也只是停下
 * 一个已经停下的东西，而把它丢掉则会让「立刻停下」变成「什么都不做」——
 * 那正是用户喊停时最不希望发生的事。
 */
export function isExpired(command: unknown, at: unknown, nowMs: number): boolean {
  const cmd = command as ActionCommand | null | undefined;
  if (normalizedKind(cmd) === 'stop') {
    return false;
  }
  const ttl = cmd === null || cmd === undefined ? undefined : cmd.ttlMs;
  if (typeof ttl !== 'number' || !isFinite(ttl) || ttl <= 0) {
    return false;
  }
  if (typeof at !== 'number' || !isFinite(at)) {
    return false;
  }
  return nowMs - at > ttl;
}

/** 把 `payload.params` 里能用的挑出来。值必须是有限数字，其余丢掉。 */
export function collectParameters(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'number' && isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 执行一条指令。**任何情况下都不抛。**
 *
 * `target === null` 表示「现在没有模型」（页面刚开、正在换装、或模型加载失败）。
 * 那时只有 `say` 与 `stop` 能干活：说话不依赖模型，而 `stop` 至少要能把声音停掉。
 */
export async function runAction(
  target: ActionTarget | null,
  command: ActionCommand | null | undefined,
  hooks: ActionHooks,
): Promise<ActionResult> {
  const kind = normalizedKind(command);
  if (kind === '') {
    return { handled: false, ok: false, code: 'E_ACTION_UNKNOWN_KIND', detail: '这条指令没有 kind。' };
  }
  const cmd = command as ActionCommand;

  try {
    switch (kind) {
      case 'say': {
        const text = textOf(cmd);
        if (text.trim() === '') {
          return fail('E_ACTION_EMPTY_TEXT', '这条说话的指令是空的。');
        }
        const interrupt = interruptOf(cmd);
        const voice = voiceOf(cmd);
        const rate = rateOf(cmd);
        await hooks.speak(text, { interrupt, voice, rate });
        return done(
          interrupt
            ? `说了 ${text.length} 个字（打断上一句）。`
            : `说了 ${text.length} 个字（排在后面）。`,
        );
      }

      case 'stop': {
        // 三件事都要做，顺序也是刻意的：先停声音（用户最先感知到），
        // 再停动作与表情（那是「她还在动」的来源）。
        hooks.stopSpeech();
        if (target !== null) {
          target.stopMotion();
          target.clearExpression();
          target.clearParameterOverrides();
        }
        return done('停下了。');
      }

      case 'idle': {
        if (target === null) {
          return done('现在没有模型，待机不需要做什么。');
        }
        target.stopMotion();
        target.clearExpression();
        target.clearParameterOverrides();
        // 视线回正：待机的意思是「不再盯着刚才那个点」。
        target.lookAt(0, 0);
        return done('回到待机。');
      }

      case 'motion': {
        if (target === null) {
          return fail('E_ACTION_NO_MODEL', '现在没有模型，动作没法播。');
        }
        const motion = cmd.payload === null || cmd.payload === undefined ? undefined : cmd.payload.motion;
        const group = motion === null || motion === undefined ? undefined : motion.group;
        if (typeof group !== 'string' || group === '') {
          return fail('E_ACTION_BAD_VALUE', '这条动作指令没说要播哪一组。');
        }
        const index = motion === undefined ? undefined : optionalNumber(motion.index);
        const fadeMs = motion === undefined ? undefined : optionalNumber(motion.fadeMs);
        const loop = motion === undefined ? undefined : motion.loop === true;
        const priority = motionPriorityFor(cmd.priority);
        const result = await target.playMotion(group, index, { fadeMs, loop, priority });
        return { handled: true, ok: result.ok, code: result.code, detail: result.detail };
      }

      case 'expression': {
        if (target === null) {
          return fail('E_ACTION_NO_MODEL', '现在没有模型，表情换不了。');
        }
        const expression =
          cmd.payload === null || cmd.payload === undefined ? undefined : cmd.payload.expression;
        const name = expression === null || expression === undefined ? undefined : expression.name;
        if (typeof name !== 'string' || name === '') {
          return fail('E_ACTION_BAD_VALUE', '这条表情指令没说要换哪一个。');
        }
        /*
         * 这里**读不到** `weight`，因为上游已经没有这个字段了。
         *
         * 契约表 §4.1 写过 `set_expression(name, weight?, holdMs?)`，但 Framework
         * 没有「按权重混合单个表情」这条路，参数会一路传到底、什么都不发生、还不报错。
         * 与其留一个永远不生效的旋钮，不如整条链上都不留 —— 详见方案 §4.2.8。
         */
        const holdMs = expression === undefined ? undefined : optionalNumber(expression.holdMs);
        const result = await target.setExpression(name, { holdMs });
        return { handled: true, ok: result.ok, code: result.code, detail: result.detail };
      }

      case 'look': {
        if (target === null) {
          return fail('E_ACTION_NO_MODEL', '现在没有模型，视线转不了。');
        }
        const look = cmd.payload === null || cmd.payload === undefined ? undefined : cmd.payload.look;
        const x = look === null || look === undefined ? 0 : finiteOr(look.x, 0);
        const y = look === null || look === undefined ? 0 : finiteOr(look.y, 0);
        // 时长在这一层曾是断点：Host 校验好、门禁钉好、画面上永远是同一个速度。
        const durationMs =
          look === null || look === undefined ? undefined : optionalNumber(look.durationMs);
        const result = target.lookAt(x, y, { durationMs });
        return { handled: true, ok: result.ok, code: result.code, detail: result.detail };
      }

      case 'microMotion': {
        const micro = cmd.payload === null || cmd.payload === undefined
          ? undefined
          : cmd.payload.microMotion;
        const id = micro === null || micro === undefined || typeof micro.id !== 'string'
          ? ''
          : micro.id.trim();
        if (id === '') return fail('E_ACTION_BAD_VALUE', '这条微动作指令没说要演哪一条。');
        if (target === null) return fail('E_ACTION_NO_MODEL', '现在没有模型，微动作没处安。');
        /*
         * 旧页面 + 新 Host：`playMicroMotion` 在刷新前的 bundle 里不存在。
         * 这时必须报错而不是「什么都没发生」—— 否则 AI 会说「她歪了下头」，
         * 而屏幕上的她一动不动。
         */
        if (typeof target.playMicroMotion !== 'function') {
          return fail('E_ACTION_UNSUPPORTED', '这个版本的渲染端还不会演单条微动作（刷新一次页面）。');
        }
        const result = target.playMicroMotion(id);
        return { handled: true, ok: result.ok, code: result.code, detail: result.detail };
      }

      case 'emotion': {
        if (target === null) {
          return fail('E_ACTION_NO_MODEL', '现在没有模型，情绪没处安。');
        }
        const emotion =
          cmd.payload === null || cmd.payload === undefined ? undefined : cmd.payload.emotion;
        const name = emotion === null || emotion === undefined ? '' : textOption(emotion.name);

        /*
         * ★ 「只收指定的层」走在这一段之前：它的 payload 里**没有名字也没有参数**
         * （只有 `release: ['思考']`），落进下面的空参数表分支会被当成坏指令。
         */
        const release = emotion === null || emotion === undefined || !Array.isArray(emotion.release)
          ? []
          : emotion.release.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
            .map((item) => item.trim());
        if (release.length > 0) {
          const outcome = target.releaseEmotion(release);
          const parts = [];
          if (outcome.released.length > 0) parts.push(`收掉 ${outcome.released.join('、')}`);
          if (outcome.unknown.length > 0) parts.push(`${outcome.unknown.join('、')} 当时不在场`);
          return done(`情绪层：${parts.length > 0 ? parts.join('；') : '没有可收的层'}。`);
        }

        const params = collectParameters(
          emotion === null || emotion === undefined ? undefined : emotion.params,
        );
        const ids = Object.keys(params);

        /*
         * 空参数表不是错误，而是「清空情绪层」——「平静」这条预设就是空的，
         * 它要表达的是「把之前那层撤掉」。区分这两种情况靠的是名字：
         * 有名无参 = 平静；连名字都没有 = 这条指令是坏的。
         */
        if (ids.length === 0) {
          if (name === undefined || name === '') {
            return fail('E_ACTION_BAD_VALUE', '这条情绪指令既没有名字也没有参数。');
          }
          target.clearEmotion();
          return done(`情绪层已清空（${name}）。`);
        }

        const outcome = target.setEmotion(params, {
          name,
          holdMs: optionalNumber(emotion?.holdMs),
          attackMs: optionalNumber(emotion?.attackMs),
          releaseMs: optionalNumber(emotion?.releaseMs),
          /*
           * ★ 退场形状（§13.33）：新 Host 会带 `decayMs`（不传 `releaseMs`）；
           * 旧 Host 只带 `releaseMs` —— 那时 `undefined` 落到 `setEmotion()` 的
           * 默认值，而默认值又会因为「有 releaseMs」自动走线性。两端都不用改协议。
           */
          decayMs: optionalNumber(emotion?.decayMs),
        });
        if (outcome.applied.length === 0) {
          // 模型里一个都没有 ⇒ 如实失败。预设表是按角色解析的，走到这里说明
          // 能力清单和模型的实际参数不一致（换装换了一半、或清单是旧的）。
          return fail(
            'E_ACTION_PARAMETER_IGNORED',
            `模型里没有这个情绪需要的参数：${outcome.ignored.join('、')}`,
          );
        }
        return done(
          `情绪「${name ?? '未命名'}」：叠上 ${outcome.applied.join('、')}`
            + (outcome.ignored.length > 0 ? `；模型没有 ${outcome.ignored.join('、')}` : ''),
        );
      }

      case 'param': {
        if (target === null) {
          return fail('E_ACTION_NO_MODEL', '现在没有模型，参数没法写。');
        }
        const params = collectParameters(
          cmd.payload === null || cmd.payload === undefined ? undefined : cmd.payload.params,
        );
        const ids = Object.keys(params);
        if (ids.length === 0) {
          return fail('E_ACTION_BAD_VALUE', '这条参数指令里没有可用的数值。');
        }
        // `holdMs` 借用指令自己的 TTL：一条 4 秒的指令不该把参数钉上一辈子。
        const holdMs = finiteOr(cmd.ttlMs, 0);
        const outcome = target.setParameterOverride(params, holdMs);
        // 空手而归要如实说，不能让 AI 以为它改动了什么。
        if (outcome.applied.length === 0) {
          const why =
            outcome.dropped.length > 0
              ? `这些是口型参数，由语音通道独占：${outcome.dropped.join('、')}`
              : `模型里没有这些参数：${outcome.ignored.join('、')}`;
          return fail('E_ACTION_PARAMETER_IGNORED', why);
        }
        return done(
          `写了 ${outcome.applied.join('、')}` +
            (outcome.dropped.length > 0 ? `；丢掉了口型参数 ${outcome.dropped.join('、')}` : ''),
        );
      }

      default:
        /*
         * 不认得的 kind：**如实说没处理**，但不是失败。
         * 新 Host 加了一种指令、页面还跑着旧 bundle 时走的就是这条路 ——
         * 那时「她没反应」的原因必须能从日志里读出来，否则会被归咎于 AI。
         */
        return {
          handled: false,
          ok: false,
          code: 'E_ACTION_UNSUPPORTED_KIND',
          detail: `渲染端还不认识「${kind}」这类指令（已认识的：${HANDLED_KINDS.join('、')}）。`,
        };
    }
  } catch (error) {
    // 兜底：`target` 的实现可能在任何一步抛（WebGL 上下文丢了、文件坏了……）。
    // 这里接住，绝不让它传回 React。
    const message = error instanceof Error ? error.message : String(error);
    return fail('E_ACTION_FAILED', `执行「${kind}」时出错：${message}`);
  }
}

/** 现取当前目标并执行。轮询那边的一行入口。 */
export async function runCurrentAction(
  command: ActionCommand | null | undefined,
  hooks: ActionHooks,
): Promise<ActionResult> {
  return runAction(currentTarget, command, hooks);
}

// ---------------------------------------------------------------------------
// 空闲行为（§5 的 P3 交付物之一）
// ---------------------------------------------------------------------------

/**
 * 多久没人搭理就自己动一下。
 *
 * 20 秒是**用户感知**上的取舍，不是性能取舍：短于 10 秒会让人觉得「她一直在动、
 * 有点吵」，长于 30 秒则「她是不是卡住了」。20 秒大约是一次对话停顿的长度。
 */
export const IDLE_AFTER_MS = 20000;

/**
 * 一条待机动作**连播几个循环**就换下一条（§13.31）。
 *
 * 这个数字是给「`Loop: true` 的片段」准备的：hiyori 的十条动作本身就是无缝
 * 循环片段（1.6–8.8 秒、`Meta.Loop: true`），我们又以 `loop: true` 播，
 * 于是「什么时候换」完全由换片节奏决定 —— 曾经是整 20 秒一刀切，1.6 秒的
 * 片段要在她身上重复 **12 遍**才轮到下一条，看起来就是「一直循环一个动作」。
 */
export const IDLE_LOOP_REPEATS = 2;

/** 换片节奏的下限：短于 6 秒会显得「她一直在换姿势、有点吵」。 */
export const IDLE_HOLD_MIN_MS = 6000;

/** 换片节奏的上限：长于 12 秒，短片段又要重复很多遍。 */
export const IDLE_HOLD_MAX_MS = 12000;

/**
 * 这条动作该在她身上停多久（毫秒）。
 *
 * 取「片段时长 × {@link IDLE_LOOP_REPEATS}」并夹到 6–12 秒：
 *   · 1.6 秒的短片段 → 6 秒（约 3.7 个循环，已经是下限了）；
 *   · 4.6 秒的中等片段 → 9.2 秒；
 *   · 8.8 秒的长片段 → 12 秒（不到两个循环，再长就单调了）。
 *
 * 时长读不到（老 bundle / 读失败）时退回上限：宁可慢一点，也不要每 6 秒
 * 换一次、把「待机」变成「一直动」。
 */
export function idleHoldMsFor(durationMs: unknown): number {
  const ms =
    typeof durationMs === 'number' && isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  if (ms <= 0) {
    return IDLE_HOLD_MAX_MS;
  }
  const wanted = Math.round(ms * IDLE_LOOP_REPEATS);
  return Math.max(IDLE_HOLD_MIN_MS, Math.min(IDLE_HOLD_MAX_MS, wanted));
}

/**
 * 在 `count` 个动作里挑一个序号，**尽量不跟上一条重**（§13.31）。
 *
 * 为什么要单独一个函数：随机挑一条时，连续两次撞上同一条的概率是 `1/count`
 * （hiyori 是 1/10）。她的十条又都是同风格的 VTS 待机动作，撞一次就像
 * 「还是那一个」。这里把「刚演过的那条」从候选里剔掉，其余仍然等概率。
 *
 * `avoidIndex` 非法（-1 / 越界 / 非数字）或者只有一条时，退回纯随机。
 * `random` 注入是为了门禁能穷举，而不是为了在运行时换随机源。
 */
export function pickIdleIndex(
  count: number,
  avoidIndex: unknown,
  random: () => number = Math.random,
): number {
  const total = typeof count === 'number' && isFinite(count) ? Math.trunc(count) : 0;
  if (total <= 0) {
    return -1;
  }
  const raw = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * total);
  if (total === 1) {
    return 0;
  }
  const avoid =
    typeof avoidIndex === 'number' && isFinite(avoidIndex) ? Math.trunc(avoidIndex) : -1;
  if (avoid < 0 || avoid >= total || raw !== avoid) {
    return raw;
  }
  // 撞上了：在剩下 `total - 1` 个里等概率挑一个，整体挪一格避开 avoid。
  const offset = 1 + Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * (total - 1));
  return (avoid + offset) % total;
}

/**
 * 该不该自动进待机。
 *
 * 四个条件缺一不可：
 * ① 距上次**有意义的指令**已超过 `idleAfterMs`（有人说话/要动作时不该自顾自待机）；
 * ② 距上次**自动待机**也超过 `idleAfterMs` —— 没有这一条，轮询每 1.2 秒就会
 *    重播一次动作，采样看起来正常，实际是每 1.2 秒重启一次动画（用户看到的是
 *    「她一直在抽第一帧」）；
 * ③ 时间戳得是数字。`lastActivityAt` 初始为 0 时不能算「很久没动」——
 *    首次待机由调用方在第一次轮询时把 `lastActivityAt` 初始化成当前时间；
 * ④ **当前正在播的不能是一段「正经动作」**（`currentMotionPriority` 高于待机档）。
 *
 * 第 ④ 条是**这一条链上唯一真正读优先级的地方**。它守的是那句写下来的承诺
 * ——「待机动作永远盖不掉正经动作」—— 因为框架其实**不拦**任何新动作：
 * `startMotionPriority()` 无条件开播（见 `FRAMEWORK_PRIORITY` 的注释），
 * 所以「待机盖不掉正经动作」这句话，只能由**待机自己先问一句**来实现。
 * 没有第 ④ 条时，AI 让播一段循环动作、或一段比 20 秒还长的动作，
 * 都会在 20 秒后被自动待机顶掉 —— 而且不报任何错。
 *
 * ⑤ **嘴还在动的时候不待机**（`speechBusy`）。前四条数的都是「距上次**指令**
 *    多久」，而一句长文本可以念四十秒：念到第 20 秒时计时器到点，她就会在
 *    **说话的同时**把姿势换掉 —— 用户看到的是「她一边说一边换了个动作」，
 *    很像卡了一下（这一条是 §9.7 第 6 条那个已知边界）。
 *    所以调用方要把「朗读通道还忙不忙」传进来
 *    （`plugin.ts` 用的是 `getSpeechLane().busy() || speech.state.speaking`）。
 *    注意这一条**必须住在函数里**，不能让调用方在外面 `&&`：那样它就只是调用方
 *    的一个 if，门禁断言不到「待机不打断朗读」这条规则（前四条住在这里，为的是同一件事）。
 *
 * 传入 `0`（什么都没在播）或 `IDLE`（在播的正是我们上一轮挑的待机动作）
 * 都算合格：前者无需多说，后者是「她一直在循环同一个待机动作，
 * 该换一个了」，所以待机仍然可以重新出手。
 */
export function shouldAutoIdle(
  lastActivityAt: number,
  lastAutoIdleAt: number,
  nowMs: number,
  currentMotionPriority: number,
  idleAfterMs: number = IDLE_AFTER_MS,
  speechBusy: boolean = false,
  holdMs: number = idleAfterMs,
): boolean {
  if (!isFinite(lastActivityAt) || !isFinite(lastAutoIdleAt) || !isFinite(nowMs)) {
    return false;
  }
  if (lastActivityAt <= 0) {
    return false;
  }
  if (speechBusy === true) {
    return false;
  }
  if (isBusyWithRealMotion(currentMotionPriority)) {
    return false;
  }
  /*
   * ① 与 ② 用的是**两个**阈值（§13.31）。
   *
   * ①「距上次指令」必须守住 20 秒 —— 那是「有人说话时不该自顾自待机」的承诺，
   *   不能被换片节奏带短。
   * ②「距上次待机」才是换片节奏：它随上一条动作的**片段时长**变（`idleHoldMsFor`），
   *   6–12 秒。两者一度是同一个 `idleAfterMs`，于是短片段要重复十几遍才换。
   */
  const hold = isFinite(holdMs) && holdMs > 0 ? holdMs : idleAfterMs;
  return nowMs - lastActivityAt >= idleAfterMs && nowMs - lastAutoIdleAt >= hold;
}

/**
 * 现在播着的这段动作，是不是「正经动作」（AI 要的），而不是我们自己的待机动作。
 *
 * 非有限数一律当「没有在播」—— 待机不该因为一个脏读数而永久停摆。
 */
export function isBusyWithRealMotion(currentMotionPriority: unknown): boolean {
  if (typeof currentMotionPriority !== 'number' || !isFinite(currentMotionPriority)) {
    return false;
  }
  return currentMotionPriority > FRAMEWORK_PRIORITY.IDLE;
}

/**
 * 现在播着的，是不是**我们上一轮自己挑的待机动作**。
 *
 * 单独写成一个函数，是因为这个判断决定一件有副作用的事：换待机之前要先把
 * 旧的那段**摘掉**（`ActionTarget.stopMotion()`）。
 *
 * ★ 【2026-02 更正】这里以前写着「`loop: true` 的动作框架永远不会回收，队列
 * 每 20 秒长一条、只进不出」。**那套推理是错的，已经实测证伪**，别再顺着它查：
 * 循环动作确实等不到「播到头」那个结束判定（`cubismmotion.ts:641-651` 的循环支
 * 不碰 finished 标志、`acubismmotion.ts:83-88` 要求 `endTime > 0` 而循环动作是
 * `-1`），**但回收根本不靠那条路**。真正的回收链是：
 *   · `startMotion()` 给队列里每一条都标上淡出（`cubismmotionqueuemanager.ts:68-75`）；
 *   · `doUpdateMotion()` 把淡出落实成结束时刻（`:280-284` → `startFadeOut`，
 *     `cubismmotionqueueentry.ts:58-68` 里 `endTime` 就是 `-1` 也会被赋上真值）；
 *   · `updateParameters()` 过了那个时刻置 `_finished = true`（`acubismmotion.ts:83-88`）；
 *   · `doUpdateMotion()` splice 掉已结束的条目（`:274-277`）。
 * 所以上一条循环动作最多多活一个淡出时长 —— 默认 0.3 秒（`capabilities.js:197-211`
 * 的 `DEFAULT_MOTION_FADE_SECONDS`；工具播的 ≤5 秒，`lib/host/actions.js:42`）。
 * 按 5 Hz 模拟 10 / 30 / **240** 分钟：队列深度始终是 1，峰值 2，单帧开销是常数，
 * 也不碰 WebGL（动作只在 CPU 侧写参数）。**它不是「跑一段时间突然卡住」的原因。**
 *
 * 那这里还留着这个判断干什么？因为它守的是**另一个真缺陷**（已修在
 * `pet-model.ts` 的 `stopMotion()` 里）：框架的 `stopAllMotions()` 只删得掉隔一条
 * （`cubismmotionqueuemanager.ts:152-170` 的 `splice(i, 1); continue;`），剩一条活的
 * 循环动作时 `currentMotionPriority()` 永远回不到 `IDLE`，于是 `shouldAutoIdle()` 的
 * 第四个条件恒假 —— 她会一直重复同一个姿势。那是行为缺陷，不是画面冻住。
 *
 * 阈值就是待机档本身：`IDLE`(1) 是记号，只有我们自己会写（见 `FRAMEWORK_PRIORITY`）。
 */
export function isOwnIdleMotion(currentMotionPriority: unknown): boolean {
  return currentMotionPriority === FRAMEWORK_PRIORITY.IDLE;
}

/**
 * 挑一个用来待机的动作组。
 *
 * 优先名字里含 `idle` 的（官方模型都叫 `Idle`，大小写不一）；没有就退到第一组。
 * 都没有时返回空串 —— 调用方据此**什么都不做**，而不是硬编一个组名去碰运气
 * （碰运气的后果是一条 `E_MOTION_GROUP_NOT_FOUND` 每 20 秒刷一次日志）。
 */
export function pickIdleGroup(groups: unknown): string {
  if (!Array.isArray(groups)) {
    return '';
  }
  const names = groups.filter((name) => typeof name === 'string' && name !== '');
  const idle = names.find((name) => name.toLowerCase().includes('idle'));
  if (typeof idle === 'string') {
    return idle;
  }
  return names.length > 0 ? names[0] : '';
}
