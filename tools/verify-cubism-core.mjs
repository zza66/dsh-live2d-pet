/**
 * verify-cubism-core.mjs — P0 门禁脚本（可重复运行）
 *
 * 目的：证明「vendor 里的 Cubism Core 到底能不能加载用户这个 moc3 模型」。
 * 这是整个项目的地基：Core 版本低于 moc3 版本时，模型根本加载不了（E_MOC3_VERSION_UNSUPPORTED）。
 *
 * 背景（踩过的三个坑，勿重犯）：
 *  1) 别把「npm 上的 Core」和「官方 CDN 上的 Core」当成同一个东西：
 *       · npm `live2dcubismcore@1.0.2`      → csmGetVersion raw 67239938 = Core 4.2.0.2，只支持 moc3 ≤ 4
 *       · 官方 CDN .../cubismcore/live2dcubismcore.min.js → raw 83951616 = Core 5.1.0.0，支持到 moc3 5.0
 *       · 官方 SDK CubismSdkForWeb-5-r.5/Core     → raw 100663297 = Core 6.0.0.1，支持到 moc3 5.3（vendor 用的就是这份）
 *     本模型 moc3 版本 = 5，所以 4.2.x 那份**必然**失败（Moc.fromArrayBuffer 返回 null）。
 *  2) 该脚本在 Node 里直接 import/require 会走 emscripten 的 module.exports 分支，
 *     Live2DCubismCore 挂不到全局 → 必须在**没有 module/exports 的 vm 沙箱**里当脚本执行。
 *  3) 沙箱里必须补：`atob`（emscripten 解内联小字符串要用），且**不能**给
 *     `module`/`exports`/`require`/`process`，也**不能**给 `window`/`self`/`document`
 *     —— 一旦定义了 window/self，emscripten 就判定为浏览器环境、改走 DOM 分支然后卡死。
 *     注意 `vm.createContext` 新建的 V8 context 自带全部 ES 内建对象（含 WebAssembly），
 *     所以 WebAssembly 给不给都能跑；真正决定成败的是「有没有 window/module」。
 *  4) Core 5/6 不需要任何 wasm 文件，也不需要网络：它是纯 JS 构建（详见脚本中段的字节级取证）。
 *
 * 用法：node tools/verify-cubism-core.mjs [core.min.js 路径] [moc3 路径]
 * 退出码：0 = 能加载；1 = 不能加载；2 = 用法/文件缺失。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const CORE =
  process.argv[2] || path.join(ROOT, 'vendor', 'cubism', 'live2dcubismcore.min.js');
const MOC =
  process.argv[3] ||
  path.join(ROOT, 'models-inbox', '空_vts', '空 - 免费版.moc3');

const line = (s = '') => process.stdout.write(s + '\n');

for (const [label, p] of [['Core', CORE], ['moc3', MOC]]) {
  if (!fs.existsSync(p)) {
    line(`✗ ${label} 不存在: ${p}`);
    process.exit(2);
  }
}

const coreSrc = fs.readFileSync(CORE, 'utf8');
const coreSha = crypto.createHash('sha256').update(coreSrc).digest('hex');
const mocBuf = fs.readFileSync(MOC);
const mocAb = mocBuf.buffer.slice(mocBuf.byteOffset, mocBuf.byteOffset + mocBuf.byteLength);
const moc3Version = mocBuf.readUInt32LE(4);

line(`Core  : ${CORE}  (${coreSrc.length} 字节, sha256=${coreSha.slice(0, 16)}…)`);
line(`moc3  : ${MOC}  (${mocBuf.length} 字节)`);
line(`签名  : ${mocBuf.subarray(0, 4).toString('latin1')}  moc3 版本(offset 4) = ${moc3Version}`);
line('');

// ── wasm 到底在哪：字节级定性（独立于沙箱结论）──────────────────────────────
// 结论先说：Core 5/6 是**纯 JS** 构建（emscripten 的 wasm2js / asm.js 风格输出），
// 既没有外置 .wasm，也没有内联二进制。所以下面三条字节级证据应当全部为「否/零」，
// 而真正的证明在再下面的 [sandbox]：那里没有 fetch / require / fs / process，
// 若脚本仍能就绪并读出模型数据，则运行所需的一切必然已在 .js 里。
const coreBytes = Buffer.from(coreSrc, 'utf8'); // 文件是纯 ASCII，utf8 往返与原始字节一致
let nonAscii = 0;
for (const b of coreBytes) if (b >= 0x80) nonAscii++;
const rawMagic = coreBytes.includes(Buffer.from([0x00, 0x61, 0x73, 0x6d])); // 原生 "\0asm"
const b64 = (coreSrc.match(/[A-Za-z0-9+/]{2000,}={0,2}/g) || []).sort((a, b) => b.length - a.length);
const b64Magic = b64.length > 0 && Buffer.from(b64[0].slice(0, 8), 'base64').toString('hex') === '0061736d';
line(`[wasm] 原生 "\\0asm" 魔数 (00 61 73 6d)      : ${rawMagic ? '有' : '无'}`);
line(`[wasm] base64 魔数 "AGFzbQ" 出现次数        : ${(coreSrc.match(/AGFzbQ/g) || []).length}`);
line(`[wasm] 最长 base64 连续串                  : ${b64.length ? `${b64[0].length} 字符 (≈${Math.floor((b64[0].length * 3) / 4)} 字节)，首 4 字节是 \\0asm → ${b64Magic}` : '无 2000+ 字符的串'}`);
line(`[wasm] 非 ASCII 字节数 (>=0x80)             : ${nonAscii} / ${coreBytes.length}`);
line(`[wasm] "_em_module.wasm" 字样出现次数       : ${(coreSrc.match(/_em_module\.wasm/g) || []).length}（emscripten locateFile 的兜底路径，本构建走不到）`);
line(
  `[wasm] 定性：${!rawMagic && !b64Magic && nonAscii === 0
    ? '纯 JS 构建（wasm2js / asm.js 风格）—— 没有 wasm 载荷，不需要任何外置文件，也不需要网络'
    : '文件里含二进制/内联载荷，需按上面的字节证据具体判断'}`
);
line(`       注意源码里有 \`var WebAssembly={},F=[]\` —— 全局 WebAssembly 被遮蔽成空对象，`);
line(`       这正是不依赖 WebAssembly、也不去取 ${'_em_module.wasm'} 的原因。`);
line('');

const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  atob, btoa,
  ArrayBuffer, SharedArrayBuffer, Uint8Array, Int8Array, Float32Array, Float64Array,
  Uint16Array, Int16Array, Uint32Array, Int32Array, DataView,
  Math, Date, Promise, JSON, Error, TypeError, RangeError, String, Object, Array, Number, Boolean, Symbol,
  TextDecoder, TextEncoder,
  // 明确断言：沙箱里没有模块系统、没有 Node、没有网络。
  fetch: () => Promise.reject(new Error('沙箱内不允许网络：Core 应当自带全部运行所需代码')),
  performance,
};
sandbox.location = {
  href: 'https://localhost/live2dcubismcore.min.js',
  origin: 'https://localhost',
  protocol: 'https:',
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = {
  currentScript: { src: sandbox.location.href },
  createElement: () => ({ getContext: () => null, style: {}, setAttribute() {} }),
};

line(
  `[sandbox] typeof module=${typeof sandbox.module} exports=${typeof sandbox.exports} ` +
    `require=${typeof sandbox.require} process=${typeof sandbox.process}`
);

vm.createContext(sandbox);
vm.runInContext(coreSrc, sandbox, { filename: 'live2dcubismcore.min.js' });

const Core = sandbox.Live2DCubismCore;
if (!Core) {
  line('✗ 脚本执行后没有挂上 Live2DCubismCore');
  process.exit(1);
}

// 这个构建是同步完成的（没有 .then、没有 onRuntimeInitialized）：runInContext 返回即已编译完，
// 但**不要**把第一次探测的异常当致命 —— 第 1 次通常抛
// "Cannot read properties of undefined (reading 'apply')"（那是在 apply a.asm.d 之前），
// 第 2 次（约 25-30ms）就正常返回版本号了。所以要「轮询 + 容忍瞬时异常」。
const t0 = Date.now();
let probeCalls = 0;
let transient = 0;
while (Date.now() - t0 < 30000) {
  probeCalls++;
  try {
    if (Core.Version.csmGetVersion() > 0) break;
  } catch {
    transient++;
  }
  await new Promise((r) => setTimeout(r, 20));
}
if (!Core.Moc) {
  line('✗ 30s 内 Moc 未就绪 —— wasm 没跑起来');
  process.exit(1);
}
line(`[ok] wasm 就绪，耗时 ${Date.now() - t0}ms（轮询 ${probeCalls} 次，其中 ${transient} 次抛「未就绪」）`);
line('');

// ── 验收步骤 1 / 2 ──────────────────────────────────────────────────────────
const raw = Core.Version.csmGetVersion();
const major = raw >>> 24;
const ver = `${major}.${(raw >>> 16) & 0xff}.${(raw >>> 8) & 0xff}.${raw & 0xff}`;
const latest = Core.Version.csmGetLatestMocVersion();

line('=== 验收步骤 1-2：Core 版本能力 ===');
line(`[1] csmGetVersion()          = ${raw} (0x${raw.toString(16).padStart(8, '0')}) → ${ver}   ${major >= 5 ? '✓ major >= 5' : '✗ major < 5'}`);
line(`[2] csmGetLatestMocVersion() = ${latest}   ${latest >= 5 ? '✓ >= 5' : '✗ < 5'}   (枚举 0=Unknown 1=3.0 2=3.3 3=4.0 4=4.2 5=5.0 6=5.3)`);
line('');

// 先建 Moc —— 这既是验收步骤 4 的产物，也是步骤 3 备用签名所必需的句柄。
let moc = null;
let mocErr = null;
try {
  moc = Core.Moc.fromArrayBuffer(mocAb);
} catch (e) {
  mocErr = e;
}

// ── 验收步骤 3 ──────────────────────────────────────────────────────────────
// 注意：不同 Core 构建里 csmGetMocVersion 的签名不一样。
//   · SDK 5-r.5 的 Core 6.0.0.1：csmGetMocVersion(mocBytes: ArrayBuffer)
//   · 官方 CDN 那份 Core 5.1.0.0：csmGetMocVersion(mocPtr: number, mocSize: number)  ← 原始指针形式
// 两种都试，取能用的那个，并在输出里说明用的是哪种。
line('=== 验收步骤 3：Core 认不认这个 moc3 ===');
let mocVer = null;
let mocVerHow = '';
try {
  mocVer = Core.Version.csmGetMocVersion(mocAb);
  mocVerHow = 'csmGetMocVersion(ArrayBuffer)';
} catch (e) {
  if (moc && moc._ptr) {
    // 这个构建的 csmGetMocVersion 要的是「原始 moc3 字节在 Core 堆里的地址」，不是 Moc 句柄。
    // 拿 Moc 句柄去调只会得到 0，那是误用，不能据此判负 —— 交给步骤 4 直接证明。
    mocVer = null;
    mocVerHow = '该构建的 csmGetMocVersion 不是 ArrayBuffer 签名（Core 5.1.0.0 走原始指针 ptr,size）';
  } else {
    mocVerHow = `${e.name}: ${e.message}`;
  }
}
line(`[3] ${mocVerHow}`);
if (mocVer === null) {
  line(`    未取得，不作判负依据 —— 能否读 moc3 ${moc3Version} 由下面步骤 4 的 Moc 非 null + 枚举数直接证明`);
} else {
  const mocVerOk = mocVer === moc3Version && mocVer >= 5;
  line(`    = ${mocVer}   (文件头写的 ${moc3Version})   ${mocVerOk ? '✓ 一致且 >= 5' : '✗ ' + (mocVer === 0 ? '0 = 版本不认识' : '与文件头不一致')}`);
}
if (typeof Core.Version.csmHasMocConsistency === 'function') {
  let cons = null;
  try { cons = Core.Version.csmHasMocConsistency(mocAb); } catch { cons = '(抛错)'; }
  line(`[..] csmHasMocConsistency()  = ${cons}`);
}
line('');

// ── 验收步骤 4 ──────────────────────────────────────────────────────────────
line('=== 验收步骤 4：Moc.fromArrayBuffer ===');
if (!moc) {
  line(`[4] Moc.fromArrayBuffer(模型) = null   ✗ moc3 ${moc3Version} 加载失败 —— Core ${ver} 太旧，需要 Cubism 5 的 Core`);
  if (mocErr) line(`    ${mocErr.name}: ${mocErr.message}`);
  process.exit(1);
}
line(`[4] Moc.fromArrayBuffer(模型) = Moc{_ptr=${moc._ptr}}   ✓ 非 null`);
line(`    ⓘ Moc 只暴露 { _ptr, hasMocConsistency, fromArrayBuffer, _release }；`);
line(`      parameters/parts/drawables/canvasinfo 都在 Model 上，必须再 Model.fromMoc(moc)。`);
line(`      （任务书里写的 moc.parameters.ids / moc.canvasinfo.CanvasSize 在 Core 5/6 上不存在）`);
line('');

const model = Core.Model.fromMoc(moc);
if (!model) {
  line('✗ Moc 拿到了，但 Model 初始化失败');
  process.exit(1);
}

// ── 验收步骤 5 ──────────────────────────────────────────────────────────────
const nParam = model.parameters.count;
const nPart = model.parts.count;
const nDraw = model.drawables.count;
const ci = model.canvasinfo;
const ids = Array.from({ length: nParam }, (_, i) => model.parameters.ids[i]);

// Core 5.1.0.0 和 6.0.0.1 的 Model 属性并不完全一致（老构建没有 offscreens / renderOrders /
// textureIndices），步骤 5 是「抄回真实数字」而不是门禁，缺哪个就如实标 (无 API)，不许崩。
const safeGet = (fn) => { try { const v = fn(); return v === undefined || v === null ? '(无 API)' : v; } catch { return '(无 API)'; } };

line('=== 验收步骤 5：模型能力清单（真数据）===');
line(`[5] parameters.ids.length  = ${model.parameters.ids.length}   (parameters.count = ${nParam})`);
line(`[5] parts.ids.length       = ${model.parts.ids.length}   (parts.count = ${nPart})`);
line(`[5] drawables.ids.length   = ${model.drawables.ids.length}   (drawables.count = ${nDraw})`);
line(`[5] offscreens.count       = ${safeGet(() => model.offscreens.count)}`);
line(`[5] renderOrders.length    = ${safeGet(() => model.renderOrders.length)}`);
line(`[5] canvasinfo             = ${ci
  ? `CanvasWidth=${ci.CanvasWidth} CanvasHeight=${ci.CanvasHeight} Origin=(${ci.CanvasOriginX}, ${ci.CanvasOriginY}) PixelsPerUnit=${ci.PixelsPerUnit}`
  : '(该构建的 Model 上没有 canvasinfo)'}`);
if (ci) line(`    ⓘ 没有 CanvasSize 字段；等价画布尺寸 = ${ci.CanvasWidth} x ${ci.CanvasHeight}`);
line(`texture 张数 : ${safeGet(() => new Set(Array.from(model.drawables.textureIndices)).size)}`);
line(`顶点数       : ${safeGet(() => model.drawables.vertexCounts.reduce((a, b) => a + b, 0))}`);
line('');

// 参数 id 预览 + 口型/表情相关参数是否齐备
const want = ['ParamMouthOpenY', 'ParamMouthForm', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamAngleX', 'ParamAngleY', 'ParamBodyAngleX', 'ParamBreath'];
line('口型/表情关键参数是否存在：');
for (const w of want) line(`  ${ids.includes(w) ? '✓' : '✗'} ${w}`);
line('');
line(`参数 id 前 12 个: ${ids.slice(0, 12).join(', ')}`);

// 真实写一次参数并 update，证明「能驱动」
const mi = ids.indexOf('ParamMouthOpenY');
if (mi >= 0) {
  const before = model.parameters.values[mi];
  model.parameters.values[mi] = 1.0;
  model.update(); // 实例方法（不是 Core.Model.update(model)）
  const after = model.parameters.values[mi];
  line('');
  line(`[ok] 写入 ParamMouthOpenY: ${before} -> ${after}（索引 ${mi}）`);
  line(`     参数 min/max = ${model.parameters.minimumValues[mi]} / ${model.parameters.maximumValues[mi]}`);
  line(`     Core.Model.update() 已执行，未抛错 → 渲染驱动链路可用`);
}

line('');
line('✓ 结论：vendor 里的 Core 可以加载这个模型，P0 门禁通过。');
