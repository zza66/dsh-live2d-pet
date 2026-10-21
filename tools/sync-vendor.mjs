/**
 * sync-vendor.mjs — 把官方 Cubism SDK Core 落位到 vendor/cubism/，并校验版本与来源哈希。
 *
 * 用法:
 *   node tools/sync-vendor.mjs            # 同步并校验
 *   node tools/sync-vendor.mjs --check    # 只校验，不复制
 *
 * 为什么要这一步:
 *   moc3 的格式版本与 Core 必须匹配（moc3 由高版本编辑器导出时，低版本 Core 直接加载失败）。
 *   所以 vendor 里的 Core **必须**来自一个明确的官方 SDK 版本，并把该版本记录下来。
 *   SDK 自带的 cubism-info.yml 里有 core/framework/samples 三个 git 哈希，是本目录的溯源凭据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_CORE = path.join(ROOT, 'work', 'sdk5', 'CubismSdkForWeb-5-r.5', 'Core');
const SDK_INFO = path.join(ROOT, 'work', 'sdk5', 'CubismSdkForWeb-5-r.5', 'cubism-info.yml');
const VENDOR = path.join(ROOT, 'vendor', 'cubism');

const FILES = [
  'live2dcubismcore.min.js',
  'live2dcubismcore.js',
  'live2dcubismcore.d.ts',
  'CHANGELOG.md',
  'README.md',
  'LICENSE.md',
  'RedistributableFiles.txt',
];
const RENAMES = { 'README.md': 'README-Core.md', 'LICENSE.md': 'LICENSE-Core.md' };
const checkOnly = process.argv.includes('--check');

function sha256(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

if (!fs.existsSync(SDK_CORE)) {
  console.error(`[x] 找不到官方 SDK Core: ${SDK_CORE}`);
  console.error('    请先解压官方 Cubism SDK for Web 到 work/sdk5/ 下。');
  process.exit(1);
}

const info = fs.readFileSync(SDK_INFO, 'utf8');
const version = /^version:\s*(.+)$/m.exec(info)?.[1]?.trim() ?? 'unknown';
const coreHash = /^\s+core:\s*(.+)$/m.exec(info)?.[1]?.trim() ?? 'unknown';

fs.mkdirSync(VENDOR, { recursive: true });

const report = [];
for (const f of FILES) {
  const src = path.join(SDK_CORE, f);
  const dstName = RENAMES[f] ?? f;
  const dst = path.join(VENDOR, dstName);
  if (!fs.existsSync(src)) throw new Error(`官方 SDK 缺文件: ${src}`);
  const srcHash = sha256(src);
  if (checkOnly) {
    const ok = fs.existsSync(dst) && sha256(dst) === srcHash;
    report.push(`${ok ? 'ok  ' : 'DIFF'} ${dstName.padEnd(28)} ${srcHash.slice(0, 16)}`);
    continue;
  }
  fs.copyFileSync(src, dst);
  report.push(`cp   ${dstName.padEnd(28)} ${srcHash.slice(0, 16)}`);
}

// 记录溯源信息，供后续任何时刻复核
const provenance = {
  sdk: `Cubism SDK for Web ${version}`,
  sdkInfoVersion: version,
  coreGitHash: coreHash,
  coreCsmVersion: '0x6000001 (6.0.1)',
  supportsMoc3UpTo: 6,
  sourceArchive: 'work/sdk5/CubismSdkForWeb-5-r.5（官方 SDK 解包目录）',
  syncedFiles: FILES.map((f) => RENAMES[f] ?? f),
  note: 'Core 的 wasm 内嵌在 live2dcubismcore.min.js 内；官方 SDK 目录里没有 _em_module.wasm，勿去寻找。',
};
if (!checkOnly) {
  fs.writeFileSync(path.join(VENDOR, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
  // 清掉早期手工放入、来源不明/重复的副本，避免 vendor 里出现两个版本的 Core
  for (const stale of ['README.md', 'LICENSE.md']) {
    const p = path.join(VENDOR, stale);
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      console.log(`rm   ${stale.padEnd(28)} （重复文件，正名为 ${RENAMES[stale]}）`);
    }
  }
}

console.log(report.join('\n'));
console.log(`\nSDK 版本 = ${version}   core git hash = ${coreHash}`);
console.log(checkOnly ? '[check] 完成（未复制）' : `[ok] 已同步到 ${VENDOR}`);
