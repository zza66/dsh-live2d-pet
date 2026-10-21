/**
 * 渲染帧预算 —— `maxFps` 在渲染端的**唯一落地点**。
 *
 * ── 它修的是什么 ────────────────────────────────────────────────────────
 *
 * `maxFps` 从 P0 起就写在 `lib/index.js` 的配置说明里（「渲染性能档位」），
 * 被读进 `/status`，在方案 §4.4 的 Config Schema 里叫 `render.maxFps` ——
 * 而**从来没有任何代码用它改过任何行为**。三个配置键里它是唯一一个
 * 「读出来只为了报回去」的：`modelsRoot` 决定去哪儿找模型，`enableAgentTools`
 * 决定注不注册工具，`maxFps` 谁都不管。
 *
 * 用户看得见的那一面：把它设成 30 想省电/降风扇，帧率一点没变
 * （144Hz 屏上照旧 144fps），面板上的数字照旧，而且不报任何错。
 * 方案 §4.4 把「降帧率（后台或低电量）」列为性能降级档的一项已承诺能力。
 *
 * ── 为什么是纯函数 ──────────────────────────────────────────────────────
 *
 * 这一层只回答一个问题：**这一帧该不该画**。零 DOM、零 rAF、零 Date.now() ——
 * 时间从参数进来。于是门禁可以用一条假时间轴把「一秒」推一遍，
 * 数出到底画了几帧，而不必真的开一个浏览器。
 */

import { normalizeFps } from '../../lib/host/render-config.js';

/**
 * 判定余量：离上一帧至少要有「目标间隔的 90%」才允许再画。
 *
 * ★ 这个余量不是优化，是**正确性必需**。若严格要求
 * `now - lastDrawAt >= 1000 / fps`，60Hz 显示器上 rAF 的回调间隔本身就在
 * 16.6–16.7ms 之间抖动，于是**每一帧都会被判成「还不到时候」**，60fps 的上限
 * 在 60Hz 屏上掉成 30fps。这是此类代码最常见的坑，而且它看起来「成功了」
 * —— 帧率数字确实降下去了，只是降过头。
 *
 * 代价是**上限会量化到显示器刷新率的整数分之一**：144Hz 屏上设 60 会得到 48
 * （每 3 帧画 1 次）而不是 60。这是上限、不是目标，写进文档即可；不能靠放大
 * 余量去凑 —— 余量放到 0.75 时 144Hz 屏会画出 72fps，那是**超发**，
 * 「上限」这个词就又不成立了。
 */
export const FRAME_SLACK = 0.9;

/**
 * 目标帧间隔（毫秒）。
 *
 * 非法输入不会得到 `NaN` 或 `Infinity`：`normalizeFps()` 已经把它们收成默认值，
 * 而这里再兜一次底 —— 一个 `Infinity` 的间隔意味着**永久不再画**。
 */
export function frameIntervalMs(fps: unknown): number {
  const interval = 1000 / normalizeFps(fps);
  return Number.isFinite(interval) && interval > 0 ? interval : 1000 / 60;
}

/**
 * 这一帧该不该画。
 *
 * `lastDrawAt` 传 `0` 表示「还一帧都没画过」—— 第一帧永远要画，否则模型
 * 要白等一个完整间隔才出现，而 `maxFps: 10` 时那一等是 100ms，看得见。
 *
 * 下面三条兜底的方向完全一致：**宁可多画一帧，也绝不把桌宠冻住**。
 * 一个「配置写坏了就永久静止」的功能，比一个「配置没生效」的功能坏得多，
 * 而且它连错误都不报（§9.2 的思路：静默失败是最贵的失败）。
 *   1. `now` 不是有限数（`NaN`）→ 画；
 *   2. `lastDrawAt` 不是正数（`0` / `NaN` / 负数）→ 画；
 *   3. `now <= lastDrawAt`（时钟回拨，或两个回调拿到同一个时间戳）→ 画。
 *
 * 注意第 3 条**不能**写成 `now === lastDrawAt`：一旦 `lastDrawAt` 因为任何原因
 * 跑到了未来，严格比较会让桌宠一帧都不画，而「时钟回拨」在系统休眠唤醒后
 * 是真实会发生的。
 */
export function shouldDrawFrame(lastDrawAt: number, now: number, fps: unknown): boolean {
  if (!Number.isFinite(now)) return true;
  if (!(lastDrawAt > 0)) return true;
  if (!(now > lastDrawAt)) return true;
  return now - lastDrawAt >= frameIntervalMs(fps) * FRAME_SLACK;
}
