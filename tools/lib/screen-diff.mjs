// 比较两张 BMP 的差异：像素级（按 step 抽样）+ 差异包围盒。
// 用途：不靠眼睛判断「这个参数写下去到底有没有让画面动」。
import { readFileSync } from 'node:fs';

function readBmp(file) {
  const buf = readFileSync(file);
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported bpp ${bpp}`);
  const bytes = bpp / 8;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  return { buf, offset, width, height, bytes, rowSize, bottomUp: buf.readInt32LE(22) > 0 };
}

function pixel(img, x, y) {
  const row = img.bottomUp ? img.height - 1 - y : y;
  const idx = img.offset + row * img.rowSize + x * img.bytes;
  return [img.buf[idx + 2], img.buf[idx + 1], img.buf[idx]]; // BMP 是 BGR
}

export function diffBmp(left, right, step = 2, threshold = 8) {
  const a = readBmp(left);
  const b = readBmp(right);
  if (a.width !== b.width || a.height !== b.height) throw new Error('size mismatch');
  let count = 0;
  let total = 0;
  let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
  const cols = [];
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      total += 1;
      const p = pixel(a, x, y);
      const q = pixel(b, x, y);
      const d = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
      if (d <= threshold) continue;
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return {
    width: a.width,
    height: a.height,
    sampled: total,
    changed: count,
    ratio: total === 0 ? 0 : count / total,
    box: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + step, h: maxY - minY + step },
  };
}

if (process.argv[1] && process.argv[1].endsWith('screen-diff.mjs')) {
  const [, , left, right, stepArg] = process.argv;
  if (!left || !right) {
    console.error('用法：node screen-diff.mjs <before.bmp> <after.bmp> [step]');
    process.exit(2);
  }
  const result = diffBmp(left, right, Number(stepArg) || 2);
  console.log(JSON.stringify(result));
}
