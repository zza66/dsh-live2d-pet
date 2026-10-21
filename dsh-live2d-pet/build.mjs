#!/usr/bin/env node
/**
 * 把 `src/client/*.ts` 打成 `lib/client.js`（DSH 的 client plugin bundle）。
 *
 * 为什么必须打包、而不是像 `dsh-pet-live2d` 那样手写一个自包含 IIFE：
 * 我们要用**官方 Cubism SDK for Web 5-r.5 的 Framework**（`framework/src`）
 * 做真正的 WebGL 渲染——59 个 TS 文件、上百个相对 import，手写维护不现实。
 * esbuild 只做转译不做类型检查，正好；类型错了由运行时实测负责。
 *
 * 产物形状是 DSH 的既有约定（从已装插件实证，不是猜的）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => ({ name, inject, apply }) })
 *
 * 三条硬约束写在 options 里，改动前请先读注释：
 *   1. `format: 'iife'` —— bundle 是**经典脚本**，不是 ESM。DSH 的模块表只为
 *      react / react-dom/client 播种，没有 import map，ESM 产物会直接抛错。
 *   2. 不 `minify` —— 这个 bundle 在调试期要能在浏览器 Sources 里读。发布版
 *      再打开；现在省下的 200 KB 换不来任何东西。
 *   3. Core 用 **banner 前置执行**、shader 用**虚拟模块内联**。两者形态不同是有
 *      硬理由的，见下面的 `coreBanner` 与 `virtualModules`。
 *
 * 用法：
 *   node build.mjs            单次构建
 *   node build.mjs --watch    监听重建（配合页面刷新）
 *
 * 每次都会产出**多份**：`lib/client.js`（DSH 的客户端 bundle）与
 * `lib/test/*.mjs`（给 Node 里的门禁用的 ESM 版本，见文件末尾的 `buildTest()`）。
 */

import { build, context } from 'esbuild';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/**
 * 构建号。
 *
 * 它会注入客户端半区，再由客户端在每次 `/status` 心跳里回传给 Host——于是
 * 「浏览器到底有没有换上刚构建的 client.js」变成一个可查询的事实（`/status`
 * 的 `clientBuild` 字段），不需要让用户开 DevTools 看。
 */
const buildId = process.env.LIVE2D_BUILD_ID ?? String(Date.now());

const CORE_PATH = resolve(here, 'vendor/cubism/live2dcubismcore.min.js');
const SHADER_DIR = resolve(here, 'shaders');

/**
 * ★ Cubism Core 必须**先于**所有 Framework 代码执行，所以它走 banner（前置注入），
 *   而不是被某个模块 `import` 进来。
 *
 * 这是一个真实踩过的坑，也是本插件唯一能把用户整个应用弄挂的地方：
 * Framework 的 `model/cubismmodel.ts` 里有 `export enum CubismColorBlend { … }`，
 * 而枚举成员的初始值是 `Live2DCubismCore.ColorBlendType_Normal` 之类 —— **枚举在模块
 * 求值时就展开**，于是「Framework 被求值」这件事本身就要求 `Live2DCubismCore` 已经
 * 存在。原来把 Core 放在 React 副作用里用 blob `<script>` 懒加载，结果是 bundle 一
 * 求值就抛 `Live2DCubismCore is not defined`；脚本抛错 → 没走到
 * `__ModuleLoader__.load()` → DSH 外壳的启动审计认为这个 client entry 加载失败 →
 * **应用起不来（白屏，且不留日志）**。
 *
 * 改用 banner 还有两个附带好处：Core 的异步初始化（emscripten wasm→JS，约 20–30ms）
 * 从「组件挂载时」提前到「页面加载时」，等于白赚一段预热时间；而且整段代码仍在
 * **经典脚本顶层**，`var Live2DCubismCore` 天然落到全局。
 *
 * 末尾那句显式赋值是防御性的：万一将来外壳把 bundle 包进函数里执行，顶层 `var`
 * 就只活在函数作用域里，而 IIFE 里的闭包仍能读到它，于是我们主动搬到 `globalThis`。
 */
const coreSource = readFileSync(CORE_PATH, 'utf8');
if (!/Live2DCubismCore\s*=/.test(coreSource)) {
  throw new Error(`[build] ${CORE_PATH} 里找不到 Live2DCubismCore 赋值，Core 可能换了打包方式`);
}
const coreBanner = [
  `/* Live2D Cubism Core ${coreSource.length} 字节，由 build.mjs 内联（官方 RedistributableFiles.txt 允许分发）。`,
  '   必须在任何 Framework 代码之前执行：Framework 的顶层 enum 会读 Live2DCubismCore.*。 */',
  coreSource,
  ';(function () {',
  '  try {',
  '    if (typeof Live2DCubismCore !== "undefined") globalThis.Live2DCubismCore = Live2DCubismCore;',
  '  } catch (error) {',
  '    /* 环境不允许写 globalThis 也不能让加载失败 —— 后面的就绪探测会报出真正的原因。 */',
  '  }',
  '})();',
].join('\n');

/**
 * ★ 最后一道保险：把整个 bundle 包进 `try { … } catch`。
 *
 * 上面那条注释讲的是**已知**的求值顺序问题。但同类问题还会再来：任何被 import
 * 进来的模块，只要在顶层碰了浏览器不认的东西，整个 bundle 就会在求值期抛错，
 * 而这**发生在我们任何 try/catch 生效之前** —— `src/client/index.ts` 里的兜底只包得住
 * 工厂函数，包不住模块求值。
 *
 * 所以 banner 用一个未闭合的 `try {`，footer 用 `} catch` 收口。这样无论哪里抛，
 * 脚本本身都不再抛异常，而且**在 catch 里补登一个合法但什么都不做的插件** ——
 * 保证 `__ModuleLoader__.load()` 一定被调用过。桌宠宁可自己不出现，也不能让用户的
 * 应用起不来。
 *
 * 注意：这条保险会让 simulate-client-boot.mjs 里的「顶层不抛」变得恒真，所以那个
 * 自检**另外**断言了「注册的是真插件（inject 含 slots）而不是兜底插件」，别把那条删掉。
 */
const fatalBanner = 'try {';
const fatalFooter = [
  '} catch (__live2dFatal) {',
  '  /* 走到这里说明 bundle 在求值期就抛了。绝不 rethrow。 */',
  '  try {',
  '    var __live2dReport = (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function")',
  '      ? function (text) { try { navigator.sendBeacon("/.dsh-live2d-pet/client-error", text); } catch (e) {} }',
  '      : function () {};',
  '    __live2dReport("fatal-at-eval: " + ((__live2dFatal && __live2dFatal.message) || String(__live2dFatal)));',
  '    if (typeof window !== "undefined" && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === "function") {',
  '      window.__ModuleLoader__.load({',
  '        id: "dsh-live2d-pet",',
  '        factory: function () {',
  '          return { name: "dsh-live2d-pet", inject: [], apply: function () {} };',
  '        },',
  '      });',
  '    }',
  '  } catch (error) {',
  '    /* 连兜底都失败就只能沉默了 —— 至少脚本本身没有抛。 */',
  '  }',
  '}',
  '',
].join('\n');

/** 读 shaders/ 下全部文件，产出 { 文件名: 源码 }。Framework 按文件名找它们。 */
function readShaders() {
  const out = {};
  for (const name of readdirSync(SHADER_DIR).sort()) {
    out[name] = readFileSync(resolve(SHADER_DIR, name), 'utf8');
  }
  return out;
}

/**
 * 虚拟模块：13 个 shader 的源码。
 *
 * 刻意用「生成一个 JS 源文件」而不是 esbuild 的 `loader: { '.js': 'text' }`：
 * 后者会把内容当**默认导出**，而我们要的是既能在 TS 里具名 import、又能在源码里
 * 保留原始的换行与转义。写成 `export const … = <JSON 字面量>` 最省事。
 *
 * shader 走 import 是安全的：`CubismShader_WebGL` 只在真的要画的时候才读它们，
 * 而那时组件早就挂载完了 —— 与上面 Core 的「求值期就必须存在」完全不同。
 */
const virtualModules = {
  name: 'live2d-virtual-assets',
  setup(builder) {
    builder.onResolve({ filter: /^virtual:live2d-shaders$/ }, (args) => ({
      path: args.path,
      namespace: 'live2d-virtual',
    }));

    builder.onLoad({ filter: /.*/, namespace: 'live2d-virtual' }, () => {
      const shaders = readShaders();
      const keys = Object.keys(shaders);
      return {
        loader: 'js',
        contents:
          `// 由 build.mjs 内联：shaders/ 下 ${keys.length} 个文件\n`
          + `export const SHADER_NAMES = ${JSON.stringify(keys)};\n`
          + `export const SHADER_SOURCES = ${JSON.stringify(shaders)};\n`,
      };
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(here, 'src/client/index.ts')],
  outfile: resolve(here, 'lib/client.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  charset: 'utf8',
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  plugins: [virtualModules],
  banner: { js: `${coreBanner}\n${fatalBanner}` },
  footer: { js: fatalFooter },
  define: {
    __LIVE2D_BUILD_ID__: JSON.stringify(buildId),
  },
};

function report(ms) {
  const { size } = statSync(resolve(here, 'lib/client.js'));
  const kb = (size / 1024).toFixed(1);
  console.log(`[build] lib/client.js  ${kb} KB  build=${buildId}  ${ms}ms`);
}

/**
 * 测试用产物：把 `src/client/speech.ts` 单独打成一个 **ESM** 模块。
 *
 * 为什么值得多打一份：这个文件是 P0 #7 的核心逻辑（base64 → 解码 → 包络 → 每帧
 * 张开度），而在浏览器里它要靠 `AudioContext` 才能跑。Node 里没有 AudioContext，
 * 但**可以塞一个假的** —— 前提是这个模块能被 `import`。主产物是 IIFE 经典脚本、
 * 还会调 `__ModuleLoader__.load`，在 Node 里根本没法用。
 *
 * 于是「口型对不对」这件事从「只能靠用户在页面里肉眼看」变成「可以断言」。
 * 它不进 `lib/` 根目录，免得被 DSH 的插件扫描误认成入口。
 */
const testOptions = {
  entryPoints: [resolve(here, 'src/client/speech.ts')],
  outfile: resolve(here, 'lib/test/speech-player.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第二份测试产物：`lib/test/model-list.mjs`。
 *
 * 同一套理由，另一个受害者。模型清单的几个决策（坏包标 `✕`、切换被拦、
 * 默认选中跳过坏包）**在 `plugin.ts` 里无法被验证**：`simulate-client-boot.mjs`
 * 用的是桩 React —— `useState` 返回固定值、setter 是空函数、effect 从不执行，
 * 所以渲染永远停在「正在扫描模型库…」那一帧，下拉框根本没被建出来。
 * 把它们挤进 `src/client/model-list.ts`（不碰 DOM / React / fetch）之后，
 * 就能用真的断言覆盖，而不是靠「我在浏览器里点了一下，看着是对的」。
 */
const modelListOptions = {
  entryPoints: [resolve(here, 'src/client/model-list.ts')],
  outfile: resolve(here, 'lib/test/model-list.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第三份测试产物：口型增益与字幕的纯逻辑（`tools/test-pet-settings.mjs`）。
 *
 * 与上面两份同理 —— 「用户存的设置被理解成了什么」和「这一刻字幕该显示什么」
 * 全是能断言的判断题，只有把它们搬到 Node 够得着的地方，才会真的被断言。
 */
const petSettingsOptions = {
  entryPoints: [resolve(here, 'src/client/settings.ts')],
  outfile: resolve(here, 'lib/test/pet-settings.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 指令执行层（`tools/test-action-runner.mjs`）。
 *
 * 与上面三份同理：`runAction()` 的分派是纯逻辑，但它的调用方是 React effect 里的
 * 轮询 —— 留在那里就只能靠肉眼看。搬到 Node 里配一个**假 target**，才能把
 * 「哪条指令调了哪个方法」「过期该不该跳过」「不认得的 kind 有没有如实说」全部钉住。
 */
const actionRunnerOptions = {
  entryPoints: [resolve(here, 'src/client/action-runner.ts')],
  outfile: resolve(here, 'lib/test/action-runner.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 朗读通道（`tools/test-speech-lane.mjs`）。
 *
 * 与上面几份同理：串行朗读的逻辑是纯逻辑，但它的调用方是 React effect 里的
 * 轮询 —— 留在那里就只能靠耳朵听。搬到 Node 里配一个**能手动控制「这一句播完
 * 了」时机的假 player**，才能把「两句不重叠」「叫停之后旧句子作废」「`speak`
 * 抛错不停摆」「看门狗会放行」全部钉住。
 */
const speechLaneOptions = {
  entryPoints: [resolve(here, 'src/client/speech-lane.ts')],
  outfile: resolve(here, 'lib/test/speech-lane.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第六份测试产物：视线时间线（`tools/test-look-tween.mjs`）。
 *
 * 为什么它值得单独产一份：`TimedLookTarget`（真正的适配层，继承框架的
 * `CubismTargetPoint`）需要 WebGL 才能构造，只能靠肉眼在画面上看；而它做的事
 * 全是算术 —— 时长、缓动、中途改目标、脏值归一。算术搬到 `look-tween.ts`
 * 就能在没有画布的 Node 里逐条断言。
 */
const lookTweenOptions = {
  entryPoints: [resolve(here, 'src/client/look-tween.ts')],
  outfile: resolve(here, 'lib/test/look-tween.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第七份测试产物：渲染帧预算（`tools/test-frame-budget.mjs`）。
 *
 * 为什么它值得单独产一份：帧率上限的判据活在 `frame()` 里，而 `frame()` 只在
 * 真的 `requestAnimationFrame` 驱动下才跑 —— 在 Node 里没法断言，在浏览器里
 * 也只能靠肉眼估一个数字。把它抽成「时间从参数进来」的纯函数之后，
 * 就能用一条假时间轴把一秒推一遍、**数出到底画了几帧**。
 *
 * 这件事必须能断言，因为「上限没生效」和「上限生效了但把 60 变成了 30」
 * 在画面上都只是「帧率不太对」，说不清是哪一个。第十个缺陷就是前者。
 */
const frameBudgetOptions = {
  entryPoints: [resolve(here, 'src/client/frame-budget.ts')],
  outfile: resolve(here, 'lib/test/frame-budget.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第八份测试产物：缩略图（`tools/test-thumbnail.mjs`）。
 *
 * 为什么它值得单独产一份：缩略图这条链上真正会出错的地方全是**算术与防御**，
 * 而它们两头都够不着 —— 包围盒算错只表现为「图裁歪了一点」（肉眼很难说清
 * 是裁歪还是模型本来就那样）；`parseStored()` 少一个判空则表现为
 * 「面板偶尔白屏一下」（§9.2 那次事故的形状，而且复现不了）。
 *
 * 抽成零 DOM、零 canvas、零 localStorage、零 `Date.now()` 的纯模块之后，
 * 这两类都能在 Node 里逐条钉死：给一片手工造的 alpha 数组要包围盒，
 * 给一堆坏 JSON 要 `null`。
 */
const thumbnailOptions = {
  entryPoints: [resolve(here, 'src/client/thumbnail.ts')],
  outfile: resolve(here, 'lib/test/thumbnail.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第九份测试产物：渲染舞台的存在性（`tools/test-stage-presence.mjs`）。
 *
 * 为什么它值得单独产一份：这件事**只能在 Node 里断言**。它要回答的问题是
 * 「面板收起时那五道护栏还在不在」，而在浏览器里那个问题的两种答案长得
 * 完全一样 —— 都是「控制台安静、画面正常」。只有把「登记 → 拼查询串 →
 * 注销」这条链搬到 Node 里，才能钉住「注销之后查询串必须变成 `stage=0`」
 * 这种一眼看不出对错的约定（一个 `return` 忘了改，症状是 Host 永远以为
 * 有人在守着，那正是这次要修的失明）。
 *
 * 模块本身零 DOM / 零 React / 零 `Date.now()`，所以不需要假环境。
 */
const stagePresenceOptions = {
  entryPoints: [resolve(here, 'src/client/stage-presence.ts')],
  outfile: resolve(here, 'lib/test/stage-presence.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第十份测试产物：上报通道的账本（`tools/test-report.mjs`）。
 *
 * 为什么它必须能在 Node 里跑：这条通道**从来没有成功送回过任何一条消息**，
 * 而它在浏览器里失败的样子与「一个错误都没发生」完全一样 —— 都是安静。
 * 唯一的分别藏在 `reportFailure()` 内部那几个计数器里，而计数器只有
 * 在能注入假 `fetch` / 假 `navigator` 的地方才看得见。
 *
 * 模块只在函数体内碰 `fetch` / `navigator` / `Blob`（不是模块级），
 * 所以门禁可以先把它们替换掉，再调 `reportFailure()` 看账本怎么变。
 */
const reportOptions = {
  entryPoints: [resolve(here, 'src/client/report.ts')],
  outfile: resolve(here, 'lib/test/report.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 部件透明度曲线（`Target: "PartOpacity"`）的解析与求值。
 *
 * 这个模块是纯计算、不碰任何 Framework 全局，所以门禁可以直接对着它跑：
 * 既用合成曲线测四种段的求值，也拿 `models-inbox` 里的**真动作文件**跑一遍
 * （hiyori 的 10 段动作各自带 `PartArmA` / `PartArmB` 两条常量曲线）。
 */
const partCurvesOptions = {
  entryPoints: [resolve(here, 'src/client/part-curves.ts')],
  outfile: resolve(here, 'lib/test/part-curves.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第十二份测试产物：朗读账本与那条查询串（`tools/test-reverse-channel.mjs`）。
 *
 * 为什么必须有这一份（而不是满足于源码级断言）：这条链的两半是**两个人各写
 * 一半**的 —— 渲染端拼出 `&speech=1&speechState=…&speechQueued=…`，Host 用
 * `parseSpeechQuery()` 读回来。两半在各自的源码里都「看着对」，而它们之间的
 * 那个字符串从来没有被真的搬过一次：字段名改一个字母、`encodeURIComponent`
 * 加错位置、`current === null` 那条分支写反，症状全都是「AI 偶尔抢话」——
 * 一个不会被任何告警抓到、只会被当成性格问题的症状。
 *
 * 所以这一份产物要做的事只有一件：让「拼出来的串」真的交给「读它的函数」。
 * 本轮之前 `speechQuerySuffix()` 一次都没有被执行过（§10 第 2 条）。
 */
const speechPresenceOptions = {
  entryPoints: [resolve(here, 'src/client/speech-presence.ts')],
  outfile: resolve(here, 'lib/test/speech-presence.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第十三份测试产物：窗口形态的纯逻辑（`tools/test-window-mode.mjs`）。
 *
 * 这一层全是「算术 + 容错」，而它们错起来**不会有任何报错**：
 * 夹边少一条，窗口被拖出屏幕之后就再也拖不回来（而且位置是持久化的，
 * 刷新页面回来还在屏幕外）；`parseWindowState()` 少一个兜底，
 * 一条手改坏的 `localStorage` 就能让整张卡片白屏。两种症状都不像 bug，
 * 像「这插件抽风了」。
 *
 * 所以这份产物存在的理由与 speech-presence 那份一样：让门禁跑**真代码**。
 */
const windowModeOptions = {
  entryPoints: [resolve(here, 'src/client/window-mode.ts')],
  outfile: resolve(here, 'lib/test/window-mode.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第十四份测试产物：舞台视图的纯逻辑（`tools/test-stage-view.mjs`）。
 *
 * 这一层的每一条错法都不会报错，只会让模型「不见了」：夹取漏掉缩放上限，
 * 滚轮一路滚下去模型变成一个像素；平移不留上限，用力一拖就扔到舞台外面
 * —— 而舞台是 `overflow: hidden`，拖出去的东西**看不见也点不到**；
 * 持久化不夹取，`localStorage` 里留着一个「缩放 0.01」，刷新回来模型就没了。
 */
const stageViewOptions = {
  entryPoints: [resolve(here, 'src/client/stage-view.ts')],
  outfile: resolve(here, 'lib/test/stage-view.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第十五份测试产物：思考时「收着点」的纯逻辑（`tools/test-motion-calm.mjs`）。
 *
 * 为什么它必须能在 Node 里跑：这条改动**唯一的证据是「看起来安静了一些」**。
 * 包络没起来、包络起太快、`calm=0` 时系数不是恰好 1、收幅收错对象（把 AI 点名的
 * 动作也打了折）—— 这四种错在画面上全都只是「好像有点不一样」，谁都说不清。
 * 算术搬到 `motion-calm.ts` 就能按帧对账：480 ms 淡入、1100 ms 放开、
 * 系数曲线、以及「只对待机档生效」这条边界。
 */
const motionCalmOptions = {
  entryPoints: [resolve(here, 'src/client/motion-calm.ts')],
  outfile: resolve(here, 'lib/test/motion-calm.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第十六份测试产物：待机小动作的纯逻辑（`tools/test-idle-garnish.mjs`）。
 *
 * 这一层的证据同样只有「看起来活泼了一点」。包络起不来、幅度收不住、手势表里
 * 少了一个部位、`look_at` 生效期间还自己乱瞥 —— 四种错在画面上都只是「好像有点
 * 不一样」。手势表、包络、挑选规则搬到 `idle-garnish.ts` 就能逐帧对账。
 */
const idleGarnishOptions = {
  entryPoints: [resolve(here, 'src/client/idle-garnish.ts')],
  outfile: resolve(here, 'lib/test/idle-garnish.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第十七份测试产物：声音功能的可见范围（`tools/test-voice-packs.mjs` 的 [10] 段）。
 *
 * 这一层没有画面证据、也没有网络证据 —— 它的错误长这样：开关说「只留权重包」，
 * 但一个只有参考音的包仍在列表里；或者正在生效的零样本包被一起隐藏，用户再也
 * 关不掉它，只能去改 settings.json。把「该显示哪些」搬成纯函数就能逐条对账。
 */
const voiceScopeOptions = {
  entryPoints: [resolve(here, 'src/client/voice-scope.ts')],
  outfile: resolve(here, 'lib/test/voice-scope.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

/**
 * 第十八份测试产物：微动作的排期与挑选（`tools/test-micro-motions.mjs`）。
 *
 * 这一层与待机小动作同病：证据只有「看起来会自己动了」。而它比手写那七条多两个
 * 错法 —— 说话档与待机档挑错包、以及「忙碌时还在叠参数」（那会与正经动作打架，
 * 表现为幅度翻倍）。排期、挑法、busy 闸门放进纯函数就能逐帧对账。
 */
const microMotionOptions = {
  entryPoints: [resolve(here, 'src/client/micro-motion.ts')],
  outfile: resolve(here, 'lib/test/micro-motion.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  charset: 'utf8',
  minify: false,
  logLevel: 'warning',
};

async function buildTest() {
  await build(testOptions);
  await build(modelListOptions);
  await build(petSettingsOptions);
  await build(actionRunnerOptions);
  await build(speechLaneOptions);
  await build(lookTweenOptions);
  await build(frameBudgetOptions);
  await build(thumbnailOptions);
  await build(stagePresenceOptions);
  await build(reportOptions);
  await build(partCurvesOptions);
  await build(speechPresenceOptions);
  await build(windowModeOptions);
  await build(stageViewOptions);
  await build(motionCalmOptions);
  await build(idleGarnishOptions);
  await build(voiceScopeOptions);
  await build(microMotionOptions);
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await buildTest();
  console.log(`[build] watching src/client/**  build=${buildId}`);
} else {
  const started = Date.now();
  await build(options);
  await buildTest();
  report(Date.now() - started);
}
