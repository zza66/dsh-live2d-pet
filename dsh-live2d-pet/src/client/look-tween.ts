/**
 * 视线「转过去」这条时间线。
 *
 * ## 为什么需要它
 *
 * §4.1 的 `live2d_look_at` 契约里写着第三个参数 `durationMs`（默认 400，上限 5000），
 * `lib/index.js` 的工具描述也原样告诉了 LLM，`lib/host/actions.js` 还把它夹取好
 * 写进 `command.payload.look.durationMs` —— `test-actions.mjs` 有三条断言钉着
 * 这件事。**然后渲染端从头到尾没读过它。**
 *
 * 这是同一类缺陷的第四个实例（前三个见方案 §4.2.4 / §4.2.5 / §4.2.6），但它比
 * 前三个更麻烦一层：前三个只要「把值接上」就行，这一个**接不上** —— 框架给的
 * `CubismTargetPoint` 里，转头速度是写死的（`faceParamMaxV = 40.0 / 10.0`，
 * 约 4 单位/秒，另有 0.15 秒加速），`set(x, y)` 只设目标点，**没有任何时长旋钮**。
 *
 * 所以「慢慢转过去」在原来的实现里做不到，只能按框架那一个速度转。这个文件就是
 * 把时长这条时间线自己拿回来。
 *
 * ## 为什么是纯函数
 *
 * 真正的适配层是 `pet-model.ts` 里的 `TimedLookTarget`（它必须继承
 * `CubismTargetPoint`，否则挂不进调度器），而那个类需要 WebGL 才能实例化。
 * 把数学放这里，`tools/test-look-tween.mjs` 就能在没有画布的 Node 里逐条断言 ——
 * 和 `speech-lane.ts` / `action-runner.ts` 是同一套做法。
 *
 * ## 边界
 *
 * **绝不抛异常**（§9.2：客户端求值期抛错 = 整壳白屏）。所有进来的脏值就地归一，
 * 时间戳倒退、`deltaMs` 是 `NaN`、坐标是 `Infinity` 都不许让这一帧崩掉。
 */

import { DEFAULT_LOOK_DURATION_MS, MAX_LOOK_DURATION_MS } from '../../lib/host/actions.js';

/** 当前视线位置，两个分量都在 `[-1, 1]`。 */
export interface LookPose {
  x: number;
  y: number;
}

/** 一次「转过去」的完整状态。就地修改，不产生新对象（每帧都要用）。 */
export interface LookTweenState {
  /** 起点。中途改目标时它会被设成**当时的当前位置**，所以不会跳。 */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** 已经走了多少毫秒。 */
  elapsedMs: number;
  /** 这一趟要走多少毫秒。`0` 表示「立刻到位」。 */
  durationMs: number;
  /** 当前值。 */
  x: number;
  y: number;
}

export function createLookTween(): LookTweenState {
  return {
    fromX: 0,
    fromY: 0,
    toX: 0,
    toY: 0,
    elapsedMs: 0,
    durationMs: 0,
    x: 0,
    y: 0,
  };
}

/** 非有限数一律当 0；再夹到 `[-1, 1]`。 */
function unit(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

/** 非有限数一律当 0；再夹到 `[0, max]`。 */
function duration(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value > MAX_LOOK_DURATION_MS ? MAX_LOOK_DURATION_MS : value;
}

/**
 * 缓动：smoothstep（`t²(3-2t)`）。
 *
 * 为什么不是线性：线性转头看起来像机械臂 —— 起步和停住都是硬拐角。smoothstep
 * 两端的导数为 0，首尾都软，而中间速度是平均值的 1.5 倍，所以**总时长仍然准**。
 * 为什么不用框架那套（0.15 秒加速到最高速）：那套的时长取决于距离，正是我们
 * 要摆脱的东西。
 */
export function easeInOut(t: number): number {
  // 注意判断顺序：`NaN` 先单独挡掉，剩下的按两端夹取 —— 所以 `+Infinity`
  // 落到 1（「早就过了终点」），`-Infinity` 落到 0。曾经写成
  // `!Number.isFinite(t) → 0`，那会把 `+Infinity` 变成 0，也就是
  // 「走得越远越靠近起点」，单调性直接反了。
  if (typeof t !== 'number' || Number.isNaN(t)) return 0;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * 转向 `(x, y)`，走 `durationMs` 毫秒。
 *
 * `durationMs` 省略时用 §4.1 的默认值 400。**中途再调一次不会跳**：新的起点是
 * 当前位置（`state.x` / `state.y`），所以「先看左边、半路改成看右边」是平滑的
 * 折返，而不是闪一下。
 */
export function glideTo(
  state: LookTweenState,
  x: number,
  y: number,
  durationMs?: number,
): void {
  const ms = durationMs === undefined ? DEFAULT_LOOK_DURATION_MS : duration(durationMs);
  const fromX = state.x;
  const fromY = state.y;
  const toX = unit(x);
  const toY = unit(y);

  state.fromX = fromX;
  state.fromY = fromY;
  state.toX = toX;
  state.toY = toY;
  state.durationMs = ms;
  state.elapsedMs = 0;

  /*
   * 时长为 0（或负、或脏）时**立刻到位**，不留一帧的中间态。
   * `duration: 0` 是契约允许的取值（`clampNumber(raw?.durationMs, 0, …)`），
   * 语义就是「别缓动，直接转过去」。
   */
  if (ms <= 0) {
    state.x = toX;
    state.y = toY;
  }
}

/** 立刻跳到某个位置，不走时间线。`setDrag()` 那条路用得上。 */
export function jumpTo(state: LookTweenState, x: number, y: number): void {
  state.fromX = state.x;
  state.fromY = state.y;
  state.toX = unit(x);
  state.toY = unit(y);
  state.durationMs = 0;
  state.elapsedMs = 0;
  state.x = state.toX;
  state.y = state.toY;
}

/**
 * 推进 `deltaMs` 毫秒，返回当前位置。
 *
 * 这是每帧调一次的那个函数。走完之后 `x` / `y` 就是目标值，再调也不会漂 ——
 * 落点是精确的 `toX` / `toY`，不是「插值到接近」。
 */
export function stepLookTween(state: LookTweenState, deltaMs: number): LookPose {
  if (state.durationMs <= 0) {
    state.x = state.toX;
    state.y = state.toY;
    return { x: state.x, y: state.y };
  }

  const dt = typeof deltaMs === 'number' && Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
  state.elapsedMs += dt;

  const t = state.elapsedMs >= state.durationMs ? 1 : state.elapsedMs / state.durationMs;
  if (t >= 1) {
    state.x = state.toX;
    state.y = state.toY;
    return { x: state.x, y: state.y };
  }

  const e = easeInOut(t);
  state.x = state.fromX + (state.toX - state.fromX) * e;
  state.y = state.fromY + (state.toY - state.fromY) * e;
  return { x: state.x, y: state.y };
}

/** 这一趟走完了没有。`durationMs` 为 0 时永远算走完。 */
export function isSettled(state: LookTweenState): boolean {
  return state.durationMs <= 0 || state.elapsedMs >= state.durationMs;
}
