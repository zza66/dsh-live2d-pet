/**
 * gate-model.mjs — P0 门禁：官方 Cubism Core 能否在纯 Node 里加载真实测试模型。
 *
 * 用法:
 *   node tools/gate-model.mjs <core.js> <model.moc3>
 *
 * 为什么需要它:
 *   「AI 控制 Live2D」的全部可行性建立在「moc3 能被官方 Core 解析、参数/部件能被枚举」之上。
 *   这个脚本把该前提变成一条可重复执行的命令，任何时刻都能重跑验证。
 *
 * 踩过的坑（已内建规避，勿回退）:
 *   1. Core 的 UMD 尾部会走 `module.exports` 分支 → 在 ESM 里 import 拿不到全局，
 *      必须放进没有 module/exports 的 vm 沙箱当脚本执行，再从沙箱取 Live2DCubismCore。
 *   2. Node 24 的 globalThis.navigator 只有 getter，赋值会抛 TypeError（Core 不需要它）。
 *   3. 沙箱必须给 atob，否则 wasm 初始化永不完成。
 *   4. 不要去找 `_em_module.wasm`：官方 SDK 的 Core 目录里**没有**这个文件（SDK zip 与
 *      npm 包、CDN 三处都实测过），wasm 是内嵌在 live2dcubismcore.min.js 里的；
 *      沙箱给一个「明确失败」的 fetch 桩即可，Core 会自己落到内嵌路径。
 *   5. Core **没有 then()**，别等 `Core.then`；初始化是异步的，用轮询 `Core.Version.csmGetVersion()`。
 *   6. 画布信息在 **Model** 上且是全小写 `model.canvasinfo`，不是 `moc.canvasInfo`。
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

/** 在 vm 沙箱里执行 Core，返回沙箱上的 Live2DCubismCore。 */
export function createCore(corePath) {
  const src = fs.readFileSync(corePath, 'utf8');
  const url = 'file:///' + corePath.replace(/\\/g, '/');
  const sandbox = {
    console,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance,
    Promise,
    WebAssembly,
    Math,
    JSON,
    Date,
    Error,
    TypeError,
    Number,
    Array,
    Object,
    String,
    // Core 会探测 fetch；给它一个「明确失败」的桩，逼它落到内嵌 wasm 路径。
    fetch: (u) => Promise.reject(new Error('gate-model: no external wasm expected, got ' + u)),
    location: { href: url },
    document: { currentScript: { src: url } },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.runInContext(src, vm.createContext(sandbox), { filename: corePath });
  return sandbox.Live2DCubismCore;
}

/** Core 的 wasm 初始化是异步的，且没有 then()。轮询版本号直到可用。 */
export async function waitForCore(Core, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = Core.Version.csmGetVersion();
      if (typeof v === 'number') return { version: v, elapsedMs: Date.now() - t0 };
    } catch {
      /* not ready yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`Core wasm did not initialize within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * 是否作为命令行脚本直接运行。
 *
 * 需要这个判断是因为下面那段 CLI 代码用的是**顶层 await**：一旦被 `import`，
 * 它会连同 CLI 一起执行（`process.argv[2]` 是空的 → 直接 exit 2），
 * 于是这个文件里两个有用的导出（`createCore` / `waitForCore`）就没法被复用。
 * `tools/test-model-library.mjs` 要用它们来核对 Core 支持的最高 moc3 版本。
 */
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const CORE = process.argv[2];
const MOC = process.argv[3];
if (IS_MAIN && (!CORE || !MOC)) {
  console.error('usage: node tools/gate-model.mjs <core.js> <model.moc3>');
  process.exit(2);
}

if (IS_MAIN) {
const Core = createCore(CORE);
const { version, elapsedMs } = await waitForCore(Core);
console.log(`[1] Core 就绪 耗时=${elapsedMs}ms  csmGetVersion=0x${version.toString(16)} (${version})`);
console.log(`[2] Core 支持的最高 moc3 = ${Core.Version.csmGetLatestMocVersion()}  常量: MocVersion_50=${Core.MocVersion_50} MocVersion_53=${Core.MocVersion_53}`);

const buf = fs.readFileSync(MOC);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const sig = Buffer.from(ab, 0, 4).toString('ascii');
/**
 * moc3 文件头的真实布局：`"MOC3"` + **1 字节版本** + **1 字节端序** + 2 字节保留。
 *
 * 这里原先读的是 `readUInt32LE(4)`，**只是碰巧对**：官方样本的字节 4–7 都是
 * `[版本, 0, 0, 0]`（端序=0 小端、保留=0），所以 32 位整数读出来正好等于版本。
 * 一旦某个模型声明大端序（字节 5 = 1），那个读法就会报出一个荒谬的版本号。
 * 实测三个样本（空/Haru/Ren）= `[5,0,0,0]` / `[1,0,0,0]` / `[6,0,0,0]`，
 * 两种读法一致 —— 正因为一致，这个错误才一直没被发现。
 */
const header = Buffer.from(ab, 0, 8);
const mocVer = header[4];
const endian = header[5];
console.log(`[3] 模型文件 sig=${sig} moc3 版本=v${mocVer} 端序=${endian === 0 ? '小端' : `未知(${endian})`} 字节=${ab.byteLength}`);
if (sig !== 'MOC3') throw new Error('bad moc3 signature: ' + sig);
if (endian !== 0) console.log(`    ⚠ 端序字节非 0，本门禁未验证 Core 对它的处理`);
if (mocVer > Core.Version.csmGetLatestMocVersion()) {
  throw new Error(`moc3 v${mocVer} 高于 Core 支持的 v${Core.Version.csmGetLatestMocVersion()}`);
}

const moc = Core.Moc.fromArrayBuffer(ab);
console.log(`[4] Moc 解析成功 一致性=${typeof moc.hasMocConsistency === 'function' ? moc.hasMocConsistency(ab) : 'n/a'}`);
console.log(`     moc 上的 moc3 版本=${Core.Version.csmGetMocVersion(moc, ab)} (MocVersion_50=${Core.MocVersion_50})`);

const model = Core.Model.fromMoc(moc);
// 注意：canvasinfo 是 **Model** 的字段（不是 Moc 的），全小写。
const ci = model.canvasinfo;
console.log(`[5] 画布 ${ci.CanvasWidth}x${ci.CanvasHeight} origin=(${ci.CanvasOriginX},${ci.CanvasOriginY}) ppu=${ci.PixelsPerUnit}`);

const par = model.parameters;
const ids = [];
for (let i = 0; i < par.count; i++) {
  ids.push({ id: par.ids[i], min: par.minimumValues[i], max: par.maximumValues[i], def: par.defaultValues[i] });
}
console.log(`[6] 参数=${par.count} 部件=${model.parts.count} 绘制对象=${model.drawables.count}`);

const want = [
  'ParamMouthOpenY', 'ParamMouthForm', 'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamEyeBallX', 'ParamEyeBallY', 'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamBreath',
  'ParamBrowLYY', 'ParamBrowRYY',
];
const missing = [];
for (const w of want) {
  const hit = ids.find((x) => x.id === w);
  if (!hit) { missing.push(w); continue; }
  console.log(`[7] ${w.padEnd(18)} min=${hit.min} max=${hit.max} def=${hit.def}`);
}
if (missing.length) console.log(`[7] 缺失标准参数: ${missing.join(', ')}`);

const placeholder = ids.filter((x) => /^Param\d+$/.test(x.id));
console.log(`[8] 占位参数 /^Param\\d+$/ 共 ${placeholder.length} 个`);
console.log('[9] GATE PASSED');
}
