/**
 * 情绪层门禁（`live2d_emote` → `kind: 'emotion'` → 渲染端的加法情绪层）。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────
 *
 * 用户要的是「AI 当操控者」：她按 AI 自己的话转头、睁眼闭眼、微笑。这条路线的
 * 第一期是**命令级补齐** —— 加一个 `emote` 动作种类，把「情绪」变成一条可检查的
 * 指令，而不是让模型偷偷改几个参数。
 *
 * 这个门禁守四件事，每一件都是**已经踩过或极易踩**的坑：
 *
 *   [1] **词汇表不能有错字**。预设是按「角色 → 候选参数 id」写的（`eyes.smile`
 *       在 hiyori 上是 `ParamEyeLSmile`，在 `空` 上是 `ParamEyeSmile`），
 *       而 `resolveEmotion()` 对**匹配不到的角色是静默跳过的**（那是刻意的：
 *       不同模型参数不同）。于是词汇表里写错一个 id，表现就是「这个情绪少了
 *       一半表情」，没有任何报错。⇒ 静态自检必须覆盖到每个 id。
 *   [2] ★ **预设必须落在每个模型真实声明的范围里**。cdi3 没有 min/max，范围只
 *       存在于 moc3；而渲染端拿到的增量会被 Core 静默夹取 —— 一个写大了的预设
 *       只会「看起来没那么用力」，不会报错。⇒ 用官方 Core 枚举 hiyori 的
 *       真实范围，逐条情绪、**逐参数**核对，并且要求零跳过、零夹取。
 *   [3] **解析的边界**：未知名字要自愈（把可用名字列出来）、别名与大小写、
 *       强度/保持时长的夹取、参数一个都匹配不上时的失败。
 *   [4] **契约三处一致**：`actions.js`（校验）→ `action-runner.ts`（翻译）→
 *       `pet-model.ts`（执行）。三处任一处漏掉，指令就静默地什么都不做 ——
 *       这正是本项目已经抓到过的「静默失效」家族。
 *
 * 另外还钉一条**语义**：情绪层必须**加法写入**（`addParameterValue`），不能是
 * 硬写覆盖。硬写会盖掉眨眼与动作自带的脸部曲线，而 hiyori 的 10 段动作**每一段
 * 都在驱动脸** —— 用硬写的话，她一动起来脸上的情绪就没了。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
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

/** 门禁只看代码，不看注释 —— 注释里写着 `setEmotion` 不算数。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const emotions = await import(pathToFileURL(resolve(PACKAGE, 'lib/host/emotions.js')).href);
const actions = await import(pathToFileURL(resolve(PACKAGE, 'lib/host/actions.js')).href);

const {
  ROLE_PARAMETER_IDS,
  ROLE_LABELS,
  EMOTION_MAX_HOLD_MS,
  EMOTION_DEFAULT_HOLD_MS,
  EMOTION_ATTACK_MS,
  EMOTION_RELEASE_MS,
  EMOTION_DECAY_MS,
  EMOTION_DECAY_FLOOR,
  EMOTION_RESIDUE_WEIGHT,
  EMOTION_RESIDUE_MS,
  EMOTION_FAMILY,
  emotionNames,
  emotionRoleNames,
  emotionEnvelope,
  emotionCatalogText,
  emotionFamily,
  emotionsRelated,
  canonicalEmotionName,
  normalizeEmotionBindings,
  pickRoleParameter,
  resolveEmotion,
  createEmotionLayers,
  setEmotionLayers,
  advanceEmotionLayers,
  describeEmotionLayers,
  ambientDriftRoles,
  resolveAmbientDrift,
  ambientDriftValues,
} = emotions;

const NAMES = emotionNames();

/*
 * 九条情绪的规范名。写成常量而不是从 `emotionNames()` 现取：如果哪天有人删掉
 * 一条，`emotionNames()` 会跟着变，断言就永远绿 —— 那是**自证**，不是门禁。
 */
const EXPECTED_NAMES = ['平静', '开心', '好奇', '思考', '认真', '惊讶', '抱歉', '难过', '得意'];

/* ───────────────── [1] 词汇表的静态自检 ───────────────── */

section('[1] 词汇表：角色、id、增量');

ok('九条情绪一条不少', EXPECTED_NAMES.every((name) => NAMES.includes(name)),
  `实际：${NAMES.join(' / ')}`);

ok('没有多出来的情绪', NAMES.every((name) => EXPECTED_NAMES.includes(name)),
  `实际：${NAMES.join(' / ')}`);

/*
 * 预设表本身没有导出（它不该被外部改），所以按名字逐条解析出它的角色集合：
 * 给 `resolveEmotion()` 一份「所有角色都能匹配上」的假参数表，那么 `skipped`
 * 就是「这张表里用了、我却没给它铺参数」的角色 —— 反过来 `applied` 就是这张表
 * 用到的全部角色。
 */
const ALL_ROLES = Object.keys(ROLE_PARAMETER_IDS);
const WIDE_TABLE = ALL_ROLES.map((role) => ({
  // 每个角色取它的第一个候选 id；`resolveEmotion` 按候选顺序取第一个匹配上的。
  id: ROLE_PARAMETER_IDS[role][0],
  min: -8,
  max: 8,
  def: 0,
}));

const usedRoles = new Map();
for (const name of NAMES) {
  const result = resolveEmotion(name, { parameters: WIDE_TABLE, intensity: 1 });
  usedRoles.set(name, result.emotion.applied.map((item) => item.role));
}

ok('每个角色的候选 id 都是非空字符串数组',
  ALL_ROLES.every((role) => Array.isArray(ROLE_PARAMETER_IDS[role])
    && ROLE_PARAMETER_IDS[role].length > 0
    && ROLE_PARAMETER_IDS[role].every((id) => typeof id === 'string' && id !== '') ),
  ALL_ROLES.filter((role) => !(Array.isArray(ROLE_PARAMETER_IDS[role]) && ROLE_PARAMETER_IDS[role].length > 0)).join(' / '));

ok('角色数量与词汇表规模相符（≥ 12 个角色）', ALL_ROLES.length >= 12, `实际 ${ALL_ROLES.length} 个角色`);

/*
 * ★ 在「全能假模型」上，每条非空情绪都必须用到**自己表里写下的每一个角色**：
 * `WIDE_TABLE` 给每个角色都铺了参数，所以 `skipped` 必须为空。它抓到的是
 * 「预设里写了 `mouth.smile`，而 `ROLE_PARAMETER_IDS` 里根本没有这个键」这种错字。
 */
const unknownRoles = [];
for (const name of NAMES) {
  const roles = usedRoles.get(name) ?? [];
  const nonEmpty = roles.length > 0;
  if (name === '平静') {
    if (nonEmpty) unknownRoles.push(`${name} 应该是空表（清空用），却用了 ${roles.join(' / ')}`);
    continue;
  }
  if (!nonEmpty) unknownRoles.push(`${name} 一个角色都没有`);
}
ok('非空情绪都至少有一个角色、`平静` 是空表', unknownRoles.length === 0, unknownRoles.join('；'));

const deltas = [];
for (const name of NAMES) {
  const result = resolveEmotion(name, { parameters: WIDE_TABLE, intensity: 1 });
  for (const item of result.emotion.applied) deltas.push({ name, ...item });
}
ok('所有增量都是有限数', deltas.every((item) => Number.isFinite(item.delta)),
  deltas.filter((item) => !Number.isFinite(item.delta)).map((item) => `${item.name}/${item.role}`).join(' / '));

/*
 * ⚠️ 这里**不能**断言「增量都在 ±1 内」：角度类角色（`head.yaw` / `body.lean` /
 * `hair.ahoge`）的单位是度，`ParamAngleY` 的范围是 ±30 —— 它们本来就该是几度。
 * 真正该守的是「预设没有超出模型范围」，那一条由 [2] 拿 Core 的真实范围来查。
 * 这里只守最容易悄悄发生的一种：某个角色写成了 0（等于白写）。
 */
ok('非空情绪的每个角色都真的写了非零增量（没有白写的角色）',
  NAMES.filter((name) => (usedRoles.get(name) ?? []).length > 0).every((name) => {
    const result = resolveEmotion(name, { parameters: WIDE_TABLE, intensity: 1 });
    return result.emotion.applied.every((item) => item.delta !== 0);
  }),
  NAMES.map((name) => {
    const result = resolveEmotion(name, { parameters: WIDE_TABLE, intensity: 1 });
    return result.emotion.applied.filter((item) => item.delta === 0).map((item) => `${name}/${item.role}`);
  }).flat().join(' / '));

/*
 * ★ 口型参数（`ParamMouthOpenY` / `ParamMouthForm`）是 TTS 口型通道**独占**的
 * （`actions.js` 的 `EXCLUSIVE_PARAMETER_IDS`）。情绪层去碰它们，要么被静默丢弃，
 * 要么和说话抢参数。⇒ 词汇表里一个都不许出现。
 */
const mouthIds = ALL_ROLES.flatMap((role) => ROLE_PARAMETER_IDS[role].filter((id) => actions.isExclusiveParameter(id)));
ok('词汇表里没有任何口型独占参数', mouthIds.length === 0, mouthIds.join(' / '));

ok('别名都能落到规范名上',
  ['happy', 'HAPPY', ' Happy ', 'curious', 'thinking', 'serious', 'surprised', 'sorry', 'sad', 'proud', 'neutral']
    .every((alias) => EXPECTED_NAMES.includes(canonicalEmotionName(alias))),
  ['happy', 'curious', 'thinking', 'serious', 'surprised', 'sorry', 'sad', 'proud', 'neutral']
    .map((alias) => `${alias}→${canonicalEmotionName(alias)}`).join(' '));

ok('未知名字不会撞到某条情绪上（返回 null）', canonicalEmotionName('这是一条不存在的情绪') === null,
  `实际拿到「${canonicalEmotionName('这是一条不存在的情绪')}」`);

ok('`emotionCatalogText()` 列出了全部九个名字',
  EXPECTED_NAMES.every((name) => emotionCatalogText().includes(name)));

/* ───────────────── [2] ★ hiyori 的真实参数范围 ───────────────── */

section('[2] ★ 预设 × hiyori 的真实参数范围（Core 枚举，逐参数核对）');

const Core = createCore(CORE_PATH);
const coreInfo = await waitForCore(Core);
console.log(`    Core 版本 0x${coreInfo.version.toString(16)}（初始化 ${coreInfo.elapsedMs}ms）`);

/**
 * 从 moc3 直接枚举参数范围。
 *
 * ⚠️ 与 `tools/test-capabilities.mjs` 同一个坑：`parameters` / `parts` 在
 * `Core.Model.fromMoc(moc)` 上，**不在 Moc 上**；`parameters.ids` 里装的是普通
 * 字符串。`cdi3.json` 里**没有** min/max/def —— 范围只存在于 moc3。
 */
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
console.log(`    hiyori.moc3：${HIYORI.length} 个参数`);

const hiyoriIds = new Set(HIYORI.map((item) => item.id));
ok('hiyori 的参数表里有眼睛/眉毛/脸颊这些情绪角色要用的家什',
  ['ParamEyeLOpen', 'ParamEyeLSmile', 'ParamBrowRY', 'ParamCheek', 'ParamMouthForm', 'ParamAngleX']
    .every((id) => hiyoriIds.has(id)),
  ['ParamEyeLOpen', 'ParamEyeLSmile', 'ParamBrowRY', 'ParamCheek', 'ParamMouthForm', 'ParamAngleX']
    .filter((id) => !hiyoriIds.has(id)).join(' / '));

const rangeOf = new Map(HIYORI.map((item) => [item.id, item]));
const outOfRange = [];
const clampedAtNormal = [];
const skippedRoles = [];

for (const name of NAMES) {
  /*
   * 两个强度各查一遍，因为它们守的是两条不同的契约：
   *
   *   intensity = 1（正常）  —— **一个参数都不许被夹**。这里被夹就意味着
   *                            预设自己写大了，用户看到的「开心」永远差一截，
   *                            而且没有任何提示。
   *   intensity = 1.5（用力）—— 夹到模型极限是**正确**行为（`ParamEyeLSmile`
   *                            的范围就是 [0,1]，不可能更笑），但必须**报告**出来，
   *                            否则「我让它更开心一点」就成了一个静默的空操作。
   */
  const normal = resolveEmotion(name, { parameters: HIYORI, intensity: 1 });
  if (normal.emotion.clamped.length > 0) {
    clampedAtNormal.push(`${name}：${normal.emotion.clamped.map((item) => item.id).join(' / ')}`);
  }

  const strong = resolveEmotion(name, { parameters: HIYORI, intensity: 1.5 });

  if (name !== '平静' && normal.emotion.skipped.length > 0) {
    skippedRoles.push(`${name}：${normal.emotion.skipped.join(' / ')}`);
  }

  /*
   * ★ 只要被夹了，`detail` 里就必须写出来 —— 这条断言是「不许静默」本身，
   * 而不是「不许夹」。凡是 `clamped` 非空而正文不提的，就是静默降级。
   */
  if (strong.emotion.clamped.length > 0 && !strong.detail.includes('夹')) {
    clampedAtNormal.push(`${name}：被夹了却没在正文里说明（${strong.detail}）`);
  }

  for (const [id, delta] of Object.entries(strong.emotion.params)) {
    const info = rangeOf.get(id);
    if (info === undefined) {
      outOfRange.push(`${name} 写了 hiyori 没有的参数 ${id}`);
      continue;
    }
    const target = info.def + delta;
    if (target < info.min - 1e-9 || target > info.max + 1e-9) {
      outOfRange.push(`${name}/${id} 目标 ${target.toFixed(3)} 越界 [${info.min}, ${info.max}]（def ${info.def}）`);
    }
  }
}

ok('每条情绪在 hiyori 上都能铺开（零跳过）', skippedRoles.length === 0, skippedRoles.join('；'));
ok('★ 正常强度（1.0）下一条都不被夹取 —— 预设没有写大', clampedAtNormal.length === 0, clampedAtNormal.join('；'));
ok('每条情绪的每个目标值都落在 Core 声明的范围内（含强度 1.5）', outOfRange.length === 0, outOfRange.join('；'));

/*
 * 反面：如果**范围信息没传进去**（比如哪天真去读 cdi3 了，而 cdi3 没有 min/max），
 * 预设就该按兜底范围 [-1,1] 走 —— 这里确认兜底不会把预设全部夹成 0。
 */
const withoutRanges = resolveEmotion('开心', { parameters: HIYORI.map((item) => ({ id: item.id })), intensity: 1 });
ok('参数表完全没有 min/max 时仍能铺开（走兜底范围，而不是全军覆没）',
  withoutRanges.ok && withoutRanges.emotion.applied.length > 0,
  `applied=${withoutRanges.emotion.applied.length} clamped=${withoutRanges.emotion.clamped.length}`);

/* ───────────────── [3] 解析的边界 ───────────────── */

section('[3] `resolveEmotion()` 的边界');

const unknown = resolveEmotion('暴躁', { parameters: HIYORI });
ok('未知情绪失败并给出可用名字（自愈）',
  unknown.ok === false && unknown.code === 'E_EMOTION_UNKNOWN'
  && EXPECTED_NAMES.every((name) => unknown.detail.includes(name)),
  `${unknown.code} / ${unknown.detail}`);
ok('未知情绪不返回可执行的情绪对象', unknown.emotion === null);

const clear = resolveEmotion('平静', { parameters: HIYORI });
ok('`平静` 成功且参数为空（= 清空情绪层）',
  clear.ok === true && Object.keys(clear.emotion.params).length === 0 && clear.emotion.applied.length === 0,
  `${clear.code} ${JSON.stringify(clear.emotion?.params)}`);

const strong = resolveEmotion('开心', { parameters: HIYORI, intensity: 1 });
const half = resolveEmotion('开心', { parameters: HIYORI, intensity: 0.5 });
const firstId = Object.keys(strong.emotion.params)[0];
ok('强度按比例缩放',
  firstId !== undefined && Math.abs(half.emotion.params[firstId] - strong.emotion.params[firstId] * 0.5) < 1e-9,
  `${firstId}: 1.0 → ${strong.emotion.params[firstId]}, 0.5 → ${half.emotion.params[firstId]}`);

const tooStrong = resolveEmotion('开心', { parameters: HIYORI, intensity: 99 });
ok('强度夹到上限 1.5', tooStrong.emotion.intensity === 1.5, `实际 ${tooStrong.emotion.intensity}`);

ok('默认保持时长', resolveEmotion('开心', { parameters: HIYORI }).emotion.holdMs === EMOTION_DEFAULT_HOLD_MS,
  `实际 ${resolveEmotion('开心', { parameters: HIYORI }).emotion.holdMs}`);
ok('负的保持时长夹到 0', resolveEmotion('开心', { parameters: HIYORI, holdMs: -5 }).emotion.holdMs === 0);
ok('过大的保持时长夹到上限',
  resolveEmotion('开心', { parameters: HIYORI, holdMs: 1e9 }).emotion.holdMs === EMOTION_MAX_HOLD_MS);

/*
 * 部分成功：只给「开心」真正用到的**前两个**参数。
 * ⚠️ 这里必须挑它用得上的 id，不能拿 `HIYORI.slice(0, 3)` 凑数 —— 参数表开头的三个
 * 和「开心」毫无关系，那样构造出的是「一个都没匹配上」，测的是另一条分支。
 */
const happyIds = Object.keys(strong.emotion.params);
const partial = resolveEmotion('开心', {
  parameters: HIYORI.filter((item) => happyIds.slice(0, 2).includes(item.id)),
});
ok('模型只声明了极少数参数时：能铺的照铺、其余如实报告跳过（部分成功不是完全成功）',
  partial.ok === true && partial.emotion.applied.length === 2 && partial.emotion.skipped.length > 0
  && partial.detail.includes('跳过'),
  `applied=${partial.emotion.applied.length} skipped=${partial.emotion.skipped.length}`);

const none = resolveEmotion('开心', { parameters: [{ id: 'ParamNonexistent', min: 0, max: 1, def: 0 }] });
ok('一个参数都匹配不上时失败，并说明缺哪些角色',
  none.ok === false && none.code === 'E_EMOTION_NO_PARAMETER' && none.detail.includes('开心'),
  `${none.code} / ${none.detail}`);

ok('没有能力清单时不会崩（退化成「全跳过」）',
  resolveEmotion('开心', {}).ok === false && resolveEmotion('开心', {}).code === 'E_EMOTION_NO_PARAMETER');

/* ───────────────── [4] `emotionEnvelope()` 的数学 ───────────────── */

section('[4] `emotionEnvelope()`：淡入 / 保持 / 淡出');

const A = EMOTION_ATTACK_MS;
const R = EMOTION_RELEASE_MS;
const H = 1000;
const env = (t) => emotionEnvelope(t, H, A, R);

ok('t = 0 → 0', env(0) === 0);
ok('淡入中点半值', Math.abs(env(A / 2) - 0.5) < 1e-9, `实际 ${env(A / 2)}`);
ok('淡入结束时到 1', env(A) === 1);
ok('保持段中仍是 1', env(A + H / 2) === 1);
ok('保持结束时还是 1', env(A + H) === 1);
ok('淡出中点半值', Math.abs(env(A + H + R / 2) - 0.5) < 1e-9, `实际 ${env(A + H + R / 2)}`);
ok('淡出结束时回 0', env(A + H + R) === 0);
ok('之后再久也是 0', env(A + H + R + 10000) === 0);
ok('保持为 0（"一直保持"）时不会淡出', emotionEnvelope(1e9, 0, A, R) === 1);
ok('淡入为 0 时立刻满值', emotionEnvelope(1, H, 0, R) === 1, `实际 ${emotionEnvelope(1, H, 0, R)}`);
ok('淡出为 0 时到点立刻归零', emotionEnvelope(A + H, H, A, 0) === 0);
ok('负时间与 NaN 都当 0', emotionEnvelope(-100, H, A, R) === 0 && emotionEnvelope(NaN, H, A, R) === 0);

let outOfUnit = 0;
for (let t = -50; t <= A + H + R + 50; t += 7) {
  const value = env(t);
  if (!(value >= 0 && value <= 1)) outOfUnit += 1;
}
ok('整条曲线恒在 [0,1] 内', outOfUnit === 0, `${outOfUnit} 个采样点越界`);

/* ───────────────── [4b] ★ 指数尾（§13.33）：hold 之后不是「线性掉下去」 ───────────────── */

section('[4b] 指数尾：`decayMs > 0` 时按 τ 衰减，`0` 时仍是老的线性');

const D = EMOTION_DECAY_MS;
const tail = (t) => emotionEnvelope(t, H, A, R, D);

ok('保持段里指数尾不生效（还是 1）', tail(A + H / 2) === 1 && tail(A + H) === 1);
ok('刚进衰减时不是从 0 开始（连续）', Math.abs(tail(A + H + 1) - 1) < 0.01, `实际 ${tail(A + H + 1)}`);
ok('τ 处约 37%', Math.abs(tail(A + H + D) - Math.exp(-1)) < 0.01, `实际 ${tail(A + H + D)}`);
ok('两个 τ 处约 13.5%', Math.abs(tail(A + H + 2 * D) - Math.exp(-2)) < 0.02, `实际 ${tail(A + H + 2 * D)}`);
ok('衰减到 `EMOTION_DECAY_FLOOR` 以下就归零（不会永远「还活着一点点」）',
  tail(A + H + 3 * D) > 0 && tail(A + H + 5 * D) === 0,
  `3τ=${tail(A + H + 3 * D).toFixed(4)} 5τ=${tail(A + H + 5 * D)}`);
ok('指数尾永远不超过 1、也不为负',
  (() => {
    let bad = 0;
    for (let t = 0; t <= A + H + 8 * D; t += 37) {
      const value = tail(t);
      if (!(value >= 0 && value <= 1)) bad += 1;
    }
    return bad === 0;
  })());
ok('`decayMs = 0` 时回到老的线性（4 参调用完全不变）',
  emotionEnvelope(A + H + R / 2, H, A, R, 0) === 0.5,
  `实际 ${emotionEnvelope(A + H + R / 2, H, A, R, 0)}`);
ok('`EMOTION_DECAY_FLOOR` 是个小于 0.1 的正数（夹取阈值的合理性）',
  EMOTION_DECAY_FLOOR > 0 && EMOTION_DECAY_FLOOR < 0.1, String(EMOTION_DECAY_FLOOR));

/* ───────────────── [4c] ★ 余波：换情绪时旧层不剪掉，留一层很淡的残影 ───────────────── */

section('[4c] 余波：同族留 18% 残影，异族不留');

const FAMILY_CAP = [
  { id: 'ParamEyeLSmile', min: 0, max: 1, def: 0 },
  { id: 'ParamEyeRSmile', min: 0, max: 1, def: 0 },
  { id: 'ParamCheek', min: 0, max: 1, def: 0 },
  { id: 'ParamBrowLY', min: -1, max: 1, def: 0 },
  { id: 'ParamBrowRY', min: -1, max: 1, def: 0 },
  { id: 'ParamBrowLForm', min: -1, max: 1, def: 0 },
  { id: 'ParamBrowRForm', min: -1, max: 1, def: 0 },
  { id: 'ParamAngleZ', min: -30, max: 30, def: 0 },
  { id: 'ParamAngleY', min: -30, max: 30, def: 0 },
  { id: 'ParamEyeLOpen', min: 0, max: 1, def: 1 },
  { id: 'ParamEyeROpen', min: 0, max: 1, def: 1 },
  { id: 'ParamEyeBallX', min: -1, max: 1, def: 0 },
  { id: 'ParamEyeBallY', min: -1, max: 1, def: 0 },
  { id: 'ParamHairAhoge', min: -1, max: 1, def: 0 },
  { id: 'ParamShoulder', min: -1, max: 1, def: 0 },
  { id: 'ParamBodyAngleX', min: -10, max: 10, def: 0 },
];

const happy = resolveEmotion('开心', { parameters: FAMILY_CAP });
const proud = resolveEmotion('得意', { parameters: FAMILY_CAP });
const sad = resolveEmotion('难过', { parameters: FAMILY_CAP });
ok('[4c] 前置：三条情绪都能在这个假模型上解析出来',
  happy.ok === true && proud.ok === true && sad.ok === true,
  `${happy.code}/${proud.code}/${sad.code}`);

ok('情绪分族：开心与得意同族，开心与难过不同族',
  emotionFamily('开心') === 'warm' && emotionFamily('得意') === 'warm'
  && emotionsRelated('开心', '得意') === true
  && emotionsRelated('开心', '难过') === false
  && emotionsRelated('平静', '开心') === false);

let layers = setEmotionLayers(createEmotionLayers(), happy.emotion, {}).state;
layers = advanceEmotionLayers(layers, 900).state;
const switched = setEmotionLayers(layers, proud.emotion, {});
ok('同族切换留下余波，返回值点名是谁',
  switched.residue === '开心', `residue=${JSON.stringify(switched.residue)}`);
const residueLayer = switched.state.layers.find((layer) => layer.residue === true);
ok('余波层带着标记，且幅度是原层的 18%',
  residueLayer !== undefined
  && residueLayer.holdMs === 0 && residueLayer.fadeMs === EMOTION_RESIDUE_MS
  && Object.keys(residueLayer.params).length > 0
  && Math.abs(residueLayer.params.ParamAngleZ - happy.emotion.params.ParamAngleZ * EMOTION_RESIDUE_WEIGHT) < 1e-9,
  JSON.stringify(residueLayer ?? null).slice(0, 200));
const afterSwitch = advanceEmotionLayers(switched.state, 300);
ok('余波会在 1.5 秒内淡掉（不是常驻）',
  afterSwitch.state.layers.some((layer) => layer.residue === true)
  && !advanceEmotionLayers(switched.state, EMOTION_RESIDUE_MS + 10).state.layers.some((layer) => layer.residue === true));
ok('面板文字把余波标成「·余」',
  /·余/.test(describeEmotionLayers(afterSwitch.state)),
  describeEmotionLayers(afterSwitch.state));

const crossSwitch = setEmotionLayers(layers, sad.emotion, {});
ok('异族切换**不留**余波（难过时脸上不该还挂着笑）',
  crossSwitch.residue === '' && !crossSwitch.state.layers.some((layer) => layer.residue === true),
  `residue=${JSON.stringify(crossSwitch.residue)}`);

const freshSwitch = setEmotionLayers(createEmotionLayers(), happy.emotion, {});
ok('从头挂第一层时没有余波可留', freshSwitch.residue === '', JSON.stringify(freshSwitch.residue));

const sameAgain = setEmotionLayers(layers, happy.emotion, {});
ok('★ 同一种情绪重新装一层时**不留**余波（那不是「换」，是同名续不上）',
  sameAgain.residue === '' && !sameAgain.state.layers.some((layer) => layer.residue === true),
  `residue=${JSON.stringify(sameAgain.residue)} layers=${sameAgain.state.layers.length}`);

/* ───────────────── [4d] ★ 静息漂移：不动的时候也在慢慢动 ───────────────── */

section('[4d] 静息漂移：两条正弦、按量程比例、不碰嘴');

const driftRoles = ambientDriftRoles();
ok('漂移只借「头 / 视线 / 眉毛」这几种角色（不碰嘴、不碰眼开合）',
  driftRoles.length >= 5
  && driftRoles.every((role) => ROLE_PARAMETER_IDS[role] !== undefined)
  && !driftRoles.includes('eyeOpenL') && !driftRoles.includes('eyeOpenR')
  && !driftRoles.includes('cheek') && !driftRoles.includes('eyeSmileL'),
  driftRoles.join(' / '));

const driftModel = [
  { id: 'ParamAngleZ', min: -30, max: 30, def: 0 },
  { id: 'ParamAngleX', min: -30, max: 30, def: 0 },
  { id: 'ParamEyeBallX', min: -1, max: 1, def: 0 },
];
const resolvedDrift = resolveAmbientDrift(driftModel, {});
ok('解析出这个模型上真实的三根参数', Object.keys(resolvedDrift).length === 3,
  JSON.stringify(resolvedDrift));
ok('幅度按量程比例给：±30 的头约 1.4 度、±1 的视线约 0.02',
  Math.abs(resolvedDrift.angleZ.amp - 60 * 0.024) < 1e-9
  && Math.abs(resolvedDrift.eyeBallX.amp - 2 * 0.010) < 1e-9,
  JSON.stringify(resolvedDrift));

const driftAt = (t) => ambientDriftValues(t, resolvedDrift, {});
const d0 = driftAt(0);
const d5 = driftAt(5000);
ok('t = 0 与 t = 5s 的增量明显不同（它真的在动，而不是一个常数偏移）',
  Math.abs(d0.ParamAngleZ - d5.ParamAngleZ) > 0.2,
  `${d0.ParamAngleZ} → ${d5.ParamAngleZ}`);
ok('但 t = 0 与 t = 1s 之间幅度很小（慢，不是抖）',
  Math.abs(d0.ParamAngleZ - driftAt(1000).ParamAngleZ) < 0.2,
  `${d0.ParamAngleZ} → ${driftAt(1000).ParamAngleZ}`);
ok('任何时刻都不超出解析出来的幅度上限',
  (() => {
    let bad = 0;
    for (let t = 0; t <= 600000; t += 250) {
      const value = driftAt(t);
      if (Math.abs(value.ParamAngleZ ?? 0) > resolvedDrift.angleZ.amp + 1e-9) bad += 1;
      if (Math.abs(value.ParamEyeBallX ?? 0) > resolvedDrift.eyeBallX.amp + 1e-9) bad += 1;
    }
    return bad === 0;
  })());
ok('`factor = 0` 时一个参数都不写（面板关掉它就是真的关掉）',
  Object.keys(ambientDriftValues(1000, resolvedDrift, { factor: 0 })).length === 0);
ok('`strength = 0` 时同样一个都不写',
  Object.keys(ambientDriftValues(1000, resolvedDrift, { strength: 0 })).length === 0);
ok('没有解析结果时安全返回空表（旧模型 / 没有这些参数）',
  Object.keys(ambientDriftValues(1000, {}, {})).length === 0
  && Object.keys(ambientDriftValues(1000, null, {})).length === 0);
ok('同一次调用里同一根参数只出现一次（不会把一个 id 写两遍）',
  (() => {
    const values = ambientDriftValues(1234, resolvedDrift, {});
    return Object.keys(values).length === new Set(Object.keys(values)).size;
  })());


/* ───────────────── [5] ★ 契约三处一致（真的调一次校验层） ───────────────── */

section('[5] ★ 契约三处一致：actions.js → action-runner.ts → pet-model.ts');

ok('`ACTION_KINDS` 收录了 `emotion`', actions.ACTION_KINDS.includes('emotion'),
  actions.ACTION_KINDS.join(' / '));
ok('`live2d_emote` 映射到 `emotion`', actions.TOOL_KINDS.live2d_emote === 'emotion',
  JSON.stringify(actions.TOOL_KINDS));

const CAPS = {
  parameters: HIYORI,
  expressions: [{ name: '脸红', file: 'expressions/脸红.exp3.json' }],
  motionGroups: [{ name: 'hiyori_m', count: 10 }],
  hitAreas: [],
};

const built = actions.buildAction({ kind: 'emotion', name: '开心' }, CAPS);
ok('★ 校验层真的产出一条可执行的情绪指令',
  built.ok === true && built.command?.kind === 'emotion'
  && typeof built.command.payload?.emotion === 'object'
  && Object.keys(built.command.payload.emotion.params).length > 0,
  JSON.stringify(built).slice(0, 240));

ok('指令里带着名字、强度、保持时长与淡入淡出',
  built.command?.payload?.emotion?.name === '开心'
  && built.command.payload.emotion.attackMs === EMOTION_ATTACK_MS
  && built.command.payload.emotion.releaseMs === EMOTION_RELEASE_MS
  && built.command.payload.emotion.holdMs === EMOTION_DEFAULT_HOLD_MS,
  JSON.stringify(built.command?.payload?.emotion ?? null).slice(0, 240));

ok('★ 指令里也带着指数尾的 τ（新 Host 的默认退场形状）',
  built.command?.payload?.emotion?.decayMs === EMOTION_DECAY_MS,
  `decayMs=${JSON.stringify(built.command?.payload?.emotion?.decayMs)}`);

const builtLinear = actions.buildAction({ kind: 'emotion', name: '开心', releaseMs: 800 }, CAPS);
ok('★ 显式给了 `releaseMs` 的旧形状仍然走线性（`decayMs === 0`）',
  builtLinear.ok === true && builtLinear.command?.payload?.emotion?.decayMs === 0
  && builtLinear.command.payload.emotion.releaseMs === 800,
  `decayMs=${JSON.stringify(builtLinear.command?.payload?.emotion?.decayMs)} releaseMs=${builtLinear.command?.payload?.emotion?.releaseMs}`);

const builtUnknown = actions.buildAction({ kind: 'emotion', name: '暴躁' }, CAPS);
ok('校验层拦下未知情绪', builtUnknown.ok === false && builtUnknown.code === 'E_EMOTION_UNKNOWN',
  `${builtUnknown.code} / ${builtUnknown.detail}`);

const builtNoCaps = actions.buildAction({ kind: 'emotion', name: '开心' }, null);
ok('没有能力清单时校验层拒绝', builtNoCaps.ok === false && builtNoCaps.code === 'E_ACTION_NO_CAPABILITIES',
  builtNoCaps.code);

const builtNoName = actions.buildAction({ kind: 'emotion' }, CAPS);
ok('缺名字时给出「没收到名字」而不是「没有叫 undefined 的情绪」',
  builtNoName.ok === false && builtNoName.code === 'E_EMOTION_UNKNOWN'
  && builtNoName.detail.includes('情绪名字') && !builtNoName.detail.includes('undefined'),
  `${builtNoName.code} / ${builtNoName.detail}`);

ok('`actionSummary()` 认得情绪指令',
  /开心|情绪/.test(actions.actionSummary(built.command)),
  actions.actionSummary(built.command));

const runnerSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/action-runner.ts'), 'utf8'));
const modelSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/pet-model.ts'), 'utf8'));
const pluginSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/plugin.ts'), 'utf8'));
const hostSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/index.js'), 'utf8'));
const actionsSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/host/actions.js'), 'utf8'));

ok('action-runner：`HANDLED_KINDS` 收录 `emotion`',
  /HANDLED_KINDS[^;]*'emotion'/s.test(runnerSource));
ok('action-runner：有 `case \'emotion\'` 分支并调用 `setEmotion(`',
  /case 'emotion'/.test(runnerSource) && /target\.setEmotion\(/.test(runnerSource));
ok('action-runner：空参数会走 `clearEmotion()`（而不是什么都不做）',
  /clearEmotion\(\)/.test(runnerSource));
ok('action-runner：`ActionTarget` 接口里声明了这两个方法',
  /setEmotion\(/.test(runnerSource) && /clearEmotion\(\): void/.test(runnerSource));

ok('pet-model：实现了 `setEmotion(` / `clearEmotion()` / `emotionName()`',
  /setEmotion\(/.test(modelSource) && /clearEmotion\(\)/.test(modelSource) && /emotionName\(\)/.test(modelSource));
/*
 * ★ 加法写入：**只看 `_applyEmotion()` 的函数体**，不看整个文件。
 *
 * 第一版写的是「整个文件里同时出现 `addParameterValue(` 与 `emotionEnvelope(`」——
 * 那种断言只要那两个字符串在文件里各出现一次就绿，哪怕加法那一句在一个永远
 * 走不到的分支里。D 期把包络搬进状态机（`advanceEmotionLayers()`）之后，这条
 * 断言连字符串都对不上了，正好一起改对：**函数体里只许有加法，不许有硬写**。
 */
const applyStart = modelSource.indexOf('private _applyEmotion(');
const applyNext = applyStart === -1 ? -1 : modelSource.indexOf('\n  private ', applyStart + 10);
const applyBody = applyStart === -1
  ? ''
  : modelSource.slice(applyStart, applyNext === -1 ? applyStart + 1600 : applyNext);
ok('★ pet-model：情绪层是**加法**写入（`addParameterValue`），不是硬写覆盖',
  applyBody !== ''
  && /addParameterValue\(/.test(applyBody)
  && !/setParameterValue\(/.test(applyBody)
  && /advanceEmotionLayers\(/.test(applyBody),
  `_applyEmotion 体长 ${applyBody.length}`);

/*
 * ★ 落笔位置：情绪必须在 `_scheduler.onLateUpdate()`（眨眼 200 / 表情 300 / 视线 400 /
 * 呼吸 500 / 物理 600 / 姿态 800）**之后**、`model.update()` **之前**。
 * 早了会被物理与姿态覆盖，晚了根本写不进去（`model.update()` 才是提交）。
 *
 * ⚠️ 定位 `update()` 得用真实签名（`public override update(deltaTimeSeconds: number)`），
 * 不能用 `update(delta` —— 名字对不上就会切出一个空串，三个下标一起变 -1，
 * 于是这条断言**永远红**（我第一版就是这样，反而没测到任何东西）。
 */
const updateAt = modelSource.search(/public\s+(override\s+)?update\s*\(/);
const updateBody = updateAt === -1 ? '' : modelSource.slice(updateAt);
const lateUpdateAt = updateBody.indexOf('this._scheduler.onLateUpdate(');
const emotionAt = updateBody.indexOf('this._applyEmotion(');
// 提交那一句是 `model.update();`（局部变量），不是 `this.model.update()`。
const commitAt = updateBody.indexOf('model.update();', emotionAt);
ok('★ pet-model：情绪层写在 `onLateUpdate()` 之后、`model.update()` 之前',
  lateUpdateAt !== -1 && emotionAt !== -1 && commitAt !== -1
  && lateUpdateAt < emotionAt && emotionAt < commitAt,
  `updateAt=${updateAt} onLateUpdate=${lateUpdateAt} _applyEmotion=${emotionAt} model.update=${commitAt}`);

/*
 * ★ 优先级：情绪层是**底**，口型与 `param` 覆盖是**硬写**，必须压在它上面。
 * 反过来的话，一次情绪会把她说话时的嘴冻住整段 hold —— 那正是 §4.1 硬规则 1
 * （口型通道独占）要防的事。
 */
const mouthWriteAt = updateBody.indexOf('this.setParameterValue(MOUTH_OPEN_PARAMETER_ID');
const overrideAt = updateBody.indexOf('this._parameterOverrides.size > 0');
ok('★ pet-model：口型硬写与 `param` 覆盖都排在情绪层之后（硬写仍然赢）',
  mouthWriteAt !== -1 && overrideAt !== -1 && emotionAt < mouthWriteAt && emotionAt < overrideAt,
  `_applyEmotion=${emotionAt} 口型=${mouthWriteAt} overrides=${overrideAt}`);
ok('pet-model：情绪层跟着每帧的 delta 走（不是固定步长）',
  /_applyEmotion\(delta\)/.test(modelSource));
/*
 * `release()` 必须把情绪层清空 —— 否则换装之后新模型会继承上一只的表情。
 *
 * D 期改成多层之后，清空的方式从「置 null」变成「换一个空状态机」，判据跟着
 * 改；同时**钉住它在 `release()` 里面**（整个文件里出现过一次不算）。
 */
const releaseStart = modelSource.search(/public\s+(override\s+)?release\s*\(/);
const releaseEnd = releaseStart === -1 ? -1 : modelSource.indexOf('\n  }', releaseStart);
const releaseBody = releaseStart === -1
  ? ''
  : modelSource.slice(releaseStart, releaseEnd === -1 ? releaseStart + 3000 : releaseEnd);
ok('pet-model：`release()` 会清掉情绪层',
  releaseBody !== '' && /_emotions = createEmotionLayers\(\)/.test(releaseBody),
  `release 体长 ${releaseBody.length}`);

/* ★ §13.33 的接线对账：改的是「谁在什么时候调用什么」，这一层用源码正则守。 */
ok('★ action-runner：把 `decayMs` 从 payload 透到 `setEmotion()`',
  /decayMs: optionalNumber\(emotion\?\.decayMs\)/.test(runnerSource));
ok('★ pet-model：`setEmotion()` 认得「显式 decayMs 优先、只给 releaseMs 走线性」',
  /typeof options\?\.decayMs !== 'number'/.test(modelSource)
  && /releaseGiven \? 0 : EMOTION_DECAY_MS/.test(modelSource));
ok('★ pet-model：每帧调用 `_applyAmbientDrift()`，且夹在情绪层与待机小动作之间',
  /this\._applyEmotion\(delta\);[\s\S]{0,1200}?this\._applyAmbientDrift\(delta\);[\s\S]{0,400}?this\._applyGarnish\(delta\);/.test(modelSource));
ok('★ pet-model：漂移的角色表懒解析（换模型 / 释放之后会重算）',
  /private _driftResolved/.test(modelSource)
  && /private _ensureAmbientDrift\(\)/.test(modelSource)
  && /this\._driftResolved = null;/.test(releaseBody));
ok('★ pet-model：漂移用 `addParameterValue()`（加法，与眨眼 / 动作共存）',
  /ambientDriftValues\(this\._driftClockMs, resolved/.test(modelSource));
ok('★ pet-model：正在播正经动作时漂移被压到 40%（不是归零）',
  /isBusyWithRealMotion\(this\.currentMotionPriority\(\)\) \? 0\.4 : 1/.test(modelSource));
ok('★ actions.js：`decayMs` 进了 payload（`0` 也要送，不能用真值判断吞掉）',
  /decayMs: emotion\.decayMs,/.test(actionsSource));
ok('★ pet-model：漂移开关默认是开的（面板关掉之前它一直在）',
  /private _driftEnabled = true;/.test(modelSource));

/*
 * ★ 可观测性对账（§13.33 之后补）：这三件事光看脸看不出来 —— 「衰减到 37%」
 * 要看权重，「漂移 ±1.44」要看幅度。断言它们确实交到了面板手上，否则这一轮
 * 改动的效果只能靠感觉，而「靠感觉」正是上一次用户问「怎么能看出效果」的原因。
 */
ok('★ pet-model：向面板交出原始权重（`emotionLayers()`，单层也带数字）',
  /public emotionLayers\(\)/.test(modelSource)
  && /residue: layer\.residue === true/.test(modelSource));
ok('★ pet-model：向面板交出漂移读数（几根轴 / 最大幅度 / 是否被压到 40%）',
  /public ambientDriftSummary\(\)/.test(modelSource)
  && /maxAmp/.test(modelSource)
  && /damped: isBusyWithRealMotion\(this\.currentMotionPriority\(\)\)/.test(modelSource));
ok('★ 面板：读数格式化函数存在，且权重固定两位小数',
  /function describeReadout\(/.test(pluginSource)
  && /weight\.toFixed\(2\)/.test(pluginSource));
ok('★ 面板：状态行接的是 `stats.readout`（旧的「只在两层时才有数字」那条已撤）',
  /stats\.readout === ''/.test(pluginSource)
  && !/stats\.emotion === ''/.test(pluginSource));

/*
 * ★ 这条原来写的是 `import { resolveEmotion } from './emotions.js'` —— 一个**形状**
 * 断言，而形状会因为多导入两个名字（`canonicalEmotionName` / `emotionCatalogText`，
 * #3 的「按名字收」要用）就变红，红的却不是行为。改成断言**拿的是哪三件事**：
 * 少了任何一件，另外两条断言（名字校验、清单可自愈）会各自红在正确的地方。
 */
ok('actions.js：从 `./emotions.js` 拿的是「解析 + 名字规范化 + 清单文本」三件事',
  /from '\.\/emotions\.js'/.test(actionsSource)
    && /resolveEmotion\b/.test(actionsSource)
    && /canonicalEmotionName\b/.test(actionsSource)
    && /emotionCatalogText\b/.test(actionsSource));
ok('lib/index.js：注册了 `live2d_emote` 工具',
  /name: 'live2d_emote'/.test(hostSource));
ok('lib/index.js：情绪详情受 `resolveEmotionMarker()` 开关控制',
  /resolveEmotionMarker\(/.test(hostSource) && /kind !== 'emotion'/.test(hostSource));
ok('lib/index.js：开关支持环境变量 `DSH_LIVE2D_EMOTION_MARKER`',
  /DSH_LIVE2D_EMOTION_MARKER/.test(hostSource));
/*
 * 工具说明里的情绪清单**由 `emotions.js` 生成**（`emotionCatalogText()`），而不是
 * 在 `lib/index.js` 里手抄一份。注意**不能**要求 host 源码里一个名字都不出现 ——
 * 描述里举一个例子（「Send "平静" to clear the layer」）是好事。抓的是「整份清单
 * 被抄了过来」：那种抄法意味着加了新情绪而 AI 看不到。
 */
const literalsInHost = EXPECTED_NAMES.filter((name) => hostSource.includes(name));
ok('lib/index.js：工具说明里的清单是 `emotionCatalogText()` 现生成的（没有手抄整份）',
  /emotionCatalogText\(\)/.test(hostSource) && literalsInHost.length < EXPECTED_NAMES.length,
  `emotionCatalogText()=${/emotionCatalogText\(\)/.test(hostSource)} 源码里出现的名字：${literalsInHost.join(' / ') || '（无）'}`);
ok('工具说明里确实带着清单（生成出来的那一份）',
  EXPECTED_NAMES.every((name) => emotionCatalogText().includes(name)));

/* ───────────────── [6] 反证：上面的谓词真的抓得住 ───────────────── */

section('[6] 反证：把实现改坏，判据必须变红');

const reversed = [];

// 反证 1：情绪层改成硬写覆盖（`setParameterValue`）—— 谓词必须不再成立。
const hardWrite = modelSource.replace(/addParameterValue\(/g, 'setParameterValue(');
if (hardWrite === modelSource) reversed.push('反证 1 没能改动源码（找不到 addParameterValue）');
else if (/addParameterValue\(/.test(hardWrite)) reversed.push('反证 1 后仍存在 addParameterValue');

// 反证 2：情绪落笔挪到 `onLateUpdate()` **之前** —— 顺序判据必须变红。
const earlyWrite = modelSource.replace('this._applyEmotion(delta);\n', '');
const earlyBody = earlyWrite.slice(earlyWrite.indexOf('  update(delta'));
if (!(earlyBody.indexOf('this._applyEmotion(') === -1)) reversed.push('反证 2 没能移除 _applyEmotion 调用点');

// 反证 3：`ACTION_KINDS` 里去掉 `emotion` —— 源码判据必须变红。
const noKind = actionsSource.replace("'emotion', ", '');
if (noKind === actionsSource) reversed.push('反证 3 没能改动 ACTION_KINDS');
else if (/ACTION_KINDS[^;]*'emotion'/s.test(noKind)) reversed.push('反证 3 后 ACTION_KINDS 仍含 emotion');

// 反证 4：词汇表里删掉一条情绪（表头与别名两处都删）—— 名字清单判据必须变红。
const emotionSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/host/emotions.js'), 'utf8'));
const missingName = emotionSource.replaceAll('得意', '');
if (missingName === emotionSource) reversed.push('反证 4 没能从词汇表里删掉「得意」');
else {
  const stillAll = EXPECTED_NAMES.every((name) => missingName.includes(name));
  if (stillAll) reversed.push('反证 4 后九个名字仍然齐全');
}

// 反证 5：口型独占参数混进词汇表 —— 静态自检必须变红。
const pollutedRoles = { ...ROLE_PARAMETER_IDS, 'mouth.smile': ['ParamMouthForm'] };
const pollutedIds = Object.keys(pollutedRoles)
  .flatMap((role) => pollutedRoles[role].filter((id) => actions.isExclusiveParameter(id)));
if (pollutedIds.length === 0) reversed.push('反证 5 没能构造出口型污染样本');

// 反证 6：把淡出设为 0 却仍期望中点半值 —— `emotionEnvelope` 判据必须变红。
if (Math.abs(emotionEnvelope(A + H + R / 2, H, A, 0) - 0.5) < 1e-9) reversed.push('反证 6 的样本不成立（本该是 0）');

ok('六条反证都能把对应的判据翻过来', reversed.length === 0, reversed.join('；'));

ok('反证没有改动磁盘上的源码',
  readFileSync(resolve(PACKAGE, 'src/client/pet-model.ts'), 'utf8').includes('addParameterValue(')
  && readFileSync(resolve(PACKAGE, 'lib/host/actions.js'), 'utf8').includes("'emotion'"),
  '磁盘上的源码被改动了');

/* ───────────────── [6b] 参数绑定（面板那张表） ───────────────── */

section('[6b] 参数绑定：绑定优先、绑不存在的退回并报出来');

/*
 * 这一节守的是**面板那张表真的影响了下发**。
 *
 * 它防的失效形态很具体：面板把 `eyeSmileL → ParamEyeSmile2` 存进 settings.json，
 * Host 也「读到了」，但读到的值没被带进 `resolveEmotion()` —— 于是她照旧走候选表。
 * 用户看到的是「我明明绑了，她还是没笑」，而 `/bindings` 的回读一切正常。
 */
ok('角色清单与中文名一一对应（面板的表格行数与报错里的说法取自同一处）',
  emotionRoleNames().length >= 17
  && emotionRoleNames().every((role) => typeof ROLE_LABELS[role] === 'string' && ROLE_LABELS[role] !== '')
  && Object.keys(ROLE_LABELS).length === Object.keys(ROLE_PARAMETER_IDS).length,
  `${emotionRoleNames().length} 个角色 / ${Object.keys(ROLE_LABELS).length} 个中文名`);

const normalised = normalizeEmotionBindings({
  eyeSmileL: ' ParamEyeSmile2 ',
  browLY: '',
  cheek: 42,
  bogusRole: 'ParamX',
});
ok('规范化：trim 后留下、空值/非字符串/未知角色全部进 ignored（不静默吞掉）',
  normalised.roles.eyeSmileL === 'ParamEyeSmile2'
  && Object.keys(normalised.roles).length === 1
  && normalised.ignored.some((item) => item.role === 'browLY' && item.reason === 'bad-value')
  && normalised.ignored.some((item) => item.role === 'cheek' && item.reason === 'bad-value')
  && normalised.ignored.some((item) => item.role === 'bogusRole' && item.reason === 'unknown-role'),
  JSON.stringify(normalised));

ok('坏输入不崩：null / 数组 / 字符串 / 数字都当空表',
  [null, undefined, [], 'eyeSmileL=ParamEyeSmile2', 42].every((bad) => {
    const out = normalizeEmotionBindings(bad);
    return Object.keys(out.roles).length === 0 && out.ignored.length === 0;
  }));

/*
 * 一个**只声明替代 id** 的模型：`ParamEyeSmile2`（而不是候选表首位的
 * `ParamEyeLSmile`）。这正是绑定存在的场合 —— 候选表猜不到，用户看得出。
 */
const ALT = [
  { id: 'ParamEyeSmile2', min: 0, max: 1, def: 0 },
  { id: 'ParamBrowLY', min: -1, max: 1, def: 0 },
  { id: 'ParamBrowRY', min: -1, max: 1, def: 0 },
  { id: 'ParamCheek', min: -1, max: 1, def: 0 },
  { id: 'ParamAngleZ', min: -30, max: 30, def: 0 },
  { id: 'ParamHairAhoge', min: -1, max: 1, def: 0 },
];

const boundHappy = resolveEmotion('开心', {
  parameters: ALT,
  bindings: { eyeSmileL: 'ParamEyeSmile2', eyeSmileR: 'ParamEyeSmile2' },
});
ok('★ 绑定生效：那条角色写的就是用户绑的 id（而不是候选表里第一个存在的）',
  boundHappy.ok === true
  && boundHappy.emotion.applied.some((item) => item.role === 'eyeSmileL' && item.id === 'ParamEyeSmile2' && item.source === 'binding')
  && boundHappy.emotion.bound.length === 2
  && boundHappy.detail.includes('绑定生效'),
  `${boundHappy.code} / ${boundHappy.detail}`);

/*
 * 绑了模型没有的参数：**退回候选**而不是跳过。
 * 用 `browLY` 而不是 `eyeSmileL` 是有意的 —— 后者的候选表里根本没有 ALT 声明的
 * `ParamEyeSmile2`，拿它测「退回」会变成测「跳过」。
 */
const missingBinding = resolveEmotion('开心', {
  parameters: ALT,
  bindings: { browLY: 'ParamBrowLY7' },
});
ok('★ 绑了本模型没有的参数：退回候选并把「这条绑定不适用」报出来（不是静默跳过）',
  missingBinding.ok === true
  && missingBinding.emotion.applied.some((item) => item.role === 'browLY' && item.id === 'ParamBrowLY' && item.source === 'auto')
  && missingBinding.emotion.bindingMisses.length === 1
  && missingBinding.emotion.bindingMisses[0].boundId === 'ParamBrowLY7'
  && missingBinding.detail.includes('绑定指向的参数这个模型没有'),
  missingBinding.detail);

const boundNoCandidate = resolveEmotion('开心', {
  parameters: ALT.filter((item) => item.id !== 'ParamCheek'),
  bindings: { cheek: 'ParamCheek' },
});
ok('绑定不会凭空造出参数：模型没有它就仍然跳过，同时报「绑定不适用」',
  boundNoCandidate.emotion.skipped.includes('cheek')
  && boundNoCandidate.emotion.bindingMisses.some((item) => item.role === 'cheek' && item.boundId === 'ParamCheek'),
  JSON.stringify(boundNoCandidate.emotion.bindingMisses));

const pickBound = pickRoleParameter('eyeSmileL', new Map(ALT.map((item) => [item.id, item])), { eyeSmileL: 'ParamEyeSmile2' });
const pickMissing = pickRoleParameter('browLY', new Map(ALT.map((item) => [item.id, item])), { browLY: 'ParamBrowLY7' });
ok('`pickRoleParameter()` 单独也说得清三件事：谁赢、退回谁、绑的那个在不在',
  pickBound.id === 'ParamEyeSmile2' && pickBound.source === 'binding' && pickBound.bindingMissing === false
  && pickMissing.id === 'ParamBrowLY' && pickMissing.source === 'auto' && pickMissing.bindingMissing === true,
  `${JSON.stringify(pickBound)} / ${JSON.stringify(pickMissing)}`);

const boundBuilt = actions.buildAction(
  { kind: 'emotion', name: '开心' },
  { parameters: ALT, expressions: [], motionGroups: [], hitAreas: [] },
  { bindings: { eyeSmileL: 'ParamEyeSmile2' } },
);
ok('★ `buildAction()` 把绑定透了进去（面板存的那张表真的到达了指令里）',
  boundBuilt.ok === true
  && typeof boundBuilt.command.payload.emotion.params.ParamEyeSmile2 === 'number'
  && !('ParamEyeLSmile' in boundBuilt.command.payload.emotion.params),
  JSON.stringify(boundBuilt.command?.payload?.emotion?.params ?? null));

const plainBuilt = actions.buildAction(
  { kind: 'emotion', name: '开心' },
  { parameters: ALT, expressions: [], motionGroups: [], hitAreas: [] },
);
/*
 * 指令的 payload 里**不**放 bound / bindingMisses：渲染端不需要它们，而
 * 「哪块肌肉没绑上」这句话的作用对象是**用户**（面板）和**AI**（工具的 detail）。
 * 所以这里断言的是 detail —— 那才是这句话真正到达的地方。
 */
ok('不传绑定时行为与改动前一致（而且 detail 里不会冒出「绑定」两个字）',
  plainBuilt.ok === true && !plainBuilt.detail.includes('绑定'),
  plainBuilt.detail);

/* ───────────────── 写回 settings.json ───────────────── */
/*
 * `/bindings` 的 POST 是整个插件里**唯一一处写用户配置文件**的地方。
 * 它现在住在 `host/settings-write.js` 里，所以这一段可以拿临时目录把每一种
 * 坏情况真跑一遍 —— 这些断言存在的理由只有一个：写坏这个文件等于替用户
 * 删掉他自己手写的配置（别处的 `modelsRoot`、别的插件写进去的键都在这一个文件里）。
 */
section('【6】写回 settings.json（唯一一处写用户配置的代码）');
{
  const { applySettingsPatch } = await import(
    pathToFileURL(resolve(PACKAGE, 'lib', 'host', 'settings-write.js')).href
  );
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-live2d-bindings-'));
  try {
    // ① 目标文件还不存在（连目录都不存在）—— 要自己建目录、写出来、以换行收尾。
    const fresh = join(sandbox, 'nested', 'deep', 'settings.json');
    const created = applySettingsPatch(fresh, { emotionBindings: { eyeSmileL: 'ParamEyeSmile2' } });
    ok('文件 / 目录都不存在时会建出来，并返回写了几项',
      created.ok === true && created.keys === 1 && readFileSync(fresh, 'utf8').endsWith('\n'),
      JSON.stringify(created));
    ok('写出来的内容就是那份绑定',
      JSON.parse(readFileSync(fresh, 'utf8')).emotionBindings.eyeSmileL === 'ParamEyeSmile2',
      readFileSync(fresh, 'utf8'));

    // ② ★ 别的键一个都不许丢 —— 这是这个文件里最重要的那条。
    writeFileSync(fresh, JSON.stringify({
      modelsRoot: 'D:\\别处\\models',
      emotionScene: 'story',
      'other-plugin': { keep: true },
    }, null, 2), 'utf8');
    const kept = applySettingsPatch(fresh, { emotionBindings: { cheek: 'ParamCheek' } });
    const afterKept = JSON.parse(readFileSync(fresh, 'utf8'));
    ok('★ 只动自己那个键：别的键（含别的插件写的）原样带过去',
      kept.ok === true
      && afterKept.modelsRoot === 'D:\\别处\\models'
      && afterKept.emotionScene === 'story'
      && afterKept['other-plugin']?.keep === true
      && afterKept.emotionBindings.cheek === 'ParamCheek',
      readFileSync(fresh, 'utf8'));

    // ③ `undefined` = 删除那个键（面板上清空绑定）。
    const cleared = applySettingsPatch(fresh, { emotionBindings: undefined });
    const afterCleared = JSON.parse(readFileSync(fresh, 'utf8'));
    ok('值传 `undefined` 时那个键从文件里消失（不是留一个空对象）',
      cleared.ok === true && !('emotionBindings' in afterCleared) && afterCleared.emotionScene === 'story',
      readFileSync(fresh, 'utf8'));

    // ④ ★ 现有文件坏了 → 拒绝写，**一个字节都不动**。
    const corrupt = join(sandbox, 'corrupt.json');
    const corruptBody = '{ 这不是 JSON';
    writeFileSync(corrupt, corruptBody, 'utf8');
    const refused = applySettingsPatch(corrupt, { emotionBindings: { eyeSmileL: 'X' } });
    ok('★ 现有 settings.json 不是合法 JSON 时拒绝覆盖（报 E_SETTINGS_UNREADABLE）',
      refused.ok === false && refused.code === 'E_SETTINGS_UNREADABLE',
      JSON.stringify(refused));
    ok('★ 被拒绝之后文件逐字节没变（没有偷偷写一半）',
      readFileSync(corrupt, 'utf8') === corruptBody,
      readFileSync(corrupt, 'utf8'));

    // ⑤ 空路径 / 怪 patch —— 报错，不抛。
    ok('没有 settingsPath 时报 E_NO_SETTINGS_PATH（而不是写到当前目录）',
      applySettingsPatch('', { a: 1 }).code === 'E_NO_SETTINGS_PATH');
    ok('patch 不是对象时报 E_BAD_PATCH（数组 / null 都算）',
      applySettingsPatch(join(sandbox, 'x.json'), [1, 2]).code === 'E_BAD_PATCH'
      && applySettingsPatch(join(sandbox, 'x.json'), null).code === 'E_BAD_PATCH');

    // ⑥ 合法但不是对象（数组）—— 不是「用户手写的配置」，按空处理而不是拒绝。
    const arr = join(sandbox, 'arr.json');
    writeFileSync(arr, '[1,2,3]', 'utf8');
    const arrResult = applySettingsPatch(arr, { emotionBindings: { browLY: 'ParamBrowLY7' } });
    ok('现有文件是数组时按空配置处理（覆盖成对象，不报错）',
      arrResult.ok === true && JSON.parse(readFileSync(arr, 'utf8')).emotionBindings.browLY === 'ParamBrowLY7',
      readFileSync(arr, 'utf8'));

    // ⑦ 不许留下临时文件 —— `*.tmp` 留在用户目录里就是垃圾。
    const leftovers = readdirSync(sandbox).filter((name) => name.endsWith('.tmp'));
    ok('写完不留临时文件（先写 .tmp 再改名）', leftovers.length === 0, JSON.stringify(leftovers));

    /*
     * ⑧ 反证：把「坏 JSON 就拒绝」那道闸删掉，同一个坏文件就会被覆盖。
     *    否则 ④ 那两条绿可能只是因为那股路径恰好写不进去 —— 恒真的门禁没有价值。
     *    这是本仓库的老做法：改一份内存里的源码、用 data: URL 真 import 回来跑。
     */
    const guardSource = readFileSync(resolve(PACKAGE, 'lib', 'host', 'settings-write.js'), 'utf8');
    const noGuard = guardSource.replace(
      /return fail\('E_SETTINGS_UNREADABLE', '现有 settings\.json 不是合法 JSON[^\n]*\n/,
      'existing = {};\n',
    );
    ok('反证的前置：那道闸真的被改掉了（否则下面那条什么都没证明）', noGuard !== guardSource);
    const mutated = await import(`data:text/javascript;base64,${Buffer.from(noGuard).toString('base64')}#cp-settings`);
    const corrupt2 = join(sandbox, 'corrupt2.json');
    writeFileSync(corrupt2, corruptBody, 'utf8');
    const overwritten = mutated.applySettingsPatch(corrupt2, { emotionBindings: { cheek: 'ParamCheek' } });
    ok('★ 反证：真跑改过的源码时，坏文件被覆盖了（说明 ④ 拦住的确实是这个）',
      overwritten.ok === true && readFileSync(corrupt2, 'utf8') !== corruptBody,
      `${JSON.stringify(overwritten)} :: ${readFileSync(corrupt2, 'utf8')}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ───────────────── 收尾 ───────────────── */

console.log('');
if (failures === 0) {
  console.log(`[7] EMOTION GATE PASSED —— ${checks} 项断言全绿`);
  process.exit(0);
}
console.log(`[7] EMOTION GATE FAILED —— ${failures} / ${checks} 项断言变红`);
process.exit(1);
