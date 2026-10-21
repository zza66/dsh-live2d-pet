/**
 * 模型包导入：把用户拖进来的 **zip / rar** 变成模型库里一个可用的目录。
 *
 * ## 与 `zip.js` / `rar.js` 的分工
 *
 * `zip.js` 与 `rar.js` 只管**格式**（字节怎么解释、包怎么解开），本模块只管**策略**
 * （字节该落到哪里、落下去之前要做哪些判断、失败了要不要留痕）。分开是为了让两边的
 * 门禁都能只测自己那一半：格式门禁在内存里造包，策略门禁在临时目录里跑，互不牵连。
 *
 * 两条格式的检查位置不同，但**上限是同一组数字**（`MAX_ENTRIES` /
 * `MAX_TOTAL_UNCOMPRESSED` / `MAX_ENTRY_UNCOMPRESSED` 都从 `zip.js` 借）：
 * zip 能在写盘前逐条判断，rar 只能解出来之后量，所以 rar 那条多了一个
 * 「解包期间按体积 kill」的闸门（见 `rar.js`）。
 *
 * ## 三条策略
 *
 * 1. **先解到临时目录，验完再搬进去。** 直接往模型库里解的话，一个解到一半失败的
 *    包会永久留在库里，而用户看到的是「一个坏模型」，不是「一次失败的导入」。
 *    临时目录名以 `.` 开头，而扫描器会跳过 `.` 开头的目录 —— 就算进程在导入中途
 *    被杀，残留的也只是模型库里一个看不见的目录，不会污染下拉框。
 * 2. **搬进去用 `rename`，不是复制。** 同一个文件系统内的 rename 是原子的，
 *    并且大包（用户手上那个 93MB 的）不会经历一次完整的磁盘拷贝。
 * 3. **「不是模型包」和「模型包但坏了」要分开。**
 *    - 里面根本没有 `.model3.json` → 删除临时目录、返回 `E_IMPORT_NO_MODEL`。
 *      这种包进了库只会变成一个没有意义的条目，而用户其实是想拖模型。
 *    - 有 `.model3.json` 但缺纹理之类 → **照常入库**，由 `model-library.js` 标成
 *      `ok: false`。用户需要能在列表里看见它、并读到「缺哪一张纹理」，
 *      这正是方案 §6.1 #2「分别返回唯一且可读的错误码」要的效果。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectModel } from './model-library.js';
import {
  RarError,
  extractRar,
  findExtractor,
  isRar,
} from './rar.js';
import {
  ZipError,
  classifyEntryPath,
  commonTopLevel,
  isZip,
  readZipDirectory,
  readZipEntry,
} from './zip.js';

/** 临时目录前缀。以 `.` 开头是刻意的 —— `scanLibrary` 跳过这类目录。 */
export const IMPORT_TEMP_PREFIX = '.import-';
/** 模型定义文件在包里的最大深度。超过这个深度的不算「这个包的模型」。 */
export const MAX_MODEL_DEPTH = 4;
/** 重名时最多往后试多少个后缀。 */
export const MAX_NAME_ATTEMPTS = 50;

export class ImportError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * 把任意字符串变成一个能当目录名用的名字。
 *
 * 处理的都是真实会遇到的：`miku.zip` → `miku`；带 `?` `*` `:` 的下载文件名在
 * Windows 上建不了目录；结尾的点和空格同样建不了（Windows 会静默去掉，于是
 * 「创建成功但名字不对」）；`CON` `NUL` 这类保留名会让 `mkdir` 直接失败。
 */
export function sanitizeLibraryName(input, fallback = 'model') {
  let name = String(input ?? '');

  // 只取最后一段：调用方可能传进来一个完整路径。
  name = name.replace(/\\/g, '/');
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);

  name = name.replace(/\.(zip|rar)$/i, '');
  // 控制字符与 Windows 非法字符一起换成下划线。
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  // Windows 不允许目录名以点或空格结尾。
  name = name.replace(/[. ]+$/, '').trim();

  if (name === '' || name === '.' || name === '..') name = fallback;
  if (WINDOWS_RESERVED.has(name.toLowerCase())) name = `_${name}`;
  if (name.length > 60) name = name.slice(0, 60).replace(/[. ]+$/, '');
  if (name === '') name = fallback;
  return name;
}

/** 在 `root` 下找一个没被占用的目录名。`preferred` 被占就试 `preferred (2)`、`(3)`… */
export function chooseAvailableName(root, preferred) {
  if (!existsSync(join(root, preferred))) return { name: preferred, renamed: false };
  for (let i = 2; i <= MAX_NAME_ATTEMPTS; i += 1) {
    const candidate = `${preferred} (${i})`;
    if (!existsSync(join(root, candidate))) return { name: candidate, renamed: true };
  }
  throw new ImportError(
    'E_IMPORT_NAME_EXHAUSTED',
    `「${preferred}」这个名字已经被占用太多次了`,
    `试到 ${preferred} (${MAX_NAME_ATTEMPTS}) 都还存在，请先清理模型库`,
  );
}

/**
 * 在目录里找 `.model3.json`，返回相对路径（`/` 分隔）。
 *
 * 只找一层「每个目录里挑一个」—— 一个包里有两套模型是打包者的失误，
 * 但那是能用的：我们会用找到的第一个，并把数量一起报出去。
 */
export function findModelFiles(dir, depth = 0) {
  if (depth > MAX_MODEL_DEPTH) return [];
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  const subdirs = [];
  // 排序是为了让「先用哪个模型」是确定的 —— 不然同一个包在两台机器上
  // 可能选中不同的 .model3.json，而这类不确定性以后会变成查不出来的怪 bug。
  names.sort((a, b) => a.name.localeCompare(b.name));

  for (const item of names) {
    if (item.name.startsWith('.')) continue;
    const absolute = join(dir, item.name);
    if (item.isDirectory()) {
      subdirs.push(absolute);
    } else if (item.isFile() && /\.model3\.json$/i.test(item.name)) {
      found.push(absolute);
    }
  }

  // 浅的先返回：模型定义在本层的包，比深藏在子目录里的更可能是用户想导入的。
  if (found.length > 0) return found;
  for (const sub of subdirs) {
    const deeper = findModelFiles(sub, depth + 1);
    if (deeper.length > 0) return deeper;
  }
  return [];
}

/**
 * 导入一个 zip。
 *
 * @param {Buffer} buffer         zip 的原始字节（**不是** base64）。
 * @param {object} options
 * @param {string} options.modelsRoot  模型库根目录（不存在会被创建）。
 * @param {string} [options.name]      zip 的文件名，用来给目录起名。
 * @returns {{ ok: true, id: string, path: string, name: string, entry: object, stats: object }}
 */
export function importModelZip(buffer, options) {
  const modelsRoot = options?.modelsRoot;
  if (typeof modelsRoot !== 'string' || modelsRoot === '') {
    throw new ImportError('E_IMPORT_NO_ROOT', '没有配置模型库目录');
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImportError('E_IMPORT_EMPTY', '请求体是空的');
  }
  if (!isZip(buffer)) {
    // 这个判断放在最前面是有意的：用户把文件夹直接拖进来、或者拖了个 rar，
    // 都应该在这里就得到「这不是 zip」，而不是解析到一半报一个内部错误。
    throw new ImportError(
      'E_IMPORT_NOT_ZIP',
      '这不是一个 zip 文件',
      '请把模型文件夹压缩成 .zip 再拖进来（rar / 7z 不支持）',
    );
  }

  mkdirSync(modelsRoot, { recursive: true });

  let directory;
  try {
    directory = readZipDirectory(buffer);
  } catch (error) {
    if (error instanceof ZipError) {
      throw new ImportError(error.code, error.message, error.detail);
    }
    throw error;
  }

  const files = directory.entries.filter((e) => !e.isDirectory);
  if (files.length === 0) {
    throw new ImportError('E_IMPORT_EMPTY', '这个 zip 里没有文件');
  }

  const strippedPrefix = commonTopLevel(directory.entries);
  const preferred = sanitizeLibraryName(
    strippedPrefix ?? options?.name ?? '',
    `model-${Date.now()}`,
  );

  const tempDir = join(modelsRoot, `${IMPORT_TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tempDir, { recursive: true });

  const stats = { entries: 0, skipped: 0, bytes: 0, directories: 0 };

  try {
    for (const entry of directory.entries) {
      const classified = classifyEntryPath(entry.name);

      if (classified.kind === 'unsafe') {
        throw new ImportError(
          'E_ZIP_UNSAFE_PATH',
          `这个 zip 里有不安全的路径：${classified.path}`,
          `${classified.reason} —— 已拒绝整个包，没有写入任何文件`,
        );
      }
      if (classified.kind === 'junk') {
        stats.skipped += 1;
        continue;
      }

      // 剥掉公共的第一层目录：`mymodel-1.0/mymodel/x.model3.json` 里
      // 用户想导入的是 `mymodel`，不是外面那层版本号目录。
      let relative = classified.path;
      if (strippedPrefix !== null && relative.startsWith(`${strippedPrefix}/`)) {
        relative = relative.slice(strippedPrefix.length + 1);
      }
      if (relative === '') {
        stats.skipped += 1;
        continue;
      }

      const target = join(tempDir, relative);
      // 双保险：即使 classify 有漏，也绝不允许写到临时目录之外。
      // `join` 已经吃掉了 `..`，所以这里比的是「结果还在不在 tempDir 里」。
      if (target !== tempDir && !target.startsWith(`${tempDir}\\`) && !target.startsWith(`${tempDir}/`)) {
        throw new ImportError('E_ZIP_UNSAFE_PATH', `条目「${classified.path}」会写到临时目录之外`);
      }

      if (classified.kind === 'directory') {
        mkdirSync(target, { recursive: true });
        stats.directories += 1;
        continue;
      }

      const data = readZipEntry(buffer, entry, directory.shift);
      const cut = Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/'));
      if (cut > 0) mkdirSync(target.slice(0, cut), { recursive: true });
      writeFileSync(target, data);
      stats.entries += 1;
      stats.bytes += data.length;
    }

    const modelFiles = findModelFiles(tempDir);
    if (modelFiles.length === 0) {
      throw new ImportError(
        'E_IMPORT_NO_MODEL',
        '这个 zip 里没有 .model3.json',
        `认不出它属于哪个模型 —— 模型包的样子是 zip 里（最多 ${MAX_MODEL_DEPTH} 层深）有一个 .model3.json 和它引用的 moc3 / 纹理`,
      );
    }

    return finishImport({ modelsRoot, tempDir, modelFiles, preferred, stats, strippedPrefix });
  } catch (error) {
    // 无论怎么失败，临时目录都不留 —— 这是「先解到临时目录」这个策略的一半价值。
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* 清不掉也不能让错误被吃掉 */
    }
    throw error;
  }
}

/**
 * 入库的最后一步：改名、搬迁、体检。
 *
 * zip 与 rar 走的是同一段 —— 「从哪来的」不影响「放进去长什么样」，而这一段里的
 * 每个决定（重名怎么让、什么时候 rename、体检失败还入不入库）都必须只有一处。
 *
 * 注意 `importModelRar` 传进来的 `tempDir` 可能只是外层包装目录里的那个真身
 * （RAR 里常见「一个顶层文件夹」），外层的清理由调用方负责。
 */
function finishImport({ modelsRoot, tempDir, modelFiles, preferred, stats, strippedPrefix }) {
  const chosen = chooseAvailableName(modelsRoot, preferred);
  const finalDir = join(modelsRoot, chosen.name);
  // 相对路径必须在 rename **之前**算出来：rename 之后 `modelFiles[0]` 指向的还是
  // 旧的临时路径，虽然按长度切片仍然对，但读代码的人得绕一圈才能确认这一点。
  const relativeModelFile = modelFiles[0].slice(tempDir.length + 1).replace(/\\/g, '/');
  renameSync(tempDir, finalDir);

  const id = `${chosen.name}/${relativeModelFile}`;
  const entry = inspectModel(modelsRoot, id, { force: true });

  return {
    ok: true,
    id,
    path: id,
    // `name` 是**体检器给出的展示名**（模型库列表里显示的那个），不是目录名 ——
    // 提示语「已导入 XXX」要的正是这个。目录名单独放在 `dir` 里，
    // 因为它才是用户要拿去在资源管理器里找文件夹的名字，两者经常不一样。
    name: entry?.name ?? chosen.name,
    dir: chosen.name,
    entry,
    stats: {
      ...stats,
      modelFiles: modelFiles.length,
      strippedPrefix,
      renamed: chosen.renamed,
      requestedName: preferred,
    },
  };
}

/**
 * 按住格式分发：`.zip` 走内存解析，`.rar` 走系统解包器。
 *
 * 返回值统一是 Promise —— zip 那条本身是同步的，但调用方（路由）不该为了
 * 「这一把恰好是 zip」写两套等待逻辑。
 */
export async function importModelArchive(buffer, options) {
  if (isZip(buffer)) return importModelZip(buffer, options);
  if (isRar(buffer)) return importModelRar(buffer, options);

  throw new ImportError(
    'E_IMPORT_NOT_ARCHIVE',
    '这个文件既不是 zip 也不是 rar',
    '请把模型文件夹压成 .zip 或 .rar 再拖进来（7z / tar / 分卷包请先转换）',
  );
}

/**
 * RAR 导入：写到临时目录 → 交给系统解包器 → 量树 → 走和 zip 一样的收尾。
 *
 * `options.findExtractor` / `options.spawnImpl` 是给门禁注入的：一台没有 7-Zip
 * 也没有 tar.exe 的机器上，光「找不到解包器时报什么错」这一条就值得单独测。
 */
export async function importModelRar(buffer, options) {
  const modelsRoot = options?.modelsRoot;
  if (typeof modelsRoot !== 'string' || modelsRoot === '') {
    throw new ImportError('E_IMPORT_NO_ROOT', '没有配置模型库目录');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImportError('E_IMPORT_EMPTY', '请求体是空的');
  }

  const locate = typeof options?.findExtractor === 'function' ? options.findExtractor : findExtractor;
  const extractor = locate();
  if (extractor === null || extractor === undefined) {
    throw new ImportError(
      'E_IMPORT_RAR_NO_EXTRACTOR',
      '这台机器上没有能解 RAR 的程序',
      'RAR 需要 7-Zip、WinRAR，或 Windows 10 1803+ 自带的 tar.exe；装一个再试，或者先解压成 .zip',
    );
  }

  mkdirSync(modelsRoot, { recursive: true });
  const tempDir = join(modelsRoot, `${IMPORT_TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tempDir, { recursive: true });

  // 解包器只认「文件路径」，不认内存里的 Buffer；这个名字以 `.` 开头，
  // 解完就删，绝不会跟着 rename 进模型库。
  const archivePath = join(tempDir, '.package.rar');
  writeFileSync(archivePath, buffer);

  try {
    let extracted;
    try {
      extracted = await extractRar({
        archivePath,
        destDir: tempDir,
        extractor,
        spawnImpl: options?.spawnImpl,
        limits: options?.limits,
        timeoutMs: options?.timeoutMs,
        pollMs: options?.pollMs,
      });
    } catch (error) {
      if (error instanceof RarError) throw new ImportError(error.code, error.message, error.detail);
      throw error;
    }

    rmSync(archivePath, { force: true });

    const stats = {
      entries: extracted.tree.files,
      skipped: 0,
      bytes: extracted.tree.bytes,
      directories: extracted.tree.directories,
    };

    if (stats.entries === 0) {
      throw new ImportError('E_IMPORT_EMPTY', '这个 rar 里没有文件');
    }

    /*
     * RAR 里常见「解出来只有一个顶层文件夹」。剥掉它，导入后的目录结构就和 zip
     * 那条一样（模型文件直接在库条目根下），`id` 也更好读。
     * 注意只在那层里确实有文件时才剥 —— 空壳目录不剥，让 `findModelFiles` 去判。
     */
    let base = tempDir;
    let strippedPrefix = null;
    const topEntries = readdirSync(tempDir, { withFileTypes: true }).filter((item) => item.name !== '.package.rar');
    if (topEntries.length === 1 && topEntries[0].isDirectory()) {
      const nested = join(tempDir, topEntries[0].name);
      if (findModelFiles(nested).length > 0) {
        base = nested;
        strippedPrefix = topEntries[0].name;
      }
    }

    const modelFiles = findModelFiles(base);
    if (modelFiles.length === 0) {
      throw new ImportError(
        'E_IMPORT_NO_MODEL',
        '这个 rar 里没有 .model3.json',
        `认不出它属于哪个模型 —— 模型包的样子是压缩包里（最多 ${MAX_MODEL_DEPTH} 层深）有一个 .model3.json 和它引用的 moc3 / 纹理`,
      );
    }

    const preferred = sanitizeLibraryName(
      strippedPrefix ?? options?.name ?? '',
      `model-${Date.now()}`,
    );

    const result = finishImport({ modelsRoot, tempDir: base, modelFiles, preferred, stats, strippedPrefix });
    /*
     * `base !== tempDir` 时，被 rename 走的是里层那个文件夹，外层包装目录还在。
     * 它同样是 `.import-` 开头（扫描器看不见），但不该留在用户的模型库里。
     */
    if (base !== tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* 清不掉也不算导入失败：模型已经搬进去了 */
      }
    }
    return result;
  } catch (error) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* 清不掉也不能让错误被吃掉 */
    }
    throw error;
  }
}
