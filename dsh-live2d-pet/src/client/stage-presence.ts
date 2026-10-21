/**
 * 「渲染舞台这会儿在不在」—— 一个必须跟着心跳一起回到 Host 的事实。
 *
 * ── 它修的是什么 ────────────────────────────────────────────────────────
 *
 * 「她卡住了，而且一条记录都没有」已经查了三轮。前四道护栏
 * （`frame-live` / `frame-blind` / `frame-frozen` / `frame-hidden`）加上
 * 第五道 `frame-nostart` **全都住在渲染舞台那个 effect 里**，而那个 effect
 * 的挂载是有条件的：
 *
 *     collapsed
 *       ? null                                        // ← 收起面板
 *       : h('div', { className: 'dsh-l2d-body' },
 *           ... h(Live2DStage, { modelPath: active.path, ... }))
 *
 * 收起面板 = `Live2DStage` 整个不渲染 = effect 卸载 = cleanup 把
 * `stallTimer` / `hiddenTimer` / `startTimer` / `wakeTimer` / `glWatchTimer`
 * 五个定时器全部 `clearInterval` 掉。于是 **「面板收着」和「一切正常」
 * 在 `/status` 上长得一模一样**：都是零条 `frame-*` 记录。
 *
 * 这正是 §8.29 教训 2 说的那种失明 —— 护栏的覆盖率必须显式检查。
 * 前四道护栏集体对「舞台不存在」失明，而「舞台不存在」恰好是零记录最容易的
 * 成因。第五道护栏补的是「effect 在、但没有帧」，它同样够不着「effect 不在」。
 *
 * ── 为什么由轮询这件事来带 ──────────────────────────────────────────────
 *
 * `useHostStatus` 那个 effect 的依赖是 `[load, intervalMs]`，**与 `collapsed`
 * 无关** —— 面板收起来它照旧每几秒打一次 `/status`。所以它是唯一一个
 * 「无论面板什么状态都在跑」的通道，也就只能由它来回答这个问题。
 *
 * 于是：舞台挂载时登记、卸载时注销，轮询每次请求把当前状态编进查询串。
 * Host 把它记进 `clientStage`，`live2d_status` 再把它说进会话里 ——
 * 这样「零条记录」终于能被拆成两种意思之一。
 *
 * ── 为什么零依赖 ────────────────────────────────────────────────────────
 *
 * 这个模块不碰 DOM、不碰 React、不碰 `Date.now()`（时间从参数进来），
 * 于是门禁可以在 node 里直接把「登记 → 注销 → 查询串」这条链跑一遍。
 */

/** 舞台活着的证据。两个字段都是取值函数 —— 登记之后它们还会变。 */
export interface StagePresence {
  /** 登记时刻（`Date.now()`）。 */
  readonly since: number;
  /** 画面上真正在渲染的那一个（可能还没换上，此时是空串）。 */
  readonly modelPath: () => string;
  /** 到目前为止画了多少帧。 */
  readonly frames: () => number;
}

let current: StagePresence | null = null;

/**
 * 舞台挂载时登记，卸载时传 `null` 注销。
 *
 * 传入 `null` 是**唯一**的注销方式 —— 不留「只登记不注销」的口子，
 * 因为那正是这次要修的毛病：一个只在自己活着时才说真话的信号，
 * 死了以后什么都不说。
 */
export function setStagePresence(next: StagePresence | null): void {
  current = next;
}

/** 当前登记（没有就是 `null`）。门禁与轮询都走这个。 */
export function getStagePresence(): StagePresence | null {
  return current;
}

/**
 * 拼进 `/status` 查询串的后缀。
 *
 * `stage=0` 与 `stage=1` 都必须发出去 —— **缺省值最危险**：如果「舞台不在」
 * 表现为「参数干脆不出现」，那么一个连 `stage` 都不发的旧客户端、和一个
 * 舞台确实不在的新客户端，在 Host 侧又是同一个样子。
 *
 * `modelPath` 里有空格与中文（`空/空 - 免费版.model3.json`），必须编码。
 */
export function stageQuerySuffix(): string {
  if (current === null) return '&stage=0';
  const frames = current.frames();
  const safe = Number.isFinite(frames) && frames >= 0 ? Math.floor(frames) : 0;
  return `&stage=1&stageModel=${encodeURIComponent(current.modelPath())}&stageFrames=${String(safe)}`;
}
