// src/client/motion-calm.ts
var IDLE_CALM_FACTOR = 0.35;
var CALM_ATTACK_MS = 480;
var CALM_RELEASE_MS = 1100;
var CALM_EPSILON = 2e-3;
var CALM_MAX_STEP_MS = 200;
var THINKING_LAYER_NAME = "思考";
function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clamp01(value) {
  const v = finite(value, 0);
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}
function advanceCalm(current, target, dtMs) {
  const from = clamp01(current);
  const to = clamp01(target);
  if (from === to) return from;
  const dt = Math.max(0, Math.min(finite(dtMs, 0), CALM_MAX_STEP_MS));
  if (dt === 0) return from;
  const span = to > from ? CALM_ATTACK_MS : CALM_RELEASE_MS;
  const step = dt / span;
  const next = to > from ? Math.min(to, from + step) : Math.max(to, from - step);
  return clamp01(next);
}
function calmFactorFor(calm) {
  return 1 - clamp01(calm) * (1 - IDLE_CALM_FACTOR);
}
function dampTowardDefault(value, defaultValue, factor) {
  const base = finite(defaultValue, 0);
  const v = finite(value, base);
  return base + (v - base) * clamp01(factor);
}
function shouldDampMotion(input) {
  if (!(clamp01(input?.calm) > CALM_EPSILON)) return false;
  if (input?.motionUpdated !== true) return false;
  const priority = finite(input?.motionPriority, 0);
  const idle = finite(input?.idlePriority, 1);
  return priority <= idle;
}
function calmTargetFor(thinking) {
  return thinking === true ? 1 : 0;
}
export {
  CALM_ATTACK_MS,
  CALM_EPSILON,
  CALM_MAX_STEP_MS,
  CALM_RELEASE_MS,
  IDLE_CALM_FACTOR,
  THINKING_LAYER_NAME,
  advanceCalm,
  calmFactorFor,
  calmTargetFor,
  clamp01,
  dampTowardDefault,
  shouldDampMotion
};
