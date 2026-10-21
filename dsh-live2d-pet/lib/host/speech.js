/*
 * 反向通道：她「开始说」与「说完了」这两件事，回到会话里。
 *
 * ── 它修的是什么 ────────────────────────────────────────────────────────
 *
 * `live2d_speak` 是 fire-and-forget：工具返回「已排队」时，那句话**还没开始念**，
 * 更没念完。于是 AI 侧对朗读的认知只有两种极端 —— 「我刚排了一句」和
 * 「大概早念完了吧」。
 *
 * 现实里这不是小事。三个具体场景：
 *   · AI 排了两句，然后立刻排第三句 —— `interrupt` 默认 true，第三句把前两句
 *     掐掉，用户听到的是「话说了一半跳走了」；
 *   · 用户在她还在念的时候打字打断，AI 不知道她还在念，于是继续排下一句；
 *   · 长句（TTS 5 秒）之后 AI 又来一条 `live2d_play_motion`，观众视角是
 *     「她在说话的同时突然甩头」。
 *
 * 三个都只需要同一个事实：**此刻她还在不在念，还有几句排着**。
 *
 * ── 为什么走查询串（而不是新开一条 POST 路由）─────────────────────────────
 *
 * 渲染进程往 Host 送东西，目前只有两条被证明能走通的路（见 `stage-presence.ts`
 * 与 `report.ts` 的长注释）：错误走 `sendBeacon('/client-error')`，
 * **状态走 `/status` 轮询的查询串**。事故史站在后者那一边：`clientStage` 抵达过，
 * 而 `sendBeacon` 五轮全空。
 *
 * 更关键的是覆盖面：`useHostStatus` 那个 effect 的依赖是 `[load, intervalMs]`，
 * 与面板是否收起无关 —— 它是唯一一条「无论用户在看什么都在跑」的通道。
 * 朗读状态恰好是那种「面板收着也必须继续报」的事实：用户收起面板，
 * 恰恰是最可能让她自己念一段的时候。
 *
 * ── 三个刻意的设计 ──────────────────────────────────────────────────────
 *
 * 1. **计数器必须单调**（`started` / `settled`）。只有 `speaking` 一个布尔值时，
 *    「她没在说话」与「轮询根本没在报」是同一个样子 —— 那正是 §8.29 教训 2
 *    说的失明。两个单调计数器把「这一拍之前念完过 N 句」变成可对账的事实。
 *
 * 2. **时间用 Host 自己的钟**。客户端报的 `since` 跨机器没意义（何况页面可能
 *    刚重载、`Date.now()` 跳变），所以过渡时刻一律记在报告**抵达**的那一刻，
 *    客户端只提供「状态变了没有」与两个计数器。
 *
 * 3. **陈旧即沉默**。标签页关掉的那一刻若她正在念，`speaking: true` 会永远留在
 *    Host 上 —— 于是 AI 会一直以为她在说话，永远不敢开口。超过
 *    `SPEECH_STALE_MS` 没有新心跳就当作「不知道」，宁可什么都不说。
 *
 * ── 为什么空字符串很重要 ────────────────────────────────────────────────
 *
 * `describeSpeech()` 在她闲着且没有近况时返回 `''`，而 system prompt 的装配器
 * 会把空文本的 context 整条丢掉（`dsh-system-prompt/lib/index.js:150` 的
 * `.filter((section) => section.text.length > 0)`）。所以「没什么可说」的代价
 * 是**零个 token** —— 这一行只在真的会影响判断时才出现在提示词里。
 *
 * 这个文件与 `emotions.js` / `mood.js` / `emotion-stream.js` 同一个规矩：
 * **零 import、零 I/O、不读时钟**（`now` 从参数进来），于是门禁能直接调它。
 */

/** 超过这么久没有心跳 ⇒ 报告作废（面板关了、页面崩了、网络断了都算）。 */
export const SPEECH_STALE_MS = 15000;

/** 「刚说完」在提示词里保留多久。再久就不影响这一轮该怎么做了。 */
export const SPEECH_RECENT_MS = 20000;

/** 这一行在运行时上下文里的排序位。DSH 自有的三条是 110 / 115 / 120。 */
export const SPEECH_CONTEXT_ORDER = 140;

/** 运行时上下文里的名字（同一个 scope 里重名会被 shadow，所以要够独特）。 */
export const SPEECH_CONTEXT_NAME = 'live2d-pet.speech';

/**
 * 解析 `/status` 查询串里的朗读字段。
 *
 * 返回 `null` 表示**这份报告什么都没说**（旧客户端不发这些字段）——
 * 调用方必须保持原值，绝不能当成「她没在说」：那是凭空的故障。
 */
export function parseSpeechQuery(params) {
  const flag = params.get('speech');
  if (flag !== '0' && flag !== '1') return null;
  if (flag === '0') return { present: false };
  /*
   * 状态字段只认两个取值。**缺失时返回 `null` 而不是「当作没在说」**：
   * 「这一版客户端会报朗读状态」与「它此刻在念」是两件事，把后者从前者缺省
   * 出来正好是这条通道最不该犯的错 —— 一次手写的 curl 就能让 AI 以为她闲着。
   */
  const state = params.get('speechState');
  if (state !== 'speaking' && state !== 'idle') return null;
  const num = (key) => {
    const value = Number(params.get(key));
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  };
  return {
    present: true,
    speaking: state === 'speaking',
    queued: num('speechQueued'),
    started: num('speechStarted'),
    settled: num('speechSettled'),
  };
}

/** 空账本。`reports` 是「收到过多少次带 speech 字段的心跳」——自证用。 */
export function createSpeechState() {
  return {
    known: false,
    speaking: false,
    since: 0,
    settledAt: 0,
    queued: 0,
    started: 0,
    settled: 0,
    reloads: 0,
    reports: 0,
    at: 0,
  };
}

/**
 * 把一份报告并进账本，过渡时刻记在 `now`（Host 的钟）。
 *
 * 单调计数器**回退**只有一个解释：页面重载了（通道是新的，计数器从 0 开始）。
 * 那是个值得留痕的事件（`reloads`），而且必须重置所有时刻 —— 否则
 * 「刚才那句念了 90 秒」会变成一个凭空的假象。
 */
export function mergeSpeechReport(previous, report, now) {
  const base = previous ?? createSpeechState();
  if (report === null) return base;

  if (report.present === false) {
    return { ...base, known: true, speaking: false, queued: 0, reports: base.reports + 1, at: now };
  }

  const reloaded = base.known && (report.started < base.started || report.settled < base.settled);
  const before = reloaded ? createSpeechState() : base;

  const changed = report.speaking !== before.speaking;
  return {
    known: true,
    speaking: report.speaking,
    /* 状态没变就保留上一次的过渡时刻：`since` 是「这一句从什么时候开始念的」。 */
    since: report.speaking ? (changed ? now : (before.since || now)) : 0,
    settledAt: report.speaking ? 0 : (changed ? now : before.settledAt),
    queued: report.queued,
    started: report.started,
    settled: report.settled,
    reloads: before.reloads + (reloaded ? 1 : 0),
    reports: before.reports + 1,
    at: now,
  };
}

/** 这份报告还算不算数。关掉的标签页不该让「她还在说」永远成立。 */
export function speechIsFresh(speech, now) {
  if (speech === null || speech === undefined || speech.known !== true) return false;
  return now - speech.at <= SPEECH_STALE_MS;
}

/** 「正在说」的秒数（只有新鲜的报告才敢算）。 */
export function speakingSeconds(speech, now) {
  if (!speechIsFresh(speech, now) || speech.speaking !== true) return 0;
  return Math.max(0, (now - speech.since) / 1000);
}

/**
 * 写进运行时上下文的那一行。**没事可说时返回 `''`**（零 token）。
 *
 * 措辞上只做两件事：说清事实（念了多久、还排着几句），以及给出可操作的下一步。
 * 不写「请等待」这类命令句 —— 该不该等是 AI 的判断，这里只提供事实。
 */
export function describeSpeech(speech, now) {
  if (!speechIsFresh(speech, now)) return '';

  if (speech.speaking === true) {
    const seconds = speakingSeconds(speech, now).toFixed(1);
    const queue = speech.queued > 0 ? `，后面还排着 ${speech.queued} 句` : '';
    return `她此刻正在说话：这一句已经念了 ${seconds} 秒${queue}。`
      + '要打断或改口就调 live2d_stop_speaking；要接着往下说就等她念完（下一轮自然会看到）。';
  }

  if (speech.settledAt > 0 && now - speech.settledAt <= SPEECH_RECENT_MS) {
    const seconds = ((now - speech.settledAt) / 1000).toFixed(1);
    return `她刚念完上一句（${seconds} 秒前；自本次加载以来一共念完 ${speech.settled} 句）。`;
  }

  return '';
}

/**
 * 诊断面（`live2d_status` 与 `/status`）读的一行 —— 它**永远**有话说。
 *
 * 与 `describeSpeech()` 的分工：那个是给提示词省 token 的（没事就不出现），
 * 这个是「有人在问」的时候回答的，所以「不知道」也必须说出来。
 */
export function speechSummary(speech, now) {
  if (speech === null || speech === undefined || speech.known !== true) return '朗读状态未知（还没有收到带朗读字段的心跳）';
  if (!speechIsFresh(speech, now)) {
    const seconds = ((now - speech.at) / 1000).toFixed(0);
    return `朗读状态已过期（${seconds} 秒没有心跳）`;
  }
  if (speech.speaking === true) {
    const queue = speech.queued > 0 ? `，还排着 ${speech.queued} 句` : '';
    return `正在说话（这句已念 ${speakingSeconds(speech, now).toFixed(1)} 秒${queue}）`;
  }
  if (speech.settledAt > 0) {
    const seconds = ((now - speech.settledAt) / 1000).toFixed(1);
    return `没在说话（${seconds} 秒前念完第 ${speech.settled} 句）`;
  }
  return '没在说话（这一轮还没念过）';
}
