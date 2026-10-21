#!/usr/bin/env node
/**
 * 门禁：**渲染帧预算**（`lib/test/frame-budget.mjs` ＝ `src/client/frame-budget.ts`）。
 *
 * ## 为什么需要这个文件
 *
 * 它守的是第十个真缺陷：插件配置里的 `maxFps`（默认 60）**谁都没有读**。
 * `lib/index.js` 把它读出来、夹好、写进 `/status`，客户端把它收到一个字段里
 * ——然后渲染循环一个节流都没有，屏幕上 144Hz 就是 144fps。
 * 用户在配置里写 `maxFps: 30` 想降风扇，帧率一点没变、面板数字照旧、不报任何错。
 *
 * 与前九个同类缺陷一样，危险的不是「值没传到」，是「值传到了、没人用它做判断」。
 * 而这次的层又换了一次：前九个都在指令链或渲染端，这个是**配置层** ——
 * 整条链从配置文件到 `/status` 全都通，链尾那一扣没接。
 *
 * ## 为什么必须用「数帧数」的方式验
 *
 * 帧率这个东西在画面上**没法判断是哪种错**：
 *
 *   - 上限没生效       → 「帧率不太对」
 *   - 上限生效但砍过头 → 「帧率不太对」（60 变成 30，看起来还挺像「省电了」）
 *   - 上限生效但发超了 → 「帧率不太对」（144Hz 屏设 60 却画出 72）
 *
 * 所以这里不去量真实帧率（那要 WebGL 和一块 144Hz 的屏），而是把判据抽成
 * 「时间从参数进来」的纯函数，用**一条假时间轴**把一秒推一遍，直接数出画了几帧。
 * 顺带把三条真会发生的坏实现跑一遍，证明这个门禁分得清它们。
 *
 * ## 用法
 *
 *     node tools/test-frame-budget.mjs     （离线：无网络、无 DOM、无文件系统写入）
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(PACKAGE, 'lib/test/frame-budget.mjs');
const configPath = resolve(PACKAGE, 'lib/host/render-config.js');
const hostDir = resolve(PACKAGE, 'lib/host');
const clientDir = resolve(PACKAGE, 'src/client');

let failed = 0;
let passed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

if (!existsSync(modulePath)) {
  console.error(`帧预算的测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const config = await import(new URL(`file://${configPath.replace(/\\/g, '/')}`).href);
const { FRAME_SLACK, frameIntervalMs, shouldDrawFrame } = mod;
const { DEFAULT_FPS, MAX_FPS, MIN_FPS, normalizeFps } = config;

const close = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;

/**
 * 把「一秒钟」推一遍，返回**真的画了几帧**。
 *
 * 这是这个门禁的核心：判据是 `shouldDrawFrame(lastDrawAt, now, fps)`，而
 * `lastDrawAt` 只在真的画了之后才更新（与 `plugin.ts` 的 `frame()` 一致）。
 * 实现成「按 i 乘出来」而不是「累加 step」，是为了让时间戳本身不带累计误差 ——
 * 浮点累加跑 600 帧会飘出零点几毫秒，而这一道要数的正是「够不够 16.6ms」。
 *
 * `jitter` 模拟真实 `requestAnimationFrame` 的抖动（正负若干毫秒）：它不是
 * 装饰，`FRAME_SLACK` 的存在理由就是它 —— 严格比较会把**每一帧**都判成
 * 「还不到时候」。
 */
function simulate({ fps, hz, seconds, jitter = 0, impl = shouldDrawFrame }) {
  const step = 1000 / hz;
  const frames = Math.round(seconds * hz);
  let lastDrawAt = 0;
  let drawn = 0;
  let dtTotalMs = 0;
  for (let i = 1; i <= frames; i += 1) {
    const wobble = jitter === 0 ? 0 : (i % 2 === 0 ? -jitter : jitter);
    const now = i * step + wobble;
    if (!impl(lastDrawAt, now, fps)) continue;
    if (lastDrawAt > 0) dtTotalMs += now - lastDrawAt;
    lastDrawAt = now;
    drawn += 1;
  }
  return { drawn, dtTotalMs };
}

/** 只取「这个文件声明了哪些常量」，注释里的同名文字不算。 */
function declaredConstants(file) {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
  const found = new Set();
  for (const name of ['MIN_FPS', 'MAX_FPS', 'DEFAULT_FPS']) {
    if (new RegExp(`(^|\\s)(export\\s+)?const\\s+${name}\\s*=`).test(source)) found.add(name);
  }
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
section('[1] 帧率边界只有一个定义处（第八个缺陷那套扫描法，换到配置层再查一遍）');

const declarers = [];
for (const [dir, filter] of [
  [hostDir, (name) => name.endsWith('.js')],
  [clientDir, (name) => name.endsWith('.ts')],
]) {
  for (const name of readdirSync(dir).filter(filter)) {
    const found = declaredConstants(join(dir, name));
    if (found.size > 0) declarers.push(`${dir === hostDir ? 'lib/host' : 'src/client'}/${name}: ${[...found].sort().join(',')}`);
  }
}

check(
  '★ MIN_FPS / MAX_FPS / DEFAULT_FPS 全仓只有一处声明',
  declarers.length === 1 && declarers[0].startsWith('lib/host/render-config.js'),
  declarers.length === 0 ? '一处都没有（常量被删了？）' : declarers.join(' | '),
);
check(
  '★ 三个边界都在 lib/host/render-config.js 里',
  declarers.length === 1 && declarers[0].includes('MIN_FPS') && declarers[0].includes('MAX_FPS') && declarers[0].includes('DEFAULT_FPS'),
  declarers[0] ?? '(无)',
);

const indexSource = readFileSync(resolve(PACKAGE, 'lib/index.js'), 'utf8');
check(
  '★ lib/index.js 把配置交给 normalizeFps()，而不是自己写一个 60',
  /maxFps:\s*normalizeFps\(\s*cfg\.maxFps\s*\)/.test(indexSource),
);
check(
  '★ 旧的 `cfg.maxFps ?? 60` 已经不在了（它就是第十个缺陷的形状）',
  !/cfg\.maxFps\s*(\?\?|\|\|)/.test(indexSource),
);
check(
  '★ lib/index.js 真的从 render-config.js 取这个函数',
  /import\s*\{[^}]*normalizeFps[^}]*\}\s*from\s*'\.\/host\/render-config\.js'/.test(indexSource),
);

// ───────────────────────────────────────────────────────────────────────────
section('[2] 渲染端真的用它做判断了（而不是读出来报回去）');

const pluginSource = readFileSync(resolve(PACKAGE, 'src/client/plugin.ts'), 'utf8');
const gateNeedle = 'shouldDrawFrame(host.last, now, fpsRef.current)';
const gateAt = pluginSource.indexOf(gateNeedle);
const lastAt = pluginSource.indexOf('host.last = now;');

check('★ frame() 里调用了 shouldDrawFrame(host.last, now, fpsRef.current)', gateAt >= 0);
check(
  '★ 这个调用在 plugin.ts 里只出现一次（两次就是「顺手又加了一层」，数字会互相打架）',
  pluginSource.split(gateNeedle).length - 1 === 1,
);
check(
  '★ 限流判据排在 `host.last = now` 之前',
  gateAt >= 0 && lastAt >= 0 && gateAt < lastAt,
  gateAt < 0 || lastAt < 0 ? '有一处找不到' : `gate@${gateAt} < last@${lastAt}`,
);

/*
 * ★ 这一条是上面那条顺序断言的**原因**，也是唯一能证明「跳帧不会让动作变慢」的地方：
 * 若把 `host.last = now` 挪到限流之前，`dt` 就永远只覆盖一个 rAF 间隔 ——
 * 上限 30 时动作会以一半速度播放。$[3] 段会把这件事算出来。
 */
check(
  '★ fpsRef.current 每次渲染都被赋值（心跳带回来的新值要能被下一帧读到）',
  /fpsRef\.current\s*=\s*props\.maxFps;/.test(pluginSource),
);
check(
  '★ Live2DStage 收到了 maxFps（值从 /status 一路走到渲染循环）',
  /maxFps:\s*normalizeFps\(/.test(pluginSource),
);
check(
  '★ 传给 Stage 的那一行仍然走 normalizeFps（不信任任何一个外来数字）',
  /maxFps:\s*normalizeFps\(\s*\(status as \{ maxFps\?: unknown \} \| null\)\?\.maxFps\s*\)/.test(pluginSource),
);

// ───────────────────────────────────────────────────────────────────────────
section('[3] normalizeFps：脏值往「能看见」的方向夹，不往「冻住」的方向夹');

check('DEFAULT_FPS 是 60', DEFAULT_FPS === 60, `实测 ${DEFAULT_FPS}`);
check('MIN_FPS 是 10（再低就不像桌宠了）', MIN_FPS === 10, `实测 ${MIN_FPS}`);
check('MAX_FPS 是 240', MAX_FPS === 240, `实测 ${MAX_FPS}`);

check('normalizeFps(60) 原样通过', normalizeFps(60) === 60, `→ ${normalizeFps(60)}`);
check('normalizeFps(0.5) 夹到下限而不是 0', normalizeFps(0.5) === MIN_FPS, `→ ${normalizeFps(0.5)}`);
check('★ normalizeFps(0) 夹到 10 —— 它就是「桌宠永久静止」的那条路', normalizeFps(0) === MIN_FPS, `→ ${normalizeFps(0)}`);
check('normalizeFps(-5) 夹到 10', normalizeFps(-5) === MIN_FPS, `→ ${normalizeFps(-5)}`);
check('normalizeFps(1000) 夹到 240', normalizeFps(1000) === MAX_FPS, `→ ${normalizeFps(1000)}`);
check("normalizeFps('30') 当脏值，回 60（不去猜字符串）", normalizeFps('30') === DEFAULT_FPS, `→ ${normalizeFps('30')}`);
check('normalizeFps(NaN) 回 60', normalizeFps(Number.NaN) === DEFAULT_FPS, `→ ${normalizeFps(Number.NaN)}`);
check('normalizeFps(Infinity) 回 60', normalizeFps(Number.POSITIVE_INFINITY) === DEFAULT_FPS, `→ ${normalizeFps(Number.POSITIVE_INFINITY)}`);
check('normalizeFps(undefined) 回 60（/status 还没回来的那一瞬）', normalizeFps(undefined) === DEFAULT_FPS, `→ ${normalizeFps(undefined)}`);

check('frameIntervalMs(60) = 1000/60', close(frameIntervalMs(60), 1000 / 60), `→ ${frameIntervalMs(60)}`);
check('frameIntervalMs(0) = 100ms（不是 Infinity）', frameIntervalMs(0) === 100, `→ ${frameIntervalMs(0)}`);
check('frameIntervalMs(undefined) = 1000/60', close(frameIntervalMs(undefined), 1000 / 60), `→ ${frameIntervalMs(undefined)}`);
check('frameIntervalMs(1000) = 1000/240（夹到上限）', close(frameIntervalMs(1000), 1000 / 240), `→ ${frameIntervalMs(1000)}`);

// ───────────────────────────────────────────────────────────────────────────
section('[4] shouldDrawFrame：四条兜底都朝「宁可多画一帧，绝不冻住」');

check('★ 还没画过时一定画（lastDrawAt === 0）', shouldDrawFrame(0, 12345, 60) === true);
check('★ now 是脏值（NaN）时画，不静默冻住', shouldDrawFrame(100, Number.NaN, 60) === true);
check('★ lastDrawAt 是脏值（NaN）时画', shouldDrawFrame(Number.NaN, 100, 60) === true);
check('★ 同一个时间戳（时钟回拨 / 停在同一毫秒）时画', shouldDrawFrame(100, 100, 60) === true);
check('★ 时钟倒着走时画', shouldDrawFrame(200, 100, 60) === true);
check('★ lastDrawAt 跑到未来（休眠唤醒后真会发生）也不会一帧不画', shouldDrawFrame(1e9, 100, 60) === true);
check('间隔不够时不画', shouldDrawFrame(100, 105, 60) === false, '5ms < 15ms');
check('间隔够了就画', shouldDrawFrame(100, 120, 60) === true, '20ms >= 15ms');

// ───────────────────────────────────────────────────────────────────────────
section('[5] ★ 假时间轴：一秒推一遍，数出到底画了几帧');

const hz60 = simulate({ fps: 60, hz: 60, seconds: 1 });
check('★ 60Hz 屏 + 上限 60 → 画出 60 帧（不是 30，也不是 0）', hz60.drawn >= 58 && hz60.drawn <= 61, `实测 ${hz60.drawn} 帧`);

const noLimit = simulate({ fps: undefined, hz: 60, seconds: 1 });
check('配置没写 maxFps（undefined）→ 默认 60fps', noLimit.drawn >= 58 && noLimit.drawn <= 61, `实测 ${noLimit.drawn} 帧`);

const cap30 = simulate({ fps: 30, hz: 60, seconds: 1 });
check('上限 30 → 画出 30 帧', cap30.drawn >= 28 && cap30.drawn <= 31, `实测 ${cap30.drawn} 帧`);

const cap10 = simulate({ fps: 10, hz: 60, seconds: 1 });
check('上限 10 → 画出 10 帧', cap10.drawn >= 9 && cap10.drawn <= 11, `实测 ${cap10.drawn} 帧`);

const cap240on60 = simulate({ fps: 240, hz: 60, seconds: 1 });
check('上限 240 但屏只有 60Hz → 最多 60 帧（上限不能凭空造出帧）', cap240on60.drawn >= 58 && cap240on60.drawn <= 61, `实测 ${cap240on60.drawn} 帧`);

const hz144 = simulate({ fps: 60, hz: 144, seconds: 1 });
check(
  '★ 144Hz 屏 + 上限 60 → 明显低于 60 但没超发（量化到刷新率的整数分之一）',
  hz144.drawn <= 60 && hz144.drawn >= 40,
  `实测 ${hz144.drawn} 帧（48 正是 144/3）`,
);

const jittery = simulate({ fps: 60, hz: 60, seconds: 1, jitter: 0.4 });
check(
  '★ 带 ±0.4ms 抖动的 60Hz + 上限 60 → 仍然 60 帧（这就是 FRAME_SLACK 存在的理由）',
  jittery.drawn >= 58,
  `实测 ${jittery.drawn} 帧`,
);

// ───────────────────────────────────────────────────────────────────────────
section('[6] ★ 配置写坏了不能把桌宠冻住');

const zero5s = simulate({ fps: 0, hz: 60, seconds: 5 });
check(
  '★ maxFps: 0 跑 5 秒 → 画出 ≥40 帧（按 10fps 走），不是 0 帧',
  zero5s.drawn >= 40,
  `实测 ${zero5s.drawn} 帧`,
);
const garbage = simulate({ fps: 'abc', hz: 60, seconds: 1 });
check("maxFps: 'abc' → 按默认 60fps 走", garbage.drawn >= 58, `实测 ${garbage.drawn} 帧`);
const negative = simulate({ fps: -100, hz: 60, seconds: 1 });
check('maxFps: -100 → 按 10fps 走，不是冻住', negative.drawn >= 9, `实测 ${negative.drawn} 帧`);

// ───────────────────────────────────────────────────────────────────────────
section('[7] ★ 跳帧不能让动作变慢（dt 的起点只在真的画了之后才更新）');

check(
  '上限 30 跑一秒：累计 dt 覆盖几乎整秒（不是 30 个 rAF 间隔）',
  cap30.dtTotalMs > 950,
  `实测 ${Math.round(cap30.dtTotalMs)}ms`,
);

/** 退化 4：**每个 rAF 帧都更新 last** —— 上限生效了，但动作以一半速度播放。 */
function simulateUpdatingLastEveryFrame({ fps, hz, seconds }) {
  const step = 1000 / hz;
  const frames = Math.round(seconds * hz);
  let lastRafAt = 0;
  let lastDrawAt = 0;
  let drawn = 0;
  let dtTotalMs = 0;
  for (let i = 1; i <= frames; i += 1) {
    const now = i * step;
    const dt = lastRafAt === 0 ? 0 : now - lastRafAt;
    lastRafAt = now;
    if (!shouldDrawFrame(lastDrawAt, now, fps)) continue;
    dtTotalMs += dt;
    lastDrawAt = now;
    drawn += 1;
  }
  return { drawn, dtTotalMs };
}

const halfSpeed = simulateUpdatingLastEveryFrame({ fps: 30, hz: 60, seconds: 1 });
check(
  '退化（每帧都更新 last）：帧数一样是 30，但累计 dt 只有一半',
  halfSpeed.drawn === cap30.drawn && halfSpeed.dtTotalMs < 600,
  `dt 实测 ${Math.round(halfSpeed.dtTotalMs)}ms vs 正确的 ${Math.round(cap30.dtTotalMs)}ms`,
);

// ───────────────────────────────────────────────────────────────────────────
section('[8] ★ 三条坏实现，这个门禁分得清');

/** 退化 1：**没有上限**（第十个缺陷原来就是这个形状）—— 无条件画。 */
const noCap = () => true;
const noCap30 = simulate({ fps: 30, hz: 60, seconds: 1, impl: noCap });
check(
  '退化 1（没上限）：60Hz 上设 30 还是画 60 帧',
  noCap30.drawn >= 58 && cap30.drawn <= 31,
  `退化 ${noCap30.drawn} 帧 vs 正确 ${cap30.drawn} 帧`,
);

/** 退化 2：**严格比较，不留余量** —— 上限生效了，但 60 掉成 30。 */
const strictNoSlack = (lastDrawAt, now, fps) => {
  if (!(lastDrawAt > 0)) return true;
  if (!(now > lastDrawAt)) return true;
  return now - lastDrawAt >= frameIntervalMs(fps);
};
const strict60 = simulate({ fps: 60, hz: 60, seconds: 1, jitter: 0.4, impl: strictNoSlack });
check(
  '退化 2（严格比较）：带抖动时 60fps 上限掉成约 30fps',
  strict60.drawn <= 45 && jittery.drawn >= 58,
  `退化 ${strict60.drawn} 帧 vs 正确 ${jittery.drawn} 帧`,
);

/** 退化 3：**不夹取**（`1000 / fps` 直接用）—— 配置写 0 就永久静止。 */
const freezeOnZero = (lastDrawAt, now, fps) => {
  if (!(lastDrawAt > 0)) return true;
  if (!(now > lastDrawAt)) return true;
  return now - lastDrawAt >= (1000 / fps) * FRAME_SLACK;
};
const frozen = simulate({ fps: 0, hz: 60, seconds: 5, impl: freezeOnZero });
check(
  '退化 3（不夹取）：maxFps: 0 时 5 秒只画出第一帧',
  frozen.drawn <= 1 && zero5s.drawn >= 40,
  `退化 ${frozen.drawn} 帧 vs 正确 ${zero5s.drawn} 帧`,
);

check(
  'FRAME_SLACK 严格小于 1（等于 1 就把 60Hz 上的 60fps 上限压成 30）',
  typeof FRAME_SLACK === 'number' && FRAME_SLACK > 0 && FRAME_SLACK < 1,
  `实测 ${FRAME_SLACK}`,
);

// ───────────────────────────────────────────────────────────────────────────
/*
 * ★ 这个门禁原来的职责是「帧率上限算得对不对」。从「miku 跑一段时间后冻住」
 * 那次排查之后，它多了一层职责：**冻结必须留下证据**。
 *
 * 为什么放在这儿而不是新开一个门禁文件：下面每一条守的都是同一个问题的另一面
 * ——「画面为什么可能停住」。帧率算错会停住，抛异常会停住，`await` 挂死也会
 * 停住。它们共用「冻住」这个词，也就该共用一份断言。
 *
 * 全部是源码探针（`pluginSource`），因为它们守的是**接线**：这些护栏本身没有
 * 复杂的算法，它们的价值全在「有没有被接上去」。写错了不会红，只会沉默 ——
 * 而「沉默」正是这一整类故障的名字。
 */
/**
 * 去掉注释再匹配。
 *
 * 理由是撞出来的：`plugin.ts` 里那些护栏的注释**正解释着**它们要断言的字符串
 * （`'frame'`、`'tick-stall'`、`busyStep`……），直接 grep 源码一定命中注释，
 * 断言就会「注释写得越详细越绿」—— 而注释是**承诺**，代码才是**事实**。
 * 两者必须分开看。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const pluginCode = stripComments(pluginSource);

section('[9] ★ 帧循环的护栏：抛错要留痕，停摆要留痕');

check(
  '★ rAF 回调包在 try/catch 里（rAF 没有异常出口，一次抛错 = 循环照跑 + 画面定格 + 零日志）',
  /try \{\s*const drew = drawFrame\(now\);/.test(pluginCode)
    && /catch \(err\) \{\s*frameErrors \+= 1;/.test(pluginCode)
    && /reportFailure\(\s*'frame',/.test(pluginCode),
);
check(
  '★ 上报带节流（它每帧都炸；不节流的话日志会被自己淹掉，真原因反而找不到）',
  /FRAME_ERROR_REPORT_MS = \d{4}/.test(pluginCode)
    && /now - lastFrameErrorAt >= FRAME_ERROR_REPORT_MS/.test(pluginCode),
  '节流窗口是四位毫秒数（5 秒），写小了会淹日志、写大了复现一次抓不到',
);
check(
  '★ 停摆看门狗是一个独立的定时器，且在卸载时被清掉',
  /const stallTimer = setInterval\(/.test(pluginCode)
    && /clearInterval\(stallTimer\);/.test(pluginCode),
  '忘了 clearInterval 的话，面板卸载后它还会拿着已经拆掉的 host 继续跑',
);
check(
  '★ 看门狗把「窗口藏起来」与「真的停摆」分开（藏起来时浏览器本来就会停 rAF，那不是故障）',
  /document\.hidden === true/.test(pluginCode),
);
/*
 * 这一条守的是一个**我自己写出来的**缺陷：第一版把 `lastDrawnAt = Date.now()`
 * 记在调用处，于是「被判掉的帧」也算「画过了」。看门狗存在的唯一理由就是抓
 * 「帧率上限被算成 Infinity、每一帧都被判掉」那一类 —— 而那一类恰好被它自己
 * 的记账方式盖住了：画面冻着，看门狗一声不吭。
 *
 * 所以断言的是「记账的开关接在返回值上」，而不是「文件里出现了 lastDrawnAt」。
 */
check(
  '★ 停摆看门狗的记账开关接在 drawFrame 的返回值上（判掉的帧不算画过）',
  /const drew = drawFrame\(now\);/.test(pluginCode)
    && /if \(drew\) lastDrawnAt = Date\.now\(\);/.test(pluginCode)
    && !/^\s*lastDrawnAt = Date\.now\(\);/m.test(pluginCode),
  '不接返回值的话，「每一帧都被判掉」这种停摆会被看门狗自己盖住',
);
check(
  '★ 看门狗用的是墙上时钟（Date.now）而不是 rAF 的 now（两者起点不同，混用会立刻误报）',
  /lastDrawnAt = Date\.now\(\)/.test(pluginCode)
    && /Date\.now\(\) - lastDrawnAt/.test(pluginCode),
);

section('[10] ★ 命令通道：一次挂死的 await 会让它永久沉默，而且所有仪表都正常');

check(
  '★ tick 有世代号（看门狗强行解锁后，卡住的那一轮醒来必须发现自己作废，不能把同一批指令再执行一遍）',
  /let tickGen = 0;/.test(pluginCode)
    && /const myGen = \+\+tickGen;/.test(pluginCode)
    && /const stale = \(\): boolean => cancelled \|\| myGen !== tickGen;/.test(pluginCode)
    && /if \(stale\(\)\) return;/.test(pluginCode),
);
check(
  '★ 每个 await 之后都查一次 stale()（只在开头查等于没查：卡住的是中间那一次）',
  (pluginCode.match(/if \(stale\(\)\) return;/g) ?? []).length >= 4,
  `实测 ${(pluginCode.match(/if \(stale\(\)\) return;/g) ?? []).length} 处`,
);
check(
  '★ tick 有独立的看门狗，且卸载时被清掉',
  /const TICK_STALL_MS = \d{4,6};/.test(pluginCode)
    && /const tickWatchdog = setInterval\(/.test(pluginCode)
    && /clearInterval\(tickWatchdog\);/.test(pluginCode),
);
check(
  '★ 看门狗不只是报警，还会强行解锁（只报警的话用户仍要手动刷新才能用）',
  /tickGen \+= 1;\s*busy = false;/.test(pluginCode),
);
check(
  '★ 报警文案里带上「卡在哪一步」（否则只知道卡了，不知道该去查哪个 await）',
  /busyStep = '/.test(pluginCode) && /卡在：\$\{busyStep\}/.test(pluginCode),
);
check(
  '★ 报警文案说清「心跳正常不代表通道活着」（这一条不说，看日志的人会以为没事）',
  /心跳与 fps 都是别的代码写的/.test(pluginCode),
);
check(
  '★ /pending 的 fetch 走带超时的那个包装（fetch 没有默认超时，挂住 = 永久沉默）',
  /await fetchWithTimeout\(\s*`\$\{ROUTE_PREFIX\}\/pending`/.test(pluginCode)
    && /POLL_FETCH_TIMEOUT_MS,/.test(pluginCode),
);

section('[11] ★ WebGL 上下文丢失：静默变 no-op，是最干净的一条「冻住」解释');

check(
  '★ 两个事件都监听了，且都在卸载时摘掉（同一个 canvas 会被重建复用，不摘就会叠加监听器）',
  /canvas\.addEventListener\('webglcontextlost', onContextLost\)/.test(pluginCode)
    && /canvas\.addEventListener\('webglcontextrestored', onContextRestored\)/.test(pluginCode)
    && /canvas\.removeEventListener\('webglcontextlost', onContextLost\)/.test(pluginCode)
    && /canvas\.removeEventListener\('webglcontextrestored', onContextRestored\)/.test(pluginCode),
);
check(
  '★ 丢失时 preventDefault（不阻止默认行为，浏览器不会尝试恢复上下文）',
  /event\.preventDefault\(\);/.test(pluginCode),
);
check(
  '★ 丢失时会重建渲染宿主（框架侧 GPU 资源已销毁，没有「全部重建」的入口，只能推倒重来）',
  /setBoot\(\(n\) => n \+ 1\);/.test(pluginCode)
    && /const \[boot, setBoot\] = useState\(0\);/.test(pluginCode)
    && /\}, \[boot\]\);/.test(pluginCode),
  'setBoot 了但启动 effect 的依赖还是空数组的话，这一行等于没写',
);
check(
  '★ 不能只靠事件：每 2 秒轮询一次 gl.isContextLost()（事件可能根本没派发，或者在监听器装上之前上下文就已经丢了）',
  /const GL_WATCH_MS = \d+;/.test(pluginCode)
    && /gl\.isContextLost\(\) === true/.test(pluginCode)
    && /const glWatchTimer = setInterval\(/.test(pluginCode)
    && /clearInterval\(glWatchTimer\);/.test(pluginCode),
  '★ 现场证据：用户那次冻住时 clientErrors 里没有 webgl-context-lost，而画面确实是一张照片 —— 事件这条路有洞',
);

section('[12] ★ 资源请求也要有超时：一次挂住会让那个动作永远加载不出来，且每次重试都新起一个挂死的 await');

const petModelPath = resolve(PACKAGE, 'src/client/pet-model.ts');
const petModelSource = readFileSync(petModelPath, 'utf8');
const petModelCode = stripComments(petModelSource);
const actionRunnerSource = readFileSync(resolve(PACKAGE, 'src/client/action-runner.ts'), 'utf8');
check(
  '★ pet-model 里没有裸的 fetch（两个包装都走带超时的那个）',
  !/\bawait fetch\(/.test(petModelCode) && !/return await fetch\(/.test(petModelCode)
    && (petModelCode.match(/await fetchWithTimeout\(/g) ?? []).length >= 2,
  `裸 fetch ${(petModelCode.match(/\bawait fetch\(/g) ?? []).length} 处`,
);
check(
  '★ 超时的定义只有一处（两个数值各写一份的话，迟早变成两个互相矛盾的真相）',
  readdirSync(clientDir).filter((f) => f.endsWith('.ts'))
    .filter((f) => /export const ASSET_FETCH_TIMEOUT_MS/.test(readFileSync(join(clientDir, f), 'utf8')))
    .length === 1,
);
check(
  '★ 轮询超时比资源超时短（轮询晚一轮只差 1.2 秒，卡住的代价是整个通道死掉）',
  (() => {
    const shared = readFileSync(resolve(PACKAGE, 'src/client/fetch-timeout.ts'), 'utf8');
    const asset = Number(/ASSET_FETCH_TIMEOUT_MS = (\d+)/.exec(shared)?.[1] ?? '0');
    const poll = Number(/POLL_FETCH_TIMEOUT_MS = (\d+)/.exec(shared)?.[1] ?? '0');
    return asset > 0 && poll > 0 && poll < asset;
  })(),
);
check(
  '★ 带超时的 fetch 在 finally 里清定时器（成功路径不清就是每次请求挂一个 15 秒的定时器）',
  (() => {
    const shared = readFileSync(resolve(PACKAGE, 'src/client/fetch-timeout.ts'), 'utf8');
    return /\} finally \{\s*\/\/[^\n]*\n\s*clearTimeout\(timer\);/.test(shared)
      || /\} finally \{\s*clearTimeout\(timer\);/.test(shared);
  })(),
);

section('[14] ★ 画面冻住了：唯一一条不问假设的存活判据（比像素，而不是比仪表）');

check(
  '★ 采样按 LIVE_SAMPLE_MS 节流（每帧一次 getImageData 是白烧电，而它要整天跑）',
  /const LIVE_SAMPLE_MS = \d+;/.test(pluginCode)
    && /Date\.now\(\) - host\.liveSampledAt >= LIVE_SAMPLE_MS/.test(pluginCode),
);
check(
  '★ 连续相同才计数，任何一次不同就归零（否则「偶尔一帧恰好一样」会累积成假故障）',
  /host\.liveSameStreak = hash === host\.liveHash \? host\.liveSameStreak \+ 1 : 0;/.test(pluginCode),
);
check(
  '★ 全透明一律当「这次不知道」—— 少了这条会造出「加载中 → 判冻住 → 重建 → 又加载中」的死循环',
  /let opaque = 0;/.test(pluginCode) && /if \(opaque === 0\) \{/.test(pluginCode),
  '模型加载期间画布是空的，空画面哈希恒定不变，探针会把「正常加载」判成故障并且永远出不来',
);
check(
  '★ 窗口藏起来时不判（那时画面本来就不该变）',
  /document\.hidden !== true/.test(pluginCode),
);
check(
  '★ 上报限流（clientErrors 只留最后 20 条，不限流会把真事淹掉）',
  /const LIVE_REPORT_MS = \d+;/.test(pluginCode)
    && /at - host\.liveReportedAt >= LIVE_REPORT_MS/.test(pluginCode),
);
check(
  '★ 上报里带着 gl.isContextLost() 与动作优先级（下一次再冻住，一条记录就能定案）',
  /gl\.isContextLost\(\)=\$\{String\(contextLost\)\}/.test(pluginCode)
    && /动作优先级=\$\{priority\}/.test(pluginCode)
    && /模型=\$\{host\.renderedPath \?\? '（无）'\}/.test(pluginCode),
);
check(
  '★ 连续相同到 LIVE_REBUILD_SAMPLES 次就重建渲染宿主（把「永久冻住、手动刷新」变成「30 秒自愈」）',
  /const LIVE_REBUILD_SAMPLES = \d+;/.test(pluginCode)
    && /if \(host\.liveSameStreak >= LIVE_REBUILD_SAMPLES\) \{/.test(pluginCode)
    && /setPhase\('画面停住了，正在重建渲染宿主…'\);/.test(pluginCode),
);
check(
  '★ 采样排在 draw() 之后、同一个 rAF 回调里',
  (() => {
    const draw = pluginCode.indexOf('model.draw(w, hgt);');
    const sample = pluginCode.indexOf('frameHashOf(canvas, host.liveProbe,');
    return draw > 0 && sample > draw;
  })(),
  '采样早于 draw 的话每次都是一片透明 → 探针自己把「正常运行」误报成「冻住」',
);
check(
  '★ 重建是**活的**：模型加载 effect 也依赖 boot',
  /\}, \[modelPath, boot\]\);/.test(pluginCode),
  '启动 effect 的 cleanup 会 release() 掉模型，而加载模型是另一个 effect 的事 —— '
  + '少了 boot，重建的结果是「旧模型被释放、新模型没人装」= 桌宠整个消失，比冻住更糟',
);
check(
  '★ 探针会自证：采满 LIVE_SELF_TEST_SAMPLES 次主动报一条 frame-live（否则「0 条记录」在两件事之间分不清）',
  /const LIVE_SELF_TEST_SAMPLES = \d+;/.test(pluginCode)
    && /host\.liveSamples >= LIVE_SELF_TEST_SAMPLES/.test(pluginCode)
    && /reportFailure\(\s*'frame-live',/.test(pluginCode),
  '探针只在故障时说话，所以 clientErrors 为空既可能是「没冻住」也可能是「压根没接上线」——'
  + '2026-06 用户问「有记录吗」时，能回答的只有去翻 lib/client.js 里有没有那几个字符串，'
  + '而「包里有」不等于「跑起来了」',
);
check(
  '★ 自证的闸门只认本进程（不用 sessionStorage）：能被看不见的陈旧标记永久压住的诊断，比多一条日志坏得多',
  /let liveSelfTestSent = false;/.test(pluginCode)
    && !/sessionStorage/.test(pluginCode)
    && /!liveSelfTestSent && host\.liveSamples >= LIVE_SELF_TEST_SAMPLES/.test(pluginCode),
  '这里原来用 sessionStorage（一个标签页只报一次），它造成过一次真实误判：'
  + 'Host 的 clientErrors 是内存里的、DSH 一重启就清空，而标签页里的 sessionStorage 不会 ——'
  + '于是「自证发过了、重启把记录抹了、标签页没刷新、自证再也不会发」这条路上，'
  + '我看到的是空 clientErrors，与「探针压根没接线」一模一样，只能靠猜（并且猜错了两次）',
);
check(
  '★ 自证报的是观测到的事实（采样次数 / 连续相同次数 / isContextLost），不是「我还在跑」这句自称',
  /已采样 \$\{host\.liveSamples\} 次/.test(pluginCode)
    && /连续逐字节相同的最大次数=\$\{host\.liveSameStreak\}/.test(pluginCode)
    && /gl\.isContextLost\(\)=\$\{String\(selfTestContextLost\)\}/.test(pluginCode),
);
check(
  '★ 自证只要求「拿到了像素」，不再要求「窗口可见」—— 报自证是证明探针活着，不是声明健康',
  /if \(hash >= 0 && !liveSelfTestSent && host\.liveSamples >= LIVE_SELF_TEST_SAMPLES\) \{/.test(pluginCode)
    && /document\.hidden=\$\{String\(/.test(pluginCode),
  '【2026-02 更正】这里原来还要求 visible，理由是「藏起来时画面本来就不该变，报自证是谎话」。'
  + '那把**自证**当成了**健康声明**，方向错了：自证的唯一职责是证明「探针活着」，'
  + '好让它之后的沉默可解释。加上 visible 之后，恰好在「窗口被判成隐藏」这个最需要证据的'
  + '处境里自证拒绝出声 —— 于是又一次得到「零记录」，又一次只能靠猜。'
  + '现在照报，把 document.hidden 与 visibilityState 写进消息里让人自己判断。'
  + 'hash >= 0 仍然必须保留：加载期间那片全透明不能报成「画面确实在动」。',
);
check(
  '★ 探针瞎了会自己说出来（frame-blind）：连续读不到像素要报一条，并带上失败原因',
  /const LIVE_BLIND_SAMPLES = \d+;/.test(pluginCode)
    && /host\.liveBlindStreak >= LIVE_BLIND_SAMPLES/.test(pluginCode)
    && /reportFailure\(\s*'frame-blind',/.test(pluginCode)
    && /diag\.why/.test(pluginCode),
  '探针只在冻住时说话，所以「clientErrors 为空」同时对应三件事：真的没冻、探针没跑到、'
  + '探针跑到了但读不到像素 —— 前两种要改代码、第三种要改探针，而它们在 /status 上一模一样',
);
check(
  '★ frameHashOf 的每一个 return -1 分支都留下了原因（不然「瞎了」还是「没跑到」只能靠猜）',
  (pluginCode.match(/diag\.why = /g) ?? []).length >= 4,
  '失败原因必须逐分支写：画布尺寸为 0 / 取不到 2D 上下文 / 采到全透明 / 读像素抛异常。'
  + '这四种的后果完全不同，却都表现为「探针沉默」',
);
check(
  '★ 「一帧都没跑到」自己说出来（frame-nostart）：唯一一条不依赖任何一帧的护栏',
  /const LIVE_START_MS = \d+;/.test(pluginCode)
    && /const startTimer = setInterval\(/.test(pluginCode)
    && /reportFailure\(\s*'frame-nostart',/.test(pluginCode)
    && /clearInterval\(startTimer\);/.test(pluginCode),
  '上面四条护栏（帧 try/catch、停摆看门狗、frame-blind、frame-frozen）全都住在 drawFrame 里面，'
  + '或者以「已经画过帧」为前提 —— 停摆看门狗与兜底驱动都写着 if (lastDrawnAt === 0) return;，'
  + '而那个早退分支覆盖的恰恰就是「一帧都没有」这个状态。于是「帧循环根本没跑起来」'
  + '没有任何护栏能说话，而它的外在表现与「她冻住了」完全一致：clientErrors 空的、'
  + 'fps 标签停在最后一次算出来的值上。必须放在定时器里：rAF 停了，藏在帧里的检查永远不执行。',
);
check(
  '★ frame-nostart 的判据是 liveAttempts（采样块跑过几次），不是 frames / liveSamples',
  /liveAttempts: number;/.test(pluginCode)
    && pluginCode.indexOf('host.liveAttempts += 1;') >= 0
    && /host\.liveAttempts > 0/.test(pluginCode)
    && pluginCode.indexOf('host.liveAttempts += 1;') < pluginCode.indexOf('const hash = frameHashOf('),
  'frames 与 liveSamples 在「模型还在加载、画布全透明」时都可能是 0，会冤枉加载慢的模型；'
  + 'liveAttempts 只要有一帧就立刻从 0 变 1，所以 liveAttempts=0 是毫不含糊的「根本没有帧」。'
  + '计数必须放在 frameHashOf **之前** —— 放到后面就又变成「读到像素才算跑过」，'
  + '而「读不到像素」已经由 frame-blind 负责了。',
);
check(
  '★ 眼睛好了就拔掉「已经报过瞎」的闩（否则第二次瞎掉永远不出声）',
  /host\.liveBlindReported = false;/.test(pluginCode),
  '不拔的话这一条一辈子只能报一次：第一次瞎（比如加载期间画布全透明）报过之后，'
  + '哪怕后来好了、再后来又瞎了，都再也不出声 —— 那正是「沉默无法解释」的老毛病，'
  + '只不过这次是闩造成的。clientErrors 只留最后 20 条，多报几次的代价有限。',
);
check(
  '★ 「窗口被判成隐藏」单独报一条（frame-hidden），而且是从**定时器**里报的、不是从帧里',
  /const LIVE_HIDDEN_REPORT_MS = \d+;/.test(pluginCode)
    && /reportFailure\(\s*'frame-hidden',/.test(pluginCode)
    && /const hiddenTimer = setInterval\(/.test(pluginCode)
    && /clearInterval\(hiddenTimer\);/.test(pluginCode)
    && pluginCode.indexOf('const hiddenTimer = setInterval(') > pluginCode.indexOf('const stallTimer = setInterval('),
  '停摆看门狗与画面活性探针都**故意**在 document.hidden 时保持沉默（理由是对的），'
  + '于是「窗口被判隐藏」成了我们自己造出来的盲区：rAF 暂停 → 画面永久定格、'
  + 'fps 标签停在最后一次算出的值（仍显示 60，是骗人的）、零记录 —— 三个症状与用户报的逐字吻合。'
  + '必须放在定时器里：rAF 停了帧循环就不跑了，藏在帧里的检查永远不会执行',
);
check(
  '★ rAF 停摆时用定时器兜底驱动画面（wakeTimer）：把「冻成一张照片」变成「动得慢一点」',
  /const WAKE_STALL_MS = \d+;/.test(pluginCode)
    && /const wakeTimer = setInterval\(/.test(pluginCode)
    && /const drew = drawFrame\(performance\.now\(\)\);/.test(pluginCode)
    && /clearInterval\(wakeTimer\);/.test(pluginCode)
    && /if \(drew\) lastDrawnAt = Date\.now\(\);/.test(pluginCode),
  'document.hidden 这个判定不受我们控制、也不总是对的（用户明明看着桌宠）。'
  + '既然定时器在被判隐藏时仍会跑（降频但不停），就不能只把它记下来：'
  + '要真的把帧补上。判据必须用墙上时钟 —— rAF 的 now 在停摆时根本不会更新',
);

section('[15] ★ 动作队列：框架的 stopAllMotions() 只删得掉隔一条，所以我们必须循环抽干');

check(
  '★ stopMotion() 循环抽干队列，而不是调用一次 stopAllMotions()',
  /const MAX_MOTION_QUEUE_DRAIN = \d+;/.test(petModelCode)
    && /manager\.getCubismMotionQueueEntries\(\)\.length === 0/.test(petModelCode)
    && /manager\.stopAllMotions\(\);/.test(petModelCode)
    && petModelCode.indexOf('getCubismMotionQueueEntries().length === 0')
      > petModelCode.indexOf('public stopMotion('),
  '框架的 CubismMotionQueueManager.stopAllMotions()（framework/src/motion/'
  + 'cubismmotionqueuemanager.ts:152-170）在 for (i = 0; i < length; i++) 里做 '
  + 'splice(i, 1); continue; —— 删掉第 i 个之后数组左移，i++ 于是跳过了原本的第 i+1 个。'
  + '实测存活：n=1 → []、n=2 → [E1]、n=4 → [E1, E3]。留一条活的循环动作会让 '
  + 'currentMotionPriority() 永远回不到 IDLE，shouldAutoIdle() 的第四个条件恒假 ——'
  + '她会一直重复同一个姿势。这是行为缺陷，不是画面冻住。',
);
check(
  '★ 抽干循环有轮数上限（防止将来框架换成另一种「删不完」的形状时变成死循环）',
  /for \(let guard = 0; guard < MAX_MOTION_QUEUE_DRAIN; guard \+= 1\) \{/.test(petModelCode),
  '每轮至少删掉一条，所以实际轮数远小于上限；上限只是防御性的',
);
check(
  '★ 两处误导性的注释都改成了实测结论（循环动作靠淡出被回收，队列不会增长）',
  /【2026-02 更正】/.test(pluginSource)
    && /队列深度始终是 1/.test(pluginSource)
    && /【2026-02 更正】/.test(actionRunnerSource)
    && /但回收根本不靠那条路/.test(actionRunnerSource)
    && /DEFAULT_MOTION_FADE_SECONDS/.test(actionRunnerSource),
  '实测证伪：startMotion() 会给队列里每一条标淡出（cubismmotionqueuemanager.ts:68-75），'
  + 'doUpdateMotion() 把淡出落实成结束时刻（:280-284），updateParameters() 过期置 _finished'
  + '（acubismmotion.ts:83-88），doUpdateMotion() splice 掉已结束的（:274-277）。'
  + '所以旧的循环动作最多多活一个淡出时长（默认 0.3 秒，capabilities.js:197-211）。'
  + '按 5 Hz 模拟 240 分钟：队列深度始终是 1，峰值 2，单帧开销是常数，也不碰 WebGL。'
  + '这两处注释曾把一个不存在的机理写成「无界增长」，并误导过一次排查 ——'
  + '错注释比没注释更坏（§8.11 的教训），所以要留一条断言钉住「更正过了」。',
);

section('[16] ★★ 动作进队列前必须 setEffectIds()：漏一步，画面从第一帧动作起永久定格');

/**
 * 框架侧那一半契约：`CubismMotion` 造出来的动作**天生不能 update**。
 *
 * 这不是我们的实现细节，是 SDK 的形状，所以要直接读框架源码把它钉住 ——
 * 将来升级 Cubism SDK 时如果那两处读法加了 null 保护（或构造函数不再置 null），
 * 这条会变红，提醒我们「当初写下的理由之一已经不成立了，去复核」。
 */
const cubismMotionPath = resolve(PACKAGE, 'framework/src/motion/cubismmotion.ts');
const cubismMotionCode = stripComments(readFileSync(cubismMotionPath, 'utf8'));
check(
  '★ 框架契约：构造函数把 _eyeBlinkParameterIds / _lipSyncParameterIds 置为 null',
  /this\._eyeBlinkParameterIds\s*=\s*null;/.test(cubismMotionCode)
    && /this\._lipSyncParameterIds\s*=\s*null;/.test(cubismMotionCode),
  'framework/src/motion/cubismmotion.ts:792-793（构造函数内）',
);
check(
  '★ 框架契约：doUpdateParameters() 无保护地读这两个数组的 .length',
  /this\._eyeBlinkParameterIds\.length/.test(cubismMotionCode)
    && /this\._lipSyncParameterIds\.length/.test(cubismMotionCode),
  'framework/src/motion/cubismmotion.ts:404 / :410。读法里没有 `?.`、没有前置判空 —— '
  + '所以 null 会以 TypeError 的形式抛出去，而不是被当成「没有眨眼参数」。',
);
check(
  '★ 框架契约：唯一的写入者是 setEffectIds()',
  (cubismMotionCode.match(/setEffectIds/g) ?? []).length === 1
    && /public\s+setEffectIds\s*\(/.test(cubismMotionCode),
  'framework/src/motion/cubismmotion.ts:770-776。全仓库 grep `setEffectIds` 只命中这一处定义，'
  + '也就是说「谁加载动作，谁负责调它」——这不是可选的装饰，是必须补的一步。',
);

check(
  '★★ _loadMotion() 在动作入队前调了 setEffectIds()（漏了就是每帧抛 null.length）',
  /motion\.setEffectIds\(/.test(petModelCode)
    && petModelCode.indexOf('motion.setEffectIds(') > petModelCode.indexOf('private async _loadMotion(')
    && petModelCode.indexOf('motion.setEffectIds(') > petModelCode.indexOf('this.loadMotion('),
  '这就是「她冻住」的真因，也是它唯一一次被抓到的形态：'
  + '`TypeError: Cannot read properties of null (reading \'length\')` @ '
  + '_CubismMotion.doUpdateParameters，每秒约 60 次（每一帧），累计到 8677 次。'
  + '表现极具误导性——画面定格在最后一帧，而 JS 线程、5 秒心跳、命令通道、'
  + '`/status` 全部正常，连心跳龄都是 0.1 秒。'
  + '触发条件是「第一个动作进入队列」：空（motionsGroups 为空）永远不触发，'
  + 'miku / akari / hiyori 都会在 IDLE_AFTER_MS（20000ms）后被它冻住。',
);
check(
  '★★ 传给 setEffectIds() 的是数组：取不到就是空数组，绝不是 null / undefined',
  /_effectIdsCache/.test(petModelCode)
    && /this\._rawSettings\?\.Groups\s*\?\?\s*\[\]/.test(petModelCode)
    && /group\?\.Ids\s*\?\?\s*\[\]/.test(petModelCode)
    && /setEffectIds\(ids\.eyeBlink,\s*ids\.lipSync\)/.test(petModelCode),
  '空数组的 `.length` 是 0，安全（框架只会走「没有要覆盖的参数」那条分支）；'
  + 'null 会每帧抛。所以 `?? []` 在这里不是防御性编程的装饰，是正确性本身。'
  + '`Groups` 在 model3.json 里是标准做法但并非强制，'
  + '「模型没写这两组」必须是一种能正常工作的状态。',
);
check(
  '★★ release() 里跟着 _rawSettings 一起清掉缓存（换模型后不能留着上一只的参数 id）',
  /this\._rawSettings = null;/.test(petModelCode)
    && /this\._effectIdsCache = null;/.test(petModelCode)
    && petModelCode.indexOf('this._effectIdsCache = null;')
      > petModelCode.indexOf('this._rawSettings = null;'),
  '缓存是从 _rawSettings.Groups 推出来的，同生共死',
);
check(
  '★★ 接口 id 走 cachedId() 过一遍（与模型参数表共用一套句柄，不是每次新建字符串）',
  /out\.push\(cachedId\(id\)\)/.test(petModelCode),
  'pet-model.ts 里已有 `const CACHED_PARAM_IDS: Map<string, CubismIdHandle>` 与 `cachedId()`；'
  + '框架比的是句柄相等，直接传字符串会静默不生效（又一个「没有报错」的失败模式）。',
);
check(
  '★★ 传真实 LipSync id 不会抢走我们自己的口型通道',
  /lipSyncValue/.test(readFileSync(cubismMotionPath, 'utf8')),
  'framework/src/motion/cubismmotion.ts:597-617：口型那段只在 '
  + '`lipSyncValue != Number.MAX_VALUE` 时才动手，而这个值只有「动作自己带了口型曲线」'
  + '时才会被赋值。所以绝大多数动作下这一路是空转的；'
  + '真带了口型曲线的动作，本来也会通过普通曲线通道驱动嘴部 —— 行为没有变化。',
);
check(
  '反证 24：把 _loadMotion 里的 setEffectIds() 那一行删掉，上面那条断言必须变红',
  (() => {
    const broken = petModelCode.replace(/motion\.setEffectIds\(ids\.eyeBlink, ids\.lipSync\);/g, '');
    return broken !== petModelCode && !/motion\.setEffectIds\(/.test(broken);
  })(),
);
check(
  '反证 25：把 `?? []` 改成传 null，上面那条「给的是数组」的断言必须变红',
  (() => {
    const broken = petModelCode.replace(/group\?\.Ids \?\? \[\];/, 'group?.Ids ?? null;');
    return broken !== petModelCode && !/group\?\.Ids \?\? \[\];/.test(broken);
  })(),
);

section('[17] ★★ 「已画几帧」必须是单调计数：窗口计数器会让健康的桌宠读出 0');

check(
  '★★ 舞台心跳报的是 drawnTotal（单调），不是 frames（每 500ms 归零的窗口计数）',
  /frames: \(\) => host\.drawnTotal,/.test(pluginCode)
    && !/frames: \(\) => host\.frames,/.test(pluginCode),
  '/status 上那个字段的读法是「已画 N 帧」，语义就该是累计帧数。'
  + '拿窗口计数器充当它，会造出一个**无法与故障区分**的读数：'
  + '实测一个完全健康的桌宠，被每 5 秒采样一次，读出的是 '
  + '25 → 20 → 16 → 8 → 0 → 25 的锯齿（0 出现两次，连续 10 秒）—— '
  + '而那正是「冻住了」的样子。判据一旦有歧义，就等于没有判据。',
);
check(
  '★★ drawnTotal 只在「真的画了一帧」那一行自增，全仓库没有任何一处清它',
  (pluginCode.match(/host\.drawnTotal \+= 1;/g) ?? []).length === 1
    && !/host\.drawnTotal = 0;/.test(pluginCode)
    && pluginCode.indexOf('host.drawnTotal += 1;') > pluginCode.indexOf('host.frames += 1;'),
  '与 `host.frames += 1` 相邻、排在它后面 —— 两者必须在同一个位置，'
  + '否则「画了帧」这件事就有两个不一致的定义。清零点一处都不许有：'
  + '换模型会清 `host.frames`（换 fps 窗口是对的），但累计数清了就回到有歧义的状态。',
);
check(
  '★★ 三处「已画帧数=…」诊断报文读的都是 drawnTotal',
  (pluginCode.match(/已画帧数=\$\{host\.drawnTotal\}/g) ?? []).length === 3
    && !/已画帧数=\$\{host\.frames\}/.test(pluginCode),
  'frame-blind / frame-hidden / frame-nostart 三条护栏的正文里都写着「已画帧数」，'
  + '而它们原来的取值是窗口计数器 —— 一份自相矛盾的诊断比没有诊断更坏（§8.11）：'
  + '一条说「探针连续读不到像素」的记录里跟着「已画帧数=0」，'
  + '读的人只会得到「一帧都没画」这个错误结论。',
);
check(
  '★★ frames 仍然只用来算 fps（它没有从代码里消失，职责被收窄了）',
  /const fps = \(host\.frames \* 1000\) \/ \(now - host\.windowStart\);/.test(pluginCode)
    && /host\.frames = 0;/.test(pluginCode),
  '窗口计数器本身是对的，错的只是把它当成「画了多少帧」报出去',
);
check(
  '反证 26：把心跳改回报 host.frames，上面第一条断言必须变红',
  (() => {
    const broken = pluginCode.replace(/frames: \(\) => host\.drawnTotal,/, 'frames: () => host.frames,');
    return broken !== pluginCode && /frames: \(\) => host\.frames,/.test(broken);
  })(),
);
check(
  '反证 27：加上一处 drawnTotal 的清零，第二条断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /host\.drawnTotal \+= 1;/,
      'host.drawnTotal += 1;\n        host.drawnTotal = 0;',
    );
    return broken !== pluginCode && /host\.drawnTotal = 0;/.test(broken);
  })(),
);

section('[18] ★★ 眨眼：`create()` 永远不返回 null，所以判 null 等于没判（akari 因此从不眨眼）');

const cubismEyeBlinkPath = resolve(PACKAGE, 'framework/src/effect/cubismeyeblink.ts');
const cubismEyeBlinkSource = readFileSync(cubismEyeBlinkPath, 'utf8');

check(
  '★★ 框架事实：`CubismEyeBlink.create()` 永远 `return new …`，不返回 null',
  /public static create\(/.test(cubismEyeBlinkSource)
    && /return new CubismEyeBlink\(modelSetting\);/.test(cubismEyeBlinkSource),
  'framework/src/effect/cubismeyeblink.ts:24-28。所以「`if (eyeBlink !== null)` 才接」'
  + '是一条**恒真**判 —— 它不提供任何保护，只让人以为提供了保护。',
);
check(
  '★★ 框架事实：参数表为空时更新循环一次都不跑（在这个效果上「空数组」不等于安全）',
  /for \(let i = 0; i < this\._parameterIds\.length; \+\+i\) \{/.test(cubismEyeBlinkSource),
  'framework/src/effect/cubismeyeblink.ts:155，而构造函数 :179-182 在 setting 存在但 '
  + '`getEyeBlinkParameterCount()` 为 0 时给的就是空数组 ⇒ 实例造出来了、挂进调度器了、'
  + '每帧都被调用了，但**一根参数都不会动**。这与 `_CubismMotion` 那边的空数组是两回事：'
  + '那边空数组是解药（避开 null 崩溃），这边空数组是病本身。',
);
check(
  '★★ pet-model.ts 的判据是「有没有真的拿到参数」，不是「有没有造出实例」',
  /if \(eyeBlink\.getParameterIds\(\)\.length === 0\) \{/.test(petModelCode)
    && !/eyeBlink !== null/.test(petModelCode),
  '实测四只模型里 `akari_vts` 是唯一 `Groups.EyeBlink.Ids = []` 的'
  + '（`空` / `miku` / `hiyori_vts` 都声明了真 id）—— 也就是说在这条修掉之前，'
  + '**akari 从来不眨眼**，而面板、能力清单与错误上报里没有任何一处会说这件事。',
);
check(
  '★★ 空参数表要回退到 Cubism 惯例 id，而不是放任它空着',
  /eyeBlink\.setParameterIds\(\[cachedId\('ParamEyeLOpen'\), cachedId\('ParamEyeROpen'\)\]\)/.test(petModelCode),
  '`akari_vts.cdi3.json` 里 `ParamEyeLOpen` / `ParamEyeROpen` **都在**（四个模型的 `Groups` '
  + '与 `cdi3` 我都逐个过了一遍才这么写），所以这两个惯例 id 对她是有意义的。'
  + '不回退的后果不是「少一个装饰」—— 是一只模型**永久不眨眼**，而且没有任何报错。',
);
check(
  '★★ 眨眼仍然只在「动作没在更新这一帧」时才动手',
  /new CubismEyeBlinkUpdater\(\(\) => this\._motionUpdated, eyeBlink\)/.test(petModelCode),
  '这是原有的正确行为，补一条断言是防止修 null 判的时候顺手把它改成常量 —— '
  + '传常量 false 等于宣称「动作永远没在播」，眨眼会盖掉动作里的眼部关键帧。',
);
check(
  '反证 28：把判据换回 `eyeBlink !== null`，第三条断言必须变红',
  (() => {
    const broken = petModelCode.replace(
      /if \(eyeBlink\.getParameterIds\(\)\.length === 0\) \{/,
      'if (eyeBlink !== null) {',
    );
    return broken !== petModelCode && /eyeBlink !== null/.test(broken);
  })(),
);
check(
  '反证 29：把回退那一行删掉，第四条断言必须变红',
  (() => {
    const broken = petModelCode.replace(
      /eyeBlink\.setParameterIds\(\[cachedId\('ParamEyeLOpen'\), cachedId\('ParamEyeROpen'\)\]\);/,
      '',
    );
    return (
      broken !== petModelCode && !/eyeBlink\.setParameterIds\(\[cachedId\('ParamEyeLOpen'\)/.test(broken)
    );
  })(),
);

section('[19] ★★ fps 读数不许撒谎：暂停时必须说「已暂停」，而不是停在最后一次算出的 60');

/*
 * 这一节守的是一个**读数**，不是一个功能。
 *
 * 2026-06 用户报的「她冻住了」里，最误导人的一处不是画面停了 —— 是面板右下角
 * 那个 `60 fps` 还在，指着一片定格说「一切正常」。它由 `drawFrame()` 内部结算，
 * 而页面被判成不可见（隐藏 / 最小化 / 被完全遮挡 —— Chromium 把这三件事里的后
 * 两件算成第一件）时 rAF 暂停、结算不再发生，那个数字就永远停在最后一次的值上。
 *
 * 所以暂停态必须是一个**显式的状态**，而不是「上一次的数字」。判据挂在
 * `visibilitychange` 上：切换那一刻必然送达，不受隐藏页定时器被降频到每分钟
 * 一次的影响；同时在 fps 窗口结算处写回 `paused: false`，让「能画帧」这件事
 * 本身就能自愈任何漏掉的事件。
 */
const fpsPausedLabel = /stats\.paused \? '—（已暂停）' : `\$\{stats\.fps\} fps`/;
const fpsVisibilitySync = /document\.addEventListener\('visibilitychange', sync\)/;
const fpsVisibilityUnsync = /document\.removeEventListener\('visibilitychange', sync\)/;
const fpsResumeOnDraw = /fps: Math\.round\(fps\),[\s\S]{0,40}?paused: false,/;
const fpsPausedInherit = /paused: prev\?\.paused \?\? false,/;
/*
 * ⚠️ 这条谓词只能钉到「`fps` 与 `paused` 都在类型里」为止，**不能**再往下写死
 * `size: string; params: number; core: string` 那一串：`stats` 的类型是会长的
 * （情绪层给它加了 `emotion: string`），写死字段顺序就变成「加一个字段即变红」，
 * 而那不是缺陷。要守的是**这两个字段真的在类型里**（而不是靠 `fps === 0` 猜暂停）。
 */
const fpsStateHasPaused = /const \[stats, setStats\] = useState<\{[\s\S]{0,260}?fps: number;[\s\S]{0,260}?paused: boolean;/;

check(
  '★★ 面板那个 fps 数字有暂停态，暂停时说「已暂停」而不是报出旧值',
  fpsPausedLabel.test(pluginCode),
  'plugin.ts 的面板标签。它守的场景很具体：**页面被暂停时，唯一还在动的指示器'
  + '不能替我们说一切正常**。同一处还有一个必须区分的对照 —— 渲染器活着但画面冻住'
  + '（抛错 / 上下文丢失）时，标签**仍然**会停在旧值上，因为那时页面可见、'
  + '`visibilitychange` 不会来。所以这个暂停态不是万能解释，它只覆盖「浏览器不让画」。',
);
check(
  '★★ 暂停态的判据挂在 `visibilitychange` 上，并且退订干净',
  fpsVisibilitySync.test(pluginCode) && fpsVisibilityUnsync.test(pluginCode),
  '不能用那个 20 秒轮询的 `hiddenTimer` 当判据：隐藏页的定时器被浏览器降频到'
  + '约每分钟一次，用户切回来之后标签可能在「已暂停」上再赖一分钟 —— '
  + '**一个会赖着不走的暂停态，和不会暂停的读数一样坏**。',
);
check(
  '★★ 只要还能结算 fps 窗口，就必须把暂停态改回 false（自愈路径）',
  fpsResumeOnDraw.test(pluginCode),
  '这一行是「事件漏了」的兜底：能走到窗口结算就证明页面正在被画。'
  + '少了它，一次漏掉的 `visibilitychange` 会让标签永久停在「已暂停」，'
  + '而她其实一直在动 —— 修掉一个会撒谎的读数，不能换来另一个。',
);
check(
  '★★ 换模型时暂停态只能继承，不能拍成 false',
  fpsPausedInherit.test(pluginCode),
  '换模型走的是 `setStats({...})` 那条路，不经过任何一帧。若在这里写死 `false`，'
  + '「窗口隐藏期间换了模型」会让标签谎报正在渲染 —— 而它此刻恰恰是暂停的。',
);
check(
  '★★ `stats` 里必须有 `paused` 这个字段（而不是靠 `fps === 0` 猜）',
  fpsStateHasPaused.test(pluginCode),
  '`fps === 0` 至少有两个别的含义：刚换完模型（那一刻 fps 被显式置 0），'
  + '以及窗口刚开还没结算过一次。**用一个有多种含义的值去当判据，'
  + '是这一路上重复犯过的同一个错**（`frames` 的窗口计数器冒充累计数就是上一例）。',
);
check(
  '★★ 那条 frame-hidden 报文要和面板说同一句话（否则它自己就是新的假声明）',
  /fps 标签会显示「—（已暂停）」/.test(pluginCode)
    && !/fps 标签停在最后一次算出的值上/.test(pluginCode),
  '报文的正文是给未来的人读的。改完代码不改它，就等于在日志里留下一条'
  + '与代码相反的说明 —— §8.33 里「面板 fps 标签停在 60」那句话正是这么变成谎话的。',
);
check(
  '反证 30：把标签改回无条件报数字，第一条断言必须变红',
  (() => {
    const broken = pluginCode.replace(fpsPausedLabel, '`${stats.fps} fps`');
    return broken !== pluginCode && !fpsPausedLabel.test(broken);
  })(),
);
check(
  '反证 31：删掉 `visibilitychange` 的登记，第二条断言必须变红',
  (() => {
    const broken = pluginCode.replace(fpsVisibilitySync, 'void sync;');
    return broken !== pluginCode && !fpsVisibilitySync.test(broken);
  })(),
);
check(
  '反证 32：把窗口结算处的 `paused: false` 删掉，第三条断言必须变红',
  (() => {
    const broken = pluginCode.replace(/fps: Math\.round\(fps\),\n(\s*)paused: false,/,
      'fps: Math.round(fps),');
    return broken !== pluginCode && !fpsResumeOnDraw.test(broken);
  })(),
);
check(
  '反证 33：把换模型处的继承改成写死 false，第四条断言必须变红',
  (() => {
    const broken = pluginCode.replace(/paused: prev\?\.paused \?\? false,/, 'paused: false,');
    return broken !== pluginCode && !fpsPausedInherit.test(broken);
  })(),
);

section('[13] ★ 反证：把这几条护栏拆掉，上面的断言必须能红');

check(
  '反证 9：把记账改成无条件（判掉的帧也算画过），那条看门狗断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /if \(drew\) lastDrawnAt = Date\.now\(\);/g,
      'lastDrawnAt = Date.now();',
    );
    return broken !== pluginCode && !/if \(drew\) lastDrawnAt = Date\.now\(\);/.test(broken);
  })(),
);
check(
  '反证 10：把世代号检查换成单纯的 cancelled，那条世代号断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /cancelled \|\| myGen !== tickGen/,
      'cancelled',
    );
    return broken !== pluginCode && !/myGen !== tickGen/.test(broken);
  })(),
);
check(
  '反证 11：把 /pending 换回裸 fetch，那条超时断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /await fetchWithTimeout\(\s*`\$\{ROUTE_PREFIX\}\/pending`,\s*\{ cache: 'no-store' \},\s*POLL_FETCH_TIMEOUT_MS,\s*\)/,
      'await fetch(`${ROUTE_PREFIX}/pending`, { cache: \'no-store\' })',
    );
    return broken !== pluginCode && !/fetchWithTimeout\(\s*`\$\{ROUTE_PREFIX\}\/pending`/.test(broken);
  })(),
);
check(
  '反证 12：把「连续相同才计数」改成无条件累加，那条断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /host\.liveSameStreak = hash === host\.liveHash \? host\.liveSameStreak \+ 1 : 0;/,
      'host.liveSameStreak += 1;',
    );
    return broken !== pluginCode && !/hash === host\.liveHash \? host\.liveSameStreak \+ 1 : 0/.test(broken);
  })(),
);
check(
  '反证 13：删掉「全透明当不知道」那条守卫，对应断言必须变红',
  (() => {
    const broken = pluginCode.replace(/if \(opaque === 0\) \{/, 'if (false) {');
    return broken !== pluginCode && !/if \(opaque === 0\) \{/.test(broken);
  })(),
);
check(
  '反证 14：把模型加载 effect 的依赖退回 [modelPath]，「重建是活的」那条必须变红',
  (() => {
    const broken = pluginCode.replace(/\}, \[modelPath, boot\]\);/, '}, [modelPath]);');
    return broken !== pluginCode && !/\[modelPath, boot\]/.test(broken);
  })(),
);
check(
  '反证 15：把「窗口可见」这个前提塞回自证，「自证不再要求可见」那条必须变红',
  (() => {
    const broken = pluginCode.replace(
      /if \(hash >= 0 && !liveSelfTestSent && host\.liveSamples >= LIVE_SELF_TEST_SAMPLES\) \{/,
      'if (visible && hash >= 0 && !liveSelfTestSent && host.liveSamples >= LIVE_SELF_TEST_SAMPLES) {',
    );
    return broken !== pluginCode && !/if \(hash >= 0 && !liveSelfTestSent/.test(broken);
  })(),
);
check(
  '反证 16：把 sessionStorage 的闸门塞回去，「只认本进程」那条必须变红',
  (() => {
    const broken = pluginCode.replace(
      /let liveSelfTestSent = false;/,
      "let liveSelfTestSent = sessionStorage.getItem('x') !== null;",
    );
    return broken !== pluginCode && /sessionStorage/.test(broken);
  })(),
);
check(
  '反证 17：把「探针瞎了要上报」删掉，对应断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /if \(host\.liveBlindStreak >= LIVE_BLIND_SAMPLES && !host\.liveBlindReported\) \{/,
      'if (false) {',
    );
    return broken !== pluginCode && !/host\.liveBlindStreak >= LIVE_BLIND_SAMPLES/.test(broken);
  })(),
);
check(
  '反证 18：把隐藏看门狗挪进帧循环（rAF 停了它就永远不会执行），那条断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /const hiddenTimer = setInterval\(/,
      'const hiddenTimer = { run: () => setInterval(',
    );
    return broken !== pluginCode && !/const hiddenTimer = setInterval\(/.test(broken);
  })(),
);
check(
  '反证 19：让定时器兜底不再真的画（改成只记时间），那条断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /const drew = drawFrame\(performance\.now\(\)\);/,
      'const drew = true;',
    );
    return broken !== pluginCode && !/drawFrame\(performance\.now\(\)\)/.test(broken);
  })(),
);
check(
  '反证 20：把「一帧都没跑到」那条护栏从定时器改成普通对象（等于永远不执行），对应断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /const startTimer = setInterval\(/,
      'const startTimer = { run: () => setInterval(',
    );
    return broken !== pluginCode && !/const startTimer = setInterval\(/.test(broken);
  })(),
);
check(
  '反证 21：删掉 liveAttempts 的计数，「判据是 liveAttempts」那条必须变红',
  (() => {
    const broken = pluginCode.replace(/host\.liveAttempts \+= 1;/, '');
    return broken !== pluginCode && !/host\.liveAttempts \+= 1;/.test(broken);
  })(),
);
check(
  '反证 22：把计数挪到 frameHashOf 之后（变成「读到像素才算跑过」），对应断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /host\.liveAttempts \+= 1;\n(\s*)if \(host\.liveProbe === null\)/,
      'if (host.liveProbe === null)',
    ).replace(
      /(const hash = frameHashOf\(canvas, host\.liveProbe, diag\);)/,
      '$1\n          host.liveAttempts += 1;',
    );
    if (broken === pluginCode) return false;
    return broken.indexOf('host.liveAttempts += 1;') > broken.indexOf('const hash = frameHashOf(');
  })(),
);
check(
  '反证 23：把「眼睛好了就拔闩」那行删掉，对应断言必须变红',
  (() => {
    const broken = pluginCode.replace(/host\.liveBlindReported = false;/, '');
    return broken !== pluginCode && !/host\.liveBlindReported = false;/.test(broken);
  })(),
);


// ───────────────────────────────────────────────────────────────────────────
console.log('');
if (failed > 0) {
  console.log(`[15] FRAME BUDGET GATE FAILED —— ${failed} 项失败，${passed} 项通过`);
  process.exit(1);
}
console.log(`[16] FRAME BUDGET GATE PASSED —— ${passed} 项断言全绿`);
