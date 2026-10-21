/**
 * 验证 `Sec-MS-GEC` v2 令牌的 JS 移植与上游 Python 实现**逐字节一致**。
 *
 * 为什么需要这个测试：v2 是一套**故意混淆过的哈希**（改过轮常数的 SHA-256 +
 * 一个叫 CS64 的自定义摘要），手工移植时任何一处移位方向、任一处的 32 位截断
 * 时机搞错，结果都是一个「看起来完全正常、服务器却拒收」的 403 —— 靠人眼看
 * 是查不出来的。所以这里用上游 Python 实现算出的固定向量做基准。
 *
 * 基准向量的来源（可复现）：
 *   work/refpkg/ 里放上游 `edge_tts` 的 constants.py + drm.py，
 *   然后用 `work/ref-tokens.py` 跑出下面这张表。
 *
 * 跑法：`node tools/test-edge-tts-drm.mjs`，退出码 0 = 全部一致。
 */

import { generateSecMsGecV2, tokenHash } from '../dsh-live2d-pet/lib/host/edge-tts-drm.js';

/** 上游 `generate_sec_ms_gec_v2(t)` 在固定时间戳下的输出。 */
const REFERENCE_VECTORS = [
  ['1760000000', '6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D'],
  ['1760000300', 'BAF4076F572BFE4E-2D6FBE5C0E24F56622EB94F37395F2D153C6C0C451DAAE2249A459BB3AFAD62C'],
  ['1760000600', '888E368302A0D5CE-346B89DBF1A9DC32E73932D778AA09BEE9B5D0F57E3F3C4FA44DD30045948E3B'],
  ['1792062000', 'A7FC1929C57A6E9F-24CD5D239C6F52D57101F1E8A445CB38D2EB0FF110CB4836D2B48AA433908387'],
  ['1792062300', '3D9DB90802C86EB4-FEE401A2DBD309B7405DEC2A5E3F60F4C43401EEE2EBAABBE715A0D6F2161749'],
  ['1893456000', '7442B6E630CDF0DE-CE82EC1509335DC856270C1EEB0F7F2575909AC26840D2C15B28A41EBB7E9CCF'],
];

let failures = 0;

console.log('[1] 令牌格式：应形如 <16 位十六进制>-<64 位十六进制>');
const sample = generateSecMsGecV2(1792062000);
if (/^[0-9A-F]{16}-[0-9A-F]{64}$/.test(sample)) {
  console.log(`    [ok] ${sample}`);
} else {
  console.log(`    [FAIL] 格式不对：${sample}`);
  failures += 1;
}

console.log('[2] 与上游 Python 的固定向量逐条比对');
for (const [seconds, expected] of REFERENCE_VECTORS) {
  const actual = generateSecMsGecV2(Number(seconds));
  if (actual === expected) {
    console.log(`    [ok] t=${seconds}`);
  } else {
    console.log(`    [FAIL] t=${seconds}`);
    console.log(`           期望 ${expected}`);
    console.log(`           实得 ${actual}`);
    failures += 1;
  }
}

console.log('[3] 5 分钟窗口内必须完全相同（这是能按窗口缓存的前提）');
const base = 1792062000;
const within = [base, base + 1, base + 299];
const tokensWithin = within.map((t) => generateSecMsGecV2(t));
if (tokensWithin.every((token) => token === tokensWithin[0])) {
  console.log('    [ok] t=base / base+1 / base+299 三者一致');
} else {
  console.log(`    [FAIL] 窗口内不一致：${JSON.stringify(tokensWithin)}`);
  failures += 1;
}
if (generateSecMsGecV2(base + 300) !== tokensWithin[0]) {
  console.log('    [ok] t=base+300 进入下一个窗口，令牌已变化');
} else {
  console.log('    [FAIL] t=base+300 没有换窗口');
  failures += 1;
}

console.log('[4] 两个分量应当各自独立可复算（cs64 与 sha256 拼接）');
const [cs64, sha256] = tokenHash(
  new TextEncoder().encode(`${Math.round((1792062000 + 11644473600 - ((1792062000 + 11644473600) % 300)) * 1e7)}6A5AA1D4EAFF4E9FB37E23D68491D6F4`),
);
if (`${cs64}-${sha256}` === generateSecMsGecV2(1792062000)) {
  console.log('    [ok] tokenHash 的重组结果与 generateSecMsGecV2 一致');
} else {
  console.log(`    [FAIL] 重组不一致：${cs64}-${sha256}`);
  failures += 1;
}

if (failures > 0) {
  console.log(`\n[x] ${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n[5] DRM GATE PASSED —— JS 移植与上游 Python 完全一致');
}
