// src/client/stage-view.ts
var MIN_ZOOM = 0.5;
var MAX_ZOOM = 3;
var PAN_LIMIT = 1.5;
var ZOOM_SENSITIVITY = 18e-4;
var MAX_WHEEL_FACTOR = 2;
var STAGE_VIEW_STORAGE_KEY = "dsh-live2d-pet.stage-view";
function defaultStageView() {
  return { zoom: 1, panX: 0, panY: 0 };
}
function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clampStageView(view) {
  const zoom = Math.min(Math.max(MIN_ZOOM, finite(view?.zoom, 1)), MAX_ZOOM);
  const panX = Math.min(Math.max(-PAN_LIMIT, finite(view?.panX, 0)), PAN_LIMIT);
  const panY = Math.min(Math.max(-PAN_LIMIT, finite(view?.panY, 0)), PAN_LIMIT);
  return { zoom, panX, panY };
}
function isDefaultStageView(view) {
  if (view === null || view === void 0) {
    return true;
  }
  return view.zoom === 1 && view.panX === 0 && view.panY === 0;
}
function wheelZoomFactor(deltaY) {
  const dy = finite(deltaY, 0);
  const raw = Math.exp(-dy * ZOOM_SENSITIVITY);
  return Math.min(Math.max(1 / MAX_WHEEL_FACTOR, raw), MAX_WHEEL_FACTOR);
}
function zoomStageView(view, factor) {
  const current = clampStageView(view);
  return clampStageView({ ...current, zoom: current.zoom * finite(factor, 1) });
}
function panStageView(view, dxFrac, dyFrac) {
  const current = clampStageView(view);
  return clampStageView({
    ...current,
    panX: current.panX + finite(dxFrac, 0),
    panY: current.panY + finite(dyFrac, 0)
  });
}
function stageViewToNdc(view) {
  const current = clampStageView(view);
  return { zoom: current.zoom, tx: current.panX * 2, ty: -current.panY * 2 };
}
function parseStageView(raw) {
  let data = null;
  if (typeof raw === "string" && raw !== "") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (data === null || typeof data !== "object") {
    return defaultStageView();
  }
  const record = data;
  return clampStageView({ zoom: finite(record.zoom, 1), panX: finite(record.panX, 0), panY: finite(record.panY, 0) });
}
function serializeStageView(view) {
  const current = clampStageView(view);
  const round = (value) => Math.round(value * 1e4) / 1e4;
  return JSON.stringify({ zoom: round(current.zoom), panX: round(current.panX), panY: round(current.panY) });
}
export {
  MAX_ZOOM,
  MIN_ZOOM,
  PAN_LIMIT,
  STAGE_VIEW_STORAGE_KEY,
  ZOOM_SENSITIVITY,
  clampStageView,
  defaultStageView,
  isDefaultStageView,
  panStageView,
  parseStageView,
  serializeStageView,
  stageViewToNdc,
  wheelZoomFactor,
  zoomStageView
};
