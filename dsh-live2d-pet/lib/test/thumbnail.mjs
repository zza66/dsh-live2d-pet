// src/client/thumbnail.ts
var THUMB_PREFIX = "dsh-l2d-thumb:";
var MAX_THUMB_SIDE = 96;
var PROBE_MAX_SIDE = 192;
var ALPHA_THRESHOLD = 8;
var BBOX_PAD = 0.06;
var MAX_STORED_THUMBS = 32;
var MAX_THUMB_CHARS = 24 * 1024;
function thumbnailKey(id) {
  return `${THUMB_PREFIX}${typeof id === "string" ? id : ""}`;
}
function fingerprintOf(model) {
  if (model === null || model === void 0 || typeof model !== "object") return "";
  const mtime = typeof model.mtimeMs === "number" && Number.isFinite(model.mtimeMs) ? model.mtimeMs : -1;
  const bytes = typeof model.bytes === "number" && Number.isFinite(model.bytes) ? model.bytes : -1;
  const moc = typeof model.moc3?.version === "number" ? model.moc3.version : -1;
  if (mtime < 0 && bytes < 0) return "";
  return `${mtime}:${bytes}:${moc}`;
}
function isFresh(stored, fingerprint) {
  if (stored === null || stored === void 0 || typeof stored !== "object") return false;
  if (typeof stored.dataUrl !== "string" || stored.dataUrl === "") return false;
  if (typeof fingerprint !== "string" || fingerprint === "") return false;
  return stored.fingerprint === fingerprint;
}
function parseStored(raw) {
  if (raw === null || raw === void 0) return null;
  let value = raw;
  if (typeof raw === "string") {
    if (raw === "") return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value;
  if (typeof v.id !== "string" || v.id === "") return null;
  if (typeof v.dataUrl !== "string" || v.dataUrl === "") return null;
  if (!v.dataUrl.startsWith("data:image/")) return null;
  if (v.dataUrl.length > MAX_THUMB_CHARS) return null;
  if (typeof v.fingerprint !== "string") return null;
  const at = typeof v.at === "number" && Number.isFinite(v.at) ? v.at : 0;
  return { id: v.id, dataUrl: v.dataUrl, fingerprint: v.fingerprint, at };
}
function serializeThumb(thumb) {
  return JSON.stringify({
    id: thumb.id,
    dataUrl: thumb.dataUrl,
    fingerprint: thumb.fingerprint,
    at: thumb.at
  });
}
function isStorableThumb(dataUrl) {
  if (typeof dataUrl !== "string") return false;
  if (!dataUrl.startsWith("data:image/")) return false;
  return dataUrl.length <= MAX_THUMB_CHARS;
}
function bboxOfAlpha(data, width, height, threshold = ALPHA_THRESHOLD, pad = BBOX_PAD) {
  if (data === null || data === void 0) return null;
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
  const padX = Math.round((maxX - minX + 1) * pad);
  const padY = Math.round((maxY - minY + 1) * pad);
  const x0 = Math.max(0, minX - padX);
  const y0 = Math.max(0, minY - padY);
  const x1 = Math.min(width - 1, maxX + padX);
  const y1 = Math.min(height - 1, maxY + padY);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
function inkCenterNdc(box, probeWidth, sourceWidth) {
  if (box === null || box === void 0) return null;
  if (!Number.isFinite(probeWidth) || probeWidth <= 0) return null;
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) return null;
  if (!Number.isFinite(box.x) || !Number.isFinite(box.width) || box.width <= 0) return null;
  const centerPx = (box.x + box.width / 2) * (sourceWidth / probeWidth);
  return centerPx / sourceWidth * 2 - 1;
}
function fitInto(width, height, max = MAX_THUMB_SIDE) {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const limit = Number.isFinite(max) && max >= 1 ? max : MAX_THUMB_SIDE;
  const scale = Math.min(1, limit / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale))
  };
}
function pickEvictions(thumbs, limit = MAX_STORED_THUMBS) {
  if (!Array.isArray(thumbs)) return [];
  const list = thumbs.filter((t) => t !== null && typeof t === "object" && typeof t.id === "string");
  const keep = Number.isFinite(limit) && limit >= 0 ? limit : MAX_STORED_THUMBS;
  if (list.length <= keep) return [];
  const sorted = [...list].sort((a, b) => {
    const at = (typeof b.at === "number" ? b.at : 0) - (typeof a.at === "number" ? a.at : 0);
    if (at !== 0) return at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.slice(keep);
}
function thumbAlt(model) {
  const name = model !== null && model !== void 0 && typeof model.name === "string" && model.name !== "" ? model.name : "模型";
  return `${name} 的预览图`;
}
export {
  ALPHA_THRESHOLD,
  BBOX_PAD,
  MAX_STORED_THUMBS,
  MAX_THUMB_CHARS,
  MAX_THUMB_SIDE,
  PROBE_MAX_SIDE,
  THUMB_PREFIX,
  bboxOfAlpha,
  fingerprintOf,
  fitInto,
  inkCenterNdc,
  isFresh,
  isStorableThumb,
  parseStored,
  pickEvictions,
  serializeThumb,
  thumbAlt,
  thumbnailKey
};
