/**
 * tts-adapters.js — TTS 适配器登记表与**降级策略**（方案文档 §5 P2、§6.1 #8）。
 *
 * 这一版只解决 P2 里最要紧、也最容易被漏掉的那一条：
 *
 *   > §6.1 #8 Edge-TTS 不可达时，自动降级到系统语音，UI 显示质量降级提示，无阻塞卡死。
 *
 * 为什么单独一个模块:
 *   和 `capabilities.js` 同一个理由 —— **Host 与客户端共用同一份实现**。
 *   降级判断需要两边都做：Host 在 `/speak` 失败时告诉渲染端「可以降级」，
 *   渲染端自己也可能根本没走到 Host（断网时 `fetch` 直接失败）。两处各写一份
 *   判断，迟早会出现「Host 说别降级、客户端降级了」这种只有用户能发现的分歧。
 *
 * ★ 硬约束：本文件必须保持**零 import、不碰任何 `node:` 内置模块**。
 *   客户端 bundle 也会 import 它（esbuild 直接内联），一旦有人在这里写
 *   `import fs from 'node:fs'`，客户端构建会当场失败 —— 刻意选的失败方式：
 *   构建时炸掉，而不是运行时让桌宠消失（方案文档 §9.2）。
 *
 * ★ 本模块是纯策略，**不做任何合成**。
 *   它回答的是「出这个错的时候，该不该换一个说话的东西，以及该怎么跟用户说」。
 *   真正的合成分工：
 *     - `edge`    → Host 的 `lib/host/edge-tts.js`（联网，质量高，有真实音频包络）
 *     - `system`  → 渲染端的 `speechSynthesis`（浏览器自带，离线，**没有音频包络**）
 *   后者只能在渲染端跑：Host 是 Node 进程，没有音频输出设备可以给它用。
 */

/**
 * 一个 TTS 适配器。
 *
 * @typedef {object} TtsAdapter
 * @property {string} id          稳定标识，会出现在响应体与日志里。
 * @property {string} label       给人看的名字（界面与提示语直接用）。
 * @property {'high'|'low'} quality
 * @property {'host'|'renderer'} transport 在哪个半区跑。
 * @property {boolean} needsNetwork
 * @property {string} note        为什么它是这个质量档。
 */

/** @type {ReadonlyArray<TtsAdapter>} */
export const TTS_ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'edge',
    label: 'Edge-TTS',
    quality: 'high',
    transport: 'host',
    needsNetwork: true,
    note: '微软 Edge 的在线语音，音色自然，而且能在本地算出逐帧包络来驱动口型。',
  }),
  Object.freeze({
    id: 'system',
    label: '系统语音',
    quality: 'low',
    transport: 'renderer',
    needsNetwork: false,
    note: '浏览器自带语音，完全离线可用，但拿不到音频数据 —— 所以口型只能靠词边界事件近似。',
  }),
]);

export const DEFAULT_ADAPTER_ID = 'edge';
export const FALLBACK_ADAPTER_ID = 'system';

/**
 * 这些错误码**不应该**降级。
 *
 * 它们的共同点是「请求本身就不该发出来」：文本是空的、太长、body 不是 JSON、
 * 或者 `voice` / `rate` / `pitch` 的格式不对。
 *
 * 降级会把这些变成更糟的东西 —— 系统语音会老老实实把一串空格念出来、
 * 或者用默认语速把话念完，于是「调用方写了个 bug」被伪装成
 * 「我们成功地说了一句话」。而 §4.1 硬规则 2 要的是**可自愈的失败**：
 * 调用方得知道该改哪个字段，换个引擎重说一遍只会把错误藏起来。
 *
 * 判断规则因此是**白名单式**的：只有这里列出的码不降级，其余一律降级（见 `isDegradable`）。
 */
export const NO_DEGRADE_CODES = Object.freeze([
  'E_TTS_EMPTY_TEXT',
  'E_TTS_TEXT_TOO_LONG',
  'E_TTS_BAD_VOICE',
  'E_TTS_BAD_RATE',
  'E_TTS_BAD_PITCH',
  /*
   * 自定义服务回了 4xx：它**看懂了这个请求，然后拒绝执行**（文本超长、格式不认、
   * 鉴权不对）。这和「服务自己撞墙了」不是一回事 —— 后者换引擎真的可能成功，
   * 前者换过去只会把请求错误藏起来，或者用系统语音把本该被拒的内容念出来。
   * 5xx 仍是 `E_TTS_UPSTREAM_BAD_STATUS`，照旧降级。
   */
  'E_TTS_UPSTREAM_BAD_REQUEST',
  'E_BAD_JSON',
]);

/**
 * 按 id 找适配器。
 *
 * @param {unknown} id
 * @returns {TtsAdapter | null}
 */
export function adapterById(id) {
  if (typeof id !== 'string') return null;
  for (const adapter of TTS_ADAPTERS) {
    if (adapter.id === id) return adapter;
  }
  return null;
}

/**
 * 这个错误码值不值得换个引擎再说一遍？
 *
 * **默认是「值得」** —— 认不出的错误码照样降级。理由是不对称的：
 *   - 猜错成「降级」的代价：用户听到机器音，外加一行「音质已降级」的提示。
 *     他至少知道刚才发生了什么。
 *   - 猜错成「不降级」的代价：什么都没发生，也没有任何解释 —— 这正是
 *     §6.1 #8 里「无阻塞卡死」要防的那种体验。
 *
 * @param {unknown} code
 * @returns {boolean}
 */
export function isDegradable(code) {
  if (typeof code !== 'string' || code === '') return true;
  return !NO_DEGRADE_CODES.includes(code);
}

/**
 * 决定这次该用哪个适配器。
 *
 * 返回**扁平形状**的 `{ adapterId, degraded, reason }`，而不是
 * `{ok:true,…} | {ok:false,…}` 这样的判别联合 —— 本项目的 `tsconfig.json` 是
 * `strict: false`（`strictNullChecks` 关着），那种配置下布尔字面量会被放宽成
 * `boolean`，判别式失效，写出来就是 `if (!decision.ok)` 之后的属性访问报 TS2339。
 *
 * @param {{ preferred?: unknown, failureCode?: unknown }} [input]
 * @returns {{ adapterId: string, degraded: boolean, reason: string }}
 */
export function chooseAdapter(input = {}) {
  const preferred = adapterById(input.preferred) ?? adapterById(DEFAULT_ADAPTER_ID);
  const code = input.failureCode;

  // 没失败过，或者失败得「不值得重说一遍」：还是用它。
  if (code === undefined || code === null || code === '') {
    return {
      adapterId: preferred.id,
      degraded: false,
      reason: '',
    };
  }

  if (!isDegradable(code)) {
    return {
      adapterId: preferred.id,
      degraded: false,
      reason: `${preferred.label} 拒绝了这次请求（${String(code)}），换个引擎说同一句话也是一样的结果，所以没有降级。`,
    };
  }

  const fallback = adapterById(FALLBACK_ADAPTER_ID);
  return {
    adapterId: fallback.id,
    degraded: true,
    reason: `${preferred.label} 用不了（${String(code)}），已换成${fallback.label}。`,
  };
}

/**
 * 给用户看的一句话。**界面必须显示它** —— §6.1 #8 明确要求「UI 显示质量降级提示」，
 * 而「为什么她的声音变了」是用户此刻唯一的疑问。
 *
 * @param {{ adapterId?: unknown, degraded?: unknown, reason?: unknown }} [decision]
 * @returns {string}
 */
export function describeDegradation(decision = {}) {
  if (decision.degraded !== true) return '';

  const adapter = adapterById(decision.adapterId) ?? adapterById(FALLBACK_ADAPTER_ID);
  const reason = typeof decision.reason === 'string' && decision.reason !== ''
    ? decision.reason
    : `已换成${adapter.label}。`;

  return `${reason}音质会明显下降，口型也只能近似 —— 恢复联网后会自动换回来。`;
}
