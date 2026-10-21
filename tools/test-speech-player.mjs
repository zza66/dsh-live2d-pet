/**
 * 口型驱动门禁：在 Node 里用**假 AudioContext** 把 `src/client/speech.ts` 真跑一遍。
 *
 * 为什么值得单独写一道：P0 #7 的验收是「说话时嘴巴会动」，而这条链上每一步都能
 * 悄悄坏掉 —— base64 解错、包络喂错通道、时间轴起点算错、说完不归零 —— 且**都不会
 * 报错**，只表现为「嘴巴不动」或「一直张着」。只靠人在页面里盯一眼，很容易把
 * 「我这次没看清」当成「通过」。
 *
 * 被测对象是 `dsh-live2d-pet/lib/test/speech-player.mjs`（由 `build.mjs` 产出，
 * 不是手写的副本）—— 所以这道门禁红了就说明**真的要上屏的那份代码**有问题。
 *
 * 假 AudioContext 只实现播放器真正用到的那几个成员（createGain / decodeAudioData /
 * createBufferSource / resume / currentTime / state）。`currentTime` 由测试推进，
 * 于是「播放到第 1.2 秒时嘴巴张多少」变成一个确定性断言，不需要真的等 1.2 秒。
 *
 * 用法：node tools/test-speech-player.mjs [--live]
 *   --live 额外把真实 Edge-TTS 返回的 MP3 走一遍 base64 → 解码入口，
 *          验证「真音频进得来、字节数对得上」（不验包络形状：Node 里没有 MP3 解码器）。
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const MODULE_PATH = resolve(ROOT, 'dsh-live2d-pet', 'lib', 'test', 'speech-player.mjs');
const LIVE = process.argv.includes('--live');

const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
    failures.push(label);
  }
}

if (!existsSync(MODULE_PATH)) {
  console.log(`[x] 找不到 ${MODULE_PATH} —— 先在 dsh-live2d-pet 里跑一次 node build.mjs`);
  process.exit(1);
}

/* ── 假 AudioContext ─────────────────────────────────────────────────── */

/** 合成分段信号：静音 → 正弦 → 静音。返回 Float32Array。 */
function makeSamples(sampleRate, segments) {
  const total = segments.reduce((sum, seg) => sum + Math.round(seg.seconds * sampleRate), 0);
  const data = new Float32Array(total);
  let cursor = 0;
  for (const seg of segments) {
    const count = Math.round(seg.seconds * sampleRate);
    for (let i = 0; i < count; i += 1) {
      // 两端各加 10ms 淡入淡出，避免凭空造出解码器不会产生的爆音边沿。
      const gain = Math.min(1, Math.min(i, count - 1 - i) / (sampleRate * 0.01));
      data[cursor + i] = seg.amplitude === 0
        ? 0
        : seg.amplitude * gain * Math.sin((2 * Math.PI * (seg.hz ?? 220) * i) / sampleRate);
    }
    cursor += count;
  }
  return data;
}

class FakeBufferSource {
  constructor() {
    this.buffer = null;
    this.onended = null;
    this.started = false;
  }
  connect() {}
  disconnect() {}
  start() { this.started = true; }
  stop() {}
}

class FakeAudioContext {
  /**
   * 实例化之前就要定好的东西 —— 因为播放器是**惰性**创建 AudioContext 的，
   * 测试没法先拿到实例再配置它。
   */
  static pending = null;        // 下一次 decodeAudioData 返回的 PCM
  static initialState = 'running';
  static resumeWorks = true;
  static last = null;

  constructor() {
    this.state = FakeAudioContext.initialState;
    this.currentTime = 0;
    this.sampleRate = 24000;
    this.sources = [];
    this.decodedBytes = [];
    this.resumeCalls = 0;
    FakeAudioContext.last = this;
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createBufferSource() {
    const node = new FakeBufferSource();
    this.sources.push(node);
    return node;
  }
  async resume() {
    this.resumeCalls += 1;
    // 没有用户手势时，真实的 resume() 会一直 pending 且 state 不变。
    if (FakeAudioContext.resumeWorks) this.state = 'running';
  }
  async decodeAudioData(bytes) {
    this.decodedBytes.push(bytes?.byteLength ?? -1);
    const samples = FakeAudioContext.pending ?? makeSamples(this.sampleRate, [{ seconds: 0.1, amplitude: 0 }]);
    return {
      duration: samples.length / this.sampleRate,
      sampleRate: this.sampleRate,
      length: samples.length,
      numberOfChannels: 1,
      getChannelData: () => samples,
    };
  }
  /** 让播放器认为「已经播了 t 秒」。 */
  advance(seconds) { this.currentTime += seconds; }
  /** 模拟播放自然结束（真实浏览器由 onended 通知）。 */
  finish() { for (const node of this.sources) node.onended?.(); }

  static reset(pcm) {
    FakeAudioContext.pending = pcm;
    FakeAudioContext.initialState = 'running';
    FakeAudioContext.resumeWorks = true;
    FakeAudioContext.last = null;
  }
}

globalThis.AudioContext = FakeAudioContext;

const { createSpeechPlayer } = await import(pathToFileURL(MODULE_PATH).href);
/**
 * 一段假的「MP3」：开头是真的 MP3 帧同步字（0xFF 0xFB），内容无所谓 ——
 * 真正的解码由假 AudioContext 接管。但**长度有意义**：下面会断言它一字节不差地
 * 抵达了 `decodeAudioData`，这是 base64 那一段唯一的职责。
 */
const FAKE_MP3_BYTES = [0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00];
const FAKE_MP3_BASE64 = Buffer.from(FAKE_MP3_BYTES).toString('base64');

/* ── [1] 未播放时的基线 ──────────────────────────────────────────────── */
console.log('[1] 未播放时');
{
  const player = createSpeechPlayer();
  check('openness() 恒为 0', player.openness() === 0);
  check('state.speaking 为 false', player.state.speaking === false);
  check('audioState 为 closed（没建过 AudioContext）',
    player.state.audioState === 'closed', player.state.audioState);
  check('没建 AudioContext 就没实例', FakeAudioContext.last === null);
  player.stop();
  check('stop() 在未播放时不抛', true);
}

/* ── [2] 真播一段：包络应当「静音低 → 出声高 → 收尾归零」 ────────────── */
console.log('\n[2] 播一段 静音0.2s → 正弦1.0s → 静音0.4s');
{
  FakeAudioContext.reset(makeSamples(24000, [
    { seconds: 0.2, amplitude: 0 },
    { seconds: 1.0, amplitude: 0.7, hz: 220 },
    { seconds: 0.4, amplitude: 0 },
  ]));
  const player = createSpeechPlayer();
  await player.playBase64(FAKE_MP3_BASE64, '门禁测试');
  const ctx = FakeAudioContext.last;

  check('一个 source 被创建', ctx.sources.length === 1);
  check('并且真的 start() 了', ctx.sources[0].started === true);
  check('base64 一字节不差地解出来', ctx.decodedBytes[0] === FAKE_MP3_BYTES.length,
    `${ctx.decodedBytes[0]} vs ${FAKE_MP3_BYTES.length}`);
  check('state.speaking 为 true', player.state.speaking === true);
  check('state.text 记录了文本', player.state.text === '门禁测试');
  check('state.durationSeconds ≈ 1.6', Math.abs(player.state.durationSeconds - 1.6) < 0.01,
    String(player.state.durationSeconds));
  check('包络帧数 > 100', player.state.frames > 100, String(player.state.frames));
  check('包络峰值 > 0', player.state.peak > 0, String(player.state.peak));
  check('state.lastError 已清空', player.state.lastError === null);
  /*
   * 音源声明：默认必须是 edge（老路径一行都不改），传了才换。
   * 写死 'edge' 的症状是「试听自己导入的录音，面板上写着 Edge-TTS」。
   */
  check('默认音源是 edge（老调用点不受影响）', player.state.adapterId === 'edge', player.state.adapterId);

  {
    const voiced = createSpeechPlayer();
    await voiced.playBase64(FAKE_MP3_BASE64, '试听语音包', [], { adapterId: 'voice' });
    check('★ 传了 adapterId 之后面板音源跟着变（语音包试听）',
      voiced.state.adapterId === 'voice', voiced.state.adapterId);
    check('★ 语音包那一路不会把 degraded 留在 true 上',
      voiced.state.degraded === false && voiced.state.notice === '',
      `${voiced.state.degraded}/${voiced.state.notice}`);
    voiced.stop();
  }

  // 时间轴：t = ctx.currentTime - startedAt（startedAt 是 playBase64 时的 currentTime = 0）
  const atHead = player.openness();
  check('t=0（前导静音）张开度 < 0.1', atHead < 0.1, atHead.toFixed(4));

  ctx.advance(0.7);
  const atLoud = player.openness();
  check('t=0.7（正弦中段）张开度 > 0.7', atLoud > 0.7, atLoud.toFixed(4));

  ctx.advance(0.35);
  const stillLoud = player.openness();
  check('t=1.05 仍在出声', stillLoud > 0.5, stillLoud.toFixed(4));

  ctx.advance(2.0); // 越过 1.6s + 尾巴
  const afterEnd = player.openness();
  check('播完（越过尾巴）后张开度归零', afterEnd === 0, String(afterEnd));

  check('张开度恒在 [0,1]', [atHead, atLoud, stillLoud, afterEnd].every((v) => v >= 0 && v <= 1));
}

/* ── [3] 自然结束：onended 要把 speaking 落回 false ───────────────────── */
console.log('\n[3] 播放自然结束');
{
  FakeAudioContext.reset(makeSamples(24000, [{ seconds: 0.5, amplitude: 0.6 }]));
  const player = createSpeechPlayer();
  await player.playBase64(FAKE_MP3_BASE64, '短句');
  const ctx = FakeAudioContext.last;
  check('播放中 speaking 为 true', player.state.speaking === true);
  ctx.advance(0.5);
  ctx.finish();
  check('onended 之后 speaking 为 false', player.state.speaking === false);
  ctx.advance(0.2);
  check('结束后张开度归零', player.openness() === 0);
}

/* ── [4] 打断：新的一句不能被上一句的结束事件关掉 ────────────────────── */
console.log('\n[4] 连说两句（打断）');
{
  FakeAudioContext.reset(makeSamples(24000, [{ seconds: 2.0, amplitude: 0.7 }]));
  const player = createSpeechPlayer();
  await player.playBase64(FAKE_MP3_BASE64, '第一句');
  const ctx = FakeAudioContext.last;
  const firstSource = ctx.sources[ctx.sources.length - 1];

  ctx.advance(0.3);
  await player.playBase64(FAKE_MP3_BASE64, '第二句');
  check('第二句的 source 也 start 了', ctx.sources.length === 2 && ctx.sources[1].started === true);
  check('state.text 换成了第二句', player.state.text === '第二句');

  // 上一句的 onended 迟到了：它**不能**把第二句标成结束。
  firstSource.onended?.();
  check('迟到 onended 没有关掉第二句', player.state.speaking === true);

  ctx.advance(0.2);
  check('第二句仍在出声（张开度 > 0.5）', player.openness() > 0.5, player.openness().toFixed(4));
}

/* ── [5] stop() ─────────────────────────────────────────────────────── */
console.log('\n[5] stop()');
{
  FakeAudioContext.reset(makeSamples(24000, [{ seconds: 1.0, amplitude: 0.7 }]));
  const player = createSpeechPlayer();
  await player.playBase64(FAKE_MP3_BASE64, '被打断');
  const ctx = FakeAudioContext.last;
  ctx.advance(0.3);
  check('打断前张开度 > 0.5', player.openness() > 0.5, player.openness().toFixed(4));
  player.stop();
  check('stop() 之后 speaking 为 false', player.state.speaking === false);
  check('stop() 之后张开度归零', player.openness() === 0);
}

/* ── [6] 错误路径必须抛出来，而不是静默不动 ─────────────────────────── */
console.log('\n[6] 错误路径');
{
  FakeAudioContext.reset(makeSamples(24000, [{ seconds: 0.1, amplitude: 0 }]));
  const player = createSpeechPlayer();
  let emptyError = '';
  try {
    await player.playBase64('');
  } catch (error) {
    emptyError = String(error?.message ?? error);
  }
  check('空音频抛 E_AUDIO_EMPTY', emptyError.startsWith('E_AUDIO_EMPTY'), emptyError);
  check('失败原因进了 state.lastError', String(player.state.lastError ?? '').startsWith('E_AUDIO_EMPTY'));
}

{
  // 被自动播放策略挂起：必须给出可执行的提示，不能只是「点了没反应」。
  FakeAudioContext.reset(makeSamples(24000, [{ seconds: 0.3, amplitude: 0.5 }]));
  FakeAudioContext.initialState = 'suspended';
  FakeAudioContext.resumeWorks = false;
  const player = createSpeechPlayer();
  let blockedError = '';
  const started = Date.now();
  try {
    await player.playBase64(FAKE_MP3_BASE64, '被挡住');
  } catch (error) {
    blockedError = String(error?.message ?? error);
  }
  const elapsed = Date.now() - started;
  check('挂起时抛 E_AUDIO_BLOCKED', blockedError.startsWith('E_AUDIO_BLOCKED'), blockedError);
  check('没有无限等 resume（<2s）', elapsed < 2000, `${elapsed}ms`);
  check('state.audioState 如实反映挂在 suspended', player.state.audioState === 'suspended');
  FakeAudioContext.resumeWorks = true;
  FakeAudioContext.initialState = 'running';
}

{
  // 环境里根本没有 AudioContext（例如 Node 里跑 SSR、或极老的浏览器）。
  FakeAudioContext.reset(makeSamples(24000, [{ seconds: 0.1, amplitude: 0 }]));
  const saved = globalThis.AudioContext;
  delete globalThis.AudioContext;
  const player = createSpeechPlayer();
  let noCtxError = '';
  try {
    await player.playBase64(FAKE_MP3_BASE64, '没有音频环境');
  } catch (error) {
    noCtxError = String(error?.message ?? error);
  }
  check('没有 AudioContext 时抛 E_AUDIO_UNAVAILABLE', noCtxError.startsWith('E_AUDIO_UNAVAILABLE'), noCtxError);
  check('并且 openness() 仍然是 0 而不是 NaN', player.openness() === 0);
  globalThis.AudioContext = saved;
}

/* ── [7] subscribe / warmUp ──────────────────────────────────────────── */
console.log('\n[7] 订阅与解锁');
{
  FakeAudioContext.reset(null);
  const player = createSpeechPlayer();
  let notified = 0;
  const off = player.subscribe(() => { notified += 1; });
  await player.warmUp();
  check('warmUp() 触发了通知', notified >= 1, String(notified));
  check('warmUp() 之后 audioState 为 running', player.state.audioState === 'running', player.state.audioState);
  off();
  const before = notified;
  await player.warmUp();
  check('取消订阅后不再通知', notified === before, `${before} → ${notified}`);
}

/* ── [8] 系统语音降级路径（Edge-TTS 够不到时的兜底） ──────────────────── */
console.log('\n[8] 系统语音降级');
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class FakeUtterance {
    constructor(text) {
      this.text = text;
      this.onstart = null;
      this.onboundary = null;
      this.onend = null;
      this.onerror = null;
    }
  }
  class FakeSpeechSynthesis {
    constructor() { this.spoken = []; this.cancelled = 0; }
    speak(u) { this.spoken.push(u); }
    cancel() { this.cancelled += 1; }
    static reset() {
      FakeSpeechSynthesis.last = new FakeSpeechSynthesis();
      globalThis.speechSynthesis = FakeSpeechSynthesis.last;
      globalThis.SpeechSynthesisUtterance = FakeUtterance;
      return FakeSpeechSynthesis.last;
    }
  }
  const fire = (u, name, payload = {}) => u?.[name]?.({ type: name, ...payload });

  FakeAudioContext.reset(null);
  const synth = FakeSpeechSynthesis.reset();

  // —— 先验两条「不该降级」的路径 ——
  {
    const player = createSpeechPlayer();
    let emptyError = '';
    try {
      await player.speakWithSystemVoice('   ');
    } catch (error) {
      emptyError = String(error?.message ?? error);
    }
    check('空文本抛 E_TTS_EMPTY_TEXT', emptyError.startsWith('E_TTS_EMPTY_TEXT'), emptyError);
    check('空文本没有真的去念', synth.spoken.length === 0, String(synth.spoken.length));

    const saved = globalThis.speechSynthesis;
    delete globalThis.speechSynthesis;
    const p2 = createSpeechPlayer();
    let noFallback = '';
    try {
      await p2.speakWithSystemVoice('你好');
    } catch (error) {
      noFallback = String(error?.message ?? error);
    }
    check('没有 speechSynthesis 时抛 E_TTS_NO_FALLBACK',
      noFallback.startsWith('E_TTS_NO_FALLBACK'), noFallback);
    check('并且没有把它记成成功', p2.state.speaking === false);
    globalThis.speechSynthesis = saved;
  }

  // —— 正常降级：张嘴靠 onboundary + 180ms 衰减 ——
  {
    const player = createSpeechPlayer();
    check('初始 adapterId 是 edge', player.state.adapterId === 'edge', player.state.adapterId);
    check('初始 degraded 是 false', player.state.degraded === false);

    await player.speakWithSystemVoice('降级测试。', 'Edge-TTS 用不了，音质会明显下降。');
    const utterance = FakeSpeechSynthesis.last.spoken[0];
    check('真的调用了 speechSynthesis.speak', FakeSpeechSynthesis.last.spoken.length === 1);
    check('文本原样传进去', utterance?.text === '降级测试。', String(utterance?.text));
    check('state.adapterId 变成 system', player.state.adapterId === 'system', player.state.adapterId);
    check('state.degraded 变成 true', player.state.degraded === true);
    check('notice 原样保留给界面', player.state.notice.includes('音质'), player.state.notice);
    check('onstart 之前嘴巴是闭着的', player.openness() === 0);

    fire(utterance, 'onstart');
    const atStart = player.openness();
    check('onstart 之后张嘴（衰减起点接近满格）', atStart > 0.8, atStart.toFixed(4));
    check('state.speaking 为 true', player.state.speaking === true);

    // 180ms 是「一个音节」的近似：过了它就该闭嘴，否则说话时嘴一直张着。
    await sleep(230);
    check('超过 BOUNDARY_DECAY_MS 后自然闭合', player.openness() === 0, player.openness().toFixed(4));

    const framesBefore = player.state.frames;
    fire(utterance, 'onboundary', { name: '降', charIndex: 0 });
    check('onboundary 把嘴巴重新张开', player.openness() > 0.8, player.openness().toFixed(4));
    check('onboundary 也让 frames 计数增长（面板看得见边界事件）',
      player.state.frames === framesBefore + 1, `${framesBefore} → ${player.state.frames}`);

    fire(utterance, 'onend');
    check('onend 之后 speaking 落回 false', player.state.speaking === false);
    check('onend 之后嘴巴闭合', player.openness() === 0);
  }

  // —— stop() 必须在降级路径上同样有效（否则她会一直说个不停） ——
  {
    const player = createSpeechPlayer();
    const before = FakeSpeechSynthesis.last.cancelled;
    await player.speakWithSystemVoice('打断测试。');
    const utterance = FakeSpeechSynthesis.last.spoken.at(-1);
    fire(utterance, 'onstart');
    check('打断前嘴巴是张着的', player.openness() > 0.5);

    player.stop();
    check('stop() 之后立刻闭嘴', player.openness() === 0, player.openness().toFixed(4));
    check('stop() 之后 speaking 为 false', player.state.speaking === false);
    check('stop() 真的调用了 synth.cancel()',
      FakeSpeechSynthesis.last.cancelled > before, `${before} → ${FakeSpeechSynthesis.last.cancelled}`);

    // 迟到的 onend 不能改状态（它属于已经被丢掉的那一句）。
    fire(utterance, 'onend');
    check('被丢掉那一句的迟到 onend 不影响现状', player.state.speaking === false);
  }

  // —— 从降级切回正常：两个引擎绝不能同时说话 ——
  {
    FakeAudioContext.reset(makeSamples(24000, [{ seconds: 0.3, amplitude: 0.7, hz: 220 }]));
    const player = createSpeechPlayer();
    await player.speakWithSystemVoice('先降级。');
    const utterance = FakeSpeechSynthesis.last.spoken.at(-1);
    fire(utterance, 'onstart');
    const cancelledBefore = FakeSpeechSynthesis.last.cancelled;

    await player.playBase64(FAKE_MP3_BASE64, '再正常播一句');
    check('切回正常时停掉了系统语音（不会两个引擎同时说话）',
      FakeSpeechSynthesis.last.cancelled > cancelledBefore,
      `${cancelledBefore} → ${FakeSpeechSynthesis.last.cancelled}`);
    check('adapterId 回到 edge', player.state.adapterId === 'edge', player.state.adapterId);
    check('degraded 回到 false', player.state.degraded === false);
    check('notice 被清空', player.state.notice === '', player.state.notice);
    check('降级那句的张开度不再影响当前（系统语音状态已清）',
      Number.isFinite(player.openness()), String(player.openness()));
  }

  // —— 清理全局，免得影响后面的段 ——
  delete globalThis.speechSynthesis;
  delete globalThis.SpeechSynthesisUtterance;
  // —— 面板那一行字的优先规则（写反了只有用户能发现） ——
  {
    const { describeSpeechState } = await import(pathToFileURL(MODULE_PATH).href);
    const base = {
      speaking: false, text: null, durationSeconds: 0, frames: 0, peak: 0,
      lastError: null, audioState: 'closed', adapterId: 'edge', degraded: false, notice: '',
    };
    check('空闲时显示「待机」', describeSpeechState(base) === '待机', describeSpeechState(base));

    const degraded = { ...base, adapterId: 'system', degraded: true, notice: '音质已降级，口型也只能近似。', speaking: true };
    check('★ 降级提示优先于「说话中」（§6.1 #8 要求界面给出降级提示）',
      describeSpeechState(degraded).includes('音质已降级'), describeSpeechState(degraded));
    check('★ 降级时不会显示「说话中 0.00s · 包络 0 帧」那种像坏了的字',
      !describeSpeechState(degraded).includes('0.00s'), describeSpeechState(degraded));

    const degradedError = { ...degraded, lastError: 'E_TTS_NO_FALLBACK: 浏览器没有提供系统语音' };
    check('★ 错误优先于降级提示（降级路径自己也会失败）',
      describeSpeechState(degradedError).startsWith('语音失败：'), describeSpeechState(degradedError));

    const degradedNoNotice = { ...base, adapterId: 'system', degraded: true, speaking: false };
    check('降级提示丢了也不会显示空白',
      describeSpeechState(degradedNoNotice).includes('音质已降级'), describeSpeechState(degradedNoNotice));

    const speaking = { ...base, speaking: true, durationSeconds: 1.68, frames: 168, peak: 0.99 };
    check('正常说话时报出包络帧数（验收「口型真的在动」）',
      describeSpeechState(speaking).includes('包络 168 帧'), describeSpeechState(speaking));
    check('正常说话时标出引擎是 Edge-TTS',
      describeSpeechState(speaking).includes('Edge-TTS'), describeSpeechState(speaking));
    check('降级路径说话时标出引擎是系统语音',
      describeSpeechState({ ...speaking, adapterId: 'system', degraded: true, notice: '' })
        .includes('系统语音'),
      describeSpeechState({ ...speaking, adapterId: 'system', degraded: true, notice: '' }));

    /*
     * ★ 这条是「面板撒谎」的直接反证：以前这里是写死的三元表达式
     * （system ? 系统语音 : Edge-TTS），于是试听本地录音时也报 Edge-TTS。
     */
    check('★ 试听本地语音包时音源写「语音包」，不是 Edge-TTS',
      describeSpeechState({ ...speaking, adapterId: 'voice' }).includes('语音包')
        && !describeSpeechState({ ...speaking, adapterId: 'voice' }).includes('Edge-TTS'),
      describeSpeechState({ ...speaking, adapterId: 'voice' }));
    check('认不出的音源 id 原样显示（将来接第三条音源时不用改这里）',
      describeSpeechState({ ...speaking, adapterId: 'azure' }).includes('azure'),
      describeSpeechState({ ...speaking, adapterId: 'azure' }));
    check('音源 id 为空时给一个诚实的兜底，而不是空白',
      describeSpeechState({ ...speaking, adapterId: '' }).includes('未知音源'),
      describeSpeechState({ ...speaking, adapterId: '' }));

    check('被浏览器挂起时给出可操作的提示',
      describeSpeechState({ ...base, audioState: 'suspended' }).includes('点一下页面'),
      describeSpeechState({ ...base, audioState: 'suspended' }));
    check('面板文字里不出现 undefined / NaN',
      !describeSpeechState(degraded).includes('undefined')
        && !describeSpeechState(speaking).includes('NaN'));
  }
}

/* ── [9] 真音频（联网）：base64 → 字节 → 解码入口 ────────────────────── */
if (LIVE) {
  console.log('\n[9] 真实 Edge-TTS 音频走完整条解码入口');
  const { synthesize } = await import(
    pathToFileURL(resolve(ROOT, 'dsh-live2d-pet', 'lib', 'host', 'edge-tts.js')).href
  );
  const result = await synthesize({ text: '口型测试。', noCache: true });
  const base64 = result.audio.toString('base64');
  console.log(`      合成 ${result.audio.length} 字节 / ${result.durationSeconds.toFixed(3)}s / ${result.words.length} 条词边界`);

  // 真 MP3 在 Node 里解不开，但**字节必须原样抵达解码入口** —— 那正是 base64 这一段的职责。
  FakeAudioContext.reset(makeSamples(24000, [{ seconds: result.durationSeconds, amplitude: 0.7 }]));
  const player = createSpeechPlayer();
  await player.playBase64(base64, '口型测试。');
  const ctx = FakeAudioContext.last;
  check('base64 解出的字节数与 MP3 一致', ctx.decodedBytes[ctx.decodedBytes.length - 1] === result.audio.length,
    `${ctx.decodedBytes[ctx.decodedBytes.length - 1]} vs ${result.audio.length}`);
  check('持续时间来自解码结果', Math.abs(player.state.durationSeconds - result.durationSeconds) < 0.05,
    `${player.state.durationSeconds.toFixed(3)} vs ${result.durationSeconds.toFixed(3)}`);
  ctx.advance(result.durationSeconds * 0.5);
  check('播放中段张开度 > 0.5', player.openness() > 0.5, player.openness().toFixed(4));
  ctx.advance(result.durationSeconds);
  check('播完后归零', player.openness() === 0);
} else {
  console.log('\n[9] 跳过真实音频（未加 --live）');
}

console.log('');
if (failures.length === 0) {
  console.log('[10] SPEECH PLAYER GATE PASSED');
} else {
  console.log(`[x] SPEECH PLAYER GATE FAILED：${failures.length} 项未通过`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exitCode = 1;
}
