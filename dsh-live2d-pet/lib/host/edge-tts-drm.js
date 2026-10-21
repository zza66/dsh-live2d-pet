/**
 * Edge-TTS 的 `Sec-MS-GEC` 令牌（**v2**）与请求指纹。
 *
 * 为什么要自己实现一套哈希：2026 年起上游把令牌从
 *   旧版 = SHA256( 时间戳 + 固定 token ).hexUpper()
 * 换成了
 *   新版 = "<16位十六进制>-<64位十六进制>"
 * 其中后半段来自一个**改过常数的 SHA-256 变体**（K[14] 被替换、初始状态与
 * 消息调度表都是硬编码的另一套值，还要从第 14 轮才开始跑），前半段是一个
 * 叫做 "CS64" 的混淆摘要。这不是标准算法，必须照抄上游 `edge_tts/drm.py`。
 *
 * 本文件是 `rany2/edge-tts` 中 `drm.py` 纯计算部分的 1:1 移植（去掉网络部分）。
 * 移植时最需要注意的三点，都是 Python 与 JS 的语义差异：
 *   1. Python 整数是任意精度，`value << 25` 不会截断；JS 的 `<<` 会截成 32 位。
 *      因为最后只取低 32 位，而「先异或再截断」等于「先各自截断再异或」，
 *      所以 JS 直接移位 + `>>> 0` 是等价的 —— 但**必须用 `>>>` 而不是 `>>`**，
 *      否则会把最高位当符号位扩展。
 *   2. Python 的 `e * 0x100000001` 是「把 e 在 64 位里重复两次」这种取巧写法，
 *      JS 里这么大整数会丢精度，所以直接写成 ROTR。
 *   3. 所有 `(a * b) & 0xFFFFFFFF` 都必须用 `Math.imul`：乘积远超 2^53，
 *      普通乘法会丢低位。
 *
 * 上游出处：rany2/edge-tts 的 `src/edge_tts/drm.py`（`_sha256_*`、`_cs64_digest`、
 * `_token_hash`、`generate_sec_ms_gec_v2`）。协议常量见 `constants.py`。
 */

const U32_MASK = 0xffffffff;
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH_SECONDS = 11_644_473_600;

/** SHA-256 轮常数。注意索引 14 会被 _SHA256_ADJUSTMENT 顶掉。 */
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** 上游硬编码的 SHA-256 初始状态（不是 FIPS 的那八个初值）。 */
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** 跑到第 14 轮时的中间状态。 */
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];

/** 消息调度表前 14 个词（替代标准的 words[0..13]，那 14 个词被强制为 0）。 */
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];

const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

/** CS64 摘要用到的 14 组 (系数, 偏移)。 */
const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const u32 = (value) => value >>> 0;
const rotr = (value, bits) => ((value >>> bits) | (value << (32 - bits))) >>> 0;
const rol16 = (value) => (((value & U32_MASK) << 16) | ((value & U32_MASK) >>> 16)) >>> 0;
/** 32 位模乘。普通 `*` 在这里会丢低位（乘积超过 2^53）。 */
const mul32 = (a, b) => Math.imul(a, b) >>> 0;

const sigma0 = (value) =>
  ((value >>> 7) ^ (value << 25) ^ (value >>> 18) ^ (value << 14) ^ (value >>> 3)) >>> 0;
const sigma1 = (value) =>
  ((value >>> 17) ^ (value << 15) ^ (value >>> 19) ^ (value << 13) ^ (value >>> 10)) >>> 0;

/**
 * SHA-256 压缩函数，可从中间某一轮开始跑（上游为了藏起前 14 轮就是这么用的）。
 * `firstRound === 14` 时用被改过的轮常数表。
 */
function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let index = firstRound; index < 64; index += 1) {
    const t1 = u32(
      h +
        (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
        (g ^ (e & (f ^ g))) +
        constants[index] +
        words[index],
    );
    const t2 = u32(
      (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) | (c & (a | b))),
    );
    h = g;
    g = f;
    f = e;
    e = u32(d + t1);
    d = c;
    c = b;
    b = a;
    a = u32(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}

/** 消息调度扩展（同样不在中途截断，只在求和后取模）。 */
function expandSchedule(words, firstWord = 16) {
  for (let index = firstWord; index < 64; index += 1) {
    const x = words[index - 2];
    const y = words[index - 15];
    words.push(u32(sigma1(x) + words[index - 7] + sigma0(y) + words[index - 16]));
  }
}

/** 由 data 的前 7 个字节算出「跳到第 14 轮时」的状态。 */
function sha256Init(data) {
  const words = new Array(14).fill(0);
  words.push(u32((data[0] << 16) | (data[1] << 8) | data[2]));
  words.push(u32((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]));

  for (let index = 16; index <= 29; index += 1) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      const term = sigma1(words[index - 2]);
      value += index === 16 ? (term ^ SHA256_SIGMA1_ADJUSTMENT) : term;
    }
    if (index - 7 >= 14) {
      value += words[index - 7];
    }
    if (index - 15 >= 14) {
      const term = sigma0(words[index - 15]);
      value += index === 29 ? (term ^ SHA256_SIGMA0_ADJUSTMENT) : term;
    }
    words.push(u32(value));
  }

  words.push(
    u32(
      sigma1(words[28]) +
        words[23] +
        sigma0(words[15]) +
        words[14] +
        SHA256_ADJUSTMENT -
        SHA256_ROUND_CONSTANTS[14],
    ),
  );

  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((value, index) => u32(value + working[index]));
}

function toBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function toHexUpper(bytes) {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}

/** 这个变体 SHA-256 的摘要（32 字节）。 */
function sha256Digest(data) {
  if (data.length < 7) {
    throw new Error('Token salt must contain at least seven bytes');
  }
  const length = 57 + data.length;
  const tail = data.subarray(7);
  const padLength = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(tail.length + 1 + padLength + 8);
  padded.set(tail, 0);
  padded[tail.length] = 0x80;

  // 末尾 8 字节是「比特长度」的大端 64 位整数。
  const bitLength = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const blockView = new DataView(padded.buffer, offset, 64);
    const words = [];
    for (let index = 0; index < 16; index += 1) {
      words.push(blockView.getUint32(index * 4, false));
    }
    expandSchedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((value, index) => u32(value + working[index]));
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  state.forEach((value, index) => outView.setUint32(index * 4, value, false));
  return out;
}

/** 按小端 32 位切词；不足补零；词数为奇数时再补一个 0。 */
function wordsLe4Even(bytes) {
  if (bytes.length === 0) return [];
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
  padded.set(bytes, 0);
  const view = new DataView(padded.buffer);
  const words = [];
  for (let index = 0; index < padded.length / 4; index += 1) {
    words.push(view.getUint32(index * 4, true));
  }
  if (words.length % 2) words.push(0);
  return words;
}

/** CS64 摘要（两个 32 位词）。 */
function cs64Digest(data, digest) {
  const digestView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = digestView.getUint32(0, true) | 1;
  const keyB = digestView.getUint32(4, true) | 1;

  const factors = [mul32(keyA, CS64_FACTOR), mul32(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([coefficient], index) =>
    mul32(coefficient, factors[index % 2]),
  );
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);

  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  const words = wordsLe4Even(prefixed);
  words.forEach((word, index) => {
    let term = mul32(word, index % 2 === 0 ? keyA : keyB);
    let offset = mul32(rol16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (index === 0) {
      term = u32(term + mul32(CS64_ADJUSTMENT0, factors[0]));
      offset = u32(offset + CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  });

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;

  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];

    let t = rol16(u32(offsets[index] + x));
    let q = mul32(t, 0x76f50f34);
    swapAcc = u32(swapAcc + u32(mul32(rol16(q), 0xc3efea97) + q));

    t = rol16(u32(offsets[index + 1] + y));
    q = mul32(t, 0x1881ce3c);
    swapLast = u32(mul32(rol16(q), 0x35bd1ec9) + q);
    swapAcc = u32(swapAcc + swapLast);

    state = u32(mul32(state, keyA) + x);
    state = mul32(rol16(state), 0xcf98b111);
    state = mul32(rol16(state), 0x87085b9f);
    state = mul32(rol16(state), 0x12ceb96d);
    state = mul32(rol16(state), 0x257e1d83);
    acc = u32(acc + state);

    t = u32(mul32(state, keyB) + y);
    t = mul32(rol16(t), 0xa27416f5);
    t = mul32(rol16(t), 0xd38396ff);
    state = mul32(rol16(mul32(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = u32(acc + state);
  }

  return [u32(swapLast ^ state), u32(swapAcc ^ acc)];
}

/** 返回 `[cs64 的 16 位大写十六进制, sha256 的 64 位大写十六进制]`。 */
export function tokenHash(data) {
  const digest = sha256Digest(data);
  const [low, high] = cs64Digest(data, digest);
  const cs64Bytes = new Uint8Array(8);
  const view = new DataView(cs64Bytes.buffer);
  view.setUint32(0, low, true);
  view.setUint32(4, high, true);
  return [toHexUpper(cs64Bytes), toHexUpper(digest)];
}

/**
 * 生成 v2 版 `Sec-MS-GEC`。
 *
 * 时间向下取整到 5 分钟窗口，换算成 100ns 计数，拼上固定 token 再哈希。
 * 5 分钟窗口意味着这个值**可以按窗口缓存**，不必每次合成都重算。
 *
 * @param {number} [unixTimestampSeconds] 供测试注入固定时间。
 */
export function generateSecMsGecV2(unixTimestampSeconds) {
  let ticks = unixTimestampSeconds ?? Date.now() / 1000;
  ticks += WIN_EPOCH_SECONDS;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const salt = `${Math.round(ticks)}${TRUSTED_CLIENT_TOKEN}`;
  const [cs64, sha256] = tokenHash(toBytes(salt));
  return `${cs64}-${sha256}`;
}

/** 旧的 v1 令牌，仅保留用于对照排查（服务器已不接受）。 */
export function generateSecMsGecV1(unixTimestampSeconds) {
  let seconds = Math.floor((unixTimestampSeconds ?? Date.now() / 1000) + WIN_EPOCH_SECONDS);
  seconds -= seconds % 300;
  const salt = `${seconds * 1e7}${TRUSTED_CLIENT_TOKEN}`;
  let hex = '';
  for (const byte of sha256DigestStandard(toBytes(salt))) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex.toUpperCase();
}

/**
 * 生成 MUID（`Cookie: muid=<值>;`）。上游用 `secrets.token_hex(16).upper()`，
 * 即 32 个大写十六进制字符。
 */
export function generateMuid(randomBytes) {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex.toUpperCase();
}

// 仅供 v1 对照使用；v2 走的是上面那套改过的 SHA-256，不要混。
import { createHash } from 'node:crypto';
function sha256DigestStandard(bytes) {
  return createHash('sha256').update(bytes).digest();
}

// 直接 `node lib/host/edge-tts-drm.js` 时打印几组固定时间的令牌，便于与上游对照。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const samples = [1760000000, 1760000300, 1760000600, 1792062000];
  console.log(`[drm] v2 令牌（5 分钟窗口，同一窗口内应完全一致）：`);
  for (const seconds of samples) {
    console.log(`      t=${seconds}  ${generateSecMsGecV2(seconds)}`);
  }
  console.log(`[drm] MUID 示例  ${generateMuid()}`);
}
