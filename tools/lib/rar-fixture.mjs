/*
 * 手搓一枚 RAR4（store 法），只为让 RAR 导入那条路有真包可测。
 *
 * ## 为什么需要它
 *
 * RAR 是**只读格式**：本机没有 7-Zip / WinRAR（那两者能压），Node 侧也没有能写
 * RAR 的库。可「rar 导入能不能成」这件事必须在一个真包上验 —— 拿假字节喂进去，
 * 测到的只是我们自己的错误分支。
 *
 * 这个生成器写的是 RAR4 的 **stored**（不压缩）块，结构完全按 unrar 的布局：
 *
 * ```
 * BaseBlock { u16 HEAD_CRC; u8 HEAD_TYPE; u16 HEAD_FLAGS; u16 HEAD_SIZE }
 * HEAD_CRC = CRC32(从 HEAD_TYPE 起、到 HEAD_SIZE 结尾) 的低 16 位
 * MARK_HEAD   = 52 61 72 21 1a 07 00
 * MAIN_HEAD   = 0x73, HEAD_SIZE 13, 另有 u16 HighPosAV + u32 PosAV
 * FILE_HEAD   = 0x74, HEAD_SIZE 32 + 名字长度, 另有
 *               u32 PACK_SIZE, u32 UNP_SIZE, u8 HOST_OS, u32 FILE_CRC,
 *               u32 FTIME, u8 UNP_VER, u8 METHOD, u16 NAME_SIZE, u32 ATTR
 * ENDARC_HEAD = 0x7b, HEAD_SIZE 7
 * ```
 *
 * 实测 `C:\Windows\System32\tar.exe`（bsdtar 3.8.9 / libarchive）能列出并解出这些包，
 * 说明字节是对的 —— 这一点很重要：如果生成器写错了，门禁里「解包成功」的断言
 * 会变成在测一个我们自己编的格式。
 *
 * RAR5 没有生成器：它的头是 vint 编码的，手搓成本远大于收益。RAR4 / RAR5 的
 * **识别**用固定魔数测（`isRar`），**解包**能力交给解包器自己（libarchive 两种都认）。
 */

import { PNG_1X1, modelPackageFiles } from './make-zip.mjs';

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[i] = c >>> 0;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function base(type, flags, body) {
  const head = Buffer.alloc(7 + body.length);
  head.writeUInt8(type, 2);
  head.writeUInt16LE(flags, 3);
  head.writeUInt16LE(head.length, 5);
  body.copy(head, 7);
  head.writeUInt16LE(crc32(head.subarray(2)) & 0xffff, 0);
  return head;
}

const MARK = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

function mainHead() {
  const body = Buffer.alloc(6);
  body.writeUInt16LE(0, 0);
  body.writeUInt32LE(0, 2);
  return base(0x73, 0x0000, body);
}

function dosTime(date) {
  return (
    (((date.getFullYear() - 1980) & 0x7f) << 25)
    | ((date.getMonth() + 1) << 21)
    | (date.getDate() << 16)
    | (date.getHours() << 11)
    | (date.getMinutes() << 5)
    | (date.getSeconds() >> 1)
  ) >>> 0;
}

function fileHead(name, data, { directory = false } = {}) {
  const nameBuf = Buffer.from(name, 'ascii');
  const body = Buffer.alloc(25 + nameBuf.length);
  body.writeUInt32LE(directory ? 0 : data.length, 0);
  body.writeUInt32LE(directory ? 0 : data.length, 4);
  body.writeUInt8(3, 8); // HOST_OS: unix
  body.writeUInt32LE(directory ? 0 : crc32(data), 9);
  body.writeUInt32LE(dosTime(new Date('2026-10-19T12:00:00Z')), 13);
  body.writeUInt8(20, 17); // UNP_VER 2.0
  body.writeUInt8(0x30, 18); // METHOD: store
  body.writeUInt16LE(nameBuf.length, 19);
  body.writeUInt32LE(directory ? 0x10 : 0x20, 21);
  nameBuf.copy(body, 25);
  return base(0x74, directory ? 0xe0 : 0x8000, body);
}

function endArc() {
  return base(0x7b, 0x4000, Buffer.alloc(0));
}

/**
 * @param {{name: string, data?: Buffer, directory?: boolean}[]} entries
 * @returns {Buffer} 一个 RAR4 包
 */
export function buildRar4(entries) {
  const parts = [MARK, mainHead()];
  for (const entry of entries) {
    if (entry.directory) {
      parts.push(fileHead(entry.name, Buffer.alloc(0), { directory: true }));
      continue;
    }
    const data = entry.data ?? Buffer.alloc(0);
    parts.push(fileHead(entry.name, data), data);
  }
  parts.push(endArc());
  return Buffer.concat(parts);
}

/**
 * 一个最小**合法**模型包打成的 rar。
 *
 * `prefix` 模拟「解出来只有一个顶层文件夹」—— 那正是 rar 分发里最常见的样子，
 * 也是 `importModelRar` 要剥掉的一层。
 */
export function rarOfPackage(prefix = 'mymodel', mocVersion = 5) {
  const files = modelPackageFiles(mocVersion);
  const entries = [{ name: prefix, directory: true }];
  for (const [name, data] of Object.entries(files)) {
    entries.push({ name: `${prefix}/${name}`, data });
  }
  return buildRar4(entries);
}

/** 一个「像个压缩包，但没有 .model3.json」的 rar，用来测 `E_IMPORT_NO_MODEL`。 */
export function rarWithoutModel(prefix = 'junk') {
  return buildRar4([
    { name: prefix, directory: true },
    { name: `${prefix}/readme.txt`, data: Buffer.from('not a model', 'utf8') },
    { name: `${prefix}/texture.png`, data: PNG_1X1 },
  ]);
}
