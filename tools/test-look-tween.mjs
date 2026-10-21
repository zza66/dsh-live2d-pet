#!/usr/bin/env node
/**
 * 门禁：**视线时间线**（`lib/test/look-tween.mjs` ＝ `src/client/look-tween.ts`）。
 *
 * ## 为什么需要这个文件
 *
 * 它守的是同一类缺陷的第四个实例：§4.1 的 `live2d_look_at` 契约写着第三个参数
 * `durationMs`（默认 400，上限 5000），`lib/index.js` 的工具描述把它告诉了 LLM，
 * `lib/host/actions.js` 夹取好写进 `command.payload.look.durationMs`，
 * `test-actions.mjs` 还有两条断言钉着它 —— **然后渲染端从头到尾没读过它。**
 *
 * 前三个同类缺陷（方案 §4.2.4 / §4.2.5 / §4.2.6）只要「把值接上」就行，这一个
 * **接不上**：框架给的 `CubismTargetPoint` 里转头速度是写死的
 * （`faceParamMaxV = 40/10`，约 4 单位/秒 + 0.15 秒加速），`set(x, y)` 只设目标点，
 * **没有任何时长旋钮**。所以「慢慢转过去」原来根本表达不出来。
 *
 * 真正的适配层是 `pet-model.ts` 里的 `TimedLookTarget`（必须继承
 * `CubismTargetPoint`，实例化要 WebGL，没法在这里构造）。算术全在 `look-tween.ts`，
 * 于是这个文件能在没有画布的 Node 里把时间线逐条钉住。
 *
 * ## 用法
 *
 *     node tools/test-look-tween.mjs     （离线：无网络、无 DOM、无文件系统）
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, '..', 'dsh-live2d-pet', 'lib/test/look-tween.mjs');

let failed = 0;
let passed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

if (!existsSync(modulePath)) {
  console.error(`视线时间线的测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const actionsMod = await import(
  new URL(
    `file://${resolve(here, '..', 'dsh-live2d-pet', 'lib/host/actions.js').replace(/\\/g, '/')}`,
  ).href
);
const { createLookTween, easeInOut, glideTo, jumpTo, isSettled, stepLookTween } = mod;
const { DEFAULT_LOOK_DURATION_MS, MAX_LOOK_DURATION_MS } = actionsMod;

const close = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;

/**
 * 按 60fps 的节拍把时间线走完，返回走过的帧数与最后的落点。
 *
 * 用固定 1/60 秒而不是「一次走完」：真实调用是每帧一步（框架的
 * `CubismLookUpdater.onLateUpdate` 把 `deltaTimeSeconds` 递进来），一次走完
 * 只能证明算术对，证明不了「一帧一帧走也对」。
 */
function runFrames(state, totalMs, frameMs = 1000 / 60) {
  let elapsed = 0;
  let frames = 0;
  while (elapsed < totalMs) {
    const dt = Math.min(frameMs, totalMs - elapsed);
    stepLookTween(state, dt);
    elapsed += dt;
    frames += 1;
  }
  return { frames, pose: { x: state.x, y: state.y } };
}

console.log('[1] 导出契约');
check('createLookTween 是函数', typeof createLookTween === 'function');
check('easeInOut 是函数', typeof easeInOut === 'function');
check('glideTo 是函数', typeof glideTo === 'function');
check('jumpTo 是函数', typeof jumpTo === 'function');
check('stepLookTween 是函数', typeof stepLookTween === 'function');
check('isSettled 是函数', typeof isSettled === 'function');
{
  const s = createLookTween();
  check('初始位置是原点', s.x === 0 && s.y === 0);
  check('初始时长是 0（＝不缓动）', s.durationMs === 0);
  check('初始没有起点偏移', s.fromX === 0 && s.fromY === 0 && s.toX === 0 && s.toY === 0);
  check('初始已落定', isSettled(s) === true);
  check('默认时长就是契约里那个 400', DEFAULT_LOOK_DURATION_MS === 400, `实测 ${DEFAULT_LOOK_DURATION_MS}`);
  check('上限就是契约里那个 5000', MAX_LOOK_DURATION_MS === 5000, `实测 ${MAX_LOOK_DURATION_MS}`);
}

console.log('');
console.log('[2] ★ 时长真的准 —— 这一个文件存在的全部理由');
{
  const s = createLookTween();
  glideTo(s, 1, 0, 400);
  check('刚出发时位置没动', close(s.x, 0) && close(s.y, 0));
  check('刚出发时不落定', isSettled(s) === false);

  // 走一半：400ms 走到 200ms 时，smoothstep 在 t=0.5 处正好是 0.5。
  const s2 = createLookTween();
  glideTo(s2, 1, 0, 400);
  runFrames(s2, 200);
  check('走一半时正好在中点', close(s2.x, 0.5, 0.02), `x=${s2.x.toFixed(4)}`);
  check('走一半时还没落定', isSettled(s2) === false);

  const s3 = createLookTween();
  glideTo(s3, 1, 0, 400);
  const done = runFrames(s3, 400);
  check('400ms 走完落在目标上', close(s3.x, 1, 1e-9), `x=${s3.x}`);
  check('落定', isSettled(s3) === true);
  check('用掉了约 24 帧', done.frames === 24, `实测 ${done.frames} 帧`);

  // 再走 10 秒也不许漂。
  runFrames(s3, 10000);
  check('走完之后再走一万毫秒也不漂', close(s3.x, 1, 1e-9), `x=${s3.x}`);

  // 慢的一趟：5000ms。
  const s4 = createLookTween();
  glideTo(s4, 0, -1, 5000);
  runFrames(s4, 2500);
  check('5000ms 的一趟走一半也在中点', close(s4.y, -0.5, 0.02), `y=${s4.y.toFixed(4)}`);
  runFrames(s4, 2500);
  check('5000ms 走完落在目标上', close(s4.y, -1, 1e-9), `y=${s4.y}`);
}

console.log('');
console.log('[3] 时长不同，过程真的不同（否则「慢慢转」永远表达不出来）');
{
  const fast = createLookTween();
  const slow = createLookTween();
  glideTo(fast, 1, 0, 200);
  glideTo(slow, 1, 0, 4000);
  runFrames(fast, 200);
  runFrames(slow, 200);
  check('200ms 的那趟已经到位', close(fast.x, 1, 1e-9), `x=${fast.x}`);
  check('4000ms 的那趟才刚起步', slow.x < 0.05, `x=${slow.x.toFixed(5)}`);
  check('同一时刻两者位置不同', Math.abs(fast.x - slow.x) > 0.9);
}

console.log('');
console.log('[4] 缓动：两端慢、中间快');
{
  check('easeInOut(0) = 0', easeInOut(0) === 0);
  check('easeInOut(1) = 1', easeInOut(1) === 1);
  check('easeInOut(0.5) = 0.5（对称）', close(easeInOut(0.5), 0.5));
  check('起点速度接近 0', easeInOut(0.01) < 0.01, `${easeInOut(0.01)}`);
  check('终点速度接近 0', 1 - easeInOut(0.99) < 0.01, `${1 - easeInOut(0.99)}`);
  check('中间比线性快', easeInOut(0.25) < 0.25 && easeInOut(0.75) > 0.75);
  check('单调不减', easeInOut(0.2) < easeInOut(0.4) && easeInOut(0.4) < easeInOut(0.6));
  check('超过 1 夹到 1', easeInOut(1.5) === 1);
  check('负数夹到 0', easeInOut(-0.5) === 0);
  check('NaN 当 0', easeInOut(NaN) === 0);
  check('Infinity 当 1', easeInOut(Infinity) === 1);
}

console.log('');
console.log('[5] durationMs 省略 / 为 0 / 为负');
{
  const s = createLookTween();
  glideTo(s, 1, 0);
  check('省略时用 400', s.durationMs === DEFAULT_LOOK_DURATION_MS, `${s.durationMs}`);
  runFrames(s, 400);
  check('省略时也真的走完 400ms', close(s.x, 1, 1e-9));

  const z = createLookTween();
  glideTo(z, 1, 0, 0);
  check('durationMs=0 立刻到位', z.x === 1 && z.y === 0);
  check('durationMs=0 立刻落定', isSettled(z) === true);
  check('durationMs=0 时没有中间态', z.fromX === 0 && z.toX === 1);

  const n = createLookTween();
  glideTo(n, 0, 1, -500);
  check('负数时长也立刻到位', n.y === 1);
}

console.log('');
console.log('[6] ★ 中途改目标不许跳');
{
  const s = createLookTween();
  glideTo(s, 1, 0, 1000);
  runFrames(s, 500);
  const before = s.x;
  glideTo(s, -1, 0, 1000);
  check('改目标的那一瞬间位置没跳', close(s.x, before, 1e-9), `${before.toFixed(4)} → ${s.x.toFixed(4)}`);
  check('新起点就是当前位置', close(s.fromX, before, 1e-9));
  check('新目标是新给的那个', s.toX === -1);
  check('计时重新开始', s.elapsedMs === 0 && s.durationMs === 1000);

  runFrames(s, 1000);
  check('折返后落在新目标上', close(s.x, -1, 1e-9), `x=${s.x}`);
}

console.log('');
console.log('[7] 夹取与脏值（绝不抛异常，§9.2）');
{
  const s = createLookTween();
  glideTo(s, 5, -5, 100);
  runFrames(s, 100);
  check('x 超范围夹到 1', s.x === 1);
  check('y 超范围夹到 -1', s.y === -1);

  const d = createLookTween();
  glideTo(d, NaN, Infinity, NaN);
  runFrames(d, 400);
  check('NaN / Infinity 当 0', d.x === 0 && d.y === 0);
  check('NaN 时长当 0 → 立刻到位', d.durationMs === 0);

  const big = createLookTween();
  glideTo(big, 1, 0, 999999);
  check('时长超上限夹到 5000', big.durationMs === MAX_LOOK_DURATION_MS, `${big.durationMs}`);

  let threw = null;
  try {
    const junk = createLookTween();
    glideTo(junk, 'left', {}, undefined);
    glideTo(junk, null, [], 'fast');
    stepLookTween(junk, NaN);
    stepLookTween(junk, -100);
    stepLookTween(junk, Infinity);
    stepLookTween(junk, 'soon');
    jumpTo(junk, undefined, null);
    isSettled(junk);
  } catch (error) {
    threw = error;
  }
  check('一串脏值一个异常都不抛', threw === null, threw === null ? '' : String(threw));

  const neg = createLookTween();
  glideTo(neg, 1, 1, 1000);
  runFrames(neg, 500);
  const at = neg.x;
  stepLookTween(neg, -500);
  check('deltaMs 为负不会倒着走', close(neg.x, at, 1e-9), `${at.toFixed(4)} → ${neg.x.toFixed(4)}`);
}

console.log('');
console.log('[8] jumpTo：立刻到位');
{
  const s = createLookTween();
  jumpTo(s, 0.5, -0.5);
  check('jumpTo 立刻到位', s.x === 0.5 && s.y === -0.5);
  check('jumpTo 之后是落定的', isSettled(s) === true);
  jumpTo(s, 9, 9);
  check('jumpTo 也夹取', s.x === 1 && s.y === 1);
}

console.log('');
console.log('[9] 边框：时长刚好到点、落点精确');
{
  const s = createLookTween();
  glideTo(s, 1, 0, 1000);
  stepLookTween(s, 1000);
  check('一次走满时长正好落定', isSettled(s) === true);
  check('一次走满时落点精确等于目标', s.x === 1, `x=${s.x}`);
  check('不会超过目标（不过冲）', s.x <= 1);

  const t = createLookTween();
  glideTo(t, 1, 0, 1000);
  stepLookTween(t, 999.9);
  check('差 0.1ms 时还没落定', isSettled(t) === false);
  check('差 0.1ms 时已经很接近', t.x > 0.99, `x=${t.x.toFixed(6)}`);
  stepLookTween(t, 0.1);
  check('补上那 0.1ms 就落定', isSettled(t) === true && t.x === 1);
}

console.log('');
console.log('[10] 反向验证：真的跑一遍退化实现，确认这个门禁抓得住');
{
  /**
   * 退化 1：**忽略时长，永远按固定速度转**。
   *
   * 这就是框架原本的行为（`faceParamMaxV = 40/10`，约 4 单位/秒）—— 也正是这个
   * 缺陷的来源。如果门禁用「转过去了没有」当判据，它会全绿。
   */
  const naiveFixedSpeed = (state, x, y) => {
    state.toX = x;
    state.toY = y;
    state.durationMs = 250; // 固定 250ms 走完，不管调用方要多久
    state.elapsedMs = 0;
    state.fromX = state.x;
    state.fromY = state.y;
  };
  const a = createLookTween();
  const b = createLookTween();
  naiveFixedSpeed(a, 1, 0);
  glideTo(b, 1, 0, 4000);
  runFrames(a, 300);
  runFrames(b, 300);
  const real = createLookTween();
  glideTo(real, 1, 0, 4000);
  runFrames(real, 300);
  check(
    '退化 1（忽略时长）：300ms 后已经到位，真实现还在半路',
    close(a.x, 1, 1e-9) && real.x < 0.25,
    `退化 ${a.x.toFixed(3)} / 真实现 ${real.x.toFixed(3)}`,
  );

  /** 退化 2：**中途改目标时从原点重新出发**（跳一下）。 */
  const naiveSnap = (state, x, y, ms) => {
    state.fromX = 0;
    state.fromY = 0;
    state.toX = x;
    state.toY = y;
    state.durationMs = ms;
    state.elapsedMs = 0;
  };
  const c = createLookTween();
  glideTo(c, 1, 0, 1000);
  runFrames(c, 500);
  const beforeC = c.x;
  naiveSnap(c, -1, 0, 1000);
  stepLookTween(c, 16);
  const d = createLookTween();
  glideTo(d, 1, 0, 1000);
  runFrames(d, 500);
  glideTo(d, -1, 0, 1000);
  stepLookTween(d, 16);
  check(
    '退化 2（改目标回原点）：位置从半路跳回 0，真实现不跳',
    Math.abs(c.x) < 0.05 && close(d.x, beforeC, 0.01),
    `退化 ${c.x.toFixed(3)} / 真实现 ${d.x.toFixed(3)}`,
  );

  /** 退化 3：**durationMs=0 也走一帧缓动**（「立刻」变成「一帧后」）。 */
  const naiveAlwaysGlide = (state, x, y, ms) => {
    state.fromX = state.x;
    state.fromY = state.y;
    state.toX = x;
    state.toY = y;
    state.durationMs = ms === undefined ? 400 : ms;
    state.elapsedMs = 0;
  };
  const e = createLookTween();
  naiveAlwaysGlide(e, 1, 0, 0);
  check('退化 3（0 也缓动）：0ms 时没到位', e.x !== 1, `x=${e.x}`);
  const f = createLookTween();
  glideTo(f, 1, 0, 0);
  check('真实现 0ms 时已到位', f.x === 1);

  /** 退化 4：**不做脏值归一**（NaN 传进去，位置变成 NaN，模型整只消失）。 */
  const naiveRaw = (state, x, y) => {
    state.x = x;
    state.y = y;
    state.toX = x;
    state.toY = y;
    state.durationMs = 0;
  };
  const g = createLookTween();
  naiveRaw(g, NaN, undefined);
  check('退化 4（不归一）：位置成了 NaN', Number.isNaN(g.x) && g.y === undefined);
  const h = createLookTween();
  glideTo(h, NaN, undefined, 0);
  check('真实现归一成 0', h.x === 0 && h.y === 0);
}

console.log('');
if (failed > 0) {
  console.log(`[11] LOOK TWEEN GATE FAILED —— ${failed} 项失败，${passed} 项通过`);
  process.exit(1);
}
console.log(`[11] LOOK TWEEN GATE PASSED —— ${passed} 项断言全绿`);
