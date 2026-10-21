/**
 * 本地语音包 —— 清单格式（`voices.json`）与选片逻辑。
 *
 * ## 它解决的问题
 *
 * 插件目前只有一条出声通道：`/speak` → Edge-TTS → base64 → `playBase64()`。
 * 这条通道念的是**文本**，声音是合成的、腔调由引擎决定。想让她用自己的录音
 * 说话（同人音源、配音素材、自己录的台词），就必须有第二个音源：磁盘上的
 * 音频文件。
 *
 * 关键前提：**口型不用另做**。`playBase64()` 把字节解成 AudioBuffer 之后算包络
 * （`createEnvelope`），嘴跟的是解码后的 PCM，与「这段音频从哪来」无关。所以
 * 本地语音只要走到 `playBase64()`，口型、字幕、朗读状态就全部免费拿到。
 *
 * ## 为什么这个文件零 import
 *
 * 门禁 `tools/test-voice-pack.mjs` 直接 import 它（不是 import 打包产物）。
 * 一旦这里引入 `node:fs`，判定逻辑就与「磁盘长什么样」绑死，只能靠造目录来测，
 * 而真正容易写错的是**清单里那一堆形状不一的条目**（字符串、null、重复 id、
 * 穿越路径、中文文件名）—— 这些用纯函数测最省事。所以：
 *
 *   - 本文件只做**判断**，不碰磁盘；
 *   - 路由层（`lib/index.js`）负责读文件、列出目录、把结果拼成 `names` 传进来。
 *
 * 情绪名归一化也是注入的（`options.canonicalEmotion`）：`emotions.js` 里那张别名表
 * 是权威，但把它 import 进来会让「情绪表改了」连累语音包的判定看起来也变了。
 * 注入之后两边的耦合只剩一个函数签名。
 *
 * ## 两个「不能省」的约束
 *
 * 1. **`id` 必须是 ASCII**。它要进 URL query（`/voice?clip=…`）与工具参数，
 *    中文 id 会在各处引出编码问题，而症状是「这条语音点了没反应」。
 *    文件名可以是中文 —— `sanitizeClipId()` 负责把它折成合法 id。
 * 2. **`file` 只能是包内的相对路径**。`file` 由清单作者（外部文件）书写，
 *    和 zip 导入一样属于不可信输入；`../../` 一旦被放行，`/voice` 就是任意文件读取。
 *
 * @module dsh-live2d-pet/host/voice-pack
 */

/** 清单文件名。放在包目录根部。 */
export const VOICE_MANIFEST_NAME = 'voices.json';

/**
 * 清单格式版本。
 *
 * 现在只有一个版本，校验它的理由不是「兼容未来」，而是**拒绝未来**：
 * 用户拿到一个 v2 的包时，报 `E_VOICE_FORMAT` 让他去更新插件，
 * 比按 v1 强行解析（然后某些字段被静默忽略、语音听起来不对）好得多。
 */
export const VOICE_FORMAT = 1;

/** 一个包最多多少条语音。超出部分被截断并报出来，不静默丢弃。 */
export const MAX_CLIPS = 500;
export const MAX_CLIP_ID_CHARS = 64;
/** 字幕文本上限。与 `live2d_speak` 的文本上限无关：这里只是「这句录音对应的字」。 */
export const MAX_CLIP_TEXT_CHARS = 200;
export const MAX_PACK_NAME_CHARS = 40;
export const MAX_TAGS = 8;
export const MAX_TAG_CHARS = 24;

/**
 * 能吃进来的音频扩展名。
 *
 * 白名单而不是黑名单：`decodeAudioData()` 对不认识的容器是**异步 reject**，
 * 症状是「点了没声音、面板上什么都不显示」。在清单校验这一步就拒掉，
 * 用户至少能看到是哪个文件不行。
 */
export const VOICE_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

/**
 * 扩展名 → MIME。
 *
 * 注意：`playBase64()` 走的是 `decodeAudioData(bytes)`，**不看 MIME**
 * （见 `src/client/speech.ts` 的 `base64ToBytes`）。所以这里只是让 `/voice`
 * 的响应诚实、让 `<audio>` 之类的旁路能用；写错了不会影响口型。
 */
const MIME_BY_EXTENSION = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
});

/** 合法 id：字母数字开头，长度受限，只允许 `[A-Za-z0-9._-]`。 */
const CLIP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `file` 里不能出现的形状（与 `ref-path.js` 的 `isSafeRefPath` 同一套判据，但不限后缀）。 */
const ABSOLUTE_PATH_PATTERN = /^[\\/]|^[a-zA-Z]:/;

/** 失败结果。所有 `ok:false` 都长这样，调用方只认 `code`/`detail`。 */
function fail(code, detail, extra = null) {
  return { ok: false, code, detail, ...(extra ?? {}) };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clipText(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(0, max);
}

/** 取扩展名（含点、小写）。 */
function extensionOf(name) {
  const text = String(name ?? '');
  const cut = text.lastIndexOf('.');
  return cut <= 0 ? '' : text.slice(cut).toLowerCase();
}

/** 去掉扩展名的文件名部分。 */
function stemOf(name) {
  const text = String(name ?? '').replace(/\\/g, '/');
  const base = text.slice(text.lastIndexOf('/') + 1);
  const cut = base.lastIndexOf('.');
  return cut <= 0 ? base : base.slice(0, cut);
}

/**
 * 这个文件名是不是音频（只看扩展名）。
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isVoiceFileName(name) {
  return VOICE_EXTENSIONS.includes(extensionOf(name));
}

/**
 * 这个文件名的 MIME；不认识的扩展名回 `application/octet-stream`。
 *
 * @param {unknown} name
 * @returns {string}
 */
export function voiceMimeType(name) {
  return MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * 把一个任意文件名（可以是中文）折成合法 id。
 *
 * 规则：非 `[A-Za-z0-9._-]` 的字符逐字换成 `-`，合并连续的 `-`，去掉首尾的
 * `-` 与 `.`，夹到 `MAX_CLIP_ID_CHARS`；折完是空的（纯中文名，例如「早上好」）
 * 就回 `fallback`。`fallback` 必须由调用方给一个**包内唯一**的值（松散扫描时
 * 用序号），否则两个中文文件名会折成同一个 id。
 *
 * 只判空的理由：首尾的 `-` / `.` 上面已经剥掉了，剩下的字符全在
 * `[A-Za-z0-9._-]` 里，所以非空结果**必然**以字母数字开头 ——
 * 再判一次首字符是一条永远为真的分支，门禁的反证段也已经证实它没有牙。
 *
 * 例：`早上好.mp3` → `fallback`；`greet 01.wav` → `greet-01`；`A/B.mp3` → `B`。
 *
 * @param {unknown} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitizeClipId(name, fallback = 'clip') {
  const raw = stemOf(name);
  const id = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_CLIP_ID_CHARS);
  return id === '' ? fallback : id;
}

/**
 * 包内相对路径是否安全。
 *
 * @param {unknown} value
 * @returns {{ ok: boolean, path: string, reason: string }}
 */
export function checkVoiceFilePath(value) {
  if (typeof value !== 'string') {
    return { ok: false, path: '', reason: '路径不是字符串' };
  }
  const raw = value.trim();
  if (raw === '') return { ok: false, path: '', reason: '路径是空的' };
  const unified = raw.replace(/\\/g, '/');
  if (ABSOLUTE_PATH_PATTERN.test(raw)) {
    return { ok: false, path: raw, reason: '不能是绝对路径（只接受包内的相对路径）' };
  }
  const segments = unified.split('/');
  if (segments.includes('..')) {
    return { ok: false, path: raw, reason: '不能含 `..`（会跑出包目录）' };
  }
  if (!isVoiceFileName(unified)) {
    return {
      ok: false,
      path: raw,
      reason: `扩展名不在白名单里（只支持 ${VOICE_EXTENSIONS.join(' / ')}）`,
    };
  }
  return { ok: true, path: unified, reason: '' };
}

/**
 * 解析 `voices.json`。
 *
 * 判定分两层，这一点是刻意的：
 *   - **整包级**错误（不是 JSON、`clips` 不是数组、格式版本不对、一条都没剩下）
 *     直接 `ok:false` —— 这种包没法用，含糊地收下只会让用户对着空面板发愁。
 *   - **单条级**错误（某个 id 非法、文件不存在、路径穿越）只丢掉那一条，并把
 *     原因记进 `problems`。一个 200 条的包里有一条写错，不该整包作废。
 *
 * @param {string} text 清单文件的**原文**（不是路径）
 * @param {{ files?: string[]|Set<string>, canonicalEmotion?: (name: string) => string, dirName?: string }} [options]
 *   `files` 给出时校验「文件真的在包里」；不给则跳过（纯单元测试用）。
 * @returns {{ ok: true, pack: object, problems: object[] } | { ok: false, code: string, detail: string }}
 */
export function parseVoiceManifest(text, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch (error) {
    return fail('E_VOICE_MANIFEST_JSON', `voices.json 不是合法 JSON：${error?.message ?? error}`);
  }

  if (!isPlainObject(parsed)) {
    return fail('E_VOICE_MANIFEST_SHAPE', 'voices.json 的顶层必须是一个对象');
  }

  if (parsed.format !== undefined && parsed.format !== VOICE_FORMAT) {
    return fail(
      'E_VOICE_FORMAT',
      `这个包是 format ${JSON.stringify(parsed.format)}，本插件只认 format ${VOICE_FORMAT}`,
    );
  }

  if (!Array.isArray(parsed.clips)) {
    return fail('E_VOICE_MANIFEST_SHAPE', 'voices.json 缺少 clips 数组');
  }

  const fileSet = options.files === undefined ? null : new Set([...options.files].map((n) => String(n).replace(/\\/g, '/')));
  const canonicalEmotion = typeof options.canonicalEmotion === 'function'
    ? options.canonicalEmotion
    : (name) => String(name ?? '').trim();

  const problems = [];
  const clips = [];
  const seen = new Set();
  let truncated = 0;

  for (let index = 0; index < parsed.clips.length; index += 1) {
    const entry = parsed.clips[index];
    const where = `clips[${index}]`;

    if (!isPlainObject(entry)) {
      problems.push({ code: 'E_VOICE_CLIP_NOT_OBJECT', path: where, detail: '这一条不是对象' });
      continue;
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id === '' || id.length > MAX_CLIP_ID_CHARS || !CLIP_ID_PATTERN.test(id)) {
      problems.push({
        code: 'E_VOICE_ID_INVALID',
        path: where,
        detail: `id ${JSON.stringify(entry.id ?? null)} 不合法：只允许字母数字开头的 [A-Za-z0-9._-]，最长 ${MAX_CLIP_ID_CHARS} 字符`,
      });
      continue;
    }
    if (seen.has(id)) {
      // 重复 id 的后果是「点播永远拿到同一条」，而清单里看着有两条 —— 静默取第一条
      // 会让作者以为后一条也生效了。
      problems.push({ code: 'E_VOICE_DUP_ID', path: where, detail: `id「${id}」重复，后一条被丢弃` });
      continue;
    }

    const checked = checkVoiceFilePath(entry.file);
    if (!checked.ok) {
      problems.push({ code: 'E_VOICE_FILE_UNSAFE', path: where, detail: `file：${checked.reason}` });
      continue;
    }
    if (fileSet !== null && !fileSet.has(checked.path)) {
      problems.push({
        code: 'E_VOICE_FILE_MISSING',
        path: where,
        detail: `清单写着「${checked.path}」，但包里没有这个文件`,
      });
      continue;
    }

    if (clips.length >= MAX_CLIPS) {
      truncated += 1;
      continue;
    }

    const emotionRaw = typeof entry.emotion === 'string' ? entry.emotion.trim() : '';
    const emotion = emotionRaw === '' ? '' : String(canonicalEmotion(emotionRaw) ?? emotionRaw).trim();
    if (emotionRaw !== '' && emotion === '') {
      // 归一化把非空写回空，说明这张情绪表里没有它。语音照样能播，所以只报不改。
      problems.push({ code: 'E_VOICE_UNKNOWN_EMOTION', path: where, detail: `情绪「${emotionRaw}」不在情绪表里` });
    }

    const tags = Array.isArray(entry.tags)
      ? entry.tags
        .filter((tag) => typeof tag === 'string' && tag.trim() !== '')
        .slice(0, MAX_TAGS)
        .map((tag) => clipText(tag.trim(), MAX_TAG_CHARS))
      : [];

    seen.add(id);
    clips.push({
      id,
      file: checked.path,
      text: clipText(typeof entry.text === 'string' ? entry.text.trim() : '', MAX_CLIP_TEXT_CHARS),
      emotion: emotionRaw === '' ? '' : (emotion || emotionRaw),
      tags,
      durationSeconds: Number.isFinite(entry.durationSeconds) && entry.durationSeconds > 0
        ? Number(entry.durationSeconds)
        : null,
    });
  }

  if (truncated > 0) {
    problems.push({
      code: 'E_VOICE_CLIP_TOO_MANY',
      path: 'clips',
      detail: `超过 ${MAX_CLIPS} 条上限，后面的 ${truncated} 条没有收录`,
    });
  }

  if (clips.length === 0) {
    return fail(
      'E_VOICE_NO_CLIPS',
      problems.length === 0
        ? 'voices.json 里一条语音都没有'
        : `voices.json 里没有一条能用的语音（第一个问题：${problems[0].code} ${problems[0].detail}）`,
    );
  }

  const name = clipText(
    typeof parsed.name === 'string' && parsed.name.trim() !== ''
      ? parsed.name.trim()
      : String(options.dirName ?? ''),
    MAX_PACK_NAME_CHARS,
  );

  return {
    ok: true,
    pack: {
      name,
      format: parsed.format ?? VOICE_FORMAT,
      clips,
      /** 清单里显式写的默认包标记（多个包都写 true 时由路由层挑目录序第一个并报出来）。 */
      isDefault: parsed.default === true,
      source: 'manifest',
    },
    problems,
  };
}

/**
 * 没有 `voices.json` 时，从文件名列表里凑一份清单。
 *
 * 为什么要有这条路径：用户手上多半是「一堆 mp3」，让他先手写清单再试听，
 * 等于把格式文档变成了使用门槛。约定很轻：
 *
 *   - 子目录名当情绪：`happy/greet-01.mp3` → id `greet-01`、情绪 `happy`；
 *   - 根目录的文件没有情绪：`greet-01.mp3` → id `greet-01`；
 *   - 文件名里的非 ASCII 字符由 `sanitizeClipId()` 折掉，撞名时加 `-2`、`-3`；
 *   - 没有文本 → 字幕显示 id（`text: ''`，面板那边回落到 id）。
 *
 * @param {string[]|Set<string>} names 包内的**相对路径**（`/` 分隔）
 * @param {{ canonicalEmotion?: (name: string) => string }} [options]
 * @returns {{ clips: object[], problems: object[] }}
 */
export function looseVoiceClips(names, options = {}) {
  const canonicalEmotion = typeof options.canonicalEmotion === 'function'
    ? options.canonicalEmotion
    : (name) => String(name ?? '').trim();

  const clips = [];
  const problems = [];
  const used = new Set();
  const list = [...names]
    .map((name) => String(name).replace(/\\/g, '/'))
    .filter((name) => isVoiceFileName(name) && checkVoiceFilePath(name).ok)
    .sort();

  for (const file of list) {
    if (clips.length >= MAX_CLIPS) {
      problems.push({
        code: 'E_VOICE_CLIP_TOO_MANY',
        path: file,
        detail: `超过 ${MAX_CLIPS} 条上限，后面的文件没有收录`,
      });
      break;
    }

    const base = sanitizeClipId(file, '');
    let id = base === '' ? `clip-${clips.length + 1}` : base;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);

    const segments = file.split('/');
    const dirEmotion = segments.length > 1 ? String(canonicalEmotion(segments[0]) ?? segments[0]).trim() : '';

    clips.push({
      id,
      file,
      text: '',
      emotion: dirEmotion,
      tags: [],
      durationSeconds: null,
    });
  }

  return { clips, problems };
}

/**
 * 从包里挑一条语音。
 *
 * 三种选题方式，优先级就是参数顺序：**点名 → 按情绪 → 随机**。
 *
 * 「按情绪挑不到时退到任意一条」是默认行为，而且 `fallback: true` 会把
 * 「退过了」这件事报出来。理由：AI 调 `live2d_play_voice({emotion:'难过'})`
 * 时，包里没有难过语音而**一句都不播**，比播一条不对味的更让人困惑；
 * 但返回值必须承认它退过，否则 AI 会以为自己选中的是难过那条。
 *
 * @param {{ clips: object[] }} pack
 * @param {{ id?: string, emotion?: string, rng?: () => number, allowFallback?: boolean }} [options]
 * @returns {{ ok: true, clip: object, fallback: boolean } | { ok: false, code: string, detail: string, available?: string[] }}
 */
export function pickClip(pack, options = {}) {
  const clips = Array.isArray(pack?.clips) ? pack.clips : [];
  if (clips.length === 0) {
    return fail('E_VOICE_EMPTY_PACK', '这个语音包里一条语音都没有', { available: [] });
  }

  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const pickOne = (pool) => pool[Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)))];

  const wantedId = typeof options.id === 'string' ? options.id.trim() : '';
  if (wantedId !== '') {
    const hit = clips.find((clip) => clip.id === wantedId);
    if (!hit) {
      return fail('E_VOICE_UNKNOWN_CLIP', `这个包里没有 id 为「${wantedId}」的语音`, {
        available: clips.slice(0, 20).map((clip) => clip.id),
      });
    }
    return { ok: true, clip: hit, fallback: false };
  }

  const wantedEmotion = typeof options.emotion === 'string' ? options.emotion.trim() : '';
  if (wantedEmotion !== '') {
    const pool = clips.filter((clip) => clip.emotion !== '' && clip.emotion === wantedEmotion);
    if (pool.length > 0) return { ok: true, clip: pickOne(pool), fallback: false };
    if (options.allowFallback === false) {
      return fail('E_VOICE_NO_EMOTION_CLIP', `这个包里没有「${wantedEmotion}」的语音`, {
        available: clips.slice(0, 20).map((clip) => clip.id),
      });
    }
    return { ok: true, clip: pickOne(clips), fallback: true };
  }

  return { ok: true, clip: pickOne(clips), fallback: false };
}

/**
 * 面板与 `/voices` 共用的摘要。
 *
 * @param {{ name?: string, clips: object[] }} pack
 * @returns {{ name: string, clipCount: number, emotions: string[], withText: number, withEmotion: number }}
 */
export function summarizeVoicePack(pack) {
  const clips = Array.isArray(pack?.clips) ? pack.clips : [];
  const emotions = [];
  let withText = 0;
  let withEmotion = 0;
  for (const clip of clips) {
    if (clip.text !== '') withText += 1;
    if (clip.emotion !== '') {
      withEmotion += 1;
      if (!emotions.includes(clip.emotion)) emotions.push(clip.emotion);
    }
  }
  return {
    name: String(pack?.name ?? ''),
    clipCount: clips.length,
    emotions,
    withText,
    withEmotion,
  };
}
