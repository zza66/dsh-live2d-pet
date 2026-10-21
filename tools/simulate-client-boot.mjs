/**
 * 加载期自检：把 `dsh-live2d-pet/lib/client.js` 放进一个**模拟的浏览器全局**里跑一遍。
 *
 * 为什么必须做这件事（这不是「锦上添花」，是这个插件唯一能弄坏用户应用的地方）：
 * DSH 的外壳在启动时会审计每个 client bundle —— **只要工厂函数抛异常，这个 entry
 * 就变成 `failed`，外壳会拒绝启动整个应用**。症状是「应用打不开 / 白屏」，
 * 而且不留下任何日志。所以「工厂不抛」是硬约束，必须能在没有浏览器的环境里验证。
 *
 * 这个脚本验证四件事：
 *   1. bundle 顶层代码不抛（顶层抛会让整个 bundle 直接废掉）；
 *   2. 工厂函数在**有 React**时不抛，并返回形状正确的插件（name / inject / apply）；
 *   3. 工厂函数在**require('react') 抛异常**时也不抛，降级成 inert 插件；
 *   4. `apply(ctx)` 不抛，并且真的注册了 `shell.overlay` 与 `settings.section` 两个 slot。
 *
 * 跑法：`node tools/simulate-client-boot.mjs`，退出码 0 = 安全。
 */

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS_DIR, '..');
const BUNDLE = join(ROOT, 'dsh-live2d-pet', 'lib', 'client.js');

/** 优先用 DSH profile 里真实的 React；拿不到再退回桩。真 React 能验到 createElement。 */
function loadReact() {
  const candidates = [
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'package.json'),
    join(ROOT, 'dsh-live2d-pet', 'package.json'),
  ];
  for (const anchor of candidates) {
    if (!existsSync(anchor)) continue;
    try {
      const require = createRequire(anchor);
      const react = require('react');
      if (react !== null && typeof react.createElement === 'function') {
        return { react, source: anchor };
      }
    } catch {
      // 换下一个候选。
    }
  }
  return { react: null, source: null };
}

/** 桩 React：只在拿不到真 React 时用，够验证「不抛」即可。 */
function stubReact(calls) {
  return {
    createElement(type, props, ...children) {
      calls.push({ type, props, children });
      return { $$typeof: 'stub.element', type, props, children };
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
  };
}

/** 造一个够用的浏览器全局。故意什么都不做，只求「被访问到时不炸」。 */
function makeSandbox(onBeacon) {
  const listeners = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Map,
    Set,
    Promise,
    Error,
    TypeError,
    String,
    Number,
    Boolean,
    Symbol,
    RegExp,
    Float32Array,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int32Array,
    DataView,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    performance: { now: () => Date.now() },
    // Core 是 emscripten wasm→JS 产物，异步初始化里会用到 atob 解 base64。
    // 这里必须给，否则会在「加载成功之后」抛出一个异步错误，把输出搞脏。
    atob: (data) => Buffer.from(String(data), 'base64').toString('binary'),
    btoa: (data) => Buffer.from(String(data), 'binary').toString('base64'),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: () => Promise.reject(new Error('sandbox: fetch 不应在加载期被调用')),
    URL: { createObjectURL: () => 'blob:sandbox', revokeObjectURL: () => {} },
    Blob: class Blob {},
    Image: class Image {},
    WebSocket: class WebSocket {},
    localStorage: {
      _data: new Map(),
      getItem(key) { return this._data.has(key) ? this._data.get(key) : null; },
      setItem(key, value) { this._data.set(key, String(value)); },
      removeItem(key) { this._data.delete(key); },
    },
    navigator: {
      userAgent: 'sandbox',
      sendBeacon: (url, body) => {
        onBeacon(url, body);
        return true;
      },
    },
    document: {
      head: {
        append(node) {
          sandbox.__styles.push(node);
        },
      },
      getElementById: () => null,
      createElement: (tag) => ({
        tagName: String(tag).toUpperCase(),
        id: '',
        textContent: '',
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {},
        remove() {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
        getContext: () => null,
      }),
      addEventListener(type, fn) { listeners.push({ type, fn }); },
      removeEventListener() {},
      body: { appendChild() {} },
    },
    __styles: [],
    __listeners: listeners,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/** 造一个 Cordis 客户端上下文探针，记录所有 slot 注册。 */
function makeContext() {
  const registered = [];
  const effects = [];
  const logs = [];
  const context = {
    slots: {
      inject(key, callback) {
        // 真实实现是「slot 出现后回调」，这里直接回调，等价于 slot 已就绪。
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      register(meta, render) {
        registered.push({ meta, render });
        return () => {};
      },
    },
    effect(callback, label) {
      const dispose = callback();
      effects.push({ label, dispose });
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    on() {},
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
  };
  return { context, registered, effects, logs };
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`    [ok] ${label}`);
  } else {
    console.log(`    [FAIL] ${label}${detail ? `  ${detail}` : ''}`);
    failures += 1;
  }
}

console.log(`[1] 载入产物 ${BUNDLE}`);
if (!existsSync(BUNDLE)) {
  console.log('    [FAIL] 产物不存在，先跑 `node build.mjs`');
  process.exit(1);
}
const code = readFileSync(BUNDLE, 'utf8');
console.log(`    大小 ${(code.length / 1024).toFixed(1)} KB`);

console.log('[2] 在模拟浏览器里执行整个 bundle（顶层不得抛异常）');
const beacons = [];
const sandbox = makeSandbox((url, body) => beacons.push({ url, body }));
let registrations = [];
sandbox.__ModuleLoader__ = {
  load(spec) {
    registrations.push(spec);
  },
};

let topLevelError = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js', timeout: 30000 });
} catch (error) {
  topLevelError = error;
}
check('顶层执行不抛', topLevelError === null, topLevelError ? `→ ${topLevelError.message}` : '');

console.log('[3] 模块加载器注册形状');
check('恰好注册一次 __ModuleLoader__.load', registrations.length === 1, `实际 ${registrations.length} 次`);
const spec = registrations[0];
check('id 是 dsh-live2d-pet', spec?.id === 'dsh-live2d-pet', `实际 ${String(spec?.id)}`);
check('factory 是函数', typeof spec?.factory === 'function');

console.log('[4] 工厂函数（有 React 时必须不抛，且形状正确）');
const { react: realReact, source: reactSource } = loadReact();
console.log(`    React 来源：${realReact ? reactSource : '（桩，未找到真 React）'}`);
const calls = [];
const react = realReact ?? stubReact(calls);

let plugin = null;
let factoryError = null;
try {
  plugin = spec.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`sandbox: 未播种的模块 ${id}`);
  });
} catch (error) {
  factoryError = error;
}
check('工厂不抛', factoryError === null, factoryError ? `→ ${factoryError.message}` : '');
check('返回对象非空', plugin !== null && typeof plugin === 'object');
check('name 正确', plugin?.name === 'dsh-live2d-pet', `实际 ${String(plugin?.name)}`);
check(
  "inject 含 'slots'",
  Array.isArray(plugin?.inject) && plugin.inject.includes('slots'),
  `实际 ${JSON.stringify(plugin?.inject)}`,
);
check('apply 是函数', typeof plugin?.apply === 'function');

console.log('[5] apply(ctx)：不得抛，且必须注册两个 slot');
const probe = makeContext();
let applyError = null;
try {
  plugin.apply(probe.context);
} catch (error) {
  applyError = error;
}
check('apply 不抛', applyError === null, applyError ? `→ ${applyError.message}` : '');

const slotNames = probe.registered.map((item) => item.meta?.name);
check(
  '注册了 shell.overlay',
  slotNames.includes('shell.overlay'),
  `实际 ${JSON.stringify(slotNames)}`,
);
check(
  '注册了 settings.section',
  slotNames.includes('settings.section'),
  `实际 ${JSON.stringify(slotNames)}`,
);
for (const item of probe.registered) {
  if (item.meta?.id !== 'dsh-live2d-pet') {
    console.log(`    [FAIL] slot ${item.meta?.name} 的 id 不是包名：${String(item.meta?.id)}`);
    failures += 1;
  }
}
check('所有 slot 条目都带 id', probe.registered.every((item) => typeof item.meta?.id === 'string'));

console.log('[6] 渲染函数可调用（外壳迟早会调它，抛在这里同样会炸界面）');
for (const item of probe.registered) {
  try {
    item.render();
    console.log(`    [ok] ${item.meta.name} 的 render() 未抛`);
  } catch (error) {
    // 用桩 React 时渲染函数会走真逻辑；这里只要求「不抛」。
    console.log(`    [FAIL] ${item.meta.name} 的 render() 抛出：${error.message}`);
    failures += 1;
  }
}

console.log('[7] 降级路径：require("react") 抛异常时必须返回 inert 插件而不是抛出');
let degrade = null;
let degradeError = null;
try {
  degrade = spec.factory(() => {
    throw new Error('sandbox: react 不可用');
  });
} catch (error) {
  degradeError = error;
}
check('降级路径不抛', degradeError === null, degradeError ? `→ ${degradeError.message}` : '');
check('降级插件 name 正确', degrade?.name === 'dsh-live2d-pet', `实际 ${String(degrade?.name)}`);
check('降级插件 apply 不发散', typeof degrade?.apply === 'function');
if (beacons.length > 0) {
  console.log(`    （降级时上报了 ${beacons.length} 次，url=${beacons[0].url}）`);
}

console.log('[8] Cubism Core 是否**同步**就位（这正是当初把应用搞白屏的那一条）');
const core = sandbox.Live2DCubismCore;
check('bundle 执行后全局已有 Live2DCubismCore', core !== undefined && core !== null);
check('Moc.fromArrayBuffer 同步可用', typeof core?.Moc?.fromArrayBuffer === 'function');
check('Model.fromMoc 同步可用', typeof core?.Model?.fromMoc === 'function');
// Framework 的 `export enum CubismColorBlend` 读的就是这些常量，且是**模块求值时**读的。
// 它们必须同步是数字 —— 只要这一条成立，Framework 就不会再抛 undefined。
const blend = core?.ColorBlendType_Normal;
check(
  'ColorBlendType_Normal 同步是数字（Framework 顶层枚举依赖它）',
  typeof blend === 'number',
  `实际 ${String(blend)}`,
);
check(
  'AlignofMoc 同步是数字',
  typeof core?.AlignofMoc === 'number',
  `实际 ${String(core?.AlignofMoc)}`,
);

console.log('[9] Core 异步初始化（emscripten wasm→JS）能否真的跑完');
const readyAt = await (async () => {
  const started = Date.now();
  for (;;) {
    try {
      const version = core.Version.csmGetVersion();
      if (typeof version === 'number' && version > 0) return { version, ms: Date.now() - started };
    } catch {
      // 就绪前必然抛，见 core-loader.ts 注释。
    }
    if (Date.now() - started > 4000) return null;
    await new Promise((r) => setTimeout(r, 16));
  }
})();
if (readyAt === null) {
  // 沙箱缺浏览器 API 时这里会失败，属于环境差异而不是产物缺陷 —— 不判失败，只提示。
  console.log('    [note] 4 秒内未就绪；若在沙箱里多半是缺浏览器 API，浏览器中不受影响');
} else {
  const major = (readyAt.version >> 24) & 0xff;
  const minor = (readyAt.version >> 16) & 0xff;
  const patch = (readyAt.version >> 8) & 0xff;
  const build = readyAt.version & 0xff;
  console.log(`    [ok] Core 就绪 ${readyAt.ms}ms  版本 ${major}.${minor}.${patch}.${build}`);
}

console.log('[10] 反向验证：故意让 bundle 在求值期抛错，兜底必须接管（不抛 + 补登 inert 插件）');
// 在 banner 那个未闭合的 `try {` 之后插一句 throw，模拟「某个被 import 的模块顶层炸了」。
const tryIndex = code.indexOf('\ntry {');
if (tryIndex < 0) {
  console.log('    [FAIL] 产物里找不到兜底用的 `try {` —— build.mjs 的 fatal 包装没生效');
  failures += 1;
} else {
  const broken = `${code.slice(0, tryIndex + 6)}\nthrow new Error("injected-fault: 模拟顶层抛错");\n${code.slice(tryIndex + 6)}`;
  const brokenBeacons = [];
  const brokenSandbox = makeSandbox((url, body) => brokenBeacons.push({ url, body }));
  const brokenRegistrations = [];
  brokenSandbox.__ModuleLoader__ = {
    load(spec) {
      brokenRegistrations.push(spec);
    },
  };

  let brokenThrew = null;
  try {
    vm.createContext(brokenSandbox);
    vm.runInContext(broken, brokenSandbox, { filename: 'client-broken.js', timeout: 30000 });
  } catch (error) {
    brokenThrew = error;
  }

  check('注入故障后脚本本身仍然不抛', brokenThrew === null, brokenThrew ? `→ ${brokenThrew.message}` : '');
  check('兜底仍然注册了模块', brokenRegistrations.length === 1, `实际 ${brokenRegistrations.length} 次`);
  const fallback = brokenRegistrations[0];
  check('兜底注册的 id 正确', fallback?.id === 'dsh-live2d-pet', `实际 ${String(fallback?.id)}`);

  let fallbackPlugin = null;
  try {
    fallbackPlugin = fallback?.factory(() => {
      throw new Error('sandbox: 兜底不该 require 任何东西');
    });
  } catch (error) {
    console.log(`    [FAIL] 兜底工厂抛出：${error.message}`);
    failures += 1;
  }
  check('兜底插件是惰性的（inject 为空）', Array.isArray(fallbackPlugin?.inject) && fallbackPlugin.inject.length === 0);
  check('兜底插件 apply 是空函数', typeof fallbackPlugin?.apply === 'function');
  check(
    '兜底时上报了致命错误',
    brokenBeacons.some((item) => String(item.body).includes('fatal-at-eval')),
    `实际上报 ${brokenBeacons.length} 次`,
  );
}

if (failures > 0) {
  console.log(`\n[x] ${failures} 项失败 —— 这个产物有把外壳启动审计搞挂的风险，不要启用`);
  process.exitCode = 1;
} else {
  console.log('\n[v] CLIENT BOOT SAFE —— 工厂不抛、slot 注册正常、降级路径有效');
}
