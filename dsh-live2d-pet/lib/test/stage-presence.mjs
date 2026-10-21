// src/client/stage-presence.ts
var current = null;
function setStagePresence(next) {
  current = next;
}
function getStagePresence() {
  return current;
}
function stageQuerySuffix() {
  if (current === null) return "&stage=0";
  const frames = current.frames();
  const safe = Number.isFinite(frames) && frames >= 0 ? Math.floor(frames) : 0;
  return `&stage=1&stageModel=${encodeURIComponent(current.modelPath())}&stageFrames=${String(safe)}`;
}
export {
  getStagePresence,
  setStagePresence,
  stageQuerySuffix
};
