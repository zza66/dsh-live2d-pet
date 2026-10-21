#!/usr/bin/env node
/**
 * 门禁：语音包库的**磁盘层**（`lib/host/voice-library.js`）。
 *
 * ## 它与 `test-voice-pack.mjs` 的分工
 *
 * `voice-pack.js` 是纯逻辑（不碰磁盘），它的门禁验的是「字符串判断对不对」。
 * 这个文件验的是另一件事：**磁盘上的目录到底被读成了什么**——目录名能不能
 * 当 URL 参数、坏 json 会不会让整张清单消失、`?pack=` 能不能逃出根目录、
 * 清单写了文件但文件不在时会怎样。
 *
 * 这些差别不是学术问题：`?pack=../..` 放行就是任意目录读取，`voices.json`
 * 写错一个字段就让整个包被静默跳过则是「我建的包不见了」。两条都不会崩，
 * 所以只能靠断言钉住。
 *
 * ## 为什么用临时目录
 *
 * 全部 IO 都发生在 `mkdtempSync` 造出来的目录里，跑完就删——不碰用户的
 * `voices-inbox`（那个目录里是**用户的东西**，门禁既不该读也不该写）。
 *
 * ## 用法
 *
 *     node tools/test-voice-library.mjs     （离线：无网络、无 DOM、只用临时目录）
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MAX_VOICE_MANIFEST_BYTES,
  checkPackName,
  readVoicePack,
  resolveVoiceClip,
  scanVoiceLibrary,
} from '../dsh-live2d-pet/lib/host/voice-library.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', 'dsh-live2d-pet');
const sourcePath = resolve(packageRoot, 'lib/host/voice-library.js');
const hostEntryPath = resolve(packageRoot, 'lib/index.js');

let passed = 0;
let failed = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`);
  }
};

/** 情绪表替身：与真表同一套归一化语义（表里没有 → null）。 */
const canonicalEmotion = (name) => {
  const table = {
    happy: '开心', 开心: '开心', sad: '难过', 难过: '难过', neutral: '平静', 平静: '平静',
  };
  return table[String(name).trim()] ?? null;
};

/* ══════════════════════════════════════════════════════════════════════════ *
 * 测试夹具：一棵小巧但覆盖全部形态的语音库
 * ══════════════════════════════════════════════════════════════════════════ */

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-voicelib-'));
const root = join(sandbox, 'voices');

const writeFileAt = (relative, bytes) => {
  const file = join(root, ...relative.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
};

mkdirSync(root, { recursive: true });

// ① 有清单的健康包（中文目录名、清单里一条文件存在、一条不存在）
writeFileAt('好包/happy/greet-01.wav', Buffer.from('RIFF....WAVEfake'));
writeFileAt('好包/voices.json', JSON.stringify({
  format: 1,
  name: '好包（清单名）',
  default: true,
  clips: [
    { id: 'greet-01', file: 'happy/greet-01.wav', text: '早上好呀', emotion: 'happy' },
    { id: 'ghost-01', file: 'happy/ghost-01.wav', text: '这条的文件不存在' },
  ],
}));

// ② 没有清单的松散包（子目录名当情绪）
writeFileAt('松散包/happy/a.mp3', Buffer.from('ID3fake'));
writeFileAt('松散包/neutral/b.wav', Buffer.from('RIFFfake'));

// ③ 清单 JSON 坏掉
writeFileAt('坏JSON/voices.json', '{ 这不是 json');

// ④ 空目录
mkdirSync(join(root, '空包'), { recursive: true });

// ⑤ 隐藏目录（不该出现在清单里）
writeFileAt('.cache/x.mp3', Buffer.from('ID3fake'));

// ⑥ 清单大到离谱（只看体积，内容是什么无所谓）
writeFileAt('超大清单/voices.json', 'x'.repeat(MAX_VOICE_MANIFEST_BYTES + 1));

const cleanup = () => rmSync(sandbox, { recursive: true, force: true });
process.on('exit', cleanup);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [1] 目录名校验（URL 参数的第一道门）
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[1] 目录名校验（checkPackName）');

check('普通名通过', checkPackName('示例包').ok === true);
check('中文名通过', checkPackName('我的录音包').ok === true);
check('带空格与连字符通过', checkPackName('my pack-1').ok === true);
check('空名被拒', checkPackName('').ok === false && checkPackName('').reason === 'E_VOICE_PACK_NAME_EMPTY');
check('`..` 被拒', checkPackName('..').ok === false);
check('`.` 被拒', checkPackName('.').ok === false);
check('正斜杠被拒（否则 ?pack=a/b 能读子目录）', checkPackName('a/b').ok === false);
check('反斜杠被拒', checkPackName('a\\b').ok === false);
check('点开头被拒（隐藏目录）', checkPackName('.hidden').ok === false);
check('控制字符被拒', checkPackName('a\u0007b').ok === false);
check('超长名被拒', checkPackName('a'.repeat(121)).ok === false);
check('非字符串被拒', checkPackName(null).ok === false);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [2] 根目录不存在时不许抛
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[2] 根目录不存在');

const missing = scanVoiceLibrary(join(sandbox, '根本没有这个目录'), { canonicalEmotion });
check('rootExists 为假', missing.rootExists === false);
check('packs 是空数组而不是 undefined', Array.isArray(missing.packs) && missing.packs.length === 0);
check('summary 仍然可读', missing.summary.packs === 0 && missing.summary.clips === 0);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [3] 读单个包：清单 / 松散 / 坏 json / 空 / 超大
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[3] readVoicePack');

const good = readVoicePack(root, '好包', { canonicalEmotion });
check('清单包被认出来', good.hasManifest === true);
check('清单名优先于目录名', good.name === '好包（清单名）');
check('抓到了显式 default', good.isDefault === true);
check('只收进文件存在的那一条', good.clipCount === 1, `clipCount=${good.clipCount}`);
check('缺文件的那条进了 problems', good.problems.length === 1 && good.problems[0].code === 'E_VOICE_FILE_MISSING');
check('problems 带位置（clips[1]）', good.problems[0].path === 'clips[1]', good.problems[0].path);
check('problems 有 code/message/detail 三个字段',
  ['code', 'message', 'detail'].every((key) => typeof good.problems[0][key] === 'string'));
check('情绪被归一化（happy → 开心）', good.clips[0].emotion === '开心', good.clips[0].emotion);
check('字节数由 stat 补齐', good.clips[0].bytes > 0);
check('摘要与 clips 一致', good.withText === 1 && good.withEmotion === 1);

const loose = readVoicePack(root, '松散包', { canonicalEmotion });
check('没有清单也认', loose.hasManifest === false);
check('松散包收进两个文件', loose.clipCount === 2);
check('子目录名当情绪', loose.emotions.includes('开心') && loose.emotions.includes('平静'), JSON.stringify(loose.emotions));
check('没有文本 → text 是空串（字幕那边回落到 id）', loose.clips.every((clip) => clip.text === ''));
check('id 由文件名折出来', loose.clips.map((clip) => clip.id).sort().join(',') === 'a,b');
check('松散包没有 problems', loose.problems.length === 0);

const broken = readVoicePack(root, '坏JSON', { canonicalEmotion });
check('坏 json → ok 为假', broken.ok === false);
check('坏 json 的错误码是 E_VOICE_MANIFEST_JSON',
  broken.problems[0].code === 'E_VOICE_MANIFEST_JSON', broken.problems[0].code);
check('坏 json 时 clips 是空数组（不是 undefined）', Array.isArray(broken.clips) && broken.clips.length === 0);

const empty = readVoicePack(root, '空包', { canonicalEmotion });
check('空目录 → ok 为假', empty.ok === false);
check('空目录 → clipCount 0', empty.clipCount === 0);
check('空目录不抛', typeof empty.problems === 'object');

const huge = readVoicePack(root, '超大清单', { canonicalEmotion });
check('超大清单被拒（E_VOICE_MANIFEST_TOO_LARGE）',
  huge.problems[0].code === 'E_VOICE_MANIFEST_TOO_LARGE', huge.problems[0].code);

const unsafe = readVoicePack(root, '..', { canonicalEmotion });
check('非法目录名 → E_VOICE_PACK_NAME_UNSAFE', unsafe.ok === false && unsafe.problems[0].code === 'E_VOICE_PACK_NAME_UNSAFE');

const ghostPack = readVoicePack(root, '没有这个包', { canonicalEmotion });
check('不存在的包不抛，只是 ok 为假', ghostPack.ok === false);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [4] 扫描整个库
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[4] scanVoiceLibrary');

const scan = scanVoiceLibrary(root, { canonicalEmotion });
check('rootExists 为真', scan.rootExists === true);
check('隐藏目录被跳过（五个包，不是六个）', scan.packs.length === 5, scan.packs.map((p) => p.dirName).join(','));
check('坏包也在清单里（不能只列好包）',
  scan.packs.some((pack) => pack.dirName === '坏JSON') && scan.packs.some((pack) => pack.dirName === '空包'));
check('按名字排序',
  scan.packs.map((pack) => pack.name).join('|') === [...scan.packs].map((pack) => pack.name)
    .sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN')).join('|'));
check('summary.packs 与实际一致', scan.summary.packs === scan.packs.length);
check('summary.clips 是各包之和', scan.summary.clips === 3, String(scan.summary.clips));
check('summary.okPacks 两个（好包 + 松散包）', scan.summary.okPacks === 2, String(scan.summary.okPacks));
check('summary.problems 至少两条（缺文件 + 坏 json + 超大 + 空包…）', scan.summary.problems >= 2);
check('扫描耗时是个数字', typeof scan.durationMs === 'number');

/* ══════════════════════════════════════════════════════════════════════════ *
 * [5] 把 URL 参数解析成磁盘文件
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[5] resolveVoiceClip');

const byId = resolveVoiceClip(root, { pack: '好包', clip: 'greet-01' }, { canonicalEmotion });
check('点名取到', byId.ok === true);
check('MIME 按扩展名给（wav → audio/wav）', byId.mimeType === 'audio/wav', byId.mimeType);
check('路径真的在包目录里', byId.ok === true && byId.path.includes('好包'), byId.path ?? '');
check('返回的 clip 带文本（字幕要用）', byId.ok === true && byId.clip.text === '早上好呀');
check('没退让时 fallback 为假', byId.ok === true && byId.fallback === false);

const byEmotion = resolveVoiceClip(root, { pack: '好包', emotion: '开心' }, { canonicalEmotion });
check('按情绪取到（清单里写的是 happy，归一成开心）', byEmotion.ok === true);
check('按情绪命中时不算退让', byEmotion.ok === true && byEmotion.fallback === false);

const unknownId = resolveVoiceClip(root, { pack: '好包', clip: 'ghost-01' }, { canonicalEmotion });
check('点了名但没有这条 → ok 为假（不退让）', unknownId.ok === false);
check('错误码 E_VOICE_UNKNOWN_CLIP', unknownId.code === 'E_VOICE_UNKNOWN_CLIP', unknownId.code);
check('报出可用的 id 列表', Array.isArray(unknownId.available) && unknownId.available.includes('greet-01'));

const fallbackPick = resolveVoiceClip(root, { pack: '松散包', emotion: '难过' }, { canonicalEmotion });
check('按情绪挑不到时退到任意一条', fallbackPick.ok === true && fallbackPick.fallback === true);
check('退让时说出来（fallback: true）', fallbackPick.fallback === true);

const strictPick = resolveVoiceClip(
  root,
  { pack: '松散包', emotion: '难过' },
  { canonicalEmotion, allowFallback: false },
);
check('allowFallback:false 时拒绝退让', strictPick.ok === false && strictPick.code === 'E_VOICE_NO_EMOTION_CLIP');

const navPack = resolveVoiceClip(root, { pack: '../', clip: 'a' }, { canonicalEmotion });
check('`?pack=../` 被拒（否则是任意目录读取）',
  navPack.ok === false && navPack.code === 'E_VOICE_PACK_NAME_UNSAFE', navPack.code);

const emptyPackPick = resolveVoiceClip(root, { pack: '空包' }, { canonicalEmotion });
check('空包 → 明确报错', emptyPackPick.ok === false && emptyPackPick.code === 'E_VOICE_PACK_EMPTY', emptyPackPick.code);

const missingPackPick = resolveVoiceClip(root, { pack: '没有这个包' }, { canonicalEmotion });
check('不存在的包 → 明确报错', missingPackPick.ok === false);

const mp3Pick = resolveVoiceClip(root, { pack: '松散包', clip: 'a' }, { canonicalEmotion });
check('mp3 的 MIME 是 audio/mpeg', mp3Pick.ok === true && mp3Pick.mimeType === 'audio/mpeg');

/* ══════════════════════════════════════════════════════════════════════════ *
 * [6] 反证：把守卫弄坏，判据必须变假
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[6] 反证（把真代码的守卫弄坏，同一批评据必须失败）');

const source = readFileSync(sourcePath, 'utf8');
/*
 * 反证要把源码复制到临时目录再 import，而它 `import … from './voice-pack.js'`——
 * 那个依赖也得一起复制过去，否则 import 直接 ERR_MODULE_NOT_FOUND，
 * 反证变成「因为别的原因失败」，那是最没有价值的假绿。
 *
 * 两个细节：
 *   · 临时目录里没有 `package.json`，`.js` 会被当成 CommonJS → `export` 直接语法错。
 *     所以依赖改写成 `.mjs`（后缀这件事与要验的守卫无关）；
 *   · 被复制的只有**依赖**，被测的那个文件仍然带着真源码里的守卫原文。
 */
const packSource = readFileSync(resolve(packageRoot, 'lib/host/voice-pack.js'), 'utf8');

async function loadMutated(from, to, tag) {
  if (!source.includes(from)) {
    throw new Error(`反证锚点没找到（源码改过了？）：${JSON.stringify(from.slice(0, 70))}`);
  }
  const dir = mkdtempSync(join(tmpdir(), `dsh-voicelib-${tag}-`));
  writeFileSync(join(dir, 'voice-pack.mjs'), packSource, 'utf8');
  const file = join(dir, 'voice-library.mjs');
  writeFileSync(
    file,
    source.replace("from './voice-pack.js'", "from './voice-pack.mjs'").replace(from, to),
    'utf8',
  );
  const mod = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

/* --- 反证 1：拿掉分隔符检查，`a/b` 必须变成「合法目录名」 --- */
{
  const mutated = await loadMutated(
    "if (value.includes('/') || value.includes('\\\\')) return { ok: false, reason: 'E_VOICE_PACK_NAME_UNSAFE' };",
    'if (false) return { ok: false, reason: \'E_VOICE_PACK_NAME_UNSAFE\' };',
    'sep',
  );
  check('反证 1：去掉分隔符守卫后 `a/b` 变成合法目录名', mutated.checkPackName('a/b').ok === true);
  check('反证 1 对照：真代码拒绝它', checkPackName('a/b').ok === false);
}

/* --- 反证 2：不跳过隐藏目录，`.cache` 必须出现在清单里 --- */
{
  const mutated = await loadMutated(
    'if (!entry.isDirectory()) continue;\n    if (entry.name.startsWith(\'.\')) continue;',
    'if (!entry.isDirectory()) continue;',
    'hidden',
  );
  const mutatedScan = mutated.scanVoiceLibrary(root, { canonicalEmotion });
  check('反证 2：不跳过点开头的目录后清单变长',
    mutatedScan.packs.length === scan.packs.length + 1,
    `${mutatedScan.packs.length} vs ${scan.packs.length}`);
  check('反证 2 对照：真代码把隐藏目录挡住', scan.packs.length === 5);
}

/* --- 反证 3：让「路径必须在根目录内」这道校验永远失败，正常包也必须取不到 --- */
{
  const mutated = await loadMutated(
    'if (packDir !== rootResolved && !packDir.startsWith(rootResolved + sep)) {',
    'if (true) {',
    'contain',
  );
  const broken = mutated.resolveVoiceClip(root, { pack: '好包', clip: 'greet-01' }, { canonicalEmotion });
  check('反证 3：把根目录包含检查改成恒真后，正常包也取不到（说明它真的在跑）', broken.ok === false);
  check('反证 3 对照：真代码取得到', byId.ok === true);
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * [7] 接线：Host 里那两条路由真的指向这两个函数
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[7] 调用点（lib/index.js 的接线）');

const hostSource = readFileSync(hostEntryPath, 'utf8');
check('import 了 scanVoiceLibrary / resolveVoiceClip',
  hostSource.includes('scanVoiceLibrary') && hostSource.includes('resolveVoiceClip'));
check('import 了语音库模块本身', hostSource.includes("from './host/voice-library.js'"));
check('有 GET /voices 这条路由', hostSource.includes("if (rest === '/voices')"));
check('有 GET /voice 这条路由', hostSource.includes("if (rest === '/voice')"));
check('语音根目录走自己的解析链（resolveVoicesRoot）', hostSource.includes('function resolveVoicesRoot('));
check('`/status` 里能看到语音库根目录（state 字段）', hostSource.includes('voicesRootSource: resolvedVoices.source'));
check('/voice 用 base64 装进 JSON（与 /speak 同形状）',
  hostSource.includes('audioBase64: bytes.toString(\'base64\')'));
check('单条语音有体积上限（否则一次点播能把标签页推死）',
  hostSource.includes('MAX_VOICE_CLIP_BYTES') && hostSource.includes('E_VOICE_CLIP_TOO_LARGE'));
check('用 base64 之前先 stat 体积（不能先把 200MB 读进内存再判）',
  hostSource.indexOf('statSync(picked.path).size') < hostSource.indexOf("readFileSync(picked.path)"));

/* ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✓' : '✗'} VOICE LIBRARY GATE —— ${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
