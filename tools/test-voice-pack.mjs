#!/usr/bin/env node
/**
 * 门禁：**本地语音包的清单格式与选片逻辑**（`lib/host/voice-pack.js`）。
 *
 * ## 为什么需要这个文件
 *
 * 语音包要解决「让她用自己的录音说话」，而清单 `voices.json` 是**用户手写的外部
 * 文件** —— 它和 zip 导入一样属于不可信输入，但它不像 zip 那样有二进制格式兜底：
 * 写错一个字段，最坏的结果不是报错，而是**静默地不对**：
 *
 *   - `id` 写成中文 —— 面板上列得出来，点播时 URL 编码一乱就「点了没反应」；
 *   - `file` 写了 `../../` —— 放行的话 `/voice` 就是任意文件读取；
 *   - 两条语音 `id` 相同 —— 点播永远拿到第一条，而清单里看着有两条；
 *   - 按情绪挑不到语音时静默退到任意一条 —— AI 以为自己点的就是「难过」那条。
 *
 * 这些错法没有一个会让程序崩，所以只能靠断言钉住。第 [10] 段把真代码里的三条
 * 守卫**弄坏**再 import，断言同一类判据变假 —— 否则「坏输入被拒绝」可能只是因为
 * 那个输入本来就无害。
 *
 * ## 为什么 import 源码而不是打包产物
 *
 * `voice-pack.js` 是零 import 的纯模块（不碰 `node:fs`），门禁可以**直接** import
 * 它。与 `lib/test/*.mjs` 那批产物不同，这里没有构建环节，所以门禁跑的是
 * 「用户装上的那一份」本身。
 *
 * ## 用法
 *
 *     node tools/test-voice-pack.mjs     （离线：无网络、无 DOM、不碰真目录）
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MAX_CLIP_TEXT_CHARS,
  MAX_CLIPS,
  MAX_PACK_NAME_CHARS,
  VOICE_EXTENSIONS,
  VOICE_FORMAT,
  VOICE_MANIFEST_NAME,
  checkVoiceFilePath,
  isVoiceFileName,
  looseVoiceClips,
  parseVoiceManifest,
  pickClip,
  sanitizeClipId,
  summarizeVoicePack,
  voiceMimeType,
} from '../dsh-live2d-pet/lib/host/voice-pack.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', 'dsh-live2d-pet');
const sourcePath = resolve(packageRoot, 'lib/host/voice-pack.js');

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

/** 情绪表替身：happy/开心 → 开心，sad/难过 → 难过，其余归一成空（模拟「表里没有」）。 */
const canonicalEmotion = (name) => {
  const table = {
    happy: '开心', 开心: '开心', sad: '难过', 难过: '难过', neutral: '平静', 平静: '平静',
  };
  return table[String(name).trim()] ?? '';
};

const manifestOf = (value) => JSON.stringify(value);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [1] 扩展名白名单与 MIME
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[1] 扩展名白名单与 MIME');

check('清单文件名固定是 voices.json', VOICE_MANIFEST_NAME === 'voices.json');
check('格式版本是 1', VOICE_FORMAT === 1);
check('白名单五种：mp3 / wav / ogg / m4a / flac',
  VOICE_EXTENSIONS.length === 5 && ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].every((ext) => VOICE_EXTENSIONS.includes(ext)));

check('认 .mp3', isVoiceFileName('a.mp3') === true);
check('扩展名大小写不敏感（.WAV 也认）', isVoiceFileName('a.WAV') === true);
check('不认 .txt', isVoiceFileName('a.txt') === false);
check('不认没有扩展名的文件', isVoiceFileName('voices') === false);
check('不认 .mp3.bak（看最后一段扩展名）', isVoiceFileName('a.mp3.bak') === false);
check('MIME：mp3 → audio/mpeg', voiceMimeType('a.mp3') === 'audio/mpeg');
check('MIME：m4a → audio/mp4', voiceMimeType('a.m4a') === 'audio/mp4');
check('MIME：不认识的扩展名回 application/octet-stream', voiceMimeType('a.xyz') === 'application/octet-stream');

/* ══════════════════════════════════════════════════════════════════════════ *
 * [2] sanitizeClipId —— 中文文件名怎么变成合法 id
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[2] id 折名（sanitizeClipId）');

check('普通文件名原样保留', sanitizeClipId('greet-01.mp3') === 'greet-01');
check('空格折成连字符', sanitizeClipId('greet 01.wav') === 'greet-01');
check('中文名折不出东西 → 回 fallback（否则会得到空 id）',
  sanitizeClipId('早上好.mp3', 'clip-7') === 'clip-7');
check('中文与英文混排只保留英文部分',
  sanitizeClipId('hello 早上好 world.mp3') === 'hello-world');
check('带路径的文件名只取最后一段', sanitizeClipId('happy/greet-01.mp3') === 'greet-01');
check('反斜杠路径同样只取最后一段', sanitizeClipId('happy\\greet-01.mp3') === 'greet-01');
check('数字开头是合法的', sanitizeClipId('01-intro.mp3') === '01-intro');
check('开头的点被吃掉（隐藏文件名）', sanitizeClipId('.hidden.mp3') === 'hidden');
check('超长名被夹到 64 字符以内', sanitizeClipId(`${'a'.repeat(200)}.mp3`).length === 64);
check('连续的分隔符合并成一个连字符', sanitizeClipId('a   b.mp3') === 'a-b');

/* ══════════════════════════════════════════════════════════════════════════ *
 * [3] checkVoiceFilePath —— 路径穿越这道门
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[3] 包内路径安全（checkVoiceFilePath）');

check('普通相对路径通过', checkVoiceFilePath('greet-01.mp3').ok === true);
check('子目录通过', checkVoiceFilePath('sub/dir/x.mp3').ok === true);
check('反斜杠被归一成正斜杠', checkVoiceFilePath('sub\\dir\\x.mp3').path === 'sub/dir/x.mp3');
check('`..` 被拒（否则 /voice 变成任意文件读取）', checkVoiceFilePath('../../secret.mp3').ok === false);
check('藏在中间的 `..` 也被拒', checkVoiceFilePath('a/../../b.mp3').ok === false);
check('Windows 绝对路径被拒（C:/x.mp3）', checkVoiceFilePath('C:/x.mp3').ok === false);
check('POSIX 绝对路径被拒（/x.mp3）', checkVoiceFilePath('/x.mp3').ok === false);
check('反斜杠开头的绝对路径被拒（\\x.mp3）', checkVoiceFilePath('\\x.mp3').ok === false);
check('非音频扩展名被拒', checkVoiceFilePath('notes.txt').ok === false);
check('空字符串被拒', checkVoiceFilePath('').ok === false);
check('非字符串被拒', checkVoiceFilePath(null).ok === false);
check('被拒时给出原因（面板要能显示）', checkVoiceFilePath('../../x.mp3').reason.includes('..'));

/* ══════════════════════════════════════════════════════════════════════════ *
 * [4] parseVoiceManifest —— 一份能用的清单
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[4] 清单解析：正常路径');

const GOOD = manifestOf({
  format: 1,
  name: '示例语音包',
  default: true,
  clips: [
    { id: 'greet-01', file: 'greet-01.mp3', text: '早上好呀。', emotion: 'happy' },
    { id: 'sad-01', file: 'sub/sad-01.wav', emotion: '难过', tags: ['低谷', '深夜'], durationSeconds: 2.5 },
  ],
});
const good = parseVoiceManifest(GOOD, { files: ['greet-01.mp3', 'sub/sad-01.wav'], canonicalEmotion });

check('整包通过', good.ok === true, good.ok ? '' : good.detail);
check('两条语音都收下', good.ok && good.pack.clips.length === 2);
check('包名来自清单', good.ok && good.pack.name === '示例语音包');
check('default 标记透传', good.ok && good.pack.isDefault === true);
check('来源标成 manifest', good.ok && good.pack.source === 'manifest');
check('情绪被归一化（happy → 开心）', good.ok && good.pack.clips[0].emotion === '开心');
check('文本透传', good.ok && good.pack.clips[0].text === '早上好呀。');
check('没有文本时是空串（面板回落到 id）', good.ok && good.pack.clips[1].text === '');
check('tags 透传', good.ok && good.pack.clips[1].tags.length === 2);
check('durationSeconds 透传', good.ok && good.pack.clips[1].durationSeconds === 2.5);
check('没有 problems 时是空数组', good.ok && good.problems.length === 0);
check('文件路径被归一成正斜杠', good.ok && good.pack.clips[1].file === 'sub/sad-01.wav');

const noFiles = parseVoiceManifest(GOOD, { canonicalEmotion });
check('不给 files 时跳过「文件真的在吗」的检查', noFiles.ok === true && noFiles.pack.clips.length === 2);

const noName = parseVoiceManifest(manifestOf({ clips: [{ id: 'a', file: 'a.mp3' }] }), {
  files: ['a.mp3'], dirName: '我的包',
});
check('清单没写 name 时回落到目录名', noName.ok && noName.pack.name === '我的包');

const longName = parseVoiceManifest(
  manifestOf({ name: '长'.repeat(200), clips: [{ id: 'a', file: 'a.mp3' }] }),
  { files: ['a.mp3'] },
);
check(`包名被夹到 ${MAX_PACK_NAME_CHARS} 字`, longName.ok && longName.pack.name.length === MAX_PACK_NAME_CHARS);

const longText = parseVoiceManifest(
  manifestOf({ clips: [{ id: 'a', file: 'a.mp3', text: '字'.repeat(500) }] }),
  { files: ['a.mp3'] },
);
check(`文本被夹到 ${MAX_CLIP_TEXT_CHARS} 字`, longText.ok && longText.pack.clips[0].text.length === MAX_CLIP_TEXT_CHARS);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [5] 整包级错误：这个包没法用
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[5] 清单解析：整包级错误');

const badJson = parseVoiceManifest('{ not json', {});
check('不是 JSON → E_VOICE_MANIFEST_JSON', badJson.ok === false && badJson.code === 'E_VOICE_MANIFEST_JSON');

const topArray = parseVoiceManifest('[1,2,3]', {});
check('顶层是数组 → E_VOICE_MANIFEST_SHAPE', topArray.ok === false && topArray.code === 'E_VOICE_MANIFEST_SHAPE');

const noClips = parseVoiceManifest(manifestOf({ name: 'x' }), {});
check('缺 clips → E_VOICE_MANIFEST_SHAPE', noClips.ok === false && noClips.code === 'E_VOICE_MANIFEST_SHAPE');

const emptyClips = parseVoiceManifest(manifestOf({ clips: [] }), {});
check('clips 是空数组 → E_VOICE_NO_CLIPS', emptyClips.ok === false && emptyClips.code === 'E_VOICE_NO_CLIPS');

const futureFormat = parseVoiceManifest(manifestOf({ format: 2, clips: [{ id: 'a', file: 'a.mp3' }] }), {});
check('format 2 → E_VOICE_FORMAT（拒绝而不是硬解）',
  futureFormat.ok === false && futureFormat.code === 'E_VOICE_FORMAT');

const noFormat = parseVoiceManifest(manifestOf({ clips: [{ id: 'a', file: 'a.mp3' }] }), { files: ['a.mp3'] });
check('省略 format 时按 1 处理', noFormat.ok === true);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [6] 单条级错误：只丢那一条，并说明原因
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[6] 清单解析：单条级错误（丢一条、留其余）');

const mixed = parseVoiceManifest(manifestOf({
  clips: [
    { id: 'ok-1', file: 'ok-1.mp3' },
    'not an object',
    { id: '', file: 'x.mp3' },
    { id: '中文id', file: 'x.mp3' },
    { id: 'ok-1', file: 'dup.mp3' },
    { id: 'escape', file: '../../secret.mp3' },
    { id: 'txt', file: 'notes.txt' },
    { id: 'missing', file: 'nope.mp3' },
    { id: 'ok-2', file: 'ok-2.mp3', emotion: '震惊' },
  ],
}), { files: ['ok-1.mp3', 'ok-2.mp3', 'dup.mp3', 'notes.txt'], canonicalEmotion });

const codes = mixed.ok ? mixed.problems.map((problem) => problem.code) : [];
check('剩下的两条仍然可用', mixed.ok === true && mixed.pack.clips.length === 2);
check('空 id 被拒（E_VOICE_ID_INVALID）', codes.includes('E_VOICE_ID_INVALID'));
check('中文 id 被拒（E_VOICE_ID_INVALID）', codes.filter((code) => code === 'E_VOICE_ID_INVALID').length === 2);
check('重复 id 被拒（E_VOICE_DUP_ID）', codes.includes('E_VOICE_DUP_ID'));
check('穿越路径被拒（E_VOICE_FILE_UNSAFE）', codes.includes('E_VOICE_FILE_UNSAFE'));
check('文件不存在被拒（E_VOICE_FILE_MISSING）', codes.includes('E_VOICE_FILE_MISSING'));
check('不是对象被拒（E_VOICE_CLIP_NOT_OBJECT）', codes.includes('E_VOICE_CLIP_NOT_OBJECT'));
check('不认识的扩展名被拒（E_VOICE_FILE_UNSAFE）', codes.filter((code) => code === 'E_VOICE_FILE_UNSAFE').length === 2);
check('不在情绪表里的情绪只警告、不丢片（E_VOICE_UNKNOWN_EMOTION）', codes.includes('E_VOICE_UNKNOWN_EMOTION'));
check('警告之后这条语音仍然能播', mixed.ok && mixed.pack.clips.some((clip) => clip.id === 'ok-2'));
check('情绪原样保留（认不出的名字不丢）',
  mixed.ok && mixed.pack.clips.find((clip) => clip.id === 'ok-2').emotion === '震惊');
check('每条 problem 都带位置（能指到清单的哪一行）',
  mixed.ok && mixed.problems.every((problem) => typeof problem.path === 'string' && problem.path !== ''));

const allBad = parseVoiceManifest(manifestOf({ clips: [{ id: 'x', file: '../../x.mp3' }] }), {});
check('一条都不剩时整包失败，并把第一个问题带出来',
  allBad.ok === false && allBad.code === 'E_VOICE_NO_CLIPS' && allBad.detail.includes('E_VOICE_FILE_UNSAFE'));

const many = parseVoiceManifest(manifestOf({
  clips: Array.from({ length: MAX_CLIPS + 5 }, (_, index) => ({ id: `c-${index}`, file: `c-${index}.mp3` })),
}), {});
check(`超过 ${MAX_CLIPS} 条时截断`, many.ok === true && many.pack.clips.length === MAX_CLIPS);
check('截断要报出来（不静默丢）',
  many.ok === true && many.problems.some((problem) => problem.code === 'E_VOICE_CLIP_TOO_MANY' && problem.detail.includes('5')));

/* ══════════════════════════════════════════════════════════════════════════ *
 * [7] 没有清单时：松散扫描
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[7] 松散扫描（没有 voices.json）');

const loose = looseVoiceClips([
  'neutral/a.mp3',
  'happy/greet-01.mp3',
  'sad/greet-01.mp3',
  'top-level.wav',
  'notes.txt',
  '../evil.mp3',
  '开心/早上好.mp3',
], { canonicalEmotion });

const looseIds = loose.clips.map((clip) => clip.id);
check('只收音频文件（notes.txt 被跳过）', loose.clips.length === 5, `实际 ${loose.clips.length}`);
check('子目录名当情绪（happy → 开心）',
  loose.clips.find((clip) => clip.id === 'greet-01')?.emotion === '开心');
check('根目录的文件没有情绪', loose.clips.find((clip) => clip.id === 'top-level')?.emotion === '');
check('中文文件名回落到 clip-N', looseIds.includes('clip-5'), looseIds.join(','));
check('没有文本时 text 是空串', loose.clips.every((clip) => clip.text === ''));
check('`..` 的条目被跳过（不进清单）', !loose.clips.some((clip) => clip.file.includes('..')));
check('撞名时加序号（两条 greet-01 都在）',
  looseIds.includes('greet-01') && looseIds.includes('greet-01-2'), looseIds.join(','));
check('id 全部唯一', new Set(looseIds).size === looseIds.length);
check('id 全部合法（ASCII）', looseIds.every((id) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)));
check('排序稳定（同一份输入两次结果一致）',
  looseVoiceClips(['b/b.mp3', 'a/a.mp3'], {}).clips.map((clip) => clip.id).join(',') === 'a,b');
check('空输入得到空清单', looseVoiceClips([]).clips.length === 0);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [8] pickClip —— 点名 / 按情绪 / 随机
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[8] 选片（pickClip）');

const PACK = {
  clips: [
    { id: 'greet-01', file: 'greet-01.mp3', text: '早上好', emotion: '开心', tags: [], durationSeconds: null },
    { id: 'happy-02', file: 'happy-02.mp3', text: '好耶', emotion: '开心', tags: [], durationSeconds: null },
    { id: 'sad-01', file: 'sad-01.mp3', text: '……', emotion: '难过', tags: [], durationSeconds: null },
    { id: 'plain-01', file: 'plain-01.mp3', text: '', emotion: '', tags: [], durationSeconds: null },
  ],
};
const zero = () => 0;
const almostOne = () => 0.999;

const byId = pickClip(PACK, { id: 'sad-01' });
check('点名命中', byId.ok === true && byId.clip.id === 'sad-01');

const byIdMiss = pickClip(PACK, { id: 'nope' });
check('点名未命中 → E_VOICE_UNKNOWN_CLIP', byIdMiss.ok === false && byIdMiss.code === 'E_VOICE_UNKNOWN_CLIP');
check('未命中时把可选 id 报回来（AI 能自我纠正）',
  byIdMiss.ok === false && Array.isArray(byIdMiss.available) && byIdMiss.available.includes('greet-01'));

const idWins = pickClip(PACK, { id: 'sad-01', emotion: '开心' });
check('点名优先于情绪', idWins.ok === true && idWins.clip.id === 'sad-01');

const byEmotion = pickClip(PACK, { emotion: '难过', rng: zero });
check('按情绪命中', byEmotion.ok === true && byEmotion.clip.id === 'sad-01' && byEmotion.fallback === false);

const emotionPool = pickClip(PACK, { emotion: '开心', rng: almostOne });
check('同一情绪的池里随机（rng=0.999 取池尾）',
  emotionPool.ok === true && emotionPool.clip.id === 'happy-02');

const fallback = pickClip(PACK, { emotion: '惊讶', rng: zero });
check('情绪挑不到时退到任意一条，并标记 fallback', fallback.ok === true && fallback.fallback === true);

const noFallback = pickClip(PACK, { emotion: '惊讶', allowFallback: false });
check('allowFallback:false 时拒绝退让（E_VOICE_NO_EMOTION_CLIP）',
  noFallback.ok === false && noFallback.code === 'E_VOICE_NO_EMOTION_CLIP');

const randomPick = pickClip(PACK, { rng: zero });
check('不点名不按情绪时随机一条', randomPick.ok === true && randomPick.clip.id === 'greet-01');
const randomTail = pickClip(PACK, { rng: almostOne });
check('rng 落在末尾时取最后一条', randomTail.ok === true && randomTail.clip.id === 'plain-01');
check('rng 超界也不越界（夹取）', pickClip(PACK, { rng: () => 9 }).ok === true);

const emptyPack = pickClip({ clips: [] }, {});
check('空包 → E_VOICE_EMPTY_PACK', emptyPack.ok === false && emptyPack.code === 'E_VOICE_EMPTY_PACK');
check('包为 null 也不抛', pickClip(null, {}).ok === false);

check('没有情绪的语音不会被「按情绪」选中（emoji 池只含真标了情绪的）',
  pickClip({ clips: [{ id: 'plain', emotion: '', file: 'p.mp3' }] }, { emotion: '开心', rng: zero }).fallback === true);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [9] 摘要（面板与 /voices 共用）
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[9] 摘要（summarizeVoicePack）');

const summary = summarizeVoicePack({ name: '示例', clips: PACK.clips });
check('条数对', summary.clipCount === 4);
check('情绪去重后两种', summary.emotions.length === 2 && summary.emotions.includes('开心'));
check('有文本的 3 条', summary.withText === 3);
check('有情绪的 3 条', summary.withEmotion === 3);
check('空包不抛', summarizeVoicePack(null).clipCount === 0);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [10] 反证：把守卫弄坏，判据必须变假
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[10] 反证（把真代码的守卫弄坏，同一批评据必须失败）');

const source = readFileSync(sourcePath, 'utf8');

async function loadMutated(from, to, tag) {
  if (!source.includes(from)) {
    throw new Error(`反证锚点没找到（源码改过了？）：${JSON.stringify(from.slice(0, 60))}`);
  }
  const dir = mkdtempSync(join(tmpdir(), `dsh-voicepack-${tag}-`));
  const file = join(dir, 'voice-pack.mjs');
  writeFileSync(file, source.replace(from, to), 'utf8');
  const mod = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

/* --- 反证 1：拿掉 `..` 检查，穿越路径必须变成「通过」 --- */
{
  const mutated = await loadMutated(
    "if (segments.includes('..')) {",
    'if (false) {',
    'traversal',
  );
  check('反证 1：去掉 `..` 守卫后 ../../secret.mp3 变成「合法」',
    mutated.checkVoiceFilePath('../../secret.mp3').ok === true);
  check('反证 1 对照：真代码拒绝它', checkVoiceFilePath('../../secret.mp3').ok === false);
}

/* --- 反证 2：让「禁止退让」失效，它必须开始静默退让 --- */
{
  const mutated = await loadMutated(
    'if (options.allowFallback === false) {',
    'if (false) {',
    'fallback',
  );
  const result = mutated.pickClip(PACK, { emotion: '惊讶', allowFallback: false });
  check('反证 2：拆掉 allowFallback 守卫后它开始静默退让',
    result.ok === true && result.fallback === true);
  check('反证 2 对照：真代码拒绝退让', noFallback.ok === false);
}

/* --- 反证 3：拿掉扩展名白名单，notes.txt 必须变成「合法音频路径」 --- */
{
  const mutated = await loadMutated(
    'if (!isVoiceFileName(unified)) {',
    'if (false) {',
    'extension',
  );
  check('反证 3：拆掉扩展名白名单后 notes.txt 被当成合法路径',
    mutated.checkVoiceFilePath('notes.txt').ok === true);
  check('反证 3 对照：真代码拒绝它', checkVoiceFilePath('notes.txt').ok === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✔' : '✘'} VOICE PACK GATE —— ${passed} 项通过、${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
