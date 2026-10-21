/**
 * 「她这会儿在不在说话」—— 反向通道的渲染端那一半。
 *
 * ── 为什么这是个独立模块 ────────────────────────────────────────────────
 *
 * 朗读的生命周期只有 `speech-lane.ts` 知道（它才是那个「等这一句真的播完」的
 * 地方），而 Host 只有一条回程通道（`/status` 轮询的查询串，见 `stage-presence.ts`
 * 里那段长注释：`clientStage` 抵达过、`sendBeacon` 五轮全空）。
 *
 * 于是分工：**通道报告过渡，这里记账，轮询把账本带回去**。三者互不认识，
 * 每一段都能在 node 里单独跑 —— 与 `stage-presence.ts` 同一个取舍：
 * 零依赖、不碰 DOM、不碰 React、不读 `Date.now()`（时刻从参数进来）。
 *
 * ── 为什么要计数器而不只是一个布尔值 ────────────────────────────────────
 *
 * 只有 `speaking` 一个字段时，「她没在说话」与「页面根本没在报」在 Host 侧
 * 是同一个样子 —— §8.29 教训 2 说的那种失明。两个**单调计数器**
 * （`started` / `settled`）让 Host 能对账：这一拍之前她念完过 N 句。
 * 计数器回退（页面重载）也因此变成一个可识别的事件，而不是一个假象。
 *
 * ── 为什么字段永远要发 ──────────────────────────────────────────────────
 *
 * `speech=0` 与 `speech=1` 都必须发出去，理由与 `stage=0` 完全一样：
 * 如果「这一版客户端不报朗读状态」表现为「参数干脆不出现」，那么一个旧客户端
 * 和一个真的没在说话的新客户端，在 Host 侧又是同一个样子 —— 而这两者的区别
 * 恰恰决定了 AI 敢不敢开口。
 */

/** 记账本。时刻都是调用方给的（客户端钟），Host 只拿它当参考。 */
export interface SpeechPresence {
  /** 现在这一句是否在念。 */
  readonly speaking: boolean;
  /** 这一句开始的时刻。 */
  readonly since: number;
  /** 上一句结束的时刻（0 = 还没念完过任何一句）。 */
  readonly settledAt: number;
  /** 累计开始念过几句（单调）。 */
  readonly started: number;
  /** 累计念完几句（单调）。 */
  readonly settled: number;
}

let current: SpeechPresence | null = null;

/**
 * 一句话开始出声时登记。
 *
 * `null` 是**唯一**的初始状态，也是「这一版客户端从来没说过话」的表达 ——
 * 查询串据此发 `speech=0`，与「有账本、此刻没在说」（`speech=1&speechState=idle`）
 * 区分开。
 */
export function noteSpeechStart(at: number): void {
  const settledAt = current?.settledAt ?? 0;
  const started = (current?.started ?? 0) + 1;
  current = {
    speaking: true,
    since: at,
    settledAt,
    started,
    settled: current?.settled ?? 0,
  };
}

/** 这一句结束（播完、出错、被叫停）时登记。 */
export function noteSpeechSettled(at: number): void {
  const before = current;
  current = {
    speaking: false,
    since: 0,
    settledAt: at,
    started: before?.started ?? 0,
    settled: (before?.settled ?? 0) + 1,
  };
}

/** 当前账本（从来没登记过就是 `null`）。门禁与轮询都走这个。 */
export function getSpeechPresence(): SpeechPresence | null {
  return current;
}

/** 给门禁用：把账本清回「什么都没发生过」。 */
export function resetSpeechPresence(): void {
  current = null;
}

/**
 * 拼进 `/status` 查询串的后缀。
 *
 * `queued` 由调用方在**这一刻**取（排队深度是通道的实时状态，不是过渡事件，
 * 记在账本里只会记到过期的数）。
 */
export function speechQuerySuffix(queued = 0): string {
  if (current === null) return '&speech=0';
  const depth = Number.isFinite(queued) && queued > 0 ? Math.floor(queued) : 0;
  return '&speech=1'
    + `&speechState=${current.speaking ? 'speaking' : 'idle'}`
    + `&speechQueued=${String(depth)}`
    + `&speechStarted=${String(current.started)}`
    + `&speechSettled=${String(current.settled)}`;
}
