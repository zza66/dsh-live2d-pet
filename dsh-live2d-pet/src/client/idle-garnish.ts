/**
 * 待机时的小动作（idle garnish）：让「没事干的时候」不只是循环那几段自带动作。
 *
 * ## 为什么需要它
 *
 * 桌宠安静下来时，画面里只有两件事：模型自带的 `Idle` 动作（每 20 秒换一段）和
 * 呼吸。用久了就很像一个循环播放的 GIF —— 用户的原话是「待机动作也可以丰富一点，
 * 不只用模型自带的动作：比如忽然向左右看，低头或抬头，侧身，抬眉」。
 *
 * 这些**不需要美术资源**：Live2D 的参数本来就是连续的，头往哪边转、眉毛抬多高，
 * 都是写参数。所以这一层是一组「小表演」：每次挑一个，按包络淡入 → 保持 → 淡出，
 * 叠在动作/表情/呼吸算完的结果上。
 *
 * ## 为什么是加法，为什么落在这个位置
 *
 * 和情绪层（`emotion-layer.ts`）完全同一个理由：`addParameterValue()` 是**加**，
 * 加在谁身上决定了「和谁共存」。放在 `_scheduler.onLateUpdate()` 之后 ⇒ 加在
 * 眨眼、表情、视线、呼吸、物理、姿态的结果之上，这些层照常生效，只是多一层小动作。
 * 用 `setParameterValue()` 会把它们全部盖掉，那就不是「丰富待机」，是「接管画面」。
 *
 * ## 与 `look_at` 的关系
 *
 * 视线是**独立子系统**（`TimedLookTarget` + `CubismLook`，有自己的一条时间线）。
 * 这里的小动作不碰它，只往 `ParamAngleX/Y`、`ParamEyeBallX/Y` 上**加**一点偏移。
 * 代价是「用户点名看向右边」和「忽然瞥一眼」会叠在一起 —— 所以带 `gaze` 的手势
 * 在视线已经偏出去、或者正在转的途中会被跳过（`_lookAllowsGaze()`），
 * 让 `look_at` 始终是这个方向的最终解释者。
 *
 * ## 为什么算术放在这里
 *
 * `PetModel` 要 WebGL 才能实例化，门禁在 Node 里构造不出来。包络、手势表、挑选
 * 规则全放在这个文件里，`tools/test-idle-garnish.mjs` 能逐帧钉住 —— 否则
 * 「小动作到底播了没有、幅度对不对」在画面上只是一句「好像动了」。
 */

/** 一次小动作。`params` 是**增量**（叠加在动作结果之上），不是绝对值。 */
export interface GarnishGesture {
  readonly id: string;
  readonly params: Readonly<Record<string, number>>;
  /** 淡入（毫秒）。 */
  readonly attackMs: number;
  /** 保持满幅（毫秒）。 */
  readonly holdMs: number;
  /** 淡出（毫秒）。 */
  readonly releaseMs: number;
  /**
   * 这个手势会不会动到「看哪里」。
   *
   * 会动到的，在 `look_at` 生效期间要跳过 —— 不然用户点名「向右看」，
   * 她每 10 秒自己瞥回中间一次，看起来像没听懂。
   */
  readonly gaze: boolean;
  /**
   * 跟在后面的部位（**晚 `delayMs` 毫秒**才动，也晚同样多才收回去）。
   *
   * 真人没有哪个部位是同时动的：眼睛先扫过去、头再跟上；头先歪、肩膀再把重心
   * 让过去。同时动听起来没问题，看起来像「整个人被一根轴带着转」，一眼假。
   * 所以节奏交给这里，而不是靠给每个参数单独画曲线 —— 一层包络 + 一个延迟，
   * 够骗过眼睛了。
   */
  readonly trailing?: {
    readonly delayMs: number;
    readonly params: Readonly<Record<string, number>>;
  };
}

/**
 * 手势表。
 *
 * 幅度是按 hiyori 的参数范围手调的（`ParamAngleX/Y/Z` 约 ±30，`ParamEyeBallX/Y`
 * 约 ±1）：转头 12 度看得出「瞥了一眼」但不夸张，眉毛 0.5 看得出抬了一下。
 * 模型没有的参数会被 `addParameterValue()` 静默跳过，所以这张表换到别的模型上
 * 也不会炸 —— 只是少了那几个部位的表现。
 *
 * 节奏上有一条共同规则：**没有两个部位是同时动的**。七个手势全部按各自的真实顺序拆成两拨：
 * 「瞥一眼」是眼球先过去、`ParamAngleX/Y` 晚 120 ms 跟上（头跟着眼睛走，这是真人看东西的顺序；
 * 反过来读起来像在找声音来源）；「歪头」是头先歪、肩膀晚 140 ms 把重心让过去；「侧身」是身子
 * 先转、头晚 150 ms 顺着带过去；「抬眉」甚至两条眉毛都错开 90 ms——一起抬是「惊讶」，
 * 错开才是「挑了一下眉」。同时动不会报错，只是看着像整个人被一根轴带着转，一眼假。
 */
export const GARNISH_GESTURES: readonly GarnishGesture[] = Object.freeze([
  Object.freeze({
    id: 'glance-left',
    params: Object.freeze({
      ParamEyeBallX: -0.5,
      ParamEyeBallY: 0.05,
    }),
    attackMs: 150,
    holdMs: 620,
    releaseMs: 520,
    gaze: true,
    trailing: Object.freeze({
      delayMs: 120,
      params: Object.freeze({
        ParamAngleX: -12,
        ParamAngleZ: -2,
      }),
    }),
  }),
  Object.freeze({
    id: 'glance-right',
    params: Object.freeze({
      ParamEyeBallX: 0.5,
      ParamEyeBallY: 0.05,
    }),
    attackMs: 150,
    holdMs: 620,
    releaseMs: 520,
    gaze: true,
    trailing: Object.freeze({
      delayMs: 120,
      params: Object.freeze({
        ParamAngleX: 12,
        ParamAngleZ: 2,
      }),
    }),
  }),
  Object.freeze({
    id: 'glance-up',
    params: Object.freeze({
      ParamEyeBallY: 0.45,
    }),
    attackMs: 170,
    holdMs: 500,
    releaseMs: 620,
    gaze: true,
    trailing: Object.freeze({
      delayMs: 120,
      params: Object.freeze({
        ParamAngleY: 10,
        ParamAngleX: 3,
      }),
    }),
  }),
  Object.freeze({
    id: 'glance-down',
    params: Object.freeze({
      ParamEyeBallY: -0.4,
    }),
    attackMs: 190,
    holdMs: 520,
    releaseMs: 600,
    gaze: true,
    trailing: Object.freeze({
      delayMs: 120,
      params: Object.freeze({
        ParamAngleY: -8,
        ParamAngleZ: -1.5,
      }),
    }),
  }),
  Object.freeze({
    id: 'brow-raise',
    /**
     * 两条眉毛**不同时**抬。
     *
     * 一起抬是「惊讶」（两条对称、幅度一样），错开 90 ms 才读成「挑了一下眉」——
     * 而且右边比左边低一点点（0.42 对 0.5），不对称是故意的：真人几乎不会两边
     * 完全一样，完全一样反而像贴图。
     */
    params: Object.freeze({
      ParamBrowLY: 0.5,
      ParamBrowLForm: -0.12,
    }),
    attackMs: 150,
    holdMs: 260,
    releaseMs: 340,
    gaze: false,
    trailing: Object.freeze({
      delayMs: 90,
      params: Object.freeze({
        ParamBrowRY: 0.42,
        ParamBrowRForm: -0.1,
      }),
    }),
  }),
  Object.freeze({
    id: 'head-tilt',
    /**
     * 歪头的幅度调大过一次：初版是 `ParamAngleZ: 8`，用户看演示后说
     * 「不太清晰啊，要不要把歪头的角度加大一点」。8 度在 hiyori 这种头身比下
     * 只够看出「动了」，不够看出「歪着头在想事」，所以翻到 15 度并把保持段从
     * 900 ms 拉到 1000 ms —— 歪着的时间够长才像在打量，而不是一阵抖动。
     *
     * 上限由门禁钉住（`ParamAngleZ` ≤ 18）：再大就不是「歪头」，是颈椎病。
     */
    params: Object.freeze({
      ParamAngleZ: 15,
      ParamAngleX: 5,
      ParamEyeBallX: 0.2,
    }),
    attackMs: 300,
    holdMs: 1000,
    releaseMs: 700,
    gaze: true,
    /**
     * 头先歪，肩膀再把重心让过去 —— 晚 140 ms。
     *
     * 只加头角度的话，15 度和 8 度看起来差别没有想象中大；加上这一层「重心跟过去」，
     * 幅度不用再加，画面就已经是「她歪着头在打量你」而不是「她的头歪了」。
     * 身体幅度刻意小（侧倾 4 度、侧转 2 度）：跟着动是让动作落地，抢戏就成了扭秧歌。
     */
    trailing: Object.freeze({
      delayMs: 140,
      params: Object.freeze({
        ParamBodyAngleZ: 4,
        ParamBodyAngleX: 2,
      }),
    }),
  }),
  Object.freeze({
    id: 'body-turn',
    /**
     * 身子先转，头晚 150 ms 跟过去。
     *
     * 反过来（头先转、身子后跟）也行，但那是「回头看一眼」；这里要的是「换个坐姿」，
     * 所以重心先动、头顺着带过去。头只跟 3 度——跟着动是让动作有重量，不是让她扭头。
     */
    params: Object.freeze({
      ParamBodyAngleX: 10,
      ParamBodyAngleZ: 4,
    }),
    attackMs: 520,
    holdMs: 1300,
    releaseMs: 900,
    gaze: false,
    trailing: Object.freeze({
      delayMs: 150,
      params: Object.freeze({
        ParamAngleZ: 3,
      }),
    }),
  }),
]);

/** 两次小动作之间至少隔多久。太密就成了抽搐，太疏（>20 秒）用户会以为它坏了。 */
export const GARNISH_MIN_DELAY_MS = 6500;

/** 最长的间隔。 */
export const GARNISH_MAX_DELAY_MS = 15000;

/**
 * 中途被打断（比如 AI 点名了一个正经动作）之后，隔多久再试。
 *
 * 比最短间隔短：打断不是错误，只是「现在不方便」，没必要再等六七秒。
 */
export const GARNISH_ABORT_DELAY_MS = 3000;

/**
 * 一帧最多认多少毫秒。
 *
 * 标签页切回来时 `delta` 可能是几秒，不截的话包络一步跳到尾巴，看起来像抽搐一下。
 * 和 `motion-calm.ts` 的 `CALM_MAX_STEP_MS` 同一个理由、同一个数量级。
 */
export const GARNISH_MAX_STEP_MS = 200;

/** 视线偏出去多远，就不再自己加「看这边」的小动作。 */
export const GARNISH_GAZE_ALLOWED_OFFSET = 0.4;

/** 一次小动作的完整状态。就地改，不产生新对象（每帧都要用）。 */
export interface GarnishState {
  gesture: GarnishGesture | null;
  elapsedMs: number;
}

export function createGarnishState(): GarnishState {
  return { gesture: null, elapsedMs: 0 };
}

/** 这一帧算出来的结果。 */
export interface GarnishFrame {
  state: GarnishState;
  /** 参数名 → 这一帧要加多少。空对象表示「这一帧什么都不加」。 */
  values: Record<string, number>;
  /** 这段小动作播完了没有。 */
  done: boolean;
}

function finite(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampUnit(value: number): number {
  const v = finite(value, 0);
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/** 两端导数为 0 的缓动，`t ∈ [0, 1]`。起步和收尾都不硬拐。 */
export function smoothstep(t: number): number {
  const v = clampUnit(t);
  return v * v * (3 - 2 * v);
}

/** 一次小动作总共要多久（毫秒）：主部位的三段。 */
export function garnishDurationMs(gesture: GarnishGesture): number {
  return (
    Math.max(0, finite(gesture.attackMs, 0)) +
    Math.max(0, finite(gesture.holdMs, 0)) +
    Math.max(0, finite(gesture.releaseMs, 0))
  );
}

/** 跟随部位的延迟（毫秒）。没有 `trailing` 就是 0。 */
export function garnishTrailDelayMs(gesture: GarnishGesture): number {
  return gesture.trailing === undefined ? 0 : Math.max(0, finite(gesture.trailing.delayMs, 0));
}

/**
 * 整个小动作播完要多久（毫秒）= 主部位时长 + 跟随延迟。
 *
 * 跟随部位的淡出起点被推迟了 `delayMs`，所以它的尾巴会比主部位晚结束；
 * 「播完」必须按这个算，否则收尾那一小段会被提前掐掉，肩膀会硬生生弹回去。
 */
export function garnishTotalMs(gesture: GarnishGesture): number {
  return garnishDurationMs(gesture) + garnishTrailDelayMs(gesture);
}

/**
 * 第 `elapsedMs` 毫秒时的幅度系数，`[0, 1]`。
 *
 * 三段：淡入（smoothstep 到 1）→ 保持 1 → 淡出（smoothstep 回 0）。
 * 用缓动而不是线性，是因为线性在起止处有可见的「折断」；而这里不像 `motion-calm`
 * 那样需要按帧对账绝对时长，`durationMs` 仍然精确（缓动不改变总时长）。
 */
export function envelopeAt(
  gesture: { readonly attackMs: number; readonly holdMs: number; readonly releaseMs: number },
  elapsedMs: number,
): number {
  const t = Math.max(0, finite(elapsedMs, 0));
  const attack = Math.max(0, finite(gesture.attackMs, 0));
  const hold = Math.max(0, finite(gesture.holdMs, 0));
  const release = Math.max(0, finite(gesture.releaseMs, 0));

  if (t <= 0) return 0;
  if (attack > 0 && t < attack) {
    return smoothstep(t / attack);
  }
  if (t <= attack + hold) {
    return 1;
  }
  const into = t - attack - hold;
  if (release <= 0 || into >= release) {
    return 0;
  }
  return smoothstep(1 - into / release);
}

/**
 * 推进一帧，返回这一帧要叠加的参数与「播完没有」。
 *
 * `factor` 是外层给的全局折扣（思考时「收着点」用它，`calmFactorFor(_calm)`
 * 把这里的小动作一起收掉）；`1` 表示原样。
 */
export function garnishValues(state: GarnishState, deltaMs: number, factor: number): GarnishFrame {
  const gesture = state.gesture;
  if (gesture === null) {
    return { state, values: {}, done: true };
  }
  const step = Math.min(Math.max(0, finite(deltaMs, 0)), GARNISH_MAX_STEP_MS);
  state.elapsedMs += step;

  const duration = garnishDurationMs(gesture);
  const trailDelay = garnishTrailDelayMs(gesture);
  const scale = clampUnit(factor) * envelopeAt(gesture, state.elapsedMs);
  const values: Record<string, number> = {};
  if (scale > 0) {
    for (const id of Object.keys(gesture.params)) {
      const amount = gesture.params[id] * scale;
      if (amount !== 0) {
        values[id] = amount;
      }
    }
  }
  if (gesture.trailing !== undefined && trailDelay >= 0) {
    const trailScale = clampUnit(factor) * envelopeAt(gesture, state.elapsedMs - trailDelay);
    if (trailScale > 0) {
      for (const id of Object.keys(gesture.trailing.params)) {
        const amount = gesture.trailing.params[id] * trailScale;
        if (amount !== 0) {
          values[id] = (values[id] ?? 0) + amount;
        }
      }
    }
  }

  const done = duration <= 0 || state.elapsedMs >= duration + trailDelay;
  if (done) {
    state.gesture = null;
    state.elapsedMs = 0;
  }
  return { state, values, done };
}

/** 下一次小动作该等多久（毫秒）。`rng` 返回 `[0, 1)`。 */
export function nextDelayMs(rng: () => number): number {
  const raw = typeof rng === 'function' ? finite(rng(), 0.5) : 0.5;
  const unit = raw <= 0 ? 0 : raw >= 1 ? 0.999999 : raw;
  const span = GARNISH_MAX_DELAY_MS - GARNISH_MIN_DELAY_MS;
  return GARNISH_MIN_DELAY_MS + Math.floor(unit * (span + 1));
}

/** `pickGesture()` 的约束。 */
export interface GarnishPickOptions {
  /** 上一次播的那个，尽量不连着播。 */
  avoidId?: string | null;
  /** 现在能不能动视线（`look_at` 生效期间是 `false`）。 */
  allowGaze?: boolean;
}

/**
 * 挑一个手势。挑不到（全被过滤掉）就返回 `null`。
 *
 * 不用权重：七个手势轮流出现已经很够，加权只会让人记住「总是那一个」。
 */
export function pickGesture(rng: () => number, options?: GarnishPickOptions): GarnishGesture | null {
  const allowGaze = options === null || options === undefined ? true : options.allowGaze !== false;
  const avoidId = options === null || options === undefined ? null : (options.avoidId ?? null);

  let candidates = GARNISH_GESTURES.filter(gesture => allowGaze || !gesture.gaze);
  if (avoidId !== null && candidates.length > 1) {
    candidates = candidates.filter(gesture => gesture.id !== avoidId);
  }
  if (candidates.length === 0) {
    return null;
  }
  const raw = typeof rng === 'function' ? finite(rng(), 0) : 0;
  const unit = raw <= 0 ? 0 : raw >= 1 ? 0.999999 : raw;
  const index = Math.floor(unit * candidates.length);
  return candidates[index < 0 ? 0 : index >= candidates.length ? candidates.length - 1 : index];
}

/**
 * 可复现的伪随机数（mulberry32）。
 *
 * 生产环境用 `Math.random`；这个存在是为了门禁能断言「挑得出来、会换、不会越界」——
 * 否则「随机」什么都证明不了。
 */
export function createRandom(seed: number): () => number {
  let a = Math.floor(finite(seed, 1)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
