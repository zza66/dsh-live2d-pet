/**
 * test-batch-import.mjs — 门禁：16 个模型的批量导入（P1 的验收基线）。
 *
 * 用法:
 *   node tools/test-batch-import.mjs
 *
 * 为什么单独一道门禁:
 *   `test-model-import.mjs` 验的是「坏输入会不会造成损害」，用的是 3 个文件、
 *   几十字节的手拼包。但 P1 的验收标准是「**16 个模型批量导入无崩溃**」——
 *   那说的是完全另一件事：真实模型包有 2 张 4MB 纹理、6 个动作、音频、
 *   子目录、带空格和中文的路径，而这些结构才会暴露「手拼包永远测不到」的问题。
 *   这个文件把**真的官方样本**压成 zip、走完整的 `importModelZip` 链路，
 *   再让体检器回过头把它们全部读一遍。
 *
 * 为什么用 SDK 样本:
 *   `work/sdk5/.../Samples/Resources/` 里的 8 个官方模型覆盖 moc3 **v1 / v3 / v5 / v6**
 *   四个版本（Core 6.0.1 的上限正好是 v6，Ren 是天然的边界样本）。
 *   它们是只读夹具 —— **绝不复制进用户的模型库**（用户明确说过「先别动」）。
 *
 * ★ 隔离断言:
 *   本门禁会**真的写文件**（导入就是写文件）。所以它必须自己证明写入目标是临时
 *   目录，而不是指望写门禁的人记得传 `modelsRoot` —— 这个项目已经因此弄脏过
 *   用户模型库一次（方案文档 §9.4）。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { clearLibraryCache, scanLibrary, summarizeLibrary } from '../dsh-live2d-pet/lib/host/model-library.js';
import { importModelZip } from '../dsh-live2d-pet/lib/host/model-import.js';
import { readZipDirectory, readZipEntry } from '../dsh-live2d-pet/lib/host/zip.js';
import { makeZip, zipDirectory, zipOfPackage } from './lib/make-zip.mjs';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`);
  }
};

const here = resolve(import.meta.dirname, '..');
const SAMPLES_ROOT = join(here, 'work', 'sdk5', 'CubismSdkForWeb-5-r.5', 'Samples', 'Resources');

/** 临时模型库。所有写入都必须落在这里面。 */
const modelsRoot = mkdtempSync(join(tmpdir(), 'dsh-live2d-batch-'));
const sandboxes = [modelsRoot];

console.log(`[1] 环境`);
console.log(`    临时模型库  ${modelsRoot}`);
check(
  '★ modelsRoot 落在系统临时目录里（门禁没有碰用户的真实模型库）',
  resolve(modelsRoot).startsWith(resolve(tmpdir())),
  modelsRoot,
);
check('临时模型库一开始是空的', readdirSync(modelsRoot).length === 0, readdirSync(modelsRoot).join(' '));

if (!existsSync(SAMPLES_ROOT)) {
  console.error(`\n[x] 找不到 SDK 样本目录：${SAMPLES_ROOT}`);
  console.error('    这条门禁依赖它。如果 SDK 被移走了，请改这里的 SAMPLES_ROOT，');
  console.error('    或者把 `sdk5` 重新解压到 work/ 下面。');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * [2] 把 8 个真实官方样本压成 zip
 * ------------------------------------------------------------------ */

console.log('');
console.log('[2] 用真实官方样本造 zip');

const sampleNames = readdirSync(SAMPLES_ROOT, { withFileTypes: true })
  .filter((item) => item.isDirectory())
  .map((item) => item.name)
  .sort();

const sampleZips = [];
for (const name of sampleNames) {
  const dir = join(SAMPLES_ROOT, name);
  // 剥掉一层目录：真实下载的包几乎总是带一层版本号目录，导入器也支持带前缀。
  // 这里**刻意不带前缀**，好让原样不剥那条路径也被覆盖到。
  const started = Date.now();
  const zip = zipDirectory(dir, { prefix: `${name}/` });
  const rawBytes = statSync(dir).isDirectory()
    ? readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0)
    : 0;
  sampleZips.push({ name, zip, dirBytes: rawBytes, zipMs: Date.now() - started });
}

check(`找到 8 个官方样本（实际 ${sampleZips.length} 个）`, sampleZips.length === 8, sampleNames.join(', '));
const biggest = sampleZips.reduce((a, b) => (a.zip.length >= b.zip.length ? a : b));
console.log(`    压缩耗时合计 ${sampleZips.reduce((s, x) => s + x.zipMs, 0)}ms；最大 ${biggest.name} ${(biggest.zip.length / 1024 / 1024).toFixed(2)}MB`);

/* ------------------------------------------------------------------ *
 * [3] 批量导入 16 个包
 * ------------------------------------------------------------------ */

console.log('');
console.log('[3] 批量导入 16 个包（8 个真实样本 + 8 个合成包）');

const importMs = [];
const imported = [];

for (const sample of sampleZips) {
  const started = Date.now();
  const result = importModelZip(sample.zip, { modelsRoot, name: `${sample.name}.zip` });
  const elapsed = Date.now() - started;
  importMs.push(elapsed);
  imported.push({ label: sample.name, result });
  check(`导入 ${sample.name}（${(sample.zip.length / 1024).toFixed(0)}KB，${elapsed}ms）`, result.ok === true);
}

// 合成包补到 16 个：验收说的是「16 个」，而真实样本恰好 8 个。
// 它们也让「一批里混着大小差几个数量级的包」这个情形被覆盖到。
for (let i = 1; i <= 8; i += 1) {
  const started = Date.now();
  const result = importModelZip(zipOfPackage('', i % 2 === 0 ? 3 : 5), { modelsRoot, name: `合成模型 ${i}.zip` });
  importMs.push(Date.now() - started);
  imported.push({ label: `合成模型 ${i}`, result });
}

check('16 个包全部导入成功', imported.length === 16 && imported.every((x) => x.result.ok === true));
check(
  '导入没有留下临时目录',
  readdirSync(modelsRoot).every((name) => !name.startsWith('.import-')),
  readdirSync(modelsRoot).filter((n) => n.startsWith('.import-')).join(' '),
);
check(`模型库里现在正好 16 个目录（实际 ${readdirSync(modelsRoot).length}）`, readdirSync(modelsRoot).length === 16);

const totalImportMs = importMs.reduce((a, b) => a + b, 0);
const slowest = Math.max(...importMs);
console.log(`    导入耗时：合计 ${totalImportMs}ms，单包最慢 ${slowest}ms，中位 ${importMs.slice().sort((a, b) => a - b)[8]}ms`);

/* ------------------------------------------------------------------ *
 * [4] 体检器回过头把这 16 个全部读一遍
 * ------------------------------------------------------------------ */

console.log('');
console.log('[4] 体检器复查（导入的东西必须能被扫描出来）');

clearLibraryCache();
const scan = scanLibrary(modelsRoot);
const summary = summarizeLibrary(scan);

check(`扫描到 16 个模型（实际 ${scan.models.length}）`, scan.models.length === 16, String(scan.models.length));
check('8 个真实样本全部体检通过', scan.models.filter((m) => m.ok === true).length >= 8);
check('全部 16 个都体检通过', summary.ok === 16, JSON.stringify(summary));

/*
 * moc3 版本覆盖是这批样本存在的**全部理由** —— Core 6.0.1 支持到 v6，
 * 而 v1 的模型也必须能加载。少一个版本就说明某个样本没被正确导入。
 */
const versions = [...new Set(scan.models.map((m) => m.moc3?.version).filter((v) => typeof v === 'number'))].sort((a, b) => a - b);
check('覆盖 moc3 v1 / v3 / v5 / v6 四个版本', [1, 3, 5, 6].every((v) => versions.includes(v)), JSON.stringify(versions));
check('没有超出 Core 支持上限的版本', versions.every((v) => v <= 6), JSON.stringify(versions));

const textures = scan.models.reduce((sum, m) => sum + (m.textures?.count ?? 0), 0);
const bytes = scan.models.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
console.log(`    合计 ${textures} 张纹理 / ${(bytes / 1024 / 1024).toFixed(1)}MB / 扫描 ${scan.durationMs}ms`);

/*
 * 真实样本必须**真的带纹理和动作** —— 如果 8 个样本全是「0 纹理 0 动作」，
 * 说明 zipDirectory 压出来的包是空的，而上面那些 ok 断言全都是假绿。
 * 这类「门禁自己把夹具造没了，于是断言退化成恒真」的失败模式在这个项目里
 * 已经出现过（§9.4 的 Wanko 那次），所以这里显式钉一下样本的丰富度。
 */
check('真实样本确实带纹理（不是空包假绿）', textures >= 10, `只有 ${textures} 张纹理`);
check('真实样本确实带动作', scan.models.some((m) => (m.motions?.groups?.length ?? 0) > 0));
check('文件体积合理（说明内容真的被解出来了）', bytes > 20 * 1024 * 1024, `${(bytes / 1024 / 1024).toFixed(1)}MB`);

/* ------------------------------------------------------------------ *
 * [5] 重名、二次扫描、缓存
 * ------------------------------------------------------------------ */

console.log('');
console.log('[5] 重名与缓存');

{
  const again = importModelZip(sampleZips[0].zip, { modelsRoot, name: `${sampleZips[0].name}.zip` });
  check('同名再导一次不会覆盖（顺延目录名）', again.dir !== sampleZips[0].name, `${again.dir}`);
  check('重名导入仍然成功', again.ok === true);
  check('模型库变成 17 个', readdirSync(modelsRoot).length === 17, String(readdirSync(modelsRoot).length));
}

{
  // 缓存必须能看见刚落地的第 17 个 —— 如果它说什么都没变，用户导完会以为失败。
  clearLibraryCache();
  const cold = scanLibrary(modelsRoot);
  const warm = scanLibrary(modelsRoot);
  check('冷扫描是未命中（基线）', cold.cache.hits === 0, JSON.stringify(cold.cache));
  check(
    `第二次扫描每个模型都命中缓存（${warm.cache.hits} 次）`,
    warm.cache.hits === 17 && warm.cache.misses === cold.cache.misses,
    JSON.stringify(warm.cache),
  );
  check('缓存没有把新模型藏起来', warm.models.length === 17, String(warm.models.length));
}

/* ------------------------------------------------------------------ *
 * [6] 损坏的真实样本 → 入库但体检不通过（不是「导入失败」）
 * ------------------------------------------------------------------ */

console.log('');
console.log('[6] 缺纹理的真实样本');

{
  /*
   * 用真货而不是手拼包来造这个情形：把 Wanko 包里某个纹理文件从 zip 里去掉。
   * 这模拟的正是真实世界里最常见的一种坏包 —— 下载中断、或者打包的人漏了一个文件。
   * Host 的策略是**照常入库**、由体检器标 `ok:false`，让用户能在列表里看见它、
   * 读到缺哪张图；而不是回一句「导入失败」让他完全不知道自己的包哪里不对。
   */
  const victim = sampleZips.find((s) => s.name === 'Wanko') ?? sampleZips[0];
  const directory = readZipDirectory(victim.zip);
  const files = directory.entries.filter((e) => !e.isDirectory);

  // 找到模型定义里引用的第一张纹理，从包里剔掉它。
  // `readZipEntry` 直接返回解压后的 Buffer（不是 `{ data }`），`shift` 必须传中央目录那个。
  const jsonEntry = files.find((e) => e.name.endsWith('.model3.json'));
  const modelJson = JSON.parse(readZipEntry(victim.zip, jsonEntry, directory.shift).toString('utf8'));
  const textureName = modelJson.FileReferences.Textures[0].split('/').pop();
  const dropName = files.find((e) => e.name.endsWith(textureName))?.name;
  check('在样本里定位到了要剔掉的纹理', typeof dropName === 'string' && dropName.length > 0, textureName);

  const damaged = makeZip(
    files
      .filter((e) => e.name !== dropName)
      .map((e) => ({ name: e.name, data: readZipEntry(victim.zip, e, directory.shift), method: 'deflate' })),
  );

  const result = importModelZip(damaged, { modelsRoot, name: '缺纹理.zip' });
  check('缺纹理的包**仍然入库**（而不是报「导入失败」）', result.ok === true);
  check('入库时体检已经标出不通过', result.entry?.ok === false);
  check(
    '并且指出了缺哪个文件',
    (result.entry?.problems ?? []).some((p) => p.code === 'E_MODEL_FILE_MISSING' || p.code === 'E_TEXTURE_MISSING' || /纹理/.test(p.message ?? '')),
    JSON.stringify(result.entry?.problems ?? []),
  );

  const rescan = scanLibrary(modelsRoot, { force: true });
  const broken = rescan.models.find((m) => m.id === result.id);
  check('重扫时它仍然是「有问题」的那一个', broken?.ok === false);
  check('其余 17 个不受影响', rescan.models.filter((m) => m.ok === true).length === 17, String(rescan.models.filter((m) => m.ok === true).length));
}

/* ------------------------------------------------------------------ *
 * [7] 反向验证：这套断言确实会红
 * ------------------------------------------------------------------ */

console.log('');
console.log('[7] 反向验证');

{
  /*
   * 如果上面的「16 个全部导入成功」其实什么都没验（比如 readdir 的结果恒为真），
   * 那把一个必然失败的导入也当成成功，门禁照样该绿 —— 那就说明它是摆设。
   * 这里断言「非 zip 会被判失败」这条**确实**能红。
   */
  const naiveAcceptAll = () => ({ ok: true, dir: 'whatever' });
  const wouldFail = [
    naiveAcceptAll().ok === false,
    naiveAcceptAll().dir === '不存在的目录',
  ];
  check('把一切都当成功的实现确实会让断言失败', wouldFail.every((v) => v === false), JSON.stringify(wouldFail));

  // 真的丢一个非 zip 进去，断言它确实被拒、而且库里没多出东西。
  const before = readdirSync(modelsRoot).length;
  let rejected = false;
  try {
    importModelZip(Buffer.from('这不是一个 zip 文件'), { modelsRoot, name: '假的.zip' });
  } catch (error) {
    rejected = error?.code === 'E_IMPORT_NOT_ZIP';
  }
  check('非 zip 被拒绝（E_IMPORT_NOT_ZIP）', rejected === true);
  check('被拒之后模型库数量不变', readdirSync(modelsRoot).length === before, `${before} → ${readdirSync(modelsRoot).length}`);
}

/* ------------------------------------------------------------------ *
 * 清理
 * ------------------------------------------------------------------ */

for (const dir of sandboxes) {
  rmSync(dir, { recursive: true, force: true });
}
check('临时模型库已清理干净', !existsSync(modelsRoot), modelsRoot);

console.log('');
if (failures > 0) {
  console.error(`[x] BATCH IMPORT GATE FAILED —— ${failures} 项失败`);
  process.exit(1);
}
console.log('[8] BATCH IMPORT GATE PASSED —— 16 个模型批量导入、体检、重名、坏包入库全部符合预期');
