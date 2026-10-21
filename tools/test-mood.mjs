/*
 * D 期门禁：**她的状态**（`host/mood.js` + `host/emotions.js` 的情绪层状态机）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 这一道门禁在守什么
 * ─────────────────────────────────────────────────────────────────────────
 * B 期与 C 期做完之后，她的脸会「跟着话动」了。但那张脸只有两种命运：
 * 「这句里有情绪词」→ 动一下；其余时间 → **完全静止**（和掉线长得一样）。
 * D 期补的是两件事：
 *
 *   1. **层**（`emotions.js` 的 `createEmotionLayers` 那一族）。B 期是单层，
 *      换情绪 = 一帧换脸。现在旧的那层化进新的那层，任意时刻可能有 0..n 层
 *      同时往同一个参数上写。**两个东西同时写一个参数**是这一期唯一真正
 *      复杂的地方，也正是最该被逐帧对账的地方 —— 而它跑在浏览器里（要 Cubism
 *      Core 与 WebGL），所以数学必须留在 Host 半区的纯函数里，这里直接喂 delta。
 *   2. **状态**（`mood.js`）。回合开始 → 思考态；回合结束 → 收掉。它不由话的
 *      内容决定，所以 C 期那套关键词表永远盖不到它。
 *
 * 为什么断言密度这么高：这两件东西的失效方式都是**静默**的。一层没被摘掉，
 * 面板会一直说她「开心」；思考态没收，她的脸会一直皱着；交叉淡出退化成剪掉，
 * 只有肉眼在 260ms 里能看出来 —— 而肉眼那一关是我们唯一没有自动化的关（她
 * 的脸在浏览器里）。所以这里把能钉的都钉死。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCore, waitForCore } from './gate-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..');
const PACKAGE = resolve(WORKSPACE, 'dsh-live2d-pet');
const CORE_PATH = resolve(PACKAGE, 'vendor', 'cubism', 'live2dcubismcore.min.js');
const HIYORI_MOC = resolve(WORKSPACE, 'models-inbox', 'hiyori_vts', 'hiyori.moc3');

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
    return true;
  }
  failures += 1;
  console.log(`  ✘ ${label}${detail === '' ? '' : `\n      ${detail}`}`);
  return false;
}

function section(title) {
  console.log(`\n${title}`);
}

/** 门禁只看代码，不看注释 —— 注释里写着 `moodOnTurnEnd` 不算数。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function near(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) <= epsilon;
}

const emotions = await import(pathToFileURL(resolve(PACKAGE, 'lib/host/emotions.js')).href);
const moodModule = await import(pathToFileURL(resolve(PACKAGE, 'lib/host/mood.js')).href);
const streamModule = await import(pathToFileURL(resolve(PACKAGE, 'lib/host/emotion-stream.js')).href);
const { EMOTION_KEYWORDS, STREAM_EMOTION_INTENSITY, STREAM_HOLD_MAX_MS } = streamModule;

const {
  ROLE_PARAMETER_IDS,
  EMOTION_SWITCH_FADE_MS,
  EMOTION_CLEAR_FADE_MS,
  EMOTION_MAX_FADE_MS,
  EMOTION_MAX_HOLD_MS,
  EMOTION_RELEASE_MS,
  EMOTION_REUSE_WEIGHT,
  /*
   * ★ §13.33 之后「hold 走完」不再等于「马上消失」：默认按 7 秒的 τ 指数衰减，
   * 低于 `EMOTION_DECAY_FLOOR` 才摘掉。这两条断言要等的时长必须跟着它走 ——
   * 门禁里写死 `releaseMs` 的话，测的就不是现在这条路了。
   */
  EMOTION_DECAY_MS,
  EMOTION_DECAY_FLOOR,
  createEmotionLayers,
  setEmotionLayers,
  clearEmotionLayers,
  releaseEmotionLayers,
  advanceEmotionLayers,
  describeEmotionLayers,
  resolveEmotion,
  canonicalEmotionName,
} = emotions;

const {
  MOOD_STATES,
  MOOD_IDLE,
  MOOD_THINKING,
  MOOD_REACTING,
  MOOD_SETTLING,
  THINKING_INTENSITY,
  THINKING_HOLD_MS,
  THINKING_ATTACK_MS,
  THINKING_RELEASE_MS,
  THINKING_EMOTION_NAME,
  thinkingEmotion,
  createMood,
  moodOnTurnStart,
  moodOnEmotion,
  moodOnTurnEnd,
  moodToIdle,
  describeMood,
  advanceMood,
  MOOD_SETTLING_MS,
} = moodModule;

/* ───────────────── [1] 情绪层状态机 ───────────────── */

section('[1] 情绪层：多层叠加、交叉淡出、惯性复用、衰减');

/*
 * 用**真实的预设**（跑一遍 `resolveEmotion()`）当夹具，而不是手搓一层假的：
 * 手搓的话「层里装的是什么形状」就成了我自己的假设，而真实形状是
 * `{name, params, holdMs, attackMs, releaseMs}` —— 两边一旦分叉，这一节全绿
 * 而线上不工作是可能的。
 */
const WIDE_TABLE = Object.keys(ROLE_PARAMETER_IDS).map((role) => ({
  id: ROLE_PARAMETER_IDS[role][0],
  min: -30,
  max: 30,
  def: 0,
}));

const happy = resolveEmotion('开心', { parameters: WIDE_TABLE, intensity: 1 }).emotion;
const sad = resolveEmotion('难过', { parameters: WIDE_TABLE, intensity: 1 }).emotion;

ok('夹具成立：开心与难过都解析出了参数，且名字不同',
  Object.keys(happy.params).length > 0 && Object.keys(sad.params).length > 0 && happy.name !== sad.name,
  `开心 ${Object.keys(happy.params).length} 个参数 / 难过 ${Object.keys(sad.params).length} 个`);

const empty = createEmotionLayers();
ok('空状态是空表（不是 null / undefined）',
  Array.isArray(empty.layers) && empty.layers.length === 0 && Array.isArray(empty.active),
  JSON.stringify(empty));

const installHappy = setEmotionLayers(empty, happy);
ok('装第一层：只有一层、没有东西被推进退场、也不是复用',
  installHappy.state.layers.length === 1
  && installHappy.released === 0
  && installHappy.reused === false);
ok('新层的寿命从 0 开始（不是继承上一个层的时间）',
  installHappy.state.layers[0].elapsedMs === 0);
ok('新层带着它自己的四段时长（来自 resolveEmotion）',
  installHappy.state.layers[0].holdMs === happy.holdMs
  && installHappy.state.layers[0].attackMs === happy.attackMs
  && installHappy.state.layers[0].releaseMs === happy.releaseMs);

/** 逐帧推进，返回最后一帧、累计帧数与累计摘掉几层 —— 对账都用它，避免手写循环写错。 */
function runFrames(state, totalMs, stepMs = 16) {
  let current = state;
  let last = null;
  let frames = 0;
  let droppedTotal = 0;
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    last = advanceEmotionLayers(current, stepMs);
    current = last.state;
    frames += 1;
    droppedTotal += last.dropped;
  }
  return { state: current, last, frames, droppedTotal };
}

const atZero = advanceEmotionLayers(installHappy.state, 0);
ok('时间不往前走时，权重仍是 0（包络在 t=0 就是 0，不是满值）',
  atZero.active.length === 0 || atZero.active.every((item) => item.weight === 0),
  JSON.stringify(atZero.active));

/*
 * ★ 逐帧对账：`values` 必须等于「每一层的增量 × 那一层此刻的权重」之和。
 *
 * 这条是这一节的地基 —— 它不重复实现包络，而是**独立地**从
 * `state.layers`（增量）+ `active`（权重）重算一遍，再和实现给出的 `values`
 * 对上。两层同时在场时它才真正有意义，所以下面每一处关键帧都跑一遍。
 */
function valuesMatchLayers(frame) {
  const expected = {};
  for (const active of frame.active) {
    const layer = frame.state.layers.find((item) => item.name === active.name);
    if (layer === undefined) return `active 里的「${active.name}」不在 layers 里`;
    for (const [id, delta] of Object.entries(layer.params)) {
      expected[id] = (expected[id] ?? 0) + delta * active.weight;
    }
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(frame.values)]);
  for (const id of keys) {
    const a = expected[id] ?? 0;
    const b = frame.values[id] ?? 0;
    if (!near(a, b, 1e-9)) return `${id}：期望 ${a}，实际 ${b}`;
  }
  return '';
}

const full = runFrames(installHappy.state, happy.attackMs + 50);
ok('★ 逐帧对账：values = Σ(层增量 × 层权重)',
  valuesMatchLayers(full.last) === '', String(valuesMatchLayers(full.last)));
ok('过了淡入之后权重到 1，写进去的就是预设里的增量本身',
  full.last.active.length === 1
  && near(full.last.active[0].weight, 1)
  && Object.keys(happy.params).every((id) => near(full.last.values[id], happy.params[id])),
  JSON.stringify(full.last.active));

/*
 * ★ 换情绪：旧的**不能**在一帧之内消失（那是 B 期的行为，也是这一期要修的）。
 * 换完之后的第一帧里，两层必须同时在场，旧的那层权重还接近 1。
 */
const swapped = setEmotionLayers(full.state, sad);
const crossFrame = advanceEmotionLayers(swapped.state, 16);
ok('★ 换情绪之后旧的那层还在（不是一帧换脸）',
  crossFrame.active.length === 2, JSON.stringify(crossFrame.active));
ok('★ 旧的那层在这一帧里权重仍接近 1（它是化掉，不是被剪掉）',
  (crossFrame.active.find((item) => item.name === happy.name)?.weight ?? 0) > 0.9,
  JSON.stringify(crossFrame.active));
ok('★ 新的那层同时在场（从 0 开始涨）',
  (crossFrame.active.find((item) => item.name === sad.name)?.weight ?? 1) < 0.2,
  JSON.stringify(crossFrame.active));
ok('★ 两层叠加时逐帧对账仍然成立（这才是「两个东西写同一个参数」）',
  valuesMatchLayers(crossFrame) === '', String(valuesMatchLayers(crossFrame)));

const sharedIds = Object.keys(happy.params).filter((id) => id in sad.params);
ok('（夹具信息）开心与难过有没有共用参数（共用才测得到求和）……',
  true, sharedIds.length > 0
    ? `共用 ${sharedIds.join(' / ')}`
    : '没有共用参数 —— 求和由上面那条独立重算的断言覆盖');

const afterSwitch = runFrames(swapped.state, EMOTION_SWITCH_FADE_MS + 40);
ok('交叉淡出走完之后旧的层被摘掉，只剩新的那层',
  afterSwitch.state.layers.length === 1 && afterSwitch.state.layers[0].name === sad.name,
  afterSwitch.state.layers.map((item) => item.name).join(' / '));

/*
 * ★ 从**淡入途中**被替换：不许跳变。
 *
 * 这一条守的是一个很容易写错的实现：把旧的层「推进退场」时去改它的 `holdMs`
 * （让它立刻开始淡出）。那样只有**已经到 1** 的层能平滑退场，一个权重 0.4 的
 * 层会先被抬到 1 再退 —— 换情绪时那一下比直接剪掉还显眼。
 */
const midway = runFrames(setEmotionLayers(createEmotionLayers(), happy).state, happy.attackMs / 2);
const midwayWeight = midway.last.active[0]?.weight ?? -1;
ok('（夹具）淡入进行到一半时权重确实在 0 与 1 之间',
  midwayWeight > 0.2 && midwayWeight < 0.8, `实际 ${midwayWeight}`);
const midwaySwapped = setEmotionLayers(midway.state, sad);
const midwayFirst = advanceEmotionLayers(midwaySwapped.state, 0);
const midwayHappy = midwayFirst.active.find((item) => item.name === happy.name)?.weight ?? -1;
ok('★ 从淡入途中被换掉时，旧的层不跳变（权重原地开始化）',
  near(midwayHappy, midwayWeight, 0.02), `换之前 ${midwayWeight}，换之后 ${midwayHappy}`);

/*
 * ★ 惯性：同一个情绪在权重还高时再来一条 —— 不重来，续时间。
 * 不这么做的话，第二句「太好了」会让她脸上的笑**掉回 0 再涨回来**（一次抽搐）。
 */
const reuseBase = runFrames(setEmotionLayers(createEmotionLayers(), happy).state, happy.attackMs + 200);
const reused = setEmotionLayers(reuseBase.state, { ...happy, holdMs: 1000 });
ok('★ 同名情绪在权重高时复用（不重建一层）',
  reused.reused === true && reused.state.layers.length === 1, JSON.stringify({ reused: reused.reused, n: reused.state.layers.length }));
ok('★ 复用时保持时间是**续上**的（第二句让她笑得更久）',
  reused.state.layers[0].holdMs === happy.holdMs + 1000,
  `期望 ${happy.holdMs + 1000}，实际 ${reused.state.layers[0].holdMs}`);
ok('复用不改已经走过的寿命（脸上的权重不跳）',
  reused.state.layers[0].elapsedMs === reuseBase.state.layers[0].elapsedMs);

/*
 * ★ 权重跌到复用阈值以下要等多久（§13.33 之后是**指数尾**，不是线性淡出）。
 *
 * `exp(-x/τ) < 0.9` 解出 `x > 738ms`（τ = 7 秒），所以这里留 900ms 的余量。
 * 之前写的是 `releaseMs / 2`（250ms）—— 那是线性年代的值，指数尾下它还在 0.96。
 */
const belowReuseMs = Math.ceil(-EMOTION_DECAY_MS * Math.log(EMOTION_REUSE_WEIGHT)) + 200;
const faded = runFrames(setEmotionLayers(createEmotionLayers(), { ...happy, holdMs: 100 }).state,
  happy.attackMs + 100 + belowReuseMs);
const fadedWeight = faded.last.active[0]?.weight ?? 0;
ok('（夹具）这一帧的权重已经掉到复用阈值以下', fadedWeight < EMOTION_REUSE_WEIGHT, `实际 ${fadedWeight}`);
const notReused = setEmotionLayers(faded.state, happy);
ok('★ 已经淡到阈值以下的同名情绪**不**复用（重新装一层）',
  notReused.reused === false && notReused.state.layers.length === 2,
  JSON.stringify({ reused: notReused.reused, n: notReused.state.layers.length }));
ok('不复用时旧的层被推进退场（不是被丢掉）',
  notReused.released === 1);

const keepForever = setEmotionLayers(
  runFrames(setEmotionLayers(createEmotionLayers(), { ...happy, holdMs: 0 }).state, happy.attackMs + 200).state,
  { ...happy, holdMs: 5000 },
);
ok('★ 「一直保持」（holdMs 0）的层被续期时仍是 0（不许变成有限值）',
  keepForever.reused === true && keepForever.state.layers[0].holdMs === 0,
  `实际 ${keepForever.state.layers[0].holdMs}`);

/*
 * 衰减：保持走完 → 淡出 → 层被摘掉。摘掉与「继续写 0」在画面上一样，但
 * 「她现在有没有情绪」这个问题的答案不一样（面板和开关要读它）。
 */
/*
 * 衰减：保持走完 → 指数尾掉到地板 → 层被摘掉。摘掉与「继续写 0」在画面上一样，
 * 但「她现在有没有情绪」这个问题的答案不一样（面板和开关要读它）。
 *
 * 时长：`hold + τ·ln(1/floor)`（7 秒 τ、0.02 地板 ≈ 27 秒），留 40% 余量。
 */
const tailToFloorMs = Math.ceil(EMOTION_DECAY_MS * Math.log(1 / EMOTION_DECAY_FLOOR) * 1.4);
const decayed = runFrames(setEmotionLayers(createEmotionLayers(), { ...happy, holdMs: 200 }).state,
  happy.attackMs + 200 + tailToFloorMs);
ok('★ 保持 + 淡出走完之后层被摘掉（不是留在表里写 0）',
  decayed.state.layers.length === 0 && decayed.last.values !== undefined
  && Object.keys(decayed.last.values).length === 0,
  `层数 ${decayed.state.layers.length}，values ${JSON.stringify(decayed.last.values)}`);
ok('★ 走过的这一程里，层的结束被如实记下来（不是悄悄不出声地消失）',
  decayed.droppedTotal >= 1, `droppedTotal ${decayed.droppedTotal}`);

const halfRelease = runFrames(setEmotionLayers(createEmotionLayers(), { ...happy, holdMs: 0 }).state,
  happy.attackMs + 100);
const cleared = clearEmotionLayers(halfRelease.state);
ok('清空：把活着的层都推进退场，并报出清了几层',
  cleared.cleared === 1 && cleared.state.layers.length === 1);
const clearFirst = advanceEmotionLayers(cleared.state, 0);
ok('★ 清空也不跳变（权重原地开始化）',
  near(clearFirst.active[0]?.weight ?? -1, halfRelease.last.active[0]?.weight ?? -2, 0.01),
  `${halfRelease.last.active[0]?.weight} → ${clearFirst.active[0]?.weight}`);
const clearHalf = runFrames(cleared.state, EMOTION_CLEAR_FADE_MS / 2);
ok('清空走到一半时权重掉到一半左右',
  (clearHalf.last.active[0]?.weight ?? 1) > 0.3 && (clearHalf.last.active[0]?.weight ?? 1) < 0.7,
  JSON.stringify(clearHalf.last.active));
const clearDone = runFrames(cleared.state, EMOTION_CLEAR_FADE_MS + 60);
ok('清空走完 → 脸上什么都没有了', clearDone.state.layers.length === 0);
ok('★ 「回正」比「换情绪」慢（退场 vs 让位）',
  EMOTION_CLEAR_FADE_MS > EMOTION_SWITCH_FADE_MS,
  `clear ${EMOTION_CLEAR_FADE_MS} / switch ${EMOTION_SWITCH_FADE_MS}`);
ok('淡入淡出的上限是个正数，且不小于两个默认值',
  EMOTION_MAX_FADE_MS > 0 && EMOTION_MAX_FADE_MS >= EMOTION_CLEAR_FADE_MS && EMOTION_MAX_FADE_MS >= EMOTION_SWITCH_FADE_MS);

/*
 * ── ★ #3「按名字收掉某一层」 ──────────────────────────────────────────────
 *
 * 在这之前，「让她脸上少点东西」只有两条路：装一层新的、或者一整把「平静」——
 * 两个都是**全收**。于是「我停下之后收掉思考态」顺手抹掉了我点名让她保持 30 秒的
 * 情绪，一句自动情绪也常常是被下一步的清空剪断的（用户看到的是「她笑了一下就收」，
 * 而日志里一个字都没有）。这一段验的就是那个「只收它」。
 *
 * 夹具为什么是**手搭的两层**：`setEmotionLayers()` 装一层新的会让别的层退场，
 * 所以它造不出「两层都好好在场」的样子 —— 而那正是「只收一层」唯一说得清的场合。
 *
 * ★ `elapsedMs` 必须推过淡入段（`attackMs`）：停在 0 的层权重还是 0，会被
 * `advanceEmotionLayers()` 当成本帧就结束的层直接摘掉 —— 第一版就是那样，
 * 两条断言红在「active 是空的」，看着像「收」坏了，其实是夹具里那两层还没露脸。
 */
const twoLayers = {
  layers: [
    {
      name: THINKING_EMOTION_NAME,
      params: { ParamBrowLY: -0.3 },
      elapsedMs: happy.attackMs,
      holdMs: 0,
      attackMs: happy.attackMs,
      releaseMs: EMOTION_RELEASE_MS,
      fadeAt: null,
      fadeMs: 0,
    },
    {
      name: happy.name,
      params: { ParamEyeLSmile: 0.7 },
      elapsedMs: happy.attackMs,
      holdMs: 0,
      attackMs: happy.attackMs,
      releaseMs: EMOTION_RELEASE_MS,
      fadeAt: null,
      fadeMs: 0,
    },
  ],
  active: [],
};
const thinkingRelease = releaseEmotionLayers(twoLayers, [THINKING_EMOTION_NAME]);
ok('★ 按名字收：点到的层开始退场，并报出收了哪一层',
  thinkingRelease.released.join('、') === THINKING_EMOTION_NAME && thinkingRelease.unknown.length === 0,
  JSON.stringify({ released: thinkingRelease.released, unknown: thinkingRelease.unknown }));
const untouchedLayer = thinkingRelease.state.layers.filter((item) => item.name === happy.name)[0];
ok('★★ 没被点到的层**一个字节都没动**（这就是「只收它」的全部意义）',
  JSON.stringify(untouchedLayer) === JSON.stringify(twoLayers.layers[1]),
  JSON.stringify(untouchedLayer));
const releasedFrames = runFrames(thinkingRelease.state, EMOTION_CLEAR_FADE_MS + 60);
ok('★ 收完那一层之后，她脸上剩下的是另一层（不是一张空脸）',
  releasedFrames.state.layers.length === 1
  && releasedFrames.state.layers[0].name === happy.name
  && Object.keys(releasedFrames.last.values).includes('ParamEyeLSmile')
  && !Object.keys(releasedFrames.last.values).includes('ParamBrowLY'),
  JSON.stringify({ layers: releasedFrames.state.layers.map((l) => l.name), values: releasedFrames.last.values }));
const releaseStart = advanceEmotionLayers(thinkingRelease.state, 0);
ok('★ 收也不跳变（权重从当前值开始化，不是直接消失）',
  near(releaseStart.active.find((l) => l.name === THINKING_EMOTION_NAME)?.weight ?? -1, 1, 0.02),
  JSON.stringify(releaseStart.active));
ok('★ 收一个当时不在场的层不算错，但要点名（`unknown` 是我在 `live2d_status` 想区分的）',
  releaseEmotionLayers(twoLayers, ['绝望']).released.length === 0
  && releaseEmotionLayers(twoLayers, ['绝望']).unknown.join('、') === '绝望');
ok('已经在化掉的同一层再收一次：既不重来也不算「不在场」（没有可收的层）',
  releaseEmotionLayers(thinkingRelease.state, [THINKING_EMOTION_NAME]).released.length === 0
  && releaseEmotionLayers(thinkingRelease.state, [THINKING_EMOTION_NAME]).unknown.length === 0);
ok('坏输入不崩也不误伤：null / 空数组 / 全空白 / 非字符串',
  releaseEmotionLayers(null, [happy.name]).released.length === 0
  && releaseEmotionLayers(twoLayers, []).state.layers.length === 2
  && releaseEmotionLayers(twoLayers, ['   ']).state.layers.length === 2
  && releaseEmotionLayers(twoLayers, [42, null]).state.layers.length === 2);
ok('单个名字（不是数组）也收得掉 —— 调用方不必先包一层',
  releaseEmotionLayers(twoLayers, happy.name).released.join('、') === happy.name);
ok('★ 正在化掉的层被同名的下一条**救回来**（不撤退场因子，她会化到一半停在那里）',
  (() => {
    const revived = setEmotionLayers(releaseEmotionLayers(twoLayers, [happy.name]).state, happy);
    return revived.reused === true
      && revived.state.layers.filter((l) => l.name === happy.name)[0].fadeAt === null;
  })());

/* 面板与诊断读的那句话。 */
ok('一句话说清脸上是什么：单层给名字',
  describeEmotionLayers(full.last.state) === happy.name,
  `实际「${describeEmotionLayers(full.last.state)}」`);
const crossDescribe = describeEmotionLayers(crossFrame.state);
ok('★ 交叉淡出期间两层都写出来（单值答案是假的）',
  crossDescribe.includes(happy.name) && crossDescribe.includes(sad.name) && crossDescribe.includes('+'),
  crossDescribe);
ok('权重大的写在前面',
  crossDescribe.indexOf(happy.name) < crossDescribe.indexOf(sad.name), crossDescribe);
ok('空脸上是空串（不是「undefined」/「null」）',
  describeEmotionLayers(createEmotionLayers()) === ''
  && describeEmotionLayers(null) === ''
  && describeEmotionLayers(undefined) === '');

/* 数值稳健性：delta 是每帧来的，来源（rAF 时间戳）不可信。 */
const weird = advanceEmotionLayers(full.state, NaN);
ok('delta 是 NaN / 负数时当作 0（不许把层的寿命搞坏）',
  weird.state.layers[0].elapsedMs === full.state.layers[0].elapsedMs,
  `${full.state.layers[0].elapsedMs} → ${weird.state.layers[0].elapsedMs}`);
ok('delta 是负数时同样不动', advanceEmotionLayers(full.state, -1000).state.layers[0].elapsedMs === full.state.layers[0].elapsedMs);
ok('state 是 null / undefined 时不崩（渲染端第一帧可能什么都没有）',
  advanceEmotionLayers(null, 16).state.layers.length === 0
  && advanceEmotionLayers(undefined, 16).values !== undefined);

/* 长跑：任何一帧的权重都在 [0,1]，且层数不会无限涨。 */
let stressState = createEmotionLayers();
const names = emotions.emotionNames();
let outOfRange = 0;
let maxLayers = 0;
for (let i = 0; i < 4000; i += 1) {
  if (i % 37 === 0) {
    const picked = resolveEmotion(names[i % names.length], { parameters: WIDE_TABLE, intensity: 1 }).emotion;
    stressState = setEmotionLayers(stressState, picked).state;
  }
  const frame = advanceEmotionLayers(stressState, 16);
  stressState = frame.state;
  maxLayers = Math.max(maxLayers, stressState.layers.length);
  if (frame.active.some((item) => !(item.weight >= 0 && item.weight <= 1))) outOfRange += 1;
  if (Object.values(frame.values).some((value) => !Number.isFinite(value))) outOfRange += 1;
}
ok('★ 长跑 4000 帧：权重恒在 [0,1]、写入值恒为有限数', outOfRange === 0, `${outOfRange} 帧越界`);
ok('★ 长跑：层数有界（不会越攒越多 —— 叠 9 种情绪 × 4000 帧）',
  maxLayers <= 4, `峰值 ${maxLayers} 层`);

/* ───────────────── [2] mood：回合级状态机 ───────────────── */

section('[2] 状态：思考态、情绪接管、说完了回正');

const idle = createMood();
ok('初始是闲着', idle.state === MOOD_IDLE && idle.turnId === '' && idle.thinkingPushed === false);
ok('四种状态都在 MOOD_STATES 里', MOOD_STATES.length === 4 && MOOD_STATES.includes(MOOD_SETTLING));

const started = moodOnTurnStart(idle, { now: 1000, turnId: 'turn-1' });
ok('★ 回合开始 → 状态变成「思考中」', started.mood.state === MOOD_THINKING, started.mood.state);
ok('★ 回合开始 → 要推一条思考态（这就是「她一直在处理」的那条）',
  started.emotion !== null && started.emotion.name === THINKING_EMOTION_NAME,
  JSON.stringify(started.emotion));
ok('思考态的强度被压低（不许和真实情绪一样重）',
  started.emotion.intensity === THINKING_INTENSITY && THINKING_INTENSITY < 0.85,
  `思考 ${THINKING_INTENSITY}`);
ok('思考态的三段时长就是这里配的那三个',
  started.emotion.holdMs === THINKING_HOLD_MS
  && started.emotion.attackMs === THINKING_ATTACK_MS
  && started.emotion.releaseMs === THINKING_RELEASE_MS);
ok('回合号被记下来（诊断要看它是哪一轮）', started.mood.turnId === 'turn-1');

/*
 * ★ 一个回合里已经推过情绪 → 脸归那条情绪管。
 * 然后**走完一步时什么都不推** —— `end` 帧是按步来的（一个回合里几十步），
 * 逐步清脸会把我点名让她保持 30 秒的情绪、和每一句自动情绪都抹掉。
 */
const reacting = moodOnEmotion(started.mood, { now: 2000, name: '开心' });
ok('★ 推过情绪之后状态是「情绪中」', reacting.mood.state === MOOD_REACTING);
const endedAfterEmotion = moodOnTurnEnd(reacting.mood, { now: 3000 });
ok('★ 走完一步时**不推任何东西**（`clear` 这个字段已经不在了）',
  endedAfterEmotion.clear === undefined && !('clear' in endedAfterEmotion),
  JSON.stringify(endedAfterEmotion));
ok('回合结束后状态是「说完了」', endedAfterEmotion.mood.state === MOOD_SETTLING);
ok('回合结束后不再记得回合号', endedAfterEmotion.mood.turnId === '');

const endedPushed = moodOnTurnEnd({ ...started.mood, thinkingPushed: true }, { now: 3000 });
ok('★ 「思考态可能还挂着」这件事被带过 `end`（收它的时机在 8 秒后的那一次读）',
  endedPushed.mood.thinkingPushed === true);

const endedThinking = moodOnTurnEnd(started.mood, { now: 3000 });
ok('这一步走完了，理由写在 detail 里（而且明说收思考态不在这里做）',
  endedThinking.detail.includes('这一步走完了') && endedThinking.detail.includes('等说完'),
  endedThinking.detail);

const doubleEnd = moodOnTurnEnd(endedThinking.mood, { now: 4000 });
ok('连着两次 `end` 只是把「说完了」的时间往后挪，不重复推任何东西',
  doubleEnd.mood.state === MOOD_SETTLING && doubleEnd.mood.thinkingPushed === false);

/*
 * ★ 上一个回合没收到 `end`（实测里会出现：会话被切走）时的两条路：
 *   · 那条思考态**真的推上去了**（`thinkingPushed`）→ 不许重复推，因为同名的层
 *     会被复用（保持时间续上），推第二次只是白占一个队列位；
 *   · 上一次**没推成功**（模型没这个角色、队列满、清单没到）→ 下一个回合必须
 *     重试，否则一次失败会让她整个进程都不再有思考态。
 *
 * 所以这个标记由**推成功的那一刻**来置（`lib/index.js`），不是状态机自己猜 ——
 * 状态机不知道推没推成功，它只负责「说不说」。
 */
ok('★ 状态机自己不置「推过」标记（推没推成功只有调用方知道）',
  started.mood.thinkingPushed === false,
  JSON.stringify(started.mood));

const takeover = moodOnTurnStart({ ...started.mood, thinkingPushed: true }, { now: 5000, turnId: 'turn-2' });
ok('★ 上回合没结束、思考态确实挂着：不重复推',
  takeover.emotion === null && takeover.mood.state === MOOD_THINKING,
  JSON.stringify({ emotion: takeover.emotion, state: takeover.mood.state }));
ok('不重复推的理由写在 detail 里', takeover.detail.includes('还挂着'), takeover.detail);

const retried = moodOnTurnStart({ ...started.mood, thinkingPushed: false }, { now: 6000, turnId: 'turn-3' });
ok('★ 上一次思考态没推成功时，下一个回合要重试',
  retried.emotion !== null, JSON.stringify(retried.emotion));

/*
 * `canThink: false` 的三种情况（开关关了 / 能力清单没到 / 显式情绪刚下过 /
 * 队列里压着两条自动情绪）：**不推东西，状态也不写「思考中」**。
 *
 * 这一条守的是一个很贵的错误：如果照样写 `thinking`，那么 8 秒后那一次读到期的
 * 转移会以为脸上挂着一条思考态，于是按名字去收一个空 —— 白占一个队列位，
 * 而且日志里会多一句「收掉了一个不存在的东西」。
 */
const muted = moodOnTurnStart(idle, { now: 7000, turnId: 'turn-4', canThink: false });
ok('★ `canThink: false` 时不推东西，状态也不写「思考中」',
  muted.emotion === null && muted.mood.state === MOOD_IDLE,
  JSON.stringify({ emotion: muted.emotion, state: muted.mood.state }));
ok('★ 也因此：8 秒后到期时不会去收一个空（`thinkingPushed` 是假的）',
  (() => {
    const ended = moodOnTurnEnd(muted.mood, { now: 7500 });
    const advanced = advanceMood(ended.mood, { now: 7500 + MOOD_SETTLING_MS });
    return advanced.changed === true && advanced.release.length === 0;
  })());
ok('但回合号照样记下来（诊断要知道「现在是这一轮」）', muted.mood.turnId === 'turn-4');
ok('不推的理由写在 detail 里', muted.detail.includes('不推'), muted.detail);

const backToIdle = moodToIdle(endedThinking.mood, { now: 8000 });
ok('回到闲着：状态、回合号、已推标记一起复位',
  backToIdle.mood.state === MOOD_IDLE && backToIdle.mood.turnId === '' && backToIdle.mood.thinkingPushed === false);
ok('从「说完了」回到闲着时会给一句理由（从哪个状态来的）',
  backToIdle.detail.includes(MOOD_SETTLING), backToIdle.detail);

/* 纯函数 + 坏输入：这个模块跑在事件回调里，抛异常 = 整条流式链断掉。 */
ok('不传 options 不崩', moodOnTurnStart(idle).mood.state === MOOD_THINKING);
ok('传 null / undefined 不崩',
  moodOnTurnStart(null, { now: 1 }).emotion !== null
  && moodOnEmotion(undefined, { now: 1 }).mood.state === MOOD_REACTING
  && moodOnTurnEnd(null, { now: 1 }).mood.state === MOOD_SETTLING
  && moodToIdle(null).mood.state === MOOD_IDLE);
ok('时间不是数字时按 0 记（不许把 NaN 写进状态）',
  moodOnTurnStart(idle, { now: NaN }).mood.since === 0
  && moodOnTurnStart(idle, {}).mood.since === 0);

const descriptions = MOOD_STATES.map((state) => describeMood({ state, since: 0, turnId: '', thinkingPushed: false }));
ok('四种状态各有一句话，互不相同',
  new Set(descriptions).size === 4, descriptions.join(' / '));
ok('四句话里没有 undefined / null / NaN',
  descriptions.every((text) => !/undefined|null|NaN/.test(text)), descriptions.join(' / '));
ok('未知状态会如实说「未知」而不是崩或说空话',
  describeMood({ state: '???', since: 0, turnId: '', thinkingPushed: false }).includes('未知'));
ok('describeMood 对 null 也不崩', typeof describeMood(null) === 'string' && describeMood(null) !== '');

/*
 * ── 过期：状态机里唯一一条与时间有关的转移（`advanceMood`）──
 *
 * 这一段出自一个具体的现场：离开一晚之后回来问「她怎么样了」，`/status.mood.state`
 * 还写着 `settling`、`description` 还写着「脸上的东西正在自己化掉」—— 而她脸上
 * 早就什么都没有了。**过期不是措辞问题，是状态问题**：那个 state 字段是给机器读的，
 * 一个心里想着「闲着」、嘴上说着 `settling` 的字段，比一句过期的中文更容易骗到
 * 下一轮读它的代码。所以修的是状态本身，`describeMood` 一个字都没改。
 */
const settledPlain = moodOnTurnEnd(
  moodOnEmotion(moodOnTurnStart(idle, { now: 1000, turnId: 't-settle' }).mood, { now: 1500, name: '开心' }).mood,
  { now: 9000 },
).mood;
ok('夹具确实停在「说完了」', settledPlain.state === MOOD_SETTLING, settledPlain.state);

ok('★ 「说完了」有有效期，而且盖得住「脸上最后一点东西化掉」的时间',
  Number.isFinite(MOOD_SETTLING_MS) && MOOD_SETTLING_MS > 0
  && MOOD_SETTLING_MS >= STREAM_HOLD_MAX_MS + EMOTION_RELEASE_MS,
  `MOOD_SETTLING_MS=${MOOD_SETTLING_MS} vs ${STREAM_HOLD_MAX_MS}+${EMOTION_RELEASE_MS}`);

ok('有效期之内不动它（刚说完那几秒，「说完了」是真实的现场）',
  advanceMood(settledPlain, { now: settledPlain.since + 1000 }).changed === false);

ok('★ 超过有效期之后状态自己回到闲着（改写的是状态，不是只换措辞）',
  (() => {
    const advanced = advanceMood(settledPlain, { now: settledPlain.since + MOOD_SETTLING_MS });
    return advanced.changed === true
      && advanced.mood.state === MOOD_IDLE
      && advanced.mood.turnId === ''
      && advanced.mood.thinkingPushed === false;
  })(),
  JSON.stringify(advanceMood(settledPlain, { now: settledPlain.since + MOOD_SETTLING_MS }).mood));

ok('回到闲着时给一句理由，说清刚才那句是多久以前说的',
  (() => {
    const advanced = advanceMood(settledPlain, { now: settledPlain.since + MOOD_SETTLING_MS * 3 });
    return advanced.detail.includes('回到闲着') && advanced.detail.includes('秒');
  })(),
  advanceMood(settledPlain, { now: settledPlain.since + MOOD_SETTLING_MS * 3 }).detail);

ok('中文也跟着变（诊断面与 live2d_status 读的是 description）',
  describeMood(advanceMood(settledPlain, { now: settledPlain.since + MOOD_SETTLING_MS }).mood)
  === describeMood({ state: MOOD_IDLE, since: 0, turnId: '', thinkingPushed: false }));

ok('★ 只推进「说完了」：思考中 / 情绪中 / 闲着都不许被它改掉',
  advanceMood({ state: MOOD_THINKING, since: 0, turnId: 't', thinkingPushed: true }, { now: 1e12 }).changed === false
  && advanceMood({ state: MOOD_REACTING, since: 0, turnId: 't', thinkingPushed: false }, { now: 1e12 }).changed === false
  && advanceMood({ state: MOOD_IDLE, since: 0, turnId: '', thinkingPushed: false }, { now: 1e12 }).changed === false);

ok('没到点时不换对象（一小时被读 720 次，只是看了 720 次同一份状态）',
  advanceMood(settledPlain, { now: settledPlain.since }).mood === settledPlain);

/*
 * ★ 这条转移的**第二个职责**：它是全项目唯一一个收思考态的时机（「每一步结束时
 * 收」已经改掉了 —— `end` 是按步来的，逐步收会连着别的东西一起抹）。所以它必须
 * 说清楚收**哪一个名字**，而不是要求调用方去清空：这 8 秒里挂上来的真实情绪
 * 该继续按自己的节奏化掉。
 */
ok('★ 到期那一刻报出「该按名字收掉的层」= 思考态',
  (() => {
    const ended = moodOnTurnEnd({ ...started.mood, thinkingPushed: true }, { now: 2000 });
    const advanced = advanceMood(ended.mood, { now: 2000 + MOOD_SETTLING_MS });
    return advanced.changed === true
      && advanced.release.length === 1
      && advanced.release[0] === THINKING_EMOTION_NAME;
  })(),
  JSON.stringify(advanceMood(endedPushed.mood, { now: endedPushed.mood.since + MOOD_SETTLING_MS }).release));
ok('★ 没推过思考态时不给 `release`（不推一条「收掉一个不存在的东西」）',
  advanceMood(settledPlain, { now: settledPlain.since + MOOD_SETTLING_MS }).release.length === 0,
  JSON.stringify(advanceMood(settledPlain, { now: settledPlain.since + MOOD_SETTLING_MS }).release));
ok('没到点时 `release` 也是空表（调用方可以无条件读它）',
  advanceMood(settledPlain, { now: settledPlain.since + 1000 }).release.length === 0
  && advanceMood(null).release.length === 0);

ok('坏输入不崩：null / 不传 now / NaN 都按「不动」处理',
  advanceMood(null).changed === false
  && advanceMood(undefined, {}).changed === false
  && advanceMood(settledPlain, { now: NaN }).changed === false);

/* ───────────────── [3] 跨模块：思考态必须真的能用 ───────────────── */

section('[3] 思考态 × 真实词汇表 × 真实模型范围');

/*
 * ★ 这一节守的是一条**只在运行时才会炸**的接缝：`mood.js` 里那个
 * `THINKING_EMOTION_NAME = '思考'` 是硬编码的字符串，而情绪词汇表住在
 * `emotions.js`。有人改名字（或者哪天把「思考」从词汇表里删掉）时，
 * 两个模块各自都自洽，只有她的脸会开始收到 `E_EMOTION_UNKNOWN`。
 */
ok('★ 思考态用的名字真的在情绪词汇表里',
  canonicalEmotionName(THINKING_EMOTION_NAME) === THINKING_EMOTION_NAME,
  `canonicalEmotionName('${THINKING_EMOTION_NAME}') = ${canonicalEmotionName(THINKING_EMOTION_NAME)}`);
ok('★ `thinkingEmotion()` 给出的四个字段与常量一致',
  JSON.stringify(thinkingEmotion()) === JSON.stringify({
    name: THINKING_EMOTION_NAME,
    intensity: THINKING_INTENSITY,
    holdMs: THINKING_HOLD_MS,
    attackMs: THINKING_ATTACK_MS,
    releaseMs: THINKING_RELEASE_MS,
  }), JSON.stringify(thinkingEmotion()));

const Core = createCore(CORE_PATH);
const coreInfo = await waitForCore(Core);
console.log(`    Core 版本 0x${coreInfo.version.toString(16)}（初始化 ${coreInfo.elapsedMs}ms）`);

/** 从 moc3 枚举参数范围（照 `test-emotions.mjs` 的写法，坑也一样）。 */
function enumerateParameters(mocPath) {
  const buffer = readFileSync(mocPath);
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const model = Core.Model.fromMoc(Core.Moc.fromArrayBuffer(ab));
  const params = model.parameters;
  const out = [];
  for (let index = 0; index < params.count; index += 1) {
    out.push({
      id: String(params.ids[index]),
      min: params.minimumValues[index],
      max: params.maximumValues[index],
      def: params.defaultValues[index],
    });
  }
  model.release();
  return out;
}

const HIYORI = enumerateParameters(HIYORI_MOC);
const thinkingOnHiyori = resolveEmotion(THINKING_EMOTION_NAME, {
  parameters: HIYORI,
  intensity: THINKING_INTENSITY,
  holdMs: THINKING_HOLD_MS,
  attackMs: THINKING_ATTACK_MS,
  releaseMs: THINKING_RELEASE_MS,
});
ok('★ 思考态在 hiyori 上真的解析出了参数（不是「这个模型没有对应参数」）',
  thinkingOnHiyori.ok && Object.keys(thinkingOnHiyori.emotion.params).length > 0,
  `${thinkingOnHiyori.code} ${thinkingOnHiyori.detail}`);
const hiyoriRange = new Map(HIYORI.map((item) => [item.id, item]));
const thinkingOutOfRange = Object.keys(thinkingOnHiyori.emotion.params)
  .filter((id) => {
    const info = hiyoriRange.get(id);
    if (info === undefined) return true;
    const target = info.def + thinkingOnHiyori.emotion.params[id];
    return target < info.min - 1e-6 || target > info.max + 1e-6;
  });
ok('★ 思考态在 hiyori 的真实范围里一个都不越界（不许被静默夹取）',
  thinkingOutOfRange.length === 0, thinkingOutOfRange.join(' / '));
ok('★ 思考态的兜底保持时间**不超过情绪层的上限**（写 45000、实际被夹到 30000 就是个谎）',
  THINKING_HOLD_MS <= EMOTION_MAX_HOLD_MS,
  `思考 ${THINKING_HOLD_MS}ms / 情绪层上限 ${EMOTION_MAX_HOLD_MS}ms`);
ok('★ 也因此：思考态原样穿过 `resolveEmotion()`，一次都没被夹取',
  resolveEmotion(THINKING_EMOTION_NAME, {
    parameters: HIYORI,
    intensity: THINKING_INTENSITY,
    holdMs: THINKING_HOLD_MS,
    attackMs: THINKING_ATTACK_MS,
    releaseMs: THINKING_RELEASE_MS,
  }).emotion.holdMs === THINKING_HOLD_MS,
  '这一条是 simulate-host-boot 抓出来的：`mood.js` 原本写 45000，队列里却是 30000');

ok('★ 思考态走的是**同一条** emotion 通道（词汇表里有它），不是一条平行通道',
  canonicalEmotionName(THINKING_EMOTION_NAME) === THINKING_EMOTION_NAME);
/*
 * ★ 思考态是**持续态**，按句猜出来的情绪是**反应**。两者共用一个词汇表与一条
 * 通道，唯一把它们分开的就是时间尺度：一条猜出来的情绪最长 5 秒，思考态要
 * 挂到回合结束（45 秒兜底）。如果哪天有人把 `THINKING_HOLD_MS` 调到和它们
 * 一个量级，思考态就会被下一句话顶掉，「她一直在处理」这件事就没了。
 */
ok('★ 思考态比任何按句猜出来的情绪长一个量级（持续态 vs 反应）',
  THINKING_HOLD_MS >= STREAM_HOLD_MAX_MS * 5,
  `思考 ${THINKING_HOLD_MS}ms / 猜出来的上限 ${STREAM_HOLD_MAX_MS}ms`);
ok('★ 思考态的强度比猜出来的情绪更低（它是底噪，不许抢戏）',
  THINKING_INTENSITY < STREAM_EMOTION_INTENSITY,
  `思考 ${THINKING_INTENSITY} / 自动情绪 ${STREAM_EMOTION_INTENSITY}`);
ok('（信息）关键词表里也有「思考」的词：一句「让我想想」同样能触发它 —— 两条路不冲突，'
  + '差别只在寿命（一个 5 秒，一个到回合结束）',
  Object.prototype.hasOwnProperty.call(EMOTION_KEYWORDS, THINKING_EMOTION_NAME),
  Object.keys(EMOTION_KEYWORDS).join(' / '));

/* 攻击/释放可以逐次指定 —— 思考态用 420ms 的慢淡入。 */
const customFade = resolveEmotion('开心', {
  parameters: WIDE_TABLE,
  attackMs: THINKING_ATTACK_MS,
  releaseMs: 1234,
});
ok('★ `resolveEmotion` 接受逐次的淡入/淡出（D 期加的）',
  customFade.emotion.attackMs === THINKING_ATTACK_MS && customFade.emotion.releaseMs === 1234,
  JSON.stringify({ a: customFade.emotion.attackMs, r: customFade.emotion.releaseMs }));
ok('★ 逐次指定也要夹到上限（不许把她的脸慢成幻灯片）',
  resolveEmotion('开心', { parameters: WIDE_TABLE, attackMs: 999999 }).emotion.attackMs === EMOTION_MAX_FADE_MS
  && resolveEmotion('开心', { parameters: WIDE_TABLE, releaseMs: -5 }).emotion.releaseMs === 0);
ok('★ 实际用的淡入淡出要写进 detail（脸上发生的事正文里必须读得到）',
  customFade.detail.includes(`${THINKING_ATTACK_MS}ms 淡入`) && customFade.detail.includes('1234ms 淡出'),
  customFade.detail);

/* ───────────────── [4] 接线（源码级） ───────────────── */

section('[4] 接线：Host 三个回合转移点 + 一条过期转移 + 渲染端用状态机');

const hostSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/index.js'), 'utf8'));
const actionsSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/host/actions.js'), 'utf8'));
const modelSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/pet-model.ts'), 'utf8'));
const moodSource = readFileSync(resolve(PACKAGE, 'lib/host/mood.js'), 'utf8');
const emotionsSource = readFileSync(resolve(PACKAGE, 'lib/host/emotions.js'), 'utf8');

ok('★ `mood.js` 与 `emotions.js` 都是零 import 的纯模块（门禁能直接跑它们）',
  !/^\s*import\s/m.test(moodSource) && !/^\s*import\s/m.test(emotionsSource));
ok('host：导入了 mood 的那五个函数',
  /from '\.\/host\/mood\.js'/.test(hostSource)
  && /createMood/.test(hostSource)
  && /moodOnTurnStart/.test(hostSource)
  && /moodOnEmotion/.test(hostSource)
  && /moodOnTurnEnd/.test(hostSource));
ok('host：订阅的还是那个事件名（`agent/assistant-stream`）',
  /ctx\.on\('agent\/assistant-stream'/.test(hostSource));
ok('★ host：`start` 帧推思考态', /moodOnTurnStart\(/.test(hostSource) && /pushMoodEmotion\(/.test(hostSource));
ok('★ host：`end` 帧**只翻状态、不动脸**（收思考态挪到了 8 秒后的那一次读）',
  /moodOnTurnEnd\(/.test(hostSource)
  && /applyMood\(ended, ended\.detail\)/.test(hostSource)
  && !/ended\.clear/.test(hostSource));
ok('★ host：`end` 帧不再推「平静」（一把全清会抹掉刚挂上来的情绪）',
  !/name: '平静'/.test(hostSource));
ok('★ host：思考态是**按名字**收的（`release`，只收它那一层）',
  /pushMoodRelease/.test(hostSource)
  && /kind: 'emotion', release: names/.test(hostSource)
  && /pushMoodRelease\(advanced\.release\)/.test(hostSource));
ok('host：显式情绪也翻状态（`live2d_emote` 走 moodApi）',
  /onExplicitEmotion/.test(hostSource) && /moodApi\.onExplicitEmotion\(/.test(hostSource));
ok('host：`registerTools` 真的收到了那个把手（形参与调用点都在）',
  // 形参后面可能还跟着别的把手（`microApi`，§13.30），所以只要求 `moodApi` 出现在参数表里。
  /function registerTools\([^)]*moodApi(?:[,)])/.test(hostSource)
  && /registerTools\(ctx, state, modelsRoot, pushCommand, \(\) => capabilities, cfg, \{/.test(hostSource));
ok('host：思考态的推送单独计数（`moodPushes`，与「跟着话动」分开记）',
  /moodPushes: 0/.test(hostSource) && /streamStats\.moodPushes \+= 1/.test(hostSource));
ok('host：状态写进 `state`（`/status` 与 `live2d_status` 都能读到）',
  /state\.mood = \{/.test(hostSource));
ok('host：`live2d_status` 的正文里带这一句', /moodText/.test(hostSource));
ok('host：思考态的推送受队列配额保护（与自动情绪同一个上限）',
  /queuedAuto < MAX_QUEUED_AUTO_EMOTIONS/.test(hostSource));
ok('★ host：思考态是「真的推上去了」才置标记（推失败下一个回合要能重试）',
  /if \(pushed\) applyMood\(/.test(hostSource) && /thinkingPushed: true/.test(hostSource),
  '`pushMoodEmotion()` 的返回值没有被用来置 `thinkingPushed`');
ok('host：显式情绪的静默期对思考态同样有效（`emotionMuteUntil` 也拦住它）',
  /now >= \(state\.emotionMuteUntil \?\? 0\)/.test(hostSource));

/*
 * ★ 「过期」这条转移必须真的接在两个读点上 —— 纯函数写对了但没人调，
 * 是这一整类缺陷里最安静的一种（门禁全绿、现场照旧说谎）。
 */
ok('★ host：`refreshMood()` 存在，而且只在真的变了时才写回状态（顺手收思考态）',
  /const refreshMood = \(\) => \{/.test(hostSource)
  && /advanceMood\(mood, \{ now: Date\.now\(\) \}\)/.test(hostSource)
  && /if \(advanced\.changed\)/.test(hostSource)
  && /applyMood\(advanced, advanced\.detail\)/.test(hostSource)
  && /pushMoodRelease\(advanced\.release\)/.test(hostSource));
ok('★ host：心跳读点推了一次（`/status`），而且就在把状态送出去之前',
  (hostSource.match(/refreshMood\(\);/g) ?? []).length === 1
  && /refreshMood\(\);\s*return sendJson\(res, 200, \{ ok: true, \.\.\.state \}\);/.test(hostSource),
  `refreshMood(); 出现 ${(hostSource.match(/refreshMood\(\);/g) ?? []).length} 次`);
ok('★ host：`live2d_status` 那个读点走把手（它在 `registerTools()` 里，看不见 `apply()` 的局部函数）',
  /refresh: \(\) => refreshMood\(\)/.test(hostSource)
  && /typeof moodApi\?\.refresh === 'function'\) moodApi\.refresh\(\);/.test(hostSource),
  '直接调 refreshMood() 会是一个只有真跑才暴露的 ReferenceError');
ok('★ host：`live2d_status` 里那一次在拼 `moodText` **之前**',
  (() => {
    const call = hostSource.indexOf('moodApi.refresh();', hostSource.indexOf('const clientReportText'));
    const read = hostSource.indexOf('const moodText');
    return call !== -1 && read !== -1 && call < read;
  })(), '推得太晚 = 读到的还是上一拍的旧状态');

ok('actions：把 attackMs / releaseMs 转发给 `resolveEmotion`（不再写死默认值）',
  /attackMs: raw\?\.attackMs/.test(actionsSource) && /releaseMs: raw\?\.releaseMs/.test(actionsSource));

ok('pet-model：六个状态机函数都用上了',
  /createEmotionLayers\(\)/.test(modelSource)
  && /setEmotionLayers\(/.test(modelSource)
  && /advanceEmotionLayers\(/.test(modelSource)
  && /clearEmotionLayers\(/.test(modelSource)
  && /releaseEmotionLayers\(/.test(modelSource)
  && /describeEmotionLayers\(/.test(modelSource));
ok('★ pet-model：旧的单层字段没有残留（`_emotion` 与 `_emotions` 混用 = 有一半代码在写一个没人读的字段）',
  !/_emotion\s*=\s*null/.test(modelSource) && !/_emotion\s*:\s*\{/.test(modelSource));
ok('pet-model：`setEmotion()` 支持逐次 fadeMs（换情绪与回正用不同的速度）',
  /fadeMs\?: number/.test(modelSource) && /EMOTION_SWITCH_FADE_MS/.test(modelSource));
ok('pet-model：`clearEmotion()` 走的是「化掉」那条路（不是直接置空）',
  /clearEmotionLayers\(this\._emotions/.test(modelSource));
ok('★ pet-model：`releaseEmotion()` 真的用上了按名字收的那条路（只收指定的层）',
  /releaseEmotionLayers\(this\._emotions/.test(modelSource)
  && /public releaseEmotion\(names: string\[\]\)/.test(modelSource));
ok('★ runner：`emotion` 指令支持「只收」这一形态（它没有名字也没有参数）',
  /target\.releaseEmotion\(release\)/.test(
    stripComments(readFileSync(resolve(PACKAGE, 'src/client/action-runner.ts'), 'utf8')),
  ));
ok('★ actions：`release` 是一等输入（还带名字校验，收一层也要求名字对得上）',
  /canonicalEmotionName\(asked\)/.test(actionsSource)
  && /release: releaseNames/.test(actionsSource));

/* ───────────────── [5] 反证 ───────────────── */

section('[5] 反证：把实现改坏，上面的判据必须变红');

const reversed = [];

// 反证 1：`end` 帧不再收思考态（她的脸会一直皱着）—— 接线断言必须变红。
const noEnd = hostSource.replace(/moodOnTurnEnd\(/g, 'notMoodOnTurnEnd(');
if (noEnd === hostSource) reversed.push('反证 1 没能改动源码（找不到 moodOnTurnEnd）');
else if (/moodOnTurnEnd\(/.test(noEnd)) reversed.push('反证 1 之后仍存在 moodOnTurnEnd');

// 反证 2：思考态改用词汇表里没有的名字 —— 跨模块那条断言必须变红。
const badName = moodSource.replace(/THINKING_EMOTION_NAME = '思考'/, "THINKING_EMOTION_NAME = '沉思'");
if (badName === moodSource) reversed.push('反证 2 没能改动源码（找不到 THINKING_EMOTION_NAME）');
else {
  const stolen = badName.match(/THINKING_EMOTION_NAME = '([^']+)'/)?.[1] ?? '';
  if (canonicalEmotionName(stolen) !== null) reversed.push(`反证 2 的名字「${stolen}」居然也在词汇表里`);
}

// 反证 3：到期时**不看有没有推过**，一律要求收一层 —— 「没推过就不给 release」必须变红。
// 与反证 6 同一手法：把**改过的源码**真的 import 回来跑一遍（磁盘一个字节都不动）。
const alwaysRelease = moodSource.replace(
  'const release = current.thinkingPushed === true ? [THINKING_EMOTION_NAME] : [];',
  'const release = [THINKING_EMOTION_NAME];',
);
if (alwaysRelease === moodSource) reversed.push('反证 3 没能改动源码（找不到 release 那一行）');
else {
  const mutated = await import(`data:text/javascript;base64,${Buffer.from(alwaysRelease).toString('base64')}#cp3`);
  const wrong = mutated.advanceMood(settledPlain, { now: settledPlain.since + MOOD_SETTLING_MS });
  if (!(wrong.release.length > 0)) reversed.push('反证 3 之后「没推过也照样要求收」居然没发生');
}

// 反证 4：把「回正」调得比「换情绪」快 —— 顺序断言必须变红。
const fastClear = emotionsSource.replace(/EMOTION_CLEAR_FADE_MS = (\d+)/, 'EMOTION_CLEAR_FADE_MS = 100');
if (fastClear === emotionsSource) reversed.push('反证 4 没能改动源码（找不到 EMOTION_CLEAR_FADE_MS）');
else {
  const stolen = Number(fastClear.match(/EMOTION_CLEAR_FADE_MS = (\d+)/)?.[1] ?? 0);
  if (stolen > EMOTION_SWITCH_FADE_MS) reversed.push('反证 4 改出来的值仍然比 switch 大');
}

// 反证 5：复用阈值降到 0（等于永远复用）—— 复用判据必须变红。
const alwaysReuse = emotionsSource.replace(/EMOTION_REUSE_WEIGHT = [\d.]+/, 'EMOTION_REUSE_WEIGHT = 0');
if (alwaysReuse === emotionsSource) reversed.push('反证 5 没能改动源码（找不到 EMOTION_REUSE_WEIGHT）');
else {
  const stolen = Number(alwaysReuse.match(/EMOTION_REUSE_WEIGHT = ([\d.]+)/)?.[1] ?? -1);
  if (!(fadedWeight >= stolen)) reversed.push('反证 5 之后「已经淡下去的那一层」也会被复用');
}

// 反证 6：抽掉「还没到点就不动」那道闸 —— 有效期那条判据必须变红。
// `mood.js` 零 import，所以这里可以把**改过的源码**真的 import 回来跑一遍
// （文件系统一个字节都不动）：改坏之后的**行为**是被执行过的，不是被假设的。
const noGuard = moodSource.replace(
  "  if (!(now - since >= MOOD_SETTLING_MS)) return { mood: current, changed: false, detail: '', release: [] };\n",
  '',
);
if (noGuard === moodSource) reversed.push('反证 6 没能改动源码（找不到「还没到点就不动」那道闸）');
else {
  const mutated = await import(`data:text/javascript;base64,${Buffer.from(noGuard).toString('base64')}#cp6`);
  const tooEarly = mutated.advanceMood(settledPlain, { now: settledPlain.since + 1000 });
  if (tooEarly.changed !== true) reversed.push('反证 6 之后「刚说完一秒也照样过期」居然没发生');
}

ok('六条反证都能把对应的判据翻过来', reversed.length === 0, reversed.join('；'));
ok('反证没有改动磁盘上的源码',
  readFileSync(resolve(PACKAGE, 'lib/host/mood.js'), 'utf8').includes("THINKING_EMOTION_NAME = '思考'")
  && readFileSync(resolve(PACKAGE, 'lib/host/mood.js'), 'utf8').includes(`MOOD_SETTLING_MS = ${MOOD_SETTLING_MS}`)
  && readFileSync(resolve(PACKAGE, 'lib/host/emotions.js'), 'utf8').includes(`EMOTION_CLEAR_FADE_MS = ${EMOTION_CLEAR_FADE_MS}`));

console.log('');
if (failures === 0) {
  console.log(`[6] MOOD GATE PASSED —— ${checks} 项断言全绿`);
  process.exit(0);
}
console.log(`[6] MOOD GATE FAILED —— ${failures} / ${checks} 项断言变红`);
process.exit(1);
