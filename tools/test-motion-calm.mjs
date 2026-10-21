#!/usr/bin/env node
/**
 * 门禁：**思考时「收着点」**（`lib/test/motion-calm.mjs` ＝ `src/client/motion-calm.ts`）。
 *
 * ## 为什么需要这个文件
 *
 * 用户的原话是「希望她在思考的时候不要动的那么剧烈」。这条改动的独特难点是
 * **它没有可看的产物**：没有报错、没有返回值、没有一眼能对的数字，唯一的证据
 * 是「看起来安静了一些」。于是下面四种错都能悄悄活下来：
 *
 *   1. 包络根本没起来（Host 那条 `mood` 字段没接上）—— 画面上什么都没变；
 *   2. 包络起得太快/太慢（480 ms 写成 48 或 4800）—— 只是「有点突兀」；
 *   3. `calm = 0` 时系数不是**恰好** 1 —— 不思考时动作也小了一点点，没人查得出来；
 *   4. 收幅收错对象 —— AI 点名的动作（挥手、点头）也被打了折，用户会觉得
 *      「她现在怎么这么没劲」，而那是另一个故事。
 *
 * 算术全在 `motion-calm.ts`（`PetModel` 要 WebGL，Node 里构造不出来），
 * 所以这个文件能把 1~4 逐条钉住；接线部分靠读源码对账。
 *
 * ## 用法
 *
 *     node tools/test-motion-calm.mjs     （离线：无网络、无 DOM、无画布）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(PACKAGE, 'lib/test/motion-calm.mjs');

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
  IDLE_CALM_FACTOR,
  CALM_ATTACK_MS,
  CALM_RELEASE_MS,
  CALM_EPSILON,
  CALM_MAX_STEP_MS,
  THINKING_LAYER_NAME,
  clamp01,
  advanceCalm,
  calmFactorFor,
  calmTargetFor,
  dampTowardDefault,
  shouldDampMotion,
} = mod;

const close = (a, b, epsilon = 1e-9) => typeof a === 'number' && Math.abs(a - b) <= epsilon;

/** 按 60fps 的节拍把包络从 `from` 推到 `to`，返回 { frames, value, trail }。 */
function runEnvelope(from, to, extraMs = 2000) {
  const frameMs = 1000 / 60;
  let value = from;
  let frames = 0;
  const trail = [];
  while (frames * frameMs < extraMs) {
    const previous = value;
    value = advanceCalm(value, to, frameMs);
    frames += 1;
    trail.push(value);
    if (value === to) return { frames, value, trail, stable: previous === value };
  }
  return { frames, value, trail, stable: false };
}

// ---------------------------------------------------------------------------
console.log('\n[1] 产物与导出');
// ---------------------------------------------------------------------------
check('测试产物存在', existsSync(modulePath), modulePath.replace(PACKAGE, ''));
check('IDLE_CALM_FACTOR 是 0~1 之间的数', typeof IDLE_CALM_FACTOR === 'number' && IDLE_CALM_FACTOR > 0 && IDLE_CALM_FACTOR < 1, String(IDLE_CALM_FACTOR));
check('淡入时长 480 ms', CALM_ATTACK_MS === 480, String(CALM_ATTACK_MS));
check('放开时长 1100 ms', CALM_RELEASE_MS === 1100, String(CALM_RELEASE_MS));
check('包络阈值为正', typeof CALM_EPSILON === 'number' && CALM_EPSILON > 0 && CALM_EPSILON < 0.05, String(CALM_EPSILON));
check('单帧上限 200 ms', CALM_MAX_STEP_MS === 200, String(CALM_MAX_STEP_MS));
check('思考层名字是「思考」', THINKING_LAYER_NAME === '思考', THINKING_LAYER_NAME);
check('函数齐全', ['clamp01', 'advanceCalm', 'calmFactorFor', 'calmTargetFor', 'dampTowardDefault', 'shouldDampMotion'].every((name) => typeof mod[name] === 'function'));

// ---------------------------------------------------------------------------
console.log('\n[2] 包络时间线（60fps 逐帧）');
// ---------------------------------------------------------------------------
const up = runEnvelope(0, 1);
check('从 0 升到 1 需要 29 帧（480 ms）', up.frames === 29, `${up.frames} 帧`);
check('第 28 帧还没到（不是一帧到位）', advanceCalm(0, 1, (28 * 1000) / 60) < 1, String(advanceCalm(0, 1, (28 * 1000) / 60)));
check('升的过程中严格单调', up.trail.every((value, index) => index === 0 || value >= up.trail[index - 1]));
check('升的过程中不越界', up.trail.every((value) => value >= 0 && value <= 1));

const down = runEnvelope(1, 0);
// 1100 / (1000/60) = 66.0 —— 正好落在帧边界上，浮点累加的末位误差会让它多走一帧，
// 所以这里钉的是「不能早于 1100 ms」，而不是「必须第 66 帧」。早一帧才是真 bug。
check('从 1 放到 0 不早于 1100 ms（66~67 帧）', down.frames >= 66 && down.frames <= 67, `${down.frames} 帧`);
check('第 65 帧时还没放开完（不是一下子弹回去）', advanceCalm(1, 0, (65 * 1000) / 60) > 0, String(advanceCalm(1, 0, (65 * 1000) / 60)));
check('放开比淡入慢（不是同一个时长）', down.frames > up.frames, `${down.frames} > ${up.frames}`);
check('放的过程中严格单调', down.trail.every((value, index) => index === 0 || value <= down.trail[index - 1]));

check('一帧 5 秒也只走 200 ms 的步长', close(advanceCalm(0, 1, 5000), 200 / 480), String(advanceCalm(0, 1, 5000)));
check('dt = 0 时原样返回', advanceCalm(0.3, 1, 0) === 0.3);
check('dt 为负数时原样返回', advanceCalm(0.3, 1, -50) === 0.3);
check('dt 为 NaN 时原样返回', advanceCalm(0.3, 1, NaN) === 0.3);
check('当前值是 NaN 时当 0 起算', advanceCalm(NaN, 1, 16) > 0 && advanceCalm(NaN, 1, 16) < 0.05);
check('已经在目标上时不漂移', advanceCalm(1, 1, 16) === 1 && advanceCalm(0, 0, 16) === 0);
check('calmTargetFor 只回 0 / 1', calmTargetFor(true) === 1 && calmTargetFor(false) === 0);
check('clamp01 夹取 NaN / 越界', clamp01(NaN) === 0 && clamp01(-3) === 0 && clamp01(7) === 1);

// ---------------------------------------------------------------------------
console.log('\n[3] 系数曲线');
// ---------------------------------------------------------------------------
check('calm = 0 时系数**恰好**是 1（不思考时逐像素不变）', calmFactorFor(0) === 1);
check('calm = 1 时系数是 IDLE_CALM_FACTOR', calmFactorFor(1) === IDLE_CALM_FACTOR, String(calmFactorFor(1)));
const curve = [0, 0.25, 0.5, 0.75, 1].map((calm) => calmFactorFor(calm));
check('随 calm 单调递减', curve.every((value, index) => index === 0 || value <= curve[index - 1]), curve.map((v) => v.toFixed(3)).join(' → '));
check('越界值照样夹取', calmFactorFor(-1) === 1 && calmFactorFor(9) === IDLE_CALM_FACTOR);
check('NaN 当 0（退回不改动）', calmFactorFor(NaN) === 1);

// ---------------------------------------------------------------------------
console.log('\n[4] 往默认值收');
// ---------------------------------------------------------------------------
check('10 → 默认 2、系数 0.35 得到 4.8', close(dampTowardDefault(10, 2, 0.35), 4.8), String(dampTowardDefault(10, 2, 0.35)));
check('系数 1 时恒等（改动前行为）', dampTowardDefault(10, 2, 1) === 10);
check('系数 0 时回到默认值', dampTowardDefault(10, 2, 0) === 2);
check('默认值为 0 时按比例收', close(dampTowardDefault(-8, 0, 0.35), -2.8), String(dampTowardDefault(-8, 0, 0.35)));
check('value 是 NaN 时用默认值', dampTowardDefault(NaN, 3, 0.5) === 3);
check('default 是 NaN 时当 0 起算', dampTowardDefault(4, NaN, 0.5) === 2);
check('系数超过 1 时夹到 1（不放大）', dampTowardDefault(10, 2, 3) === 10);

// ---------------------------------------------------------------------------
console.log('\n[5] 该不该收（只收待机档）');
// ---------------------------------------------------------------------------
const base = { calm: 1, motionUpdated: true, motionPriority: 1, idlePriority: 1 };
check('calm = 0 时什么都不做', shouldDampMotion({ ...base, calm: 0 }) === false);
check('calm 恰好在阈值上时不做（严格大于）', shouldDampMotion({ ...base, calm: CALM_EPSILON }) === false);
check('待机动作 + 包络起来 → 收', shouldDampMotion(base) === true);
check('AI 点名的动作（优先级 2）不收', shouldDampMotion({ ...base, motionPriority: 2 }) === false);
check('FORCE（优先级 3）不收', shouldDampMotion({ ...base, motionPriority: 3 }) === false);
check('这一帧没有动作在写参数时不收', shouldDampMotion({ ...base, motionUpdated: false }) === false);
check('优先级是 NaN 时按 0 处理（仍收）', shouldDampMotion({ ...base, motionPriority: NaN }) === true);

// ---------------------------------------------------------------------------
console.log('\n[6] 接线（读源码对账）');
// ---------------------------------------------------------------------------
const petModelSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/pet-model.ts'), 'utf8'));
const pluginSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/plugin.ts'), 'utf8'));
const hostSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/index.js'), 'utf8'));
const moodSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/host/mood.js'), 'utf8'));
const runnerSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/action-runner.ts'), 'utf8'));

check('`PetModel` 真的把每个参数往默认值收', petModelSource.includes('dampTowardDefault('));
check('`PetModel` 每帧推进包络', petModelSource.includes('advanceCalm('));
check('收幅在 `saveParameters()` **之前**', (() => {
  const damp = petModelSource.indexOf('this._applyMotionCalm(delta)');
  const save = petModelSource.indexOf('model.saveParameters()', damp);
  return damp > 0 && save > damp;
})(), '顺序错了效果链会二次叠加');
check('收幅跳过口型（那条通道独占）', (() => {
  const start = petModelSource.indexOf('private _applyMotionCalm');
  const slice = petModelSource.slice(start, start + 2000);
  return slice.includes('MOUTH_OPEN_PARAMETER_ID') && slice.includes('MOUTH_FORM_PARAMETER_ID');
})());
check('只对待机档生效（用 FRAMEWORK_PRIORITY.IDLE）', petModelSource.includes('idlePriority: FRAMEWORK_PRIORITY.IDLE'));
check('渲染端从 `mood.state` 读思考态', pluginSource.includes("setMotionCalm?.(data.mood?.state === 'thinking')"));
check('`/pending` 顺带报 mood', /\/pending'[\s\S]{0,1200}?mood: state\.mood/.test(hostSource));
check('Host 的状态机确实是那个字段名', /state:\s*mood\.state/.test(hostSource) || hostSource.includes('state.mood = {'));
check('两层名字一致（Host 的 THINKING_EMOTION_NAME ＝ 客户端的 THINKING_LAYER_NAME）', (() => {
  const hostName = /export const THINKING_EMOTION_NAME = '([^']+)'/.exec(moodSource);
  return hostName !== null && hostName[1] === THINKING_LAYER_NAME;
})());
check('指令层接口声明了可选方法（旧 Host 时不存在）', runnerSource.includes('setMotionCalm?(active: boolean): void;'));

// ---------------------------------------------------------------------------
console.log('\n[7] 反证：朴素做法会被这些断言抓出来');
// ---------------------------------------------------------------------------
/** 朴素做法 1：没有包络，一帧直接跳到目标。 */
const naiveJump = (current, target) => (target > current ? 1 : 0);
check('退化 1（一帧到位）16 ms 后就是 1，真实现不是', naiveJump(0, 1) === 1 && advanceCalm(0, 1, 16) < 1, `真实现 ${advanceCalm(0, 1, 16).toFixed(4)}`);

/** 朴素做法 2：收所有动作，不看优先级。 */
const naiveDampAll = () => true;
check('退化 2（收所有动作）会把 AI 点名的动作也打折', naiveDampAll() === true && shouldDampMotion({ ...base, motionPriority: 2 }) === false);

/** 朴素做法 3：`calm = 0` 时系数用近似值而不是恰好 1。 */
const naiveApprox = (calm) => 1 - calm * (1 - IDLE_CALM_FACTOR) - 1e-9;
check('退化 3（系数差 1e-9）会被「恰好 === 1」抓出来', naiveApprox(0) !== 1 && calmFactorFor(0) === 1);

/** 朴素做法 4：函数库「思考」二字写错（改名漂移）。 */
check('退化 4（层名不匹配）会被第 [6] 段的改名对账抓出来', (() => {
  const hostName = /export const THINKING_EMOTION_NAME = '([^']+)'/.exec(moodSource);
  return hostName !== null && hostName[1] !== '思考中';
})());

console.log('');
if (failed > 0) {
  console.log(`[19] MOTION CALM GATE FAILED —— ${failed} 项失败，${passed} 项通过`);
  process.exit(1);
}
console.log(`[19] MOTION CALM GATE PASSED —— ${passed} 项断言全绿`);
