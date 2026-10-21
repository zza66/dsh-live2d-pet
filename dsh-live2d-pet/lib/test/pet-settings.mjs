// src/client/settings.ts
var MIN_LIP_GAIN = 0.2;
var MAX_LIP_GAIN = 2;
var LIP_GAIN_STEP = 0.05;
var DEFAULT_SETTINGS = Object.freeze({
  lipGain: 1,
  subtitles: true
});
var SETTINGS_KEY = "dsh-live2d-pet.settings";
function clampGain(value) {
  if (!isFinite(value)) return DEFAULT_SETTINGS.lipGain;
  if (value < MIN_LIP_GAIN) return MIN_LIP_GAIN;
  if (value > MAX_LIP_GAIN) return MAX_LIP_GAIN;
  return value;
}
function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const rawGain = typeof source.lipGain === "string" ? Number(source.lipGain) : source.lipGain;
  const lipGain = typeof rawGain === "number" ? clampGain(rawGain) : DEFAULT_SETTINGS.lipGain;
  const subtitles = typeof source.subtitles === "boolean" ? source.subtitles : DEFAULT_SETTINGS.subtitles;
  return { lipGain, subtitles };
}
function serializeSettings(settings) {
  const clean = normalizeSettings(settings);
  return JSON.stringify({ lipGain: clean.lipGain, subtitles: clean.subtitles });
}
function readSettings(storage) {
  if (storage === null || storage === void 0) return { ...DEFAULT_SETTINGS };
  try {
    const text = storage.getItem(SETTINGS_KEY);
    if (typeof text !== "string" || text === "") return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function writeSettings(storage, patch) {
  const current = readSettings(storage);
  const next = normalizeSettings({ ...current, ...patch });
  if (storage !== null && storage !== void 0) {
    try {
      storage.setItem(SETTINGS_KEY, serializeSettings(next));
    } catch {
    }
  }
  return next;
}
function applyLipGain(openness, gain) {
  const value = typeof openness === "number" && isFinite(openness) ? openness : 0;
  const factor = typeof gain === "number" ? clampGain(gain) : DEFAULT_SETTINGS.lipGain;
  const scaled = value * factor;
  if (!isFinite(scaled)) return 0;
  if (scaled < 0) return 0;
  if (scaled > 1) return 1;
  return scaled;
}
function describeLipGain(gain) {
  const value = typeof gain === "number" ? clampGain(gain) : DEFAULT_SETTINGS.lipGain;
  const percent = Math.round(value * 100);
  if (Math.abs(value - 1) < 1e-3) return `口型幅度 ${percent}%（默认）`;
  return value > 1 ? `口型幅度 ${percent}%（比默认大）` : `口型幅度 ${percent}%（比默认小）`;
}
var HIDDEN = Object.freeze({ visible: false, text: "", highlightFrom: -1, highlightTo: -1 });
function subtitleView(source, settings) {
  if (!settings.subtitles) return HIDDEN;
  if (source === null || source === void 0) return HIDDEN;
  if (source.speaking !== true) return HIDDEN;
  const text = typeof source.text === "string" ? source.text : "";
  if (text === "") return HIDDEN;
  const index = typeof source.activeWordIndex === "number" ? source.activeWordIndex : -1;
  const words = Array.isArray(source.words) ? source.words : [];
  const range = highlightRange(text, words, index);
  return { visible: true, text, highlightFrom: range[0], highlightTo: range[1] };
}
function highlightRange(text, words, index) {
  if (typeof text !== "string" || text === "") return [-1, -1];
  if (!Array.isArray(words)) return [-1, -1];
  if (typeof index !== "number" || !isFinite(index) || index < 0) return [-1, -1];
  if (index >= words.length) return [-1, -1];
  let cursor = 0;
  let found = [-1, -1];
  for (let i = 0; i <= index; i += 1) {
    const raw = words[i]?.text;
    const word = typeof raw === "string" ? raw : "";
    if (word === "") {
      found = [-1, -1];
      continue;
    }
    const at = text.indexOf(word, cursor);
    if (at < 0) {
      found = [-1, -1];
      continue;
    }
    cursor = at + word.length;
    found = [at, cursor];
  }
  return found;
}
function describeSubtitles(settings, view) {
  if (!settings.subtitles) return "字幕已关闭";
  if (!view.visible) return "字幕开着（说话时才显示）";
  const total = view.highlightFrom >= 0 ? "正在跟读" : "整句显示";
  return `字幕开着 · ${total}`;
}
export {
  DEFAULT_SETTINGS,
  LIP_GAIN_STEP,
  MAX_LIP_GAIN,
  MIN_LIP_GAIN,
  SETTINGS_KEY,
  applyLipGain,
  describeLipGain,
  describeSubtitles,
  highlightRange,
  normalizeSettings,
  readSettings,
  serializeSettings,
  subtitleView,
  writeSettings
};
