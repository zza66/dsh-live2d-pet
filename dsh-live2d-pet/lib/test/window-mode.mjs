// src/client/window-mode.ts
var MIN_FLOAT_W = 420;
var MIN_FLOAT_H = 280;
var DEFAULT_FLOAT_W = 820;
var DEFAULT_FLOAT_H = 480;
var KEEP_VISIBLE_X = 120;
var KEEP_VISIBLE_Y = 36;
var VIEWPORT_MARGIN = 24;
var WINDOW_STORAGE_KEY = "dsh-live2d-pet.window";
function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function saneViewport(viewport) {
  const w = finite(viewport?.w, 0) > 0 ? Number(viewport?.w) : 1024;
  const h = finite(viewport?.h, 0) > 0 ? Number(viewport?.h) : 768;
  return { w, h };
}
function parseWindowMode(value) {
  return value === "float" ? "float" : "fixed";
}
function clampFloatRect(rect, viewport) {
  const { w: vw, h: vh } = saneViewport(viewport);
  const w = Math.min(Math.max(MIN_FLOAT_W, finite(rect?.w, DEFAULT_FLOAT_W)), Math.max(MIN_FLOAT_W, vw));
  const h = Math.min(Math.max(MIN_FLOAT_H, finite(rect?.h, DEFAULT_FLOAT_H)), Math.max(MIN_FLOAT_H, vh));
  const x = Math.min(Math.max(finite(rect?.x, vw - w - VIEWPORT_MARGIN), KEEP_VISIBLE_X - w), vw - KEEP_VISIBLE_X);
  const y = Math.min(Math.max(finite(rect?.y, vh - h - VIEWPORT_MARGIN), 0), Math.max(0, vh - KEEP_VISIBLE_Y));
  return { x, y, w, h };
}
function defaultFloatRect(viewport) {
  const { w: vw, h: vh } = saneViewport(viewport);
  const w = Math.max(MIN_FLOAT_W, Math.min(DEFAULT_FLOAT_W, vw - VIEWPORT_MARGIN * 2));
  const h = Math.max(MIN_FLOAT_H, Math.min(DEFAULT_FLOAT_H, vh - VIEWPORT_MARGIN * 2));
  return clampFloatRect({ x: vw - w - VIEWPORT_MARGIN, y: vh - h - VIEWPORT_MARGIN, w, h }, viewport);
}
function parseWindowState(raw, viewport) {
  let data = null;
  if (typeof raw === "string" && raw !== "") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  const record = data !== null && typeof data === "object" ? data : {};
  const rect = clampFloatRect(
    { x: finite(record.x, Number.NaN), y: finite(record.y, Number.NaN), w: finite(record.w, DEFAULT_FLOAT_W), h: finite(record.h, DEFAULT_FLOAT_H) },
    viewport
  );
  return { mode: parseWindowMode(record.mode), ...rect };
}
function serializeWindowState(state) {
  return JSON.stringify({
    mode: parseWindowMode(state?.mode),
    x: Math.round(finite(state?.x, 0)),
    y: Math.round(finite(state?.y, 0)),
    w: Math.round(finite(state?.w, DEFAULT_FLOAT_W)),
    h: Math.round(finite(state?.h, DEFAULT_FLOAT_H))
  });
}
function moveFloatRect(start, dx, dy, viewport) {
  return clampFloatRect({ ...start, x: start.x + finite(dx, 0), y: start.y + finite(dy, 0) }, viewport);
}
function resizeFloatRect(start, dx, dy, viewport) {
  return clampFloatRect({ x: start.x, y: start.y, w: start.w + finite(dx, 0), h: start.h + finite(dy, 0) }, viewport);
}
var COLLAPSED_BAR_W = 268;
var COLLAPSED_BAR_H = 38;
function fitCollapsedBar(rect, viewport) {
  const { w: vw, h: vh } = saneViewport(viewport);
  const w = Math.min(COLLAPSED_BAR_W, Math.max(0, vw));
  const h = COLLAPSED_BAR_H;
  const x = Math.min(Math.max(finite(rect?.x, vw - w - VIEWPORT_MARGIN), 0), Math.max(0, vw - w));
  const y = Math.min(Math.max(finite(rect?.y, vh - h - VIEWPORT_MARGIN), 0), Math.max(0, vh - h));
  return { x, y, w, h };
}
export {
  COLLAPSED_BAR_H,
  COLLAPSED_BAR_W,
  DEFAULT_FLOAT_H,
  DEFAULT_FLOAT_W,
  KEEP_VISIBLE_X,
  KEEP_VISIBLE_Y,
  MIN_FLOAT_H,
  MIN_FLOAT_W,
  VIEWPORT_MARGIN,
  WINDOW_STORAGE_KEY,
  clampFloatRect,
  defaultFloatRect,
  fitCollapsedBar,
  moveFloatRect,
  parseWindowMode,
  parseWindowState,
  resizeFloatRect,
  serializeWindowState
};
