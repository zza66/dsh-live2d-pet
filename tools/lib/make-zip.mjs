/**
 * 在内存里拼一个 zip —— 供门禁造测试样本用。
 *
 * 为什么自己拼而不是调 `zip` 命令或第三方库：门禁需要造出**故意损坏**的包
 * （CRC 写错、大小写错、截断、压缩炸弹），而这些恰恰是任何正经打包工具
 * 都不会让你做出来的东西。手写 30 字节的本地头 + 46 字节的中央目录项
 * 换来的是「每一个字节都可控」。
 *
 * 被 `tools/test-model-import.mjs` 与 `tools/lib/host-route-checks.mjs` 共用 ——
 * 两处各写一份的话，路由门禁测的就不再是同一个格式了。
 *
 * @module tools/lib/make-zip
 */

import { deflateRawSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** zip 内 CRC-32（IEEE 802.3 多项式，反射写法）。 */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 1×1 透明 PNG（33 字节的完整文件）。体检器只需要 IHDR 里的宽高。 */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 造一个 zip。
 *
 * 每个 entry 可以单独指定压缩方法、UTF-8 标志位，以及**故意写错的**
 * CRC / 大小 —— 后面那些是为了测「损坏检测」，正常样本不传就行。
 *
 * `name` 可以直接给 Buffer，用来造 GBK 这种非 UTF-8 的条目名。
 */
export function makeZip(entries, options = {}) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const item of entries) {
    const rawName = Buffer.isBuffer(item.name) ? item.name : Buffer.from(item.name, 'utf8');
    const data = item.data ?? Buffer.alloc(0);
    const method = item.method === 'deflate' ? 8 : 0;
    const payload = method === 8 ? deflateRawSync(data) : data;
    const flags = item.utf8Flag === true ? 0x800 : 0;
    const crc = item.crcOverride ?? crc32(data);
    const compressedSize = item.compressedSizeOverride ?? payload.length;
    const uncompressedSize = item.uncompressedSizeOverride ?? data.length;
    const isDirectory = rawName.length > 0 && rawName[rawName.length - 1] === 0x2f;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(rawName.length, 26);
    local.writeUInt16LE(0, 28);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressedSize, 20);
    entry.writeUInt32LE(uncompressedSize, 24);
    entry.writeUInt16LE(rawName.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(isDirectory ? 0x10 : 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, rawName]));

    parts.push(local, rawName, payload);
    offset += 30 + rawName.length + payload.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const tail = options.comment ? Buffer.from(options.comment, 'utf8') : Buffer.alloc(0);
  if (tail.length > 0) eocd.writeUInt16LE(tail.length, 20);

  return Buffer.concat([...parts, cd, eocd, tail]);
}

/** 一个最小但**合法**的模型包（若干文件的名字 → 字节）。 */
export function modelPackageFiles(mocVersion = 5) {
  const moc = Buffer.alloc(64);
  moc.write('MOC3', 0, 'latin1');
  moc[4] = mocVersion;
  moc[5] = 0;
  const json = {
    Version: 3,
    FileReferences: { Moc: 'model.moc3', Textures: ['texture.png'] },
    Groups: [{ Name: 'EyeBlink', Ids: [] }],
  };
  return {
    'model.model3.json': Buffer.from(JSON.stringify(json), 'utf8'),
    'model.moc3': moc,
    'texture.png': PNG_1X1,
  };
}

/**
 * 一个最小合法模型包打成的 zip。
 *
 * `prefix` 用来模拟「从 GitHub 下载的包多一层版本号目录」这种情况，
 * 它正是 `commonTopLevel()` 要剥掉的那一层。
 */
export function zipOfPackage(prefix = '', mocVersion = 5) {
  const files = modelPackageFiles(mocVersion);
  return makeZip(Object.entries(files).map(([name, data]) => ({ name: `${prefix}${name}`, data, method: 'deflate' })));
}

/**
 * 把一个**真实目录**压成 zip。
 *
 * 与上面那些「手拼一个最小包」的函数分工不同：它们造的是**样本**，
 * 这个压的是真货 —— 用来验「用户真实的模型包能不能走完整条导入链路」。
 * 手拼的包永远只有 3 个文件、几十字节，压不出「2 张 4MB 纹理 + 6 个动作 + 音频」
 * 这类真实结构里才会出现的路径问题（大小写、空格、中文名、子目录、二级引用）。
 *
 * 条目名一律用 `/` 分隔（zip 规范如此，Windows 的 `\` 会被别的解压器当成文件名的一部分）。
 * 目录条目也写进去 —— 虽然导入器会跳过它们，但真实的压缩工具都会写，
 * 门禁压出来的包应该和用户手里的长得一样。
 */
export function zipDirectory(dir, options = {}) {
  const prefix = options.prefix ?? '';
  const entries = [];

  const walk = (absolute, relative) => {
    for (const item of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = join(absolute, item.name);
      const rel = relative === '' ? item.name : `${relative}/${item.name}`;
      if (item.isDirectory()) {
        entries.push({ name: `${prefix}${rel}/`, data: Buffer.alloc(0) });
        walk(child, rel);
      } else if (item.isFile()) {
        // 二进制原样压：`deflate` 对 PNG 收益很小，但真实工具也是这么干的。
        entries.push({ name: `${prefix}${rel}`, data: readFileSync(child), method: 'deflate' });
      }
    }
  };

  walk(dir, '');
  return makeZip(entries, options);
}
