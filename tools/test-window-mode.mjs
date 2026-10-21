#!/usr/bin/env node
/**
 * 门禁：**两种窗口形态的纯逻辑**（`lib/test/window-mode.mjs` ＝ `src/client/window-mode.ts`）。
 *
 * ## 为什么需要这个文件
 *
 * 用户的第一条要求是「窗口有两种形态」：钉在右下角的那张卡片（`fixed`），
 * 和页面里可以拖动、可以拉角的横屏窗口（`float`）。这一层里**全是算术和容错**，
 * 而它们错起来不会有任何报错，只会留下三种很难查的死局：
 *
 *   1. 夹边少一条 —— 窗口被拖出视口之后就再也拖不回来。更糟的是位置是**持久化**的：
 *      刷新页面回来还在屏幕外，用户唯一的出路是清掉 localStorage。
 *   2. 尺寸不夹 —— 一个「宽 3000」的窗口，右下角的拉角正好在屏幕外，没法拉小。
 *   3. 持久化不做容错 —— 一条被手改坏的 `localStorage` 就能让整张卡片白屏
 *      （这段代码在渲染路径上），而成品看起来像「这插件抽风了」。
 *
 * 三种症状都不像 bug，所以它们必须被**执行**，而不是被读一遍源码确认。
 *
 * ## 结构
 *
 * [2]–[7] 对真代码断言；[8] 把真实产物里的守卫**弄坏**再用 `data:` URL 重新
 * import，断言同一个谓词为假 —— 于是「这条断言有牙」本身也被验证了
 * （一条恒真的断言在报告里与一条有效的断言长得完全一样）。
 *
 * ## 用法
 *
 *     node tools/test-window-mode.mjs     （离线：无网络、无 DOM）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(packageRoot, 'lib/test/window-mode.mjs');

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
  console.error(`窗口形态的测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const {
  MIN_FLOAT_W,
  MIN_FLOAT_H,
  DEFAULT_FLOAT_W,
  DEFAULT_FLOAT_H,
  KEEP_VISIBLE_X,
  KEEP_VISIBLE_Y,
  VIEWPORT_MARGIN,
  WINDOW_STORAGE_KEY,
  COLLAPSED_BAR_W,
  COLLAPSED_BAR_H,
  parseWindowMode,
  clampFloatRect,
  defaultFloatRect,
  fitCollapsedBar,
  parseWindowState,
  serializeWindowState,
  moveFloatRect,
  resizeFloatRect,
} = mod;

const VIEW = { w: 1280, h: 800 };

/* ══════════════════════════════════════════════════════════════════════════
 * [1] 常量本身
 * ══════════════════════════════════════════════════════════════════════════ */

section('[1] 常量：夹边余量与最小尺寸都是「够用但不离谱」的数');

check(`KEEP_VISIBLE_X 是正数且小于一屏（${KEEP_VISIBLE_X}）`, KEEP_VISIBLE_X > 0 && KEEP_VISIBLE_X < VIEW.w);
check(`KEEP_VISIBLE_Y 是正数且够点到标题栏（${KEEP_VISIBLE_Y}）`, KEEP_VISIBLE_Y >= 24 && KEEP_VISIBLE_Y <= 80);
check(`最小尺寸小于默认尺寸（${MIN_FLOAT_W}×${MIN_FLOAT_H} < ${DEFAULT_FLOAT_W}×${DEFAULT_FLOAT_H}）`, MIN_FLOAT_W < DEFAULT_FLOAT_W && MIN_FLOAT_H < DEFAULT_FLOAT_H);
check('默认尺寸是横屏（宽 > 高）', DEFAULT_FLOAT_W > DEFAULT_FLOAT_H);
check(`存储键与设置、模型记忆分开（${WINDOW_STORAGE_KEY}）`, WINDOW_STORAGE_KEY === 'dsh-live2d-pet.window');

/* ══════════════════════════════════════════════════════════════════════════
 * [2] 形态解析：认不出来的一律当 fixed
 * ══════════════════════════════════════════════════════════════════════════ */

section('[2] parseWindowMode：只有一个值能进浮动形态，其余全部是固定形态');

check("'float' → float", parseWindowMode('float') === 'float');
check("'fixed' → fixed", parseWindowMode('fixed') === 'fixed');
check("认不出来的（'FLOAT' / 42 / null / undefined / '' / {}）全部 → fixed（不把用户困在浮动形态里）",
  ['FLOAT', 'Float', 42, null, undefined, '', {}, [], true].every((v) => parseWindowMode(v) === 'fixed'));

/* ══════════════════════════════════════════════════════════════════════════
 * [3] 夹边：三条规则各自挡掉一种「拖不回来」
 * ══════════════════════════════════════════════════════════════════════════ */

section('[3] clampFloatRect：尺寸先夹、位置再夹，任何输入都得到一个能用的矩形');

const tiny = clampFloatRect({ x: 0, y: 0, w: 10, h: 10 }, VIEW);
check(`太小的尺寸被抬到最小尺寸（${tiny.w}×${tiny.h}）`, tiny.w === MIN_FLOAT_W && tiny.h === MIN_FLOAT_H);

const huge = clampFloatRect({ x: 0, y: 0, w: 9999, h: 9999 }, VIEW);
check(`太大的尺寸被压到视口内（${huge.w}×${huge.h}）`, huge.w === VIEW.w && huge.h === VIEW.h);

const rightOut = clampFloatRect({ x: 9999, y: 0, w: 420, h: 300 }, VIEW);
check(`拖到右侧外面：左边界停在「视口宽 − ${KEEP_VISIBLE_X}」（x=${rightOut.x}）`, rightOut.x === VIEW.w - KEEP_VISIBLE_X);

const leftOut = clampFloatRect({ x: -9999, y: 0, w: 420, h: 300 }, VIEW);
check(`拖到左侧外面：右边界停在「${KEEP_VISIBLE_X}」（x=${leftOut.x}）`, leftOut.x === KEEP_VISIBLE_X - 420);

const downOut = clampFloatRect({ x: 0, y: 9999, w: 420, h: 300 }, VIEW);
check(`拖到下方外面：上边界停在「视口高 − ${KEEP_VISIBLE_Y}」（y=${downOut.y}）`, downOut.y === VIEW.h - KEEP_VISIBLE_Y);

const upOut = clampFloatRect({ x: 0, y: -9999, w: 420, h: 300 }, VIEW);
check('拖到上方外面：上边界停在 0（标题栏不许出视口）', upOut.y === 0);

const junk = clampFloatRect({ x: Number.NaN, y: Number.POSITIVE_INFINITY, w: undefined, h: 'wide' }, VIEW);
check('坏数字（NaN / Infinity / undefined / 字符串）不炸，全部落成有限数',
  [junk.x, junk.y, junk.w, junk.h].every((v) => typeof v === 'number' && Number.isFinite(v)));
check('坏数字的尺寸落在最小尺寸与视口之间', junk.w >= MIN_FLOAT_W && junk.w <= VIEW.w && junk.h >= MIN_FLOAT_H && junk.h <= VIEW.h);

const noViewport = clampFloatRect({ x: 5000, y: 5000, w: 420, h: 300 }, null);
check('没有视口（null）也有兜底（不返回 NaN）',
  [noViewport.x, noViewport.y, noViewport.w, noViewport.h].every((v) => Number.isFinite(v)));

const pinched = clampFloatRect({ x: 0, y: 0, w: 420, h: 300 }, { w: 200, h: 150 });
check('视口比最小窗口还小的时候不产生负数尺寸',
  pinched.w > 0 && pinched.h > 0 && pinched.x >= KEEP_VISIBLE_X - pinched.w);

/* ══════════════════════════════════════════════════════════════════════════
 * [4] 默认矩形：右下角、留白、已夹过
 * ══════════════════════════════════════════════════════════════════════════ */

section('[4] defaultFloatRect：第一次切到浮动时落在右下角（固定形态本来就在那儿）');

const first = defaultFloatRect(VIEW);
check(`默认尺寸是 ${DEFAULT_FLOAT_W}×${DEFAULT_FLOAT_H}`, first.w === DEFAULT_FLOAT_W && first.h === DEFAULT_FLOAT_H);
check(`右边缘离视口留 ${VIEWPORT_MARGIN}px`, first.x + first.w === VIEW.w - VIEWPORT_MARGIN);
check(`下边缘离视口留 ${VIEWPORT_MARGIN}px`, first.y + first.h === VIEW.h - VIEWPORT_MARGIN);
check('默认矩形自己已经夹过（再夹一次不变）',
  JSON.stringify(clampFloatRect(first, VIEW)) === JSON.stringify(first));

const smallView = defaultFloatRect({ w: 500, h: 320 });
check('小视口下默认尺寸收得进去（不超出视口）', smallView.w <= 500 && smallView.h <= 320 && smallView.w >= MIN_FLOAT_W);

/* ══════════════════════════════════════════════════════════════════════════
 * [5] 持久化：读回来的永远能用，写下去的能读回来
 * ══════════════════════════════════════════════════════════════════════════ */

section('[5] parseWindowState / serializeWindowState：一条手改坏的存储不许让卡片白屏');

const fresh = parseWindowState(null, VIEW);
check('没有存过 → 固定形态', fresh.mode === 'fixed');
check('没有存过 → 浮动矩形是默认矩形',
  JSON.stringify({ x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h }) === JSON.stringify(defaultFloatRect(VIEW)));

check("坏 JSON（'{' / 'undefined' / 'null'）不抛，退回固定形态",
  ['{', 'undefined', 'null', 'not json', ''].every((raw) => parseWindowState(raw, VIEW).mode === 'fixed'));

const stored = parseWindowState(JSON.stringify({ mode: 'float', x: 100, y: 80, w: 700, h: 460 }), VIEW);
check('正常存过的状态原样读回来',
  stored.mode === 'float' && stored.x === 100 && stored.y === 80 && stored.w === 700 && stored.h === 460);

const wild = parseWindowState(JSON.stringify({ mode: 'float', x: 1e9, y: -1e9, w: 'wide', h: null }), VIEW);
check('越界与坏字段被夹成能用的矩形（不是 NaN，也不是 Infinity）',
  [wild.x, wild.y, wild.w, wild.h].every((v) => Number.isFinite(v)) &&
  wild.y === 0 && wild.x === VIEW.w - KEEP_VISIBLE_X);

const round = { mode: 'float', x: 120, y: 90, w: 640, h: 400 };
check('写下去再读回来是同一个矩形',
  JSON.stringify(parseWindowState(serializeWindowState(round), VIEW)) === JSON.stringify(round));

check('写下去的是整数（不把亚像素抖动写进存储）',
  serializeWindowState({ mode: 'float', x: 10.4, y: 20.6, w: 640.5, h: 400.2 }).includes('"x":10'));

check('坏状态序列化也不抛', typeof serializeWindowState({ mode: 'float', x: Number.NaN, y: null, w: undefined, h: 'x' }) === 'string');
check('坏状态序列化之后仍能被读回来',
  parseWindowState(serializeWindowState({ mode: 'float', x: Number.NaN, y: null, w: undefined, h: 'x' }), VIEW).mode === 'float');

/* ══════════════════════════════════════════════════════════════════════════
 * [6] 拖动与拉角
 * ══════════════════════════════════════════════════════════════════════════ */

section('[6] moveFloatRect / resizeFloatRect：手势与夹边各管一段');

const start = { x: 300, y: 200, w: 640, h: 400 };
const moved = moveFloatRect(start, 50, -30, VIEW);
check('拖动是纯位移（尺寸不变、位置按增量走）',
  moved.x === 350 && moved.y === 170 && moved.w === 640 && moved.h === 400);

const dragOut = moveFloatRect(start, 9999, 9999, VIEW);
check('拖出右下角时被夹住（不是消失）',
  dragOut.x === VIEW.w - KEEP_VISIBLE_X && dragOut.y === VIEW.h - KEEP_VISIBLE_Y);

const dragZero = moveFloatRect(start, Number.NaN, undefined, VIEW);
check('坏增量（NaN / undefined）当作 0，窗口不跳', dragZero.x === start.x && dragZero.y === start.y);

const grown = resizeFloatRect(start, 100, 50, VIEW);
check('拉角只改右下角（左上角不动）',
  grown.x === start.x && grown.y === start.y && grown.w === start.w + 100 && grown.h === start.h + 50);

const shrunk = resizeFloatRect(start, -9999, -9999, VIEW);
check('拉到比最小尺寸还小时停在最小尺寸',
  shrunk.w === MIN_FLOAT_W && shrunk.h === MIN_FLOAT_H && shrunk.x === start.x);

const grownOut = resizeFloatRect(start, 9999, 9999, VIEW);
check('拉到比视口还大时，尺寸停在视口内、而且窗口仍留在屏幕上（还能被拖回来）',
  grownOut.w === VIEW.w && grownOut.h === VIEW.h &&
  grownOut.x <= VIEW.w - KEEP_VISIBLE_X && grownOut.x + grownOut.w >= KEEP_VISIBLE_X);

/* ══════════════════════════════════════════════════════════════════════════
 * [7] 收起形态：一条只有标题栏的横条
 * ══════════════════════════════════════════════════════════════════════════ */

section('[7] fitCollapsedBar：收起之后是宽度固定、整条可见的横条（不是「清空了但仍然占着原位置」）');

const bar = fitCollapsedBar({ x: 300, y: 200, w: 820, h: 480 }, VIEW);
check(`尺寸换成横条的 ${COLLAPSED_BAR_W}×${COLLAPSED_BAR_H}（与固定形态的卡片同宽）`,
  bar.w === COLLAPSED_BAR_W && bar.h === COLLAPSED_BAR_H);
check('位置照旧（收起来是缩小，不是搬家）', bar.x === 300 && bar.y === 200);

const barRight = fitCollapsedBar({ x: VIEW.w - KEEP_VISIBLE_X, y: 0, w: 820, h: 480 }, VIEW);
check(`原来贴在右边缘（只露 ${KEEP_VISIBLE_X}px）时，横条被推回整条可见：右边界 = 视口宽（x=${barRight.x}）`,
  barRight.x + barRight.w === VIEW.w);

const barLeft = fitCollapsedBar({ x: -500, y: -500, w: 820, h: 480 }, VIEW);
check('跑到左上角外面时夹回 0,0（标题栏不许出视口）', barLeft.x === 0 && barLeft.y === 0);

const barDown = fitCollapsedBar({ x: 0, y: 9999, w: 820, h: 480 }, VIEW);
check(`跑到下面外面时，下边界停在视口底（y=${barDown.y}）`, barDown.y + barDown.h === VIEW.h);

const barJunk = fitCollapsedBar({ x: Number.NaN, y: Number.POSITIVE_INFINITY, w: 'x', h: null }, VIEW);
check('坏数字不炸，落成有限数且仍在视口内',
  [barJunk.x, barJunk.y, barJunk.w, barJunk.h].every((v) => Number.isFinite(v)) &&
  barJunk.x >= 0 && barJunk.y >= 0 && barJunk.x + barJunk.w <= VIEW.w && barJunk.y + barJunk.h <= VIEW.h);

const barTiny = fitCollapsedBar({ x: 50, y: 50, w: 820, h: 480 }, { w: 200, h: 100 });
check('视口比横条还窄的时候，宽度收到视口宽（不出横向滚动条、不产生负数）',
  barTiny.w === 200 && barTiny.x === 0 && barTiny.y + barTiny.h <= 100);

const barNoView = fitCollapsedBar({ x: 5000, y: 5000, w: 820, h: 480 }, null);
check('没有视口（null）也有兜底（不返回 NaN）',
  [barNoView.x, barNoView.y, barNoView.w, barNoView.h].every((v) => Number.isFinite(v)));

/* ══════════════════════════════════════════════════════════════════════════
 * [8] 反证：把守卫弄坏，同一个谓词必须变假
 * ══════════════════════════════════════════════════════════════════════════ */
section('[8] 反证：产物里的守卫真的在起作用（不是恒真的断言）');

const artifactSource = readFileSync(modulePath, 'utf8');

async function importMutated(source, tag) {
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}#${tag}`;
  return import(url);
}

/**
 * 找产物里那条常量声明的原文。
 *
 * 不写死 `const` 前缀：bundle 出来是 `var`（esbuild 打包时的提升），
 * 而这条断言要钉的是「有这个数」，不是「用的是哪个声明关键字」。
 */
function declarationNeedle(source, name, value) {
  const match = new RegExp(`(var|const|let) ${name} = ${value};`).exec(source);
  return match === null ? null : match[0];
}

const yGuardNeedle = declarationNeedle(artifactSource, 'KEEP_VISIBLE_Y', KEEP_VISIBLE_Y);
check('反证前提：产物里能找到 KEEP_VISIBLE_Y 那个常量（找不到说明产物形状变了，改这条断言）',
  yGuardNeedle !== null, yGuardNeedle ?? '未找到');

if (yGuardNeedle !== null) {
  const brokenY = await importMutated(artifactSource.replace(yGuardNeedle, yGuardNeedle.replace(/= \d+;/, '= 0;')), 'cp-y');
  const brokenDown = brokenY.clampFloatRect({ x: 0, y: 9999, w: 420, h: 300 }, VIEW);
  check('退化 1：把「标题栏留在视口里」的余量改成 0 之后，窗口能整条滑出下边（本门禁会红）',
    brokenDown.y !== VIEW.h - KEEP_VISIBLE_Y && brokenDown.y === VIEW.h);
}

const minWidthNeedle = declarationNeedle(artifactSource, 'MIN_FLOAT_W', MIN_FLOAT_W);
check('反证前提：产物里能找到 MIN_FLOAT_W 那个常量', minWidthNeedle !== null, minWidthNeedle ?? '未找到');

if (minWidthNeedle !== null) {
  const brokenW = await importMutated(artifactSource.replace(minWidthNeedle, minWidthNeedle.replace(/= \d+;/, '= 1;')), 'cp-w');
  const thinWindow = brokenW.clampFloatRect({ x: 0, y: 0, w: 10, h: 10 }, VIEW);
  check('退化 2：把最小宽度改成 1 之后，窗口能被缩成一条缝（右边栏挤没了）',
    thinWindow.w === 10 && thinWindow.w < MIN_FLOAT_W);
}

const barWidthNeedle = declarationNeedle(artifactSource, 'COLLAPSED_BAR_W', COLLAPSED_BAR_W);
check('反证前提：产物里能找到 COLLAPSED_BAR_W 那个常量', barWidthNeedle !== null, barWidthNeedle ?? '未找到');

if (barWidthNeedle !== null) {
  const brokenBar = await importMutated(artifactSource.replace(barWidthNeedle, barWidthNeedle.replace(/= \d+;/, '= 9999;')), 'cp-bar');
  const wideBar = brokenBar.fitCollapsedBar({ x: 300, y: 200, w: 820, h: 480 }, VIEW);
  check('退化 3：把横条宽度改成 9999 之后，收起的窗口变成整屏宽（这里的 268 真的是它撑着的）',
    wideBar.w === VIEW.w && wideBar.w !== COLLAPSED_BAR_W);
}

/* ══════════════════════════════════════════════════════════════════════════
 * [9] 调用点：这一层真的被面板用上了
 * ══════════════════════════════════════════════════════════════════════════ */

section('[9] 调用点（源码级，只读文件找关键字）');

const pluginSource = readFileSync(resolve(packageRoot, 'src/client/plugin.ts'), 'utf8');

check('面板 import 了这个模块', /from '\.\/window-mode'/.test(pluginSource));
check('切换形态用的是 toggle（只改一个字段，不重建画布）', /toggleMode/.test(pluginSource));
check('拖动标题栏用的是 moveFloatRect', /moveFloatRect\(/.test(pluginSource));
check('拉角用的是 resizeFloatRect', /resizeFloatRect\(/.test(pluginSource));
check('读状态用的是 parseWindowState', /parseWindowState\(/.test(pluginSource));
check('写状态用的是 serializeWindowState', /serializeWindowState\(/.test(pluginSource));
check('形态写在 DOM 上（CSS 才分得开两种形态）', /'data-mode': win\.mode/.test(pluginSource));
check('浮动形态是 8:2 的横排（舞台 flex 8、边栏 flex 2，gap 归零所以比例是精确的）',
  /flex:\s*8 1 0/.test(pluginSource) && /flex:\s*2 1 0/.test(pluginSource));
check('横排只在浮动形态生效（固定形态下两层是 display: contents）',
  /\.dsh-l2d-main, \.dsh-l2d-side \{ display: contents; \}/.test(pluginSource));
check('收起形态写在 DOM 上（CSS 才分得开「收起的横条」与「展开的窗口」）',
  /'data-collapsed': collapsed \? '1' : '0'/.test(pluginSource));
check('收起时用的是 fitCollapsedBar（横条位置是算出来的，不是写回 win 的）',
  /fitCollapsedBar\(/.test(pluginSource));
check('收起时是收起成横条，不是「清空了内容但窗口还在原地空着」',
  /\[data-mode="float"\]\[data-collapsed="1"\] \.dsh-l2d-card \{[^}]*height: auto/.test(pluginSource));
check('收起时不画右下角拉角（横条没有「变大」这件事）',
  /win\.mode === 'float' && !collapsed/.test(pluginSource));

/*
 * 开场形态（用户 2026-06 追加的要求）：**每次刷新或重启 DSH 之后，插件的形态都是
 * 收起的固定窗口**。这是一条「不还原历史」的规则，所以它由两处「不读」共同成立，
 * 少任何一处都会被 localStorage 里的旧值翻盘：
 *   · `collapsed` 初始值写死为 `true`，不读 collapsed 键；
 *   · `win` 解析完立刻把 `mode` 改回 `'fixed'`（位置/大小照旧保留）。
 *
 * 反证：把这两处分别还原成「读存储」的写法，用同一组判据再测一遍 —— 必须变红，
 * 否则这些正则只是在匹配注释里的字。
 */
const initialCollapsed = /const \[collapsed, setCollapsed\] = useState<boolean>\(true\)/;
/*
 * 只认**初始化那一行**：`{ ...parseWindowState(…), mode: 'fixed' }`。不能用
 * 「文件里存在 `mode: 'fixed' }`」这种判据 —— `toggleMode` 里也有一处
 * `{ ...prev, mode: 'fixed' }`，它会替初始化那行作证。
 */
const winInitAt = pluginSource.indexOf('const [win, setWin]');
const winInit = winInitAt < 0 ? '' : pluginSource.slice(winInitAt, winInitAt + 600);
const forceFixed = /parseWindowState\([\s\S]{0,120}?mode: 'fixed' \}/;
check('开场就是收起（collapsed 初始值为 true，不读上一次的展开状态）', initialCollapsed.test(pluginSource));
check('开场强制固定形态（初始化的那一行解析完把 mode 改回 fixed）', forceFixed.test(winInit));
check('不再往 localStorage 写 collapsed（读的人已经没了，写就是脏数据）',
  !/localStorage\.setItem\('dsh-live2d-pet\.collapsed'/.test(pluginSource));
check('也不从 localStorage 读 collapsed', !/localStorage\.getItem\('dsh-live2d-pet\.collapsed'/.test(pluginSource));

const regressedCollapsed = pluginSource.replace(
  'useState<boolean>(true)',
  "useState<boolean>(() => localStorage.getItem('dsh-live2d-pet.collapsed') === '1')",
);
check('反证：把 collapsed 改回读存储后，开场收起这条判据必须变红', !initialCollapsed.test(regressedCollapsed));

const regressedMode = winInit.replace(", mode: 'fixed' }", ' }');
check('反证：把初始化的强制 fixed 去掉之后，这条判据必须变红', !forceFixed.test(regressedMode));

/* ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✔' : '✘'} WINDOW MODE GATE —— ${passed} 项通过、${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
