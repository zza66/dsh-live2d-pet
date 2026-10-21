/**
 * test-model-import.mjs — 门禁：模型包导入（zip / rar 解析 + 落库策略）。
 *
 * 用法:
 *   node tools/test-model-import.mjs
 *
 * 为什么需要它:
 *   「拖一个压缩包进来」是本项目里**唯一处理不可信输入**的功能。用户从网上下载的
 *   模型包什么都可能是：损坏的、缺文件的、带路径穿越的、压缩炸弹、或者干脆不是压缩包。
 *   这些没有一个会让程序崩 —— 它们会让**模型库被写坏**，而模型库里是用户自己
 *   攒下来的模型。所以这里的断言重点不是「功能对不对」，而是「坏输入会不会造成损害」。
 *
 * zip / rar 从哪来:
 *   zip 用 `makeZip()` 现造（包括故意造坏的：CRC 篡改、截断、穿越路径、超高压缩比）；
 *   rar 用 `tools/lib/rar-fixture.mjs` 手搓的 RAR4（store 法）。两者都比从磁盘上找
 *   样本可控得多，也不需要往仓库里放二进制文件。
 *
 * 一条重要的反向验证:
 *   [3] 段不只断言「穿越被拒绝」，还**用一个天真的解压实现证明那个穿越真的会写到
 *   目录外**。否则「危险路径被拒绝」这条断言可能只是因为路径本来就无害才通过的。
 *
 * rar 那一段（[7]）有一半的断言是**条件性的**：本机没有 7-Zip / WinRAR / tar.exe 时
 * 只验「回 409 + E_IMPORT_RAR_NO_EXTRACTOR」这条路，不假装解包成功。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  MAX_ENTRIES,
  crc32,
  classifyEntryPath,
  commonTopLevel,
  decodeZipName,
  isZip,
  readZipDirectory,
  readZipEntry,
} from '../dsh-live2d-pet/lib/host/zip.js';
import {
  ImportError,
  chooseAvailableName,
  findModelFiles,
  importModelArchive,
  importModelZip,
  sanitizeLibraryName,
} from '../dsh-live2d-pet/lib/host/model-import.js';
import {
  RarError,
  assertTree,
  classifyExtractFailure,
  extractorArgs,
  extractorCandidates,
  findExtractor,
  isRar,
  rarVariant,
  runExtractor,
  walkTree,
} from '../dsh-live2d-pet/lib/host/rar.js';
import { buildRar4, rarOfPackage, rarWithoutModel } from './lib/rar-fixture.mjs';
import { clearLibraryCache, scanLibrary } from '../dsh-live2d-pet/lib/host/model-library.js';

/**
 * 造包工具与路由门禁共用（`tools/lib/host-route-checks.mjs` 也用它）——
 * 两处各写一份的话，路由门禁测的就不再是同一个格式了。
 *
 * 注意这里的 `crc32` 是**独立实现**（不是插件里那个）：这样插件算错了 CRC
 * 会表现为「合法包被判成损坏」，而不是两边一起错、测试照样绿。
 */
import { PNG_1X1, makeZip, modelPackageFiles, zipOfPackage } from './lib/make-zip.mjs';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`);
  }
};


const sandboxes = [];
function makeSandbox(tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-live2d-${tag}-`));
  sandboxes.push(dir);
  return dir;
}

function capture(fn) {
  try {
    return { value: fn(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

/** `capture` 的异步版（`importModelArchive` 因为 rar 要走外部解包器，是 async 的）。 */
async function captureAsync(fn) {
  try {
    return { value: await fn(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

/* ------------------------------------------------------------------ *
 * [1] zip 格式
 * ------------------------------------------------------------------ */

console.log('[1] zip 解析：stored / deflate、CRC、目录条目、注释');

{
  const hello = Buffer.from('hello 模型导入', 'utf8');
  const zip = makeZip([
    { name: 'a.txt', data: hello, method: 'store', utf8Flag: true },
    { name: 'sub/', data: Buffer.alloc(0), utf8Flag: true },
    { name: 'sub/b.bin', data: hello, method: 'deflate', utf8Flag: true },
  ]);

  check('isZip 认得出来', isZip(zip) === true);
  check('isZip 不会把任意字节当成 zip', isZip(Buffer.from('PK..nonsense')) === false);

  const dir = readZipDirectory(zip);
  check('条目数正确', dir.entries.length === 3, String(dir.entries.length));
  check('目录条目被识别', dir.entries[1].isDirectory === true);
  check('文件名解对', dir.entries[0].name === 'a.txt');
  check('子目录路径用正斜杠', dir.entries[2].name === 'sub/b.bin');

  const stored = readZipEntry(zip, dir.entries[0], dir.shift);
  const deflated = readZipEntry(zip, dir.entries[2], dir.shift);
  check('stored 条目内容一字节不差', stored.equals(hello));
  check('deflate 条目内容一字节不差', deflated.equals(hello));

  const commented = makeZip([{ name: 'x.txt', data: hello }], { comment: '这是一个注释，长度不为零' });
  const dir2 = readZipDirectory(commented);
  check('带注释的 zip 也能解析（EOCD 要往回找）', dir2.entries.length === 1);
  check('带注释时条目仍读得出', readZipEntry(commented, dir2.entries[0], dir2.shift).equals(hello));
}

{
  // 自解压包（前面粘了一段可执行代码）—— 所有偏移整体后移。不处理位移的话
  // 每个条目都会读到垃圾字节，而报出来的错会指向完全无关的地方。
  const inner = makeZip([{ name: 'x.txt', data: Buffer.from('payload', 'utf8') }]);
  const shifted = Buffer.concat([Buffer.from('MZ\x90\x00 fake exe stub'.padEnd(4096, ' ')), inner]);
  const result = capture(() => {
    const dir = readZipDirectory(shifted);
    return readZipEntry(shifted, dir.entries[0], dir.shift).toString('utf8');
  });
  check('自解压包（偏移整体后移）仍能正确读出内容', result.value === 'payload', String(result.error ?? result.value));
}

/* ------------------------------------------------------------------ *
 * [2] 名字编码
 * ------------------------------------------------------------------ */

console.log('\n[2] 名字编码：UTF-8（带/不带标志位）与 GBK');

{
  const utf8Name = Buffer.from('模型/贴图.png', 'utf8');
  check('标志位为 1 时按 UTF-8 解', decodeZipName(utf8Name, true) === '模型/贴图.png');
  // 现实里不少工具存的是 UTF-8 却忘了设标志位。按规范该用 CP437，那会解出乱码。
  check('标志位为 0 但字节是合法 UTF-8 时仍按 UTF-8 解', decodeZipName(utf8Name, false) === '模型/贴图.png');

  // 「模型」的 GBK 字节。Windows 上压缩中文目录最常见的就是这个组合：
  // GBK 字节 + 不设 UTF-8 标志位。
  const gbkName = Buffer.from([0xc4, 0xa3, 0xd0, 0xcd, 0x2f, 0x61, 0x2e, 0x70, 0x6e, 0x67]);
  const decoded = decodeZipName(gbkName, false);
  check('GBK 字节被解成中文而不是乱码', decoded === '模型/a.png', JSON.stringify(decoded));

  const ascii = Buffer.from('plain/ascii.png', 'utf8');
  check('纯 ASCII 不受影响', decodeZipName(ascii, false) === 'plain/ascii.png');
  check('解码永远不会抛异常', typeof decodeZipName(Buffer.from([0xff, 0xfe, 0x00]), false) === 'string');
}

/* ------------------------------------------------------------------ *
 * [3] 安全：路径穿越
 * ------------------------------------------------------------------ */

console.log('\n[3] 安全：路径穿越、绝对路径');

{
  check('`..` 被判为不安全', classifyEntryPath('../../evil.txt').kind === 'unsafe');
  check('中间的 `..` 也被判为不安全', classifyEntryPath('a/../../evil.txt').kind === 'unsafe');
  check('伪装成正常名字的 `..` 仍不安全', classifyEntryPath('a/.. /../evil.txt').kind !== 'file');
  check('绝对路径不安全', classifyEntryPath('/etc/passwd').kind === 'unsafe');
  check('盘符路径不安全', classifyEntryPath('C:/Windows/system32/x.dll').kind === 'unsafe');
  check('反斜杠穿越同样不安全', classifyEntryPath('..\\..\\evil.txt').kind === 'unsafe');
  check('正常文件被判为 file', classifyEntryPath('model/texture.png').kind === 'file');
  check('macOS 元数据被判为 junk 而不是报错', classifyEntryPath('__MACOSX/._x.png').kind === 'junk');
  check('.DS_Store 被判为 junk', classifyEntryPath('a/.DS_Store').kind === 'junk');
}

{
  const root = makeSandbox('unsafe');
  const library = join(root, 'library');
  mkdirSync(library, { recursive: true });
  // 库外面放一个「哨兵文件」，用来证明穿越如果真的发生了会写到哪。
  const outsideBefore = existsSync(join(root, 'pwned.txt'));

  const zip = makeZip([
    { name: '../pwned.txt', data: Buffer.from('escaped!', 'utf8') },
    { name: 'model.model3.json', data: Buffer.from('{}', 'utf8') },
  ]);

  const result = capture(() => importModelZip(zip, { modelsRoot: library, name: 'evil.zip' }));
  check('带穿越路径的包被拒绝', result.error !== null);
  check('拒绝时给出 E_ZIP_UNSAFE_PATH', result.error?.code === 'E_ZIP_UNSAFE_PATH', String(result.error?.code));
  check('库外没有被写出文件', outsideBefore === existsSync(join(root, 'pwned.txt')));
  check('库里没有留下任何东西', readdirSync(library).length === 0, readdirSync(library).join(','));

  /*
   * 反向验证：如果只断言「上面被拒绝了」，那有可能只是因为路径本来就无害。
   * 这里用一个**天真的解压实现**（照抄条目名直接 join + writeFileSync，不做任何
   * 分类检查）跑同一个 zip，证明那条穿越真的会写到库外面去 —— 于是上面那条
   * 断言是有价值的，而不是恒真的。
   */
  const naiveDir = join(root, 'naive');
  mkdirSync(naiveDir, { recursive: true });
  {
    const naiveEntries = readZipDirectory(zip).entries;
    let escapedTo = null;
    for (const item of naiveEntries) {
      if (item.isDirectory) continue;
      // 这就是「忘了做路径检查」的实现长什么样：只此一行之差。
      const target = join(naiveDir, item.name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, readZipEntry(zip, item, 0));
      if (!target.startsWith(naiveDir)) escapedTo = target;
    }
    check('★ 天真的解压实现确实会写到目录外（证明这个防护是必要的）', escapedTo !== null, String(escapedTo));
    check('★ 穿越的目标正是库外那个文件', existsSync(join(root, 'pwned.txt')));
    rmSync(join(root, 'pwned.txt'), { force: true });
  }
}

/* ------------------------------------------------------------------ *
 * [4] 损坏检测与限额
 * ------------------------------------------------------------------ */

console.log('\n[4] 损坏检测与限额');

{
  const good = Buffer.from('the quick brown fox', 'utf8');

  const badCrc = makeZip([{ name: 'a.txt', data: good, crcOverride: 0xdeadbeef }]);
  const r1 = capture(() => readZipEntry(badCrc, readZipDirectory(badCrc).entries[0], 0));
  check('CRC 被篡改会被发现', r1.error?.code === 'E_ZIP_CRC_MISMATCH', String(r1.error?.code));

  const truncated = makeZip([{ name: 'a.txt', data: good }]).subarray(0, 30 + 5 + 2);
  const r2 = capture(() => readZipDirectory(truncated));
  check('截断的 zip 会被发现', r2.error !== null);

  const r3 = capture(() => readZipDirectory(Buffer.from('这不是 zip，只是一段文字'.repeat(10), 'utf8')));
  check('非 zip 字节会被发现', r3.error?.code === 'E_ZIP_NOT_ARCHIVE', String(r3.error?.code));

  const r4 = capture(() =>
    importModelZip(Buffer.from('PK but not really', 'utf8'), { modelsRoot: makeSandbox('notzip') }),
  );
  check('导入非 zip 给出 E_IMPORT_NOT_ZIP', r4.error?.code === 'E_IMPORT_NOT_ZIP', String(r4.error?.code));

  // 超高压缩比：全零内容 deflate 后极小，正是压缩炸弹的形状。
  const bomb = makeZip([{ name: 'zeros.bin', data: Buffer.alloc(4 * 1024 * 1024), method: 'deflate' }]);
  const r5 = capture(() => readZipDirectory(bomb));
  check('压缩炸弹会被拦下', r5.error?.code === 'E_ZIP_BOMB_SUSPECT', String(r5.error?.code));
  // 错误码是给程序看的，`message`/`detail` 是给用户看的 —— 后者必须说人话。
  const bombText = `${r5.error?.message ?? ''} ${r5.error?.detail ?? ''}`;
  check('拦下炸弹时报的是可读的理由', /压缩比/.test(bombText), bombText);

  // 条目数上限：不真造 2001 个条目（那太慢），直接改 EOCD 里的计数，
  // 断言计数检查发生在遍历之前。
  const many = makeZip([{ name: 'a.txt', data: good }]);
  const eocdAt = many.length - 22;
  many.writeUInt16LE(MAX_ENTRIES + 1, eocdAt + 10);
  const r6 = capture(() => readZipDirectory(many));
  check('条目数超过上限会被拒绝', r6.error?.code === 'E_ZIP_TOO_MANY_ENTRIES', String(r6.error?.code));

  const bigEntry = makeZip([
    { name: 'huge.bin', data: Buffer.from('x', 'utf8'), uncompressedSizeOverride: 200 * 1024 * 1024 },
  ]);
  const r7 = capture(() => readZipDirectory(bigEntry));
  check('单条目超过单文件上限会被拒绝', r7.error?.code === 'E_ZIP_ENTRY_TOO_LARGE', String(r7.error?.code));
}

/* ------------------------------------------------------------------ *
 * [5] 导入策略
 * ------------------------------------------------------------------ */

console.log('\n[5] 导入策略：落库、剥前缀、重名、拒绝无模型的包');

{
  const library = join(makeSandbox('import'), 'library');

  const good = capture(() => importModelZip(zipOfPackage(), { modelsRoot: library, name: 'miku.zip' }));
  check('合法包导入成功', good.error === null, String(good.error));
  check('目录名取自 zip 文件名', good.value?.dir === 'miku', String(good.value?.dir));
  check('模型定义路径正确', good.value?.path === 'miku/model.model3.json', String(good.value?.path));
  // 展示名来自体检器（模型库列表里显示的那个），不一定是文件名 —— 这里两者恰好相同。
  check('展示名来自体检器', good.value?.name === 'model', String(good.value?.name));
  check('体检结果是可加载', good.value?.entry?.ok === true);
  check('模型真的写到磁盘上了', existsSync(join(library, 'miku', 'model.moc3')));
  check('纹理也写了', existsSync(join(library, 'miku', 'texture.png')));

  // 公共的第一层目录要被剥掉：从 GitHub 下载的包几乎都多一层版本号目录。
  const nested = capture(() =>
    importModelZip(zipOfPackage('mymodel-1.0/'), { modelsRoot: library, name: 'download.zip' }),
  );
  check('剥掉了公共的第一层目录', nested.value?.path === 'mymodel-1.0/model.model3.json', String(nested.value?.path));
  check('目录名用了包名而不是 download.zip', nested.value?.dir === 'mymodel-1.0', String(nested.value?.dir));
  check('stats 里记下了被剥掉的前缀', nested.value?.stats?.strippedPrefix === 'mymodel-1.0');
  check('解出来的文件确实是剥完的（没有多一层）', existsSync(join(library, 'mymodel-1.0', 'model.moc3')));

  const dup = capture(() => importModelZip(zipOfPackage(), { modelsRoot: library, name: 'miku.zip' }));
  check('重名不会被覆盖', dup.value?.dir === 'miku (2)', String(dup.value?.dir));
  check('重名后路径也对', dup.value?.path === 'miku (2)/model.model3.json', String(dup.value?.path));
  check('重名被标记为已改名', dup.value?.stats?.renamed === true);
  check('原来那个模型还在', existsSync(join(library, 'miku', 'model.moc3')));

  // 没有 .model3.json 的包：拒绝，并且**不留下任何痕迹**。
  const junkZip = makeZip([
    { name: 'readme.txt', data: Buffer.from('随便一个压缩包', 'utf8') },
    { name: 'photo.jpg', data: PNG_1X1 },
  ]);
  const before = readdirSync(library).filter((n) => !n.startsWith('.')).length;
  const junk = capture(() => importModelZip(junkZip, { modelsRoot: library, name: 'junk.zip' }));
  check('没有 .model3.json 的包被拒绝', junk.error?.code === 'E_IMPORT_NO_MODEL', String(junk.error?.code));
  check('拒绝后库里没有多出目录', readdirSync(library).filter((n) => !n.startsWith('.')).length === before);
  check('拒绝后没有留下临时目录', readdirSync(library).filter((n) => n.startsWith('.import-')).length === 0);

  // 是模型包但坏掉（缺纹理）：照样入库，但要能精确说出哪里坏。
  const brokenJson = {
    Version: 3,
    FileReferences: { Moc: 'model.moc3', Textures: ['missing.png'] },
  };
  const brokenZip = makeZip([
    { name: 'broken.model3.json', data: Buffer.from(JSON.stringify(brokenJson), 'utf8') },
    { name: 'model.moc3', data: modelPackageFiles()['model.moc3'] },
  ]);
  const broken = capture(() => importModelZip(brokenZip, { modelsRoot: library, name: 'broken.zip' }));
  check('坏包仍然入库（用户需要能看见它并读到原因）', broken.error === null, String(broken.error));
  check('坏包被体检判为不可加载', broken.value?.entry?.ok === false);
  check(
    '坏包给出了精确的错误码',
    broken.value?.entry?.problems?.some((p) => p.code === 'E_MODEL_FILE_MISSING'),
    JSON.stringify(broken.value?.entry?.problems ?? []),
  );

  // macOS 元数据要静默跳过，而不是让整个包失败。
  const withJunk = makeZip([
    { name: '__MACOSX/._model.model3.json', data: Buffer.from('junk', 'utf8') },
    ...Object.entries(modelPackageFiles()).map(([name, data]) => ({ name: `mac/${name}`, data, method: 'deflate' })),
  ]);
  const mac = capture(() => importModelZip(withJunk, { modelsRoot: library, name: 'mac.zip' }));
  check('macOS 元数据被跳过而不是拒绝整个包', mac.error === null, String(mac.error));
  check('跳过的条目被计入 stats.skipped', (mac.value?.stats?.skipped ?? 0) >= 1);
  check('库外没有被写出 __MACOSX', !existsSync(join(library, '__MACOSX')));

  // 落库之后，扫描器必须能看见它 —— 这是「导入」和「显示」之间的接缝。
  clearLibraryCache();
  const scan = scanLibrary(library, { force: true });
  check('扫描器能看到刚导入的模型', scan.models.length >= 3, String(scan.models.length));
  check('导入的坏包在清单里是 ok:false', scan.models.some((m) => m.ok === false));
  check('扫描器没有把临时目录当成模型', scan.models.every((m) => !m.path.startsWith('.')));
}

{
  // 名字清洗：这些都会让 Windows 的 mkdir 直接失败或静默改名。
  check('去掉 .zip 后缀', sanitizeLibraryName('miku.zip') === 'miku');
  check('去掉路径部分', sanitizeLibraryName('C:\\Users\\x\\Downloads\\miku.zip') === 'miku');
  check('非法字符换成下划线', sanitizeLibraryName('a?b*c:d.zip') === 'a_b_c_d');
  check('去掉结尾的点（Windows 不允许）', sanitizeLibraryName('miku...') === 'miku');
  check('保留名被加下划线', sanitizeLibraryName('CON') === '_CON');
  check('空名字有兜底', sanitizeLibraryName('') . length > 0);
  check('超长名字被截断', sanitizeLibraryName('x'.repeat(200)).length <= 60);

  const root = makeSandbox('names');
  mkdirSync(join(root, 'miku'), { recursive: true });
  const picked = chooseAvailableName(root, 'miku');
  check('重名时顺延到 (2)', picked.name === 'miku (2)' && picked.renamed === true);
  check('没被占用时原样返回', chooseAvailableName(root, 'other').renamed === false);
}

{
  // 找模型文件的规则本身也要钉住：浅的优先、跳过点目录、深度有上限。
  const dir = makeSandbox('find');
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  mkdirSync(join(dir, '.hidden'), { recursive: true });
  writeFileSync(join(dir, '.hidden', 'x.model3.json'), '{}');
  writeFileSync(join(dir, 'top.model3.json'), '{}');
  writeFileSync(join(dir, 'a', 'b', 'deep.model3.json'), '{}');
  const found = findModelFiles(dir);
  check('浅层的模型定义优先', found.length === 1 && found[0].endsWith('top.model3.json'), found.join(','));
  check('点目录被跳过', found.every((f) => !f.includes('.hidden')));

  const onlyDeep = makeSandbox('deep');
  mkdirSync(join(onlyDeep, 'a', 'b'), { recursive: true });
  writeFileSync(join(onlyDeep, 'a', 'b', 'deep.model3.json'), '{}');
  check('没有浅层时能找到深层的', findModelFiles(onlyDeep).length === 1);

  const tooDeep = makeSandbox('toodeep');
  mkdirSync(join(tooDeep, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
  writeFileSync(join(tooDeep, 'a', 'b', 'c', 'd', 'e', 'x.model3.json'), '{}');
  check('超过深度上限的找不到（防止把别人的整棵目录树当成模型包）', findModelFiles(tooDeep).length === 0);
}

/* ------------------------------------------------------------------ *
 * [6] 反向验证
 * ------------------------------------------------------------------ */

console.log('\n[6] 反向验证：门禁本身会不会红');

{
  // 1) 「坏包被拒绝」这类断言必须真的会失败 —— 用一个必然成功的导入做对照。
  const ok = capture(() => importModelZip(zipOfPackage(), { modelsRoot: makeSandbox('neg-ok'), name: 'ok.zip' }));
  check('好包不会触发 E_IMPORT_NO_MODEL（错误码不是恒真的）', ok.error === null);

  // 2) `commonTopLevel` 在「没有公共前缀」时必须返回 null，否则会误剥一层目录。
  const mixed = makeZip([
    { name: 'a/x.model3.json', data: Buffer.from('{}', 'utf8') },
    { name: 'b/y.png', data: PNG_1X1 },
  ]);
  check('没有公共前缀时返回 null', commonTopLevel(readZipDirectory(mixed).entries) === null);

  // 3) crc32 自己要和已知向量一致，否则「CRC 校验通过」毫无意义。
  check('crc32 对上已知向量（"123456789" → 0xCBF43926）', crc32(Buffer.from('123456789', 'utf8')) === 0xcbf43926);
}

/* ------------------------------------------------------------------ *
 * [7] RAR 桥接
 * ------------------------------------------------------------------ */

{
  console.log('[7] RAR 桥接（识别 / 解包器 / 安全闸 / 真解包）');

  // 8.1 识别：只认魔数，且 RAR5 比 RAR4 长一字节，顺序错了会把 5 认成 4。
  const rar4 = buildRar4([{ name: 'a.txt', data: Buffer.from('a') }]);
  const rar5 = Buffer.concat([Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]), Buffer.from('rest')]);
  check('RAR4 魔数 → 版本 4', rarVariant(rar4) === 4, String(rarVariant(rar4)));
  check('RAR5 魔数 → 版本 5', rarVariant(rar5) === 5, String(rarVariant(rar5)));
  check('zip 不会被认成 rar', isRar(zipOfPackage()) === false);
  check('短缓冲不越界', rarVariant(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) === null);

  // 8.2 解包器：显式指定时只认它；都没装时返回 null（而不是抛错）。
  const envOnly = extractorCandidates({ DSH_RAR_EXTRACTOR: 'D:\\tools\\unrar.exe' });
  check('DSH_RAR_EXTRACTOR 优先且独占', envOnly.length === 1 && envOnly[0].path === 'D:\\tools\\unrar.exe', JSON.stringify(envOnly));
  const envDefault = extractorCandidates({ ProgramFiles: 'C:\\PF', SystemRoot: 'C:\\Windows' });
  check(
    '默认候选里同时有 7-Zip / UnRAR / 内置 tar',
    envDefault.some((item) => item.kind === '7z')
      && envDefault.some((item) => item.kind === 'unrar')
      && envDefault.some((item) => item.kind === 'bsdtar' && item.from === 'builtin'),
    envDefault.map((item) => `${item.kind}:${item.path}`).join(' | '),
  );
  const fakeExists = (wanted) => wanted.endsWith('7z.exe');
  const picked = findExtractor({ env: { ProgramFiles: 'C:\\PF', SystemRoot: 'C:\\Windows' }, exists: fakeExists });
  check('findExtractor 返回第一个存在的候选（7-Zip）', picked?.kind === '7z', JSON.stringify(picked));
  check('一个都没有时返回 null', findExtractor({ env: {}, exists: () => false }) === null);

  // 8.3 命令行：三种解包器的参数不能串味（-o 只给 7z、-p- 只给 unrar、-C 只给 bsdtar）。
  const args7z = extractorArgs({ kind: '7z', path: '7z.exe' }, 'a.rar', 'D:\\out');
  const argsUnrar = extractorArgs({ kind: 'unrar', path: 'unrar.exe' }, 'a.rar', 'D:\\out');
  const argsTar = extractorArgs({ kind: 'bsdtar', path: 'tar.exe' }, 'a.rar', 'D:\\out');
  check('7z 用 -o<dir>', args7z.includes('-oD:\\out') && args7z.includes('x'), args7z.join(' '));
  check('UnRAR 用 -p- 并且目标目录带反斜杠', argsUnrar.includes('-p-') && argsUnrar.at(-1) === 'D:\\out\\', argsUnrar.join(' '));
  check('bsdtar 用 -C <dir>', argsTar.join(' ') === '-x -f a.rar -C D:\\out', argsTar.join(' '));

  // 8.4 错误翻译：安全 → 加密 → 分卷 → 通用，顺序不能反（加密的分卷包两句话都会出现）。
  const unsafe = classifyExtractFailure({ stderr: "../../evil.txt: Path contains '..': Unknown error" });
  check('`..` 包被判成不安全路径', unsafe.code === 'E_IMPORT_RAR_UNSAFE_PATH', unsafe.code);
  const encrypted = classifyExtractFailure({ stderr: 'Passphrase required for this entry' });
  check('加密包 → E_IMPORT_RAR_ENCRYPTED', encrypted.code === 'E_IMPORT_RAR_ENCRYPTED', encrypted.code);
  const volume = classifyExtractFailure({ stderr: 'Unexpected end of archive' });
  check('分卷包 → E_IMPORT_RAR_MULTIVOLUME', volume.code === 'E_IMPORT_RAR_MULTIVOLUME', volume.code);
  check('ENOENT → 没有解包器', classifyExtractFailure({ code: 'ENOENT' }).code === 'E_IMPORT_RAR_NO_EXTRACTOR');
  check('体积超限 kill → E_IMPORT_TOO_LARGE', classifyExtractFailure({ killed: 'too-large' }).code === 'E_IMPORT_TOO_LARGE');
  check('其它失败 → E_IMPORT_RAR_FAILED 且带首行原因', classifyExtractFailure({ stderr: 'junk\nsecond' }).detail === 'junk');

  // 8.5 解包后的树：符号链接 / 条目数 / 总体积 / 单文件，四条都要能拦住。
  const treeSandbox = makeSandbox('rar-tree');
  writeFileSync(join(treeSandbox, 'ok.txt'), Buffer.alloc(10));
  const treeOk = walkTree(treeSandbox);
  check('walkTree 量到 1 个文件 / 10 字节', treeOk.files === 1 && treeOk.bytes === 10, JSON.stringify(treeOk));
  check('正常树通过上限检查', assertTree(treeOk, {}).files === 1);
  const tooMany = { ...treeOk, entries: 2500 };
  check('条目超限被拦', capture(() => assertTree(tooMany, { maxEntries: 2000 })).error?.code === 'E_IMPORT_TOO_MANY_ENTRIES');
  const tooBig = { ...treeOk, bytes: 2048 };
  check('总体积超限被拦', capture(() => assertTree(tooBig, { maxTotalBytes: 1024 })).error?.code === 'E_IMPORT_TOO_LARGE');
  const oneBig = { ...treeOk, largest: 4096, bytes: 4096 };
  check('单文件超限被拦', capture(() => assertTree(oneBig, { maxEntryBytes: 1024 })).error?.code === 'E_IMPORT_ENTRY_TOO_LARGE');
  const withLink = { ...treeOk, symlinks: ['C:\\link'] };
  check('符号链接被拦（模型包里不该有）', capture(() => assertTree(withLink, {})).error?.code === 'E_IMPORT_RAR_SYMLINK');

  // 8.6 超时会 kill 子进程，而不是一直等。用一个永不退出的假解包器。
  {
    const { EventEmitter } = await import('node:events');
    let killed = false;
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        killed = true;
        setImmediate(() => child.emit('close', null));
      };
      return child;
    };
    const timed = await new Promise((resolve) => {
      runExtractor({
        extractor: { kind: 'bsdtar', path: 'tar.exe' },
        archivePath: 'a.rar',
        destDir: treeSandbox,
        spawnImpl: fakeSpawn,
        timeoutMs: 30,
        pollMs: 1000,
      }).then(() => resolve({ ok: true }), (error) => resolve({ ok: false, code: error.code }));
    });
    check('超过 timeoutMs 会 kill 并报 E_IMPORT_RAR_TIMEOUT', killed && timed.code === 'E_IMPORT_RAR_TIMEOUT', JSON.stringify(timed));
  }

  // 8.7 真解包：本机有解包器才跑（没有时明确跳过，而不是假装通过）。
  const realExtractor = findExtractor();
  if (realExtractor === null) {
    console.log('  · 跳过真解包：这台机器上没有 7-Zip / WinRAR / tar.exe');
  } else {
    console.log(`  · 用 ${realExtractor.kind} 真解包：${realExtractor.path}`);
    const libSandbox = makeSandbox('rar-import');

    const good = await captureAsync(() => importModelArchive(rarOfPackage('mymodel'), { modelsRoot: libSandbox, name: 'pkg.rar' }));
    check('合法 rar 导入成功', good.error === null, String(good.error?.message ?? ''));
    check('目录名用了 rar 内那层顶层文件夹', good.value?.dir === 'mymodel', String(good.value?.dir));
    check(
      'id 指向剥掉顶层之后的模型文件',
      good.value?.id === 'mymodel/model.model3.json',
      String(good.value?.id),
    );
    check('模型文件真的躺在库里', good.value !== null && existsSync(join(libSandbox, 'mymodel', 'model.model3.json')));
    check(
      '临时目录与 .package.rar 都没留下',
      readdirSync(libSandbox).every((name) => !name.startsWith('.import-')),
      readdirSync(libSandbox).join(','),
    );

    const noModel = await captureAsync(() => importModelArchive(rarWithoutModel('junk'), { modelsRoot: libSandbox, name: 'junk.rar' }));
    check('没有 .model3.json 的 rar → E_IMPORT_NO_MODEL', noModel.error?.code === 'E_IMPORT_NO_MODEL', String(noModel.error?.code));
    check(
      '失败后临时目录也被清掉',
      readdirSync(libSandbox).every((name) => !name.startsWith('.import-')),
      readdirSync(libSandbox).join(','),
    );

    const evil = buildRar4([
      { name: '../../evil-rar-test.txt', data: Buffer.from('evil') },
      { name: 'ok/ok.txt', data: Buffer.from('ok') },
    ]);
    const escaped = await captureAsync(() => importModelArchive(evil, { modelsRoot: libSandbox, name: 'evil.rar' }));
    check('带 `..` 的 rar 被整包拒绝', escaped.error?.code === 'E_IMPORT_RAR_UNSAFE_PATH', String(escaped.error?.code));
    check(
      '真的一字节都没写到库外面',
      !existsSync(join(libSandbox, '..', 'evil-rar-test.txt')) && !existsSync(join(libSandbox, 'evil-rar-test.txt')),
    );
  }

  // 8.8 两条与解包器无关的入口：不是压缩包 / 明确没有解包器。
  const notArchive = await captureAsync(() => importModelArchive(Buffer.from('hello world'), { modelsRoot: makeSandbox('rar-not') }));
  check('既不是 zip 也不是 rar → E_IMPORT_NOT_ARCHIVE', notArchive.error?.code === 'E_IMPORT_NOT_ARCHIVE', String(notArchive.error?.code));
  const noExtractor = await captureAsync(() => importModelArchive(rarOfPackage(), {
    modelsRoot: makeSandbox('rar-none'),
    findExtractor: () => null,
  }));
  check('没有解包器时报 E_IMPORT_RAR_NO_EXTRACTOR', noExtractor.error?.code === 'E_IMPORT_RAR_NO_EXTRACTOR', String(noExtractor.error?.code));
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

for (const dir of sandboxes) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不算失败 */
  }
}

console.log('');
if (failures > 0) {
  console.log(`[x] MODEL IMPORT GATE FAILED — ${failures} 项断言未通过`);
  process.exit(1);
}
console.log('[7] MODEL IMPORT GATE PASSED');
