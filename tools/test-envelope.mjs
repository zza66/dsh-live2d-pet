/**
 * `dsh-live2d-pet/src/audio/envelope.mjs` 的单元测试。
 *
 * 用 Node 自带的 `node --test`，**不引入任何测试框架依赖** —— 方案文档里原本写的是
 * Vitest，但既然被测对象是纯 ESM、零依赖，再为它装一套 runner 只会给这个项目增加
 * 一个需要维护的东西。跑法：
 *
 *   node --test tools/test-envelope.mjs
 *
 * 这里全部用手工合成的信号（正弦 / 静音 / 突发），因为合成信号的**真值已知**：
 * 我们知道声音什么时候开始、什么时候结束，所以能反过来断言包络该长什么样。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelope, DEFAULT_ENVELOPE_OPTIONS } from '../dsh-live2d-pet/src/audio/envelope.mjs';

const SAMPLE_RATE = 24000;

/** n 秒静音。 */
function silence(seconds, sampleRate = SAMPLE_RATE) {
  return new Float32Array(Math.round(seconds * sampleRate));
}

/** n 秒正弦波，振幅 0..1。 */
function tone(seconds, amplitude = 0.5, frequency = 220, sampleRate = SAMPLE_RATE) {
  const count = Math.round(seconds * sampleRate);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return out;
}

/** n 秒白噪声，振幅 0..1。 */
function noise(seconds, amplitude = 0.5, sampleRate = SAMPLE_RATE, seed = 12345) {
  const count = Math.round(seconds * sampleRate);
  const out = new Float32Array(count);
  let state = seed;
  for (let i = 0; i < count; i += 1) {
    // xorshift32：可复现，测试失败时能原样重跑。
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    out[i] = amplitude * ((state / 0xffffffff) * 2 - 1);
  }
  return out;
}

function concat(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 从 `fromSeconds` 起，第一次满足 `predicate(openness)` 的时刻（秒）。
 * 找不到就返回 null —— 测试里必须显式处理，避免「断言没跑到」被当成通过。
 */
function firstCrossing(envelope, fromSeconds, predicate, stepSeconds = 0.002) {
  for (let t = fromSeconds; t <= envelope.durationSeconds + stepSeconds; t += stepSeconds) {
    if (predicate(envelope.opennessAt(t))) return t;
  }
  return null;
}

test('纯静音：整段输出为 0（不会因为 dB 除法反转而张到最大）', () => {
  const envelope = createEnvelope(silence(1.0), SAMPLE_RATE);
  assert.equal(envelope.maxOpenness(), 0);
  for (const t of [0, 0.1, 0.5, 0.99]) {
    assert.equal(envelope.opennessAt(t), 0, `t=${t} 应为 0`);
  }
});

test('极低电平底噪：低于静音判定线时输出为 0', () => {
  // -60dBFS 左右，比默认 noiseFloorDb(-45) 低，应当被整段判为静音。
  const envelope = createEnvelope(noise(1.0, 0.001), SAMPLE_RATE);
  assert.equal(envelope.maxOpenness(), 0, '底噪不该让嘴巴动');
});

test('稳态正弦：几百毫秒内张满并保持', () => {
  const envelope = createEnvelope(tone(1.0, 0.5), SAMPLE_RATE);
  const reached = firstCrossing(envelope, 0, (v) => v >= 0.9);
  assert.ok(reached !== null, '应当能达到 0.9');
  assert.ok(reached < 0.3, `起音应在 300ms 内，实测 ${(reached * 1000).toFixed(0)}ms`);
  // 保持段必须稳定在高位，中途掉下来说明平滑或归一化有问题。
  for (const t of [0.4, 0.6, 0.8, 0.95]) {
    assert.ok(envelope.opennessAt(t) > 0.85, `t=${t} 应保持张开，实测 ${envelope.opennessAt(t)}`);
  }
});

test('突发音：张开比闭合快（attack < release）', () => {
  const envelope = createEnvelope(concat(silence(0.2), tone(0.4, 0.5), silence(0.4)), SAMPLE_RATE);
  const ONSET = 0.2;
  const OFFSET = 0.6;

  const attackAt = firstCrossing(envelope, ONSET, (v) => v >= 0.5);
  const releaseAt = firstCrossing(envelope, OFFSET, (v) => v <= 0.5);
  assert.ok(attackAt !== null && releaseAt !== null, '起音与落音都必须发生');

  const attackMs = (attackAt - ONSET) * 1000;
  const releaseMs = (releaseAt - OFFSET) * 1000;
  assert.ok(attackMs < releaseMs, `attack 应快于 release，实测 attack=${attackMs.toFixed(0)}ms release=${releaseMs.toFixed(0)}ms`);

  // 30ms/80ms 的时间常数下，半程分别约 21ms / 55ms；给足余量只验量级。
  assert.ok(attackMs < 80, `attack 应在 80ms 内，实测 ${attackMs.toFixed(0)}ms`);
  assert.ok(releaseMs > 25 && releaseMs < 200, `release 应在 25–200ms，实测 ${releaseMs.toFixed(0)}ms`);
});

test('停顿回零：声音结束后必须真的回到 0（验收要求）', () => {
  const envelope = createEnvelope(concat(silence(0.2), tone(0.4, 0.5), silence(0.6)), SAMPLE_RATE);
  const OFFSET = 0.6;

  const zeroAt = firstCrossing(envelope, OFFSET, (v) => v === 0);
  assert.ok(zeroAt !== null, '结尾必须回到精确的 0');
  const tailMs = (zeroAt - OFFSET) * 1000;
  assert.ok(tailMs < 600, `应在 600ms 内归零，实测 ${tailMs.toFixed(0)}ms`);

  assert.equal(envelope.opennessAt(envelope.durationSeconds), 0);
});

test('自动增益：振幅 0.1 与 0.9 的语音都能张到接近满格', () => {
  const quiet = createEnvelope(tone(0.6, 0.1), SAMPLE_RATE);
  const loud = createEnvelope(tone(0.6, 0.9), SAMPLE_RATE);
  assert.ok(quiet.maxOpenness() > 0.95, `轻音也该张满，实测 ${quiet.maxOpenness()}`);
  assert.ok(loud.maxOpenness() > 0.95, `大声也该张满，实测 ${loud.maxOpenness()}`);
  // 两者都归一化到 1 附近，说明音量差异被抹平而不是直接当成张开度。
  assert.ok(Math.abs(quiet.maxOpenness() - loud.maxOpenness()) < 0.05);
});

test('输出恒在 [0, 1] 且不含 NaN', () => {
  const envelope = createEnvelope(concat(noise(0.3, 0.8), silence(0.2), tone(0.3, 0.3)), SAMPLE_RATE);
  for (let i = 0; i < envelope.levels.length; i += 1) {
    const value = envelope.levels[i];
    assert.ok(Number.isFinite(value), `第 ${i} 帧是 ${value}`);
    assert.ok(value >= 0 && value <= 1, `第 ${i} 帧越界：${value}`);
  }
});

test('时间轴：时长、帧间隔与越界查询', () => {
  const envelope = createEnvelope(tone(2.0, 0.5), SAMPLE_RATE);
  assert.ok(Math.abs(envelope.durationSeconds - 2.0) < 1e-6, `时长应为 2s，实测 ${envelope.durationSeconds}`);
  assert.ok(
    Math.abs(envelope.hopSeconds - DEFAULT_ENVELOPE_OPTIONS.hopMs / 1000) < 1e-9,
    `帧间隔应为 ${DEFAULT_ENVELOPE_OPTIONS.hopMs}ms`,
  );
  // 越界一律 0，而不是抛错或插值到数组外。
  assert.equal(envelope.opennessAt(-1), 0);
  assert.equal(envelope.opennessAt(0), 0);
  assert.equal(envelope.opennessAt(2.5), 0);
  assert.equal(envelope.opennessAt(Number.NaN), 0);
});

test('退化输入不炸：空数组、零采样率、单点', () => {
  for (const [samples, rate] of [[[], 24000], [new Float32Array(0), 24000], [new Float32Array(10), 0]]) {
    const envelope = createEnvelope(samples, rate);
    assert.equal(envelope.maxOpenness(), 0);
    assert.equal(envelope.opennessAt(0.1), 0);
  }
  const single = createEnvelope([0.5], SAMPLE_RATE);
  assert.ok(Number.isFinite(single.maxOpenness()));
  assert.ok(single.durationSeconds > 0);
});

test('性能：一根 5 秒的语音轨道构建时间应在毫秒级（渲染循环里要能随时重建）', () => {
  const samples = concat(silence(0.3), tone(4.4, 0.6), silence(0.3));
  const started = process.hrtime.bigint();
  const envelope = createEnvelope(samples, SAMPLE_RATE);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(envelope.frameCount > 400, `帧数应足够密，实测 ${envelope.frameCount}`);
  assert.ok(elapsedMs < 250, `5 秒音频应在 250ms 内算完，实测 ${elapsedMs.toFixed(1)}ms`);
});

test('opennessAt 是 O(1)：60fps 下逐帧查询 5 秒不会超时', () => {
  const envelope = createEnvelope(tone(5.0, 0.5), SAMPLE_RATE);
  const started = process.hrtime.bigint();
  let sink = 0;
  for (let frame = 0; frame < 300; frame += 1) sink += envelope.opennessAt(frame / 60);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(sink > 0, '查询必须真的取到值');
  assert.ok(elapsedMs < 20, `300 次查询应在 20ms 内，实测 ${elapsedMs.toFixed(2)}ms`);
});
