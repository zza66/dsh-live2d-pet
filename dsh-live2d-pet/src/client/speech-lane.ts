/*
 * 朗读通道（Speech Lane）。
 *
 * 为什么需要它 —— 这是 P3 交付后反查 §6.1 #6（打断）时抓到的一个真缺陷：
 *
 * `speech.ts` 的 `playBase64()` / `speakWithSystemVoice()` 都是「**开始播**」就
 * resolve 的原语（那是刻意的，见 `speech.ts` 里 `speakWithSystemVoice` 的注释：
 * 调用方不该被一次朗读挡住）。可 `plugin.ts` 的轮询循环是这样用的：
 *
 *     for (const item of items) await runCurrentAction(command, { speak: speakNow })
 *
 * 于是 `/pending` 一批里若有两条 `say`：A 开始播 → `speakNow` 立刻返回 → 循环
 * 马上处理 B → B 的 `playBase64()` 开头那句 `teardown()` **把 A 掐断**。A 只播了
 * 「一次 /speak 往返」那么长（缓存命中时约 50ms，听上去就是没出声）。
 *
 * 现象是「AI 说了一句话，她只哼了半声就跳到下一句」，日志全绿。
 *
 * 修法不是在 `speech.ts` 里把原语改成阻塞（那会连带把「动作与语音并行」一起
 * 干掉，而 §6.1 场景 4 要求「AI 主动做非语音动作时不打断当前语音」）。修法是
 * **在原语之上加一条串行通道**：一句话播完（或被叫停）才轮到下一句。
 *
 * 于是这个文件负责三件 `speech.ts` 不该管的事：
 *   1. **串行**：同一时刻只有一句话在播，靠「等这一句真的结束」实现；
 *   2. **可取消**：`stopAll()` 清空排队、掐掉当前，并且让「排到一半」的旧句子
 *      作废（`generation`），这样 §6.1 #6 的「队列清空」才有东西可清；
 *   3. **不卡死**：`waitUntilDone()` 万一永远不 resolve（音频上下文被挂起、
 *      `onended` 丢失），必须有看门狗放行 —— P3 的验收原话就是「不越界、**不卡死**」。
 *
 * 与 `action-runner.ts` 同样的取舍：**纯逻辑、不碰 DOM 也不碰 React**，靠注入的
 * `hooks` 与调用方解耦，于是每一条分支都能被 `tools/test-speech-lane.mjs` 断言。
 * 留在 `plugin.ts` 的轮询回调里就只能靠耳朵验收 —— 而这个 bug 恰恰是耳朵才能
 * 发现的那一类。
 */

/**
 * 一句话要念的内容，外加它的合成参数。
 *
 * `voice` / `rate` 是 §4.1 `live2d_speak` 契约里的字段，**必须跟着句子一起排队** ——
 * 它们是「这一句怎么念」的属性，不是通道的属性。放在通道上会让队列里所有句子
 * 共用最后一次设置，症状是「AI 说『这句快一点』，结果连前面还没说的那句也变快了」。
 */
export interface SpeechRequest {
  text: string;
  /** Edge-TTS 音色 ShortName；缺省由 Host 用默认音色。 */
  voice?: string;
  /** 语速，如 `'+15%'`；缺省由 Host 用 `+0%`。 */
  rate?: string;
}

/** 允许只给一个字符串 —— 「说这句话，别的都默认」是最常见的调用。 */
export type SpeechInput = string | SpeechRequest;

function normalizeRequest(input: SpeechInput): SpeechRequest | null {
  if (typeof input === 'string') {
    return input.trim() === '' ? null : { text: input };
  }
  if (input === null || typeof input !== 'object') {
    return null;
  }
  if (typeof input.text !== 'string' || input.text.trim() === '') {
    return null;
  }
  const request: SpeechRequest = { text: input.text };
  if (typeof input.voice === 'string' && input.voice.trim() !== '') {
    request.voice = input.voice;
  }
  if (typeof input.rate === 'string' && input.rate.trim() !== '') {
    request.rate = input.rate;
  }
  return request;
}

/** 一句话从「开始播」到「播完」的完整生命周期，由调用方提供。 */
export interface SpeechLaneHooks {
  /**
   * 开始播这一句；返回时应当已经出声（或已经失败）。
   *
   * `isCancelled` 回答「这句还算数吗」。合成一次要几百毫秒，用户完全可能在
   * 这段时间里喊停 —— 那时 `stop()` 已经把播放器静音了，但**合成还在路上**，
   * 回来之后照样会出声。实现应当在真正开始播**之前**问一次，答「是」就
   * 直接返回、什么都别播。
   */
  speak(request: SpeechRequest, isCancelled?: () => boolean): Promise<void>;
  /** 当前这一句结束（播完、出错、或被 `stop()` 打断）时 resolve。 */
  waitUntilDone(): Promise<void>;
  /** 立刻停声。 */
  stop(): void;
  /** 出错了往哪报。**报错本身不许抛**：它跑在通道内部。 */
  onError?(error: unknown): void;
  /**
   * 这一句**真的开始出声了**（`speak()` 成功返回之后）。
   *
   * 与 `speak()` 的区别是「还没出声」与「已经出声」：合成要几百毫秒，
   * 期间用户看到的是一只安静的模型。反向通道（`speech-presence.ts`）要报给
   * AI 的是后者 —— 报早了，AI 会以为她已经在念。
   */
  onStart?(request: SpeechRequest): void;
  /**
   * 这一句结束了（播完、出错、被叫停都算）。
   *
   * 它是反向通道的**唯一**结束信号。没有它，Host 侧的「她还在说话」会一直
   * 停在上一次 `onStart` 上，症状是 AI 永远不敢接话。所以它必须走在每一条
   * 出口上：正常播完、`waitUntilDone()` 抛错、以及被 `stop()` 打断
   * （那条路上 `waitUntilDone()` 会因为 `state.speaking` 翻回 false 而 resolve）。
   */
  onSettled?(request: SpeechRequest): void;
}

export interface SpeechLane {
  /** 排一句。**立刻返回**，不等待播出。字符串 = 「只给文本，其余默认」。 */
  enqueue(input: SpeechInput): void;
  /** 清空排队 + 掐掉当前。 */
  stopAll(): void;
  /** 还有几句在排队（不含正在播的那一句）。 */
  queued(): number;
  /** 通道是否活着（正在播或正在排队）。用于决定轮询要多快。 */
  busy(): boolean;
}

/**
 * `waitForPlayer()` 的超时预算。
 *
 * `durationSeconds` 是 Host 报的音频时长（降级到系统语音时为 0，因为那时没有
 * 音频缓冲可测）。给一个宽限再进位，是因为 `onended` 本来就可能比标称时长短
 * 一点点或长一点点地到达。
 */
const WAIT_GRACE_MS = 2000;
/** 硬顶。再长也不等了 —— 通道卡死的代价比少播一句话大得多。 */
const WAIT_MAX_MS = 300000;

/** `waitForPlayer()` 需要的东西。刻意只要这一点，方便用假 player 做门禁。 */
export interface WaitablePlayer {
  readonly state: { speaking: boolean; durationSeconds: number };
  subscribe(listener: () => void): () => void;
}

/**
 * 把「播放器现在不说话了」变成一个 Promise。
 *
 * 为什么不用 `playBase64()` 的返回值：它 resolve 在「开始播」，不是「播完」
 * （见文件头）。播放器唯一诚实的结束信号是 `state.speaking` 翻回 false ——
 * 三条路径都会翻：`onended`、`onerror`、以及 `stop()`。
 *
 * 看门狗是必须的：`state.speaking` 卡在 true（音频上下文被系统挂起、`onended`
 * 在切标签页时丢失）会让这条链**永久卡死**，之后 AI 说的每一句话都排在后面
 * 永远轮不到。超时预算按这一句的已知时长推，再压一个硬顶。
 */
export function waitForPlayer(player: WaitablePlayer, options?: { graceMs?: number; maxMs?: number }): Promise<void> {
  if (player === null || player === undefined) return Promise.resolve();
  if (!player.state.speaking) return Promise.resolve();

  const graceMs = options?.graceMs ?? WAIT_GRACE_MS;
  const maxMs = options?.maxMs ?? WAIT_MAX_MS;
  const durationMs = Number(player.state.durationSeconds);
  const budget = Math.min(Math.max(Number.isFinite(durationMs) && durationMs > 0 ? durationMs * 1000 : 0, graceMs), maxMs);

  return new Promise<void>((resolve) => {
    let settled = false;
    let off: () => void = () => {};
    let timer = 0;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve();
    };

    /*
     * 先订阅再查一次状态：`speaking` 可能在 `speak()` resolve 到这一行之间就
     * 翻回 false（极短的音频）。反过来的顺序会永远等不到第二次通知。
     */
    off = player.subscribe(() => {
      if (!player.state.speaking) finish();
    });
    if (!player.state.speaking) finish();
    timer = setTimeout(finish, budget);
  });
}

/**
 * 建一条朗读通道。
 *
 * `hooks.speak()` 抛错**不会**让通道停摆：那句丢掉、报一次错、继续下一句。
 * 通道一旦因为一句坏话而停摆，表现是「从某一刻起她再也不说话了」，而日志里
 * 只有一条错 —— 那是比丢一句话严重得多的故障。
 */
export function createSpeechLane(hooks: SpeechLaneHooks): SpeechLane {
  /*
   * 队列里放的是**请求对象**而不是字符串：`voice` / `rate` 是「这一句怎么念」的
   * 属性，必须跟着句子一起排队（详见 `SpeechRequest` 的注释）。
   */
  const queue: SpeechRequest[] = [];
  /*
   * 每次 `stopAll()` 加一。排队中的句子记下自己入队时的代数，pump 取到它时
   * 若代数已变，说明「这句是在被叫停之前排的」，直接跳过。
   *
   * 为什么不用「清空数组」了事：句子可能已经离开数组、正卡在 `await speak()`
   * 里。那时数组是空的，清空什么也拦不住。代数拦得住。
   */
  let generation = 0;
  let running = false;

  const report = (error: unknown): void => {
    try {
      hooks.onError?.(error);
    } catch {
      /* 上报自己出错不能再往外抛：这里是唯一兜底的地方 */
    }
  };

  /*
   * 生命周期钩子（`onStart` / `onSettled`）与 `onError` 同样受保护：它们跑在
   * 通道内部，抛出去会把 `pump()` 的 `while` 打断，症状是「从某一刻起她再也
   * 不说话了」。而记一次账失败根本不配换这个代价。
   */
  const notify = (
    hook: ((request: SpeechRequest) => void) | undefined,
    request: SpeechRequest,
  ): void => {
    try {
      hook?.(request);
    } catch (error) {
      report(error);
    }
  };

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const gen = generation;
        const request = queue.shift() as SpeechRequest;
        const isCancelled = (): boolean => gen !== generation;
        try {
          await hooks.speak(request, isCancelled);
        } catch (error) {
          report(error);
          continue;
        }
        /* 说话期间被叫停了：不要再等这一句，也不要管剩下的（队列已被清空）。 */
        if (isCancelled()) continue;
        notify(hooks.onStart, request);
        try {
          await hooks.waitUntilDone();
        } catch (error) {
          report(error);
        }
        notify(hooks.onSettled, request);
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(input: SpeechInput): void {
      /*
       * 空文本在这里丢掉而不是排进去：调用方（`action-runner.ts` 的 `say`
       * 分支）已经用 `E_ACTION_EMPTY_TEXT` 拦过一道，能走到这儿的空串只有
       * 「有人绕过了执行层」这一种可能。排进去的后果是 Host 回一个错、降级
       * 到系统语音念一串空白 —— 一次没必要的噪声。
       */
      const request = normalizeRequest(input);
      if (request === null) return;
      queue.push(request);
      void pump();
    },

    stopAll(): void {
      generation += 1;
      queue.length = 0;
      try {
        hooks.stop();
      } catch (error) {
        report(error);
      }
    },

    queued: () => queue.length,
    busy: () => running,
  };
}

/**
 * 把一句话交给通道，并执行 §4.1 的 `interrupt` 语义。
 *
 * 单独抽成函数不是为了复用，而是为了**能被门禁测到**：这段判断原来写在
 * `plugin.ts` 的轮询回调里，那里没有门禁 —— `interrupt` 就是在那一层被整个
 * 丢掉的。当时的状态是「两端各自都对」：`lib/host/actions.js:205` 老实把它写进
 * `payload`，`lib/index.js` 的工具描述也向 LLM 承诺了「默认 true，false 会排在
 * 后面」，而渲染端从没读过它。两个取值表现完全一样，且**不报任何错**。
 *
 * 教训是：一行 glue 只要没人守，就等于没实现。所以它现在住在这里，
 * 由 `tools/test-speech-lane.mjs` 直接调。
 *
 * 语义：`interrupt` 默认 true，意思是「忘掉前面说的，现在说这句」——
 * 所以先 `stopAll()`（既掐掉正在说的、也清掉还没轮到的）再排队，
 * 而不是排到队尾慢慢等。
 */
export function speakWithInterrupt(
  lane: SpeechLane,
  text: string,
  options?: { interrupt?: boolean; voice?: string; rate?: string },
): void {
  // 契约是「默认 true」而不是「真值才 true」—— 只有明确的 `false` 才排队。
  if (options?.interrupt !== false) {
    lane.stopAll();
  }
  /*
   * `voice` / `rate` 跟着这一句走，而不是留在通道上。
   *
   * 二者都是「这一句怎么念」的属性：留在通道上会让队列里所有句子共用最后一次
   * 设置，症状是「AI 说『这句快一点』，结果连前面还没轮到的那句也变快了」。
   */
  lane.enqueue({ text, voice: options?.voice, rate: options?.rate });
}
