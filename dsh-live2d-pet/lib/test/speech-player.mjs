// src/audio/envelope.mjs
var DEFAULT_ENVELOPE_OPTIONS = Object.freeze({
  /** 计算 RMS 的窗长。太短会抖，太长会把字与字之间糊在一起。 */
  windowMs: 40,
  /** 相邻两帧的间隔，也就是包络的时间分辨率。10ms 足够 60fps 使用。 */
  hopMs: 10,
  /** 张开的时间常数：越小嘴巴张得越快。 */
  attackMs: 30,
  /** 闭合的时间常数：必须明显大于 attack，否则口型会「发抖」。 */
  releaseMs: 80,
  /**
   * 静音判定线（dBFS）。低于它的帧直接当 0 —— 否则底噪会让嘴巴一直微张。
   * -45dB 大致是「安静房间里的呼吸声」的水平。
   */
  noiseFloorDb: -45,
  /** 自适应上限所取的分位数。取 0.95 而不是最大值，避免一个爆音把整体压低。 */
  normalizationPercentile: 0.95,
  /**
   * 自适应的下限保护：若整段都很轻，`p95 - dynamicRangeDb` 也不能低于 noiseFloorDb。
   * 没有这一条时，纯静音输入会因为 p95 也是静音电平而除零。
   */
  dynamicRangeDb: 35,
  /** 曲线指数。<1 会把小声也抬起来，让轻声说话时嘴巴也动。 */
  gamma: 0.7,
  /**
   * 可用的动态范围下限（dB）。`loudDb - floorDb` 小于它就认为「整段没有可用音量」，
   * 一律输出 0。
   *
   * 这条保护是必须的：静音输入的 dB 大约是 -180，而 floorDb 被 noiseFloorDb 顶在
   * -45，于是 span 变成**负数**，除法会把「最安静的帧」映射成满张开 —— 症状是
   * **纯静音时嘴巴张到最大**。用正数判断而不是绝对值比较可以一次挡住这类情况。
   */
  minSpanDb: 1
});
function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round((sortedValues.length - 1) * fraction))
  );
  return sortedValues[index];
}
function frameRmsDb(samples, sampleRate, windowMs, hopMs) {
  const windowSize = Math.max(1, Math.round(windowMs / 1e3 * sampleRate));
  const hopSize = Math.max(1, Math.round(hopMs / 1e3 * sampleRate));
  const frameCount = samples.length <= windowSize ? samples.length > 0 ? 1 : 0 : Math.ceil((samples.length - windowSize) / hopSize) + 1;
  const levels = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSize;
    const end = Math.min(samples.length, start + windowSize);
    let sumSquares = 0;
    for (let index = start; index < end; index += 1) {
      const value = samples[index];
      sumSquares += value * value;
    }
    const count = Math.max(1, end - start);
    const rms = Math.sqrt(sumSquares / count);
    levels[frame] = 20 * Math.log10(Math.max(rms, 1e-9));
  }
  return { levels, hopSize, windowSize };
}
function createEnvelope(samples, sampleRate, options = {}) {
  const config = { ...DEFAULT_ENVELOPE_OPTIONS, ...options };
  const pcm = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
  const durationSeconds = sampleRate > 0 ? pcm.length / sampleRate : 0;
  const empty = {
    durationSeconds,
    hopSeconds: config.hopMs / 1e3,
    peak: 0,
    frameCount: 0,
    levels: new Float32Array(0),
    opennessAt: () => 0,
    maxOpenness: () => 0
  };
  if (pcm.length === 0 || !(sampleRate > 0)) return empty;
  const { levels: dbFrames, hopSize } = frameRmsDb(
    pcm,
    sampleRate,
    config.windowMs,
    config.hopMs
  );
  const hopSeconds = hopSize / sampleRate;
  const sorted = Array.from(dbFrames).sort((a, b) => a - b);
  const loudDb = percentile(sorted, config.normalizationPercentile);
  const floorDb = Math.max(config.noiseFloorDb, loudDb - config.dynamicRangeDb);
  const span = loudDb - floorDb;
  const usable = span > config.minSpanDb;
  const raw = new Float32Array(dbFrames.length);
  let peak = 0;
  if (usable) {
    for (let index = 0; index < dbFrames.length; index += 1) {
      let level = clamp01((dbFrames[index] - floorDb) / span);
      if (level > 0) level = Math.pow(level, config.gamma);
      raw[index] = level;
      if (level > peak) peak = level;
    }
  }
  const attackAlpha = 1 - Math.exp(-hopSeconds / Math.max(1e-6, config.attackMs / 1e3));
  const releaseAlpha = 1 - Math.exp(-hopSeconds / Math.max(1e-6, config.releaseMs / 1e3));
  const smoothed = new Float32Array(raw.length);
  let current = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const target = raw[index];
    const alpha = target > current ? attackAlpha : releaseAlpha;
    current += (target - current) * alpha;
    if (target === 0 && current < 2e-3) current = 0;
    smoothed[index] = clamp01(current);
  }
  const opennessAt = (seconds) => {
    if (!(seconds > 0)) return 0;
    const position = seconds / hopSeconds;
    if (position >= smoothed.length) return 0;
    const base = Math.floor(position);
    const next = Math.min(base + 1, smoothed.length - 1);
    const fraction = position - base;
    return clamp01(smoothed[base] * (1 - fraction) + smoothed[next] * fraction);
  };
  let maxLevel = 0;
  for (const value of smoothed) {
    if (value > maxLevel) maxLevel = value;
  }
  return {
    durationSeconds,
    hopSeconds,
    peak,
    frameCount: smoothed.length,
    levels: smoothed,
    opennessAt,
    maxOpenness: () => maxLevel
  };
}

// src/client/speech.ts
var TAIL_SECONDS = 0.08;
function describeSpeechState(state) {
  if (state.lastError !== null) return `语音失败：${state.lastError}`;
  if (state.notice !== "") return state.notice;
  if (state.degraded) {
    return `正在用${engineLabel(state.adapterId)}（音质已降级）`;
  }
  if (state.speaking) {
    return `说话中 ${state.durationSeconds.toFixed(2)}s · 包络 ${state.frames} 帧 · 峰值 ${state.peak.toFixed(3)} · ${engineLabel(state.adapterId)}`;
  }
  if (state.audioState === "suspended") return "音频被浏览器挂起：点一下页面即可解锁";
  return "待机";
}
function engineLabel(adapterId) {
  if (adapterId === "system") return "系统语音";
  if (adapterId === "voice") return "语音包";
  if (adapterId === "edge") return "Edge-TTS";
  if (adapterId === "custom") return "本地 TTS";
  return typeof adapterId === "string" && adapterId !== "" ? adapterId : "未知音源";
}
var BOUNDARY_DECAY_MS = 180;
function decodeBase64ToBytes(base64) {
  const binary = atob(String(base64 ?? ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
function resolveAudioContextCtor() {
  const scope = globalThis;
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}
function normalizeWords(input) {
  if (!Array.isArray(input)) return [];
  const cleaned = [];
  for (const raw of input) {
    const text = typeof raw?.text === "string" ? raw.text : "";
    const offsetSeconds = Number(raw?.offsetSeconds);
    const durationSeconds = Number(raw?.durationSeconds);
    if (text === "") continue;
    if (!isFinite(offsetSeconds) || offsetSeconds < 0) continue;
    cleaned.push({
      text,
      offsetSeconds,
      durationSeconds: isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0
    });
  }
  cleaned.sort((a, b) => a.offsetSeconds - b.offsetSeconds);
  return cleaned;
}
function resolveSpeechSynthesis() {
  const scope = globalThis;
  return scope.speechSynthesis ?? null;
}
function createSpeechPlayer() {
  let ctx = null;
  let gain = null;
  let source = null;
  let envelope = null;
  let startedAt = 0;
  let endedAt = 0;
  let token = 0;
  let systemUtterance = null;
  let systemDecayAtMs = 0;
  let systemSpeaking = false;
  const listeners = /* @__PURE__ */ new Set();
  const state = {
    speaking: false,
    text: null,
    durationSeconds: 0,
    frames: 0,
    peak: 0,
    lastError: null,
    audioState: "closed",
    adapterId: "edge",
    degraded: false,
    notice: "",
    words: []
  };
  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
      }
    }
  }
  function syncAudioState() {
    state.audioState = ctx === null ? "closed" : ctx.state;
  }
  async function ensureContext() {
    if (ctx === null) {
      const Ctor = resolveAudioContextCtor();
      if (Ctor === null) {
        throw new Error("E_AUDIO_UNAVAILABLE: 这个环境没有 AudioContext");
      }
      ctx = new Ctor();
      gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(ctx.destination);
    }
    if (ctx.state === "suspended") {
      await Promise.race([
        ctx.resume().catch(() => void 0),
        new Promise((resolve) => setTimeout(resolve, 400))
      ]);
    }
    syncAudioState();
    if (ctx.state !== "running") {
      throw new Error(`E_AUDIO_BLOCKED: AudioContext 处于 ${ctx.state}，需要先点一下页面`);
    }
    return ctx;
  }
  function teardown() {
    envelope = null;
    state.words = [];
    if (source !== null) {
      try {
        source.onended = null;
        source.stop();
      } catch {
      }
      try {
        source.disconnect();
      } catch {
      }
      source = null;
    }
  }
  function teardownSystemVoice() {
    systemDecayAtMs = 0;
    systemSpeaking = false;
    const utterance = systemUtterance;
    systemUtterance = null;
    if (utterance === null) return;
    utterance.onstart = null;
    utterance.onboundary = null;
    utterance.onend = null;
    utterance.onerror = null;
    const synth = resolveSpeechSynthesis();
    if (synth !== null) {
      try {
        synth.cancel();
      } catch {
      }
    }
  }
  return {
    state,
    openness() {
      if (systemSpeaking) {
        const remaining = systemDecayAtMs - Date.now();
        if (remaining <= 0) return 0;
        return Math.max(0, Math.min(1, remaining / BOUNDARY_DECAY_MS));
      }
      if (envelope === null || ctx === null) return 0;
      const now = ctx.currentTime;
      if (now > endedAt + TAIL_SECONDS) return 0;
      const elapsed = now - startedAt;
      if (elapsed < 0) return 0;
      const value = envelope.opennessAt(elapsed);
      return typeof value === "number" && isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    },
    activeWordIndex() {
      if (ctx === null || state.words.length === 0) return -1;
      const elapsed = ctx.currentTime - startedAt;
      if (elapsed < 0) return -1;
      let found = -1;
      for (let i = 0; i < state.words.length; i += 1) {
        const word = state.words[i];
        if (word.offsetSeconds <= elapsed) found = i;
        else break;
      }
      return found;
    },
    async playBase64(audioBase64, text = null, words = [], options) {
      const mine = token += 1;
      teardown();
      teardownSystemVoice();
      state.adapterId = typeof options?.adapterId === "string" && options.adapterId !== "" ? options.adapterId : "edge";
      state.degraded = false;
      state.notice = "";
      const audio = await ensureContext();
      const bytes = decodeBase64ToBytes(audioBase64);
      if (bytes.length === 0) {
        state.lastError = "E_AUDIO_EMPTY: 音频是空的";
        notify();
        throw new Error(state.lastError);
      }
      const buffer = await audio.decodeAudioData(bytes.buffer.slice(0));
      if (mine !== token) return;
      const samples = buffer.getChannelData(0);
      envelope = createEnvelope(samples, buffer.sampleRate);
      const node = audio.createBufferSource();
      node.buffer = buffer;
      node.connect(gain);
      node.onended = () => {
        if (mine !== token) return;
        state.speaking = false;
        endedAt = audio.currentTime;
        notify();
      };
      source = node;
      startedAt = audio.currentTime;
      endedAt = startedAt + buffer.duration;
      state.speaking = true;
      state.text = text;
      state.words = normalizeWords(words);
      state.durationSeconds = buffer.duration;
      state.frames = envelope.frameCount;
      state.peak = envelope.peak;
      state.lastError = null;
      syncAudioState();
      notify();
      node.start();
    },
    async speakWithSystemVoice(text, notice = "") {
      const trimmed = String(text ?? "").trim();
      if (trimmed === "") {
        state.lastError = "E_TTS_EMPTY_TEXT: 没有要念的文本";
        notify();
        throw new Error(state.lastError);
      }
      const synth = resolveSpeechSynthesis();
      if (synth === null) {
        state.lastError = "E_TTS_NO_FALLBACK: 浏览器没有提供系统语音，无法降级";
        notify();
        throw new Error(state.lastError);
      }
      token += 1;
      teardown();
      teardownSystemVoice();
      const utterance = new SpeechSynthesisUtterance(trimmed);
      systemUtterance = utterance;
      state.adapterId = "system";
      state.degraded = true;
      state.notice = notice;
      state.text = trimmed;
      state.words = [];
      state.durationSeconds = 0;
      state.frames = 0;
      state.peak = 0;
      state.lastError = null;
      utterance.onstart = () => {
        if (systemUtterance !== utterance) return;
        systemSpeaking = true;
        systemDecayAtMs = Date.now() + BOUNDARY_DECAY_MS;
        state.speaking = true;
        notify();
      };
      utterance.onboundary = () => {
        if (systemUtterance !== utterance) return;
        systemDecayAtMs = Date.now() + BOUNDARY_DECAY_MS;
        state.frames += 1;
        notify();
      };
      utterance.onend = () => {
        if (systemUtterance !== utterance) return;
        systemSpeaking = false;
        systemDecayAtMs = 0;
        state.speaking = false;
        notify();
      };
      utterance.onerror = (event) => {
        if (systemUtterance !== utterance) return;
        systemSpeaking = false;
        systemDecayAtMs = 0;
        state.speaking = false;
        state.lastError = `E_TTS_SYSTEM_VOICE: 系统语音报错（${String(event?.error ?? "unknown")}）`;
        notify();
      };
      state.speaking = true;
      notify();
      synth.speak(utterance);
    },
    stop() {
      token += 1;
      teardown();
      teardownSystemVoice();
      endedAt = ctx === null ? 0 : ctx.currentTime;
      state.speaking = false;
      notify();
    },
    async warmUp() {
      try {
        await ensureContext();
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
var shared = null;
function getSpeechPlayer() {
  if (shared === null) {
    shared = createSpeechPlayer();
  }
  return shared;
}
export {
  createSpeechPlayer,
  describeSpeechState,
  engineLabel,
  getSpeechPlayer
};
