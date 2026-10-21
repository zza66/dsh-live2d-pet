/**
 * 模型缩略图：**线缆、缓存与几何**的纯逻辑。
 *
 * 为什么需要这个模块：`Live2D-AI插件开发方案.md` 的 P1 交付物里写着「缩略图」，
 * §6.1 的验收第 1 条更是拿它当判据 ——「拖入含 `.model3.json` 的 zip → 30 秒内出现
 * 在模型库，**缩略图正确**」。而这一条此前一行实现都没有：下拉框只显示文本名，
 * 用户面对 `miku_vts` / `空_vts` 这种名字只能逐个点进去看。
 *
 * 方案是**纯客户端**的：模型成功上屏之后从主画布抓一帧，不碰 Host、不加路由、
 * 不写盘。理由有两条：
 *   1. Host 半区解不了这题 —— 缩略图要的是「模型长什么样」，而 Host 那边只有文件，
 *      真要去渲染就得把 Cubism Core 搬进 Node（那是几 MB 的 wasm 加一整套 GL 垫片）；
 *   2. 模型切过去之后画面上本来就有它，抓一帧是**零额外成本**的。
 *
 * 这个文件里没有任何 DOM、没有 canvas、没有 localStorage、没有 `Date.now()` ——
 * 时间与像素都从参数进来。抓帧那一段（真的碰 canvas）留在 `plugin.ts`，
 * 因为它必然带着 GL 上下文和 rAF 的时序约束；而**所有会算错的地方**
 * （包围盒、裁剪、缩放、指纹比对、坏数据解析）都在这里，可以被门禁逐条钉住。
 *
 * ⚠️ 客户端半区的老规矩（§9.2 白屏事故的教训）：这里的每个函数**都不许抛**。
 * 缩略图是锦上添花的东西，为一个装饰品让整个面板白屏是不可接受的 ——
 * 所以 `parseStored()` 遇到任何意外一律返回 `null`，`bboxOfAlpha()` 遇到
 * 任何不合理的输入一律返回 `null`。
 */

import type { ModelEntry } from './model-list';

/** 存进 localStorage 的键前缀。带前缀是为了不和别的东西撞。 */
export const THUMB_PREFIX = 'dsh-l2d-thumb:';

/** 输出缩略图的长边上限（像素）。面板里那一行高约 48px，96 够 2 倍屏用。 */
export const MAX_THUMB_SIDE = 96;

/**
 * 抓帧后先缩到多小再去找包围盒。
 *
 * 192 而不是直接 96：模型在画面里往往只占中间一块，先缩到 96 会让包围盒的
 * 边缘精度掉到几个像素，裁出来会缺手缺脚。192 是「够准」与「够便宜」的折中 ——
 * 这一步要 `getImageData()`，像素数是平方增长的。
 */
export const PROBE_MAX_SIDE = 192;

/**
 * alpha 大于多少才算「模型的一部分」。
 *
 * 不取 1：抗锯齿边缘与半透明部位会留下 alpha 很低的杂散像素，取 1 会让包围盒
 * 被一个孤点撑到整张画布。不取更高：模型有淡入动画，刚上屏时 alpha 还没到 255，
 * 取太高会裁出一张空图。
 */
export const ALPHA_THRESHOLD = 8;

/**
 * 包围盒四周留多少余量（比例）。
 *
 * 不留的话模型紧贴边缘，看着像被切了。留太多则模型变小、细节看不清。
 */
export const BBOX_PAD = 0.06;

/** localStorage 里最多留几张。超了按时间戳淘汰最旧的。 */
export const MAX_STORED_THUMBS = 32;

/**
 * 单张图最多允许多少字符（data URL 的长度）。
 *
 * 96px 的 PNG 实测 3–8KB，24KB 已经是三倍余量。设这个上限是因为它是
 * **本地存储配额的最后一道闸**：`MAX_STORED_THUMBS` 是按张数限的，而一张
 * 图有多大并不由张数决定 —— 万一某次抓到一张整块不透明的图（模型加载到
 * 一半、或者画布被别处改成很大），32 张各 500KB 就是 16MB，直接撞穿
 * localStorage 通常的 5MB 配额，那时整个面板的其他设置也一起写不进去了。
 *
 * 超限的图**不是错误**，只是不值得存 —— 界面上少一张小图，功能一个不少。
 */
export const MAX_THUMB_CHARS = 24 * 1024;

/** 存在 localStorage 里的一张缩略图。 */
export interface StoredThumb {
  /** 模型 id（`/models` 条目里的 `id`）。 */
  id: string;
  /** PNG 的 data URL。 */
  dataUrl: string;
  /** 抓这张图时模型的指纹，见 `fingerprintOf()`。 */
  fingerprint: string;
  /** 抓图时间（毫秒时间戳）。淘汰最旧的用它排序。 */
  at: number;
}

/** 包围盒，坐标是像素、左上角为原点。 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** localStorage 的键。 */
export function thumbnailKey(id: string): string {
  return `${THUMB_PREFIX}${typeof id === 'string' ? id : ''}`;
}

/**
 * 一个模型的指纹：文件变了，它的缩略图就必须重拍。
 *
 * 用 `mtimeMs` + `bytes` 两条一起。`mtimeMs` 单独用会漏掉「同一秒内改两次」，
 * `bytes` 单独用会漏掉「换了一个大小恰好相同的模型」—— 而后者意味着用户会看到
 * **另一个模型的图**，比没有图更糟。
 *
 * `mtimeMs` 缺了（旧 Host）就退回只用 `bytes`：宁可偶尔重拍，也不要永远信一张旧图。
 */
export function fingerprintOf(model: ModelEntry | null | undefined): string {
  if (model === null || model === undefined || typeof model !== 'object') return '';
  const mtime = typeof model.mtimeMs === 'number' && Number.isFinite(model.mtimeMs) ? model.mtimeMs : -1;
  const bytes = typeof model.bytes === 'number' && Number.isFinite(model.bytes) ? model.bytes : -1;
  const moc = typeof model.moc3?.version === 'number' ? model.moc3.version : -1;
  if (mtime < 0 && bytes < 0) return '';
  return `${mtime}:${bytes}:${moc}`;
}

/**
 * 存着的那张还作数吗。
 *
 * 指纹是空串一律算**不作数**：空指纹意味着「拿不到任何文件信息」，
 * 这时候信一张旧图的代价是显示错模型，而不信的代价只是多拍一张。
 */
export function isFresh(stored: StoredThumb | null | undefined, fingerprint: string): boolean {
  if (stored === null || stored === undefined || typeof stored !== 'object') return false;
  if (typeof stored.dataUrl !== 'string' || stored.dataUrl === '') return false;
  if (typeof fingerprint !== 'string' || fingerprint === '') return false;
  return stored.fingerprint === fingerprint;
}

/**
 * 把 localStorage 里读出来的东西解析成 `StoredThumb`，坏数据一律 `null`。
 *
 * 这个函数的存在理由就是「不许抛」：localStorage 里的内容可能是上一个版本写的、
 * 可能被用户手工改过、也可能是配额爆掉时写了一半的。任何一个字段不对就整条丢掉 ——
 * 缩略图丢了只是少一张图，抛出去就是整个面板白屏。
 */
export function parseStored(raw: unknown): StoredThumb | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw === '') return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id === '') return null;
  if (typeof v.dataUrl !== 'string' || v.dataUrl === '') return null;
  // 只认 data URL：`http://` 之类的东西塞进来会被 `<img src>` 拿去发请求，
  // 而这个字段理论上可能来自被改过的 localStorage。
  if (!v.dataUrl.startsWith('data:image/')) return null;
  /*
   * 超大的条目也丢掉。这一条让配额有自我修复能力：`writeStoredThumb()`
   * 会把 `parseStored()` 读不出来的键当成垃圾清掉，所以一个上个版本写进去的
   * 巨型条目会在下一次写入时被顺手清除，而不是一直占着配额。
   */
  if (v.dataUrl.length > MAX_THUMB_CHARS) return null;
  if (typeof v.fingerprint !== 'string') return null;
  const at = typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0;
  return { id: v.id, dataUrl: v.dataUrl, fingerprint: v.fingerprint, at };
}

/** 写回 localStorage 用的字符串。 */
export function serializeThumb(thumb: StoredThumb): string {
  return JSON.stringify({
    id: thumb.id,
    dataUrl: thumb.dataUrl,
    fingerprint: thumb.fingerprint,
    at: thumb.at,
  });
}

/**
 * 这张图值得存吗。
 *
 * 两个条件缺一不可：是 PNG 的 data URL（`parseStored()` 也只认这个，存一个
 * 它读不回来的东西等于写了一条垃圾），且不超过 `MAX_THUMB_CHARS`。
 *
 * 调用点在**存之前**，所以这里不抛也不报错 —— 返回 `false` 就是「这次算了」。
 */
export function isStorableThumb(dataUrl: unknown): boolean {
  if (typeof dataUrl !== 'string') return false;
  if (!dataUrl.startsWith('data:image/')) return false;
  return dataUrl.length <= MAX_THUMB_CHARS;
}

/**
 * 从一片 alpha 通道里找出非透明区域的包围盒（带 `BBOX_PAD` 余量，已夹在画布内）。
 *
 * `alpha` 是 `getImageData().data`：RGBA 交错，所以 alpha 在 `i * 4 + 3`。
 * 传进来的 `data` 长度不够（比如 canvas 被别处 resize 过）时返回 `null` ——
 * 算出来的包围盒会指向画布外面，那种图裁出来是黑的。
 *
 * 整张全透明也返回 `null`：那说明这一帧模型还没画上去（淡入的第一帧、
 * 或者加载失败），这时候拍下来的会是一张空图，而空图存下来之后**看起来像
 * 「这个模型就是空的」**，比没有缩略图更误导。
 */
export function bboxOfAlpha(
  data: Uint8ClampedArray | Uint8Array | number[] | null | undefined,
  width: number,
  height: number,
  threshold: number = ALPHA_THRESHOLD,
  pad: number = BBOX_PAD,
): Box | null {
  if (data === null || data === undefined) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (data.length < width * height * 4) return null;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[(row + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;

  // 余量按**已找到的**那一块算，然后夹回画布 —— 不夹的话模型贴边时
  // `drawImage` 的源矩形会越界，浏览器给的是未定义内容（实测是透明）。
  const padX = Math.round((maxX - minX + 1) * pad);
  const padY = Math.round((maxY - minY + 1) * pad);
  const x0 = Math.max(0, minX - padX);
  const y0 = Math.max(0, minY - padY);
  const x1 = Math.min(width - 1, maxX + padX);
  const y1 = Math.min(height - 1, maxY + padY);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * 把「本体在画面里的包围盒」换算成**本体中心的 NDC 横坐标**。
 *
 * 返回 `-1` = 本体中心贴着画布左边缘，`+1` = 右边缘，`0` = 正中。
 * 量不出来（任何一个输入不合法、或包围盒宽度为 0）返回 `null`。
 *
 * ── 为什么单独抽成一个函数 ──────────────────────────────────────────────
 * 它有两个坐标系要跨：包围盒是在**采样画布**（`probe`，长边被 `fitInto()`
 * 缩到 192）上量的，而 NDC 是相对**真实画布**（`source`）算的。少乘或多乘那个
 * `source / probe` 的比例，症状是「模型看着还是偏一点」—— 一个不会抛异常、
 * 不会报错、只能靠肉眼发现的错误。所以它必须能被门禁直接喂数字。
 */
export function inkCenterNdc(
  box: { x: number; width: number } | null | undefined,
  probeWidth: number,
  sourceWidth: number,
): number | null {
  if (box === null || box === undefined) return null;
  if (!Number.isFinite(probeWidth) || probeWidth <= 0) return null;
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) return null;
  if (!Number.isFinite(box.x) || !Number.isFinite(box.width) || box.width <= 0) return null;

  // 采样坐标 → 源画布像素 → NDC。
  const centerPx = (box.x + box.width / 2) * (sourceWidth / probeWidth);
  return (centerPx / sourceWidth) * 2 - 1;
}

/**
 * 等比缩放到长边不超过 `max`。
 *
 * 只缩不放：模型本来就只有 40px 宽时放大到 96 只会糊。至少留 1px ——
 * 一个 0 宽的 canvas 会让 `toDataURL()` 抛 `IndexSizeError`。
 */
export function fitInto(width: number, height: number, max: number = MAX_THUMB_SIDE): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const limit = Number.isFinite(max) && max >= 1 ? max : MAX_THUMB_SIDE;
  const scale = Math.min(1, limit / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * 从一堆存着的缩略图里挑出该删掉的键。
 *
 * localStorage 有配额（一般 5MB），一张 96px PNG 的 data URL 大约 3–8KB。
 * 不设上限的话，模型多的用户会先遇到 `QuotaExceededError` —— 而那时候
 * 表现是「缩略图突然不存了」，很难往「存太多了」上想。
 *
 * 留下的按 `at` 从新到旧取前 `limit` 张；`at` 相同则按 `id` 排，
 * 保证结果稳定（不然每次启动删的可能不是同一批）。
 */
export function pickEvictions(thumbs: StoredThumb[] | null | undefined, limit: number = MAX_STORED_THUMBS): StoredThumb[] {
  if (!Array.isArray(thumbs)) return [];
  const list = thumbs.filter((t): t is StoredThumb => t !== null && typeof t === 'object' && typeof t.id === 'string');
  const keep = Number.isFinite(limit) && limit >= 0 ? limit : MAX_STORED_THUMBS;
  if (list.length <= keep) return [];
  const sorted = [...list].sort((a, b) => {
    const at = (typeof b.at === 'number' ? b.at : 0) - (typeof a.at === 'number' ? a.at : 0);
    if (at !== 0) return at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.slice(keep);
}

/**
 * 面板里给 `<img>` 用的替代文字。
 *
 * 不用「缩略图」三个字：读屏软件念出来毫无信息。模型名才有用。
 */
export function thumbAlt(model: ModelEntry | null | undefined): string {
  const name = model !== null && model !== undefined && typeof model.name === 'string' && model.name !== ''
    ? model.name
    : '模型';
  return `${name} 的预览图`;
}
