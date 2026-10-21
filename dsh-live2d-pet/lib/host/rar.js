/**
 * RAR 桥接：把一个 `.rar` 变成磁盘上的一堆文件。
 *
 * ## 为什么不自己解
 *
 * RAR 没有可用的纯 JS 解码器（RAR5 尤其），UnRAR 的授权也不允许随插件分发。
 * 所以这一层不解析格式，只**找一个本机已有的解包器**去解：
 *
 *   1. `DSH_RAR_EXTRACTOR` —— 用户显式指定的可执行文件（最优先，也最可测）；
 *   2. 7-Zip / UnRAR 的常见安装位置；
 *   3. Windows 自带的 `bsdtar`（`%SystemRoot%\System32\tar.exe`，libarchive 实现，
 *      只读，能解 RAR4 / RAR5）。
 *
 * ## 三道安全闸
 *
 * zip 那边可以先把中央目录读进内存，逐条判断路径、条目数、解压后大小，再决定写不写。
 * RAR 的清单在压缩流里，没有等价的「先看一眼」—— 所以闸门换了个位置：
 *
 *   1. **解包器自己拒绝 `..` 与绝对路径**（bsdtar 默认行为，实测报
 *      `Path contains '..'`；绝对路径会被剥掉盘符落在目标目录里）；
 *   2. **解包期间按 `EXTRACT_POLL_MS` 轮询目录体积**，超上限直接 kill —— 这是
 *      解压炸弹唯一能及时止损的地方，等它解完再量就晚了；
 *   3. **解包之后逐项 `lstat`**：出现符号链接、条目数或总体积超上限，整包拒绝。
 *
 * 失败信息会带上解包器的 stderr 首行：用户拿到的应该是「这个包加了密码」，
 * 而不是「导入失败」。
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_ENTRIES,
  MAX_ENTRY_UNCOMPRESSED,
  MAX_TOTAL_UNCOMPRESSED,
} from './zip.js';

/** RAR4 的文件头：`Rar!\x1a\x07\x00`。 */
const RAR4_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
/** RAR5 的文件头：`Rar!\x1a\x07\x01\x00`。 */
const RAR5_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

/** 解包的整体超时。RAR 比 zip 慢，但 2 分钟还没解完就说明这个包不对劲。 */
export const EXTRACT_TIMEOUT_MS = 120_000;
/** 解包期间量体积的间隔。太长会放过炸弹，太短会让大包解得很慢。 */
export const EXTRACT_POLL_MS = 250;

/** 解包器的类型 → 命令行长相。 */
export const EXTRACTOR_KIND = { sevenZip: '7z', unrar: 'unrar', bsdtar: 'bsdtar' };

export class RarError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'RarError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * RAR 版本（4 / 5），不是 RAR 就返回 null。
 *
 * 只认前 8 个字节：判定「是不是 RAR」不需要更深的解析，而看清内部的头要等解包器。
 */
export function rarVariant(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 7) return null;
  // RAR5 比 RAR4 长一个字节，必须先判（两者的前 7 字节只差最后一位）。
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(RAR5_MAGIC)) return 5;
  if (buffer.subarray(0, 7).equals(RAR4_MAGIC)) return 4;
  return null;
}

/** 简写：是不是 RAR（4 或 5）。 */
export function isRar(buffer) {
  return rarVariant(buffer) !== null;
}

/**
 * 候选解包器，按优先级排。
 *
 * `env` 可注入是为了门禁能在一台什么解包器都没有的机器上跑；真实调用时传
 * `process.env`。这里只**列出**路径，不判断存在 —— 那是 `findExtractor` 的事。
 */
export function extractorCandidates(env = process.env) {
  const list = [];
  const explicit = String(env?.DSH_RAR_EXTRACTOR ?? '').trim();
  if (explicit !== '') list.push({ path: explicit, kind: EXTRACTOR_KIND.bsdtar, from: 'env' });

  const programFiles = String(env?.ProgramFiles ?? '').trim();
  const programFilesX86 = String(env?.['ProgramFiles(x86)'] ?? '').trim();
  const localAppData = String(env?.LOCALAPPDATA ?? '').trim();

  for (const base of [programFiles, programFilesX86]) {
    if (base === '') continue;
    list.push({ path: join(base, '7-Zip', '7z.exe'), kind: EXTRACTOR_KIND.sevenZip, from: 'install' });
    list.push({ path: join(base, 'WinRAR', 'UnRAR.exe'), kind: EXTRACTOR_KIND.unrar, from: 'install' });
    list.push({ path: join(base, 'WinRAR', 'WinRAR.exe'), kind: EXTRACTOR_KIND.unrar, from: 'install' });
  }
  if (localAppData !== '') {
    list.push({ path: join(localAppData, 'Programs', '7-Zip', '7z.exe'), kind: EXTRACTOR_KIND.sevenZip, from: 'install' });
  }

  const systemRoot = String(env?.SystemRoot ?? env?.windir ?? '').trim();
  const tarPath = systemRoot === '' ? 'C:\\Windows\\System32\\tar.exe' : join(systemRoot, 'System32', 'tar.exe');
  list.push({ path: tarPath, kind: EXTRACTOR_KIND.bsdtar, from: 'builtin' });

  /**
   * `DSH_RAR_EXTRACTOR` 显式指定时，**只认它** —— 用户说「用这个」就该只用这个；
   * 悄悄退回内置 tar 会让「我明明指定了 7-Zip」变成一个查不出的谜。
   */
  if (explicit !== '') return list.slice(0, 1);
  return list;
}

/**
 * 找出第一个**存在**的候选。都没有返回 null。
 *
 * `exists` 可注入：门禁在没有解包器的机器上也能验「找不到时到底返回什么」。
 */
export function findExtractor({ env = process.env, exists = existsSync } = {}) {
  for (const candidate of extractorCandidates(env)) {
    if (candidate.path.trim() === '') continue;
    try {
      if (exists(candidate.path)) return candidate;
    } catch {
      /* 权限之类的问题当作不存在，继续找下一个 */
    }
  }
  return null;
}

/**
 * 解包命令行的参数部分（可执行文件本身由调用方拼）。
 *
 * - 7-Zip：`x -y -o<dir> -bso0 -bsp0 <archive>`（`-bso0` 关掉它往 stdout 打的清单）；
 * - UnRAR：`x -y -p- -idq <archive> <dir>\`（`-p-` 明确「没有密码」，遇到加密包才会报错）；
 * - bsdtar：`-x -f <archive> -C <dir>`。
 */
export function extractorArgs(extractor, archivePath, destDir) {
  const kind = extractor?.kind ?? EXTRACTOR_KIND.bsdtar;
  if (kind === EXTRACTOR_KIND.sevenZip) {
    return ['x', '-y', '-bso0', '-bsp0', `-o${destDir}`, archivePath];
  }
  if (kind === EXTRACTOR_KIND.unrar) {
    return ['x', '-y', '-p-', '-idq', archivePath, destDir.endsWith('\\') ? destDir : `${destDir}\\`];
  }
  return ['-x', '-f', archivePath, '-C', destDir];
}

/** 面板 / 日志里怎么说这个解包器。 */
export function describeExtractor(extractor) {
  if (extractor === null || extractor === undefined) return '没有可用的解包器';
  const name = extractor.kind === EXTRACTOR_KIND.sevenZip
    ? '7-Zip'
    : extractor.kind === EXTRACTOR_KIND.unrar ? 'UnRAR' : '系统自带 bsdtar';
  const from = extractor.from === 'env' ? '指定' : extractor.from === 'builtin' ? '内置' : '已安装';
  return `${name}（${from}：${extractor.path}）`;
}

/**
 * 把解包器的 stderr 翻译成错误码。
 *
 * 顺序有讲究：先认安全（`..` / 绝对路径），再认加密，最后认分卷 —— 一个加密的
 * 分卷包两句话都会出现，用户先要知道的是「它要密码」。
 */
export function classifyExtractFailure({ kind = '', stderr = '', code = null, killed = null } = {}) {
  const text = String(stderr ?? '');
  const lower = text.toLowerCase();

  if (killed === 'timeout') {
    return new RarError('E_IMPORT_RAR_TIMEOUT', `解包超时（${Math.round(EXTRACT_TIMEOUT_MS / 1000)} 秒还没解完）`, firstLine(text));
  }
  if (killed === 'too-large') {
    return new RarError(
      'E_IMPORT_TOO_LARGE',
      `解压后的内容超过 ${Math.round(MAX_TOTAL_UNCOMPRESSED / 1024 / 1024)}MB 上限，已中止`,
      firstLine(text),
    );
  }
  if (code === 'ENOENT') {
    return new RarError('E_IMPORT_RAR_NO_EXTRACTOR', '找不到能解 RAR 的程序', 'RAR 需要 7-Zip / WinRAR / 系统自带 tar.exe，这台机器上一个都没找到');
  }
  if (/path contains '\.\.'|contains '\.\.'|unsafe path/i.test(text)) {
    return new RarError(
      'E_IMPORT_RAR_UNSAFE_PATH',
      '这个 rar 里有会写到目标目录之外的路径',
      `${firstLine(text)} —— 已拒绝整个包`,
    );
  }
  if (/passphrase|password|encrypted|encryption/i.test(lower)) {
    return new RarError(
      'E_IMPORT_RAR_ENCRYPTED',
      '这个 rar 加了密码，插件不会去猜',
      '请先解压、去掉密码，再打成 .zip 或 .rar 导入',
    );
  }
  if (/next volume|volume|unexpected end of archive|truncated|part\d+\.rar/i.test(lower)) {
    return new RarError(
      'E_IMPORT_RAR_MULTIVOLUME',
      '这个 rar 是分卷包的一部分',
      '分卷包需要把 .part1.rar / .part2.rar… 放在一起解压；插件只收单个完整的包',
    );
  }
  return new RarError(
    'E_IMPORT_RAR_FAILED',
    '解包失败',
    `${firstLine(text) || (code !== null && code !== 0 ? `解包器退出码 ${code}` : '解包器没有给出原因')}`,
  );
}

function firstLine(text) {
  const line = String(text ?? '').split(/\r?\n/).map((item) => item.trim()).find((item) => item !== '');
  return line ?? '';
}

/**
 * 量一棵目录树。
 *
 * 用 `lstat` 而不是 `stat`：符号链接要单独记下来（RAR 可以带链接，而模型包里
 * 不该有 —— 一个指向 `C:\Windows` 的链接比任何炸弹都危险）。
 */
export function walkTree(root) {
  const tree = { files: 0, directories: 0, bytes: 0, largest: 0, symlinks: [], entries: 0 };
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const full = join(dir, item.name);
      let info;
      try {
        info = lstatSync(full);
      } catch {
        continue;
      }
      tree.entries += 1;
      if (info.isSymbolicLink()) {
        tree.symlinks.push(full);
        continue;
      }
      if (info.isDirectory()) {
        tree.directories += 1;
        stack.push(full);
        continue;
      }
      if (info.isFile()) {
        tree.files += 1;
        tree.bytes += info.size;
        if (info.size > tree.largest) tree.largest = info.size;
      }
    }
  }
  return tree;
}

/** 解包后按 zip 那套上限逐项核对（同一组数字，不另立一套）。 */
export function assertTree(tree, limits = {}) {
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_UNCOMPRESSED;
  const maxEntryBytes = limits.maxEntryBytes ?? MAX_ENTRY_UNCOMPRESSED;

  if (tree.symlinks.length > 0) {
    throw new RarError(
      'E_IMPORT_RAR_SYMLINK',
      '这个 rar 里有符号链接',
      `${tree.symlinks[0]} —— 模型包里不该有链接，已拒绝整个包`,
    );
  }
  if (tree.entries > maxEntries) {
    throw new RarError('E_IMPORT_TOO_MANY_ENTRIES', `解压后有 ${tree.entries} 个条目，超过 ${maxEntries} 上限`);
  }
  if (tree.bytes > maxTotalBytes) {
    throw new RarError(
      'E_IMPORT_TOO_LARGE',
      `解压后有 ${Math.round(tree.bytes / 1024 / 1024)}MB，超过 ${Math.round(maxTotalBytes / 1024 / 1024)}MB 上限`,
    );
  }
  if (tree.largest > maxEntryBytes) {
    throw new RarError(
      'E_IMPORT_ENTRY_TOO_LARGE',
      `单个文件 ${Math.round(tree.largest / 1024 / 1024)}MB，超过 ${Math.round(maxEntryBytes / 1024 / 1024)}MB 上限`,
    );
  }
  return tree;
}

/**
 * 真的去解包。
 *
 * 三件事同时盯着：进程退出、超时、目录体积。任何一件先到都会让整个解包停下
 * （体积超限与超时会 kill 子进程，然后按 `classifyExtractFailure` 报错）。
 *
 * `spawnImpl` 可注入：门禁不想为了测「体积超限会不会 kill」而造一个 1GB 的包。
 */
export function runExtractor({
  extractor,
  archivePath,
  destDir,
  spawnImpl = nodeSpawn,
  limits = {},
  timeoutMs = EXTRACT_TIMEOUT_MS,
  pollMs = EXTRACT_POLL_MS,
} = {}) {
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_UNCOMPRESSED;
  const args = extractorArgs(extractor, archivePath, destDir);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let stderr = '';
    let killed = null;
    let settled = false;

    let child;
    try {
      child = spawnImpl(extractor.path, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      reject(classifyExtractFailure({ code: error?.code ?? null, stderr: String(error?.message ?? error) }));
      return;
    }

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      fn(value);
    };

    const timer = setTimeout(() => {
      killed = 'timeout';
      try { child.kill(); } catch { /* 已经退出 */ }
    }, timeoutMs);

    const poller = setInterval(() => {
      let bytes = 0;
      try {
        bytes = walkTree(destDir).bytes;
      } catch {
        return;
      }
      if (bytes > maxTotalBytes) {
        killed = 'too-large';
        try { child.kill(); } catch { /* 已经退出 */ }
      }
    }, pollMs);

    child.stderr?.on('data', (chunk) => {
      // 只留前 8KB：有些解包器遇到坏包会刷几十 MB 的重复警告。
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      finish(reject, classifyExtractFailure({ code: error?.code ?? null, stderr: String(error?.message ?? error) }));
    });

    child.on('close', (code) => {
      if (killed !== null) {
        finish(reject, classifyExtractFailure({ stderr, killed }));
        return;
      }
      if (code !== 0) {
        finish(reject, classifyExtractFailure({ kind: extractor?.kind, stderr, code }));
        return;
      }
      finish(resolve, { ok: true, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
}

/**
 * 一步到位：解包 + 量树 + 核对上限。
 *
 * 返回的 `tree` 是**解包之后**的事实，调用方据此算「剥不剥顶层目录」之类的策略；
 * 落盘位置与入库仍然是 `model-import.js` 的事。
 */
export async function extractRar({
  archivePath,
  destDir,
  extractor,
  spawnImpl,
  limits = {},
  timeoutMs = EXTRACT_TIMEOUT_MS,
  pollMs = EXTRACT_POLL_MS,
}) {
  const result = await runExtractor({ extractor, archivePath, destDir, spawnImpl, limits, timeoutMs, pollMs });
  const tree = walkTree(destDir);
  assertTree(tree, limits);
  return { ...result, tree };
}
