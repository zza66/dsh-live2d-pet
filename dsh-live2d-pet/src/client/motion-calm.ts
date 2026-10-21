/**
 * 思考时「收着点」：把**动作**这一路的幅度往模型的默认姿态收。
 *
 * ## 为什么需要它
 *
 * 思考态（`lib/host/mood.js` 的 `MOOD_THINKING`）推的是**情绪层** —— 一层参数
 * 增量，管脸不管动作。于是她一边「低头沉思」一边照旧每 20 秒换一段待机动作、
 * 照旧全幅度甩胳膊（`plugin.ts` 的 `shouldAutoIdle()` 不知道思考这回事）。
 * 用户的原话是「希望她在思考的时候不要动的那么剧烈」，要改的正是动作这一路。
 *
 * ## 为什么收「幅度」而不是「停掉」
 *
 * 停掉待机 = 长时间思考时她整个人僵住，和掉线没有区别（`mood.js` 文件头那条
 * 「静止的和掉线的没法区分」的教训）。收幅度则是**她还在动，只是安静**：
 * 每 20 秒照样换姿势，只是每个姿势都只做到三分之一。
 *
 * ## 为什么算术放在这里
 *
 * `PetModel` 要 WebGL 才能实例化，门禁在 Node 里构造不出来。视线时间线
 * （`look-tween.ts`）、帧预算（`frame-budget.ts`）都是同一个理由拆出来的：
 * 纯算术单独一个文件，`tools/test-motion-calm.mjs` 能逐帧钉住。
 */

/**
 * 思考到最深时，动作还保留多少幅度（`1` = 原样，`0` = 完全按默认姿态）。
 *
 * 0.35 是「看得出来还在动、但幅度明显小了一档」。再低（0.2 以下）在 hiyori 上
 * 看起来就接近静止，反而不如不动；再高（0.5 以上）用户会觉得没变化。
 */
export const IDLE_CALM_FACTOR = 0.35;

/** 从「正常」滑到「收着」要多久。比情绪层的 `EMOTION_ATTACK_MS`(180) 慢，动作本来就慢。 */
export const CALM_ATTACK_MS = 480;

/** 放开时更慢一点：思考一结束就猛地甩起来会吓人。 */
export const CALM_RELEASE_MS = 1100;

/** 小于这个值就当 0，省得每帧都去做一轮没人看得见的乘法。 */
export const CALM_EPSILON = 0.002;

/**
 * 一帧最多认多少毫秒。
 *
 * 标签页切回来时 `delta` 可能是几秒（`MAX_DELTA_SECONDS` 才截它），不在这里再截
 * 一次的话包络会一步跳到位 —— 而「淡入」的全部意义就是不跳。
 */
export const CALM_MAX_STEP_MS = 200;

/**
 * 思考态用的情绪层名字。
 *
 * 与 `lib/host/mood.js` 的 `THINKING_EMOTION_NAME` 是同一个字符串，但客户端
 * **不能 import 那个文件**（它是 Host 半区的运行时代码，客户端 bundle 不该把整个
 * 状态机拖进来）。这里留一份字面量，`tools/test-motion-calm.mjs` 有一条断言
 * 直接读 `lib/host/mood.js` 对账 —— 两边改名而这里没跟上，门禁会红。
 */
export const THINKING_LAYER_NAME = '思考';

function finite(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 夹进 `[0, 1]`。`NaN` 当 0 —— 它只可能来自「还没初始化」，不是「过半」。 */
export function clamp01(value: number): number {
  const v = finite(value, 0);
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/**
 * 把包络从 `current` 往 `target` 推 `dtMs` 毫秒，返回新值。
 *
 * 线性而不是指数：线性在这一段够用，而且**可数**（480 ms 就是 480 ms），
 * 门禁可以按帧对账而不用 tolerances 去猜时间常数。
 */
export function advanceCalm(current: number, target: number, dtMs: number): number {
  const from = clamp01(current);
  const to = clamp01(target);
  if (from === to) return from;
  const dt = Math.max(0, Math.min(finite(dtMs, 0), CALM_MAX_STEP_MS));
  if (dt === 0) return from;
  const span = to > from ? CALM_ATTACK_MS : CALM_RELEASE_MS;
  const step = dt / span;
  const next = to > from ? Math.min(to, from + step) : Math.max(to, from - step);
  return clamp01(next);
}

/**
 * 包络值 → 保留系数（`calm=0` → `1`，`calm=1` → `IDLE_CALM_FACTOR`）。
 *
 * 单独一个函数是为了让「0 的时候必须恰好是 1」成为一条可测的事实：差 0.001
 * 也会让不思考时的动作比改动前小一点点，而这种漂移没人查得出来。
 */
export function calmFactorFor(calm: number): number {
  return 1 - clamp01(calm) * (1 - IDLE_CALM_FACTOR);
}

/**
 * 把一个参数值按 `factor` 向它的默认值收：`default + (value - default) * factor`。
 *
 * 为什么是「向默认值收」而不是「向 0 收」：Live2D 的参数默认值不是 0
 * （`ParamAngleX` 默认 0 但 `ParamArmLA` 默认可能是 1），向 0 收会把手臂收到
 * 一个模型作者从没设计过的姿态上。
 */
export function dampTowardDefault(value: number, defaultValue: number, factor: number): number {
  const base = finite(defaultValue, 0);
  const v = finite(value, base);
  return base + (v - base) * clamp01(factor);
}

/**
 * 这一帧该不该做「收幅度」。
 *
 * 三个条件缺一不可：
 * - `calm > CALM_EPSILON`：包络没起来时一个参数都不碰（改动前后逐像素一致）；
 * - `motionUpdated`：这一帧没有动作在写参数，收了也没意义，而且会把上一条动作
 *   留在参数上的值越收越小（她会在动作播完后继续「缩」下去）；
 * - `motionPriority <= idlePriority`：**只收待机动作**。AI 点名的动作（`NORMAL` /
 *   `FORCE`）是用户明确要看的，思考不该把它打折。
 */
export function shouldDampMotion(input: {
  calm: number;
  motionUpdated: boolean;
  motionPriority: number;
  idlePriority: number;
}): boolean {
  if (!(clamp01(input?.calm) > CALM_EPSILON)) return false;
  if (input?.motionUpdated !== true) return false;
  const priority = finite(input?.motionPriority, 0);
  const idle = finite(input?.idlePriority, 1);
  return priority <= idle;
}

/** 思考中的目标值：`true` → 1，`false` → 0。留个函数是为了调用处读起来像一句话。 */
export function calmTargetFor(thinking: boolean): number {
  return thinking === true ? 1 : 0;
}
