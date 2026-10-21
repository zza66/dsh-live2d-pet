/**
 * 最小 ZIP 读取器 —— 只做「读」，不做「写」，只用 `node:` 内置模块。
 *
 * ## 为什么自己写而不是装一个包
 *
 * 和 `lib/host/edge-tts-drm.js` 同样的判断：能用内置模块解决的事不引入依赖。
 * 但这里的理由比那边更硬 —— 插件是以 `link:` 装进 profile 的，裸模块名要靠
 * `createRequire(import.meta.url)` 才能解析；多一个包就多一个「开发机上好好的、
 * 用户机器上 ERR_MODULE_NOT_FOUND」的机会，而那个失败模式的表现是**整个插件不激活**
 * （桌宠直接消失，日志只有一行 failed to import），排查成本远高于这 300 行。
 *
 * ## 只需要格式的一小半
 *
 * 导入模型包用不到 ZIP 的加密、分卷、数据描述符写入等能力，所以只实现：
 * 中央目录解析、本地头定位、`stored`(0) 与 `deflate`(8) 两种压缩方法、CRC32 校验。
 * 其余情形**一律报明确的错**，而不是猜 —— 见下面的错误码。
 *
 * ## 本模块是纯的
 *
 * 只读 buffer、绝不碰文件系统。这样做是为了让门禁可以在内存里造 zip 来测它，
 * 不需要往磁盘上写任何东西。写盘由 `model-import.js` 负责。
 */

import { inflateRawSync } from 'node:zlib';

/** 四个用得到的签名。`zip64*` 只用于识别并给出可读的错误。 */
export const ZIP_SIGNATURE = {
  local: 0x04034b50,
  central: 0x02014b50,
  eocd: 0x06054b50,
  zip64Eocd: 0x06064b50,
  zip64Locator: 0x07064b50,
};

export const ZIP_METHOD = { stored: 0, deflate: 8 };

/**
 * 单个 zip 的硬上限。
 *
 * 定这个数的方法是回头看用户库里真实存在的包：`空 - 免费版` 解压后 93MB
 * （三张 8192×8192 的 PNG），`miku` 31MB。PNG 本身已经压过，再打一次 zip
 * 收益很小，所以「zip 大小 ≈ 解压大小」是常态 —— 64MB 会把用户自己的模型挡在门外。
 * 192MB 让这类包能进来，同时仍然是一道真实的防线。
 */
export const MAX_ZIP_BYTES = 192 * 1024 * 1024;
/** 条目数上限：一个模型包正常是几百个文件，2000 已经非常宽松。 */
export const MAX_ENTRIES = 2000;
/** 解压后总字节上限，防 zip bomb。 */
export const MAX_TOTAL_UNCOMPRESSED = 1024 * 1024 * 1024;
/**
 * 单个条目解压后的上限。
 *
 * 这个数不是防「坏文件」而是防**内存峰值**：解压是逐条目做的，写完就扔，
 * 所以峰值内存 ≈ zip 本体 + 最大条目 ×2（deflate 的输出缓冲）。
 * 用户库里最大的单文件（一张 8192 的 PNG）约 25MB，128MB 已经很宽裕。
 */
export const MAX_ENTRY_UNCOMPRESSED = 128 * 1024 * 1024;
/** 单条目的压缩比上限。 */
export const MAX_COMPRESSION_RATIO = 200;
/** 低于这个大小的条目不做压缩比检查 —— 几百字节的条目比值天然很大且无害。 */
export const MIN_RATIO_CHECK_BYTES = 64 * 1024;

export class ZipError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * 粗判「这看起来是个 zip 吗」。
 *
 * 只看本地头或中央目录头，**不解析**。用途是给用户一个「你拖进来的不是 zip」
 * 的早期判断，避免把 200MB 的 mp4 当 zip 去解析后才报错。
 */
export function isZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const sig = buffer.readUInt32LE(0);
  return sig === ZIP_SIGNATURE.local || sig === ZIP_SIGNATURE.central;
}

/* ------------------------------------------------------------------ *
 * 名字解码
 * ------------------------------------------------------------------ */

let gbkDecoder;
let gbkChecked = false;

function getGbkDecoder() {
  if (!gbkChecked) {
    gbkChecked = true;
    try {
      gbkDecoder = new TextDecoder('gbk', { fatal: true });
    } catch {
      gbkDecoder = null;
    }
  }
  return gbkDecoder;
}

/**
 * 把条目名的原始字节解成字符串。
 *
 * ZIP 规范说「没设 UTF-8 标志位就是 CP437」，而现实是：Windows 上压缩中文目录
 * 得到的是 **GBK** 字节且**不带** UTF-8 标志位。照着规范用 CP437 解会得到一串
 * 带重音符号的乱码目录名 —— 文件能解出来，但名字全错，用户会以为是插件把文件名搞坏了。
 *
 * 所以这里的策略是「先试 UTF-8，不干净就试 GBK」：
 * - 干净的 UTF-8（能解且能原样编回去）直接用，这样即使压缩工具忘了设标志位也对；
 * - 否则用 GBK；GBK 解不出来（乱码字节）再退回 latin1，保证**永远能得到一个字符串**。
 *
 * 为什么不用 `fatal: true` 的 UTF-8 解码器判「干净」：能被解成合法 UTF-8 的
 * GBK 字节序列是存在的（虽然罕见），两边都试一遍再比字节是最省事的严格判据。
 */
export function decodeZipName(bytes, utf8Flag) {
  if (utf8Flag) {
    const text = bytes.toString('utf8');
    // 设了标志位却解出替换字符，说明压缩工具撒谎了，往下走去试 GBK。
    if (!text.includes('\uFFFD')) return text;
  } else {
    const text = bytes.toString('utf8');
    if (!text.includes('\uFFFD') && Buffer.from(text, 'utf8').equals(bytes)) return text;
  }

  const decoder = getGbkDecoder();
  if (decoder !== null) {
    try {
      return decoder.decode(bytes);
    } catch {
      /* 落到 latin1 */
    }
  }
  return bytes.toString('latin1');
}

/* ------------------------------------------------------------------ *
 * CRC32
 * ------------------------------------------------------------------ */

let crcTable = null;

function getCrcTable() {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  return crcTable;
}

/** 标准 CRC-32（IEEE 802.3，ZIP 用的那个）。 */
export function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * 中央目录
 * ------------------------------------------------------------------ */

function findEocd(buffer) {
  // 注释最长 65535 字节，EOCD 固定 22 字节 —— 往回最多找这么多。
  const lowest = Math.max(0, buffer.length - (22 + 0xffff));
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_SIGNATURE.eocd) return i;
  }
  throw new ZipError('E_ZIP_NOT_ARCHIVE', '这不是一个 zip 文件（找不到中央目录结尾记录）', `长度 ${buffer.length}`);
}

/**
 * 解析中央目录，返回条目清单。
 *
 * 不读任何条目内容，所以对「只想知道里面有什么」的场景是廉价的。
 */
export function readZipDirectory(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new ZipError('E_ZIP_NOT_ARCHIVE', '入参不是 Buffer');
  }
  if (buffer.length > MAX_ZIP_BYTES) {
    throw new ZipError(
      'E_ZIP_TOO_LARGE',
      `zip 超过 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB 上限`,
      `${buffer.length} 字节`,
    );
  }
  if (buffer.length < 22) {
    throw new ZipError('E_ZIP_NOT_ARCHIVE', '文件太短，不可能是 zip', `${buffer.length} 字节`);
  }

  const eocd = findEocd(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffsetRaw = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);

  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffsetRaw === 0xffffffff) {
    throw new ZipError(
      'E_ZIP64_UNSUPPORTED',
      '这个 zip 用了 ZIP64 扩展（文件超过 4GB 或条目超过 65535 个），暂不支持',
      '请重新打包，或用 7-Zip 解压后把文件夹直接放进模型库',
    );
  }

  /*
   * 自解压包（.exe 外壳）或任何在 zip 前面粘了数据的文件，会让中央目录里记录的
   * 偏移整体后移。EOCD 紧跟在中央目录之后，所以 `eocd - cdSize` 必然指向真正的
   * 中央目录起点 —— 拿它和记录的偏移一比就得到位移量。这个位移必须传给本地头定位，
   * 否则每个条目都会读到垃圾。
   *
   * 判定的顺序很重要：**先信 `cdStart`**。因为位移存在时 `cdOffsetRaw` 指向的是
   * 外壳里的某处垃圾，拿它去读签名必然失败 —— 那正是「有位移」的特征，
   * 而不是「文件坏了」。反过来先读 `cdOffsetRaw` 会把所有自解压包都误判成损坏。
   */
  const cdStart = eocd - cdSize;
  let shift = 0;
  // 正常情况下中央目录就在 `cdStart`。这个变量只在「`cdStart` 落点不对、但记录的
  // 偏移恰好指着中央目录」时被改写 —— 那种情况下以记录的偏移为起点且不施加位移。
  let cursorStart = cdStart;
  if (cdStart < 0 || buffer.readUInt32LE(cdStart) !== ZIP_SIGNATURE.central) {
    // `cdStart` 不是中央目录 —— 只有在记录的偏移正好指着它时才还有救。
    if (cdOffsetRaw + 4 <= buffer.length && buffer.readUInt32LE(cdOffsetRaw) === ZIP_SIGNATURE.central) {
      cursorStart = cdOffsetRaw;
    } else {
      throw new ZipError('E_ZIP_CORRUPT', '中央目录位置不合理，文件可能损坏');
    }
  } else if (cdOffsetRaw !== cdStart) {
    shift = cdStart - cdOffsetRaw;
  }

  if (totalEntries > MAX_ENTRIES) {
    throw new ZipError('E_ZIP_TOO_MANY_ENTRIES', `zip 里有 ${totalEntries} 个条目，超过 ${MAX_ENTRIES} 上限`);
  }

  const entries = [];
  let cursor = cursorStart;
  let totalUncompressed = 0;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_SIGNATURE.central) {
      throw new ZipError('E_ZIP_CORRUPT', `第 ${i + 1} 个中央目录条目读不出来，文件可能损坏`);
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttrs = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const extra = buffer.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);

    // 条目级的 ZIP64 扩展字段（头 ID 0x0001）。总表没标但单条目标了，也要拒绝，
    // 否则后面按 32 位读出来的大小会是 0xFFFFFFFF。
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipError('E_ZIP64_UNSUPPORTED', `条目「${decodeZipName(rawName, (flags & 0x800) !== 0)}」用了 ZIP64 扩展，暂不支持`);
    }
    for (let p = 0; p + 4 <= extra.length; ) {
      const headerId = extra.readUInt16LE(p);
      const fieldSize = extra.readUInt16LE(p + 2);
      if (headerId === 0x0001) {
        throw new ZipError('E_ZIP64_UNSUPPORTED', '这个 zip 含 ZIP64 扩展字段，暂不支持');
      }
      p += 4 + fieldSize;
    }

    const name = decodeZipName(rawName, (flags & 0x800) !== 0);
    // 有些工具（尤其是 Windows 上的）用反斜杠当分隔符，而 zip 规范规定是正斜杠。
    const normalized = name.replace(/\\/g, '/');
    // 目录条目的判定以「名字以 / 结尾」或「外部属性里的目录位」为准。
    const isDirectory = normalized.endsWith('/') || (externalAttrs & 0x10) !== 0;

    if (method !== ZIP_METHOD.stored && method !== ZIP_METHOD.deflate) {
      throw new ZipError(
        'E_ZIP_METHOD_UNSUPPORTED',
        `条目「${normalized}」用了压缩方法 ${method}，只支持 stored(0) 与 deflate(8)`,
      );
    }

    totalUncompressed += uncompressedSize;
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED) {
      throw new ZipError(
        'E_ZIP_ENTRY_TOO_LARGE',
        `条目「${normalized}」解压后 ${Math.round(uncompressedSize / 1024 / 1024)}MB，超过单文件上限`,
        `上限 ${Math.round(MAX_ENTRY_UNCOMPRESSED / 1024 / 1024)}MB`,
      );
    }
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw new ZipError(
        'E_ZIP_TOO_LARGE_UNCOMPRESSED',
        `解压后总大小超过 ${Math.round(MAX_TOTAL_UNCOMPRESSED / 1024 / 1024)}MB 上限`,
        '这通常意味着这是一个压缩炸弹，或者你打包了一个远超预期的目录',
      );
    }
    if (
      uncompressedSize > MIN_RATIO_CHECK_BYTES &&
      compressedSize > 0 &&
      uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new ZipError(
        'E_ZIP_BOMB_SUSPECT',
        `条目「${normalized}」压缩比异常（${Math.round(uncompressedSize / compressedSize)}:1）`,
        '全零的大文件会压出这种比值，它可能是压缩炸弹',
      );
    }

    entries.push({
      name: normalized,
      rawName: Buffer.from(rawName),
      isDirectory,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      utf8: (flags & 0x800) !== 0,
    });

    cursor += 46 + nameLength + extraLength + entryCommentLength;
  }

  return { entries, shift, commentLength, zip64: false };
}

/**
 * 读取单个条目的内容。
 *
 * `shift` 必须传中央目录解析出来的那个 —— 自解压包缺了它会读到完全无关的字节。
 */
export function readZipEntry(buffer, entry, shift = 0) {
  const at = entry.localHeaderOffset + shift;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== ZIP_SIGNATURE.local) {
    throw new ZipError('E_ZIP_CORRUPT', `条目「${entry.name}」的本地头读不出来`);
  }

  // 本地头里的名字/扩展字段长度**可能与中央目录里的不同**，必须以本地头为准 ——
  // 这是 ZIP 格式里最容易踩的一个坑：中央目录的长度是「最终值」，
  // 而流式写入的 zip 在本地头里放的是占位（可能带一个额外的数据描述符）。
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const dataStart = at + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > buffer.length) {
    throw new ZipError(
      'E_ZIP_TRUNCATED',
      `条目「${entry.name}」的数据不完整`,
      `需要 ${dataEnd} 字节，实际只有 ${buffer.length} 字节`,
    );
  }

  const raw = buffer.subarray(dataStart, dataEnd);
  let data;
  if (entry.method === ZIP_METHOD.stored) {
    data = Buffer.from(raw);
  } else {
    try {
      data = inflateRawSync(raw);
    } catch (error) {
      throw new ZipError('E_ZIP_INFLATE_FAILED', `条目「${entry.name}」解压失败`, String(error?.message ?? error));
    }
  }

  if (entry.uncompressedSize !== 0xffffffff && data.length !== entry.uncompressedSize) {
    throw new ZipError(
      'E_ZIP_SIZE_MISMATCH',
      `条目「${entry.name}」解出来的大小与记录不符`,
      `记录 ${entry.uncompressedSize}，实际 ${data.length}`,
    );
  }

  const actual = crc32(data);
  if (actual !== entry.crc32) {
    throw new ZipError(
      'E_ZIP_CRC_MISMATCH',
      `条目「${entry.name}」校验失败（CRC32 不符）`,
      `记录 ${entry.crc32.toString(16)}，实际 ${actual.toString(16)} —— 文件在下载或复制过程中损坏了`,
    );
  }

  return data;
}

/**
 * 把条目名规范化成「安全的相对路径」。
 *
 * 返回 `null` 表示这个条目**必须被丢弃**。丢弃而不是报错，是因为一个包里混进
 * 一两个 macOS 的 `__MACOSX/._x` 或 `.DS_Store` 是很常见的，为此拒绝整个包
 * 会让用户莫名其妙。真正的危险条目（路径穿越、绝对路径）走 `E_ZIP_UNSAFE_PATH`
 * 由调用方决定——这里只负责判定。
 */
export function normalizeEntryPath(name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized === '' || normalized.endsWith('/')) return null;

  // 绝对路径、盘符、UNC —— 一律不安全。
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;

  const parts = [];
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;

  return parts.join('/');
}

/**
 * 把条目名分类，供解压方决定「写 / 跳过 / 拒绝」。
 *
 * 四类的区别是有意的：
 * - `file`：正常文件，写。
 * - `directory`：显式目录条目，建目录（有些工具不写目录条目，也不写它们）。
 * - `junk`：macOS / Windows 的元数据垃圾（`__MACOSX/`、`.DS_Store`、`._x`、`Thumbs.db`）。
 *   跳过而不是报错 —— 一个本来完好的模型包不该因为压缩者是 Mac 就被拒绝。
 * - `unsafe`：路径穿越、绝对路径、盘符。**整个包都会被拒绝**，因为一个包里出现
 *   这种东西要么意味着打包工具坏了，要么意味着它是恶意的，两种都不该被静默容忍。
 */
export function classifyEntryPath(name) {
  const normalized = name.replace(/\\/g, '/');

  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return { kind: 'unsafe', path: normalized, reason: '绝对路径' };
  }

  const parts = [];
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return { kind: 'unsafe', path: normalized, reason: '路径穿越（..）' };
    parts.push(part);
  }

  if (parts.length === 0) {
    return { kind: 'junk', path: normalized, reason: '空路径' };
  }

  const base = parts[parts.length - 1];
  const isDirectory = normalized.endsWith('/');
  if (isDirectory) return { kind: 'directory', path: parts.join('/') };

  if (
    parts[0] === '__MACOSX' ||
    base === '.DS_Store' ||
    base === 'Thumbs.db' ||
    base === 'desktop.ini' ||
    base.startsWith('._')
  ) {
    return { kind: 'junk', path: parts.join('/'), reason: '系统元数据文件' };
  }

  return { kind: 'file', path: parts.join('/') };
}

/**
 * 找出所有条目名公共的第一层目录名。
 *
 * 用途：从 GitHub 下载的模型包通常长这样 ——
 * `mymodel-1.0/mymodel/runtime/model.model3.json`。把 `mymodel-1.0` 这一层剥掉，
 * 模型才是直接躺在它自己目录里的，否则模型库里会出现两层同名目录。
 * 只有一个条目（或没有公共前缀）时返回 `null`，表示不剥。
 */
export function commonTopLevel(entries) {
  const names = entries
    .filter((e) => !e.isDirectory)
    .map((e) => normalizeEntryPath(e.name))
    .filter((n) => n !== null);
  if (names.length === 0) return null;

  const first = names[0].split('/');
  if (first.length < 2) return null;

  const prefix = first[0];
  for (const name of names) {
    if (!name.startsWith(`${prefix}/`)) return null;
  }
  return prefix;
}
