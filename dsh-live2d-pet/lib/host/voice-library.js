/**
 * 语音包库：把磁盘上的目录读成 `voice-pack.js` 能吃的输入。
 *
 * ── 为什么要分成两个文件 ────────────────────────────────────────────────
 *
 * `voice-pack.js` 是**零 import 的纯模块**：它只认字符串和对象，从不碰磁盘。
 * 于是它的门禁（`tools/test-voice-pack.mjs`）可以 import 源码本身，不必先打包、
 * 不必造临时目录 —— 106 项断言在 60ms 里跑完。代价是「目录里到底有什么」
 * 这件事必须由另一层去做，也就是这个文件。
 *
 * 分工是硬的：**这里只做 IO，所有判断都在 `voice-pack.js`**。路径安全、
 * id 合法性、扩展名白名单一条都不许在这层重新实现 —— 那种重复实现的第二份
 * 永远是漏掉守卫的那一份（`model-import.js` 踩过同一个坑）。
 *
 * ── 为什么没有缓存 ──────────────────────────────────────────────────────
 *
 * 模型库那边有体检缓存，因为体检要解析 moc3 头、数纹理、读 physics —— 一个
 * 模型几十毫秒。语音包这边只有「列目录 + 读一个小 JSON + stat 每个文件」，
 * 一个 500 条的包也就几毫秒，而**用户的迭代方式是「改完 json 立刻试听」**：
 * 缓存只会让它看到旧清单。不可见的缓存比慢一点糟糕得多。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  MAX_CLIPS,
  VOICE_MANIFEST_NAME,
  checkVoiceFilePath,
  looseVoiceClips,
  parseVoiceManifest,
  pickClip,
  summarizeVoicePack,
  voiceMimeType,
} from './voice-pack.js';

/** 清单体积上限：正常 500 条的清单 < 100 KB，1 MB 已经能塞进几万条了。 */
export const MAX_VOICE_MANIFEST_BYTES = 1024 * 1024;

/** 一个包最多扫多少个文件（防止有人把整个音乐库丢进一个包里）。 */
export const MAX_PACK_FILES = 4000;

/** 一次最多列多少个包。 */
export const DEFAULT_MAX_PACKS = 200;

/** 目录名合法性：一层目录名，不是路径，不隐藏，不含分隔符。 */
const PACK_DIR_NAME = /^[^\\/:*?"<>|.][^\\/:*?"<>|]*$/;

/**
 * 判断一个名字能否当包目录名（即能否出现在 URL 的 `?pack=` 里）。
 *
 * 和 `/import` 的 `sanitizeLibraryName` 不同，这里**不修正**而是**拒绝**：
 * 目录是用户自己在磁盘上建的，插件没有权限替他改名；能做的是拒绝那些
 * 会逃出根目录的名字，并在 `/voices` 里带着原因列出来。
 */
export function checkPackName(name) {
  const value = typeof name === 'string' ? name : '';
  if (value === '') return { ok: false, reason: 'E_VOICE_PACK_NAME_EMPTY' };
  if (value === '.' || value === '..') return { ok: false, reason: 'E_VOICE_PACK_NAME_UNSAFE' };
  if (value.includes('/') || value.includes('\\')) return { ok: false, reason: 'E_VOICE_PACK_NAME_UNSAFE' };
  if (value.startsWith('.')) return { ok: false, reason: 'E_VOICE_PACK_NAME_HIDDEN' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return { ok: false, reason: 'E_VOICE_PACK_NAME_UNSAFE' };
  if (value.length > 120) return { ok: false, reason: 'E_VOICE_PACK_NAME_TOO_LONG' };
  return { ok: true, reason: null };
}

/** 递归列出包内文件的相对路径（`/` 分隔），最多 `MAX_PACK_FILES` 条。 */
function listPackFiles(dir, limit = MAX_PACK_FILES) {
  const out = [];
  const walk = (current, prefix, depth) => {
    if (out.length >= limit || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // 无权限的子目录跳过：一个坏的子目录不该让整个包消失
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(current, entry.name), rel, depth + 1);
        continue;
      }
      if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, '', 0);
  return out;
}

function problem(code, message, detail, path) {
  const entry = { code, message, detail: detail === undefined ? '' : String(detail) };
  if (path !== undefined) entry.path = path;
  return entry;
}

/**
 * 把 `voice-pack.js` 产出的问题（`{ code, path, detail }`）补成面板能直接渲染的形状。
 *
 * 纯模块那边刻意不带 `message`：它只有错误码和具体细节，短句留给展示层。
 * 这里补一个空串而不是编一句话 —— 「这句话由谁来说」是界面的事，Host 不该抢。
 */
function normalizeProblems(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => ({
    code: typeof entry?.code === 'string' ? entry.code : 'E_VOICE_UNKNOWN',
    message: typeof entry?.message === 'string' ? entry.message : '',
    detail: typeof entry?.detail === 'string' ? entry.detail : '',
    ...(typeof entry?.path === 'string' ? { path: entry.path } : {}),
  }));
}

/** 给清单里的每条 clip 补上文件体积（面板要显示「≈12 KB」这类信息）。 */
function withBytes(root, dirName, clips) {
  return clips.map((clip) => {
    let bytes = 0;
    try {
      bytes = statSync(join(root, dirName, ...clip.file.split('/'))).size;
    } catch {
      bytes = 0; // 文件不存在时 parseVoiceManifest 已经记过 E_VOICE_FILE_MISSING
    }
    return { ...clip, bytes };
  });
}

/**
 * 读一个包。
 *
 * **永远返回一个对象，不抛异常**。坏包的完整信息在 `problems[]` 里 ——
 * 一个包写坏了不该让整张清单消失（与模型库体检同一条原则）。
 *
 * @param {string} root 语音库根目录（绝对路径）
 * @param {string} dirName 包目录名
 * @param {{ canonicalEmotion?: (name: string) => string | null }} [options]
 */
export function readVoicePack(root, dirName, options = {}) {
  const nameCheck = checkPackName(dirName);
  if (!nameCheck.ok) {
    return {
      ok: false,
      dirName,
      name: dirName,
      hasManifest: false,
      clipCount: 0,
      emotions: [],
      withText: 0,
      withEmotion: 0,
      clips: [],
      problems: [problem(nameCheck.reason, '这个目录名不能当语音包用', '名字里不能有路径分隔符，也不能以点开头')],
    };
  }

  const dir = join(root, dirName);
  const files = listPackFiles(dir);
  const manifestPath = join(dir, VOICE_MANIFEST_NAME);

  if (!existsSync(manifestPath)) {
    const loose = looseVoiceClips(files, { canonicalEmotion: options.canonicalEmotion });
    const clips = withBytes(root, dirName, loose.clips);
    return {
      ok: clips.length > 0,
      dirName,
      name: dirName,
      hasManifest: false,
      clipCount: clips.length,
      ...summarizeVoicePack({ name: dirName, clips }),
      clips,
      problems: normalizeProblems(loose.problems),
    };
  }

  let text;
  try {
    const size = statSync(manifestPath).size;
    if (size > MAX_VOICE_MANIFEST_BYTES) {
      return {
        ok: false,
        dirName,
        name: dirName,
        hasManifest: true,
        clipCount: 0,
        emotions: [],
        withText: 0,
        withEmotion: 0,
        clips: [],
        problems: [problem('E_VOICE_MANIFEST_TOO_LARGE', '语音清单太大了', `${size} 字节 > ${MAX_VOICE_MANIFEST_BYTES} 字节`)],
      };
    }
    text = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      dirName,
      name: dirName,
      hasManifest: true,
      clipCount: 0,
      emotions: [],
      withText: 0,
      withEmotion: 0,
      clips: [],
      problems: [problem('E_VOICE_MANIFEST_READ', '读不了 voices.json', String(error?.message ?? error))],
    };
  }

  const parsed = parseVoiceManifest(text, {
    files,
    canonicalEmotion: options.canonicalEmotion,
    dirName,
  });

  if (parsed.ok !== true) {
    return {
      ok: false,
      dirName,
      name: dirName,
      hasManifest: true,
      clipCount: 0,
      emotions: [],
      withText: 0,
      withEmotion: 0,
      clips: [],
      problems: [problem(parsed.code ?? 'E_VOICE_MANIFEST_SHAPE', '语音清单不可用', parsed.detail)],
    };
  }

  const clips = withBytes(root, dirName, parsed.pack.clips);
  return {
    ok: clips.length > 0,
    dirName,
    name: parsed.pack.name,
    hasManifest: true,
    isDefault: parsed.pack.isDefault === true,
    format: parsed.pack.format,
    clipCount: clips.length,
    ...summarizeVoicePack({ name: parsed.pack.name, clips }),
    clips,
    problems: normalizeProblems(parsed.problems),
  };
}

/**
 * 扫描整个语音库。
 *
 * 与模型库一样**不做索引文件**：用户的包是他自己拖进目录的，索引一旦和现实
 * 不一致，症状就是「包明明在里面却不在列表里」。
 *
 * @param {string} root
 * @param {{ canonicalEmotion?: (name: string) => string | null, maxPacks?: number }} [options]
 */
export function scanVoiceLibrary(root, options = {}) {
  const started = Date.now();
  const maxPacks = Number.isFinite(options.maxPacks) ? Math.max(1, Math.floor(options.maxPacks)) : DEFAULT_MAX_PACKS;

  const result = {
    root,
    rootExists: existsSync(root),
    packs: [],
    truncated: false,
    scannedDirs: 0,
    durationMs: 0,
    summary: { packs: 0, clips: 0, okPacks: 0, badPacks: 0, problems: 0 },
  };

  if (!result.rootExists) {
    result.durationMs = Date.now() - started;
    return result;
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    result.durationMs = Date.now() - started;
    result.error = String(error?.message ?? error);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (result.packs.length >= maxPacks) {
      result.truncated = true;
      break;
    }
    result.scannedDirs += 1;
    try {
      result.packs.push(readVoicePack(root, entry.name, options));
    } catch (error) {
      result.packs.push({
        ok: false,
        dirName: entry.name,
        name: entry.name,
        hasManifest: false,
        clipCount: 0,
        emotions: [],
        withText: 0,
        withEmotion: 0,
        clips: [],
        problems: [problem('E_VOICE_PACK_READ', '扫描这个包时出错了', String(error?.message ?? error))],
      });
    }
  }

  result.packs.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  result.summary = {
    packs: result.packs.length,
    clips: result.packs.reduce((sum, pack) => sum + pack.clipCount, 0),
    okPacks: result.packs.filter((pack) => pack.ok).length,
    badPacks: result.packs.filter((pack) => !pack.ok).length,
    problems: result.packs.reduce((sum, pack) => sum + pack.problems.length, 0),
  };
  result.durationMs = Date.now() - started;
  return result;
}

/**
 * 把「包名 + clip id / 情绪」解析成一个**磁盘上真实存在**的音频文件。
 *
 * 这是唯一一处把 URL 参数变成路径的地方，因此两道检查都在这里：
 * 目录名合法性（`checkPackName`，挡住 `..` 与分隔符）和最终路径仍须在
 * 根目录之内（挡住符号链接与奇怪的拼接）。
 *
 * @returns {{ok: true, path: string, mimeType: string, pack: string, clip: object}
 *   | {ok: false, code: string, detail: string, available?: string[]}}
 */
export function resolveVoiceClip(root, query, options = {}) {
  const packName = typeof query?.pack === 'string' ? query.pack : '';
  const nameCheck = checkPackName(packName);
  if (!nameCheck.ok) {
    return { ok: false, code: nameCheck.reason, detail: packName };
  }

  const packDir = resolve(root, packName);
  const rootResolved = resolve(root);
  if (packDir !== rootResolved && !packDir.startsWith(rootResolved + sep)) {
    return { ok: false, code: 'E_VOICE_PACK_NAME_UNSAFE', detail: packName };
  }

  const pack = readVoicePack(root, packName, options);
  if (pack.clips.length === 0) {
    return {
      ok: false,
      code: pack.problems[0]?.code ?? 'E_VOICE_PACK_EMPTY',
      detail: pack.problems[0]?.detail ?? pack.problems[0]?.message ?? '这个语音包里没有可用的音频',
    };
  }

  const clipId = typeof query?.clip === 'string' && query.clip !== '' ? query.clip : null;
  const emotion = typeof query?.emotion === 'string' && query.emotion !== '' ? query.emotion : null;

  const picked = pickClip(pack, {
    id: clipId ?? undefined,
    emotion: emotion ?? undefined,
    rng: options.rng,
    allowFallback: options.allowFallback,
  });

  if (picked.ok !== true) {
    return {
      ok: false,
      code: picked.code,
      detail: picked.detail,
      available: pack.clips.map((clip) => clip.id),
    };
  }

  const fileCheck = checkVoiceFilePath(picked.clip.file);
  if (!fileCheck.ok) {
    return { ok: false, code: fileCheck.reason, detail: picked.clip.file };
  }

  const absolute = resolve(packDir, ...fileCheck.path.split('/'));
  if (absolute !== packDir && !absolute.startsWith(packDir + sep)) {
    return { ok: false, code: 'E_VOICE_FILE_UNSAFE', detail: picked.clip.file };
  }

  return {
    ok: true,
    path: absolute,
    mimeType: voiceMimeType(picked.clip.file),
    pack: packName,
    clip: picked.clip,
    fallback: picked.fallback === true,
  };
}

export { MAX_CLIPS };
