#!/usr/bin/env node
/**
 * 门禁：音色包（`lib/host/voice-packs.js`）—— 磁盘上的「一段参考音 + 它的逐字文本」。
 *
 * ## 为什么需要这个文件
 *
 * 这一层是**把外部来的文件变成她会用的嗓子**的入口，危险的不是报错，是四件安静的事故：
 *
 *   1. **清单里的路径变成任意文件读取**：`refAudio: "../../../../Windows/win.ini"`
 *      只要拼接时没拦住，一个包就能把她变成读文件的海螺；
 *   2. **同名导入悄悄覆盖**：用户手调过语速/地址的那份包被后来导入的同 id 包盖掉，
 *      症状是「我上次调的又没了」，而没有任何报错；
 *   3. **坏包把她弄哑**：一个 promptText 写错的包如果被启用，每一句都要重试、
 *      最后降级成机器音 —— 所以取不到包时必须能退回去（`voiceProfile()` 返回 null）；
 *   4. **逐字文本丢了**：参考音还在、文本错了，克隆出来的音色带着口音，
 *      而界面上一切正常。所以 `promptText` 是必填，不是可选。
 *
 * 断言因此偏向反证：穿越必须被拒、同名必须不覆盖、坏输入必须带码。
 *
 * ## 用法
 *
 *     node tools/test-voice-packs.mjs      （离线：临时目录，无网络、无 GPU、无真实模型）
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(here, '..');
const PACKAGE = resolve(WORKSPACE, 'dsh-live2d-pet');
const modulePath = resolve(PACKAGE, 'lib/host/voice-packs.js');

let failed = 0;
let passed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

if (!existsSync(modulePath)) {
  console.error(`模块不存在：${modulePath}`);
  process.exit(2);
}

const mod = await import(pathToFileURL(modulePath).href);
const {
  PACK_MANIFEST_FILE,
  PACK_SCHEMA,
  MAX_REF_BYTES,
  MAX_PROMPT_CHARS,
  AUDIO_EXTENSIONS,
  normalizePackId,
  normalizeManifest,
  createVoicePackStore,
  detectSovitsVersion,
  canonicalVersion,
  SOVITS_VERSION_HEADERS,
  hashFile,
} = mod;

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-voice-packs-gate-'));
const storeRoot = join(tmpRoot, 'packs');
/** 一段 4 字节的假音频：内容不重要，扩展名与大小才是被检查的东西。 */
const FAKE_WAV = Buffer.from([0x52, 0x49, 0x46, 0x46]);

function writeWav(path, bytes = FAKE_WAV) {
  writeFileSync(path, bytes);
}

/** 造一个「源包」目录，返回它的路径。 */
function makeSource(id, { manifest = {}, files = { ['ref.wav']: FAKE_WAV } } = {}) {
  const dir = join(tmpRoot, `src-${id}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const body = {
    schema: PACK_SCHEMA,
    id,
    name: `包 ${id}`,
    promptText: '这是一段参考音的逐字文本。',
    ...manifest,
  };
  writeFileSync(join(dir, PACK_MANIFEST_FILE), JSON.stringify(body, null, 2), 'utf8');
  for (const [name, bytes] of Object.entries(files)) {
    if (name.includes('/')) mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  return dir;
}

try {
  console.log('\n[1] 模块与常量');
  check('PACK_MANIFEST_FILE 是 voice.json', PACK_MANIFEST_FILE === 'voice.json', PACK_MANIFEST_FILE);
  check('PACK_SCHEMA 是 1', PACK_SCHEMA === 1, String(PACK_SCHEMA));
  check('参考音上限 8MB', MAX_REF_BYTES === 8 * 1024 * 1024, String(MAX_REF_BYTES));
  check('promptText 上限 500 字', MAX_PROMPT_CHARS === 500, String(MAX_PROMPT_CHARS));
  check('允许 wav/mp3/ogg/flac/m4a', ['wav', 'mp3', 'ogg', 'flac', 'm4a'].every((ext) => AUDIO_EXTENSIONS.includes(`.${ext}`)), AUDIO_EXTENSIONS.join(' '));
  check('id 允许短横与点', normalizePackId('da-fei.yu_1') === 'da-fei.yu_1');
  check('id 统一转小写', normalizePackId('DaFeiYu') === 'dafeiyu');
  check('中文 id 被拒（显示名走 name）', normalizePackId('大肥鱼') === null);
  check('以短横开头的 id 被拒', normalizePackId('-abc') === null);
  check('超长 id 被拒', normalizePackId('a'.repeat(65)) === null);

  console.log('\n[2] 清单校验（normalizeManifest）');
  const good = normalizeManifest({
    schema: 1,
    id: 'demo',
    name: '演示包',
    promptText: '今天也一起做点有意思的事情吧。',
  });
  check('最小清单能通过', good.ok === true && good.pack.id === 'demo');
  check('缺省 version 补 1.0.0', good.ok === true && good.pack.version === '1.0.0');
  check('id 缺省时用目录名兜底', normalizeManifest({ name: 'x', promptText: 'y' }, { fallbackId: 'from-dir' }).ok === true);
  const badId = normalizeManifest({ id: '中文', name: 'x', promptText: 'y' });
  check('中文 id → E_PACK_BAD_ID', badId.ok === false && badId.code === 'E_PACK_BAD_ID', badId.code);
  const noName = normalizeManifest({ id: 'x', promptText: 'y' });
  check('缺 name → E_PACK_BAD_NAME', noName.ok === false && noName.code === 'E_PACK_BAD_NAME', noName.code);
  const noPrompt = normalizeManifest({ id: 'x', name: 'x' });
  check('缺 promptText → E_PACK_BAD_PROMPT', noPrompt.ok === false && noPrompt.code === 'E_PACK_BAD_PROMPT', noPrompt.code);
  check('空 promptText 也算缺', normalizeManifest({ id: 'x', name: 'x', promptText: '   ' }).ok === false);
  const traversal = normalizeManifest({ id: 'x', name: 'x', promptText: 'y', refAudio: '../outside.wav' });
  check('refAudio 有 .. → E_PACK_BAD_REF', traversal.ok === false && traversal.code === 'E_PACK_BAD_REF', traversal.code);
  const absolute = normalizeManifest({ id: 'x', name: 'x', promptText: 'y', refAudio: 'C:/Windows/win.ini' });
  check('refAudio 绝对路径 → E_PACK_BAD_REF', absolute.ok === false && absolute.code === 'E_PACK_BAD_REF', absolute.code);
  const badExt = normalizeManifest({ id: 'x', name: 'x', promptText: 'y', refAudio: 'ref.txt' });
  check('refAudio 扩展名不对 → E_PACK_BAD_REF', badExt.ok === false && badExt.code === 'E_PACK_BAD_REF', badExt.code);
  const notObject = normalizeManifest(['nope']);
  check('清单不是对象 → E_PACK_BAD_MANIFEST', notObject.ok === false && notObject.code === 'E_PACK_BAD_MANIFEST', notObject.code);
  const windowsPath = normalizeManifest({ id: 'x', name: 'x', promptText: 'y', refAudio: 'sub\\ref.wav' });
  check('反斜杠路径归一成 /', windowsPath.ok === true && windowsPath.pack.refAudio === 'sub/ref.wav', windowsPath.ok ? windowsPath.pack.refAudio : windowsPath.code);

  console.log('\n[3] 目录导入与读取');
  const store = createVoicePackStore({ root: storeRoot });
  const src = makeSource('alpha', { manifest: { license: 'CC BY-NC 4.0', author: '尹紫鹭幻想社' } });
  const imported = store.importFrom(src);
  check('导入成功', imported.ok === true, imported.ok ? '' : imported.code);
  check('包落在 <root>/alpha', existsSync(join(storeRoot, 'alpha', PACK_MANIFEST_FILE)));
  check('参考音也拷进来了', existsSync(join(storeRoot, 'alpha', 'ref.wav')));
  const listed = store.list();
  check('list 能看到这个包', listed.ok === true && listed.packs.some((pack) => pack.id === 'alpha'));
  check('list 没有坏目录', listed.broken.length === 0, JSON.stringify(listed.broken));
  const described = listed.packs.find((pack) => pack.id === 'alpha');
  check('describe 带 refBytes', described.refBytes === FAKE_WAV.length, String(described.refBytes));
  check('describe 带 refMime', described.refMime === 'audio/wav', described.refMime);
  check('describe 带许可与作者', described.license === 'CC BY-NC 4.0' && described.author === '尹紫鹭幻想社');
  check('describe 带逐字文本', described.promptText === '这是一段参考音的逐字文本。');
  const loaded = store.load('alpha');
  check('load 给出包内参考音的绝对路径', loaded.ok === true && loaded.refPath === join(storeRoot, 'alpha', 'ref.wav'), loaded.refPath ?? loaded.code);
  const profile = store.voiceProfile('alpha');
  check('voiceProfile 带 sha256（64 位十六进制）', typeof profile?.refAudioSha256 === 'string' && /^[0-9a-f]{64}$/.test(profile.refAudioSha256));
  check('voiceProfile 带 base64（小文件直接内联）', typeof profile?.refAudioBase64 === 'string' && profile.refAudioBase64.length > 0);
  check('voiceProfile 带 promptLang/textLang 缺省 zh', profile?.promptLang === 'zh' && profile?.textLang === 'zh');
  const noBase64 = store.voiceProfile('alpha', { maxBase64Bytes: 0 });
  check('超过 base64 上限时只给路径', noBase64 !== null && noBase64.refAudioBase64 === undefined);
  check('未知 id 的 voiceProfile 是 null（坏包不许把她弄哑）', store.voiceProfile('nope') === null);
  check('非法 id 的 voiceProfile 也是 null', store.voiceProfile('../etc') === null);
  const audio = store.audio('alpha');
  check('audio 给出路径与 mime', audio.ok === true && audio.mime === 'audio/wav');

  console.log('\n[4] 清单没写 refAudio：目录里唯一音频就是它');
  const implicitDir = join(tmpRoot, 'implicit');
  mkdirSync(implicitDir, { recursive: true });
  writeFileSync(join(implicitDir, PACK_MANIFEST_FILE), JSON.stringify({ id: 'implicit', name: '手搓包', promptText: '只有一条录音。' }), 'utf8');
  writeWav(join(implicitDir, 'only.wav'));
  const implicit = store.importFrom(implicitDir);
  check('导入成功', implicit.ok === true, implicit.ok ? '' : implicit.code);
  check('自动认了唯一的音频', implicit.ok === true && implicit.pack.refAudio === 'ref.wav', implicit.ok ? implicit.pack.refAudio : '');
  check('导入时把参考音统一改名成 ref.*（不保留原文件名，免得重名/大小写打架）',
    existsSync(join(storeRoot, 'implicit', 'ref.wav')) && !existsSync(join(storeRoot, 'implicit', 'only.wav')));
  const ambiguousDir = join(tmpRoot, 'ambiguous');
  mkdirSync(ambiguousDir, { recursive: true });
  writeFileSync(join(ambiguousDir, PACK_MANIFEST_FILE), JSON.stringify({ id: 'ambiguous', name: '两条录音', promptText: '不知道该用哪条。' }), 'utf8');
  writeWav(join(ambiguousDir, 'a.wav'));
  writeWav(join(ambiguousDir, 'b.wav'));
  const ambiguous = store.importFrom(ambiguousDir);
  check('两条音频且没写 refAudio → E_PACK_NO_REF（不猜）', ambiguous.ok === false && ambiguous.code === 'E_PACK_NO_REF', ambiguous.code);

  console.log('\n[5] 同名不覆盖');
  const again = store.importFrom(src);
  check('再导一次同 id → E_PACK_EXISTS', again.ok === false && again.code === 'E_PACK_EXISTS', again.code);
  const modified = makeSource('alpha', { manifest: { name: '改过的 alpha' } });
  const overwritten = store.importFrom(modified, { overwrite: true });
  check('overwrite:true 才覆盖', overwritten.ok === true && overwritten.pack.name === '改过的 alpha', overwritten.ok ? overwritten.pack.name : overwritten.code);
  check('覆盖后清单真的换了', JSON.parse(readFileSync(join(storeRoot, 'alpha', PACK_MANIFEST_FILE), 'utf8')).name === '改过的 alpha');

  console.log('\n[6] 坏输入与边界');
  check('路径不存在 → E_PACK_NO_SOURCE', store.importFrom(join(tmpRoot, 'nope')).code === 'E_PACK_NO_SOURCE');
  check('空路径 → E_PACK_NO_SOURCE', store.importFrom('').code === 'E_PACK_NO_SOURCE');
  const notZip = join(tmpRoot, 'garbage.zip');
  writeFileSync(notZip, 'this is not a zip');
  check('假 zip → E_PACK_BAD_ZIP', store.importFrom(notZip).code === 'E_PACK_BAD_ZIP', store.importFrom(notZip).code);
  const txt = join(tmpRoot, 'plain.txt');
  writeFileSync(txt, 'x');
  check('不是文件夹也不是 zip → E_PACK_BAD_SOURCE', store.importFrom(txt).code === 'E_PACK_BAD_SOURCE', store.importFrom(txt).code);
  check('load 不存在的包 → E_PACK_NOT_FOUND', store.load('ghost').code === 'E_PACK_NOT_FOUND', store.load('ghost').code);
  check('load 非法 id → E_PACK_BAD_ID', store.load('../x').code === 'E_PACK_BAD_ID', store.load('../x').code);
  check('remove 非法 id → E_PACK_BAD_ID', store.remove('..').code === 'E_PACK_BAD_ID', store.remove('..').code);
  check('remove 不存在的包 → E_PACK_NOT_FOUND', store.remove('ghost').code === 'E_PACK_NOT_FOUND');
  const tinyStore = createVoicePackStore({ root: join(tmpRoot, 'tiny'), maxRefBytes: 8 });
  const bigSource = makeSource('big', { files: { 'ref.wav': Buffer.alloc(64, 7) } });
  check('参考音超过上限 → E_PACK_REF_TOO_LARGE', tinyStore.importFrom(bigSource).code === 'E_PACK_REF_TOO_LARGE');
  const noManifestDir = join(tmpRoot, 'no-manifest');
  mkdirSync(noManifestDir, { recursive: true });
  writeWav(join(noManifestDir, 'ref.wav'));
  check('没有 voice.json → E_PACK_NO_MANIFEST', store.importFrom(noManifestDir).code === 'E_PACK_NO_MANIFEST', store.importFrom(noManifestDir).code);

  console.log('\n[7] 删除');
  const removed = store.remove('implicit');
  check('删除成功', removed.ok === true);
  check('删完目录不见了', !existsSync(join(storeRoot, 'implicit')));
  check('删完 list 里也没有了', !store.list().packs.some((pack) => pack.id === 'implicit'));

  console.log('\n[8] 坏包出现在 list 的 broken 里（而不是让整个清单失败）');
  const brokenDir = join(storeRoot, 'broken-one');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, PACK_MANIFEST_FILE), JSON.stringify({ id: 'broken-one', name: '坏包' }), 'utf8');
  const listedWithBroken = store.list();
  check('好的包仍然列得出来', listedWithBroken.packs.some((pack) => pack.id === 'alpha'));
  check('坏包进 broken 并带原因', listedWithBroken.broken.some((entry) => entry.dir === 'broken-one') && listedWithBroken.broken.length === 1, JSON.stringify(listedWithBroken.broken));
  rmSync(brokenDir, { recursive: true, force: true });

  console.log('\n[8b] 带训练权重的包');
  /** 造一份「看着像真的」的权重：2 字节版本头 + 1.5MB 填充（小于 1MB 会被当成坏文件）。 */
  const fakeWeight = (header, megabytes = 1.5) => Buffer.concat([
    Buffer.from(header, 'latin1'),
    Buffer.alloc(Math.round(megabytes * 1024 * 1024), header.charCodeAt(0)),
  ]);
  const weightSource = makeSource('weighted', {
    manifest: {
      weights: { version: 'v2pro', sovits: { file: 'w/s.pth' }, gpt: { file: 'w/g.ckpt' } },
    },
    files: { 'ref.wav': FAKE_WAV, 'w/s.pth': fakeWeight('05'), 'w/g.ckpt': fakeWeight('G') },
  });
  const importedWeights = store.importFrom(weightSource);
  check('带权重的包能导入', importedWeights.ok === true, importedWeights.code ?? '');
  check('清单里的 v2pro 归一成 v2Pro', importedWeights.ok === true && importedWeights.pack.weights.version === 'v2Pro', importedWeights.ok ? importedWeights.pack.weights.version : '');
  check('权重文件真的被拷进包目录', existsSync(join(storeRoot, 'weighted', 'w', 's.pth')));
  const listedWeights = store.list().packs.find((pack) => pack.id === 'weighted');
  check('list 里带 weights 段', listedWeights !== undefined && listedWeights.weights !== null);
  check('list 里给出版本与总体积', listedWeights?.weights?.version === 'v2Pro' && listedWeights.weights.bytes > 3 * 1024 * 1024, JSON.stringify(listedWeights?.weights ?? null));
  const info = store.weightsInfo('weighted');
  check('weightsInfo 成功', info.ok === true, info.code ?? '');
  check('按文件头判出 v2Pro', info.ok === true && info.version === 'v2Pro' && info.header === '05', info.ok ? `${info.version}/${info.header}` : '');
  check('weightsInfo 给出两份 sha256', info.ok === true && /^[0-9a-f]{64}$/.test(info.sovits.sha256) && /^[0-9a-f]{64}$/.test(info.gpt.sha256));
  check('只有参考音的包 → E_PACK_NO_WEIGHTS', store.weightsInfo('alpha').code === 'E_PACK_NO_WEIGHTS', store.weightsInfo('alpha').code);

  // 声明版本与文件头不符：必须在导入时就被拦下（否则会悄悄按错架构加载）。
  const wrongVersion = makeSource('wrong-version', {
    manifest: { weights: { version: 'v2Pro', sovits: { file: 's.pth' }, gpt: { file: 'g.ckpt' } } },
    files: { 'ref.wav': FAKE_WAV, 's.pth': fakeWeight('01'), 'g.ckpt': fakeWeight('G') },
  });
  const wrongResult = store.importFrom(wrongVersion);
  check('声明 v2Pro 但头是 01(v2) → E_PACK_WEIGHTS_VERSION_MISMATCH', wrongResult.code === 'E_PACK_WEIGHTS_VERSION_MISMATCH', wrongResult.code);
  check('版本不符的包没落盘', !existsSync(join(storeRoot, 'wrong-version')));

  // PK 头是认得出来的「我不知道」，此时以清单为准，不拦（服务端有官方 MD5 表）。
  const pkSource = makeSource('pk-weights', {
    manifest: { weights: { version: 'v2Pro', sovits: { file: 's.pth' }, gpt: { file: 'g.ckpt' } } },
    files: { 'ref.wav': FAKE_WAV, 's.pth': fakeWeight('PK'), 'g.ckpt': fakeWeight('G') },
  });
  check('PK 容器（官方预训练）不被误判成版本不符', store.importFrom(pkSource).ok === true);
  check('PK 容器判成「待服务端识别」', detectSovitsVersion(join(storeRoot, 'pk-weights', 's.pth')).version === '');

  // 权重被换过 → sha256 对不上，激活前必须发现。
  const tampered = join(storeRoot, 'weighted', 'w', 'g.ckpt');
  const before = hashFile(tampered);
  const bytes = readFileSync(tampered);
  bytes[100] = bytes[100] ^ 0xff;
  writeFileSync(tampered, bytes);
  check('篡改前 sha256 与 weightsInfo 一致', before === info.gpt.sha256);
  const tamperInfo = store.weightsInfo('weighted');
  check('权重被改过 → E_PACK_WEIGHTS_SHA_MISMATCH（清单没写 sha 时靠体积/头，写了才查）', tamperInfo.ok === true || tamperInfo.code === 'E_PACK_WEIGHTS_SHA_MISMATCH', tamperInfo.code ?? 'ok');
  writeFileSync(tampered, fakeWeight('G'));
  // 上面这一条是「宽容」断言：清单没写 sha256 时我们没有依据说它被改过。
  // 现在补一条**写了 sha256** 的：这时才算硬约束。
  const pinnedSource = makeSource('pinned', {
    manifest: {
      weights: {
        version: 'v2Pro',
        sovits: { file: 's.pth' },
        gpt: { file: 'g.ckpt', sha256: 'a'.repeat(64) },
      },
    },
    files: { 'ref.wav': FAKE_WAV, 's.pth': fakeWeight('05'), 'g.ckpt': fakeWeight('G') },
  });
  const pinnedResult = store.importFrom(pinnedSource);
  check('清单写了 sha256 但文件不符 → 导入直接失败', pinnedResult.code === 'E_PACK_WEIGHTS_SHA_MISMATCH', pinnedResult.code);

  // 明显的坏输入
  const tinyWeight = makeSource('tiny-weight', {
    manifest: { weights: { version: 'v2Pro', sovits: { file: 's.pth' }, gpt: { file: 'g.ckpt' } } },
    files: { 'ref.wav': FAKE_WAV, 's.pth': Buffer.from('05'), 'g.ckpt': fakeWeight('G') },
  });
  check('权重只有 2 字节 → E_PACK_BAD_WEIGHTS', store.importFrom(tinyWeight).code === 'E_PACK_BAD_WEIGHTS');
  const strayWeight = makeSource('stray-weight', {
    manifest: { weights: { sovits: { file: '../outside.pth' }, gpt: { file: 'g.ckpt' } } },
    files: { 'ref.wav': FAKE_WAV, 'g.ckpt': fakeWeight('G') },
  });
  check('权重路径越界 → E_PACK_BAD_WEIGHTS', store.importFrom(strayWeight).code === 'E_PACK_BAD_WEIGHTS');
  const zipWithWeights = join(tmpRoot, 'weights.zip');
  writeFileSync(zipWithWeights, Buffer.from('PK\u0003\u0004', 'latin1'));
  check('权重包不走 zip：源码里有一条专门的拒法', readFileSync(modulePath, 'utf8').includes('E_PACK_WEIGHTS_NEED_FOLDER'));
  check('canonicalVersion 认 v2proplus', canonicalVersion('V2PROPLUS') === 'v2ProPlus', canonicalVersion('V2PROPLUS'));
  check('canonicalVersion 认不出来就返回空', canonicalVersion('v9') === '');
  /*
   * 07 / 08 是 v5 训练脚本写的 LoRA 头，来自 v5 包 `process_ckpt.py` 的 head2version：
   *   b"07": ["v2", "v5dev",   True]   b"08": ["v2", "v5turbo", True]
   * 漏了这两条，用 v5 训出来的包会显示「版本未知」，热换被无辜拒掉（只能重启引擎）。
   */
  check('07/08 是 v5 的 LoRA 头', SOVITS_VERSION_HEADERS['07'] === 'v5dev' && SOVITS_VERSION_HEADERS['08'] === 'v5turbo');
  check('v5 的版本名能归一', canonicalVersion('v5turbo') === 'v5turbo' && canonicalVersion('V5DEV') === 'v5dev');

  console.log('\n[8c] 带权重的包出现在 list 的 bad 里而不是让清单崩');
  const brokenWeightsDir = join(storeRoot, 'broken-weights');
  mkdirSync(brokenWeightsDir, { recursive: true });
  writeFileSync(join(brokenWeightsDir, PACK_MANIFEST_FILE), JSON.stringify({
    id: 'broken-weights',
    name: '权重丢了',
    promptText: '测试。',
    weights: { version: 'v2Pro', sovits: { file: 's.pth' }, gpt: { file: 'g.ckpt' } },
  }), 'utf8');
  writeFileSync(join(brokenWeightsDir, 'ref.wav'), FAKE_WAV);
  const brokenListing = store.list();
  check('权重缺失的包进 broken', brokenListing.broken.some((entry) => entry.dir === 'broken-weights'), JSON.stringify(brokenListing.broken));
  check('同一份清单里别的包照列', brokenListing.packs.some((pack) => pack.id === 'weighted'));
  rmSync(brokenWeightsDir, { recursive: true, force: true });

  console.log('\n[8d] 能不能热换：PK 容器一律只许重启');
  /*
   * 这一组守的是「安静地换错架构」。
   *
   * 服务端的热换接口会自己猜版本：文件头认不出时退回按大小猜（≥700MB 猜成 v3）。
   * 于是 v5 的 766MB 权重热换进 v2Pro 进程会回 200 success，音频照出，
   * 只是采样率从 32 kHz 变成 24 kHz —— 没有报错，只有「声音不太对」。
   * 所以：认出版本的才许热换，PK 容器只许换 yaml 重启。
   */
  const pkInfo = store.weightsInfo('pk-weights');
  check('weightsInfo 对 PK 容器说不能热换', pkInfo.ok === true && pkInfo.canHotSwap === false, pkInfo.ok === true ? String(pkInfo.canHotSwap) : pkInfo.code);
  check('拒绝原因说清了「文件头认不出版本」', pkInfo.ok === true && /文件头认不出版本/.test(pkInfo.hotSwapBlockedReason));
  const v2Info = store.weightsInfo('weighted');
  check('认出架构的权重可以热换', v2Info.ok === true && v2Info.canHotSwap === true && v2Info.hotSwapBlockedReason === '');
  const pkListedPack = store.list().packs.find((pack) => pack.id === 'pk-weights');
  const v2ListedPack = store.list().packs.find((pack) => pack.id === 'weighted');
  check('清单里 PK 容器的 hotSwap 是 false', pkListedPack?.weights?.hotSwap === false, JSON.stringify(pkListedPack?.weights ?? null));
  check('清单里认出架构的 hotSwap 是 true', v2ListedPack?.weights?.hotSwap === true);
  // 保守方向：调用方忘了说「这份能热换」，那就按不能算。宁可多一次重启，不要一次悄悄换错。
  const describedNoFlag = mod.describePack(normalizeManifest({
    id: 'x', name: 'x', promptText: 'y',
    weights: { version: 'v2Pro', sovits: { file: 's.pth' }, gpt: { file: 'g.ckpt' } },
  }).pack);
  check('describePack 没拿到热换资格时按 false 算', describedNoFlag.weights?.hotSwap === false);
  const hostSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/index.js'), 'utf8'));
  check('不能热换时 Host 回 409 E_PACK_WEIGHTS_NEED_RESTART', hostSource.includes('E_PACK_WEIGHTS_NEED_RESTART'));
  check('判断用的是 canHotSwap 而不是版本字符串', /info\.canHotSwap !== true/.test(hostSource));
  const bundleForHotSwap = readFileSync(resolve(PACKAGE, 'lib/client.js'), 'utf8');
  check('面板会当场说明「不能热换」', bundleForHotSwap.includes('PK 容器') && bundleForHotSwap.includes('不能热换'));

  console.log('\n[9] 接线：契约与界面都对上了');
  const customTts = stripComments(readFileSync(resolve(PACKAGE, 'lib/host/custom-tts.js'), 'utf8'));
  check('custom-tts 会把 voiceProfile 放进请求体', /voiceProfile/.test(customTts));
  const hostIndex = stripComments(readFileSync(resolve(PACKAGE, 'lib/index.js'), 'utf8'));
  check('Host 创建了音色包仓库', /createVoicePackStore\(/.test(hostIndex));
  check('Host 有 /tts/packs 清单路由', /'\/tts\/packs'/.test(hostIndex));
  check('Host 有参考音试听路由', /\/tts\/packs\/audio/.test(hostIndex));
  check('Host 有导入/启用/删除三条路由', ['import', 'activate', 'remove'].every((action) => hostIndex.includes(`'/tts/packs/${action}'`)));
  check('Host 的 /tts POST 会校验包 id', /E_TTS_NO_VOICE_PACK|E_PACK_NOT_FOUND/.test(hostIndex));
  check('Host 有 /tts/packs/weights 预览路由', hostIndex.includes("'/tts/packs/weights'"));
  check('Host 换权重走的是用户填的那个地址（不是另找一个端口）', /async function pushAdapterWeights/.test(hostIndex) && /before\.endpoint/.test(hostIndex));
  check('Host 先换成功再写偏好', hostIndex.indexOf('await pushAdapterWeights') < hostIndex.indexOf('ttsVoicePack: wanted'));
  check('Host 会告诉面板「从权重包退回来需要重启引擎」', /restartRequired/.test(hostIndex));
  check('/speak 在取不到包时传 null 而不是抛错', /voiceProfile\s*=\s*[^;]*voicePacks\.voiceProfile/.test(hostIndex));
  const adapter = readFileSync(resolve(WORKSPACE, 'tools/gptsovits-adapter.py'), 'utf8');
  check('适配层认得 voiceProfile', /voiceProfile/.test(adapter));
  check('适配层会把 base64 参考音落盘缓存', /_materialize_pack_audio/.test(adapter));
  check('适配层 GET 声明 voicePackSupport', /voicePackSupport/.test(adapter));
  check('适配层有换权重的路由', /\/weights/.test(adapter) && /def switch_weights/.test(adapter));
  check('适配层 GET 声明 weightsSupport', /weightsSupport/.test(adapter));
  check('适配层换权重前会检查文件真的是绝对路径且存在', /_check_weight_file/.test(adapter));
  const clientBundle = readFileSync(resolve(PACKAGE, 'lib/client.js'), 'utf8');
  check('面板有音色包列表容器', clientBundle.includes('tts-pack-list'));
  check('面板有启用按钮', clientBundle.includes('tts-pack-activate'));
  check('面板有听参考音按钮', clientBundle.includes('tts-pack-audition'));
  check('面板有删除按钮', clientBundle.includes('tts-pack-remove'));
  check('面板有导入路径输入框', clientBundle.includes('tts-pack-path'));
  check('面板把逐字文本印出来（用户唯一的自查线索）', clientBundle.includes('这段录音说的是'));
  check('面板会标出这一包带了模型与版本', clientBundle.includes('tts-pack-weights') && clientBundle.includes('包里带了训练好的模型'));

  console.log('\n[9b] 声音功能的可见范围（只留权重包）');
  /*
   * 用户的原话是「有关音色的功能太过杂乱了，先只留下权重包的功能，把其他两个隐藏」。
   * 这一段的证据不在画面上：开关拨错时三种症状都像「设计如此」——只有参考音的包
   * 还在列表里（没隐藏住）、正在生效的旧包被一起藏掉（关不掉了）、导入一个旧式包
   * 之后没有任何反馈（用户以为没导进去）。所以逐条对账，而不是看一眼截图。
   */
  const scope = await import(pathToFileURL(resolve(PACKAGE, 'lib/test/voice-scope.mjs')).href);
  check('默认只开权重包', scope.VOICE_SCOPE.weightPacks === true
    && scope.VOICE_SCOPE.referencePacks === false
    && scope.VOICE_SCOPE.presetClips === false);
  const refPack = { id: 'ref-only', active: false, weights: null };
  const weightPack = { id: 'with-model', active: false, weights: { version: 'v2Pro', bytes: 1 } };
  check('没有 weights 的包归 referencePacks', scope.packScopeKey(refPack) === 'referencePacks');
  check('有 weights 的包归 weightPacks', scope.packScopeKey(weightPack) === 'weightPacks');
  check('只有参考音的包不显示', scope.packVisible(refPack) === false);
  check('带模型的包显示', scope.packVisible(weightPack) === true);
  const scoped = scope.scopePacks([refPack, weightPack]);
  check('清单里只剩权重包', scoped.shown.length === 1 && scoped.shown[0].id === 'with-model' && scoped.hiddenCount === 1);
  const activeRefPack = { id: 'old-active', active: true, weights: null };
  const scopedActive = scope.scopePacks([activeRefPack, refPack, weightPack]);
  check('正在生效的隐藏包仍然显示（否则用户没法取消）',
    scopedActive.shown.some((pack) => pack.id === 'old-active') && scopedActive.activeWhileHidden.length === 1);
  check('正在生效的隐藏包不计入隐藏数', scopedActive.hiddenCount === 1);
  check('顺序不变（清单怎么给就怎么排）',
    scope.scopePacks([weightPack, refPack]).shown.map((pack) => pack.id).join(',') === 'with-model');
  check('把 referencePacks 打开就原样回来',
    scope.scopePacks([refPack, weightPack], { weightPacks: true, referencePacks: true, presetClips: true }).shown.length === 2);
  check('连权重包也关掉时清单为空（开关是三个独立布尔，不是模式）',
    scope.scopePacks([weightPack], { weightPacks: false, referencePacks: false, presetClips: false }).shown.length === 0);
  const pluginSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/plugin.ts'), 'utf8'));
  check('语音包一节由开关控制而不是删掉', /VOICE_SCOPE\.presetClips\s*\?\s*h\(VoiceSection/.test(pluginSource));
  check('音色包列表走 scopePacks 过滤', /scopePacks\(view\.voicePacks\.packs\)/.test(pluginSource));
  check('面板会解释「有几个包被隐藏」', clientBundle.includes('tts-pack-scope-note') && clientBundle.includes('已隐藏'));
  check('导入没有模型的包时明确告诉用户它被隐藏', /没有训练好的模型/.test(clientBundle));

  console.log('\n[10] 反证');
  // 反证 1：如果 safeRelativePath 放行 `..`，上面第 [2] 组的两条穿越断言必然红。
  // 这里独立验一遍「拦的是拼接前的那一步」，防止有人把校验挪到 resolve 之后。
  const sneaky = normalizeManifest({ id: 'x', name: 'x', promptText: 'y', refAudio: 'sub/../../outside.wav' });
  check('sub/../../ 这种「看起来在里面」的路径也被拒', sneaky.ok === false && sneaky.code === 'E_PACK_BAD_REF', sneaky.code);
  // 反证 2：大小检查必须发生在**拷贝之前**，否则 8MB 的文件已经躺在磁盘上了才报错。
  const oversizedDir = makeSource('oversized', { files: { 'ref.wav': Buffer.alloc(4096, 1) } });
  const tiny2 = createVoicePackStore({ root: join(tmpRoot, 'tiny2'), maxRefBytes: 16 });
  tiny2.importFrom(oversizedDir);
  check('超限的包一个字节都没落盘', !existsSync(join(tmpRoot, 'tiny2', 'oversized')));
  // 反证 3：坏清单必须带码，不能只给一句 message —— 面板靠 code 决定说人话还是说原话。
  check('所有失败都带 E_PACK_ 前缀的码', [noName, noPrompt, traversal, absolute, badExt, notObject]
    .every((result) => result.ok === false && /^E_PACK_/.test(result.code)));

  const total = passed + failed;
  console.log('');
  if (failed > 0) {
    console.log(`[22] VOICE PACK GATE FAILED  ${passed}/${total}`);
    process.exit(1);
  }
  console.log(`[22] VOICE PACK GATE PASSED  ${passed}/${total}`);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
