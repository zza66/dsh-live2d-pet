/**
 * 部件透明度门禁（动作文件里的 `Target: "PartOpacity"`）。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────
 *
 * 用户报：「hiyori 出现了四只手，应该是模型动作和待机动作冲突了」。
 * 直觉答案是动作与待机动作抢部件，**真因完全不同**：
 *
 * Framework 的 `CubismMotion` 确实会读动作里的 PartOpacity 曲线，但它拿
 * `model.getParameterIndex(curves[c].id)` 去查一个**部件** id
 * （`framework/src/motion/cubismmotion.ts:620-639`）。部件 id 不在参数表里，于是
 * `getParameterIndex()` 现发一个「不存在的参数下标」，而
 * `setParameterValueByIndex()` 见到那个下标，把值写进 `_notExistParameterValues`
 * 这张 Map 就 `return`（`framework/src/model/cubismmodel.ts:731-746`）。
 * 值永远到不了渲染器，**也永远不报错** —— 连「写进去再读出来」的自检都看不出问题，
 * 因为读的那一头（同文件 `:702-703`）也是从那张 Map 读的。
 *
 * 全框架里唯一认真写部件不透明度的是 `CubismPose`（`CubismUpdateOrder` 里的姿态
 * 800），而它需要 `Pose.json` —— 本库四个模型一个都没声明
 * ⇒ **动作里的部件切换曲线在这个框架里是一条死代码。**
 *
 * hiyori 的 10 段动作每段都带 `PartArmA` / `PartArmB` 两条曲线，负责说明「这一段该
 * 露哪一双手臂」，而两个部件出厂不透明度都是 1 ⇒ 两套手臂同时可见。
 *
 * 修法：自己解析、逐帧用公开 API `CubismModel.setPartOpacityById()` 写
 * （`src/client/part-curves.ts` + `pet-model.ts` 的 `_applyPartOpacity()`），
 * 不改 `framework/`（`tools/sync-vendor.mjs --check` 要求它逐字节未改动）。
 *
 * ── 四层断言 ────────────────────────────────────────────────────────────
 *
 *   [1] 合成曲线：四种段（线性/贝塞尔/阶梯/反阶梯）的求值
 *   [2] 段边界：曲线之前、之后、正好落在关键点上
 *   [3] `motionTimeAt()`：循环取模、非循环夹取、负值与 NaN
 *   [4] ★ **真动作文件**：hiyori 10 段动作的两条曲线必须**互补**
 *       （都是 1 = 四只手，都是 0 = 没有手，两者都是这个缺陷的可见形态）
 *   [5] 源码级判据：框架那条死路径还在（前提没变）
 *   [6] 源码级判据：我们接上了它（解析、写入、时钟、播完停写）
 *   [7] 反证：上面的谓词真的抓得住
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', 'dsh-live2d-pet');
const MODEL = resolve(HERE, '..', 'models-inbox', 'hiyori_vts', 'animations');

let failures = 0;
let checks = 0;
let skipped = 0;

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

function skip(label, why) {
  skipped += 1;
  console.log(`  ○ ${label}（跳过：${why}）`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** 门禁只看代码，不看注释 —— 注释里写着 `setPartOpacityById` 不算数。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const {
  parseMotionPartOpacity,
  evaluatePartOpacity,
  motionTimeAt,
  partOpacitiesAt,
} = await import(pathToFileURL(resolve(PACKAGE, 'lib/test/part-curves.mjs')).href);

/* ───────────────── [1] 四种段的求值 ───────────────── */

section('[1] 合成曲线：四种段的求值');

// 一条曲线里塞满四种段，按顺序覆盖 0–4 秒：
//   起点 (0, 0)
//   线性段 → (1, 1)
//   贝塞尔段 → (2, 0)，控制点 (1.2, 1) 与 (1.6, 1)
//     ⇒ 四个 y 值是 1, 1, 1, 0，于是 y(t) = (1-t)³ + 3(1-t)²t + 3(1-t)t² = **1 - t³**
//       （t 是段内归一化时间）—— 手算得出来，且**不是**线性插值能凑出的数
//   阶梯段 → (3, 0.4)
//   反阶梯段 → (4, 0.9)
//
// ★ 阶梯/反阶梯的语义容易记反，这里按框架源码钉死（`cubismmotion.ts:193-202`）：
//   `steppedEvaluate()` 返回 `points[0].value` —— 段**起点**的值，也就是「这一整段
//   保持上一个关键点的值，到段尾才跳」；`inverseSteppedEvaluate()` 返回
//   `points[1].value` —— 段**终点**的值，也就是「一进这一段就跳过去」。
//   （`points` 是 `motionData.points.slice(segment.basePointIndex)`，
//   `basePointIndex` 指向段的前一个点。）
const MIXED = {
  Meta: { Duration: 4, Loop: false, AreBeziersRestricted: true },
  Curves: [
    {
      Target: 'PartOpacity',
      Id: 'PartArmA',
      Segments: [
        0, 0,
        0, 1, 1,
        1, 1.2, 1, 1.6, 1, 2, 0,
        2, 3, 0.4,
        3, 4, 0.9,
      ],
    },
  ],
};

const mixed = parseMotionPartOpacity(MIXED);
ok('[1.1] 解析出 1 条曲线', mixed.curves.length === 1, `拿到 ${mixed.curves.length} 条`);
ok('[1.2] 部件 id 是 PartArmA', mixed.curves[0]?.id === 'PartArmA');
ok('[1.3] 解析出 4 个段', mixed.curves[0]?.segments.length === 4,
  `拿到 ${mixed.curves[0]?.segments.length} 个`);
ok(
  '[1.4] 四种段的类型与顺序都读对了',
  JSON.stringify(mixed.curves[0]?.segments.map((s) => s.kind))
    === JSON.stringify(['linear', 'bezier', 'stepped', 'inverseStepped']),
);
ok('[1.5] 控制点数 = 起点 1 + 线性 1 + 贝塞尔 3 + 阶梯 1 + 反阶梯 1 = 7',
  mixed.curves[0]?.points.length === 7, `拿到 ${mixed.curves[0]?.points.length}`);
ok('[1.6] Meta 读对了（时长/循环/restricted）',
  mixed.duration === 4 && mixed.loop === false && mixed.beziersRestricted === true);

const curve = mixed.curves[0];
const at = (t) => evaluatePartOpacity(curve, t);
ok('[1.7] 起点值是 0', at(0) === 0, `拿到 ${at(0)}`);
ok('[1.8] 线性段中点 = 0.5', Math.abs(at(0.5) - 0.5) < 1e-9, `拿到 ${at(0.5)}`);
ok('[1.9] 线性段终点 = 1', at(1) === 1, `拿到 ${at(1)}`);
ok('[1.10] 贝塞尔段终点 = 0（端点与声明值一致）', at(2) === 0, `拿到 ${at(2)}`);
ok('[1.11] ★ 贝塞尔段中点 = 0.875（y = 1 - t³ 在 t=0.5 处）',
  Math.abs(at(1.5) - 0.875) < 1e-9,
  `拿到 ${at(1.5)} —— 线性插值会给 0.5，说明这里真的在跑 de Casteljau`);
ok('[1.12] ★ 贝塞尔段 t=0.25 处 = 0.984375', Math.abs(at(1.25) - 0.984375) < 1e-9,
  `拿到 ${at(1.25)}`);
ok('[1.13] 阶梯段保持**段首**值（= 前一点的 0），(3, 0.4) 要到段尾才生效',
  at(2.5) === 0 && at(2.9) === 0,
  `拿到 ${at(2.5)}/${at(2.9)} —— 框架的 steppedEvaluate() 返回的正是 points[0].value`);
ok('[1.14] 反阶梯段立刻取**段尾**值 0.9（它不等段尾）',
  at(3.1) === 0.9 && at(3.9) === 0.9,
  `拿到 ${at(3.1)}/${at(3.9)} —— 框架的 inverseSteppedEvaluate() 返回 points[1].value`);

/* ───────────────── [2] 段边界 ───────────────── */

section('[2] 段边界：曲线之前、之后、关键点上');

ok('[2.1] 曲线之前取起点值', at(-5) === 0, `拿到 ${at(-5)}`);
ok('[2.2] 曲线之后取末点值', at(99) === 0.9, `拿到 ${at(99)}`);
ok('[2.3] 正好落在段边界上不跳变（前一段的终点）',
  Math.abs(at(1) - 1) < 1e-9 && Math.abs(at(2) - 0) < 1e-9);
ok('[2.4] 只有起点的曲线是常量', (() => {
  const flat = parseMotionPartOpacity({
    Meta: { Duration: 1, Loop: true, AreBeziersRestricted: true },
    Curves: [{ Target: 'PartOpacity', Id: 'P', Segments: [0, 0.25] }],
  });
  return evaluatePartOpacity(flat.curves[0], 0) === 0.25
    && evaluatePartOpacity(flat.curves[0], 1000) === 0.25;
})());

// hiyori 真实曲线的形状：一次贝塞尔，但四个点的值全都相同。
const constant = parseMotionPartOpacity({
  Meta: { Duration: 5.07, Loop: true, AreBeziersRestricted: true },
  Curves: [
    { Target: 'PartOpacity', Id: 'PartArmA', Segments: [0, 1, 1, 1.69, 1, 3.38, 1, 5.07, 1] },
    { Target: 'PartOpacity', Id: 'PartArmB', Segments: [0, 0, 1, 1.69, 0, 3.38, 0, 5.07, 0] },
  ],
});
ok('[2.5] hiyori 那种「值全相同的贝塞尔」整段都是同一个值',
  [0, 0.5, 1.69, 3.38, 5.07, 99].every((t) => evaluatePartOpacity(constant.curves[0], t) === 1),
  `采样到 ${[0, 0.5, 1.69, 3.38, 5.07, 99].map((t) => evaluatePartOpacity(constant.curves[0], t)).join('/')}`);
ok('[2.6] partOpacitiesAt() 一次给出全部部件',
  JSON.stringify(partOpacitiesAt(constant, 2)) === JSON.stringify([
    { id: 'PartArmA', opacity: 1 },
    { id: 'PartArmB', opacity: 0 },
  ]), JSON.stringify(partOpacitiesAt(constant, 2)));

/* ───────────────── [3] motionTimeAt ───────────────── */

section('[3] motionTimeAt()：循环取模、非循环夹取、坏输入');

ok('[3.1] 循环动作取模', Math.abs(motionTimeAt(constant, 5.07 + 1.2) - 1.2) < 1e-9,
  `拿到 ${motionTimeAt(constant, 5.07 + 1.2)}`);
ok('[3.2] 非循环动作在末尾夹住', (() => {
  const once = { ...constant, loop: false };
  return motionTimeAt(once, 99) === 5.07;
})());
ok('[3.3] 负时间按 0 处理', motionTimeAt(constant, -3) === 0);
ok('[3.4] NaN 按 0 处理', motionTimeAt(constant, Number.NaN) === 0);
ok('[3.5] 时长未知（0）时原样返回，不猜周期', (() => {
  const unknown = { ...constant, duration: 0 };
  return motionTimeAt(unknown, 7.5) === 7.5;
})());

/* ───────────────── [4] ★ 真动作文件 ───────────────── */

section('[4] ★ 真动作文件：hiyori 的 10 段动作（两套手臂必须互补）');

const expectedOff = new Set(['hiyori_m06', 'hiyori_m08']);

if (!existsSync(MODEL)) {
  skip('[4] hiyori 动作文件', `样本库不在 ${MODEL}`);
} else {
  const files = readdirSync(MODEL).filter((f) => f.endsWith('.motion3.json')).sort();
  ok('[4.1] 找到 10 段动作', files.length === 10, `找到 ${files.length} 段`);

  let allTwoCurves = true;
  let allComplementary = true;
  let allConstant = true;
  let allRestricted = true;
  let allDurationMatch = true;
  const rows = [];

  for (const file of files) {
    const json = JSON.parse(readFileSync(resolve(MODEL, file), 'utf8'));
    const parsed = parseMotionPartOpacity(json);
    const name = file.replace('.motion3.json', '');
    const a = parsed.curves.find((c) => c.id === 'PartArmA');
    const b = parsed.curves.find((c) => c.id === 'PartArmB');
    if (a === undefined || b === undefined || parsed.curves.length !== 2) {
      allTwoCurves = false;
      rows.push(`${name}: 曲线数 ${parsed.curves.length}`);
      continue;
    }
    if (parsed.beziersRestricted !== true) {
      allRestricted = false;
    }
    if (Math.abs(parsed.duration - (json?.Meta?.Duration ?? -1)) > 1e-9) {
      allDurationMatch = false;
    }
    const samples = [0, 0.5, 1.7, 3.3, parsed.duration];
    const aValues = samples.map((t) => evaluatePartOpacity(a, t));
    const bValues = samples.map((t) => evaluatePartOpacity(b, t));
    if (new Set(aValues).size !== 1 || new Set(bValues).size !== 1) {
      allConstant = false;
    }
    const aOn = aValues[0];
    const bOn = bValues[0];
    const wantB = expectedOff.has(name);
    const complementary = aOn + bOn === 1 && (wantB ? bOn === 1 && aOn === 0 : aOn === 1 && bOn === 0);
    if (!complementary) {
      allComplementary = false;
    }
    rows.push(`${name}: A=${aOn} B=${bOn}${complementary ? '' : '  ★不互补'}`);
  }

  for (const row of rows) {
    console.log(`      ${row}`);
  }

  ok('[4.2] 每段动作都恰好带 PartArmA / PartArmB 两条曲线', allTwoCurves);
  ok('[4.3] 两条曲线都是常量（整段一个值）', allConstant);
  ok('[4.4] ★ 每段动作里两条曲线严格互补（A+B=1，且与文件名对得上）', allComplementary,
    '两条都是 1 就是「四只手」，两条都是 0 就是「没有手」—— 两种都是这个缺陷的可见形态');
  ok('[4.5] 全部声明 AreBeziersRestricted（求值偏差的前提不成立）', allRestricted);
  ok('[4.6] 解析出的时长与 Meta.Duration 一致', allDurationMatch);
}

/* ───────────────── [5] 框架那条死路径还在 ───────────────── */

section('[5] 源码级判据：框架把 PartOpacity 当参数写（前提没变）');

const frameworkMotion = stripComments(
  readFileSync(resolve(PACKAGE, 'framework/src/motion/cubismmotion.ts'), 'utf8'),
);
const frameworkModel = stripComments(
  readFileSync(resolve(PACKAGE, 'framework/src/model/cubismmodel.ts'), 'utf8'),
);
const frameworkPose = stripComments(
  readFileSync(resolve(PACKAGE, 'framework/src/effect/cubismpose.ts'), 'utf8'),
);

/** PartOpacity 那一段必须仍然走「参数」这条路，而不是「部件」那条。 */
function partOpacityGoesThroughParameters(source) {
  const at = source.indexOf('CubismMotionCurveTarget_PartOpacity');
  if (at < 0) {
    return false;
  }
  const window = source.slice(at, at + 1200);
  return window.includes('getParameterIndex(')
    && window.includes('setParameterValueByIndex(')
    && !window.includes('setPartOpacityByIndex(');
}

ok('[5.1] cubismmotion.ts 里 PartOpacity 仍然被当成参数写',
  partOpacityGoesThroughParameters(frameworkMotion));
ok('[5.2] setParameterValueByIndex() 对「不存在的参数」仍然写进 Map 就返回',
  /if \(this\._notExistParameterValues\.has\(parameterIndex\)\) \{[\s\S]{0,240}?return;/.test(frameworkModel));
ok('[5.3] 全框架只有 CubismPose 认真写部件不透明度',
  frameworkPose.includes('setPartOpacityByIndex') && !frameworkMotion.includes('setPartOpacityByIndex'));

const MODELS = resolve(HERE, '..', 'models-inbox');
if (existsSync(MODELS)) {
  const offenders = [];
  for (const dir of readdirSync(MODELS, { withFileTypes: true })) {
    if (!dir.isDirectory()) {
      continue;
    }
    const modelDir = resolve(MODELS, dir.name);
    for (const f of readdirSync(modelDir)) {
      if (!f.endsWith('.model3.json')) {
        continue;
      }
      const json = JSON.parse(readFileSync(resolve(modelDir, f), 'utf8'));
      if (json?.FileReferences?.Pose !== undefined) {
        offenders.push(`${dir.name}/${f}`);
      }
    }
  }
  ok('[5.4] 四个模型都没有 Pose.json（所以 CubismPose 救不了这件事）',
    offenders.length === 0, offenders.join('、'));
} else {
  skip('[5.4] 模型库', `不在 ${MODELS}`);
}

/* ───────────────── [6] 我们接上了它 ───────────────── */

section('[6] 源码级判据：渲染端自己应用了这些曲线');

const petModel = stripComments(readFileSync(resolve(PACKAGE, 'src/client/pet-model.ts'), 'utf8'));

const P = {
  parses: (s) => /parseMotionPartOpacity\(/.test(s),
  writes: (s) => /setPartOpacityById\(cachedId\(entry\.id\), entry\.opacity\)/.test(s),
  clock: (s) => /motionTimeAt\(active\.motion, this\._elapsed - active\.startedAt\)/.test(s),
  activates: (s) => /\{ motion: curves, startedAt: this\._elapsed \}/.test(s),
  stopsWhenFinished: (s) =>
    /\}\s*else\s*\{[\s\S]{0,400}?this\._activePartOpacity = null;/.test(s),
  clearsOnRelease: (s) => /this\._motionCache\.clear\(\);[\s\S]{0,200}?this\._activePartOpacity = null;/.test(s),
  warmUpCalled: (s) => /this\._ready = true;[\s\S]{0,700}?await this\._warmUpDefaultPartOpacity\(\);/.test(s),
  warmUpReadsFirst: (s) => /const group = this\.motionGroupNames\(\)\[0\];/.test(s),
  warmUpToleratesFailure: (s) => /await this\._loadMotion\(group, 0, entry\);\s*\}\s*catch\s*\{/.test(s),
  defaultPoseUsed: (s) => /partOpacitiesAt\(this\._defaultPartOpacity, 0\)/.test(s),
  defaultPoseCleared: (s) =>
    (s.match(/this\._motionPartOpacity\.clear\(\);\s*this\._activePartOpacity = null;\s*this\._defaultPartOpacity = null;/g) ?? []).length >= 2,
};

ok('[6.1] pet-model.ts 解析了动作里的部件曲线', P.parses(petModel));
ok('[6.2] pet-model.ts 用 setPartOpacityById 写进模型', P.writes(petModel));
ok('[6.3] 动作时间用同一个时钟推导（不另建）', P.clock(petModel));
ok('[6.4] 播动作时登记曲线与起算时刻', P.activates(petModel));
ok('[6.5] 动作播完就不再写（但值留在部件上）', P.stopsWhenFinished(petModel));
ok('[6.6] 释放模型时清掉这两份状态', P.clearsOnRelease(petModel));
ok('[6.7] 解析失败会被上报，不是悄悄咽掉',
  /reportFailure\('motion-part-curves', error\)/.test(petModel));
// ★ 静止姿态。没有它，模型刚加载完、第一个动作还没开始的那段时间里没人写部件
//   不透明度，两套手臂的初值都是 1 ⇒ 四只手（用户 2026-02 的截图）。
ok('[6.8] ★ 加载完就定一个静止姿态（且排在 `_ready = true` 之后）', P.warmUpCalled(petModel));
ok('[6.9] 静止姿态取的是第一个动作的曲线（顺序确定，不挑）', P.warmUpReadsFirst(petModel));
ok('[6.10] 静止姿态拿不到也不会连累模型加载', P.warmUpToleratesFailure(petModel));
ok('[6.11] 没有动作在播时真的把静止姿态写下去', P.defaultPoseUsed(petModel));
ok('[6.12] 换模型与释放模型时都清掉静止姿态', P.defaultPoseCleared(petModel));

/* ───────────────── [7] 反证 ───────────────── */

section('[7] 反证：谓词真的抓得住');

const mutations = [
  ['parses', (s) => s.replace('parseMotionPartOpacity(parsed)', 'null')],
  ['writes', (s) => s.replaceAll('model.setPartOpacityById(cachedId(entry.id), entry.opacity);', 'void entry;')],
  ['clock', (s) => s.replace('motionTimeAt(active.motion, this._elapsed - active.startedAt)', '0')],
  ['activates', (s) => s.replace('{ motion: curves, startedAt: this._elapsed }', 'null')],
  ['stopsWhenFinished', (s) => s.replaceAll('this._activePartOpacity = null;', 'void 0;')],
  ['clearsOnRelease', (s) => s.replaceAll('this._activePartOpacity = null;', 'void 0;')],
  ['warmUpCalled', (s) => s.replace('await this._warmUpDefaultPartOpacity();', 'void 0;')],
  ['warmUpReadsFirst', (s) => s.replace('this.motionGroupNames()[0]', 'undefined')],
  ['warmUpToleratesFailure', (s) => s.replace('await this._loadMotion(group, 0, entry);\n    } catch {', 'await this._loadMotion(group, 0, entry);\n    } finally {')],
  ['defaultPoseUsed', (s) => s.replace('partOpacitiesAt(this._defaultPartOpacity, 0)', '[]')],
  ['defaultPoseCleared', (s) => s.replaceAll('this._defaultPartOpacity = null;', 'void 0;')],
];

for (const [name, mutate] of mutations) {
  const broken = mutate(petModel);
  ok(`反证 ${name}：源码真的被改动了`, broken !== petModel,
    '这次突变没有命中任何字符 —— 断言是空转的');
  ok(`反证 ${name}：谓词变红`, P[name](broken) === false,
    '弄坏之后谓词仍然为真 —— 这条断言守不住它声称要守的东西');
}

ok('反证没有改动磁盘上的源码',
  stripComments(readFileSync(resolve(PACKAGE, 'src/client/pet-model.ts'), 'utf8')) === petModel);

/* ───────────────── 收尾 ───────────────── */

console.log('');
if (failures === 0) {
  const tail = skipped === 0 ? '' : `，跳过 ${skipped} 项`;
  console.log(`[7] PART CURVES GATE PASSED —— ${checks} 项断言全绿${tail}`);
  process.exit(0);
}
console.log(`[7] PART CURVES GATE FAILED —— ${failures} / ${checks} 项未通过`);
process.exit(1);
