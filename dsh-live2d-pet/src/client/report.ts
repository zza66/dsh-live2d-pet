/**
 * 把客户端半区的失败送回 Host，由 Host 写进日志与 `/status`。
 *
 * 存在的理由很具体：client bundle 的报错只出现在浏览器 console 里，而插件的调试期
 * 常常没有 DevTools（Electron 窗口默认不开）。
 *
 * ── ★ 2026-02 重写：这条通道从来没有成功送回过任何一条消息 ──────────────
 *
 * 现场（一个正在冻结的实例，`clientStage.present === true`、`frames` 24 秒没涨、
 * 而 `clientErrors` 是空的）逐条排掉之后只剩一个解释：
 *
 *   · Host 那条路由**好的** —— 从 node 用**同一个请求体**打过去，当场落库；
 *   · 浏览器的 POST **也是好的** —— `/capabilities` 就是渲染进程 POST 的，
 *     `state.capabilitiesDigest` 在这个进程里被写进去过；
 *   · 但 `clientErrors` 里**从来没有过任何一条浏览器发来的记录**。
 *
 * 唯一与 `/capabilities` 不同的地方是这里用了 `navigator.sendBeacon`。
 * 于是「零条记录」查了五轮的真正含义浮出来了：**不是护栏没说话，是话送不出来。**
 * 我一直在给被观测的东西加护栏，却从没验过观测这件事本身（§8.31）。
 *
 * ── 因此现在的规矩是三条 ────────────────────────────────────────────────
 *
 * 1. **`fetch(..., { keepalive: true })` 是主路，`sendBeacon` 是退路。**
 *    当初选 `sendBeacon` 是为了「页面正在被拆掉时不被取消」，而 `keepalive`
 *    就是为这件事设计的；反过来，`sendBeacon` 的失败**没有任何回调**，
 *    返回值还被原来那版代码丢掉了 —— 一个专门负责「不许静默失败」的函数，
 *    自己身上挂着一个最大的静默失败。
 * 2. **每一次上报的结果都记账**（`delivered` / `failed` / 两条路各自试了几次、成几次）。
 *    记账本身不解决问题，但它让「通道通不通」从推测变成读数。
 * 3. **账本跟着 `/status` 的心跳一起回去**（`reportQuerySuffix()`）。
 *    这是关键一步：上报通道坏掉的时候，恰恰是它自己的账本最需要送到的时候 ——
 *    所以账本**不能**走那条可能已经坏掉的通道，只能走那条已经证明能通的
 *    （`stage-presence` 就是这么抵达的，而 beacon 从来没有抵达过）。
 *
 * 这个函数**永远不能抛**：报告失败本身失败，会把「一个 bug」升级成「整个界面崩掉」。
 */

const ERROR_ENDPOINT = '/.dsh-live2d-pet/client-error';

/** 最近一条上报的摘要留多长。查询串是 GET，不能无限长。 */
const LAST_MESSAGE_CHARS = 140;

interface Counters {
  /** 调用过多少次上报（不管送没送到）。 */
  total: number;
  /** 确认送达的次数。 */
  delivered: number;
  /** 两条路都失败的次数。 */
  failed: number;
  /** 主路（fetch keepalive）试了几次 / 成了几次。 */
  fetchTried: number;
  fetchOk: number;
  /** 退路（sendBeacon）试了几次 / 自称成功几次。 */
  beaconTried: number;
  beaconOk: number;
}

const counters: Counters = {
  total: 0,
  delivered: 0,
  failed: 0,
  fetchTried: 0,
  fetchOk: 0,
  beaconTried: 0,
  beaconOk: 0,
};

let lastScope = '';
let lastMessage = '';
let lastAt = 0;

/**
 * 退路：`sendBeacon`。
 *
 * 只在主路**失败**时才走，所以 `beaconTried` 一旦不为零，本身就是一条结论：
 * 「fetch keepalive 在这台机器上不可用」。而 `beaconOk` 是不太可信的 ——
 * `sendBeacon` 返回 `true` 只表示**排进队列**，不代表送达（这正是它有嫌疑的原因）。
 *
 * ★ 它**不记账**，只把结果交回去。原因是一次上报只能算一次成败：早先的写法里
 * `fail()` 先记一次失败、`viaBeacon()` 又记一次失败，于是「两条路都不通」在
 * 账本上变成 `failed += 2` —— 而 `total` 只加了 1。门禁 [3] 段当场把它抓红。
 * 计数器的分子分母必须描述同一件事。
 */
function viaBeacon(payload: string): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
    counters.beaconTried += 1;
    if (navigator.sendBeacon(ERROR_ENDPOINT, new Blob([payload], { type: 'application/json' }))) {
      counters.beaconOk += 1;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 两条路都没成 —— 这一次上报才算失败。 */
function settleFailed(payload: string): void {
  if (viaBeacon(payload)) counters.delivered += 1;
  else counters.failed += 1;
}

export function reportFailure(scope: string, error: unknown): void {
  try {
    const err = error as { message?: string; stack?: string } | undefined;
    const message = err?.message ?? String(error);
    const payload = JSON.stringify({
      scope,
      message,
      stack: typeof err?.stack === 'string' ? err.stack : '',
    });

    counters.total += 1;
    lastScope = scope;
    lastMessage = message.length > LAST_MESSAGE_CHARS
      ? `${message.slice(0, LAST_MESSAGE_CHARS)}…`
      : message;
    lastAt = Date.now();

    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      settleFailed(payload);
    };

    if (typeof fetch !== 'function') {
      fail();
      return;
    }

    counters.fetchTried += 1;
    try {
      fetch(ERROR_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).then(
        (res) => {
          if (settled) return;
          settled = true;
          if (res.ok) {
            counters.fetchOk += 1;
            counters.delivered += 1;
          } else {
            settleFailed(payload);
          }
        },
        () => {
          fail();
        },
      );
    } catch {
      fail();
    }
  } catch {
    /* 见文件头：这里绝不能再抛。 */
  }
}

/**
 * 账本，拼进 `/status` 查询串。
 *
 * 每个字段都短、都常常在变，所以 Host 侧可以直接拿它做「这一秒通道通不通」的判据。
 * `rmsg` 是**最近一条上报的正文开头** —— 上报送不出去的时候，它就是我们唯一
 * 还能看见那条错误的窗口。
 */
export function reportQuerySuffix(): string {
  const c = counters;
  let out = `&rTotal=${String(c.total)}&rOk=${String(c.delivered)}&rFail=${String(c.failed)}`
    + `&rFetchTry=${String(c.fetchTried)}&rFetchOk=${String(c.fetchOk)}`
    + `&rBeaconTry=${String(c.beaconTried)}&rBeaconOk=${String(c.beaconOk)}`;
  if (lastScope !== '') {
    out += `&rLast=${encodeURIComponent(lastScope)}&rAt=${String(lastAt)}`;
    if (lastMessage !== '') out += `&rMsg=${encodeURIComponent(lastMessage)}`;
  }
  return out;
}

/** 给门禁用的只读快照（`reportQuerySuffix()` 是给人看的，这个是给断言看的）。 */
export function reportSnapshot(): Readonly<Counters> & {
  readonly lastScope: string;
  readonly lastMessage: string;
  readonly lastAt: number;
} {
  return { ...counters, lastScope, lastMessage, lastAt };
}
