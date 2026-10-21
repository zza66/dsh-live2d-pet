// src/client/speech-presence.ts
var current = null;
function noteSpeechStart(at) {
  const settledAt = current?.settledAt ?? 0;
  const started = (current?.started ?? 0) + 1;
  current = {
    speaking: true,
    since: at,
    settledAt,
    started,
    settled: current?.settled ?? 0
  };
}
function noteSpeechSettled(at) {
  const before = current;
  current = {
    speaking: false,
    since: 0,
    settledAt: at,
    started: before?.started ?? 0,
    settled: (before?.settled ?? 0) + 1
  };
}
function getSpeechPresence() {
  return current;
}
function resetSpeechPresence() {
  current = null;
}
function speechQuerySuffix(queued = 0) {
  if (current === null) return "&speech=0";
  const depth = Number.isFinite(queued) && queued > 0 ? Math.floor(queued) : 0;
  return `&speech=1&speechState=${current.speaking ? "speaking" : "idle"}&speechQueued=${String(depth)}&speechStarted=${String(current.started)}&speechSettled=${String(current.settled)}`;
}
export {
  getSpeechPresence,
  noteSpeechSettled,
  noteSpeechStart,
  resetSpeechPresence,
  speechQuerySuffix
};
