/**
 * test-capabilities.mjs — 门禁：模型能力清单（`model:capabilities`）。
 *
 * 用法:
 *   node tools/test-capabilities.mjs
 *
 * 为什么需要它:
 *   方案文档 §4.3 把能力清单定为 Host ↔ Client 的冻结契约，§5.2 说 P2 与 P3
 *   **都**只通过它耦合；验收标准 §6.1 #7 写的是「能力清单与模型实际参数 / 动作组
 *   **逐项一致**（自动比对，作为回归测试）」—— 这个文件就是那个自动比对。
 *
 * 它比看上去重要:
 *   清单错了不会让任何东西崩溃，只会让 AI 说出一个不存在的表情名、或者用一个
 *   模型里根本没有的参数。那种问题在真机上表现为「AI 有点笨」，而不是报错 ——
 *   所以只能在门禁里逐项比。
 *
 * 三件事必须同时成立:
 *   1. JSON 能读出来的三样（表情 / 动作组 / 可点区域）与**独立重解析**的结果一致。
 *   2. Core 枚举出来的参数与清单里的参数**逐项一致**（id、min、max、def，含顺序）。
 *   3. `normalizeCapabilities(buildCapabilities(x))` 等于 `buildCapabilities(x)`
 *      —— 这条是 Host 与 Client 不会各自理解成不同形状的唯一保证。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DEFAULT_MAX_LISTED_PARAMETERS,
  DEFAULT_MOTION_FADE_SECONDS,
  MOUTH_PARAMETER_IDS,
  buildCapabilities,
  capabilitiesDigest,
  capabilitiesEqual,
  capabilitiesFromSettings,
  describeCapabilities,
  expressionFileTable,
  motionFileTable,
  normalizeCapabilities,
  resolveMotionFades,
  summarizeCapabilities,
} from '../dsh-live2d-pet/lib/host/capabilities.js';
import { createCore, waitForCore } from './gate-model.mjs';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`);
  }
};

const ROOT = resolve(import.meta.dirname, '..');
const CORE_PATH = join(ROOT, 'vendor', 'cubism', 'live2dcubismcore.min.js');
const SAMPLES_ROOT = join(ROOT, 'work', 'sdk5', 'CubismSdkForWeb-5-r.5', 'Samples', 'Resources');

/* ------------------------------------------------------------------ *
 * [1] 形状契约与「永不抛」
 * ------------------------------------------------------------------ */

console.log('[1] 形状契约与健壮性');

check('EMPTY 形状：四个数组', (() => {
  const empty = normalizeCapabilities(null);
  return (
    Array.isArray(empty.parameters) &&
    Array.isArray(empty.expressions) &&
    Array.isArray(empty.motionGroups) &&
    Array.isArray(empty.hitAreas)
  );
})());

{
  // 网线上来的东西什么都可能是。`normalizeCapabilities` 是 Host 的入口，
  // 它一旦抛异常就是「一个坏请求把路由打死」。
  const garbage = [null, undefined, 0, '', 'x', [], true, { a: 1 }, { parameters: 'no' }, { parameters: [null, 3, {}] }];
  let threw = null;
  for (const item of garbage) {
    try {
      const out = normalizeCapabilities(item);
      if (!Array.isArray(out.parameters) || !Array.isArray(out.expressions)) {
        threw = `形状不对：${JSON.stringify(item)}`;
        break;
      }
    } catch (error) {
      threw = `${JSON.stringify(item)} → ${error?.message}`;
      break;
    }
  }
  check('垃圾输入不抛异常且形状恒定', threw === null, threw ?? '');
}

check(
  '没有 id 的参数被丢掉（它无法被任何指令引用）',
  normalizeCapabilities({ parameters: [{ id: '', min: 1 }, { id: 'A', min: 1, max: 2, def: 0 }] }).parameters.length === 1,
);
check(
  'NaN / Infinity / 字符串数字都落到 0（不让 NaN 进 prompt）',
  (() => {
    const out = normalizeCapabilities({ parameters: [{ id: 'A', min: NaN, max: Infinity, def: '3' }] }).parameters[0];
    return out.min === 0 && out.max === 0 && out.def === 0;
  })(),
);
check(
  '没有名字的表情被丢掉',
  normalizeCapabilities({ expressions: [{ name: '  ' }, { name: 'F01', file: 'f.exp3.json' }] }).expressions.length === 1,
);
check(
  '动作组数量取整且不为负',
  normalizeCapabilities({ motionGroups: [{ name: 'Idle', count: -5 }, { name: 'Tap', count: 2.9 }] }).motionGroups.every(
    (g) => Number.isInteger(g.count) && g.count >= 0,
  ),
);
check(
  '可点区域两个字段都空才丢',
  normalizeCapabilities({ hitAreas: [{ id: 'HitArea', name: 'Head' }, { id: '', name: '' }] }).hitAreas.length === 1,
);
check(
  '超长字符串被夹断',
  normalizeCapabilities({ expressions: [{ name: 'x'.repeat(500) }] }).expressions[0].name.length === 128,
);
check(
  '参数数量上限生效',
  normalizeCapabilities({
    parameters: Array.from({ length: 900 }, (_, i) => ({ id: `P${i}`, min: 0, max: 1, def: 0 })),
  }).parameters.length === 512,
);

/* ------------------------------------------------------------------ *
 * [2] 真实官方样本：JSON 三样 vs 独立重解析
 * ------------------------------------------------------------------ */

console.log('');
console.log('[2] 8 个官方样本：表情 / 动作组 / 可点区域');

if (!readFileSync) {
  console.error('[x] 读不到文件系统');
  process.exit(1);
}

const sampleNames = ['Haru', 'Hiyori', 'Mao', 'Mark', 'Natori', 'Ren', 'Rice', 'Wanko'];
const samples = [];

for (const name of sampleNames) {
  const dir = join(SAMPLES_ROOT, name);
  const jsonPath = join(dir, `${name}.model3.json`);
  const settings = JSON.parse(readFileSync(jsonPath, 'utf8'));
  samples.push({ name, dir, settings, mocPath: join(dir, `${name}.moc3`) });
}

check(`找到 ${sampleNames.length} 个官方样本`, samples.length === sampleNames.length);

for (const sample of samples) {
  const caps = capabilitiesFromSettings(sample.settings);

  /*
   * 独立重解析：这里**故意不用** capabilitiesFromSettings，直接按 model3.json
   * 的原始结构数一遍。如果两边都用同一个函数，那这个断言只能证明「函数是纯函数」，
   * 证明不了它读对了字段。
   */
  const rawExpressions = (sample.settings.FileReferences?.Expressions ?? []).map((e) => e.Name);
  const rawMotions = Object.entries(sample.settings.FileReferences?.Motions ?? {}).map(([k, v]) => [k, v.length]);
  const rawHitAreas = (sample.settings.HitAreas ?? []).map((h) => h.Name);

  const expOk =
    caps.expressions.length === rawExpressions.length &&
    caps.expressions.every((e, i) => e.name === rawExpressions[i]);
  const motionOk =
    caps.motionGroups.length === rawMotions.length &&
    caps.motionGroups.every((g, i) => g.name === rawMotions[i][0] && g.count === rawMotions[i][1]);
  const hitOk = caps.hitAreas.length === rawHitAreas.length && caps.hitAreas.every((h, i) => h.name === rawHitAreas[i]);

  check(
    `${sample.name}：表情 ${caps.expressions.length} / 动作组 ${caps.motionGroups.length} / 可点区域 ${caps.hitAreas.length}`,
    expOk && motionOk && hitOk,
    JSON.stringify({ expOk, motionOk, hitOk, caps }),
  );
  check(
    `${sample.name}：表情带了文件引用`,
    caps.expressions.every((e) => e.file.endsWith('.exp3.json')),
    JSON.stringify(caps.expressions.slice(0, 2)),
  );
  check(
    `${sample.name}：动作组数量与文件里的动作条数一致`,
    caps.motionGroups.every((g) => g.count > 0),
    JSON.stringify(caps.motionGroups),
  );
}

/*
 * Mark 是「一个没有表情的模型」的代表 —— 模型定义里没有 Expressions 是**合法**的。
 * 这条断言钉的是「不要把『没有表情』当成『包坏了』」：一个正常模型不该被标红。
 */
{
  const mark = samples.find((s) => s.name === 'Mark');
  check('Mark 确实没有表情（用它钉住「缺字段不是坏包」）', capabilitiesFromSettings(mark.settings).expressions.length === 0);
}

/* ------------------------------------------------------------------ *
 * [3] ★ 参数逐项一致（验收标准 §6.1 #7）
 * ------------------------------------------------------------------ */

console.log('');
console.log('[3] ★ 参数逐项一致（Core 枚举 vs 能力清单）');

const Core = createCore(CORE_PATH);
const coreInfo = await waitForCore(Core);
console.log(`    Core 版本 0x${coreInfo.version.toString(16)}（初始化 ${coreInfo.elapsedMs}ms）`);

/**
 * 直接从 Core 枚举参数 —— 这是「模型实际参数」的定义，与插件实现无关。
 *
 * ⚠️ 注意 Core 的 API 形状（踩过一次）：
 *   - `Model` 上**没有** `getParameterCount()`，参数是一整个 `model.parameters`
 *     对象（`count` / `ids` / `minimumValues` / `maximumValues` / `defaultValues`）。
 *   - `parameters.ids` 里装的是**普通 JS 字符串**，不是 `CubismId` 对象 ——
 *     写成 `handle.getString()` 会得到 `undefined`，而如果再用
 *     `typeof handle.getString === 'function' ? … : ''` 兜底，就会**静默地**
 *     为每一个参数产出空 id，最后表现成「清单里有 0 个参数」。
 *     所以这里两种形状都认，不靠单一形状。
 *
 * 插件里那句 `describeParameters()` 用的是 **Framework 包装类**
 * （`CubismModel.getParameterId(i)` 返回带 `getString()` 的 `CubismIdHandle`），
 * 是另一套 API —— 它是官方实现、逐索引读同一批数组，但门禁这里要的是
 * 不经过任何包装的原始事实。
 */
function readId(handle) {
  if (typeof handle === 'string') return handle;
  if (handle && typeof handle.getString === 'function') return handle.getString().toString();
  return '';
}

function enumerateParameters(mocPath) {
  const buffer = readFileSync(mocPath);
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const model = Core.Model.fromMoc(Core.Moc.fromArrayBuffer(ab));
  const params = model.parameters;
  const out = [];
  for (let index = 0; index < params.count; index += 1) {
    out.push({
      id: readId(params.ids[index]),
      min: params.minimumValues[index],
      max: params.maximumValues[index],
      def: params.defaultValues[index],
    });
  }
  model.release();
  return out;
}

const mocVersions = new Set();
let totalParameters = 0;

for (const sample of samples) {
  const actual = enumerateParameters(sample.mocPath);
  totalParameters += actual.length;

  // 能力清单必须**逐项**等于 Core 说的：id、min、max、def，连顺序都要一样。
  const caps = buildCapabilities({ settings: sample.settings, parameters: actual });
  const identical = JSON.stringify(caps.parameters) === JSON.stringify(actual);

  check(
    `${sample.name}：清单里 ${caps.parameters.length} 个参数与 Core 逐项一致`,
    identical,
    identical ? '' : `Core ${actual.length} 个，清单 ${caps.parameters.length} 个`,
  );

  // 数值保真：抽查第一个参数的三个数（`JSON.stringify` 相等已经覆盖了，
  // 但这条能在不一致时把**具体哪个数**打出来，省一轮排查）。
  const first = actual[0];
  const mirrored = caps.parameters[0];
  check(
    `${sample.name}：参数数值保真（${first.id} ${first.min}~${first.max} 默认 ${first.def}）`,
    mirrored.min === first.min && mirrored.max === first.max && mirrored.def === first.def,
  );

  // 这条是「独立实现」的关键：上面那个 identical 比的是同一个数组，
  // 而这里断言 Core **确实**报出了非零数量的参数 —— 否则空对空也是「一致」。
  check(`${sample.name}：Core 确实枚举出了参数（不是空对空）`, actual.length > 0, String(actual.length));

  const header = readFileSync(sample.mocPath).subarray(4, 5)[0];
  mocVersions.add(header);
}

console.log(`    8 个模型合计 ${totalParameters} 个参数，moc3 版本 ${[...mocVersions].sort((a, b) => a - b).join(' / ')}`);
check('样本覆盖 moc3 v1 / v3 / v5 / v6', [1, 3, 5, 6].every((v) => mocVersions.has(v)), [...mocVersions].join(','));

/*
 * ★ 参数 id 的**大小写不统一**，这是真机上会咬人的一件事：
 *   官方样本里 Wanko 用的是 `PARAM_ANGLE_X`，其余模型用 `ParamAngleX`。
 *   所以清单必须原样搬运 id —— 任何「规范化成驼峰」「转小写」的善意整理
 *   都会让 P3 的 AI 指令在这些模型上全部失效，而且不报错（找不到参数就静默无效）。
 */
{
  const wanko = samples.find((s) => s.name === 'Wanko');
  const wankoIds = enumerateParameters(wanko.mocPath).map((p) => p.id);
  const haruIds = enumerateParameters(samples[0].mocPath).map((p) => p.id);
  check('确实存在全大写参数 id 的模型（Wanko）', wankoIds.some((id) => id === 'PARAM_ANGLE_X'), wankoIds.slice(0, 3).join(','));
  check('也存在驼峰参数 id 的模型（Haru）', haruIds.some((id) => id === 'ParamAngleX'), haruIds.slice(0, 3).join(','));
  check(
    '清单原样搬运 id，不做任何大小写整理',
    JSON.stringify(buildCapabilities({ settings: wanko.settings, parameters: enumerateParameters(wanko.mocPath) }).parameters) ===
      JSON.stringify(enumerateParameters(wanko.mocPath)),
  );
}

/*
 * 口型通道用的是这两个参数，而 P2 的整个口型联动都建在它们上面。
 * 至少要有模型带 ParamMouthOpenY —— 不然「用官方样本验收口型」这件事根本不成立。
 */
{
  const withMouth = samples.filter((s) =>
    enumerateParameters(s.mocPath).some((p) => p.id === MOUTH_PARAMETER_IDS[0]),
  );
  check(`至少一个官方样本带 ${MOUTH_PARAMETER_IDS[0]}（${withMouth.length} 个）`, withMouth.length > 0, String(withMouth.length));
}

/* ------------------------------------------------------------------ *
 * [4] Host 与 Client 不会各自理解成不同形状
 * ------------------------------------------------------------------ */

console.log('');
console.log('[4] normalize ∘ build 恒等式');

for (const sample of samples) {
  const built = buildCapabilities({ settings: sample.settings, parameters: enumerateParameters(sample.mocPath) });
  const roundTripped = normalizeCapabilities(built);
  check(
    `${sample.name}：normalize(build(x)) 逐字段等于 build(x)`,
    JSON.stringify(roundTripped) === JSON.stringify(built),
  );
  check(
    `${sample.name}：JSON 往返（模拟走一趟 HTTP）后清单不变`,
    JSON.stringify(normalizeCapabilities(JSON.parse(JSON.stringify(built)))) === JSON.stringify(built),
  );
}

/* ------------------------------------------------------------------ *
 * [5] 给 LLM 的文本
 * ------------------------------------------------------------------ */

console.log('');
console.log('[5] describeCapabilities 文本');

{
  const haru = samples.find((s) => s.name === 'Haru');
  const caps = buildCapabilities({ settings: haru.settings, parameters: enumerateParameters(haru.mocPath) });
  const text = describeCapabilities(caps);

  check('提到「不要编造」（这是这段文本存在的理由）', text.includes('不要编造'));
  check('列出全部 8 个表情名', caps.expressions.every((e) => text.includes(e.name)), text);
  check('动作组带了数量', text.includes('Idle（2 个动作）') && text.includes('TapBody（4 个动作）'));
  check('列出了可点区域', text.includes('Head') && text.includes('Body'));
  check('说明参数总数', text.includes(`共 ${caps.parameters.length} 个`), text.slice(0, 200));
  check('没说谎：列出的参数个数与声称的一致', (() => {
    const m = text.match(/下面列出 (\d+) 个/);
    const claimed = m ? Number(m[1]) : -1;
    const ids = caps.parameters.filter((p) => text.includes(`${p.id}（`)).length;
    return claimed === Math.min(caps.parameters.length, DEFAULT_MAX_LISTED_PARAMETERS) && ids === claimed;
  })());
  check('截断时说清了还有多少个没列', text.includes('另有'));

  // 口型参数必须永远在列，哪怕它们排在很后面 —— P2/P3 都要靠它们。
  check(
    `口型参数 ${MOUTH_PARAMETER_IDS[0]} 在列（即使超出了默认上限）`,
    text.includes(`${MOUTH_PARAMETER_IDS[0]}（`),
    text,
  );

  // 上限调小之后仍然要给出**可引用**的名字，而不是退化成「省略」。
  const short = describeCapabilities(caps, { maxParameters: 1 });
  check('maxParameters=1 时仍然列出 1 个真实参数 id', caps.parameters.some((p) => short.includes(`${p.id}（`)));
  check('maxParameters 不是数字时退回默认', describeCapabilities(caps, { maxParameters: 'x' }).includes(`下面列出 ${DEFAULT_MAX_LISTED_PARAMETERS} 个`));
}

check('空清单给出可读的话而不是空串', (() => {
  const text = describeCapabilities(null);
  return typeof text === 'string' && text.length > 0 && !text.includes('undefined') && !text.includes('NaN');
})());

check('文本里永远不出现 undefined / NaN', samples.every((s) => {
  const text = describeCapabilities(buildCapabilities({ settings: s.settings, parameters: enumerateParameters(s.mocPath) }));
  return !text.includes('undefined') && !text.includes('NaN');
}));

/* ------------------------------------------------------------------ *
 * [6] 摘要、指纹、相等
 * ------------------------------------------------------------------ */

console.log('');
console.log('[6] 摘要 / 指纹 / 相等');

{
  const haru = buildCapabilities({
    settings: samples[0].settings,
    parameters: enumerateParameters(samples[0].mocPath),
  });
  const mao = buildCapabilities({
    settings: samples[2].settings,
    parameters: enumerateParameters(samples[2].mocPath),
  });

  check('相同清单指纹相同', capabilitiesDigest(haru) === capabilitiesDigest(JSON.parse(JSON.stringify(haru))));
  check('不同模型指纹不同', capabilitiesDigest(haru) !== capabilitiesDigest(mao));
  check('指纹带上四个计数（便于看日志）', /^[0-9a-f]{8}-p\d+-e\d+-m\d+-h\d+$/.test(capabilitiesDigest(haru)), capabilitiesDigest(haru));

  check('capabilitiesEqual 对相同清单为真', capabilitiesEqual(haru, JSON.parse(JSON.stringify(haru))));
  check('capabilitiesEqual 对不同模型为假', capabilitiesEqual(haru, mao) === false);

  // 顺序敏感是刻意的：顺序变了说明换了模型，而「换模型要重新注入清单」正是它的用途。
  const reordered = {
    ...haru,
    motionGroups: [...haru.motionGroups].reverse(),
  };
  check('顺序不同就算不同（换模型要重新注入清单）', capabilitiesEqual(haru, reordered) === false);

  check('少一个参数就算不同', (() => {
    const fewer = { ...haru, parameters: haru.parameters.slice(1) };
    return capabilitiesEqual(haru, fewer) === false;
  })());

  // min/max 改一点点也必须被发现 —— 这是「逐项一致」里最容易漏的一维。
  check('只改一个参数的 max 也算不同', (() => {
    const tweaked = JSON.parse(JSON.stringify(haru));
    tweaked.parameters[0].max += 0.5;
    return capabilitiesEqual(haru, tweaked) === false;
  })());

  console.log(`    Haru ${capabilitiesDigest(haru)}  ${summarizeCapabilities(haru)}`);
  console.log(`    Mao  ${capabilitiesDigest(mao)}  ${summarizeCapabilities(mao)}`);
  check('摘要是中文且不含 undefined', summarizeCapabilities(haru).includes('个参数'));
  check('空清单摘要说得清楚', summarizeCapabilities(null) === '能力清单还是空的（模型还没加载完）');
}

/* ------------------------------------------------------------------ *
 * [7] 反向验证
 * ------------------------------------------------------------------ */

console.log('');
console.log('[7] 反向验证');

{
  /*
   * 上面那些「逐项一致」的断言，只有在**清单可能出错**时才有意义。
   * 这里用一个退化的实现证明它们真的会红：如果清单把参数全丢了，
   * `[3]` 段的相等断言必须失败。
   */
  const haru = samples[0];
  const actual = enumerateParameters(haru.mocPath);
  const degenerate = normalizeCapabilities({ parameters: [], expressions: [], motionGroups: [], hitAreas: [] });

  check('退化实现（清单为空）确实与真实参数不等', JSON.stringify(degenerate.parameters) !== JSON.stringify(actual));
  check('退化实现的指纹也不同', capabilitiesDigest(degenerate) !== capabilitiesDigest(buildCapabilities({ settings: haru.settings, parameters: actual })));

  // 少读一个字段也要能被发现：这里模拟「忘了读 Expressions」。
  const noExpressions = buildCapabilities({ settings: { ...haru.settings, FileReferences: { ...haru.settings.FileReferences, Expressions: undefined } }, parameters: actual });
  check('漏读 Expressions 会被发现', capabilitiesEqual(noExpressions, buildCapabilities({ settings: haru.settings, parameters: actual })) === false);

  // 而「真的没有表情的模型」（Mark）不该因为这条就报错。
  const mark = samples.find((s) => s.name === 'Mark');
  check('真没表情的模型不算异常', capabilitiesFromSettings(mark.settings).expressions.length === 0);
}

/* ------------------------------------------------------------------ *
 * [8] ★ 两半区共用一张「文件表」
 * ------------------------------------------------------------------ */

console.log('');
console.log('[8] ★ 动作 / 表情的文件表（Host 与渲染端共用同一份解读）');

/*
 * 这一段钉的是 §6.1 #7 在**渲染端那半边**的覆盖。
 *
 * 以前 Host 与渲染端各自数了一遍 `FileReferences`：Host 走
 * `capabilitiesFromSettings()`，渲染端走 `PetModel._collectMotionFiles()`。
 * 真实模型上两者一致（10 个都验过），但边缘形状上不一致 —— 而那正是**用户自己
 * 往模型库里丢模型**时会遇到的形状（第三方导出工具的小写字段名、空动作组、
 * 重名表情）。症状一律是「AI 被告诉某个表情存在，渲染端说找不到」，不报错。
 *
 * 现在渲染端直接调 `motionFileTable()` / `expressionFileTable()`，所以「两边
 * 理解不一致」这件事在代码里**表达不出来**。下面既钉那些语义，也钉这份共用关系。
 */

/** 每个边缘形状：`[说明, FileReferences, 期望的动作组 [名, 数量][], 期望的表情名[]]`。 */
const SHAPES = [
  ['空动作组', { Motions: { Idle: [] }, Expressions: [] }, [], []],
  ['非数组动作组（null）', { Motions: { Idle: null }, Expressions: [] }, [], []],
  ['非数组动作组（对象）', { Motions: { Idle: { File: 'a' } }, Expressions: [] }, [], []],
  ['Motions 本身是数组', { Motions: [{ File: 'a.motion3.json' }], Expressions: [] }, [], []],
  ['空组名', { Motions: { '': [{ File: 'a.motion3.json' }] }, Expressions: [] }, [], []],
  ['组名两侧有空格', { Motions: { ' Idle ': [{ File: 'a.motion3.json' }] }, Expressions: [] }, [['Idle', 1]], []],
  ['条目里 File 为空仍占位', { Motions: { Idle: [null, { File: 'a.motion3.json' }] }, Expressions: [] }, [['Idle', 2]], []],
  ['小写字段名的表情', { Motions: {}, Expressions: [{ name: '笑', file: 'e.exp3.json' }] }, [], ['笑']],
  ['表情有名字没路径', { Motions: {}, Expressions: [{ Name: '笑' }] }, [], []],
  ['表情重名只留一个', { Motions: {}, Expressions: [{ Name: '笑', File: 'a.exp3.json' }, { Name: '笑', File: 'b.exp3.json' }] }, [], ['笑']],
  ['表情名两侧空格被 trim', { Motions: {}, Expressions: [{ Name: ' 笑 ', File: 'a.exp3.json' }] }, [], ['笑']],
];

check('motionFileTable 返回 Map（渲染端要按组名查）', motionFileTable({}) instanceof Map);
check('expressionFileTable 返回 Map（渲染端要按表情名查）', expressionFileTable({}) instanceof Map);
check('脏输入不抛且返回空表', [null, undefined, 0, 'x', true, []].every((v) => {
  try {
    return motionFileTable(v).size === 0 && expressionFileTable(v).size === 0;
  } catch {
    return false;
  }
}));

for (const [label, refs, wantGroups, wantExpr] of SHAPES) {
  const settings = { FileReferences: refs };
  const caps = capabilitiesFromSettings(settings);
  const gotGroups = caps.motionGroups.map((g) => [g.name, g.count]);
  const gotExpr = caps.expressions.map((e) => e.name);

  check(
    `形状「${label}」：清单与文件表逐项一致`,
    JSON.stringify(gotGroups) === JSON.stringify(wantGroups) && JSON.stringify(gotExpr) === JSON.stringify(wantExpr),
    JSON.stringify({ gotGroups, gotExpr }),
  );

  /*
   * ★ 这是「分歧表达不出来」的形式化：清单里的每一个动作组，都必须能在文件表里
   *   按**同一个名字**查到、数量相等；反过来，表里也不许有清单里没有的组。
   *   渲染端查的就是这张表，所以这一条成立就等于「AI 看到的组名，渲染端一定认得」，
   *   且「渲染端认得的组名，AI 一定听说过」。
   */
  const table = motionFileTable(refs);
  const exprTable = expressionFileTable(refs);
  const sameKeySet = (mapKeys, names) => JSON.stringify([...mapKeys].sort()) === JSON.stringify([...names].sort());
  check(
    `形状「${label}」：动作组名在清单与表之间一一对应`,
    sameKeySet(table.keys(), caps.motionGroups.map((g) => g.name)) &&
      caps.motionGroups.every((g) => table.get(g.name)?.length === g.count),
    JSON.stringify({ table: [...table.keys()], caps: caps.motionGroups }),
  );
  check(
    `形状「${label}」：表情名在清单与表之间一一对应`,
    sameKeySet(exprTable.keys(), caps.expressions.map((e) => e.name)) &&
      caps.expressions.every((e) => exprTable.get(e.name) === e.file),
    JSON.stringify({ table: [...exprTable.keys()], caps: caps.expressions }),
  );
}

/*
 * 路径**不夹断**：`text()` 的 128 字上限是给 prompt 用的，路径是给 fetch 用的。
 * 夹断一个路径等于悄悄指向另一个文件 —— 那种错误既不会报，也查不出来。
 */
{
  const longPath = `exp/${'子目录/'.repeat(40)}笑.exp3.json`;
  check('构造的路径确实超过 128 字', longPath.length > 128, String(longPath.length));
  const table = expressionFileTable({ Expressions: [{ Name: '笑', File: longPath }] });
  check('★ 超长路径原样保留（不夹断）', table.get('笑') === longPath, String(table.get('笑')?.length));

  const motionLong = `motion/${'子目录/'.repeat(40)}a.motion3.json`;
  const motions = motionFileTable({ Motions: { Idle: [{ File: motionLong }] } });
  check('★ 超长动作路径也原样保留', motions.get('Idle')?.[0]?.file === motionLong);

  // 而名字是给人看的，照旧夹断 —— 两种字段的待遇刻意不同。
  const longName = '表'.repeat(200);
  check('超长表情名仍然被夹到 128 字', expressionFileTable({ Expressions: [{ Name: longName, File: 'a.exp3.json' }] }).keys().next().value.length === 128);
}

/*
 * 淡入淡出的解读 —— 这一段是「动作对象被缓存复用」那条坑的守门人。
 *
 * `_loadMotion()` 只在**第一次创建**时应用声明值，之后每次 `playMotion()` 都在
 * 同一个对象上改。所以「这次没传 fadeMs 就什么都不写」＝「沿用上一次的值」：
 * 工具调用总带 fadeMs（默认 300），于是模型的声明值被永久替换掉。
 */
check('DEFAULT_MOTION_FADE_SECONDS 就是 actions.js 里那个 300ms', DEFAULT_MOTION_FADE_SECONDS === 0.3);
check('★ 没传 fadeMs 时写回声明值（不是沿用上一次）', (() => {
  const out = resolveMotionFades(undefined, { fadeIn: 1, fadeOut: 2 }, 5);
  return out.fadeIn === 1 && out.fadeOut === 2;
})(), JSON.stringify(resolveMotionFades(undefined, { fadeIn: 1, fadeOut: 2 }, 5)));
check('声明值缺失时退回默认 0.3 秒', (() => {
  const out = resolveMotionFades(undefined, {}, 5);
  return out.fadeIn === DEFAULT_MOTION_FADE_SECONDS && out.fadeOut === DEFAULT_MOTION_FADE_SECONDS;
})());
check('声明值是负数 / 字符串 / NaN 时退回默认', (() => {
  const out = resolveMotionFades(undefined, { fadeIn: -1, fadeOut: 'x' }, 5);
  const nan = resolveMotionFades(undefined, { fadeIn: NaN, fadeOut: Infinity }, 5);
  return out.fadeIn === 0.3 && out.fadeOut === 0.3 && nan.fadeIn === 0.3 && nan.fadeOut === 0.3;
})());
check('★ 声明值 0 是合法的「不要淡入」（不能被当成缺省）', (() => {
  const out = resolveMotionFades(undefined, { fadeIn: 0, fadeOut: 0 }, 5);
  return out.fadeIn === 0 && out.fadeOut === 0;
})());
check('★ 传了 fadeMs 时它覆盖声明值（淡入淡出取同一个值）', (() => {
  const out = resolveMotionFades(3000, { fadeIn: 1, fadeOut: 2 }, 5);
  return out.fadeIn === 3 && out.fadeOut === 3;
})(), JSON.stringify(resolveMotionFades(3000, { fadeIn: 1, fadeOut: 2 }, 5)));
check('★ fadeMs = 0 表示「立刻」，不是「用默认」', (() => {
  const out = resolveMotionFades(0, { fadeIn: 1, fadeOut: 1 }, 5);
  return out.fadeIn === 0 && out.fadeOut === 0;
})());
check('fadeMs 超上限时夹到 maxSeconds', resolveMotionFades(99999, undefined, 5).fadeIn === 5);
check('maxSeconds 不是正数时退化成不夹（而不是夹成 0）', resolveMotionFades(99999, undefined, 0).fadeIn === 99.999);
check('fadeMs 是脏值（字符串 / 负数 / null）时退回声明值', (() => {
  const want = resolveMotionFades(undefined, { fadeIn: 1, fadeOut: 2 }, 5);
  return ['300', -1, null, {}, [], NaN].every((bad) => {
    const out = resolveMotionFades(bad, { fadeIn: 1, fadeOut: 2 }, 5);
    return out.fadeIn === want.fadeIn && out.fadeOut === want.fadeOut;
  });
})());
check('resolveMotionFades 永不抛，且结果永远是有限非负数', (() => {
  const garbage = [undefined, null, 0, -1, NaN, Infinity, 'x', {}, [], true];
  const declared = [undefined, null, {}, { fadeIn: -1, fadeOut: 'x' }, { fadeIn: 0, fadeOut: 0 }];
  const caps = [undefined, null, 0, -5, NaN, 5];
  for (const a of garbage) {
    for (const b of declared) {
      for (const c of caps) {
        try {
          const out = resolveMotionFades(a, b, c);
          if (!Number.isFinite(out.fadeIn) || out.fadeIn < 0 || !Number.isFinite(out.fadeOut) || out.fadeOut < 0) return false;
        } catch {
          return false;
        }
      }
    }
  }
  return true;
})());

/*
 * 反向验证：一个「两边各自解析」的实现必须在这批形状上露馅。
 * 这里真的跑一遍旧渲染端的规则，而不是嘴上说它会怎样。
 */
{
  const oldMotionTable = (refs) => {
    const out = new Map();
    const motions = refs?.Motions;
    if (motions === null || motions === undefined || typeof motions !== 'object') return out;
    for (const group of Object.keys(motions)) {
      const list = motions[group];
      if (!Array.isArray(list) || list.length === 0) continue;
      out.set(group, list.map((item) => ({ file: typeof item?.File === 'string' && item.File.length > 0 ? item.File : '' })));
    }
    return out;
  };
  const oldExpressionTable = (refs) => {
    const out = new Map();
    const expressions = refs?.Expressions;
    if (!Array.isArray(expressions)) return out;
    for (const item of expressions) {
      if (item === null || item === undefined) continue;
      const name = typeof item.Name === 'string' && item.Name !== '' ? item.Name : '';
      const file = typeof item.File === 'string' && item.File !== '' ? item.File : '';
      if (name === '' || file === '') continue;
      out.set(name, file);
    }
    return out;
  };

  let drifted = 0;
  const driftedLabels = [];
  for (const [label, refs] of SHAPES) {
    const caps = capabilitiesFromSettings({ FileReferences: refs });
    const legacy = oldMotionTable(refs);
    const legacyExpr = oldExpressionTable(refs);

    /*
     * ★ 比对必须是**对称**的：键集合要一模一样，数量 / 路径也要一模一样。
     *
     * 只问「清单里的每一项在旧实现里也找得到」是不够的 —— 旧实现多出一个清单里
     * 没有的组（比如一个叫 `""` 的空组名），那种问法会判它合格。而「渲染端认一个
     * AI 根本不知道的组名」和「AI 说得出渲染端不认的组名」是同一个病。
     */
    const sameKeys = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const groupsOk =
      sameKeys(legacy.keys(), caps.motionGroups.map((g) => g.name)) &&
      caps.motionGroups.every((g) => legacy.get(g.name)?.length === g.count);
    const exprOk =
      sameKeys(legacyExpr.keys(), caps.expressions.map((e) => e.name)) &&
      caps.expressions.every((e) => legacyExpr.get(e.name) === e.file);
    if (!groupsOk || !exprOk) {
      drifted += 1;
      driftedLabels.push(label);
    }
  }
  check(
    '★ 退化实现（Host 与渲染端各解析一遍）确实在这批形状上不一致',
    drifted >= 3,
    `只有 ${drifted} 个形状不一致：${driftedLabels.join('、')}`,
  );
  console.log(`    退化实现在 ${drifted}/${SHAPES.length} 个形状上与清单不一致：${driftedLabels.join('、')}`);
}

/* ------------------------------------------------------------------ *
 * [10] ★ 清空清单（§13.25）—— 接线对账
 *
 * 这一节守的是「舞台不在了，清单也要跟着没了」这条**跨半区**的约定：
 * 渲染端在卸载 / 挂载时 POST `{capabilities: null}`，Host 必须真把清单丢掉，
 * 否则 AI 的指令会一路走到渲染端才被拒成 `E_ACTION_NO_MODEL`。
 *
 * 为什么这里只读源码、不跑真路由：这条路由的**行为**由 `test-emotion-stream`
 * （夹具里真 POST 一次清空）与 `host-route-checks`（打活体 Host）验；这里补的是
 * 「两边都接线了没有」—— 少一根线时，那两个门禁可能各自都是绿的。
 * ------------------------------------------------------------------ */

console.log('[10] ★ 清空清单：Host 路由与渲染端接线的对账');

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

{
  const pkg = join(ROOT, 'dsh-live2d-pet');
  const hostSource = readFileSync(join(pkg, 'lib', 'index.js'), 'utf8');
  const clientSource = stripComments(readFileSync(join(pkg, 'src', 'client', 'plugin.ts'), 'utf8'));

  check(
    'Host 在归一化之前认出「capabilities 显式为 null」这个清空请求',
    /payload\.capabilities === null/.test(hostSource),
  );
  check(
    'Host 清空时三样一起归零（清单 / digest / summary）',
    /capabilities = null;/.test(hostSource)
      && /state\.capabilitiesDigest = null;/.test(hostSource)
      && /state\.capabilitiesSummary = null;/.test(hostSource),
  );
  check(
    'Host 清空时记下来因（`capabilitiesClearedReason`），而不是只留一个 null',
    /state\.capabilitiesClearedReason = /.test(hostSource),
  );
  check(
    'Host 的 GET detail 分得清「还没报过」与「舞台不在了」',
    /state\.capabilitiesClearedReason === null/.test(hostSource) && /舞台不在了/.test(hostSource),
  );
  check(
    'Host 收到新清单时把「舞台不在了」那句话作废',
    /state\.capabilitiesClearedReason = null;/.test(hostSource),
  );

  check(
    '渲染端有 `reportCapabilitiesGone` 这个函数（POST capabilities:null）',
    /function reportCapabilitiesGone\(/.test(clientSource)
      && /capabilities: null, reason/.test(clientSource),
  );
  check(
    '★ 挂载时报 `stage-booting`（页面刷新后 Host 手里那份是刷新前的）',
    (clientSource.match(/reportCapabilitiesGone\('stage-booting'\)/g) ?? []).length === 1,
    String((clientSource.match(/reportCapabilitiesGone\('stage-booting'\)/g) ?? []).length),
  );
  check(
    '★ 卸载时报 `stage-unmounted`（而且是在 `setActionTarget(null)` 之后）',
    (clientSource.match(/reportCapabilitiesGone\('stage-unmounted'\)/g) ?? []).length === 1
      && clientSource.indexOf('setActionTarget(null);')
        < clientSource.indexOf("reportCapabilitiesGone('stage-unmounted')"),
  );
  check(
    '这个上报不抛（与其余上报同一条规矩，§9.2）',
    /catch \(err\) \{\s*reportFailure\('capabilities-clear', err\);\s*\}/.test(clientSource),
  );
}

/* ------------------------------------------------------------------ */

console.log('');
if (failures > 0) {
  console.error(`[x] CAPABILITIES GATE FAILED —— ${failures} 项失败`);
  process.exit(1);
}
console.log('[10] CAPABILITIES GATE PASSED —— 能力清单与 8 个官方模型的真实参数 / 动作组逐项一致，清空接线也对得上');
