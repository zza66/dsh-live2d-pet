/*
 * 带超时的 fetch —— 这个文件存在的唯一理由是：**`fetch()` 没有默认超时**。
 *
 * 一个挂住的请求不会失败、不会超时、不会抛，它只是永远不 settle。而这在这份
 * 代码里是**致命**的，因为客户端有两处 `await` 被串行化，一次挂住就是永久性
 * 的静默死亡：
 *
 *   · 指令轮询（`plugin.ts` 的 `/pending`）用 `busy` 防止重入 —— 挂在里面
 *     就等于命令通道永久失效：指令照发、心跳照跳、状态照报，只有桌宠再也不动；
 *   · 模型资源加载（`pet-model.ts` 的 `_loadMotion` / `_loadExpression`）挂在
 *     里面就等于那一个动作/表情永远加载不出来，而且**每次调用都会新起一个
 *     挂死的 await**（缓存只在 await 之后才写）。
 *
 * 两处都**不会有任何日志**：没有异常就没有 `reportFailure`，没有 4xx 就没有
 * 报错。这正是「miku 跑一段时间后卡住、空不会、两条护栏都不报」的候补解释里
 * 唯一一条能同时对上「零日志」「心跳新鲜」「只有它走到那条路径」的。
 *
 * 定义放在一个地方而不是两处各写一份：这两个超时的**理由**是同一个，
 * 理由相同而数值不同的两份拷贝，迟早会变成两个互相矛盾的真相。
 */

/**
 * 资源请求（moc3 / 纹理 / 动作 / 表情 / model3.json）的超时。
 *
 * 15 秒的依据：本地 Host 读一个几十 KB 到几十 MB 的文件正常在毫秒级，
 * 15 秒已经比正常慢三个数量级；而它仍然远小于「用户以为她卡死了」的忍耐时间。
 */
export const ASSET_FETCH_TIMEOUT_MS = 15000;

/**
 * 一次指令轮询的超时。
 *
 * 比资源请求短一个数量级：轮询本来就是「过一会儿再问一次」的东西，晚一轮
 * 的代价只是延迟 200ms～1.2 秒，而它卡住的代价是整个命令通道死掉。
 * 5 秒 > 最慢的轮询间隔（1.2 秒）× 4，不会被正常的慢响应误伤。
 */
export const POLL_FETCH_TIMEOUT_MS = 5000;

/**
 * `fetch` 加上超时。超时抛 `AbortError`，由调用方按普通失败处理。
 *
 * `AbortController` 缺席时退回不带信号的 `fetch`（老 WebView）—— 那种环境下
 * 没有更好的选择，但至少不会因为一个不存在的 API 让整次加载直接失败。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = ASSET_FETCH_TIMEOUT_MS,
): Promise<Response> {
  if (typeof AbortController !== 'function') {
    return await fetch(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    // 成功路径也要清：不清就是一个白白挂着的 15 秒定时器，每次请求一个。
    clearTimeout(timer);
  }
}
