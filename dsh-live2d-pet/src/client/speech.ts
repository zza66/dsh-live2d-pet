/**
 * 语音播放 + 口型驱动（客户端）。
 *
 * ## 为什么口型从**解码后的音频**算，而不是用 Host 给的词边界
 *
 * 三条理由，任何一条单独都够：
 *
 * 1. **时钟一致**。词边界的 `Offset` 是相对「未压缩流 t=0」的，而播放要经过
 *    MP3 解码，解码器会引入 25–50ms 的前导延迟。拿词边界对 `AudioContext.currentTime`
 *    就是在拿两把不同的尺子量同一段时间。
 * 2. **粒度不够**。词边界只告诉你「这个词从哪开始」，「好——」这种拉长音期间嘴巴
 *    该不该一直张着，它答不了。逐帧 RMS 答得了。
 * 3. **同一个时间轴**。包络的时间轴就是 `AudioContext.currentTime` 减开始时刻，
 *    与耳朵听到的是同一个时钟，天然不会漂。
 *
 * 所以词边界只喂字幕（`words` 原样透传），口型走包络。
 *
 * ## 为什么不用 `<audio>` 元素
 *
 * `HTMLAudioElement` 没法把音频样本交出来算 RMS，也没法保证 `currentTime` 与
 * 实际输出对齐到同一帧。Web Audio 的 `AudioBuffer` 一次就把两件事都给了。
 *
 * @module client/speech
 */

import { createEnvelope } from '../audio/envelope.mjs';

/** 包络对象的最小形状（`envelope.mjs` 是纯 JS，这里只声明我们真的用到的那几个成员）。 */
interface EnvelopeLike {
  durationSeconds: number;
  frameCount: number;
  peak: number;
  opennessAt(seconds: number): number;
}

export interface SpeechPlayerState {
  /** 是否正在出声。 */
  speaking: boolean;
  /** 最近一次播放的文本（只用于面板展示）。 */
  text: string | null;
  /** 最近一次播放的时长（秒）。 */
  durationSeconds: number;
  /** 包络的帧数，用来确认「口型是真的在动」而不是恒 0。 */
  frames: number;
  /** 包络的峰值，同上。 */
  peak: number;
  /** 最近一次失败的原因；成功一次就清空。 */
  lastError: string | null;
  /** AudioContext 的状态（`suspended` 表示浏览器还在等一次用户手势）。 */
  audioState: string;
  /** 正在用的 TTS 适配器 id（`edge` = Host 的在线合成，`system` = 浏览器自带语音）。 */
  adapterId: string;
  /** 是否处在降级状态（方案文档 §6.1 #8）。 */
  degraded: boolean;
  /** 给用户看的降级提示；没降级时是空串。 */
  notice: string;
  /** 这一句的词边界（**只喂字幕**，不驱动口型 —— 见 §4.2.1 的三条理由）。 */
  words: SpeechWord[];
}

/** 一个词的时间轴信息，来自 Edge-TTS 的 `WordBoundary`。 */
export interface SpeechWord {
  text: string;
  /** 相对**未压缩流 t=0** 的起点（秒）。 */
  offsetSeconds: number;
  /** 这个词持续多久（秒）。 */
  durationSeconds: number;
}

export interface SpeechPlayer {
  /** 每帧调用，返回这一帧应有的口型张开度 [0,1]。没有在说话时恒为 0。 */
  openness(): number;
  /**
   * 播一段 base64 的 MP3；会打断上一段。
   *
   * `words` 是 Host 从 Edge-TTS 拿到的词边界，**只用于字幕**。它不参与口型：
   * `offsetSeconds` 是相对未压缩流 t=0 的，而口型走的是解码后的包络（§4.2.1）。
   *
   * `options.adapterId` 让调用方声明「这段音频是谁给的」。默认 `'edge'`（Edge-TTS），
   * 本地语音包传 `'voice'` —— 面板上那一行音源名字就是从这里来的，写死会让
   * 试听用户自己的录音时显示「Edge-TTS」。
   */
  playBase64(
    audioBase64: string,
    text?: string | null,
    words?: SpeechWord[],
    options?: { adapterId?: string },
  ): Promise<void>;
  /**
   * 用浏览器自带的 `speechSynthesis` 说一句话 —— 降级路径（§6.1 #8）。
   *
   * 与 `playBase64` 相比它拿不到音频数据，所以**没有真实包络**：口型改用
   * `onboundary`（词边界事件）近似，每个词张开一次然后衰减。
   */
  speakWithSystemVoice(text: string, notice?: string): Promise<void>;
  /**
   * 这一瞬间正在念第几个词；没有在念词时返回 -1。
   *
   * 给字幕用。**只在 `adapterId === 'edge'` 时有值** —— 系统语音的边界事件
   * 只在 `onboundary` 那一刻告诉了我们「到哪个词了」，没有时间轴，所以那边
   * 由播放器把边界序号累加进 `state.frames`，字幕退化成「整句高亮」。
   */
  activeWordIndex(): number;
  stop(): void;
  /** 在用户手势里调用一次，解除浏览器的自动播放限制。 */
  warmUp(): Promise<void>;
  readonly state: SpeechPlayerState;
  /** 状态变化时通知（面板刷新用）。 */
  subscribe(listener: () => void): () => void;
}

/** 音频结束后的这一小段时间里继续读包络，避免最后几帧被硬切断。 */
const TAIL_SECONDS = 0.08;

/**
 * 面板上那一行字。
 *
 * 放在这里而不是界面文件里，是因为它有两条**容易被写反**的优先规则，而写反了只有
 * 用户能发现（面板上少了一句话，谁也不会报错）：
 *
 * 1. **降级提示排在「说话中」前面。** 降级时 `durationSeconds` 永远是 0（系统语音
 *    不给音频，没有时长可报），先走「说话中」那一支的话，用户看到的是
 *    「说话中 0.00s · 包络 0 帧」—— 一句看起来像坏了的技术话。而方案文档 §6.1 #8
 *    明确要求「UI 显示质量降级提示」，真正该告诉他的是「她的声音为什么变了」。
 * 2. **错误排在降级前面。** 降级路径自己也会失败（`E_TTS_NO_FALLBACK`），
 *    那时提示语和错误同时存在，用户需要知道的是后者。
 */
export function describeSpeechState(state: SpeechPlayerState): string {
  if (state.lastError !== null) return `语音失败：${state.lastError}`;
  if (state.notice !== '') return state.notice;
  if (state.degraded) {
    // 提示语丢了但仍在降级（理论上到不了，留个兜底免得面板出现空白）。
    return `正在用${engineLabel(state.adapterId)}（音质已降级）`;
  }
  if (state.speaking) {
    return `说话中 ${state.durationSeconds.toFixed(2)}s · 包络 ${state.frames} 帧 · 峰值 ${state.peak.toFixed(3)} · ${engineLabel(state.adapterId)}`;
  }
  if (state.audioState === 'suspended') return '音频被浏览器挂起：点一下页面即可解锁';
  return '待机';
}

/**
 * 音源 id → 面板上那个名字。
 *
 * ★ 为什么要单独一个函数：以前这里是写死的 `adapterId === 'system' ? '系统语音' : 'Edge-TTS'`，
 * 于是接上本地语音包之后，面板会**斩钉截铁地撒谎** —— 播的是用户自己的录音，
 * 上面写着「Edge-TTS」。这种错不会抛异常，只会让用户怀疑自己导入失败了。
 *
 * 认不出来的 id 原样显示而不是折叠成「未知」：将来接第三条音源（比如另一家在线 TTS）
 * 时，面板上直接出现它的 id，比一个笼统的「未知」有用。
 */
export function engineLabel(adapterId: unknown): string {
  if (adapterId === 'system') return '系统语音';
  if (adapterId === 'voice') return '语音包';
  if (adapterId === 'edge') return 'Edge-TTS';
  // 用户自己的本地服务（GPT-SoVITS 之类）。写「本地 TTS」而不是「自定义」：
  // 这一行是给用户看的结论，不是配置项的复述。
  if (adapterId === 'custom') return '本地 TTS';
  return typeof adapterId === 'string' && adapterId !== '' ? adapterId : '未知音源';
}

/**
 * 降级路径里「一个词」对应的张嘴时长（毫秒）。
 *
 * 这个数字是**近似**，不是测量结果 —— 系统语音不给我们音频，我们只知道
 * 「某个词从这一刻开始念」。180ms 大约是一个音节的长度，看起来像是在说话；
 * 再长就会显得嘴一直张着，再短就会抖。
 */
const BOUNDARY_DECAY_MS = 180;

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(String(base64 ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function resolveAudioContextCtor(): (new () => AudioContext) | null {
  const scope = globalThis as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * 把 Host 送来的词边界清一遍。
 *
 * Host 那边是照 Edge-TTS 的报文直接映射的，这里不能假设它一定干净：一个
 * `offsetSeconds: NaN` 会让 `activeWordIndex()` 的循环在第一次比较时就判 false，
 * 于是字幕永远不高亮 —— 而「字幕不高亮」不会报任何错，只会让人以为是设计如此。
 * 所以宁可在这里丢掉坏条目。
 *
 * 顺带按起点排序：Edge-TTS 按顺序发，但没有任何地方保证这件事。
 */
function normalizeWords(input: SpeechWord[] | null | undefined): SpeechWord[] {
  if (!Array.isArray(input)) return [];
  const cleaned: SpeechWord[] = [];
  for (const raw of input) {
    const text = typeof raw?.text === 'string' ? raw.text : '';
    const offsetSeconds = Number(raw?.offsetSeconds);
    const durationSeconds = Number(raw?.durationSeconds);
    if (text === '') continue;
    if (!isFinite(offsetSeconds) || offsetSeconds < 0) continue;
    cleaned.push({
      text,
      offsetSeconds,
      durationSeconds: isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0,
    });
  }
  cleaned.sort((a, b) => a.offsetSeconds - b.offsetSeconds);
  return cleaned;
}

/**
 * 取浏览器的语音合成接口。
 *
 * 惰性取（不在模块作用域拿），理由同 `AudioContext`：这个模块会在插件 `apply()`
 * 时被求值，而求值期抛异常是本项目最贵的一类事故（方案 §9.2）。
 * 另外它确实可能不存在 —— 无头浏览器、某些精简内核、以及 Node 门禁环境。
 */
function resolveSpeechSynthesis(): SpeechSynthesis | null {
  const scope = globalThis as unknown as { speechSynthesis?: SpeechSynthesis };
  return scope.speechSynthesis ?? null;
}

/**
 * 建一个播放器。
 *
 * AudioContext **惰性创建**：构造它本身在某些浏览器里就要用户手势，而这个模块
 * 会在插件 `apply()` 时被求值 —— 求值期抛异常是本项目最贵的一类事故（见方案 §9.2），
 * 所以这里连 `new AudioContext()` 都不做，一直等到真的要出声。
 */
export function createSpeechPlayer(): SpeechPlayer {  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let source: AudioBufferSourceNode | null = null;
  let envelope: EnvelopeLike | null = null;
  let startedAt = 0;
  let endedAt = 0;
  let token = 0;

  /**
   * 降级路径的状态。
   *
   * 系统语音不给音频，所以这里没有包络，只有一个「这个词念到什么时候」的时间戳，
   * 口型按它线性衰减。时钟用 `Date.now()` 而不是 `AudioContext.currentTime` ——
   * 降级时可能连 AudioContext 都建不起来（那正是要降级的原因之一）。
   */
  let systemUtterance: SpeechSynthesisUtterance | null = null;
  let systemDecayAtMs = 0;
  let systemSpeaking = false;

  const listeners = new Set<() => void>();
  const state: SpeechPlayerState = {
    speaking: false,
    text: null,
    durationSeconds: 0,
    frames: 0,
    peak: 0,
    lastError: null,
    audioState: 'closed',
    adapterId: 'edge',
    degraded: false,
    notice: '',
    words: [],
  };

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* 某个订阅者出错不该影响播放 */
      }
    }
  }

  function syncAudioState(): void {
    state.audioState = ctx === null ? 'closed' : ctx.state;
  }

  /** 确保 AudioContext 存在且是 running；拿不到就抛带错误码的 Error。 */
  async function ensureContext(): Promise<AudioContext> {
    if (ctx === null) {
      const Ctor = resolveAudioContextCtor();
      if (Ctor === null) {
        throw new Error('E_AUDIO_UNAVAILABLE: 这个环境没有 AudioContext');
      }
      ctx = new Ctor();
      gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') {
      // 浏览器自动播放策略：没有用户手势时 resume() 会一直 pending。
      // 所以给它一个上限，别把整句话卡在这里。
      await Promise.race([
        ctx.resume().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
    }
    syncAudioState();
    if (ctx.state !== 'running') {
      throw new Error(`E_AUDIO_BLOCKED: AudioContext 处于 ${ctx.state}，需要先点一下页面`);
    }
    return ctx;
  }

  function teardown(): void {
    // 包络必须一起丢掉。否则 `stop()` 之后 `openness()` 还会继续读它，
    // 于是嘴巴在停止后仍然张着最多一整个尾巴时长（实测被门禁抓到）。
    // 停止 = 忘掉这一段，而不是「让它自然播完」。
    envelope = null;
    // 字幕跟着一起清掉：停止 = 这一句已经不存在了。
    state.words = [];
    if (source !== null) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* 已经停了 */
      }
      try {
        source.disconnect();
      } catch {
        /* 已经断开 */
      }
      source = null;
    }
  }

  /**
   * 停掉降级路径。与 `teardown()` 分开是刻意的：两条路径用的是两个完全不同的
   * 引擎，把它们混在一个函数里，早晚会出现「停了 Edge 的音频，忘了停系统语音」
   * 这种只有用户能发现的 bug（她一直说个不停）。
   */
  function teardownSystemVoice(): void {
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
        /* 没有在说 */
      }
    }
  }

  return {
    state,

    openness(): number {
      // 降级路径优先：它没有 AudioContext 也照样得动嘴。
      if (systemSpeaking) {
        const remaining = systemDecayAtMs - Date.now();
        if (remaining <= 0) return 0;
        return Math.max(0, Math.min(1, remaining / BOUNDARY_DECAY_MS));
      }
      if (envelope === null || ctx === null) return 0;
      const now = ctx.currentTime;
      // 播完之后还留一小段尾巴继续读包络（尾帧本来就是 0，等于自然衰减到闭嘴）。
      if (now > endedAt + TAIL_SECONDS) return 0;
      const elapsed = now - startedAt;
      if (elapsed < 0) return 0;
      const value = envelope.opennessAt(elapsed);
      return typeof value === 'number' && isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    },

    activeWordIndex(): number {
      /*
       * 比较的是**同一个时钟**：`elapsed` 来自 `ctx.currentTime - startedAt`，
       * 而 `offsetSeconds` 来自 Edge-TTS 的 WordBoundary。
       *
       * 两者的基准都是「这一段音频的第 0 秒」，所以可以直接比。残留误差只有一个：
       * `source.start()` 到声音真的从扬声器出来之间的输出延迟（Chromium 上通常
       * 10–30ms）。方案文档 §6.1 给口型定的容忍是 80ms，字幕高亮比口型宽松得多，
       * 所以这里**不做补偿** —— 补偿需要一个我们还没标定过的常数，而一个猜出来的
       * 常数会让「它到底是准的还是有 30ms 偏差」变成一个无法回答的问题。
       */
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

    async playBase64(
      audioBase64: string,
      text: string | null = null,
      words: SpeechWord[] = [],
      options?: { adapterId?: string },
    ): Promise<void> {
      const mine = (token += 1);
      teardown();
      // 从降级路径切回正常路径时，必须把系统语音也停掉 —— 否则两个引擎会同时说话。
      teardownSystemVoice();
      state.adapterId = typeof options?.adapterId === 'string' && options.adapterId !== '' ? options.adapterId : 'edge';
      state.degraded = false;
      state.notice = '';

      const audio = await ensureContext();
      const bytes = decodeBase64ToBytes(audioBase64);
      if (bytes.length === 0) {
        state.lastError = 'E_AUDIO_EMPTY: 音频是空的';
        notify();
        throw new Error(state.lastError);
      }

      // decodeAudioData 会**夺走**（detach）传入的 ArrayBuffer，所以给一份独立的。
      const buffer = await audio.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      if (mine !== token) return; // 期间又播了新的，这段丢弃

      const samples = buffer.getChannelData(0);
      envelope = createEnvelope(samples, buffer.sampleRate) as unknown as EnvelopeLike;

      const node = audio.createBufferSource();
      node.buffer = buffer;
      node.connect(gain as GainNode);
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

    async speakWithSystemVoice(text: string, notice = ''): Promise<void> {
      const trimmed = String(text ?? '').trim();
      if (trimmed === '') {
        state.lastError = 'E_TTS_EMPTY_TEXT: 没有要念的文本';
        notify();
        throw new Error(state.lastError);
      }

      const synth = resolveSpeechSynthesis();
      if (synth === null) {
        // 这台机器连系统语音都没有 —— 到这一步就真的没有别的办法了。
        // 报错而不是静默：用户至少知道「不是她不想说话」。
        state.lastError = 'E_TTS_NO_FALLBACK: 浏览器没有提供系统语音，无法降级';
        notify();
        throw new Error(state.lastError);
      }

      // 打断上一段（可能是系统语音，也可能是正常路径的 MP3）。
      token += 1;
      teardown();
      teardownSystemVoice();

      const utterance = new SpeechSynthesisUtterance(trimmed);
      systemUtterance = utterance;
      state.adapterId = 'system';
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

      /*
       * 口型的全部信息来源就是这一个事件。
       *
       * 真实包络是「每 10ms 一个采样点」，而这里每个**词**才有一个点 —— 粒度差了
       * 两个数量级。所以降级时的口型只是「像在说话」，不可能同步。这一点必须
       * 在界面上说清楚（`notice`），否则用户会以为口型功能坏了。
       *
       * `onboundary` 在某些浏览器/语音上根本不触发（尤其是中文语音）。那时
       * 嘴巴会停在下一次 `onstart` 后的 180ms 处不动 —— 可以接受，因为
       * `onend` 一定会到，最少也能做到「说话时张一下、说完闭嘴」。
       */
      utterance.onboundary = () => {
        if (systemUtterance !== utterance) return;
        systemDecayAtMs = Date.now() + BOUNDARY_DECAY_MS;
        state.frames += 1; // 借这个字段让面板能看出「边界事件真的来了」
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
        state.lastError = `E_TTS_SYSTEM_VOICE: 系统语音报错（${String(event?.error ?? 'unknown')}）`;
        notify();
      };

      state.speaking = true;
      notify();
      synth.speak(utterance);

      /*
       * 同步返回，不 await `onend`。
       *
       * 理由与工具 `live2d_speak` 立刻返回是同一条（§4.1 硬规则 3）：调用方不该
       * 被一次朗读挡住。句子的结束由 `state.speaking` 表达，而不是靠这个 Promise。
       */
    },

    stop(): void {
      token += 1;
      teardown();
      teardownSystemVoice();
      endedAt = ctx === null ? 0 : ctx.currentTime;
      state.speaking = false;
      notify();
    },

    async warmUp(): Promise<void> {
      try {
        await ensureContext();
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
      }
      notify();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 插件级单例。
 *
 * 必须跨组件生命周期共享：说话是「Host 队列 → 播放」这条链触发的，而
 * `Live2DStage` 会随面板折叠/模型切换卸载重建 —— 播放器跟着重建就会把
 * 正在说的那句话掐断。所以它活在模块作用域。
 */
let shared: SpeechPlayer | null = null;

export function getSpeechPlayer(): SpeechPlayer {
  if (shared === null) {
    shared = createSpeechPlayer();
  }
  return shared;
}
