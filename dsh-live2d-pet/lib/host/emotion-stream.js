/*
 * 流式情绪：让她的表情跟着**正在流出来的回答**走。
 *
 * ── 这个模块在解决什么问题 ────────────────────────────────────────────────
 *
 * `live2d_emote` 解决了「AI 想让桌宠做个表情」这件事，但它要占一次工具调用：
 * 我得停下手里的活、花一个来回、写一行 `{name:'开心'}`。而**我说话的时候本来
 * 就在流式输出文字** —— 那些文字里已经写着情绪（「跑通了」「抱歉，我漏了」
 * 「没想到」），让桌宠跟着读就行。
 *
 * `agent/assistant-stream` 是 DSH 的事件（进程本地、`start`/`chunk`/`end` 三种
 * frame），订阅它**不花一个 token、不占一次工具调用**：这不是「让模型更聪明地
 * 控制表情」，这是**读已经存在的东西**。
 *
 * ── 为什么判定在本机做，而不是让模型自己标注 ──────────────────────────────
 *
 * 让模型在正文里写 `[开心]` 也能work，但它会把标注混进正文（朗读会念出来、
 * 用户会看见），而且**它会失败**：模型忘了写、写错名字、或者干脆不写。
 * 本机判定是**确定性**的：同样的句子永远得到同样的情绪，可以被门禁逐条断言。
 *
 * 代价是它**粗糙** —— 关键词表当然读不懂反讽，也读不懂「这个方案不行」里
 * 那股哭笑不得的劲。所以它的定位是**兜底**，而不是真理：
 *   · 它只在**没有更明确的信号**时说话（显式 `live2d_emote` 之后有静默期）；
 *   · 它认不出来时**什么都不做**（不猜、不重置）；
 *   · 它比显式指令**更轻**（intensity 0.85 vs 1.0）。
 *
 * ── 只 import 一个纯数据模块 ──────────────────────────────────────────────
 *
 * 这里原来写着「零 import」，目的只有一个：门禁脚本能直接 import 它跑断言，不用起
 * Host、不用真的连一个 Agent。场景档做完之后表被搬进了 `emotion-keywords.js`
 * （它同样是纯数据 + 纯函数，也不碰任何 `node:` 内置模块），所以现在多一行 import ——
 * 「能直接跑断言」这个性质没有变。
 */

import { DEFAULT_SCENE, KEYWORD_PROFILES } from './emotion-keywords.js';

/**
 * 句子的硬终止符。看到它就**立刻**切句。
 *
 * 特别注意这里**没有 `.`**：句号出现在 `1.5`、`h.release()`、`§9.4` 里的概率
 * 远高于出现在英文句末的概率，把它当终止符会让「v0.2 修好了」这类句子被切成
 * 两半，而两半都判不出情绪。中文的 `。` 没有这个歧义，所以它在。
 */
const HARD_TERMINATORS = '。！？!?…；;';

/**
 * 软停顿。**只在长句里**用：一句 60 字的话如果一路等到终止符才判，表情就
 * 落后于朗读三秒以上；在最近的逗号处切，它能跟上。
 */
const SOFT_BREAKS = '，,、：:—－ ';

/** 太短的「句子」不判 —— 「好的。」四个字里没有任何情绪信息。 */
export const SENTENCE_MIN_CHARS = 6;

/** 到这个长度就找软停顿切句。 */
export const SENTENCE_MAX_CHARS = 42;

/** 软停顿至少要在这个位置之后才算「值钱」（否则切出来的头太短）。 */
export const SOFT_BREAK_MIN_CHARS = 16;

/** 没有任何停顿的超长文本，硬切在这个长度。 */
export const HARD_CUT_CHARS = 64;

/** 缓冲的尾巴上限：超过就丢掉前面 —— 别让一条不换气的流把内存吃掉。 */
const BUFFER_TAIL_CHARS = 240;

/** 自动情绪的强度：比显式指令（1.0）轻一档，它是陪衬不是主角。 */
export const STREAM_EMOTION_INTENSITY = 0.85;

/** 两次推送之间的最小间隔。渲染端每帧都在插值，推得再密也看不出来。 */
export const MIN_PUSH_INTERVAL_MS = 700;

/** 同一种情绪在这个时间内重复出现就不再推（她脸上本来就没走完）。 */
export const REPEAT_SUPPRESS_MS = 2600;

/** 一条流上最多允许压着几条没被取走的自动情绪（见 index.js 里的队列保护）。 */
export const MAX_QUEUED_AUTO_EMOTIONS = 2;

/**
 * 一条**显式** `live2d_emote` 之后的静默期。
 *
 * 这条规则在解决一个很具体的抢戏问题：我调 `live2d_emote{name:'抱歉'}` 是因为
 * 我真的要道歉，紧接着说出来的那句话里的关键词（「失败」「报错」）会立刻被判定
 * 成「难过」并盖掉它 —— 于是她脸上那 2.5 秒的道歉被自己的解释挤掉了。
 * 明确的指令优先于猜测，所以猜测让路。
 */
export const MUTE_AFTER_EXPLICIT_EMOTION_MS = 6000;

/** 说了多少字就该保持多久：底 1400ms + 每字 70ms，夹在 1.6s ~ 5s。 */
export const STREAM_HOLD_BASE_MS = 1400;
export const STREAM_HOLD_PER_CHAR_MS = 70;
export const STREAM_HOLD_MIN_MS = 1600;
export const STREAM_HOLD_MAX_MS = 5000;

/**
 * 默认档的表（`coding`）。保留这个名字，是因为门禁、文档、`/status` 都指着它。
 *
 * 表本身在 `host/emotion-keywords.js`：三档（`coding` / `chat` / `story`）加用户
 * 追加。这里只导出**默认档** —— `classifySentence()` 不传表时用它，于是「没配
 * 任何东西」与「配了 coding」在行为上是同一件事。
 *
 * `平静` 故意**不在任何一档里**：它是「清空情绪层」的指令，而流式主动清空会在
 * 上一句的情绪还没走完时把它砍掉。清空是**表情自己到点**的行为，不是流的。
 */
export const EMOTION_KEYWORDS = KEYWORD_PROFILES[DEFAULT_SCENE];

/**
 * 把 markdown 里「不是话」的部分挖掉再判定。
 *
 * ── 为什么这是必须的，而不是锦上添花 ──────────────────────────────────────
 *
 * 我写的东西里，代码块和行内代码占很大比例。`if (!ok) throw new Error('失败')`
 * 这行代码里有「失败」，可它不是在说我难过 —— 它是**代码的内容**。不挖掉的话，
 * 她会在每次贴栈的时候露出难过的表情，而那个表情是纯噪声。
 *
 * 未闭合的围栏（流式到一半，``` 只来了一半）**一律当成「后面都还在代码里」**：
 * 这是流式特有的情况，等闭合符到了再判定也不迟。所以这里的策略是**截断**而不是
 * 删除 —— 一旦进了围栏，这一轮剩下的文本全部作废。
 */
export function stripCode(text) {
  if (typeof text !== 'string' || text === '') return '';
  let out = text;

  // 1) 闭合的围栏：整段挖掉（连同内容）。
  out = out.replace(/```[\s\S]*?```/g, ' ');

  // 2) 未闭合的围栏：从这里截断（流式到一半时的常态）。
  const openFence = out.indexOf('```');
  if (openFence !== -1) out = out.slice(0, openFence);

  // 3) 行内代码：内容挖掉（保留一个空格，免得两个词粘成一个）。
  out = out.replace(/`[^`\n]*`/g, ' ');

  // 4) markdown 的强调与标题符号。它们不影响词，但会影响「句子有多长」。
  out = out.replace(/^[ \t]*#{1,6}[ \t]*/gm, '').replace(/[*_]{1,3}/g, '');

  return out;
}

/** 在 `text` 里找下一个切点；找不到返回 null。 */
function findCut(text, flush) {
  for (let i = 0; i < text.length; i += 1) {
    if (HARD_TERMINATORS.includes(text[i])) {
      // 把连续的终止符（「！！」「？？」）和收尾引号一起吃进来。
      let end = i + 1;
      while (end < text.length && (HARD_TERMINATORS.includes(text[end]) || '」』"）)'.includes(text[end]))) end += 1;
      return { index: i, length: end - i };
    }
  }

  if (text.length >= SENTENCE_MAX_CHARS) {
    const window = text.slice(SOFT_BREAK_MIN_CHARS, SENTENCE_MAX_CHARS + 1);
    let soft = -1;
    for (let i = window.length - 1; i >= 0; i -= 1) {
      if (SOFT_BREAKS.includes(window[i])) { soft = SOFT_BREAK_MIN_CHARS + i; break; }
    }
    if (soft !== -1) return { index: soft, length: 1 };
    if (text.length >= HARD_CUT_CHARS) return { index: HARD_CUT_CHARS, length: 0 };
  }

  if (flush && text.trim().length >= 2) return { index: text.length, length: 0 };
  return null;
}

/**
 * 把一段文本切成句子（不认识的尾巴原样返回，等下一个 chunk）。
 *
 * 返回 `{ sentences, rest }`：`rest` 是**还没说完**的那截，要留在缓冲里。
 */
export function splitSentences(text, options = {}) {
  const flush = options.flush === true;
  const sentences = [];
  let rest = typeof text === 'string' ? text : '';

  for (;;) {
    const cut = findCut(rest, flush);
    if (cut === null) break;
    const head = rest.slice(0, cut.index + cut.length).trim();
    if (head !== '') sentences.push(head);
    rest = rest.slice(cut.index + cut.length);
    if (rest === '') break;
  }

  return { sentences, rest };
}

/**
 * 一条流一个缓冲。
 *
 * 本来想「刻意只是一个字符串：没有隐藏状态，门禁能一眼看穿」—— 门禁立刻证明
 * 那是错的：`stripCode` 遇到**未闭合**的围栏会截断，于是第一个 chunk 里开的
 * 围栏（```js）在缓冲里不留痕迹；第二个 chunk 的闭合符（```）反而被当成
 * **新开**一个围栏，把后面真正的正文整段吞掉 —— 表情于是永远不出现。
 * 跨 chunk 必须记住的只有一件事：**围栏现在开着没有**。所以缓冲是
 * `{ text, fenceOpen }`，`text` 里永远只有正文（代码在喂进来时就丢掉了）。
 */
export function createStreamBuffer() {
  return { text: '', fenceOpen: false };
}

/**
 * 喂一段 delta，取回「这句说完了」的句子。
 *
 * 缓冲里存的是**挖掉代码之后**的正文：原始文本是 DSH 的事（它在会话日志里），
 * 这里只需要判定用的那一份。围栏的开关状态跨 chunk 保留（见上），所以
 * `const a = 失败` 这种代码既不会在本次拼装里被判定，也不会把下一段正文吞掉。
 */
export function feedStream(buffer, delta, options = {}) {
  const previous = typeof buffer?.text === 'string' ? buffer.text : '';
  let fenceOpen = buffer?.fenceOpen === true;
  const addition = typeof delta === 'string' ? delta : '';
  let prose = '';
  let cursor = 0;

  while (cursor < addition.length) {
    const fence = addition.indexOf('```', cursor);
    if (fence === -1) {
      // 后面没有围栏了：开着就全是代码（丢掉），没开就全是正文。
      if (!fenceOpen) prose += addition.slice(cursor);
      break;
    }
    if (!fenceOpen) {
      prose += addition.slice(cursor, fence);
      fenceOpen = true;
    } else {
      fenceOpen = false;
    }
    // ```js 的 `js` 与闭合符后的换行都跟着围栏一起丢掉。
    cursor = fence + 3;
  }

  const { sentences, rest } = splitSentences(`${previous}${prose}`, { flush: options.flush === true });
  const tail = rest.length > BUFFER_TAIL_CHARS ? rest.slice(rest.length - BUFFER_TAIL_CHARS) : rest;
  return { sentences, buffer: { text: tail, fenceOpen } };
}

/**
 * 一个句子像哪一种情绪？
 *
 * 规则只有两条，都是为了**可预测**：
 *   1. **最长的关键词赢** —— 「不好意思」压过「好了」，因为它更具体；
 *   2. 一样长时**按表的顺序**赢（`EMOTION_KEYWORDS` 的键序是固定的）。
 *
 * 认不出来返回 `null` —— 那种时候调用方**什么都不做**，而不是退回「平静」。
 *
 * 第二个参数是**这一档**的表（`host/emotion-keywords.js` 解析出来的 `table`）。
 * 不传就用默认档：这让「没配置」与「配了 coding」在行为上完全一致，门禁也能在
 * 不构造配置的情况下逐条断言判据本身。
 */
export function classifySentence(text, table = EMOTION_KEYWORDS) {
  if (typeof text !== 'string' || text === '') return null;
  /*
   * 行内代码（`` `失败` ``）与残留的围栏不算话。`feedStream` 已经在流那侧把
   * 代码块丢掉了，但**行内**代码可能整个落在句子里（`ok` 反了，所以 `失败`），
   * 而调用方（Host 与门禁）都是直接递句子进来的 —— 判定这一步必须自己兜住。
   */
  const spoken = text.replace(/`[^`\n]*`/g, ' ').replace(/```/g, ' ');
  const words = table !== null && typeof table === 'object' ? table : EMOTION_KEYWORDS;
  let best = null;

  for (const name of Object.keys(words)) {
    const list = Array.isArray(words[name]) ? words[name] : [];
    for (const keyword of list) {
      if (typeof keyword !== 'string' || keyword === '') continue;
      if (!spoken.includes(keyword)) continue;
      if (best === null || keyword.length > best.keyword.length) {
        best = { name, keyword };
      }
    }
  }

  return best;
}

/** 说了多少字保持多久。太长的句子不该在她脸上停十秒。 */
export function holdForSentence(text) {
  const chars = typeof text === 'string' ? text.trim().length : 0;
  const wanted = STREAM_HOLD_BASE_MS + chars * STREAM_HOLD_PER_CHAR_MS;
  return Math.min(STREAM_HOLD_MAX_MS, Math.max(STREAM_HOLD_MIN_MS, Math.round(wanted)));
}

/**
 * 这个句子该不该推一条情绪指令？该推的话推什么？
 *
 * 返回 `{ name, intensity, holdMs, reason }` 或 `null`。`reason` 是**拒绝理由**
 * 的反面：被拒时返回 `{ skip: '…' }`…… 不，被拒就是 `null` —— 但这个函数有个
 * 明确的读者问题：**「她为什么没动」需要一个答案**。所以拒绝时返回
 * `{ skip: reason }`，接受时返回 `{ name, … }`。调用方只看有没有 `name`。
 *
 * @param {string} sentence
 * @param {{ last?: {name: string}|null, lastPushAt?: number, now?: number,
 *           mutedUntil?: number, queueFull?: boolean,
 *           table?: Record<string, string[]> }} options
 *   `table` 是这一档的表（不传 = 默认档）。
 */
export function planStreamEmotion(sentence, options = {}) {
  const text = typeof sentence === 'string' ? sentence.trim() : '';
  const now = Number.isFinite(options.now) ? options.now : 0;

  if (text.length < SENTENCE_MIN_CHARS) return { skip: 'too-short' };
  if (Number.isFinite(options.mutedUntil) && now < options.mutedUntil) return { skip: 'explicit-emotion' };
  if (options.queueFull === true) return { skip: 'queue-full' };

  const lastPushAt = Number.isFinite(options.lastPushAt) ? options.lastPushAt : -Infinity;
  if (now - lastPushAt < MIN_PUSH_INTERVAL_MS) return { skip: 'too-soon' };

  const hit = classifySentence(text, options.table);
  if (hit === null) return { skip: 'no-keyword' };

  const lastName = options.last?.name ?? '';
  if (hit.name === lastName && now - lastPushAt < REPEAT_SUPPRESS_MS) return { skip: 'same-as-last' };

  return {
    name: hit.name,
    keyword: hit.keyword,
    intensity: STREAM_EMOTION_INTENSITY,
    holdMs: holdForSentence(text),
    chars: text.length,
  };
}

/** 诊断用的一行摘要（`/status` 与门禁都读它）。 */
export function describeStreamPlan(plan) {
  if (plan === null || typeof plan !== 'object') return '（没有判定）';
  if (typeof plan.name !== 'string') return `跳过：${plan.skip ?? '未知理由'}`;
  return `${plan.name} ×${plan.intensity}（关键词「${plan.keyword}」，${plan.chars} 字，保持 ${plan.holdMs}ms）`;
}
