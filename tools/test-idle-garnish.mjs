#!/usr/bin/env node
/**
 * 门禁：**待机小动作**（`lib/test/idle-garnish.mjs` ＝ `src/client/idle-garnish.ts`）。
 *
 * ## 为什么需要这个文件
 *
 * 用户的原话是「待机动作也可以丰富一点，不只用模型自带的动作：比如忽然向左右看，
 * 低头或抬头，侧身，抬眉」。这一层和「思考时收着点」是同一类改动：**没有可看的
 * 产物**，唯一的证据是「看起来活泼了一点」。于是下面五种错都能悄悄活下来：
 *
 *   1. 手势表里少了某个部位（「侧身」写了 `ParamBodyAngleY` 而模型没有）——
 *      画面上只是「好像没这个动作」，没人查得出来；
 *   2. 包络起不来或收不回去（attack 写成 0 或 release 写漏）—— 看起来像抽搐；
 *   3. 幅度离谱（转头 80 度、眉毛 3 倍）—— 像坏了，而不是「丰富」；
 *   4. `look_at` 生效期间她还自己乱瞥 —— 用户点名「向右看」，她十秒后自己转回来；
 *   5. 思考时小动作照旧满幅 —— 刚做的「收着点」被这一层绕过去了。
 *
 * 算术、手势表、挑选规则全在 `idle-garnish.ts`（`PetModel` 要 WebGL，Node 里构造
 * 不出来），所以这个文件能把 1~3 逐条钉住；接线（4、5）靠读源码对账。
 *
 * ## 用法
 *
 *     node tools/test-idle-garnish.mjs     （离线：无网络、无 DOM、无画布）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(PACKAGE, 'lib/test/idle-garnish.mjs');

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

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

if (!existsSync(modulePath)) {
  console.error(`纯逻辑产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(pathToFileURL(modulePath).href);
const {
  GARNISH_GESTURES,
  GARNISH_MIN_DELAY_MS,
  GARNISH_MAX_DELAY_MS,
  GARNISH_ABORT_DELAY_MS,
  GARNISH_MAX_STEP_MS,
  GARNISH_GAZE_ALLOWED_OFFSET,
  createGarnishState,
  garnishDurationMs,
  garnishTotalMs,
  garnishTrailDelayMs,
  envelopeAt,
  garnishValues,
  nextDelayMs,
  pickGesture,
  createRandom,
  smoothstep,
} = mod;

console.log('[1] 产物与常量');
check('产物导出七个手势', Array.isArray(GARNISH_GESTURES) && GARNISH_GESTURES.length === 7, `len=${GARNISH_GESTURES.length}`);
check('最短间隔 6500 ms', GARNISH_MIN_DELAY_MS === 6500, `= ${GARNISH_MIN_DELAY_MS}`);
check('最长间隔 15000 ms', GARNISH_MAX_DELAY_MS === 15000, `= ${GARNISH_MAX_DELAY_MS}`);
check('打断后 3000 ms 再试', GARNISH_ABORT_DELAY_MS === 3000, `= ${GARNISH_ABORT_DELAY_MS}`);
check('单帧最多认 200 ms', GARNISH_MAX_STEP_MS === 200, `= ${GARNISH_MAX_STEP_MS}`);
check('视线偏移阈值 0.4', GARNISH_GAZE_ALLOWED_OFFSET === 0.4, `= ${GARNISH_GAZE_ALLOWED_OFFSET}`);

console.log('[2] 手势表');
const ids = GARNISH_GESTURES.map(g => g.id);
check('id 全不重复', new Set(ids).size === ids.length, ids.join(','));
for (const need of ['glance-left', 'glance-right', 'glance-up', 'glance-down', 'brow-raise', 'head-tilt', 'body-turn']) {
  check(`有「${need}」`, ids.includes(need));
}
const byId = new Map(GARNISH_GESTURES.map(g => [g.id, g]));
/** 主部位 + 跟随部位合起来的参数表：检查幅度、检查方向时都该看全。 */
const allParams = g => ({ ...g.params, ...(g.trailing?.params ?? {}) });
check('向左看用的是 ParamAngleX 负值', allParams(byId.get('glance-left')).ParamAngleX < 0, `${allParams(byId.get('glance-left')).ParamAngleX}`);
check('向右看用的是 ParamAngleX 正值', allParams(byId.get('glance-right')).ParamAngleX > 0, `${allParams(byId.get('glance-right')).ParamAngleX}`);
check('抬头是 ParamAngleY 正值', allParams(byId.get('glance-up')).ParamAngleY > 0, `${allParams(byId.get('glance-up')).ParamAngleY}`);
check('低头是 ParamAngleY 负值', allParams(byId.get('glance-down')).ParamAngleY < 0, `${allParams(byId.get('glance-down')).ParamAngleY}`);
check('抬眉只动眉毛参数（两条都算上）', Object.keys(allParams(byId.get('brow-raise'))).every(k => k.startsWith('ParamBrow')), Object.keys(allParams(byId.get('brow-raise'))).join(','));
check('抬眉两条眉毛不同时（左先右后，且幅度不完全对称）', (() => {
  const g = byId.get('brow-raise');
  const lY = g.params.ParamBrowLY ?? 0;
  const rY = g.trailing?.params.ParamBrowRY ?? 0;
  return g.trailing !== undefined && Math.abs(lY - rY) > 0.02 && lY > rY;
})(), `${byId.get('brow-raise').params.ParamBrowLY} / ${byId.get('brow-raise').trailing?.params.ParamBrowRY}`);
check('侧身是身子先动、头后跟（ParamAngleZ 在 trailing 里）', (() => {
  const g = byId.get('body-turn');
  return g.trailing !== undefined && Object.keys(g.trailing.params).includes('ParamAngleZ') && !Object.keys(g.params).some(k => k.startsWith('ParamAngle'));
})());
check('侧身跟的头角度克制（≤5）', Math.abs(byId.get('body-turn').trailing?.params.ParamAngleZ ?? 0) <= 5, `${byId.get('body-turn').trailing?.params.ParamAngleZ}`);
check('侧身动的是身体参数', Object.keys(byId.get('body-turn').params).some(k => k.startsWith('ParamBody')), Object.keys(byId.get('body-turn').params).join(','));
check('歪头动的是 ParamAngleZ', Object.keys(allParams(byId.get('head-tilt'))).includes('ParamAngleZ'));
const tilt = allParams(byId.get('head-tilt'));
check('歪头的侧倾够看得出来（≥12 度）', Math.abs(tilt.ParamAngleZ) >= 12, `${tilt.ParamAngleZ}`);
check('歪头没歪到脖子断（≤18 度）', Math.abs(tilt.ParamAngleZ) <= 18, `${tilt.ParamAngleZ}`);

for (const g of GARNISH_GESTURES) {
  const params = Object.keys(allParams(g));
  const values = Object.values(allParams(g));
  check(`${g.id}：参数非空且全是有限数`, params.length > 0 && values.every(v => typeof v === 'number' && Number.isFinite(v)), `${params.length} 个参数`);
  check(`${g.id}：三段时长都是正数`, g.attackMs > 0 && g.holdMs > 0 && g.releaseMs > 0, `${g.attackMs}/${g.holdMs}/${g.releaseMs}`);
  check(`${g.id}：总时长在 0.5~3 秒之间`, garnishDurationMs(g) >= 500 && garnishDurationMs(g) <= 3000, `${garnishDurationMs(g)} ms`);
  const merged = allParams(g);
  const head = Math.abs(merged.ParamAngleX ?? 0);
  const tiltDeg = Math.abs(merged.ParamAngleZ ?? 0);
  const eye = Math.abs(merged.ParamEyeBallX ?? 0) + Math.abs(merged.ParamEyeBallY ?? 0);
  const body = Math.abs(merged.ParamBodyAngleX ?? 0);
  check(`${g.id}：幅度不夸张（头 ≤20、侧倾 ≤18、眼 ≤1.2、身体 ≤15）`, head <= 20 && tiltDeg <= 18 && eye <= 1.2 && body <= 15, `头 ${head} 侧倾 ${tiltDeg} 眼 ${eye.toFixed(2)} 身体 ${body}`);
  if (g.trailing !== undefined) {
    check(`${g.id}：跟随延迟在 80~250 ms（太短看不出先后，太长像分两次）`, g.trailing.delayMs >= 80 && g.trailing.delayMs <= 250, `${g.trailing.delayMs} ms`);
  }
}
check('眼睛先动、头后到：四个「瞥一眼」的头参数都在 trailing 里', ['glance-left', 'glance-right', 'glance-up', 'glance-down'].every(id => {
  const g = byId.get(id);
  const headKeys = Object.keys(g.trailing?.params ?? {}).filter(k => k.startsWith('ParamAngle'));
  return g.trailing !== undefined && headKeys.length > 0 && Object.keys(g.params).every(k => k.startsWith('ParamEyeBall'));
}));
check('歪头是头先动、身体跟：身体参数在 trailing 里', (() => {
  const g = byId.get('head-tilt');
  const bodyKeys = Object.keys(g.trailing?.params ?? {}).filter(k => k.startsWith('ParamBody'));
  return g.trailing !== undefined && bodyKeys.length > 0 && Object.keys(g.params).every(k => !k.startsWith('ParamBody'));
})(), Object.keys(byId.get('head-tilt').trailing?.params ?? {}).join(','));
check('身体跟随幅度克制（侧倾+侧转 ≤8）', (() => {
  const p = byId.get('head-tilt').trailing.params;
  return Math.abs(p.ParamBodyAngleZ ?? 0) + Math.abs(p.ParamBodyAngleX ?? 0) <= 8;
})());
check(' glances 与歪头都标了 gaze', ['glance-left', 'glance-right', 'glance-up', 'glance-down', 'head-tilt'].every(id => byId.get(id).gaze === true));
check('抬眉与侧身不动视线', byId.get('brow-raise').gaze === false && byId.get('body-turn').gaze === false);

console.log('[3] 包络');
const glance = byId.get('glance-left');
const total = garnishDurationMs(glance);
check('t=0 是 0', envelopeAt(glance, 0) === 0);
check('淡入中点约 0.5（smoothstep）', Math.abs(envelopeAt(glance, glance.attackMs / 2) - 0.5) < 0.01, envelopeAt(glance, glance.attackMs / 2).toFixed(3));
check('淡入结束恰好是 1', envelopeAt(glance, glance.attackMs) === 1);
check('保持段是 1', envelopeAt(glance, glance.attackMs + glance.holdMs / 2) === 1);
check('刚进淡出还没降完', envelopeAt(glance, glance.attackMs + glance.holdMs + glance.releaseMs / 2) > 0.4);
check('走完是 0', envelopeAt(glance, total) === 0);
check('超过总时长仍是 0', envelopeAt(glance, total + 5000) === 0);
check('负时间当 0', envelopeAt(glance, -100) === 0);
check('NaN 时间当 0', envelopeAt(glance, NaN) === 0);
let riseOk = true;
let prev = -1;
for (let t = 0; t <= glance.attackMs; t += 5) {
  const v = envelopeAt(glance, t);
  if (v < prev - 1e-9) riseOk = false;
  prev = v;
}
check('淡入段不回升', riseOk);
let fallOk = true;
prev = 1;
const releaseStart = glance.attackMs + glance.holdMs;
for (let t = releaseStart; t <= total; t += 5) {
  const v = envelopeAt(glance, t);
  if (v > prev + 1e-9) fallOk = false;
  prev = v;
}
check('淡出段不回升', fallOk);
let bounded = true;
for (let t = -200; t <= total + 200; t += 37) {
  const v = envelopeAt(glance, t);
  if (!(v >= 0 && v <= 1)) bounded = false;
}
check('包络永远在 [0,1]', bounded);
check('smoothstep 两端导数为 0（0.01 → 极小）', smoothstep(0.01) < 0.01 && smoothstep(0.99) > 0.99);

console.log('[4] 逐帧叠加');
const glanceHeads = allParams(glance);
const state = createGarnishState();
check('空状态返回空值', Object.keys(garnishValues(state, 16, 1).values).length === 0);
state.gesture = glance;
const first = garnishValues(state, 16, 1);
check('淡入第一帧就有值', Object.keys(first.values).length > 0);
check('第一帧幅度小于满幅', Math.abs(first.values.ParamEyeBallX) < Math.abs(glance.params.ParamEyeBallX));
check('第一帧还轮不到头（眼睛先动）', (first.values.ParamAngleX ?? 0) === 0, `${first.values.ParamAngleX}`);
const totalMs = garnishTotalMs(glance);
check('总时长 = 主部位 + 跟随延迟', Math.abs(totalMs - (garnishDurationMs(glance) + glance.trailing.delayMs)) < 1e-9, `${totalMs} ms`);
let frames = 0;
while (state.gesture !== null && frames < 1000) {
  garnishValues(state, 16, 1);
  frames += 1;
}
check('按 60fps 播完（帧数与总时长一致 ±2）', Math.abs(frames - Math.round(totalMs / 16)) <= 2, `${frames} 帧 vs ${Math.round(totalMs / 16)}`);
check('播完把 gesture 清掉', state.gesture === null && state.elapsedMs === 0);
check('播完比主部位晚一个延迟（不然肩膀会硬弹回去）', totalMs > garnishDurationMs(glance));

const lead = createGarnishState();
lead.gesture = glance;
const atDelay = garnishValues(lead, glance.trailing.delayMs / 2, 1);
check('延迟还没到：头一点没动', (atDelay.values.ParamAngleX ?? 0) === 0, `${atDelay.values.ParamAngleX}`);
const afterDelay = garnishValues(lead, glance.trailing.delayMs, 1);
check('延迟到了之后：头开始跟上', Math.abs(afterDelay.values.ParamAngleX ?? 0) > 0, `${afterDelay.values.ParamAngleX}`);

const clamped = createGarnishState();
clamped.gesture = glance;
garnishValues(clamped, 5000, 1);
check('单帧 5 秒只推进 200 ms', Math.abs(clamped.elapsedMs - 200) < 1e-9, `${clamped.elapsedMs}`);
check('所以 5 秒那一帧还没播完（没跳到收尾）', clamped.gesture !== null);

const half = createGarnishState();
half.gesture = glance;
half.elapsedMs = glance.attackMs + glance.holdMs / 2;
const damped = garnishValues(half, 0, 0.35);
check('factor=0.35 时幅度恰好是一半不到', Math.abs(damped.values.ParamAngleX - glanceHeads.ParamAngleX * 0.35) < 1e-9, `${damped.values.ParamAngleX}`);
const dampedTrail = createGarnishState();
dampedTrail.gesture = glance;
dampedTrail.elapsedMs = glance.attackMs + glance.holdMs / 2 + glance.trailing.delayMs;
const dampedTrailFrame = garnishValues(dampedTrail, 0, 0.35);
check('跟随部位也吃同一个折扣', Math.abs(dampedTrailFrame.values.ParamAngleX - glanceHeads.ParamAngleX * 0.35) < 1e-9, `${dampedTrailFrame.values.ParamAngleX}`);
const zero = createGarnishState();
zero.gesture = glance;
zero.elapsedMs = glance.attackMs + glance.holdMs / 2;
const scaled0 = garnishValues(zero, 0, 0);
check('factor=0 时一个参数都不写', Object.keys(scaled0.values).length === 0);

console.log('[5] 挑选');
const rng0 = createRandom(1);
check('随机数在 [0,1)', (() => { for (let i = 0; i < 500; i += 1) { const v = rng0(); if (!(v >= 0 && v < 1)) return false; } return true; })());
const seq = createRandom(7);
const picked = new Set();
let invalid = 0;
for (let i = 0; i < 200; i += 1) {
  const g = pickGesture(seq);
  if (g === null || !ids.includes(g.id)) invalid += 1;
  else picked.add(g.id);
}
check('200 次挑选全部落在手势表里', invalid === 0);
check('七个手势都挑得到（分布不退化）', picked.size === ids.length, `${picked.size} 种`);
let avoided = 0;
const seq2 = createRandom(11);
for (let i = 0; i < 100; i += 1) {
  const g = pickGesture(seq2, { avoidId: 'glance-left' });
  if (g !== null && g.id === 'glance-left') avoided += 1;
}
check('avoidId 生效（100 次里一次都没重复）', avoided === 0);
let gazeLeak = 0;
const seq3 = createRandom(13);
for (let i = 0; i < 200; i += 1) {
  const g = pickGesture(seq3, { allowGaze: false });
  if (g === null) { gazeLeak += 1; continue; }
  if (g.gaze) gazeLeak += 1;
}
check('allowGaze=false 时只挑不动视线的', gazeLeak === 0);
check('rng=0 挑第一项', pickGesture(() => 0).id === GARNISH_GESTURES.find(g => g.gaze === true)?.id ?? ids[0]);
check('rng≈1 挑最后一项', pickGesture(() => 0.999999).id === [...GARNISH_GESTURES].reverse()[0].id, pickGesture(() => 0.999999).id);
check('脏 rng 不抛', (() => { try { pickGesture(() => NaN); return true; } catch { return false; } })());

console.log('[6] 间隔');
check('rng=0 → 最短间隔', nextDelayMs(() => 0) === GARNISH_MIN_DELAY_MS, `${nextDelayMs(() => 0)}`);
check('rng=0.999999 → 最长间隔', nextDelayMs(() => 0.999999) === GARNISH_MAX_DELAY_MS, `${nextDelayMs(() => 0.999999)}`);
let inRange = true;
const seq4 = createRandom(3);
for (let i = 0; i < 200; i += 1) {
  const d = nextDelayMs(seq4);
  if (!(d >= GARNISH_MIN_DELAY_MS && d <= GARNISH_MAX_DELAY_MS)) inRange = false;
}
check('200 次间隔都在区间内', inRange);
check('脏 rng 也不越界', nextDelayMs(() => NaN) >= GARNISH_MIN_DELAY_MS && nextDelayMs(() => NaN) <= GARNISH_MAX_DELAY_MS);

console.log('[7] 接线（读源码对账）');
const petModel = stripComments(readFileSync(resolve(PACKAGE, 'src/client/pet-model.ts'), 'utf8'));
check('pet-model 从 idle-garnish 引入', /from '\.\/idle-garnish'/.test(petModel));
check('update() 里真的调了 _applyGarnish(delta)', /this\._applyGarnish\(delta\);/.test(petModel));
check('排在情绪层之后', petModel.indexOf('this._applyEmotion(delta);') < petModel.indexOf('this._applyGarnish(delta);'));
check('_applyGarnish 定义存在', /private _applyGarnish\(delta: number\): void/.test(petModel));
check('用 addParameterValue 叠加（不是 setParameterValue 接管）', /this\.addParameterValue\(id, frame\.values\[id\]\)/.test(petModel));
check('思考时按 calmFactorFor(_calm) 打折', /garnishValues\(this\._garnish, step, calmFactorFor\(this\._calm\)\)/.test(petModel));
check('正经动作在播时不叠（isBusyWithRealMotion）', /isBusyWithRealMotion\(this\.currentMotionPriority\(\)\)/.test(petModel));
check('打断后按 GARNISH_ABORT_DELAY_MS 重排', /GARNISH_ABORT_DELAY_MS/.test(petModel));
check('look_at 期间跳过会动视线的手势', /_lookAllowsGaze\(\)/.test(petModel) && /dragManager\.settled\(\)/.test(petModel));
check('单帧增量被 GARNISH_MAX_STEP_MS 截住', /GARNISH_MAX_STEP_MS/.test(petModel));
const garnishBody = petModel.slice(petModel.indexOf('private _applyGarnish'), petModel.indexOf('private _lookAllowsGaze'));
check('_applyGarnish 里没有 setParameterValue（不接管别人）', !/setParameterValue/.test(garnishBody));
check('口型参数不在手势表里', GARNISH_GESTURES.every(g => !Object.keys(allParams(g)).some(k => k === 'ParamMouthOpenY' || k === 'ParamMouthForm')));

console.log('[8] 反证');
const zeroDuration = { id: 'zero', params: { ParamAngleX: 10 }, attackMs: 0, holdMs: 0, releaseMs: 0, gaze: false };
check('反证一：时长为 0 的手势总时长是 0', garnishDurationMs(zeroDuration) === 0);
const zs = createGarnishState();
zs.gesture = zeroDuration;
check('反证二：时长为 0 立刻算播完', garnishValues(zs, 16, 1).done === true);
check('反证三：包络永远不会大于 1', envelopeAt(glance, glance.attackMs - 1) <= 1 && envelopeAt(glance, glance.attackMs + 1) <= 1);
const noGazeOnly = GARNISH_GESTURES.filter(g => !g.gaze);
check('反证四：不动视线的手势确实存在（allowGaze=false 才有东西可挑）', noGazeOnly.length >= 2, `${noGazeOnly.length} 个`);

console.log('');
if (failed > 0) {
  console.error(`[20] IDLE GARNISH GATE FAILED  ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`[20] IDLE GARNISH GATE PASSED  ${passed} passed`);
