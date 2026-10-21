/**
 * 音色包（参考音 registry）——「换她的嗓子」的数据层。
 *
 * ## 它解决的问题
 *
 * 自定义 TTS 的契约里只有 `voice` 一个自由字符串，而 GPT-SoVITS 这类**零样本克隆**
 * 服务的音色其实由两样东西决定：一段参考音 + 这段参考音的**逐字文本**。
 * 在音色包之前，这两样只能手改 `tools/gptsovits-adapter.config.json` 再重启适配层；
 * 想换回来就得再改一次。一个「选一下就好」的开关，需要一个能被列举、校验、
 * 分享的最小单位 —— 那就是这个目录里的一个文件夹：
 *
 *   <root>/<id>/voice.json   ← 清单（谁做的、什么许可、念的是什么）
 *   <root>/<id>/ref.wav      ← 参考音（3~10 秒）
 *
 * ## 为什么参考音和它的文本必须绑在一起
 *
 * 零样本克隆里，`prompt_text` 与参考音**逐字对应**才成立。文本错一个字，
 * 合成出来就带口音甚至念错；两者分开放（一个音频库 + 一个人手填的文本框），
 * 迟早配错。所以一个包 = 音频 + 文本 + 许可，不可拆。
 *
 * ## 为什么解析与校验写成纯函数
 *
 * 门禁 `tools/test-voice-packs.mjs` 要能覆盖「清单长什么样的坏形状都能挡住」：
 * 中文 id、`../` 穿越、音频扩展名不对、promptText 为空、名字过长……
 * 造目录去测这些又慢又容易漏，所以 `normalizeManifest()` / `normalizePackId()`
 * 不碰磁盘，磁盘操作全部收在 `createVoicePackStore()` 里。
 *
 * ★ 不可信输入：`voice.json` 是用户从别处拿来的文件（可能来自一个 zip），
 *   所以 `refAudio` 只允许**包内相对路径**。放行 `../../` 等于送一个任意文件读取。
 *
 * @module dsh-live2d-pet/host/voice-packs
 */

import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import {
  isZip, normalizeEntryPath, readZipDirectory, readZipEntry,
} from './zip.js';

/** 清单文件名。放在包目录根部。 */
export const PACK_MANIFEST_FILE = 'voice.json';

/** 清单的 schema 版本。将来改结构时靠它分支。 */
export const PACK_SCHEMA = 1;

/** 参考音上限：8MB。一段 3~10 秒的 wav 通常 0.3~2MB。 */
export const MAX_REF_BYTES = 8 * 1024 * 1024;

/** 逐字文本上限：与适配层的 `MAX_TEXT_CHARS`（500）一致。 */
export const MAX_PROMPT_CHARS = 500;

/** 允许的参考音扩展名。 */
export const AUDIO_EXTENSIONS = Object.freeze(['.wav', '.mp3', '.ogg', '.flac', '.m4a']);

/**
 * 训练好的权重上限：2GB。
 *
 * 见过的最大一份是 v5 的 `s2Gv5turbo.pth`（766MB），GPT 权重 155MB；
 * 留到 2GB 是为了不误伤更大的版本，同时挡住「有人把整个模型仓库塞进来」。
 */
export const MAX_WEIGHT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * SoVITS 权重的版本「身份证」：文件头两个字节。
 *
 * 这张表抄自 GPT-SoVITS 的 `GPT_SoVITS/process_ckpt.py`（`head2version`）。
 * 为什么值得在这里再抄一遍：导入别人的模型时，**唯一可靠的版本判据就是这两个字节**。
 * 服务端自己的 `get_sovits_version_from_path_fast()` 先查前 8KB 的 MD5（只认六个官方
 * 预训练），再读这两个字节，最后才用**文件大小**兜底 —— 而 v5 的权重是 `PK` 开头、
 * 不在哈希表里、766MB ≥ 700MB，于是被它判成 **v3**：加载返回 200、声音却走错架构。
 * 所以版本要在导入这一侧先看清楚，不能等服务端猜。
 */
export const SOVITS_VERSION_HEADERS = Object.freeze({
  '00': 'v1',
  '01': 'v2',
  '02': 'v3',
  '03': 'v3',
  '04': 'v4',
  '05': 'v2Pro',
  '06': 'v2ProPlus',
  /*
   * 07 / 08 是 GPT-SoVITS v5 训练脚本写的 LoRA 头（`v5turbo-lora` / `v5dev-lora`）。
   * 表来自 v5 包的 `GPT_SoVITS/process_ckpt.py` 的 `head2version`：
   *   b"07": ["v2", "v5dev",   True]
   *   b"08": ["v2", "v5turbo", True]
   * 两个是真 LoRA（第三个元素 True）：文件里只有低秩增量（约 72 MB），
   * 加载时由服务端合并到官方底模 `s2Gv5turbo.pth` 上 —— 所以「一个音色」
   * 在这条路上 = LoRA 增量 + 官方底模，不是一份完整的 766 MB。
   */
  '07': 'v5dev',
  '08': 'v5turbo',
});

/** 允许在清单里声明的版本（小写比较，展示时用规范写法）。 */
const KNOWN_VERSIONS = Object.freeze(['v1', 'v2', 'v3', 'v4', 'v5dev', 'v5turbo', 'v2pro', 'v2proplus']);

/** id 的形状：ASCII、小写、可用 `.` `_` `-`。它要进 URL 与设置文件。 */
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 归一化包 id。
 *
 * 中文 id 看着友好，但它要进 URL query、设置文件、适配层的日志；一旦有一处
 * 忘了编码，症状是「这个包点了没反应」。所以 id 只允许 ASCII，显示名走 `name`。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizePackId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return PACK_ID_PATTERN.test(id) ? id : null;
}

/**
 * 把目录名折成合法 id：非 ASCII 字符直接判失败（不做音译，猜错了更糟）。
 *
 * @param {string} name
 * @returns {string | null}
 */
export function packIdFromDirectoryName(name) {
  if (typeof name !== 'string') return null;
  return normalizePackId(name);
}

/**
 * 校验并归一化一份清单。
 *
 * @param {unknown} raw voice.json 解析出来的对象
 * @param {{fallbackId?: string}} [options] 缺少 id 时用目录名兜底
 * @returns {{ok: true, pack: object} | {ok: false, code: string, message: string, detail?: string}}
 */
export function normalizeManifest(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'E_PACK_BAD_MANIFEST', message: '清单不是一个 JSON 对象' };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);

  const id = normalizePackId(source.id !== undefined ? source.id : options.fallbackId);
  if (id === null) {
    return {
      ok: false,
      code: 'E_PACK_BAD_ID',
      message: '清单里的 id 不合法',
      detail: 'id 只能是 ASCII 小写字母/数字/点/下划线/短横，1~64 字符，例如 "da-fei-yu"',
    };
  }

  const name = text(source.name, 80);
  if (name === '') {
    return { ok: false, code: 'E_PACK_BAD_NAME', message: '清单缺少 name（显示名）' };
  }

  const promptText = text(source.promptText, MAX_PROMPT_CHARS);
  if (promptText === '') {
    return {
      ok: false,
      code: 'E_PACK_BAD_PROMPT',
      message: '清单缺少 promptText（参考音的逐字文本）',
      detail: '零样本克隆要求这段文本与参考音逐字一致，缺了它音色会跑偏',
    };
  }

  const refAudioRaw = typeof source.refAudio === 'string' ? source.refAudio.trim() : '';
  const refAudio = refAudioRaw === '' ? '' : safeRelativePath(refAudioRaw);
  if (refAudio === null) {
    return {
      ok: false,
      code: 'E_PACK_BAD_REF',
      message: '清单里的 refAudio 只能是包内的相对路径',
      detail: `收到 ${JSON.stringify(refAudioRaw)}；不允许绝对路径或 ..`,
    };
  }
  if (refAudio !== '' && !AUDIO_EXTENSIONS.includes(extname(refAudio).toLowerCase())) {
    return {
      ok: false,
      code: 'E_PACK_BAD_REF',
      message: '参考音的扩展名不在允许列表里',
      detail: `允许 ${AUDIO_EXTENSIONS.join(' / ')}，收到 ${JSON.stringify(refAudio)}`,
    };
  }

  /*
   * 可选的一段：训练好的权重。
   *
   * 有它的包 = 「用别人训好的模型」，启用时要换服务端的权重（秒级、不重启进程）；
   * 没有它的包 = 「零样本音色」，只换参考音。两者共用同一个目录与同一套卡片，
   * 因为对用户来说它们都是「一个能换嗓子的包」，区别只在清单里多了这一段。
   */
  let weights = null;
  if (source.weights !== undefined && source.weights !== null) {
    const parsed = normalizeWeights(source.weights);
    if (parsed.ok !== true) return parsed;
    weights = parsed.weights;
  }

  const pack = {
    schema: PACK_SCHEMA,
    id,
    name,
    version: text(source.version, 32) || '1.0.0',
    description: text(source.description, 300),
    author: text(source.author, 80),
    license: text(source.license, 120),
    source: text(source.source, 200),
    promptText,
    promptLang: lang(source.promptLang),
    textLang: lang(source.textLang),
    refAudio: refAudio === '' ? '' : refAudio.split('\\').join('/'),
  };
  if (weights !== null) pack.weights = weights;
  return { ok: true, pack };
}

/**
 * 面板要画的那一条。
 *
 * @param {object} pack
 * @param {{refBytes?: number, refMime?: string, active?: boolean, weightBytes?: number, weightVersion?: string}} [extra]
 */
export function describePack(pack, extra = {}) {
  const weights = pack.weights
    ? {
      version: typeof extra.weightVersion === 'string' && extra.weightVersion !== ''
        ? extra.weightVersion
        : (pack.weights.version ?? ''),
      declared: pack.weights.version ?? '',
      sovits: pack.weights.sovits.file,
      gpt: pack.weights.gpt.file,
      bytes: Number.isFinite(extra.weightBytes) ? extra.weightBytes : 0,
      /*
       * 能不能在正在跑的服务上热换。
       *
       * 只有「文件头认出了架构」的权重才敢热换；PK 容器（新版 torch.save）认不出，
       * 服务端会退回按文件大小猜（≥700MB 猜成 v3），于是 200 success 但采样率从 48k 变 24k。
       * 列表里就把这个事实说了，别等点了「启用」才报错。
       */
      hotSwap: extra.weightHotSwap === true,
    }
    : null;
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    description: pack.description,
    author: pack.author,
    license: pack.license,
    source: pack.source,
    promptText: pack.promptText,
    promptLang: pack.promptLang,
    textLang: pack.textLang,
    refAudio: pack.refAudio,
    refBytes: Number.isFinite(extra.refBytes) ? extra.refBytes : 0,
    refMime: typeof extra.refMime === 'string' ? extra.refMime : '',
    weights,
    active: extra.active === true,
  };
}

/** 按扩展名猜 MIME。 */
export function audioMimeType(file) {
  switch (extname(String(file)).toLowerCase()) {
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.flac': return 'audio/flac';
    case '.m4a': return 'audio/mp4';
    default: return 'application/octet-stream';
  }
}

/**
 * 音色包的磁盘层。
 *
 * @param {{root: string, maxRefBytes?: number}} options
 */
export function createVoicePackStore(options) {
  const root = resolve(String(options?.root ?? ''));
  const maxRefBytes = Number.isFinite(options?.maxRefBytes) ? options.maxRefBytes : MAX_REF_BYTES;

  const packDir = (id) => join(root, id);

  function list() {
    const packs = [];
    const broken = [];
    if (!existsSync(root)) return { ok: true, root, packs, broken };
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      return { ok: false, root, packs, broken, code: 'E_PACK_LIST_FAILED', message: `列目录失败：${error?.message ?? error}` };
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = packIdFromDirectoryName(entry.name);
      if (id === null) {
        broken.push({ dir: entry.name, reason: '目录名不是合法 id（只能 ASCII）' });
        continue;
      }
      const loaded = load(id);
      if (loaded.ok !== true) {
        broken.push({ dir: entry.name, reason: loaded.message });
        continue;
      }
      packs.push(describePack(loaded.pack, {
        refBytes: loaded.refBytes,
        refMime: loaded.refMime,
        weightBytes: loaded.weights?.bytes ?? 0,
        weightVersion: loaded.weights?.detected ?? loaded.pack.weights?.version ?? '',
        weightHotSwap: loaded.weights ? loaded.weights.detected !== '' : false,
      }));
    }
    packs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return { ok: true, root, packs, broken };
  }

  function load(id) {
    const safeId = normalizePackId(id);
    if (safeId === null) {
      return { ok: false, code: 'E_PACK_BAD_ID', message: '包 id 不合法' };
    }
    const dir = packDir(safeId);
    /*
     * 「目录不存在」与「目录在但没清单」要分开报：前者是「没有这个包」，
     * 面板据此说「这个包没了（可能被删了）」；后者是「这个包坏了」，
     * 面板该说「它的 voice.json 不见了」。合成一句会让用户去修一个不存在的东西。
     */
    if (!existsSync(dir)) {
      return { ok: false, code: 'E_PACK_NOT_FOUND', message: `没有叫 ${safeId} 的音色包` };
    }
    const manifestPath = join(dir, PACK_MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      return { ok: false, code: 'E_PACK_NO_MANIFEST', message: `没有 ${PACK_MANIFEST_FILE}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      return { ok: false, code: 'E_PACK_BAD_JSON', message: `${PACK_MANIFEST_FILE} 不是合法 JSON：${error?.message ?? error}` };
    }
    const normalized = normalizeManifest(parsed, { fallbackId: safeId });
    if (normalized.ok !== true) return normalized;

    const pack = normalized.pack;
    // 清单没写 refAudio 时，目录里唯一的音频文件就是它（手搓包最常见的形状）。
    let refRelative = pack.refAudio;
    if (refRelative === '') {
      const found = findSingleAudio(dir);
      if (found === null) {
        return { ok: false, code: 'E_PACK_NO_REF', message: '包里没有参考音（清单没写 refAudio，目录里也没有音频文件）' };
      }
      refRelative = found;
    }
    const refPath = resolve(dir, refRelative);
    if (!isInside(dir, refPath)) {
      return { ok: false, code: 'E_PACK_BAD_REF', message: '参考音路径越出了包目录' };
    }
    if (!existsSync(refPath)) {
      return { ok: false, code: 'E_PACK_NO_REF', message: `参考音文件不存在：${refRelative}` };
    }
    const size = statSync(refPath).size;
    if (size > maxRefBytes) {
      return {
        ok: false,
        code: 'E_PACK_REF_TOO_LARGE',
        message: `参考音超过 ${Math.round(maxRefBytes / 1024 / 1024)}MB`,
        detail: `${size} 字节`,
      };
    }
    /*
     * 权重段：这里只做「在不在、多大、版本头对不对」三件事，**不算 sha256**。
     * 原因很实际：list() 会对每个包调一次 load()，而一份权重 300MB，
     * 算哈希要小一秒 —— 面板打开一次就把所有包全读一遍是不可接受的。
     * 哈希只在激活（weightsInfo）时算一次。
     */
    let weights = null;
    if (pack.weights !== undefined && pack.weights !== null) {
      const checked = inspectWeightFiles(dir, pack.weights);
      if (checked.ok !== true) return checked;
      weights = checked.weights;
      const declared = canonicalVersion(pack.weights.version);
      const detected = weights.detected;
      if (declared !== '' && detected !== '' && declared !== detected) {
        return {
          ok: false,
          code: 'E_PACK_WEIGHTS_VERSION_MISMATCH',
          message: `清单声明这份权重是 ${declared}，但文件头写的是 ${detected}`,
          detail: `SoVITS 权重头两个字节决定架构，按 ${declared} 加载会得到一份「不报错但不对」的模型`,
        };
      }
    }
    return {
      ok: true,
      pack: { ...pack, refAudio: refRelative.split('\\').join('/') },
      dir,
      refPath,
      refBytes: size,
      refMime: audioMimeType(refPath),
      weights,
    };
  }

  /**
   * 导入一个包：目录或 zip。
   * 已存在同 id 时**不覆盖**（覆盖会让用户丢掉自己调好的那个），除非 `overwrite`。
   */
  function importFrom(sourcePath, options2 = {}) {
    const source = typeof sourcePath === 'string' ? sourcePath.trim() : '';
    if (source === '') {
      return { ok: false, code: 'E_PACK_NO_SOURCE', message: '没有给出要导入的路径' };
    }
    const abs = resolve(source);
    if (!existsSync(abs)) {
      return { ok: false, code: 'E_PACK_NO_SOURCE', message: '这个路径不存在', detail: abs };
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) return importDirectory(abs, options2);
    if (stat.isFile() && extname(abs).toLowerCase() === '.zip') return importZipFile(abs, options2);
    return { ok: false, code: 'E_PACK_BAD_SOURCE', message: '只能导入文件夹或 .zip', detail: abs };
  }

  function importDirectory(dir, options2) {
    const manifestPath = join(dir, PACK_MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      return { ok: false, code: 'E_PACK_NO_MANIFEST', message: `文件夹里没有 ${PACK_MANIFEST_FILE}`, detail: dir };
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      return { ok: false, code: 'E_PACK_BAD_JSON', message: `${PACK_MANIFEST_FILE} 不是合法 JSON：${error?.message ?? error}` };
    }
    const normalized = normalizeManifest(parsed, { fallbackId: basename(dir) });
    if (normalized.ok !== true) return normalized;
    let pack = normalized.pack;

    let refRelative = pack.refAudio;
    if (refRelative === '') {
      const found = findSingleAudio(dir);
      if (found === null) return { ok: false, code: 'E_PACK_NO_REF', message: '文件夹里没有参考音' };
      refRelative = found;
    }
    const refPath = resolve(dir, refRelative);
    if (!isInside(dir, refPath) || !existsSync(refPath)) {
      return { ok: false, code: 'E_PACK_NO_REF', message: '参考音不存在或路径越界', detail: refRelative };
    }
    const refSize = statSync(refPath).size;
    if (refSize > maxRefBytes) {
      return { ok: false, code: 'E_PACK_REF_TOO_LARGE', message: `参考音超过 ${Math.round(maxRefBytes / 1024 / 1024)}MB` };
    }

    const target = packDir(pack.id);
    if (existsSync(target) && options2?.overwrite !== true) {
      return { ok: false, code: 'E_PACK_EXISTS', message: `已经有一个叫 ${pack.id} 的音色包了`, detail: '换个 id，或先删掉旧的' };
    }
    mkdirSync(target, { recursive: true });
    pack = { ...pack, refAudio: `ref${extname(refPath).toLowerCase()}` };
    writeFileSync(join(target, PACK_MANIFEST_FILE), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    copyFileSync(refPath, join(target, pack.refAudio));
    if (pack.weights !== undefined && pack.weights !== null) {
      const copied = copyWeightFiles(target, dir, pack.weights);
      if (copied.ok !== true) {
        // 半份包比没有更糟：盘点时它会出现在列表里，选中却用不了。
        rmSync(target, { recursive: true, force: true });
        return copied;
      }
    }
    const loaded = load(pack.id);
    if (loaded.ok !== true) {
      // 拷完再读一遍是刻意的：`load()` 是唯一权威的校验（版本头、大小、路径），
      // 导入阶段的检查只是为了让错误早出现。它说不行就得把刚落下的目录清掉，
      // 否则磁盘上留一个「列表里出现、选中却用不了」的包。
      rmSync(target, { recursive: true, force: true });
      return loaded;
    }
    return { ok: true, pack: describePack(loaded.pack, { refBytes: loaded.refBytes, refMime: loaded.refMime, weightBytes: loaded.weights?.bytes ?? 0 }), root };
  }

  function importZipFile(zipPath, options2) {
    const size = statSync(zipPath).size;
    if (size > 64 * 1024 * 1024) {
      return { ok: false, code: 'E_PACK_ZIP_TOO_LARGE', message: '音色包的 zip 上限 64MB' };
    }
    const buffer = readFileSync(zipPath);
    if (!isZip(buffer)) {
      return { ok: false, code: 'E_PACK_BAD_ZIP', message: '这不是一个 zip 文件' };
    }
    let directory;
    try {
      directory = readZipDirectory(buffer);
    } catch (error) {
      return { ok: false, code: 'E_PACK_BAD_ZIP', message: `zip 读不出来：${error?.message ?? error}` };
    }
    const entries = (directory.entries ?? []).filter((entry) => !entry.name.endsWith('/'));
    const manifestEntry = pickManifestEntry(entries);
    if (manifestEntry === null) {
      return { ok: false, code: 'E_PACK_NO_MANIFEST', message: `zip 里没有 ${PACK_MANIFEST_FILE}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(readZipEntry(buffer, manifestEntry, directory.shift).toString('utf8'));
    } catch (error) {
      return { ok: false, code: 'E_PACK_BAD_JSON', message: `${PACK_MANIFEST_FILE} 读不出来：${error?.message ?? error}` };
    }
    const normalized = normalizeManifest(parsed, { fallbackId: basename(zipPath, extname(zipPath)) });
    if (normalized.ok !== true) return normalized;
    let pack = normalized.pack;
    if (pack.weights !== undefined && pack.weights !== null) {
      /*
       * 带权重的包不走 zip：一份 SoVITS + GPT 是 280MB 上下，而 zip 通道上限 64MB。
       * 与其让用户对着「导入失败」猜，不如直接说清该用哪种方式。
       */
      return {
        ok: false,
        code: 'E_PACK_WEIGHTS_NEED_FOLDER',
        message: '带权重的音色包请用文件夹导入',
        detail: '权重有两三百 MB，超过 zip 通道的 64MB 上限；文件夹导入会直接拷过去',
      };
    }

    const prefix = manifestEntry.name.includes('/')
      ? manifestEntry.name.slice(0, manifestEntry.name.lastIndexOf('/') + 1)
      : '';
    let refRelative = pack.refAudio;
    let refEntry = null;
    if (refRelative === '') {
      const candidates = entries.filter((entry) => AUDIO_EXTENSIONS.includes(extname(entry.name).toLowerCase()));
      if (candidates.length === 0) return { ok: false, code: 'E_PACK_NO_REF', message: 'zip 里没有音频文件' };
      refEntry = candidates[0];
      refRelative = refEntry.name.slice(prefix.length);
    } else {
      const wanted = `${prefix}${refRelative}`.split('\\').join('/');
      refEntry = entries.find((entry) => normalizeEntryPath(entry.name) === normalizeEntryPath(wanted)) ?? null;
      if (refEntry === null) {
        return { ok: false, code: 'E_PACK_NO_REF', message: 'zip 里找不到清单写的参考音', detail: refRelative };
      }
    }
    if (refEntry.uncompressedSize > maxRefBytes) {
      return { ok: false, code: 'E_PACK_REF_TOO_LARGE', message: `参考音超过 ${Math.round(maxRefBytes / 1024 / 1024)}MB` };
    }
    let audio;
    try {
      audio = readZipEntry(buffer, refEntry, directory.shift);
    } catch (error) {
      return { ok: false, code: 'E_PACK_BAD_ZIP', message: `参考音读不出来：${error?.message ?? error}` };
    }
    if (audio.length > maxRefBytes) {
      return { ok: false, code: 'E_PACK_REF_TOO_LARGE', message: `参考音超过 ${Math.round(maxRefBytes / 1024 / 1024)}MB` };
    }

    const target = packDir(pack.id);
    if (existsSync(target) && options2?.overwrite !== true) {
      return { ok: false, code: 'E_PACK_EXISTS', message: `已经有一个叫 ${pack.id} 的音色包了`, detail: '换个 id，或先删掉旧的' };
    }
    mkdirSync(target, { recursive: true });
    pack = { ...pack, refAudio: `ref${extname(refEntry.name).toLowerCase()}` };
    writeFileSync(join(target, PACK_MANIFEST_FILE), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    writeFileSync(join(target, pack.refAudio), audio);
    const loaded = load(pack.id);
    if (loaded.ok !== true) return loaded;
    return { ok: true, pack: describePack(loaded.pack, { refBytes: loaded.refBytes, refMime: loaded.refMime, weightBytes: loaded.weights?.bytes ?? 0 }), root };
  }

  function remove(id) {
    const safeId = normalizePackId(id);
    if (safeId === null) return { ok: false, code: 'E_PACK_BAD_ID', message: '包 id 不合法' };
    const dir = packDir(safeId);
    if (!isInside(root, dir) || resolve(dir) === root) {
      return { ok: false, code: 'E_PACK_BAD_ID', message: '拒绝删除包目录之外的路径' };
    }
    if (!existsSync(dir)) return { ok: false, code: 'E_PACK_NOT_FOUND', message: `没有叫 ${safeId} 的音色包` };
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, id: safeId };
  }

  /**
   * 一份带权重的包，够不够「真的换上去」。
   *
   * 与 load() 的分工：load() 每次列表都会被调用，只做便宜的检查（在不在、多大、版本头）；
   * 这里算 sha256（读两三百 MB，秒级），所以只在「预览」与「启用」时各调一次。
   */
  function weightsInfo(id) {
    const loaded = load(id);
    if (loaded.ok !== true) return loaded;
    if (loaded.weights === null || loaded.weights === undefined) {
      return {
        ok: false,
        code: 'E_PACK_NO_WEIGHTS',
        message: '这个音色包只有参考音，没有训练好的权重',
        detail: '它走的是零样本克隆：启用后只换参考音，不换模型',
      };
    }
    const sovitsHash = hashFile(loaded.weights.sovits.path);
    const gptHash = hashFile(loaded.weights.gpt.path);
    for (const [label, file, hash] of [['SoVITS', loaded.weights.sovits, sovitsHash], ['GPT', loaded.weights.gpt, gptHash]]) {
      if (file.sha256 !== '' && file.sha256 !== hash) {
        return {
          ok: false,
          code: 'E_PACK_WEIGHTS_SHA_MISMATCH',
          message: `${label} 权重的 sha256 与清单不符`,
          detail: `清单写 ${file.sha256.slice(0, 16)}…，实际是 ${hash.slice(0, 16)}…；文件可能下坏了或被改过`,
        };
      }
    }
    return {
      ok: true,
      id: loaded.pack.id,
      name: loaded.pack.name,
      version: loaded.weights.detected !== '' ? loaded.weights.detected : loaded.weights.declared,
      header: loaded.weights.header,
      /*
       * 热换的资格：文件头认出了架构才行。
       *
       * 实测（§13.21）：把 766MB 的 v5 权重热换进 v2Pro 进程，服务端回 200 success，
       * 但 get_sovits_version_from_path_fast() 因为「头两个字节是 PK、不在官方哈希表、文件 ≥700MB」
       * 把它当成 v3 重建，音频照出、采样率从 32 kHz 变成 24 kHz —— 不报错但错了。
       * 所以 PK 容器一律不给热换，只能换 yaml 重启引擎。
       */
      canHotSwap: loaded.weights.detected !== '',
      hotSwapBlockedReason: loaded.weights.detected !== ''
        ? ''
        : `这套权重（${loaded.weights.declared || '未声明版本'}）是新版 PK 容器，文件头认不出版本；`
          + '热换会让服务端按文件大小猜版本（可能猜成 v3），音频照出但采样率会变。只能换 yaml 重启引擎。',
      sovits: { path: loaded.weights.sovits.path, bytes: loaded.weights.sovits.bytes, sha256: sovitsHash },
      gpt: { path: loaded.weights.gpt.path, bytes: loaded.weights.gpt.bytes, sha256: gptHash },
      bytes: loaded.weights.bytes,
    };
  }

  /**
   * 合成时随请求带给适配层的那一小块。
   *
   * 同时给**路径**与**内容**：同机适配层直接读路径（快、零拷贝），
   * 跨机/容器里的适配层读不到路径，就退回 base64。
   */
  function voiceProfile(id, options2 = {}) {
    const safeId = normalizePackId(id);
    if (safeId === null) return null;
    const loaded = load(safeId);
    if (loaded.ok !== true) return null;
    const maxBase64Bytes = Number.isFinite(options2?.maxBase64Bytes) ? options2.maxBase64Bytes : 2 * 1024 * 1024;
    const profile = {
      id: loaded.pack.id,
      name: loaded.pack.name,
      promptText: loaded.pack.promptText,
      promptLang: loaded.pack.promptLang,
      textLang: loaded.pack.textLang,
      refAudioPath: loaded.refPath,
      refAudioSha256: sha256(readFileSync(loaded.refPath)),
    };
    if (loaded.refBytes <= maxBase64Bytes) {
      profile.refAudioBase64 = readFileSync(loaded.refPath).toString('base64');
    }
    return profile;
  }

  function audio(id) {
    const loaded = load(id);
    if (loaded.ok !== true) return loaded;
    return { ok: true, path: loaded.refPath, mime: loaded.refMime, bytes: loaded.refBytes };
  }

  return {
    root, list, load, importFrom, remove, voiceProfile, audio, weightsInfo,
  };
}

/** 找出目录里唯一的音频文件（手搓包里最常见的形状）。 */
function findSingleAudio(dir) {
  let found = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!AUDIO_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue;
    if (found !== null) return null; // 多个音频：猜不出是哪个，要求清单写明
    found = entry.name;
  }
  return found;
}

function pickManifestEntry(entries) {
  // 根目录优先，其次任意一层里的（zip 里常见的「<id>/voice.json」）
  const exact = entries.find((entry) => normalizeEntryPath(entry.name) === PACK_MANIFEST_FILE);
  if (exact !== undefined) return exact;
  const nested = entries.filter((entry) => entry.name.endsWith(`/${PACK_MANIFEST_FILE}`));
  return nested.length === 1 ? nested[0] : null;
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function lang(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === '') return 'zh';
  return /^[a-z]{2,8}$/.test(raw) ? raw : 'zh';
}

function safeRelativePath(value) {
  const normalized = value.split('\\').join('/').trim();
  if (normalized === '') return '';
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '' || part === '.')) return null;
  return parts.join('/');
}

function isInside(parent, child) {
  const rel = resolve(child).slice(resolve(parent).length);
  return resolve(child).startsWith(resolve(parent)) && (rel === '' || rel.startsWith(sep) || rel.startsWith('/') || rel.startsWith('\\'));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 把清单里写的版本名归一成服务端认的那几个拼法。
 *
 * 清单是手写的，`v2pro` / `v2Pro` / `V2PRO` 都是同一个人想说的东西；
 * 而服务端用的是 `v2Pro` / `v2ProPlus` 这两种大小写。认不出来一律当「没声明」。
 */
export function canonicalVersion(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === '' || !KNOWN_VERSIONS.includes(raw)) return '';
  if (raw === 'v2pro') return 'v2Pro';
  if (raw === 'v2proplus') return 'v2ProPlus';
  return raw;
}

/**
 * 读 SoVITS 权重的前两个字节，判断它到底是哪一版。
 *
 * 为什么这件事必须由我们自己做：服务端的 `get_sovits_version_from_path_fast()`
 * 在「不在 MD5 表里、也不是已知文件头」时会退回**按文件大小猜**（≥700MB → v3）。
 * 实测把 766MB 的 v5 权重塞进 v2Pro 进程：**200 success**、能出声，
 * 但架构按 v3 重建，采样率悄悄从 32kHz 变成 24kHz。不报错但不对，最难查。
 *
 * 返回的 `version` 为空表示「认不出来」（例如新版 PK 容器），此时交给服务端按 MD5 表认。
 */
export function detectSovitsVersion(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(2);
    const read = readSync(fd, head, 0, 2, 0);
    if (read < 2) return { header: '', version: '' };
    const header = head.toString('latin1');
    if (header === 'PK') return { header, version: '' };
    return { header, version: SOVITS_VERSION_HEADERS[header] ?? '' };
  } catch {
    return { header: '', version: '' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 1MB 分块算 sha256：权重有三百 MB，一次性读进内存没必要。 */
export function hashFile(filePath) {
  const hash = createHash('sha256');
  const fd = openSync(filePath, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let read = 0;
    while ((read = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function normalizeWeights(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'E_PACK_BAD_WEIGHTS', message: 'weights 不是一个对象' };
  }
  const source = raw;
  const declared = typeof source.version === 'string' ? source.version.trim() : '';
  const version = canonicalVersion(declared);
  if (declared !== '' && version === '') {
    return {
      ok: false,
      code: 'E_PACK_BAD_WEIGHTS',
      message: 'weights.version 认不出来',
      detail: `只认 ${KNOWN_VERSIONS.join(' / ')}；不确定就留空，我们按文件头判`,
    };
  }
  const sovits = normalizeWeightFile(source.sovits, '.pth', 'sovits');
  if (sovits.ok !== true) return sovits;
  const gpt = normalizeWeightFile(source.gpt, '.ckpt', 'gpt');
  if (gpt.ok !== true) return gpt;
  return { ok: true, weights: { version, sovits: sovits.file, gpt: gpt.file } };
}

function normalizeWeightFile(raw, extension, label) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'E_PACK_BAD_WEIGHTS', message: `weights.${label} 缺一个 {file} 对象` };
  }
  const file = safeRelativePath(typeof raw.file === 'string' ? raw.file : '');
  if (file === null || file === '') {
    return { ok: false, code: 'E_PACK_BAD_WEIGHTS', message: `weights.${label}.file 只能是包内相对路径`, detail: String(raw.file ?? '') };
  }
  if (extname(file).toLowerCase() !== extension) {
    return { ok: false, code: 'E_PACK_BAD_WEIGHTS', message: `weights.${label}.file 应以 ${extension} 结尾`, detail: file };
  }
  const digest = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  if (digest !== '' && !/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, code: 'E_PACK_BAD_WEIGHTS', message: `weights.${label}.sha256 不是 64 位十六进制` };
  }
  return { ok: true, file: { file, sha256: digest } };
}

/**
 * 清单说有权重时，检查它在不在、多大、版本头对不对。
 *
 * 故意**不算 sha256**：list() 会对每个包调一次 load()，而一份权重三百 MB，
 * 面板打开一次就把所有包读一遍是不可接受的。哈希只在激活时算（weightsInfo）。
 */
function inspectWeightFiles(dir, weights) {
  const sovitsPath = resolve(dir, weights.sovits.file);
  const gptPath = resolve(dir, weights.gpt.file);
  const parts = [['SoVITS', sovitsPath, weights.sovits], ['GPT', gptPath, weights.gpt]];
  for (const [label, filePath, file] of parts) {
    if (!isInside(dir, filePath)) {
      return { ok: false, code: 'E_PACK_BAD_WEIGHTS', message: `${label} 权重路径越出了包目录`, detail: file.file };
    }
    if (!existsSync(filePath)) {
      return { ok: false, code: 'E_PACK_NO_WEIGHTS', message: `包里没有 ${label} 权重`, detail: file.file };
    }
    const bytes = statSync(filePath).size;
    if (bytes > MAX_WEIGHT_BYTES) {
      return { ok: false, code: 'E_PACK_WEIGHTS_TOO_LARGE', message: `${label} 权重超过 2GB`, detail: `${bytes} 字节` };
    }
    if (bytes < 1024 * 1024) {
      return {
        ok: false,
        code: 'E_PACK_BAD_WEIGHTS',
        message: `${label} 权重只有 ${bytes} 字节`,
        detail: '这不像是模型文件；如果是下载到一半的，请重新下',
      };
    }
  }
  const detected = detectSovitsVersion(sovitsPath);
  const sovitsBytes = statSync(sovitsPath).size;
  const gptBytes = statSync(gptPath).size;
  return {
    ok: true,
    weights: {
      declared: canonicalVersion(weights.version),
      detected: detected.version,
      header: detected.header,
      sovits: { path: sovitsPath, file: weights.sovits.file, bytes: sovitsBytes, sha256: weights.sovits.sha256 },
      gpt: { path: gptPath, file: weights.gpt.file, bytes: gptBytes, sha256: weights.gpt.sha256 },
      bytes: sovitsBytes + gptBytes,
    },
  };
}

/** 导入时把两份权重搬进包目录（保留清单里写的相对路径）。 */
function copyWeightFiles(target, sourceDir, weights) {
  const parts = [['SoVITS', weights.sovits], ['GPT', weights.gpt]];
  for (const [label, file] of parts) {
    const source = resolve(sourceDir, file.file);
    if (!isInside(sourceDir, source)) {
      return { ok: false, code: 'E_PACK_BAD_WEIGHTS', message: `${label} 权重路径越出了包目录`, detail: file.file };
    }
    if (!existsSync(source)) {
      return { ok: false, code: 'E_PACK_NO_WEIGHTS', message: `文件夹里没有 ${label} 权重`, detail: file.file };
    }
    const bytes = statSync(source).size;
    if (bytes > MAX_WEIGHT_BYTES) {
      return { ok: false, code: 'E_PACK_WEIGHTS_TOO_LARGE', message: `${label} 权重超过 2GB`, detail: `${bytes} 字节` };
    }
    if (bytes < 1024 * 1024) {
      return { ok: false, code: 'E_PACK_BAD_WEIGHTS', message: `${label} 权重只有 ${bytes} 字节`, detail: file.file };
    }
    if (file.sha256 !== '' && hashFile(source) !== file.sha256) {
      return {
        ok: false,
        code: 'E_PACK_WEIGHTS_SHA_MISMATCH',
        message: `${label} 权重的 sha256 与清单不符`,
        detail: '文件可能下坏了或被改过；先重新下载再导入',
      };
    }
    const destination = resolve(target, file.file);
    if (!isInside(target, destination)) {
      return { ok: false, code: 'E_PACK_BAD_WEIGHTS', message: `${label} 权重路径越界`, detail: file.file };
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return { ok: true };
}
