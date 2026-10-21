/**
 * 舞台视图（模型在舞台里的缩放与平移）的**纯逻辑**。
 *
 * 用户的第 4、5 条要求：可以用鼠标调模型的大小与位置；超出边框的部分被挡住；
 * 调的时候模型照常做动作、照常播表情 —— 只是大小和位置在变。
 *
 * ## 为什么单独一个文件
 *
 * 这里全是算术，而且**每一条错法都是静默的**：
 *
 *   - 夹取漏掉缩放上限：滚轮一路滚下去，模型变成一个像素；
 *   - 平移不做夹取：模型被拖出舞台之后就再也拖不回来（舞台是 `overflow: hidden`，
 *     拖出去的东西**看不见也点不到**）；
 *   - 持久化不夹取：`localStorage` 里留着一个「缩放 0.01」的值，刷新回来
 *     模型就没了，而面板上一切正常。
 *
 * 所以这一层值得被门禁**执行**（`tools/test-stage-view.mjs`），而不是读一遍源码。
 *
 * ## 坐标系约定（只在这里定义一次）
 *
 * `panX` / `panY` 的单位是**舞台宽/高的小数**，不是像素 —— 舞台会随窗口形态
 * 变宽变窄，像素值一刷新就对不上，小数不会。屏幕方向：`panX > 0` 表示模型
 * 向右移，`panY > 0` 表示向下移；转成 NDC 时纵轴要取反（NDC 的 y 向上）。
 *
 * 这个文件不 import 任何东西，所以门禁拿到的就是浏览器里跑的那一份代码。
 */

/** 模型在舞台里的视图。 */
export interface StageView {
  /** 缩放倍数，1 = 铺满（默认的 contain 铺法）。 */
  zoom: number;
  /** 水平平移，单位是舞台宽度的小数。 */
  panX: number;
  /** 竖直平移，单位是舞台高度的小数（正数 = 向下）。 */
  panY: number;
}

/** 缩放范围。下限留一半，上限 3 倍：再大就是看皮肤纹理，不是看桌宠。 */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;

/**
 * 平移的硬上限（以舞台尺寸为单位）。
 *
 * 1.5 的意思是「最远可以把模型推到自己身高的 1.5 倍位置」。它不是为了画面好看，
 * 而是为了**留一条退路**：有了上限，任何时候都能用双击把视图恢复默认；
 * 没有上限，一次用力过猛的拖动就能把模型扔到看不见的地方，而它还在那儿画着 ——
 * 用户只会觉得「模型不见了」。
 */
export const PAN_LIMIT = 1.5;

/** 滚轮的灵敏度：每 100 的 deltaY 大约放大 1.197 倍（e^0.18）。 */
export const ZOOM_SENSITIVITY = 0.0018;

/** 单次滚轮事件允许的最大缩放倍率，挡住「一记大力滚轮直接到头」。 */
const MAX_WHEEL_FACTOR = 2;

/** `localStorage` 里的键。与窗口形态、设置、模型记忆都分开。 */
export const STAGE_VIEW_STORAGE_KEY = 'dsh-live2d-pet.stage-view';

/** 默认视图（模型铺满舞台、正中）。 */
export function defaultStageView(): StageView {
  return { zoom: 1, panX: 0, panY: 0 };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 任何输入 → 合法视图。
 *
 * 三个夹取一个都不能少，理由见文件头：漏一个就留下一种「模型不见了」。
 */
export function clampStageView(view: StageView | null | undefined): StageView {
  const zoom = Math.min(Math.max(MIN_ZOOM, finite(view?.zoom, 1)), MAX_ZOOM);
  const panX = Math.min(Math.max(-PAN_LIMIT, finite(view?.panX, 0)), PAN_LIMIT);
  const panY = Math.min(Math.max(-PAN_LIMIT, finite(view?.panY, 0)), PAN_LIMIT);
  return { zoom, panX, panY };
}

/** 是不是默认视图（默认视图不产生任何矩阵运算）。 */
export function isDefaultStageView(view: StageView | null | undefined): boolean {
  if (view === null || view === undefined) {
    return true;
  }
  return view.zoom === 1 && view.panX === 0 && view.panY === 0;
}

/**
 * 滚轮 → 缩放倍率。
 *
 * 用指数而不是加法：加法在高倍率下「一格跳太多」、在低倍率下「一格几乎没动」，
 * 而指数让每一格的手感在所有倍率上一致 —— 这是缩放交互的常识，
 * 也是这条函数单独存在的原因（它要被门禁验单调性与夹取）。
 */
export function wheelZoomFactor(deltaY: unknown): number {
  const dy = finite(deltaY, 0);
  const raw = Math.exp(-dy * ZOOM_SENSITIVITY);
  return Math.min(Math.max(1 / MAX_WHEEL_FACTOR, raw), MAX_WHEEL_FACTOR);
}

/** 缩放一步（围绕舞台中心）。 */
export function zoomStageView(view: StageView | null | undefined, factor: unknown): StageView {
  const current = clampStageView(view);
  return clampStageView({ ...current, zoom: current.zoom * finite(factor, 1) });
}

/** 平移一步。`dxFrac` / `dyFrac` 是舞台宽高的小数（已经除以舞台尺寸）。 */
export function panStageView(view: StageView | null | undefined, dxFrac: unknown, dyFrac: unknown): StageView {
  const current = clampStageView(view);
  return clampStageView({
    ...current,
    panX: current.panX + finite(dxFrac, 0),
    panY: current.panY + finite(dyFrac, 0),
  });
}

/**
 * 视图 → 投影用的三个数（NDC）。
 *
 * `ty` 取反是唯一的符号约定：`panY > 0` 是「向下移」，而 NDC 的 +y 向上。
 * 把它放在这里而不是调用点，是因为符号写反的症状是「拖一下，模型往反方向跑」，
 * 而那种 bug 看代码是看不出来的。
 */
export function stageViewToNdc(view: StageView | null | undefined): { zoom: number; tx: number; ty: number } {
  const current = clampStageView(view);
  return { zoom: current.zoom, tx: current.panX * 2, ty: -current.panY * 2 };
}

/** 从 `localStorage` 的原始字符串恢复视图。坏输入一律退化成默认视图，不抛。 */
export function parseStageView(raw: string | null | undefined): StageView {
  let data: unknown = null;
  if (typeof raw === 'string' && raw !== '') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (data === null || typeof data !== 'object') {
    return defaultStageView();
  }
  const record = data as Record<string, unknown>;
  return clampStageView({ zoom: finite(record.zoom, 1), panX: finite(record.panX, 0), panY: finite(record.panY, 0) });
}

/** 视图 → `localStorage` 字符串。取到小数点后四位，别把浮点抖动写进存储。 */
export function serializeStageView(view: StageView | null | undefined): string {
  const current = clampStageView(view);
  const round = (value: number): number => Math.round(value * 10000) / 10000;
  return JSON.stringify({ zoom: round(current.zoom), panX: round(current.panX), panY: round(current.panY) });
}
