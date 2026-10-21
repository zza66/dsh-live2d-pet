/**
 * 口型包络：把一段解码后的 PCM 音频变成「嘴巴张开程度随时间变化」的曲线。
 *
 * 这是整个口型链路的核心算法，也是本项目**第一个可以纯函数测试**的部件 ——
 * 它不碰 WebGL、不碰音频设备、不碰 DOM，输入一段 Float32 采样就能验。
 *
 * 为什么是「解码后自己算 RMS」而不是用 Edge-TTS 返回的词边界：
 *   1. WordBoundary 的 Offset 基于**未压缩流 t=0**，而 MP3 解码有 25–50ms 的
 *      解码器前导延迟 —— 拿它当口型时间轴会系统性超前。
 *   2. 词边界只给到「词」这一级，一个长词内部嘴巴是不动的，看起来很假。
 *   3. 自己算 RMS 与音频播放用的是**同一个时钟**，天然自洽，不需要标定。
 *
 * 之所以要 attack/release 不对称：真实说话的嘴巴「张开快、闭合慢」。用同一个
 * 时间常数会让口型要么发僵（慢 attack）要么抖动（快 release）。
 *
 * 纯 ESM、零依赖，因此 `node --test` 可以直接跑它，不需要任何构建步骤。
 */

/** 默认参数。数值来源：方案里定的 attack≈30ms / release≈80ms，其余为实测调优。 */
export const DEFAULT_ENVELOPE_OPTIONS = Object.freeze({
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
  minSpanDb: 1,
});

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 取分位数。会复制并排序，所以要传入一次性数组。 */
function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round((sortedValues.length - 1) * fraction)),
  );
  return sortedValues[index];
}

/**
 * 按 `windowMs` / `hopMs` 逐帧算 RMS，再转成 dBFS。
 *
 * 注意用 dB 而不是线性 RMS：人耳是对数的，线性 RMS 下正常说话与大声喊的差别
 * 会挤在 0.6–1.0 这段，嘴巴几乎看不出变化。
 */
function frameRmsDb(samples, sampleRate, windowMs, hopMs) {
  const windowSize = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const hopSize = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const frameCount = samples.length <= windowSize
    ? (samples.length > 0 ? 1 : 0)
    : Math.ceil((samples.length - windowSize) / hopSize) + 1;

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

/**
 * 生成包络。
 *
 * @param {Float32Array|Float64Array|number[]} samples 归一化到 [-1, 1] 的 PCM。
 * @param {number} sampleRate 采样率（Edge-TTS 用 24000）。
 * @param {Partial<typeof DEFAULT_ENVELOPE_OPTIONS>} [options]
 * @returns {{
 *   durationSeconds: number,
 *   hopSeconds: number,
 *   peak: number,
 *   frameCount: number,
 *   levels: Float32Array,
 *   opennessAt: (seconds: number) => number,
 *   maxOpenness: () => number,
 * }}
 */
export function createEnvelope(samples, sampleRate, options = {}) {
  const config = { ...DEFAULT_ENVELOPE_OPTIONS, ...options };
  const pcm = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
  const durationSeconds = sampleRate > 0 ? pcm.length / sampleRate : 0;

  const empty = {
    durationSeconds,
    hopSeconds: config.hopMs / 1000,
    peak: 0,
    frameCount: 0,
    levels: new Float32Array(0),
    opennessAt: () => 0,
    maxOpenness: () => 0,
  };
  if (pcm.length === 0 || !(sampleRate > 0)) return empty;

  const { levels: dbFrames, hopSize } = frameRmsDb(
    pcm,
    sampleRate,
    config.windowMs,
    config.hopMs,
  );
  const hopSeconds = hopSize / sampleRate;

  // 自适应动态范围：以 p95 为「满张开」，往下留 dynamicRangeDb 的余量。
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

  // 非对称一阶平滑：往大走用 attack，往小走用 release。
  const attackAlpha = 1 - Math.exp(-hopSeconds / Math.max(1e-6, config.attackMs / 1000));
  const releaseAlpha = 1 - Math.exp(-hopSeconds / Math.max(1e-6, config.releaseMs / 1000));
  const smoothed = new Float32Array(raw.length);
  let current = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const target = raw[index];
    const alpha = target > current ? attackAlpha : releaseAlpha;
    current += (target - current) * alpha;
    // 收尾时避免留下 1e-4 量级的尾巴：静音就干脆归零（验收要求「停顿回零」）。
    if (target === 0 && current < 0.002) current = 0;
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
    maxOpenness: () => maxLevel,
  };
}
