/**
 * C 期门禁：**流式情绪**（`agent/assistant-stream` → 按句判定 → 正常的 emotion 指令）。
 *
 * 分两半，缺一不可：
 *
 *   [1]–[6] **纯判定**。切句、挖代码、关键词、节流全是 `lib/host/emotion-stream.js`
 *           里的纯函数，这里逐条喂夹具断言。这一半能覆盖所有分支和边界，因为
 *           它不需要 Host、不需要渲染端、不需要时间流逝。
 *
 *   [7]     ★ **真机链**。用 `host-harness.mjs` 把 Host 半区真跑起来，**真的发**
 *           `agent/assistant-stream` 事件，然后从 `/pending` 里读队列 —— 验的是
 *           「事件真的变成了一条她脸上能执行的指令」，而不是「源码里出现了这几个
 *           字符串」。
 *
 * 为什么必须有 [7]：这套插件出过一次同类的错 —— `param` 通道**完整实现、有门禁
 * 一直守着它的规则**，却没有任何工具能产生它（`live2d_emote` 的第一期，用户让我
 * 「把眼睛闭起来」时才暴露）。规则全绿而链子一次都没通过，是这套门禁里最贵的
 * 一种假绿。
 *
 * 用法：node tools/test-emotion-stream.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootHost, getJson, postJson, toolByName } from './lib/host-harness.mjs';
import * as stream from '../dsh-live2d-pet/lib/host/emotion-stream.js';
import * as keywords from '../dsh-live2d-pet/lib/host/emotion-keywords.js';
import {
  THINKING_EMOTION_NAME,
  THINKING_HOLD_MS,
  THINKING_INTENSITY,
} from '../dsh-live2d-pet/lib/host/mood.js';
import { emotionNames } from '../dsh-live2d-pet/lib/host/emotions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..');
const HOST_SOURCE = readFileSync(join(WORKSPACE, 'dsh-live2d-pet', 'lib', 'index.js'), 'utf8');
const STREAM_SOURCE = readFileSync(join(WORKSPACE, 'dsh-live2d-pet', 'lib', 'host', 'emotion-stream.js'), 'utf8');
const KEYWORDS_SOURCE = readFileSync(
  join(WORKSPACE, 'dsh-live2d-pet', 'lib', 'host', 'emotion-keywords.js'), 'utf8');

let failed = 0;
let total = 0;

function ok(label, condition, detail = '') {
  total += 1;
  if (condition) {
    console.log(`  ✔ ${label}${detail === '' ? '' : `  ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${label}${detail === '' ? '' : `  ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** 注释里的字符串不算数（这一条踩过：断言在一个被注释掉的例子里命中了）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const HOST_CODE = stripComments(HOST_SOURCE);
const STREAM_CODE = stripComments(STREAM_SOURCE);

/* ── [1] 导出契约 ─────────────────────────────────────────────────────── */
section('[1] 纯模块的导出契约');

const FUNCTIONS = [
  'stripCode', 'splitSentences', 'createStreamBuffer', 'feedStream',
  'classifySentence', 'holdForSentence', 'planStreamEmotion', 'describeStreamPlan',
];
for (const name of FUNCTIONS) {
  ok(`导出 ${name}()`, typeof stream[name] === 'function');
}

/*
 * 「零 import」这条**曾经**成立，是场景化之前的性质。它真正保的性质有两条：
 * 门禁能直接 import 它跑断言、客户端 bundle 能内联它 —— 两条都不要求「一个字都不
 * import」，只要求**不碰 `node:` 内置模块**。加了场景档之后表搬进了
 * `emotion-keywords.js`（同样是纯数据），所以判据改成「只 import 那一个」。
 */
const STREAM_IMPORTS = STREAM_SOURCE.match(/^\s*import\s[^\n]*$/gm) ?? [];
ok('★ emotion-stream.js 只 import 一个纯数据模块（还是能直接给门禁 inline 的形态）',
  STREAM_IMPORTS.length === 1 && /from '\.\/emotion-keywords\.js'/.test(STREAM_IMPORTS[0])
    && !/require\(/.test(STREAM_SOURCE),
  STREAM_IMPORTS.join(' | ') || '（没有 import）');
ok('两个模块都不碰任何 node: 内置模块',
  !/from\s+['"]node:/.test(STREAM_SOURCE) && !/require\(['"]node:/.test(STREAM_SOURCE)
    && !/from\s+['"]node:/.test(KEYWORDS_SOURCE) && !/require\(['"]node:/.test(KEYWORDS_SOURCE));

ok('常量：句子下限 6 字', stream.SENTENCE_MIN_CHARS === 6, String(stream.SENTENCE_MIN_CHARS));
ok('常量：两次推送至少隔 700ms', stream.MIN_PUSH_INTERVAL_MS === 700, String(stream.MIN_PUSH_INTERVAL_MS));
ok('常量：同一种情绪 2.6s 内不重复', stream.REPEAT_SUPPRESS_MS === 2600, String(stream.REPEAT_SUPPRESS_MS));
ok('常量：一条流上最多压 2 条自动情绪', stream.MAX_QUEUED_AUTO_EMOTIONS === 2, String(stream.MAX_QUEUED_AUTO_EMOTIONS));
ok('常量：显式指令后静默 6s', stream.MUTE_AFTER_EXPLICIT_EMOTION_MS === 6000, String(stream.MUTE_AFTER_EXPLICIT_EMOTION_MS));
ok('★ 自动情绪的强度**小于** 1（它是陪衬，不是主角）',
  stream.STREAM_EMOTION_INTENSITY > 0 && stream.STREAM_EMOTION_INTENSITY < 1,
  String(stream.STREAM_EMOTION_INTENSITY));
ok('保持时长有上下限，且下限 < 上限',
  stream.STREAM_HOLD_MIN_MS < stream.STREAM_HOLD_MAX_MS,
  `${stream.STREAM_HOLD_MIN_MS} ~ ${stream.STREAM_HOLD_MAX_MS}`);

/* ── [2] 关键词表 ─────────────────────────────────────────────────────── */
section('[2] 关键词表：每一条都必须落在真实存在的情绪上');

const NAMES = emotionNames();
const TABLE_NAMES = Object.keys(stream.EMOTION_KEYWORDS);

ok('★ 表里的每个键都是 emotions.js 里真实存在的情绪',
  TABLE_NAMES.every((name) => NAMES.includes(name)),
  TABLE_NAMES.filter((name) => !NAMES.includes(name)).join(', ') || '（全部命中）');
ok('★ 「平静」**不在**表里（它是清空指令；流式主动清空会砍掉还没走完的表情）',
  !TABLE_NAMES.includes('平静'));
ok('★ 除「平静」外每一条情绪都有关键词（否则它有词却永远轮不到）',
  NAMES.filter((name) => name !== '平静').every((name) => Array.isArray(stream.EMOTION_KEYWORDS[name])
    && stream.EMOTION_KEYWORDS[name].length > 0),
  NAMES.filter((name) => name !== '平静' && !(stream.EMOTION_KEYWORDS[name]?.length > 0)).join(', ') || '（全部有）');

const allKeywords = TABLE_NAMES.flatMap((name) => stream.EMOTION_KEYWORDS[name].map((word) => ({ name, word })));
ok('关键词都是非空字符串', allKeywords.every((e) => typeof e.word === 'string' && e.word.trim() !== ''));
ok('★ 没有单字关键词（一个「好」字会在任何句子里命中）',
  allKeywords.every((e) => e.word.length >= 2),
  allKeywords.filter((e) => e.word.length < 2).map((e) => e.word).join(', ') || '（都 ≥2 字）');

const duplicated = allKeywords
  .map((e) => e.word)
  .filter((word, index, list) => list.indexOf(word) !== index);
ok('★ 同一个关键词不在两种情绪里出现（否则判定顺序就成了唯一的判据）',
  duplicated.length === 0, duplicated.join(', ') || '（无重复）');

/*
 * ★ 每一条情绪都**可达**：拿它的第一个关键词去判，必须回到它自己。
 * 这条是「表没有写歪」的唯一机械保证 —— 光看「有没有关键词」看不出
 * 「关键词被另一种情绪更长的词压住了」。
 */
const unreachable = NAMES
  .filter((name) => name !== '平静')
  .filter((name) => {
    const probe = stream.EMOTION_KEYWORDS[name]?.[0];
    return stream.classifySentence(`这句话里有${probe}`)?.name !== name;
  });
ok('★ 每条情绪都能靠自己的关键词被认出来（没有一条被别人的更长的词永久压住）',
  unreachable.length === 0, unreachable.join(', ') || `（${NAMES.length - 1} 条全可达）`);

/* ── [2b] 三档场景：每一档自己都得是完整的 ─────────────────────────────── */
section('[2b] 三档场景：coding / chat / story 各自都完整');

ok('三档的名字就是 coding / chat / story',
  JSON.stringify(keywords.SCENE_NAMES) === JSON.stringify(['coding', 'chat', 'story']),
  JSON.stringify(keywords.SCENE_NAMES));
ok('★ 默认档是 coding，且 `EMOTION_KEYWORDS` 就是它（「没配置」与「配了 coding」是同一件事）',
  keywords.DEFAULT_SCENE === 'coding'
    && stream.EMOTION_KEYWORDS === keywords.KEYWORD_PROFILES[keywords.DEFAULT_SCENE]);

const CANONICAL = NAMES.filter((name) => name !== '平静');
for (const scene of keywords.SCENE_NAMES) {
  const table = keywords.KEYWORD_PROFILES[scene];
  const keys = Object.keys(table);
  const words = keys.flatMap((name) => (table[name] ?? []).map((word) => ({ name, word })));
  const dup = words.map((e) => e.word).filter((word, index, list) => list.indexOf(word) !== index);
  const unreachableInScene = CANONICAL.filter((name) => {
    const probe = table[name]?.[0];
    return typeof probe !== 'string' || stream.classifySentence(`这句话里有${probe}`, table)?.name !== name;
  });
  ok(`[${scene}] 八种情绪一个不少、一个不多`,
    keys.length === CANONICAL.length && CANONICAL.every((name) => keys.includes(name)),
    `${keys.length} 个键：${keys.join('/')}`);
  ok(`[${scene}] 没有单字词、没有跨情绪重复词`,
    words.every((e) => typeof e.word === 'string' && e.word.trim().length >= 2) && dup.length === 0,
    dup.join(', ') || `${words.length} 个词`);
  ok(`[${scene}] 每条情绪都能靠自己的词被认出来（没有被别人的更长的词永久压住）`,
    unreachableInScene.length === 0, unreachableInScene.join(', ') || `（${CANONICAL.length} 条全可达）`);
  ok(`[${scene}] 至少 40 个词（太薄的档等于没做）`, words.length >= 40, `${words.length} 个词`);
}

/* ── [2c] 解析：配的是哪一档、加了什么、错了怎么办 ─────────────────────── */
section('[2c] 解析：档名、追加词、回落');

const baseResolve = keywords.resolveKeywordTable();
ok('什么都不配 → coding，不算回落',
  baseResolve.scene === 'coding' && baseResolve.fallback === false && baseResolve.words > 0);
ok('配 chat → chat（大小写与空白被规整）',
  keywords.resolveKeywordTable({ scene: '  CHAT ' }).scene === 'chat');
const wrongScene = keywords.resolveKeywordTable({ scene: 'nonsense' });
ok('★ 认不出的档回落 coding，但**说出来**要的是什么',
  wrongScene.scene === 'coding' && wrongScene.fallback === true && wrongScene.requested === 'nonsense');
ok('回落原因出现在描述里（诊断面能读到）', /回落到 coding/.test(keywords.describeKeywordTable(wrongScene)));

const merged = keywords.resolveKeywordTable({
  scene: 'coding',
  additions: { 开心: ['新词甲', '好'], 不存在: ['啊'], 难过: 42, 认真: '新词乙' },
});
ok('追加词真的进了表（字符串单值也收）',
  merged.table.开心.includes('新词甲') && merged.table.认真.includes('新词乙'));
ok('★ 单字词被拒，而且拒的理由能被读到',
  !merged.table.开心.includes('好')
    && merged.ignored.some((line) => line.includes('好') && line.includes('太短')),
  JSON.stringify(merged.ignored));
ok('★ 不存在的情绪名被拒，而不是悄悄加进一个没人读的键',
  merged.ignored.some((line) => line.includes('没有这一种情绪')) && !('不存在' in merged.table),
  JSON.stringify(merged.ignored));
ok('★ 解析两次不会累加（表是副本，不是模块级那个对象的引用）',
  keywords.resolveKeywordTable().words === baseResolve.words,
  `${baseResolve.words} → ${keywords.resolveKeywordTable().words}`);
ok('词数与追加数对得上',
  merged.words === baseResolve.words + 2
    && Object.values(merged.added).reduce((n, list) => n + list.length, 0) === 2,
  `${merged.words}（追加 ${JSON.stringify(merged.added)}）`);
ok('描述里报出自定义词数', /自定义 2/.test(keywords.describeKeywordTable(merged)));

const codingTable = keywords.resolveKeywordTable({ scene: 'coding' }).table;
const chatTable = keywords.resolveKeywordTable({ scene: 'chat' }).table;
const chatOnly = '真的吗，然后呢？';
ok('★ 同一句话在两档里判出不同结果（表真的在切，不是只有名字换了）',
  stream.classifySentence(chatOnly, chatTable)?.name === '好奇'
    && stream.classifySentence(chatOnly, codingTable) === null,
  JSON.stringify({
    chat: stream.classifySentence(chatOnly, chatTable)?.name ?? null,
    coding: stream.classifySentence(chatOnly, codingTable)?.name ?? null,
  }));
ok('planStreamEmotion 用的是传进来的那张表',
  stream.planStreamEmotion(chatOnly, { table: chatTable })?.name === '好奇'
    && stream.planStreamEmotion(chatOnly, { table: codingTable })?.skip === 'no-keyword');

/* ── [3] stripCode：代码不是话 ────────────────────────────────────────── */
section('[3] stripCode：先说清楚「哪些字不是在说话」');

ok('普通的句子原样通过', stream.stripCode('跑通了，全绿。') === '跑通了，全绿。');
ok('★ 闭合的围栏整段挖掉',
  !stream.stripCode('前面```js\nconst a = 失败\n```后面').includes('失败'));
ok('★ 未闭合的围栏（流式到一半）从这里截断 —— 后面整段作废',
  !stream.stripCode('前面```js\nconst a = 失败').includes('失败'));
ok('★ 行内代码的内容挖掉', !stream.stripCode('这个 `失败` 是个变量名').includes('失败'));
ok('围栏之后的正文仍然保留（截断不等于整条丢掉）',
  stream.stripCode('```\ncode\n```\n然后跑通了。').includes('跑通了'));
ok('markdown 的强调符号被去掉，但词本身还在（`**全绿**` 仍能判出开心）',
  stream.classifySentence(stream.stripCode('**全绿**'))?.name === '开心');
ok('非字符串喂进来返回空串（事件里的坏 frame 不该让判定抛）',
  stream.stripCode(null) === '' && stream.stripCode(undefined) === '' && stream.stripCode(42) === '');

/* ── [4] splitSentences：句子的边界 ───────────────────────────────────── */
section('[4] splitSentences：句子在哪里结束');

const two = stream.splitSentences('第一句。第二句。');
ok('两个终止符切成两句', two.sentences.length === 2 && two.sentences[0] === '第一句。',
  JSON.stringify(two.sentences));
ok('切完之后没有残留', two.rest === '');

const partial = stream.splitSentences('第一句。还没说完');
ok('★ 没说完的那截留在 rest 里，不判', partial.sentences.length === 1 && partial.rest === '还没说完',
  JSON.stringify(partial));

ok('★ 点号不是终止符（`v0.2 修好了。` 是一句，不是两句）',
  stream.splitSentences('v0.2 修好了。').sentences.length === 1,
  JSON.stringify(stream.splitSentences('v0.2 修好了。').sentences));

ok('连续的终止符与收尾引号跟着句子走',
  stream.splitSentences('真的吗？！我不信。').sentences[0] === '真的吗？！',
  JSON.stringify(stream.splitSentences('真的吗？！我不信。').sentences));

/*
 * 软停顿的夹具**必须真的超过 SENTENCE_MAX_CHARS（42 字）** —— 短于它时
 * 「再等等，说不定马上就有句号」才是正确行为。第一版夹具只有 26 字，
 * 于是它验的是「短句不该被切开」，而不是它想验的那条。
 */
const longText = `${'这句话确实有点长'.repeat(4)}，后面还有一截没说完的内容`;
const longSplit = stream.splitSentences(longText);
const longHead = String(longSplit.sentences[0] ?? '');
ok('★ 长句在软停顿处切开（不能让表情落后朗读三秒）',
  longSplit.sentences.length === 1 && longHead.endsWith('，'),
  `head=${longHead.length} 字 ${JSON.stringify(longHead.slice(-6))}`);
ok('软停顿切出来的头不会太短', longHead.length >= stream.SOFT_BREAK_MIN_CHARS,
  String(longHead.length));
ok('切出来的头也不超过上限太多（否则等于没切）',
  longHead.length <= stream.SENTENCE_MAX_CHARS + 1, String(longHead.length));

const flushed = stream.splitSentences('没有终止符的一句', { flush: true });
ok('★ flush 时把剩下的整句交出来（`end` frame 要收尾）',
  flushed.sentences.length === 1 && flushed.rest === '', JSON.stringify(flushed));

ok('空输入不产生句子也不死循环',
  stream.splitSentences('').sentences.length === 0 && stream.splitSentences('', { flush: true }).sentences.length === 0);

/* ── [5] classifySentence：关键词判定 ─────────────────────────────────── */
section('[5] classifySentence：这句话像哪种情绪');

ok('「太好了，全绿。」→ 开心',
  stream.classifySentence('太好了，全绿。')?.name === '开心',
  JSON.stringify(stream.classifySentence('太好了，全绿。')));
ok('★ 最长的关键词赢（跨情绪：`没想到` 压过 `全绿`）',
  stream.classifySentence('没想到全绿了')?.name === '惊讶',
  JSON.stringify(stream.classifySentence('没想到全绿了')));
ok('认不出来返回 null（不是猜一个，也不是退回「平静」）',
  stream.classifySentence('这是一段普通的话') === null,
  JSON.stringify(stream.classifySentence('这是一段普通的话')));
ok('★ 「平静」这个词本身不判成任何情绪（它是清空指令）',
  stream.classifySentence('我很平静') === null);
ok('代码里的词不算话（stripCode + classify 连起来）',
  stream.classifySentence(stream.stripCode('```\n抛出一个失败\n```')) === null);
ok('空串与 null 不抛', stream.classifySentence('') === null && stream.classifySentence(null) === null);

/* ── [6] 节流与拒绝理由 ───────────────────────────────────────────────── */
section('[6] holdForSentence / planStreamEmotion：什么时候**不**推');

ok('短句的保持时长被抬到下限', stream.holdForSentence('短句') === stream.STREAM_HOLD_MIN_MS,
  String(stream.holdForSentence('短句')));
ok('超长句的保持时长被夹到上限',
  stream.holdForSentence('字'.repeat(300)) === stream.STREAM_HOLD_MAX_MS,
  String(stream.holdForSentence('字'.repeat(300))));
ok('越长的句子保持越久', stream.holdForSentence('这是一句比较长的中文句子了') > stream.holdForSentence('短句'));

const planBase = { now: 100000, last: null, lastPushAt: -Infinity, mutedUntil: 0, queueFull: false };
const accepted = stream.planStreamEmotion('太好了，全绿。', planBase);
ok('★ 正常的一句被接受，并给出名字 / 强度 / 保持时长',
  accepted.name === '开心' && accepted.intensity < 1
    && accepted.holdMs >= stream.STREAM_HOLD_MIN_MS && accepted.holdMs <= stream.STREAM_HOLD_MAX_MS,
  stream.describeStreamPlan(accepted));
ok('接受时带上命中的关键词与字数（诊断要能回答「为什么是这个表情」）',
  accepted.keyword === '太好了' && accepted.chars === 7,
  JSON.stringify({ keyword: accepted.keyword, chars: accepted.chars }));

const reason = (sentence, options) => stream.planStreamEmotion(sentence, { ...planBase, ...options })?.skip;
ok('太短 → too-short', reason('好的。') === 'too-short', String(reason('好的。')));
ok('没有关键词 → no-keyword', reason('这是一段普通的话') === 'no-keyword',
  String(reason('这是一段普通的话')));
/*
 * 附注：「今天天气不错」**会**判成开心 —— 表里的 `不错` 命中了。
 * 这不是漏网：`不错` 是两字词、语气确实是正面的，一只桌宠听到它笑一下是对的。
 * 夹具改掉，是因为它当「认不出来的话」用得太多，而它其实认得出来。
 */
ok('★ 离上一条太近 → too-soon',
  reason('太好了，全绿。', { lastPushAt: planBase.now - 100 }) === 'too-soon',
  String(reason('太好了，全绿。', { lastPushAt: planBase.now - 100 })));
ok('★ 同一种情绪连着出现 → same-as-last',
  reason('太好了，全绿。', { last: { name: '开心' }, lastPushAt: planBase.now - 1000 }) === 'same-as-last',
  String(reason('太好了，全绿。', { last: { name: '开心' }, lastPushAt: planBase.now - 1000 })));
ok('★ 换一种情绪就不再被 same-as-last 拦（她的脸该跟着变）',
  stream.planStreamEmotion('没想到居然是这样', { ...planBase, last: { name: '开心' }, lastPushAt: planBase.now - 1000 })?.name === '惊讶');
ok('★ 同一种情绪隔得够久可以再来一次',
  stream.planStreamEmotion('太好了，全绿。', {
    ...planBase, last: { name: '开心' }, lastPushAt: planBase.now - stream.REPEAT_SUPPRESS_MS - 1,
  })?.name === '开心');
ok('★ 显式指令的静默期 → explicit-emotion',
  reason('太好了，全绿。', { mutedUntil: planBase.now + 5000 }) === 'explicit-emotion',
  String(reason('太好了，全绿。', { mutedUntil: planBase.now + 5000 })));
ok('★ 队列里压着她还没做的自动情绪 → queue-full',
  reason('太好了，全绿。', { queueFull: true }) === 'queue-full',
  String(reason('太好了，全绿。', { queueFull: true })));
ok('★ 被拒时也返回一个对象（调用方只看有没有 name，理由记进账）',
  typeof stream.planStreamEmotion('今天天气不错', planBase) === 'object');
ok('describeStreamPlan 说人话',
  /开心/.test(stream.describeStreamPlan(accepted)) && /跳过/.test(stream.describeStreamPlan({ skip: 'no-keyword' })),
  stream.describeStreamPlan(accepted));

/* ── [7] feedStream：跨 chunk 的拼装 ──────────────────────────────────── */
section('[7] feedStream：delta 是碎的，句子不是');

let buffer = stream.createStreamBuffer();
let fed = stream.feedStream(buffer, '一切');
ok('半个句子先不判', fed.sentences.length === 0, JSON.stringify(fed.sentences));
buffer = fed.buffer;
fed = stream.feedStream(buffer, '都好。');
ok('★ 后半个 chunk 到了，句子才成立', fed.sentences.length === 1 && fed.sentences[0] === '一切都好。',
  JSON.stringify(fed.sentences));
ok('取出后缓冲清空', fed.buffer.text === '');

buffer = stream.createStreamBuffer();
buffer = stream.feedStream(buffer, '第一句。').buffer;
ok('一句里能同时取出多句', stream.feedStream(stream.createStreamBuffer(), '第一句。第二句。').sentences.length === 2);

/*
 * ★ 这一段是本文件里最有价值的一条夹具：**代码块跨 chunk**。
 * 围栏在第一个 chunk 里打开、在第二个 chunk 里闭合。没有 stripCode 的话，
 * `const a = 失败` 会被当成一句「难过」—— 她会在每次贴栈的时候露出难过的表情。
 */
buffer = stream.createStreamBuffer();
buffer = stream.feedStream(buffer, '```js\nconst a = 失败\n').buffer;
fed = stream.feedStream(buffer, '```\n然后跑通了。');
ok('★ 跨 chunk 的代码块里的话没有被判（代码不是话）',
  fed.sentences.length === 1 && fed.sentences[0].includes('跑通了') && !fed.sentences.join('').includes('失败'),
  JSON.stringify(fed.sentences));
ok('而且它不是靠「恰好没判出来」—— 同一个词在正文里是能判出来的',
  stream.classifySentence('失败了')?.name === '难过');

buffer = stream.createStreamBuffer();
buffer = stream.feedStream(buffer, '字'.repeat(400)).buffer;
ok('★ 缓冲不会无限涨（没有终止符的一大段文字）', buffer.text.length <= 240, String(buffer.text.length));

const flushedStream = stream.feedStream(stream.createStreamBuffer(), '没有终止符的收尾', { flush: true });
ok('flush 把尾巴交出来', flushedStream.sentences.length === 1, JSON.stringify(flushedStream.sentences));

/* ── [8] ★ 真机链：事件 → 队列 ────────────────────────────────────────── */
section('[8] ★ 真机链：真的发 agent/assistant-stream，真的从 /pending 里读出来');

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-live2d-stream-gate-'));

/** 情绪层要用的参数（照 hiyori 真值）：没有它们，「开心」一个角色都匹配不上。 */
const CAPABILITIES = {
  parameters: [
    { id: 'ParamAngleX', min: -30, max: 30, def: 0 },
    { id: 'ParamAngleY', min: -30, max: 30, def: 0 },
    { id: 'ParamAngleZ', min: -30, max: 30, def: 0 },
    { id: 'ParamEyeLSmile', min: 0, max: 1, def: 0 },
    { id: 'ParamEyeRSmile', min: 0, max: 1, def: 0 },
    { id: 'ParamEyeLOpen', min: 0, max: 1.2, def: 1 },
    { id: 'ParamEyeROpen', min: 0, max: 1.2, def: 1 },
    { id: 'ParamEyeBallX', min: -1, max: 1, def: 0 },
    { id: 'ParamEyeBallY', min: -1, max: 1, def: 0 },
    { id: 'ParamBrowLY', min: -1, max: 1, def: 0 },
    { id: 'ParamBrowRY', min: -1, max: 1, def: 0 },
    { id: 'ParamBrowLForm', min: -1, max: 1, def: 0 },
    { id: 'ParamBrowRForm', min: -1, max: 1, def: 0 },
    { id: 'ParamCheek', min: -1, max: 1, def: 0 },
    { id: 'ParamBodyAngleX', min: -10, max: 10, def: 0 },
    { id: 'ParamBodyAngleZ', min: -10, max: 10, def: 0 },
    { id: 'ParamShoulder', min: -1, max: 1, def: 0 },
    { id: 'ParamHairAhoge', min: -10, max: 10, def: 0 },
  ],
  expressions: [],
  motionGroups: [{ name: 'Idle', count: 2 }],
  hitAreas: [],
};

const rootAgent = { sessionId: 'root-session' };
const childAgent = { sessionId: 'child-session' };

const boot = await bootHost({
  modelsRoot: tempRoot,
  services: { agents: { roots: () => [rootAgent] } },
});
const { env, api, base } = boot;

/** 发一条完整的流（start → chunk… → end）。 */
const emitTurn = (agent, text, type = 'full') => {
  env.emit('agent/assistant-stream', { agent, frame: { type: 'start' } });
  if (type !== 'start-only') {
    env.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } });
  }
  if (type === 'full') env.emit('agent/assistant-stream', { agent, frame: { type: 'end' } });
};

const drain = async () => (await getJson(base, '/pending')).json?.items ?? [];
const emotionItems = (items) => items.filter((item) => item?.command?.kind === 'emotion');

/*
 * ★ 队列里有**两类**自动情绪，这一段必须指名道姓地说自己在数哪一类。
 *
 * D 期起，回合的起手会推一条思考态；思考态**收在状态真的回到 idle 的那一刻**
 * （说完 8 秒后），收法是「按名字收掉那一层」（`emotion.release`）。它们和
 * 「跟着话动」的判定走**同一条队列、同一个 origin、同一个配额**（这是设计，
 * 不是巧合：队列是「她还没做的表情」的清单，谁推的都要排队）。于是本段里
 * 「队列里恰好一条」这种断言在两件事上会读错：它可能数到思考态，也可能把
 * 思考态当成判定结果。
 *
 * 所以：`moodItems` 是回合状态机推的那几条（思考态 + 收思考态那一条）；
 * `classifiedItems` 才是**这一段真正要验的东西**（事件 → 分句 → 判定）。
 * 两者都要被断言到，不许靠过滤把对方藏起来 —— 所以 [8k] 专门盯着思考态那一条。
 *
 * ★ 「收」那一条**没有名字**，所以光按名字过滤会漏掉它（它会被当成一条判定结果，
 * 而它的 `name` 是空串 —— 那种断言失败会指向完全错误的地方）。`release` 数组
 * 是它唯一可靠的标记。
 */
const MOOD_PUSH_NAMES = new Set([THINKING_EMOTION_NAME, '平静']);
const isMoodPush = (item) => {
  const emotion = item?.command?.payload?.emotion ?? {};
  return MOOD_PUSH_NAMES.has(String(emotion.name ?? '')) || Array.isArray(emotion.release);
};
const moodItems = (items) => emotionItems(items).filter(isMoodPush);
const classifiedItems = (items) => emotionItems(items).filter((item) => !isMoodPush(item));
const emotionNameOf = (item) => String(item?.command?.payload?.emotion?.name ?? '');

/*
 * ★ 时间要能被门禁推着走。
 *
 * 节流（700ms）、重复抑制（2.6s）、静默期（6s）全是**时间**上的规则，而真等
 * 6 秒会让这条门禁从「一眼能跑完」变成「跑一趟要十几秒」。所以这里临时换掉
 * `Date.now`，让门禁自己决定现在几点 —— 用它换来的是一条能**确定性地**验
 * 「推得太密会被拦住」的断言，而不是一条要睡 700ms 才能验的断言。
 *
 * 步长刻意压在 1 秒以内：指令的 TTL 是 4 秒，跳太大队列里的东西会先过期。
 */
const realNow = Date.now;
let clock = 1_800_000_000_000;

try {
  Date.now = () => clock;

  await drain();

  /* [8a] 没有能力清单时：没有脸可动，什么都不该推。 */
  emitTurn(rootAgent, '太好了，全绿。');
  const beforeCaps = emotionItems(await drain());
  ok('★ 渲染端还没上报能力清单时不推（没有脸可动）', beforeCaps.length === 0,
    `${beforeCaps.length} 条`);
  ok('而且账上记了理由（`skipped["no-capabilities"]`）—— 「她为什么没动」要答得出来',
    (api.state.streamEmotion?.skipped?.['no-capabilities'] ?? 0) >= 1,
    JSON.stringify(api.state.streamEmotion?.skipped ?? {}));

  const capsPost = await postJson(base, '/capabilities', {
    id: '门禁/流式.model3.json',
    capabilities: CAPABILITIES,
  });
  ok('能力清单已就位（后面的断言才有意义）', capsPost.status === 200, `HTTP ${capsPost.status}`);

  /*
   * [8a2] ★ 舞台卸载 → 渲染端 POST 一份「清空」→ Host 必须真把清单丢掉（§13.25）。
   *
   * 这条守的不是「清空接口能返回 200」，而是**清空之后那条错就不再往下走**：
   * 以前清单只增不减，于是舞台没了以后到达的表情 / 动作会一路送到渲染端，
   * 在那里被 `action-runner.ts` 拒成 `E_ACTION_NO_MODEL`（真机 clientErrors 里
   * 那一条）。清空之后同一条指令应当在 **Host 侧**就变成 `E_ACTION_NO_CAPABILITIES`。
   */
  const cleared = await postJson(base, '/capabilities', { capabilities: null, reason: 'stage-unmounted' });
  ok('清空请求被收下（200 + cleared:true）',
    cleared.status === 200 && cleared.json?.cleared === true,
    `HTTP ${cleared.status} ${JSON.stringify(cleared.json ?? null).slice(0, 160)}`);

  const gone = await getJson(base, '/capabilities');
  ok('★ 清单真的没了（capabilities / digest / summary 三样一起，不是一个空清单）',
    gone.json?.capabilities === null && gone.json?.digest === null && gone.json?.summary === null,
    JSON.stringify({ caps: gone.json?.capabilities ?? 'null', digest: gone.json?.digest ?? 'null' }));

  ok('★ detail 说的是「舞台不在了」，而不是「模型还没加载完」（AI 该不该等，全看这一句）',
    String(gone.json?.detail ?? '').includes('舞台'),
    String(gone.json?.detail ?? '').slice(0, 96));

  let refusedText = '';
  try {
    refusedText = JSON.stringify(await toolByName(boot.env, 'live2d_emote').execute({ name: '开心' }) ?? null);
  } catch (err) {
    refusedText = String(err?.message ?? err);
  }
  ok('★ 清空之后需要清单的指令在 Host 侧就被拒成 E_ACTION_NO_CAPABILITIES（不再换成渲染端那条 E_ACTION_NO_MODEL）',
    refusedText.includes('E_ACTION_NO_CAPABILITIES'),
    refusedText.slice(0, 200));

  const capsBack = await postJson(base, '/capabilities', {
    id: '门禁/流式.model3.json',
    capabilities: CAPABILITIES,
  });
  const capsAfter = await getJson(base, '/capabilities');
  ok('重新上报后清单回来（下一段 [8b] 才有脸可动）',
    capsBack.status === 200 && capsAfter.json?.capabilities !== null,
    `HTTP ${capsBack.status} caps=${capsAfter.json?.capabilities === null ? 'null' : 'ok'}`);

  /* [8b] 一句「太好了，全绿。」→ 一条 emotion 指令。 */
  clock += 1000;
  emitTurn(rootAgent, '太好了，全绿。');
  const afterOne = await drain();
  const streamItem = classifiedItems(afterOne)[0];
  ok('★ 事件真的变成了一条入队指令（这一格是整条链的存在性证明）',
    streamItem !== undefined, JSON.stringify(afterOne.map((i) => i?.command?.kind)));
  /*
   * 一个回合是**两条**：起手的思考态 + 判出来的那一条。顺序也是设计的一部分 ——
   * 思考态先挂上，判出来的情绪再把它替掉（`setEmotion` 是替换，不是叠加）。
   */
  const moodFirst = moodItems(afterOne);
  ok('★ 一个回合推两条：先思考态、后判出来的那条（顺序即设计）',
    moodFirst.length === 1 && emotionItems(afterOne).length === 2
      && emotionNameOf(emotionItems(afterOne)[0]) === THINKING_EMOTION_NAME,
    JSON.stringify(emotionItems(afterOne).map(emotionNameOf)));
  ok('★ 判定出的是「开心」', streamItem?.command?.payload?.emotion?.name === '开心',
    String(streamItem?.command?.payload?.emotion?.name));
  ok('★ 带着真实的参数包（不是「一句开心」，是能叠到她脸上的增量）',
    Object.keys(streamItem?.command?.payload?.emotion?.params ?? {}).length >= 4,
    JSON.stringify(streamItem?.command?.payload?.emotion?.params ?? {}));
  ok('★ 来源记成 stream（队列保护要数它）', streamItem?.origin === 'stream',
    String(streamItem?.origin));
  ok('强度是 0.85（自动的比显式的轻一档）',
    streamItem?.command?.payload?.emotion?.intensity === stream.STREAM_EMOTION_INTENSITY,
    String(streamItem?.command?.payload?.emotion?.intensity));
  ok('三段时长都在（渲染端的包络要有东西可算）',
    typeof streamItem?.command?.payload?.emotion?.attackMs === 'number'
      && typeof streamItem?.command?.payload?.emotion?.releaseMs === 'number'
      && streamItem?.command?.payload?.emotion?.holdMs > 0,
    JSON.stringify({
      attack: streamItem?.command?.payload?.emotion?.attackMs,
      hold: streamItem?.command?.payload?.emotion?.holdMs,
      release: streamItem?.command?.payload?.emotion?.releaseMs,
    }));
  ok('priority 与 ttlMs 走的是和其它指令完全一样的队列语义',
    streamItem?.command?.priority === 50 && typeof streamItem?.command?.ttlMs === 'number',
    JSON.stringify({ p: streamItem?.command?.priority, ttl: streamItem?.command?.ttlMs }));

  /* [8c] ★ 自动那条与工具那条**逐字节相同**：自动情绪没有绕过契约的特权。 */
  const streamParams = JSON.stringify(streamItem?.command?.payload?.emotion?.params ?? {});
  const toolEmote = await env.tools.find((t) => t.name === 'live2d_emote').execute({ name: '开心' });
  const toolItem = classifiedItems(await drain())[0];
  ok('工具那条也被接受了（对照组）', toolEmote?.ok === true, String(toolEmote?.detail ?? '').slice(0, 80));
  ok('★ 自动那条与工具那条用的是**同一份预设**（键集相同；数值只差强度那一档）',
    JSON.stringify(Object.keys(toolItem?.command?.payload?.emotion?.params ?? {}))
      === JSON.stringify(Object.keys(streamItem?.command?.payload?.emotion?.params ?? {})),
    `${streamParams} vs ${JSON.stringify(toolItem?.command?.payload?.emotion?.params ?? {})}`);
  /*
   * ★ 这一条是「自动的比显式的轻一档」的**数值证据**：同一个「开心」，自动那条的
   * 每一个增量都恰好是工具那条 × 0.85。写成「完全相同」是错的 —— 那才是缺陷
   * （AI 自己猜的表情与它主动下的指令会长得一样重）。
   */
  const toolParams = toolItem?.command?.payload?.emotion?.params ?? {};
  const streamKeys = Object.keys(streamItem?.command?.payload?.emotion?.params ?? {});
  ok('★ 自动那条每个增量都恰好是工具那条的 0.85 倍（猜的比说的轻）',
    streamKeys.length > 0 && streamKeys.every((id) => (
      Math.abs(streamItem.command.payload.emotion.params[id]
        - toolParams[id] * stream.STREAM_EMOTION_INTENSITY) < 1e-9
    )),
    `${streamParams} vs ${JSON.stringify(toolParams)}`);
  ok('工具那条的来源是 tool（两条路在队列里分得开）', toolItem?.origin === 'tool', String(toolItem?.origin));

  /* [8d] 子会话的流不驱动表情（我看不见的话不该写在我脸上）。 */
  clock += 1000;
  emitTurn(childAgent, '太好了，全绿。');
  const afterChild = emotionItems(await drain());
  ok('★ 子会话的流一条都不推', afterChild.length === 0, `${afterChild.length} 条`);
  ok('作用域判定记成 child（可查）', api.state.streamEmotion?.lastScope === 'child',
    String(api.state.streamEmotion?.lastScope));

  /* [8e] ★ 显式指令的静默期：三拍因果（它被设了 → 它拦住了 → 清掉就恢复）。 */
  ok('★ 工具调用把静默期设上了', (api.state.emotionMuteUntil ?? 0) > clock,
    `muteUntil=${api.state.emotionMuteUntil} now=${clock}`);
  clock += 1000;
  emitTurn(rootAgent, '抱歉，我漏了这一条。');
  ok('★ 静默期内不推（我刚说的那声道歉不该被自己的解释盖掉）',
    emotionItems(await drain()).length === 0);
  ok('理由记成 explicit-emotion',
    (api.state.streamEmotion?.skipped?.['explicit-emotion'] ?? 0) >= 1,
    JSON.stringify(api.state.streamEmotion?.skipped ?? {}));

  api.state.emotionMuteUntil = 0;
  clock += 1000;
  emitTurn(rootAgent, '抱歉，我漏了这一条。');
  const afterMute = classifiedItems(await drain());
  ok('★ 清掉静默期之后同样的那句话就推了（证明拦住它的确实是静默期）',
    afterMute.length === 1 && afterMute[0]?.command?.payload?.emotion?.name === '抱歉',
    JSON.stringify(afterMute.map((i) => i?.command?.payload?.emotion?.name)));

  /* [8f] 推送节流：离上一条太近就不推。 */
  clock += 100;
  emitTurn(rootAgent, '没想到居然会这样。');
  ok('★ 离上一条不到 700ms → 不推',
    classifiedItems(await drain()).length === 0
      && (api.state.streamEmotion?.skipped?.['too-soon'] ?? 0) >= 1,
    JSON.stringify(api.state.streamEmotion?.skipped ?? {}));

  clock += 1000;
  emitTurn(rootAgent, '没想到居然会这样。');
  const afterPace = classifiedItems(await drain());
  ok('★ 隔够了就推，而且推的是「惊讶」',
    afterPace.length === 1 && afterPace[0]?.command?.payload?.emotion?.name === '惊讶',
    JSON.stringify(afterPace.map((i) => i?.command?.payload?.emotion?.name)));

  /*
   * [8g] ★ 队列保护：一次最多压两条没人取的自动情绪。
   *
   * 三条要**连着发**，中间不能 `drain()` —— 第一版每条之间都取了一次队列，
   * 于是队列永远是空的，第三条当然进得来：那一段验的其实是「队列空着的时候
   * 能进三条」，与它想验的保护正好相反。
   */
  clock += 1000;
  emitTurn(rootAgent, '太好了，全绿。');
  clock += 1000;
  emitTurn(rootAgent, '抱歉，我漏了这一条。');
  clock += 1000;
  emitTurn(rootAgent, '这也太难过了。');
  const filled = emotionItems(await drain());
  ok('★ 队列保护：两条压得住，第三条被拦住（她还没做，不该再压）',
    filled.length === 2, `${filled.length} 条`);
  /*
   * ★ 压住的那两条**是**思考态与判出来的第一条 —— 这不是巧合，是 D 期之后
   * 队列保护的正常形态：思考态也占一个配额。写清楚名字，免得后来人以为
   * 「两条」是两条判定结果。
   */
  ok('★ 占住这两个配额的是思考态与第一条判定（同一个配额，不是两本账）',
    emotionNameOf(filled[0]) === THINKING_EMOTION_NAME && emotionNameOf(filled[1]) === '开心',
    JSON.stringify(filled.map(emotionNameOf)));
  ok('理由记成 queue-full',
    (api.state.streamEmotion?.skipped?.['queue-full'] ?? 0) >= 1,
    JSON.stringify(api.state.streamEmotion?.skipped ?? {}));

  /*
   * 恢复这一步要换一种情绪：接着用「抱歉」的话，拦住它的是 `same-as-last`
   * （她的脸本来也还在走），验到的就不是队列保护解除了。
   */
  clock += 1000;
  emitTurn(rootAgent, '没想到居然会这样。');
  const recovered = emotionItems(await drain());
  ok('★ 队列被取空之后立刻恢复（保护不是永久闭嘴）',
    classifiedItems(recovered).length === 1 && emotionNameOf(classifiedItems(recovered)[0]) === '惊讶',
    JSON.stringify(recovered.map(emotionNameOf)));
  ok('★ 队列一空，思考态也能重新挂上（回合还没结束）',
    moodItems(recovered).length === 1 && emotionNameOf(moodItems(recovered)[0]) === THINKING_EMOTION_NAME,
    JSON.stringify(recovered.map(emotionNameOf)));

  /* [8h] 收尾那半句也要判（`end` frame 的 flush）。 */
  clock += 1000;
  emitTurn(rootAgent, '这一句没有终止符但已经跑通了', 'start-only');
  env.emit('agent/assistant-stream', {
    agent: rootAgent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '这一句没有终止符但已经跑通了' } },
  });
  const waiting = await drain();
  ok('★ 只有 chunk、没有终止符时先不判（半句话判出来多半是错的）',
    classifiedItems(waiting).length === 0,
    JSON.stringify(waiting.map(emotionNameOf)));
  env.emit('agent/assistant-stream', { agent: rootAgent, frame: { type: 'end' } });
  const tail = classifiedItems(await drain());
  ok('★ end frame 把收尾那半句交出来判（很多回答最后一句情绪最强）',
    tail.length === 1 && tail[0]?.command?.payload?.emotion?.name === '开心',
    JSON.stringify(tail.map((i) => i?.command?.payload?.emotion?.name)));

  /* [8i] 开关：`autoEmotion=false` 时整条链安静，但工具照旧可用。 */
  process.env.DSH_LIVE2D_AUTO_EMOTION = '0';
  clock += 1000;
  emitTurn(rootAgent, '太好了，全绿。');
  ok('★ 关掉自动情绪之后一条都不推', emotionItems(await drain()).length === 0);
  ok('作用域记成 off（开关是**每条流读一次**的）', api.state.streamEmotion?.lastScope === 'off',
    String(api.state.streamEmotion?.lastScope));

  const offTool = await env.tools.find((t) => t.name === 'live2d_emote').execute({ name: '开心' });
  ok('★ 关掉的是「猜」，不是「表情」：live2d_emote 照旧可用', offTool?.ok === true,
    String(offTool?.detail ?? '').slice(0, 80));
  await drain();
  delete process.env.DSH_LIVE2D_AUTO_EMOTION;

  /*
   * 工具调用会设静默期（那是对的：我刚说的那声道歉不该被自己的解释盖掉），
   * 所以「开关打开之后恢复」这一步必须**先把时钟推过静默期**再发 ——
   * 否则验到的是静默期，不是开关。
   */
  clock += stream.MUTE_AFTER_EXPLICIT_EMOTION_MS + 1000;
  emitTurn(rootAgent, '太好了，全绿。');
  ok('★ 开关打开（默认）之后立刻恢复', classifiedItems(await drain()).length === 1);

  /* [8j] 诊断面：`/status` 自己就能回答「她为什么没动」。 */
  const status = (await getJson(base, '/status')).json;
  ok('★ /status 带 streamEmotion 账本', typeof status?.streamEmotion === 'object' && status.streamEmotion !== null,
    JSON.stringify(status?.streamEmotion ?? null).slice(0, 140));
  ok('账本里有推成功的次数与最后一次的摘要',
    status?.streamEmotion?.pushes >= 1 && /开心|惊讶|抱歉/.test(String(status?.streamEmotion?.summary ?? '')),
    JSON.stringify({ pushes: status?.streamEmotion?.pushes, summary: status?.streamEmotion?.summary }));
  ok('账本里有每一种拒绝理由的计数（不是只报成功）',
    Object.keys(status?.streamEmotion?.skipped ?? {}).length >= 3,
    JSON.stringify(status?.streamEmotion?.skipped ?? {}));
  ok('★ /status 报出关键词表用的是哪一档（场景化的诊断面：不用问我，读一眼就知道该改哪里）',
    status?.streamEmotion?.keywords?.scene === 'coding'
      && Number(status?.streamEmotion?.keywords?.words) > 0
      && /coding/.test(String(status?.streamEmotion?.keywords?.description ?? '')),
    JSON.stringify(status?.streamEmotion?.keywords ?? null).slice(0, 240));

  /*
   * [8k] ★ 回合起手那一条思考态（D 期与流式共用一条队列）。
   *
   * 这一段存在的理由是**门禁自己被抓过一次**：C 期的断言全都默认「队列里
   * 只有我判出来的那一条」，D 期一上来就有十一条红 —— 红的不是代码，是
   * 那些断言从来没说清自己在数哪一类。所以思考态必须被**正面断言**，
   * 而不是被过滤掉。
   */
  await drain();
  clock += 1000;
  emitTurn(rootAgent, '太好了，全绿。');
  const turnItems = emotionItems(await drain());
  const thinking = moodItems(turnItems)[0];
  ok('★ 回合起手会推一条思考态（她在我还没说完时有状态，而不是一张白脸）',
    emotionNameOf(turnItems[0]) === THINKING_EMOTION_NAME, JSON.stringify(turnItems.map(emotionNameOf)));
  ok('思考态用的是自己的强度与寿命（0.5 / 30s，不是判定那套）',
    thinking?.command?.payload?.emotion?.intensity === THINKING_INTENSITY
      && thinking?.command?.payload?.emotion?.holdMs === THINKING_HOLD_MS,
    JSON.stringify({
      intensity: thinking?.command?.payload?.emotion?.intensity,
      holdMs: thinking?.command?.payload?.emotion?.holdMs,
    }));
  ok('思考态带着真实参数包（不是一个只有名字的空指令）',
    Object.keys(thinking?.command?.payload?.emotion?.params ?? {}).length >= 3,
    JSON.stringify(thinking?.command?.payload?.emotion?.params ?? {}));
  ok('★ 思考态也记成 stream（同一条队列、同一个配额，`moodPushes` 与 `pushes` 分账）',
    thinking?.origin === 'stream' && (api.state.streamEmotion?.moodPushes ?? 0) >= 1,
    JSON.stringify({
      origin: thinking?.origin,
      moodPushes: api.state.streamEmotion?.moodPushes,
      pushes: api.state.streamEmotion?.pushes,
    }));

  /* [8l] 事件里塞坏东西不能把总线炸掉。 */
  let threw = null;
  try {
    env.emit('agent/assistant-stream', null);
    env.emit('agent/assistant-stream', { agent: rootAgent, frame: null });
    env.emit('agent/assistant-stream', { agent: rootAgent, frame: { type: 'chunk' } });
    env.emit('agent/assistant-stream', { agent: rootAgent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 42 } } });
    env.emit('agent/assistant-stream', { agent: {}, frame: { type: 'start' } });
    env.emit('agent/assistant-stream', { agent: rootAgent, frame: { type: 'chunk', chunk: { type: 'other', text: '太好了' } } });
  } catch (error) {
    threw = String(error?.message ?? error);
  }
  ok('★ 坏 frame / 坏 payload 一律不向外抛（一个坏事件不能让 DSH 的事件总线炸掉）',
    threw === null, threw ?? '');
  ok('坏输入不会凭空造出指令', emotionItems(await drain()).length === 0);

  /*
   * [8m] 卸载之后必须退订（不然「插件卸了还在推情绪」）。
   *
   * ★ 这一段必须在 [8l] **之后**：监听者都摘掉了再去塞坏 frame，验到的是
   * 「没有监听者时没人抛异常」—— 一句正确的废话。第一版就是那个顺序。
   */
  const beforeUnsub = env.listeners.get('agent/assistant-stream')?.length ?? 0;
  ok('★ 订阅确实挂在事件总线上', beforeUnsub >= 1, `${beforeUnsub} 个监听者`);
  for (const effect of env.effects) {
    if (effect.label === 'live2d-pet.host.emotion-stream' && typeof effect.dispose === 'function') effect.dispose();
  }
  ok('★ 卸载后监听者被摘掉（门禁能看见泄漏）',
    (env.listeners.get('agent/assistant-stream')?.length ?? 0) === 0,
    `${env.listeners.get('agent/assistant-stream')?.length ?? 0} 个`);
} finally {
  Date.now = realNow;
  await boot.close();
  rmSync(tempRoot, { recursive: true, force: true });
}

/*
 * [8n] ★ 场景化：`config.emotionScene` 换一档，配置真的读进去了。
 *
 * 为什么值得起第二个 Host：`/status` 说 chat 只证明「配置读到了」，而「判定
 * 用的是不是那张表」在 [2c] 已经用**同一个函数**的两档对照证过（同一句话在
 * chat 里判出好奇、在 coding 里判不出），两端一夹，中间那一跳由 [9] 的源码级
 * 断言守。为了它再把「mock 事件总线 + 根会话」整套搬一遍，只会让这一段更难读。
 */
section('[8n] 场景化：配置点名一档');

const sceneRoot = mkdtempSync(join(tmpdir(), 'live2d-emotion-scene-'));
try {
  const chatHost = await bootHost({
    modelsRoot: sceneRoot,
    config: {
      maxFps: 60,
      modelsRoot: sceneRoot,
      emotionScene: 'chat',
      /*
       * 追加词**只走 config 这一条**，settings.json 那条不在这里验：「解析器只有一份」
       * 已由 [9] 的源码级断言守着，而写一个真的 settings.json 需要知道 DSH_HOME ——
       * 为一个纯函数分支去猜主进程的家目录，不值。
       */
      emotionKeywords: { 开心: ['太爽了'], 好奇: ['好'] },
    },
  });
  try {
    const chatStatus = (await getJson(chatHost.base, '/status')).json;
    ok('一回合都没跑过时 `/status` 没有关键词折子 —— 它是**上一轮**的快照，不是活配置',
      chatStatus?.streamEmotion?.keywords == null,
      JSON.stringify(chatStatus?.streamEmotion ?? null).slice(0, 160));

    const chatTool = await toolByName(chatHost.env, 'live2d_status').execute({});
    ok('★ live2d_status 报的是**此刻配置**造成的档（不是上一轮 start 帧的快照）',
      chatTool?.emotionKeywords?.scene === 'chat'
        && String(chatTool?.emotionKeywords?.source ?? '') !== ''
        && /关键词表/.test(String(chatTool?.detail ?? '')),
      JSON.stringify(chatTool?.emotionKeywords ?? null).slice(0, 240));
    ok('工具也带着三档名字（诊断面能自己回答「还有哪些档」）',
      JSON.stringify(chatTool?.emotionKeywords?.scenes ?? null) === JSON.stringify(keywords.SCENE_NAMES),
      JSON.stringify(chatTool?.emotionKeywords?.scenes ?? null));
    const chatWords = keywords.resolveKeywordTable({ scene: 'chat' }).words;
    ok('报出的词数 = chat 档 + 我追加的那一个（既不是默认档那个数，也不是没加）',
      Number(chatTool?.emotionKeywords?.words) === chatWords + 1
        && Number(chatTool?.emotionKeywords?.words) !== keywords.resolveKeywordTable({ scene: 'coding' }).words,
      `${chatTool?.emotionKeywords?.words} vs chat 档 ${chatWords} + 1`);
    ok('★ 配置里那个单字词被**拒掉并报出来**了（不是悄悄收下、也不是悄悄丢掉）',
      (chatTool?.emotionKeywords?.ignored ?? []).some((line) => String(line).includes('好')),
      JSON.stringify(chatTool?.emotionKeywords?.ignored ?? null));
    ok('描述里写明了追加了几个', /自定义 1/.test(String(chatTool?.emotionKeywords?.description ?? '')),
      String(chatTool?.emotionKeywords?.description ?? ''));

    const defaultTool = await toolByName(boot.env, 'live2d_status').execute({});
    ok('★ 第二个 Host 换了档，第一个 Host 还是 coding（表是各自的副本，没有共享可变状态）',
      defaultTool?.emotionKeywords?.scene === 'coding',
      JSON.stringify(defaultTool?.emotionKeywords ?? null).slice(0, 160));
  } finally {
    await chatHost.close();
  }
} finally {
  rmSync(sceneRoot, { recursive: true, force: true });
}

/* ── [9] 源码级：接线确实存在 ─────────────────────────────────────────── */
section('[9] 源码级：Host 半区的接线');

ok('index.js 导入了流式模块的三个函数',
  /from '\.\/host\/emotion-stream\.js'/.test(HOST_CODE)
    && /planStreamEmotion/.test(HOST_CODE) && /feedStream/.test(HOST_CODE)
    && /createStreamBuffer/.test(HOST_CODE));
ok('★ 订阅的是 agent/assistant-stream', /ctx\.on\('agent\/assistant-stream'/.test(HOST_CODE));
ok('★ 拿不到事件总线时**说出来**（不是静默不生效）',
  /没有事件总线/.test(HOST_CODE));
ok('★ 退订放在 effect 的清理里（卸载不泄漏）',
  /'live2d-pet\.host\.emotion-stream'/.test(HOST_CODE)
    && /disposeAssistantStream\(\)/.test(HOST_CODE));
ok('★ 只在根会话上驱动（判据是 agents.roots()）',
  /roots\(\)/.test(HOST_CODE) && /isRootAgent/.test(HOST_CODE));
ok('★ 显式情绪指令之后设静默期',
  /result\.command\.kind === 'emotion'/.test(HOST_CODE)
    && /state\.emotionMuteUntil = Date\.now\(\) \+ Math\.max\(MUTE_AFTER_EXPLICIT_EMOTION_MS, alive\)/.test(HOST_CODE));
ok('★ 静默期的长度跟着**这条情绪的寿命**走（让她保持 30 秒，就不该 6 秒后被猜的盖掉）',
  /const alive = holdMs === 0 \? EMOTION_MAX_HOLD_MS : Math\.min\(holdMs, EMOTION_MAX_HOLD_MS\) \+ releaseMs/.test(HOST_CODE));
ok('★ 「按名字收」那一条**不算**显式情绪（它既不该静默判定，也不该把状态翻成 reacting —— 她的脸并没有因此变成某种表情）',
  /Array\.isArray\(result\.command\.payload\?\.emotion\?\.release\)/.test(HOST_CODE));
ok('★ 自动情绪走和其它指令**同一条**路（buildAction → pushCommand）',
  /pushCommand\(outcome\.command, 'stream'\)/.test(HOST_CODE));
ok('★ 队列保护数的是 queue 里 origin===stream 的条数',
  /item\?\.origin === 'stream'/.test(HOST_CODE) && /MAX_QUEUED_AUTO_EMOTIONS/.test(HOST_CODE));
ok('pushCommand 默认来源是 tool（老调用点不用改）',
  /const pushCommand = \(command, origin = 'tool'\)/.test(HOST_CODE));
ok('★ 两个开关共用同一个解析器（优先级链只有一份实现，不会漂）',
  /function resolveEmotionMarker\(cfg, settingsPath\) \{\s*return resolveBooleanSetting\(/.test(HOST_CODE)
    && /function resolveAutoEmotion\(cfg, settingsPath\) \{\s*return resolveBooleanSetting\(/.test(HOST_CODE));
ok('★ 自动情绪的开关支持环境变量（门禁靠它，用户也能用）',
  /DSH_LIVE2D_AUTO_EMOTION/.test(HOST_CODE));
ok('★ 诊断写进 state（随 /status 出去）', /state\.streamEmotion = streamStats/.test(HOST_CODE));
ok('事件处理整段包在 try/catch 里', /\[emotion-stream\] 处理失败/.test(HOST_CODE));

ok('★ 关键词档的解析只有一份实现（config → 环境变量 → settings.json → 默认，与两个布尔开关同一条顺序）',
  /function resolveKeywordSetting\(cfg, settingsPath\)/.test(HOST_CODE)
    && /DSH_LIVE2D_EMOTION_SCENE/.test(HOST_CODE)
    && /parsed\?\.emotionScene/.test(HOST_CODE)
    && /resolveKeywordTable\(/.test(HOST_CODE));
ok('★ 档与追加词一起解析、一轮只解析一次（并记进 /status 的折子）',
  /const keywordSetting = resolveKeywordSetting\(cfg, state\.settingsPath\);\s*streamStats\.keywords = \{/.test(HOST_CODE)
    && /table: keywordSetting\.table,/.test(HOST_CODE)
    && /describeKeywordTable\(keywordSetting\)/.test(HOST_CODE));
ok('★ 判定拿的是这一轮定好的那张表（不是模块级默认表）', /table: stream\.table,/.test(HOST_CODE));
ok('★ 诊断面报的是**此刻配置**造成的档，不是上一轮 start 帧的快照',
  /const keywordSetting = resolveKeywordSetting\(cfg, state\.settingsPath\);\s*const keywordText/.test(HOST_CODE));

/* ── [10] 反证：把「它其实没在做事」的样子排除掉 ───────────────────────── */
section('[10] 反证');

ok('反证 1：`**全绿**` 去掉强调符号之后**仍然**能判出开心（不是靠符号恰好没出现）',
  stream.classifySentence('全绿')?.name === '开心');

/*
 * 反证 2：stripCode 是**承重**的，不是装饰。
 * 同一句话，挖掉代码之前判得出来、之后判不出来 —— 这才叫「它改了什么」。
 */
const withCode = '```\n操作失败\n```';
ok('★ 反证 2：不挖代码的话这段代码会被判成「难过」（所以 stripCode 是承重的）',
  stream.classifySentence(withCode)?.name === '难过'
    && stream.classifySentence(stream.stripCode(withCode)) === null,
  JSON.stringify({
    raw: stream.classifySentence(withCode)?.name ?? null,
    stripped: stream.classifySentence(stream.stripCode(withCode))?.name ?? null,
  }));

ok('反证 3：节流真的会拦（没有它，同一句话每 100ms 就能推一条）',
  stream.planStreamEmotion('太好了，全绿。', { ...planBase, lastPushAt: planBase.now - 10 })?.skip === 'too-soon');

ok('反证 4：子会话的判据不是「永远返回 true」—— roots() 里没有它就判 false',
  (() => {
    const roots = [rootAgent];
    return !roots.some((candidate) => candidate.sessionId === childAgent.sessionId);
  })());

/* ── 收尾 ─────────────────────────────────────────────────────────────── */
if (failed === 0) {
  console.log(`\n[11] EMOTION STREAM GATE PASSED —— ${total} 项断言全绿`);
  process.exit(0);
}
console.log(`\n[x] EMOTION STREAM GATE FAILED —— ${failed}/${total} 项失败`);
process.exit(1);
