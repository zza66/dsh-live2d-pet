/**
 * 窗口形态（固定 / 浮动）的**纯逻辑**。
 *
 * 为什么单独一个文件：这一层的每条规则都值得被门禁**执行**一遍
 * （`tools/test-window-mode.mjs` 直接 import 这个模块），而不是只读源码形状。
 * 规则里最容易错的两件事都在这里，而且都只靠类型系统抓不到：
 *
 *   - **夹边**：窗口被拖到视口外以后还能不能拖回来；
 *   - **持久化的容错**：`localStorage` 里可能是上一版留下的、被手改过的、
 *     甚至是 `"undefined"` 的字符串，读出来必须永远是一个能用的矩形。
 *
 * 这个文件不 import 任何东西（React / DOM / 存储都不碰），所以门禁拿到的
 * 就是浏览器里跑的那一份代码，不是它的复制品。
 *
 * 两种形态的语义（用户第 1 条要求）：
 *   - `fixed`  —— 钉在右下角的那张卡片，尺寸由 CSS 决定，**不可拖动**（默认）；
 *   - `float`  —— 页面内可以拖到任意位置、可以拉角改大小的横屏窗口。
 *
 * 两者**同时只存在一个**：形态是同一份状态里的一个字段，没有「两个窗口」，
 * 所以切形态不会重建任何东西（模型的动作与表情因此不会被重置）。
 */

/** 窗口形态。 */
export type WindowMode = 'fixed' | 'float';

/** 浮动窗口的矩形（屏幕 CSS 像素）。 */
export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 持久化的完整状态：形态 + 浮动窗口的矩形。 */
export interface WindowState extends FloatRect {
  mode: WindowMode;
}

/** 视口尺寸（`window.innerWidth/innerHeight` 的形状，便于门禁构造）。 */
export interface Viewport {
  w: number;
  h: number;
}

/** 浮动窗口的最小宽度。再窄的话右侧那 20% 的边栏就放不下一个字了。 */
export const MIN_FLOAT_W = 420;
/** 浮动窗口的最小高度。 */
export const MIN_FLOAT_H = 280;
/** 第一次切到浮动时的默认尺寸（横屏）。 */
export const DEFAULT_FLOAT_W = 820;
export const DEFAULT_FLOAT_H = 480;

/**
 * 窗口被拖出去时，至少还要留在视口里的横向宽度。
 *
 * 这个数字是**能把窗口拖回来的最小保证**：标题栏露出 120px 就够点到它。
 * 不留反而更糟 —— 拖到屏幕外面之后，用户唯一的办法是刷新页面（形态是持久化的，
 * 刷新回来还在原处，于是彻底卡死）。
 */
export const KEEP_VISIBLE_X = 120;
/** 纵向同理：标题栏必须留在视口里，否则一样拖不回来。 */
export const KEEP_VISIBLE_Y = 36;

/** 默认位置离视口右下角的留白。 */
export const VIEWPORT_MARGIN = 24;

/** `localStorage` 里的键。和设置、模型记忆分开，互不影响。 */
export const WINDOW_STORAGE_KEY = 'dsh-live2d-pet.window';

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function saneViewport(viewport: Viewport | null | undefined): Viewport {
  const w = finite(viewport?.w, 0) > 0 ? Number(viewport?.w) : 1024;
  const h = finite(viewport?.h, 0) > 0 ? Number(viewport?.h) : 768;
  return { w, h };
}

/** 任何输入 → 合法的形态。认不出来的当 `fixed`（默认形态，不会把用户困住）。 */
export function parseWindowMode(value: unknown): WindowMode {
  return value === 'float' ? 'float' : 'fixed';
}

/**
 * 把矩形夹进视口。
 *
 * 三条规则，缺一条都会留下一种「拖不回来」的死局：
 *   1. 尺寸不超过视口（否则横向的滚动条都没了，右下角的拉角也出不去）；
 *   2. 左边界不能超过 `视口宽 - KEEP_VISIBLE_X`，右边界不能小于 `KEEP_VISIBLE_X - 宽`；
 *   3. 上边界夹在 `[0, 视口高 - KEEP_VISIBLE_Y]`。
 *
 * 尺寸和位置都夹，而不是二选一：只夹位置的话，一个「宽 3000 的窗口」仍然会
 * 有一半在屏幕外，而那时它的拉角正好在屏幕外 —— 用户没法把它拉小。
 */
export function clampFloatRect(rect: FloatRect, viewport: Viewport | null | undefined): FloatRect {
  const { w: vw, h: vh } = saneViewport(viewport);
  const w = Math.min(Math.max(MIN_FLOAT_W, finite(rect?.w, DEFAULT_FLOAT_W)), Math.max(MIN_FLOAT_W, vw));
  const h = Math.min(Math.max(MIN_FLOAT_H, finite(rect?.h, DEFAULT_FLOAT_H)), Math.max(MIN_FLOAT_H, vh));
  const x = Math.min(Math.max(finite(rect?.x, vw - w - VIEWPORT_MARGIN), KEEP_VISIBLE_X - w), vw - KEEP_VISIBLE_X);
  const y = Math.min(Math.max(finite(rect?.y, vh - h - VIEWPORT_MARGIN), 0), Math.max(0, vh - KEEP_VISIBLE_Y));
  return { x, y, w, h };
}

/**
 * 第一次切到浮动时的默认位置：右下角、留 24px。
 *
 * 选右下角是因为**固定形态就在那儿** —— 切形态时窗口不动，用户看到的只是
 * 它变宽、变横、边栏跑到右边去，而不是「窗口跳到了别处」。
 */
export function defaultFloatRect(viewport: Viewport | null | undefined): FloatRect {
  const { w: vw, h: vh } = saneViewport(viewport);
  const w = Math.max(MIN_FLOAT_W, Math.min(DEFAULT_FLOAT_W, vw - VIEWPORT_MARGIN * 2));
  const h = Math.max(MIN_FLOAT_H, Math.min(DEFAULT_FLOAT_H, vh - VIEWPORT_MARGIN * 2));
  return clampFloatRect({ x: vw - w - VIEWPORT_MARGIN, y: vh - h - VIEWPORT_MARGIN, w, h }, viewport);
}

/**
 * 从 `localStorage` 的原始字符串恢复状态。
 *
 * 永远返回一个能用的状态：坏 JSON、旧版本字段、手改出来的 `NaN` 都退化成
 * 「固定形态 + 默认浮动矩形」。**不抛异常**——这段代码在渲染路径上（`useState`
 * 的初始化函数），抛出去等于整张卡片白屏，而丢失窗口位置这种小事不配让桌宠消失。
 */
export function parseWindowState(raw: string | null | undefined, viewport: Viewport | null | undefined): WindowState {
  let data: unknown = null;
  if (typeof raw === 'string' && raw !== '') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  const record = (data !== null && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const rect = clampFloatRect(
    { x: finite(record.x, Number.NaN), y: finite(record.y, Number.NaN), w: finite(record.w, DEFAULT_FLOAT_W), h: finite(record.h, DEFAULT_FLOAT_H) },
    viewport,
  );
  // `finite(..., NaN)` 的用意：字段缺失时 `clampFloatRect` 会自己回落到默认位置，
  // 而不是把它当成 0 —— 0,0 是「左上角」，那不是任何一个用户选过的地方。
  return { mode: parseWindowMode(record.mode), ...rect };
}

/** 状态 → `localStorage` 字符串。取整是为了别把亚像素抖动写进存储。 */
export function serializeWindowState(state: WindowState): string {
  return JSON.stringify({
    mode: parseWindowMode(state?.mode),
    x: Math.round(finite(state?.x, 0)),
    y: Math.round(finite(state?.y, 0)),
    w: Math.round(finite(state?.w, DEFAULT_FLOAT_W)),
    h: Math.round(finite(state?.h, DEFAULT_FLOAT_H)),
  });
}

/**
 * 拖动标题栏之后的新矩形。
 *
 * 单独抽出来是因为它是**唯一会改横纵两个方向、又要立刻夹边**的地方；
 * 调用点（`plugin.ts` 的 pointermove）只负责把指针位移喂进来。
 */
export function moveFloatRect(start: FloatRect, dx: number, dy: number, viewport: Viewport | null | undefined): FloatRect {
  return clampFloatRect({ ...start, x: start.x + finite(dx, 0), y: start.y + finite(dy, 0) }, viewport);
}

/**
 * 拉右下角改大小。
 *
 * 只让右下角动（左上角固定）是有意的：拖动位置与改变大小用两个不同的手势，
 * 混在一起的话，「往右下拖」既可能是移动也可能是放大，全看起了多大。
 */
export function resizeFloatRect(start: FloatRect, dx: number, dy: number, viewport: Viewport | null | undefined): FloatRect {
  return clampFloatRect({ x: start.x, y: start.y, w: start.w + finite(dx, 0), h: start.h + finite(dy, 0) }, viewport);
}

/**
 * 收起之后的横条宽度：**与固定形态的卡片同宽**（`plugin.ts` 里 `.dsh-l2d-card`
 * 的 268px）。两处必须一致，否则「收起」在两种形态之间会换一个长度。
 *
 * 不把它算成 `min(268, 视口宽)` 那种自适应：横条里只有标题和两个按钮，
 * 它不需要跟着视口变宽，也不需要变窄 —— 它需要的是和另一形态看起来是同一件东西。
 */
export const COLLAPSED_BAR_W = 268;

/**
 * 收起之后横条的高度。
 *
 * 这个数**只用于夹边计算**，不写进样式：真实高度由标题栏的内容撑出来
 * （padding 8 + 一行字 + 下边框，约 38px）。写死进样式的话，用户改了字号
 * 或系统缩放了，横条就会把标题栏裁掉一半 —— 而标题栏是唯一的「展开」入口。
 */
export const COLLAPSED_BAR_H = 38;

/**
 * 收起形态的矩形：宽度固定、高度为标题栏，位置夹到**整条都在视口里**。
 *
 * 与 `clampFloatRect()` 的规则不同，这里有意的更严：那个函数只保证「至少
 * 露 120px 以便拖回来」（那是给一个大窗口用的），而一条 268px 的横条一旦
 * 只剩 120px 露在外面，标题栏右端那两个按钮（切形态 / 展开）就全在屏幕外了 ——
 * 用户能看见它，却点不到它。所以这里要求整条可见。
 *
 * 位置从**收起来之前的左上角**算起，所以「收起」不会把窗口挪走，只是把它缩成
 * 一条横杠（这也是用户报的那个：「收了但没收回去」）。
 */
export function fitCollapsedBar(rect: FloatRect | null | undefined, viewport: Viewport | null | undefined): FloatRect {
  const { w: vw, h: vh } = saneViewport(viewport);
  const w = Math.min(COLLAPSED_BAR_W, Math.max(0, vw));
  const h = COLLAPSED_BAR_H;
  const x = Math.min(Math.max(finite(rect?.x, vw - w - VIEWPORT_MARGIN), 0), Math.max(0, vw - w));
  const y = Math.min(Math.max(finite(rect?.y, vh - h - VIEWPORT_MARGIN), 0), Math.max(0, vh - h));
  return { x, y, w, h };
}
