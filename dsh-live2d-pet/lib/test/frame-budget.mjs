// lib/host/render-config.js
var MIN_FPS = 10;
var MAX_FPS = 240;
var DEFAULT_FPS = 60;
function normalizeFps(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FPS;
  if (value < MIN_FPS) return MIN_FPS;
  if (value > MAX_FPS) return MAX_FPS;
  return value;
}

// src/client/frame-budget.ts
var FRAME_SLACK = 0.9;
function frameIntervalMs(fps) {
  const interval = 1e3 / normalizeFps(fps);
  return Number.isFinite(interval) && interval > 0 ? interval : 1e3 / 60;
}
function shouldDrawFrame(lastDrawAt, now, fps) {
  if (!Number.isFinite(now)) return true;
  if (!(lastDrawAt > 0)) return true;
  if (!(now > lastDrawAt)) return true;
  return now - lastDrawAt >= frameIntervalMs(fps) * FRAME_SLACK;
}
export {
  FRAME_SLACK,
  frameIntervalMs,
  shouldDrawFrame
};
