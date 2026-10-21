/*
 * 关键词表：**三档场景**（`scene`）+ 用户追加的词。
 *
 * ── 为什么是「档」，而不是一本情绪词典 ────────────────────────────────────
 *
 * 这张表不是情绪识别，是**同一个人的说法习惯**。原来那份表写的是我自己说话
 * 的方式：「全绿」「跑通了」是我说「好了」的方式，「抱歉，我漏了」是我说
 * 「对不起」的方式。换一个场景（陪聊、讲故事），同一个词的意思会变、也根本
 * 不会出现 —— 一份表硬套三个场景，结果是「该动的时候不动，不该动的时候乱动」。
 *
 * 所以这里给三档，每档是**同一个判据在不同领域的写法**：
 *
 *   · `coding` —— 技术对话（默认）。她跟我一起调试、写代码、读日志时说的话。
 *   · `chat`   —— 日常陪聊。语气词多、句子短、情绪靠「哈哈哈」「天哪」这类词。
 *   · `story`  —— 讲故事 / 朗读。叙事词（忽然、就在这时、眼泪）、长句、起伏大。
 *
 * ── 为什么表是死的，而不是让模型自己标 ────────────────────────────────────
 *
 * 见 `emotion-stream.js` 顶部：本机判定是**确定性**的，同样的话永远得到同样的
 * 情绪，可以被门禁逐条断言；让模型在正文里写标记则会把标记混进朗读。
 * 代价是它读不懂反讽 —— 这一点不是靠更大词表解决的，认不出来时它**什么都不做**。
 *
 * ── 为什么「这一档不认识那个词」是**正确**行为 ────────────────────────────
 *
 * 一个词在某档里不出现，说明这个场景里它本来就不携带那种情绪。硬塞进去会让
 * 每一档都退化成「什么都认」—— 而「猜错」比「不动」更糟（用户会看到她的脸
 * 表达了我根本没打算表达的情绪）。
 *
 * ── 这张表**仍然**是经验值，不是真理 ──────────────────────────────────────
 *
 * 三档的词是我按各场景的说话习惯写的，没有语料库支撑。真实的调法只有一种：
 * 看 `/status` 里 `streamEmotion.keywords` 的档位与词数、以及 `pushes` /
 * `skipped['no-keyword']` 的比例，再回来改这一档。改的时候请守住三条：
 * **一个词至少两个字**（单字触发面太大）、**同一档里不许有两个情绪共用一个词**
 * （谁赢取决于表序，等于掷硬币）、**同一档里不要互相包含**（最长词赢，短的那个
 * 永远不会单独生效）。这三条由 `tools/test-emotion-stream.mjs` 守。
 */

/** 默认档。没配、配错、读不到配置文件，都落在这里。 */
export const DEFAULT_SCENE = 'coding';

/** 三档的名字（顺序 = `live2d_status` 里列出来的顺序）。 */
export const SCENE_NAMES = Object.freeze(['coding', 'chat', 'story']);

/** 一个词最少两个字：单字（「好」「差」「累」）在任意一句话里都会撞上。 */
export const KEYWORD_MIN_CHARS = 2;

/**
 * 三档表。**每个键都必须是 `emotions.js` 里的正名**（门禁会核对，不许有第九种）。
 *
 * 写词的边界：只写**说话人会说的**，不写描述情绪的形容词（「愤怒」「悲伤」在
 * 叙述里出现，但那是我在描述她的脸，不是我脸上有什么）。
 */
export const KEYWORD_PROFILES = Object.freeze({
  coding: {
    开心: [
      '太好了', '全绿', '跑通了', '跑通', '搞定', '修好了', '通过了', '通过', '成功',
      '没问题', '顺利', '漂亮', '可以了', '终于', '上线', '好了', '不错',
    ],
    好奇: [
      '有意思', '挺有趣', '有点奇怪', '为什么会', '想知道', '查一查', '试试看',
      '看看它', '好奇',
    ],
    思考: [
      '我在想', '让我想想', '先想', '分析', '推理', '权衡', '大概', '也许',
      '可能要', '需要考虑', '这说明', '也就是说',
    ],
    认真: [
      '关键', '必须', '注意', '规则', '契约', '缺陷', '边界', '严格', '结论',
      '本质', '原因', '机制', '不能', '应该', '重要', '原则', '代价', '取舍',
    ],
    惊讶: [
      '没想到', '竟然', '居然', '原来', '意外', '吃惊', '吓一跳', '出乎意料',
    ],
    抱歉: [
      '抱歉', '对不起', '不好意思', '我错了', '是我的错', '我漏了', '我忘了',
      '疏忽', '手滑', '失误', '我的锅',
    ],
    难过: [
      '失败', '报错', '坏了', '挂了', '不行', '崩溃', '事故', '糟糕', '可惜',
      '遗憾', '退步', '没救', '白费',
    ],
    得意: [
      '厉害吧', '我厉害', '小意思', '顺手就', '一次就', '稳稳', '轻松搞定',
      '不在话下',
    ],
  },

  /**
   * 日常陪聊。特点：**人对着人说话**，情绪靠语气词和短句，而不是名词。
   * 所以这里多是「真的吗」「不会吧」「谢谢你」这类**回应**词。
   */
  chat: {
    开心: [
      '太好了', '好开心', '开心', '哈哈', '嘿嘿', '好耶', '太棒了', '真不错',
      '好棒', '喜欢', '谢谢你', '笑死',
    ],
    好奇: [
      '真的吗', '然后呢', '怎么回事', '为什么呀', '什么意思', '讲讲', '说来听听',
      '是吗', '啥情况', '怎么弄的',
    ],
    思考: [
      '让我想想', '我想想', '说不定', '也许吧', '我在想', '话说', '其实吧', '估计是',
    ],
    认真: [
      '说真的', '你得', '记住', '别忘', '重要', '讲道理', '认真的', '别不当回事',
    ],
    惊讶: [
      '不会吧', '天哪', '哇塞', '竟然', '居然', '没想到', '真的假的', '什么情况',
    ],
    抱歉: [
      '对不起', '抱歉', '不好意思', '是我不好', '我错了', '怪我', '疏忽了',
    ],
    难过: [
      '难受', '伤心', '委屈', '可惜', '好惨', '累死', '不开心', '想哭',
    ],
    得意: [
      '嘻嘻', '你看吧', '我说过', '厉害吧', '小意思', '轻松搞定', '不费劲', '哼哼',
    ],
  },

  /**
   * 讲故事 / 朗读。特点：**叙事**——情绪藏在动作和景物里（「眼泪」「忽然」
   * 「沉默」），而且往往是替**故事里的人**起伏，不是替我自己。
   */
  story: {
    开心: ['终于', '笑出声', '欢呼', '幸福', '温暖', '欢快'],
    好奇: ['奇怪', '究竟', '忍不住问', '打量', '好奇心', '想知道'],
    思考: ['沉默', '沉思', '想了很久', '犹豫', '似乎在', '低头不语'],
    认真: ['必须', '绝不能', '危险', '警告', '记住', '承诺', '誓言', '不可大意'],
    惊讶: ['忽然', '突然', '猛地', '一瞬间', '天哪', '没想到', '出乎意料', '震惊', '竟然'],
    抱歉: ['对不起', '抱歉', '原谅我', '我错了', '愧疚'],
    难过: ['眼泪', '哽咽', '悲伤', '孤独', '死去', '离别', '绝望', '遗憾', '心碎'],
    得意: ['得意', '嘴角上扬', '轻蔑', '不屑', '傲然', '扬眉'],
  },
});

/** 把外部来的档名规整成可比较的样子：去空白、转小写。认不出来就空串。 */
export function normalizeScene(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 把用户追加的词合进一份**可改的副本**里。
 *
 * 三条拒绝规则都是有代价的取舍，写在这里免得被当成 bug：
 *   · 词太短（< 2 字）—— 「好」出现在任何句子里，收进来等于每句都动一下；
 *   · 名字不是那八种之一 —— 加进来的层没有参数、没有颜色，渲染端会拒掉它，
 *     于是「配了但没反应」，不如这里就说清楚；
 *   · 空表 / 不是字符串 —— 配置文件是人手写的，手写就会写错。
 *
 * 被拒的词**不当错误抛**（一个词的笔误不该让整条自动情绪链失效），而是收进
 * `ignored` 让 `/status` 与 `live2d_status` 报出来 —— 静默失败是这套插件里最贵的 bug。
 */
export function mergeKeywordAdditions(table, additions) {
  const added = {};
  const ignored = [];
  if (additions === null || typeof additions !== 'object' || Array.isArray(additions)) {
    return { added, ignored };
  }

  for (const rawName of Object.keys(additions)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!Object.prototype.hasOwnProperty.call(table, name)) {
      ignored.push(`${rawName}（没有这一种情绪）`);
      continue;
    }
    const raw = additions[rawName];
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
    if (list.length === 0) {
      ignored.push(`${rawName}（空表）`);
      continue;
    }
    for (const item of list) {
      if (typeof item !== 'string') {
        ignored.push(`${rawName}: 不是字符串`);
        continue;
      }
      const word = item.trim();
      if ([...word].length < KEYWORD_MIN_CHARS) {
        ignored.push(`${rawName}: 「${word}」太短`);
        continue;
      }
      if (table[name].includes(word)) continue; // 预设里已经有了，不算追加
      table[name].push(word);
      (added[name] ??= []).push(word);
    }
  }

  return { added, ignored };
}

/**
 * 解析出一份**当前生效**的表。
 *
 * 返回的对象是这一轮的完整证据：`scene` 是实际用的、`requested` 是要的、
 * `fallback` 说明两者为什么不同、`words` 是词数、`added`/`ignored` 是追加的结果。
 * 全部都要能被 `/status` 看见 —— 「她为什么不认这个词」必须有一个能查到的地方。
 */
export function resolveKeywordTable(options = {}) {
  const requested = normalizeScene(options.scene);
  const known = requested !== '' && Object.prototype.hasOwnProperty.call(KEYWORD_PROFILES, requested);
  const scene = known ? requested : DEFAULT_SCENE;

  const base = KEYWORD_PROFILES[scene];
  const table = {};
  for (const name of Object.keys(base)) table[name] = [...base[name]];

  const merged = mergeKeywordAdditions(table, options.additions);

  let words = 0;
  for (const name of Object.keys(table)) words += table[name].length;

  return {
    scene,
    requested,
    fallback: requested !== '' && !known,
    table,
    words,
    added: merged.added,
    ignored: merged.ignored,
  };
}

/** 诊断用的一行摘要（`/status` 与 `live2d_status` 都读它）。 */
export function describeKeywordTable(meta) {
  if (meta === null || typeof meta !== 'object') return '（没有解析）';
  const scene = typeof meta.scene === 'string' ? meta.scene : DEFAULT_SCENE;
  let addedCount = 0;
  if (meta.added !== null && typeof meta.added === 'object') {
    for (const name of Object.keys(meta.added)) {
      if (Array.isArray(meta.added[name])) addedCount += meta.added[name].length;
    }
  }
  const parts = [`${scene}（${Number.isFinite(meta.words) ? meta.words : 0} 词${addedCount > 0 ? `，自定义 ${addedCount}` : ''}）`];
  if (meta.fallback === true) parts.push(`要的是「${meta.requested}」，没有这一档，回落到 ${scene}`);
  if (Array.isArray(meta.ignored) && meta.ignored.length > 0) {
    parts.push(`忽略了 ${meta.ignored.length} 个词`);
  }
  return parts.join('；');
}
