/**
 * 反向通道门禁（D-2：她「开始说 / 说完了」→ Host → 会话）。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────
 *
 * `live2d_speak` 是 fire-and-forget：工具返回「已排队」时那句话**还没出声**，
 * 更没念完。于是 AI 侧对朗读的认知只有「我刚排了一句」和「大概早念完了吧」，
 * 中间那段「她**正在**念」根本不存在 —— 而抢话、掐断、说完立刻甩头这三个毛病
 * 全都落在那一段里。
 *
 * D-2 把那段补上：朗读通道报告两个过渡（开始说 / 说完了）→
 * `src/client/speech-presence.ts` 记账 → `/status` 心跳的查询串带回 Host →
 * `lib/host/speech.js` 判新鲜度并写成运行时上下文的一行。
 *
 * 这条链**四段分居四个文件**，而每一段单独发生失效时都是静默的：
 *
 *   [1][2][3][4] 纯模块：解析、过渡时刻、新鲜度、那行字。四件都能在 node 里
 *       直接断言，所以这里逐条钉住（尤其是「没事可说时必须是空串」——
 *       那一行的存在成本是**每一步的 token**）。
 *   [5] ★ 真机链：起一个真的 Host，用真的 HTTP 把报告送进去，再读回
 *       `/status`、`live2d_status` 与注册进 `systemPrompt` 的那条 context。
 *       跨端契约（查询参数名）写错时，只有这一段会红。
 *   [6] 渲染端源码级：TS 侧跑不进 node，但「谁登记、谁发后缀、谁布线」是可读的。
 *   [7] 反证：把实现改坏，判据必须跟着翻 —— 而且改的是**真的代码**
 *       （零 import 的纯模块可以直接从 `data:` URL 重新 import，见那段注释）。
 *
 * ── 为什么「不知道」必须与「没在说」分开 ────────────────────────────────
 *
 * 这条通道的全部价值是让 AI 敢不敢开口。把「没收到字段」（旧客户端）
 * 读成「她没在说话」，AI 就会在她念到一半时抢话 —— 而这正是那个
 * 家族教训：**缺省值最危险**。所以 `parseSpeechQuery()` 对缺省返回 `null`，
 * 调用方保持原值。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootHost, getJson } from './lib/host-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..');
const PACKAGE = resolve(WORKSPACE, 'dsh-live2d-pet');

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
    return true;
  }
  failures += 1;
  console.log(`  ✘ ${label}${detail === '' ? '' : `\n      ${detail}`}`);
  return false;
}

function section(title) {
  console.log(`\n${title}`);
}

/** 门禁只看代码，不看注释 —— 注释里写着 `onSettled` 不算数。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const readSource = (rel) => readFileSync(resolve(PACKAGE, rel), 'utf8');

const speech = await import(pathToFileURL(resolve(PACKAGE, 'lib/host/speech.js')).href);
const {
  SPEECH_STALE_MS,
  SPEECH_RECENT_MS,
  SPEECH_CONTEXT_ORDER,
  SPEECH_CONTEXT_NAME,
  parseSpeechQuery,
  createSpeechState,
  mergeSpeechReport,
  speechIsFresh,
  speakingSeconds,
  describeSpeech,
  speechSummary,
} = speech;

const params = (query) => new URLSearchParams(query);

/** 造一份「正在说话」的报告。 */
const speakingReport = (over = {}) => ({
  present: true,
  speaking: true,
  queued: 0,
  started: 1,
  settled: 0,
  ...over,
});

/* ───────────────── [1] 导出契约与常量 ───────────────── */

section('[1] 导出契约与常量');

ok('十一个导出都在', [
  SPEECH_STALE_MS, SPEECH_RECENT_MS, SPEECH_CONTEXT_ORDER, SPEECH_CONTEXT_NAME,
  parseSpeechQuery, createSpeechState, mergeSpeechReport, speechIsFresh,
  speakingSeconds, describeSpeech, speechSummary,
].every((value) => value !== undefined));

/*
 * 陈旧阈值必须**容得下漏拍**：心跳平时 5 秒一拍（说话时 500ms），
 * 一拍的抖动不该让「她还在说」变成「不知道」。10 秒 = 至少漏两拍才作废。
 */
ok('陈旧阈值容得下至少两次漏拍', SPEECH_STALE_MS >= 10000 && SPEECH_STALE_MS <= 60000,
  `SPEECH_STALE_MS=${SPEECH_STALE_MS}`);
ok('「刚说完」的窗口不短于陈旧阈值',
  SPEECH_RECENT_MS >= SPEECH_STALE_MS && SPEECH_RECENT_MS <= 600000,
  `SPEECH_RECENT_MS=${SPEECH_RECENT_MS}`);
/*
 * 排序位：DSH 自有的三条运行时上下文是 110（沙箱）/ 115（审批）/ 120（子 agent），
 * 插件的事实应当排在它们**之后** —— 策略是框架定的，状态是插件报的。
 */
ok('排序位排在 DSH 自有上下文之后（>120）',
  Number.isFinite(SPEECH_CONTEXT_ORDER) && SPEECH_CONTEXT_ORDER > 120,
  `SPEECH_CONTEXT_ORDER=${SPEECH_CONTEXT_ORDER}`);
ok('上下文名字带插件前缀（不会撞上别人的名字）',
  typeof SPEECH_CONTEXT_NAME === 'string' && SPEECH_CONTEXT_NAME.includes('live2d-pet'),
  SPEECH_CONTEXT_NAME);

const empty = createSpeechState();
ok('空账本：不知道、没在说、零计数',
  empty.known === false && empty.speaking === false && empty.reports === 0
  && empty.started === 0 && empty.settled === 0 && empty.reloads === 0);

/* ───────────────── [2] 解析查询串 ───────────────── */

section('[2] 解析：缺省 ≠ 没在说');

ok('★ 没有 speech 字段 → null（旧客户端，调用方不许动账本）',
  parseSpeechQuery(params('build=abc&stage=1')) === null);
ok('★ 有 speech=1 但缺 speechState → 也是 null（半个报告不算报告）',
  parseSpeechQuery(params('speech=1&speechStarted=1')) === null);
ok('speech=2 / speech=yes 都不认', parseSpeechQuery(params('speech=2')) === null
  && parseSpeechQuery(params('speech=yes')) === null);

const offReport = parseSpeechQuery(params('speech=0'));
ok('speech=0 → 一次真实的报告：没在说（不是「不知道」）',
  offReport !== null && offReport.present === false);

const onReport = parseSpeechQuery(params(
  'speech=1&speechState=speaking&speechQueued=2&speechStarted=5&speechSettled=3',
));
ok('speech=1 的五个字段都读到了',
  onReport !== null && onReport.present === true && onReport.speaking === true
  && onReport.queued === 2 && onReport.started === 5 && onReport.settled === 3,
  JSON.stringify(onReport));
ok('idle 是明确的「没在说」（与 speaking 对称）',
  parseSpeechQuery(params('speech=1&speechState=idle'))?.speaking === false);
ok('坏数字归零而不是 NaN（一个 NaN 会污染整条链）',
  (() => {
    const bad = parseSpeechQuery(params('speech=1&speechState=idle&speechQueued=abc&speechSettled=-4'));
    return bad.queued === 0 && bad.settled === 0;
  })());

/* ───────────────── [3] 过渡时刻记在 Host 的钟上 ───────────────── */

section('[3] 过渡时刻：谁开始的、谁结束的、什么时候');

const t1 = mergeSpeechReport(createSpeechState(), speakingReport({ queued: 1 }), 1000);
ok('第一次收到「正在说」→ 记下开始时刻（Host 的 now）',
  t1.known === true && t1.speaking === true && t1.since === 1000 && t1.settledAt === 0);

const t1b = mergeSpeechReport(t1, speakingReport({ queued: 1 }), 4000);
ok('★ 状态没变的那一拍不刷新开始时刻（否则「念了多久」永远接近 0）',
  t1b.since === 1000 && t1b.reports === 2, `since=${t1b.since}`);

const t2 = mergeSpeechReport(t1b, speakingReport({ speaking: false, settled: 1 }), 6000);
ok('「说完了」→ 记下结束时刻、清掉开始时刻',
  t2.speaking === false && t2.settledAt === 6000 && t2.since === 0);

const t3 = mergeSpeechReport(t2, speakingReport({ started: 2 }), 9000);
ok('再次开口 → 开始时刻跟着更新', t3.speaking === true && t3.since === 9000);

const t4 = mergeSpeechReport(t3, speakingReport({ started: 1, settled: 0 }), 12000);
ok('★ 计数器回退 = 页面重载：记一笔 reloads，并把时刻全部重置',
  t4.reloads === 1 && t4.since === 12000 && t4.settledAt === 0,
  `reloads=${t4.reloads} since=${t4.since} settledAt=${t4.settledAt}`);

const t5 = mergeSpeechReport(t4, null, 20000);
ok('null 报告（缺省）原样返回 —— 不动账本', t5 === t4);

const t6 = mergeSpeechReport(t4, offReport, 21000);
ok('speech=0 → 明确地没在说，且排队清零',
  t6.speaking === false && t6.queued === 0 && t6.known === true);
ok('mergeSpeechReport(null, …) 不炸（第一次报告之前）',
  mergeSpeechReport(null, speakingReport(), 100).speaking === true);

/* ───────────────── [4] 新鲜度与那一行字 ───────────────── */

section('[4] 新鲜度：陈旧即沉默');

const live = mergeSpeechReport(createSpeechState(), speakingReport({ queued: 2 }), 100000);
ok('刚收到的报告是新鲜的', speechIsFresh(live, 100000 + SPEECH_STALE_MS) === true);
ok('★ 超过阈值就不新鲜了（关掉的标签页不许让「她还在说」永远成立）',
  speechIsFresh(live, 100000 + SPEECH_STALE_MS + 1) === false);
ok('从没收到过报告 → 不新鲜（而不是「没在说」）',
  speechIsFresh(createSpeechState(), 1) === false && speechIsFresh(null, 1) === false);
ok('说话秒数按 Host 的钟算', Math.abs(speakingSeconds(live, 103000) - 3) < 1e-9);

const speakLine = describeSpeech(live, 102500);
ok('正在说话 → 有一行字，含秒数与可操作的下一步',
  speakLine.includes('正在说话') && speakLine.includes('2.5') && speakLine.includes('live2d_stop_speaking'),
  speakLine);
ok('排队数会说出来（AI 才知道还要等几句）', speakLine.includes('还排着 2 句'), speakLine);
/*
 * 排队为零时不该提「还排着」——夹具必须是「正在说、但队列是空的」那一份：
 * 直接拿 `live`（它排队 2 句）来断言，测的是它自己刚说过的那句话。
 */
const solo = mergeSpeechReport(createSpeechState(), speakingReport({ queued: 0 }), 100000);
ok('没排队时不提「还排着」',
  !describeSpeech(solo, 101000).includes('还排着'), describeSpeech(solo, 101000));

const justDone = mergeSpeechReport(live, speakingReport({ speaking: false, settled: 1 }), 110000);
const doneLine = describeSpeech(justDone, 113000);
ok('刚说完 → 有一行字，含「刚念完」与秒数',
  doneLine.includes('刚念完') && doneLine.includes('3.0'), doneLine);
ok('★ 说完太久 → 空串（零 token：装配器会把空文本整条丢掉）',
  describeSpeech(justDone, 110000 + SPEECH_RECENT_MS + 1) === '');
ok('★ 陈旧 → 空串（宁可不说，也不说一句可能已经过期的话）',
  describeSpeech(live, 100000 + SPEECH_STALE_MS + 1) === '');
ok('★ 从没说过话 / 从没收到报告 → 空串',
  describeSpeech(createSpeechState(), 1) === '' && describeSpeech(null, 1) === '');
ok('这一行有长度上限（它是每一步都要装配的提示词）',
  speakLine.length <= 200 && doneLine.length <= 200,
  `speak=${speakLine.length} done=${doneLine.length}`);

section('[4b] 诊断面那一行：不知道也要说出来');

const summaryUnknown = speechSummary(createSpeechState(), 1);
const summaryStale = speechSummary(live, 100000 + SPEECH_STALE_MS + 1);
const summaryLive = speechSummary(live, 101000);
const summaryDone = speechSummary(justDone, 112000);
const summaryIdle = speechSummary(createSpeechState(), 1);
ok('★ 五个处境各有一句非空的话（诊断面没有「沉默」这个选项）',
  [summaryUnknown, summaryStale, summaryLive, summaryDone, summaryIdle].every((line) => typeof line === 'string' && line.length > 0),
  JSON.stringify([summaryUnknown, summaryStale, summaryLive, summaryDone, summaryIdle]));
ok('未知与过期说的是不同的话',
  summaryUnknown !== summaryStale && summaryUnknown.includes('未知') && summaryStale.includes('过期'),
  `${summaryUnknown} / ${summaryStale}`);
ok('正在说话那一句带秒数', summaryLive.includes('正在说话') && summaryLive.includes('1.0'), summaryLive);
ok('说完那一句带句号数（对账用）', summaryDone.includes('第 1 句'), summaryDone);

/* ───────────────── [5] ★ 真机链 ───────────────── */

section('[5] ★ 真机链：查询串 → 账本 → 状态工具 → 运行时上下文');

const modelsRoot = await mkdtemp(join(tmpdir(), 'l2d-speech-'));
/** 假的 `systemPrompt` 服务：只记账，不装配真的提示词。 */
const contextSpecs = [];
let contextDisposed = 0;
const fakeSystemPrompt = {
  context(spec) {
    contextSpecs.push(spec);
    return () => {
      contextDisposed += 1;
    };
  },
};

const host = await bootHost({ modelsRoot, services: { systemPrompt: fakeSystemPrompt } });
const { base, env } = host;

try {
  /*
   * 现在是**两条**上下文：朗读状态（D-2）与对话提示（§13.36）。
   * 两条都靠「不在场时返回空串」来做到零 token —— 所以这里按名字挑，
   * 而不是按下标取第一个（下标会随注册顺序变化，而名字是契约）。
   */
  ok('插件注册了两条运行时上下文（朗读状态 + 对话提示）', contextSpecs.length === 2,
    `注册了 ${contextSpecs.length} 条`);
  const spec = contextSpecs.find((item) => item?.name === SPEECH_CONTEXT_NAME) ?? {};
  ok('上下文用的是契约里的名字与排序位',
    spec.name === SPEECH_CONTEXT_NAME && spec.order === SPEECH_CONTEXT_ORDER,
    `${spec.name}@${spec.order}`);
  ok('上下文没装任何东西时那一行是空串（零 token）',
    typeof spec.text === 'function' && spec.text() === '', String(spec.text?.()));

  /*
   * 第一拍：她开口了 —— 带队列深度与两个计数器。
   * 注意 `build=` 也在（渲染进程的心跳一定带它），因为那才是真实客户端的形状。
   */
  await getJson(base, '/status?build=gate-speech&speech=1&speechState=speaking&speechQueued=1&speechStarted=1&speechSettled=0');
  const speakingStatus = (await getJson(base, '/status?build=gate-speech&speech=1&speechState=speaking&speechQueued=1&speechStarted=1&speechSettled=0')).json;
  ok('/status 里带着朗读账本', speakingStatus?.speech?.speaking === true,
    JSON.stringify(speakingStatus?.speech));
  ok('★ 上下文那一行活了，而且说的是「正在说话」',
    spec.text().includes('正在说话') && spec.text().includes('还排着 1 句'), spec.text());

  const sinceAfterFirst = speakingStatus.speech.since;
  await getJson(base, '/status?build=gate-speech&speech=1&speechState=speaking&speechQueued=1&speechStarted=1&speechSettled=0');
  const second = (await getJson(base, '/status?build=gate-speech&speech=1&speechState=speaking&speechQueued=1&speechStarted=1&speechSettled=0')).json;
  ok('★ 连着三拍「正在说」→ 开始时刻一直是第一拍那个（没有每拍重置）',
    second.speech.since === sinceAfterFirst && second.speech.reports >= 3,
    `since=${second.speech.since}（第一拍 ${sinceAfterFirst}）reports=${second.speech.reports}`);

  const speechTool = env.tools.find((t) => t.name === 'live2d_status');
  /*
   * ★ 括号是承重的：`await speechTool.execute({})?.detail` 会把 `?.` 挂在
   * **Promise** 上（await 的优先级低于成员访问），于是得到 `undefined` —— 而
   * `String(undefined ?? '')` 是一个安安静静的空串，这条断言会以「没读到」
   * 的样子失败，看上去像产品坏了。必须先 await，再取字段。
   */
  const speakingDetail = String((await speechTool.execute({}))?.detail ?? '');
  ok('★ `live2d_status` 的 detail 里能读到朗读状态（按需入口）',
    speakingDetail.includes('正在说话'), speakingDetail.split('，').slice(-2).join('，'));

  /* 第二拍：她说完了。 */
  await getJson(base, '/status?build=gate-speech&speech=1&speechState=idle&speechQueued=0&speechStarted=1&speechSettled=1');
  const doneStatus = (await getJson(base, '/status?build=gate-speech&speech=1&speechState=idle&speechQueued=0&speechStarted=1&speechSettled=1')).json;
  ok('账本记下了结束时刻', doneStatus.speech.speaking === false && doneStatus.speech.settledAt > 0,
    JSON.stringify(doneStatus.speech));
  ok('★ 上下文那一行跟着变成「刚念完」（每步现算，不是缓存的字符串）',
    spec.text().includes('刚念完'), spec.text());
  const doneDetail = String((await speechTool.execute({}))?.detail ?? '');
  ok('status 里报出「念完第 1 句」', doneDetail.includes('第 1 句'), doneDetail.split('，').slice(-1)[0]);

  /* 第三拍：缺省字段 —— 账本一个字都不许动。 */
  const before = JSON.stringify((await getJson(base, '/status?build=gate-speech')).json?.speech);
  await getJson(base, '/status?build=gate-speech');
  await getJson(base, '/status');
  const after = JSON.stringify((await getJson(base, '/status')).json?.speech);
  ok('★ 不带 speech 字段的心跳（旧客户端 / curl）不动账本', before === after,
    `前 ${before}\n      后 ${after}`);

  /* 第四拍：计数器回退 = 页面重载。 */
  await getJson(base, '/status?build=gate-speech&speech=1&speechState=idle&speechQueued=0&speechStarted=0&speechSettled=0');
  const reloaded = (await getJson(base, '/status')).json;
  /*
   * 重载把**所有**时刻一起清掉（`settledAt` 也归零），这不是遗漏而是结论：
   * 页面重载就地把朗读掐断了，此刻「她上一句是什么时候念完的」没有任何证据 ——
   * 留着一个重载前的时刻，只会让那一行字继续以旧证据说话。
   */
  ok('★ 计数器回退被记成一次重载，且所有时刻一起归零（而不是一个凭空的「念了 90 秒」）',
    reloaded.speech.reloads === 1 && reloaded.speech.settledAt === 0 && reloaded.speech.since === 0,
    JSON.stringify(reloaded.speech));
  ok('重载之后上下文那一行不再声称「刚念完」（时刻被重置了）',
    !spec.text().includes('刚念完') || spec.text() === '', spec.text());

  /* 第五拍：speech=0 —— 新客户端从没念过。 */
  await getJson(base, '/status?build=gate-speech&speech=0');
  const neverSpoke = (await getJson(base, '/status')).json;
  ok('speech=0 → 没在说、排队清零、但仍然「知道」',
    neverSpoke.speech.speaking === false && neverSpoke.speech.queued === 0 && neverSpoke.speech.known === true);

  /* 卸载：两条上下文都必须退订 —— 否则插件卸载后还挂在每次装配上。 */
  await host.close();
  ok('★ 卸载时退订了运行时上下文（两条都退干净，没有泄漏）', contextDisposed === 2,
    `disposed=${contextDisposed}`);
} finally {
  await host.close().catch(() => {});
  await rm(modelsRoot, { recursive: true, force: true }).catch(() => {});
}

/* ───────────────── [6] 渲染端接线（源码级）───────────────── */

section('[6] 渲染端接线：谁登记、谁发后缀、谁布线');

const presenceSource = readSource('src/client/speech-presence.ts');
const presenceCode = stripComments(presenceSource);
const laneSource = readSource('src/client/speech-lane.ts');
const laneCode = stripComments(laneSource);
const pluginSource = readSource('src/client/plugin.ts');
const pluginCode = stripComments(pluginSource);
const hostSource = readSource('lib/index.js');

ok('speech-presence.ts 零 import（门禁能直接跑它）',
  !/^\s*import\s/m.test(presenceCode), '出现了 import');
ok('★ speech-presence.ts 不读时钟（时刻必须由调用方给，否则门禁无法确定性地跑）',
  !/Date\.now\(/.test(presenceCode));
ok('speech-presence.ts 不碰 DOM / React',
  !/document\.|window\.|React|useState|useEffect/.test(presenceCode));
ok('四个导出都在（登记开始、登记结束、读账本、拼后缀）',
  /export function noteSpeechStart\(/.test(presenceCode)
  && /export function noteSpeechSettled\(/.test(presenceCode)
  && /export function getSpeechPresence\(/.test(presenceCode)
  && /export function speechQuerySuffix\(/.test(presenceCode));

/*
 * ── ★ 真的把那条串跑一遍 ──
 *
 * 上面几条是「读源码」，回答的是「谁登记、谁拼后缀」；下面这一段回答的是一个
 * 完全不同的问题：**拼出来的那个串，Host 读得懂吗**。
 *
 * 这条链的两半是两个人各写一半的 —— TS 侧拼 `&speech=1&speechState=…`，
 * JS 侧用 `parseSpeechQuery()` 读回来。两半在各自的源码里都「看着对」，
 * 而它们之间的那个字符串在本轮之前**从来没有被真的搬过一次**（§10 第 2 条）：
 * 字段名差一个字母、`current === null` 那条分支写反、排队深度忘了带，
 * 症状全都是「AI 偶尔抢话」—— 一个不会被任何告警抓到、只会被当成性格问题的症状。
 *
 * 所以这里的判据不是「源码里有这句」，而是 `speechQuerySuffix()` 的返回值
 * 交给 `parseSpeechQuery()` 之后**读出来的东西对不对**。
 */
const presence = await import(pathToFileURL(resolve(PACKAGE, 'lib/test/speech-presence.mjs')).href);

presence.resetSpeechPresence();
const neverSaid = presence.speechQuerySuffix(0);
ok('★ 一次都没登记过 → `&speech=0`（缺省值是「不知道」，不是「没在说」）',
  neverSaid === '&speech=0', neverSaid);
ok('★ 而且这个串交给 Host 读，读出来是一次真实的「没在说」报告（不是 null）',
  (() => {
    const report = parseSpeechQuery(new URLSearchParams(neverSaid.slice(1)));
    return report !== null && report.present === false;
  })(), JSON.stringify(parseSpeechQuery(new URLSearchParams(neverSaid.slice(1)))));

presence.noteSpeechStart(111);
const sayingFirst = presence.speechQuerySuffix(3);
const firstReport = parseSpeechQuery(new URLSearchParams(sayingFirst.slice(1)));
ok('★ 「开始说」之后拼出来的串，Host 读出来是「正在说」+ 排队 3 句',
  firstReport !== null && firstReport.present === true && firstReport.speaking === true
  && firstReport.queued === 3 && firstReport.started === 1 && firstReport.settled === 0,
  `${sayingFirst} → ${JSON.stringify(firstReport)}`);
ok('账本本身读得回来（面板与门禁看的是同一份）',
  (() => {
    const snapshot = presence.getSpeechPresence();
    return snapshot !== null && snapshot.speaking === true && snapshot.since === 111 && snapshot.started === 1;
  })(), JSON.stringify(presence.getSpeechPresence()));

presence.noteSpeechStart(222);
presence.noteSpeechSettled(333);
const afterSettled = parseSpeechQuery(new URLSearchParams(presence.speechQuerySuffix(0).slice(1)));
ok('★ 「说完了」之后：读出来是「没在说」、`settled` 涨到 1、排队归零',
  afterSettled !== null && afterSettled.speaking === false && afterSettled.settled === 1
  && afterSettled.queued === 0 && afterSettled.started === 2,
  JSON.stringify(afterSettled));
ok('★ 说完了不把 `started` 抹掉（「一共念了几句」要能数到）',
  afterSettled.started === 2, `started=${afterSettled?.started}`);
ok('★ 排队深度是**每次现给**的（不进账本：账本里的旧数会让 Host 一直以为还有几句在后面）',
  parseSpeechQuery(new URLSearchParams(presence.speechQuerySuffix(7).slice(1))).queued === 7);

presence.resetSpeechPresence();
ok('注销之后回到「从来没说过」那一档（门禁之间不残留）',
  presence.speechQuerySuffix(0) === '&speech=0'
  && parseSpeechQuery(new URLSearchParams(presence.speechQuerySuffix(0).slice(1))).present === false);

/*
 * ★ 跨端契约：查询参数名两边各写一遍（Host 是 JS、渲染端是 TS，没有共享类型）。
 * 一侧改名而另一侧没改 = 静默失效：Host 会把「正在说」读成「不知道」，而
 * 表现只是「AI 偶尔抢话」。所以这里逐字对账。
 */
const WIRE_FIELDS = ['speech=', 'speechState=', 'speechQueued=', 'speechStarted=', 'speechSettled='];
const speechJsSource = stripComments(readSource('lib/host/speech.js'));
const missingWire = WIRE_FIELDS.filter((field) => {
  const key = field.slice(0, -1);
  return !presenceSource.includes(`&${field}`) || !speechJsSource.includes(`'${key}'`);
});
ok('★ 五个查询参数名在两侧逐字一致', missingWire.length === 0,
  `不一致：${missingWire.join(' / ')}`);

ok('speech-lane：两个生命周期钩子在接口里声明了',
  /onStart\?\(request: SpeechRequest\): void;/.test(laneCode)
  && /onSettled\?\(request: SpeechRequest\): void;/.test(laneCode));
ok('★ 钩子调用被 try/catch 包住（记一次账失败不该让通道停摆）',
  /const notify = \(/.test(laneCode) && /catch \(error\) \{\s*report\(error\);/.test(laneCode));
/*
 * ★ 落笔顺序是承重的：`onStart` 必须在 `waitUntilDone()` **之前**、
 * `onSettled` 在它**之后**。反过来的话，AI 会在她还没出声时就以为她在念，
 * 而「念完了」会提早一整句到达。
 */
const pumpStart = laneCode.indexOf('async function pump(');
const pumpBody = pumpStart === -1 ? '' : laneCode.slice(pumpStart);
const iStart = pumpBody.indexOf('notify(hooks.onStart, request)');
const iWait = pumpBody.indexOf('await hooks.waitUntilDone()');
const iSettled = pumpBody.indexOf('notify(hooks.onSettled, request)');
ok('★ pump 里的顺序：onStart < waitUntilDone < onSettled',
  iStart !== -1 && iWait !== -1 && iSettled !== -1 && iStart < iWait && iWait < iSettled,
  `onStart=${iStart} waitUntilDone=${iWait} onSettled=${iSettled}`);
ok('★ 被叫停的那条路不记「开始」（没出声就没什么可结束的）',
  iStart !== -1 && pumpBody.indexOf('if (isCancelled()) continue;') < iStart);

ok('plugin.ts 导入了反向通道的四个名字',
  /getSpeechPresence/.test(pluginCode) && /noteSpeechSettled/.test(pluginCode)
  && /noteSpeechStart/.test(pluginCode) && /speechQuerySuffix/.test(pluginCode));
ok('★ 朗读通道的两个过渡点接在 `createSpeechLane` 上',
  /onStart: \(\) => noteSpeechStart\(Date\.now\(\)\)/.test(pluginCode)
  && /onSettled: \(\) => noteSpeechSettled\(Date\.now\(\)\)/.test(pluginCode));
const statusUrl = pluginCode.split('\n').find((line) => line.includes('/status?build=')) ?? '';
ok('★ `/status` 心跳带上了朗读后缀（这条链的出口就在这里）',
  statusUrl.includes('speechQuerySuffix('), statusUrl.trim());
ok('排队深度取的是通道的实时值（不是账本里的旧数）',
  /speechQuerySuffix\(sharedLane === null \? 0 : sharedLane\.queued\(\)\)/.test(pluginCode));
ok('★ 她说话时心跳变快（否则「说完了」最多迟到 5 秒）',
  /SPEECH_STATUS_POLL_MS/.test(pluginCode)
  && /getSpeechPresence\(\)\?\.speaking === true/.test(pluginCode)
  && /fast \? SPEECH_STATUS_POLL_MS : intervalMs/.test(pluginCode));

ok('lib/index.js：导入了 speech.js 的六个名字',
  /from '\.\/host\/speech\.js'/.test(hostSource)
  && /parseSpeechQuery/.test(hostSource) && /mergeSpeechReport/.test(hostSource)
  && /describeSpeech/.test(hostSource) && /speechSummary/.test(hostSource));
ok('★ 心跳里解析报告，并且只在那时才推进账本',
  /const speechReport = parseSpeechQuery\(url\.searchParams\)/.test(hostSource)
  && /if \(speechReport !== null\)/.test(hostSource)
  && /state\.speech = mergeSpeechReport\(state\.speech, speechReport, Date\.now\(\)\)/.test(hostSource));
ok('★ 注册了运行时上下文（每步现算），并且退订挂在 effect 上',
  /systemPrompt\.context\(\{/.test(hostSource)
  && /text: \(\) => describeSpeech\(state\.speech, Date\.now\(\)\)/.test(hostSource)
  && /live2d-pet\.host\.speech-context/.test(hostSource));
ok('没有 systemPrompt 服务时只记日志、不拦（宿主可能没装那个包）',
  /没有 systemPrompt 服务/.test(hostSource) && /\[speech\]/.test(hostSource));
ok('`live2d_status` 的 detail 里有朗读状态',
  /speechSummary\(state\.speech, Date\.now\(\)\)/.test(hostSource));
ok('账本进了 `state`（所以 `/status` 免费带上它）',
  /speech: createSpeechState\(\),/.test(hostSource));

/* ───────────────── [7] 反证：改坏实现，判据必须翻 ───────────────── */

section('[7] 反证：把实现改坏，判据必须翻');

/*
 * ★ 这里的反证比「字符串判据」强一档：`speech.js` 是零 import 的纯模块，
 * 所以可以把它**改过的源码**直接当一个 `data:` URL 模块 import 回来跑。
 * 于是「改坏之后行为真的变了」是被执行过的，而不是被正则猜出来的。
 * （文件系统一个字节都没动。）
 */
async function reimport(mutatedSource, tag) {
  const url = `data:text/javascript;base64,${Buffer.from(mutatedSource).toString('base64')}#${tag}`;
  return import(url);
}

const speechSource = readFileSync(resolve(PACKAGE, 'lib/host/speech.js'), 'utf8');
/*
 * ★ 两笔账分开记。
 *
 * `reversed` 记「改坏之后判据确实翻了」——那是**成功**，是这一段存在的目的；
 * `unmoved` 记「改坏没生效」（替换没匹配上、或者夹具没落在被改的那一行）。
 * 一开始我只留了一个数组、把成功也写进去，最后又断言它是空的 —— 于是六条
 * 反证全部生效时，那一条总账反而变红。**成功的名字不该叫失败清单**。
 */
const reversed = [];
const unmoved = [];

// 反证 1：没事可说时也说一句话 —— 「零 token」那条判据必须翻。
{
  /*
   * ★ 钉的是**最后那个** `return ''`（「新鲜、但确实没在说、也没刚说完」那条路）。
   * 空账本走不到那里 —— 它在第一行的「不新鲜」就返回了，于是反证会安静地
   * 报「改坏没生效」；夹具必须落在被改的那一行上，`speech=0` 的一次真实报告就是。
   * 正则用 `\s` 而不是写死 `\n`：这两种换行符混进源码时，判据不该跟着变红。
   */
  const quiet = mergeSpeechReport(createSpeechState(), offReport, 2000);
  const mutated = await reimport(
    speechSource.replace(
      /return '';\s*\}\s*\/\*\*\s*\*\s*诊断面/,
      "return '她闲着。';\n}\n\n/**\n * 诊断面",
    ),
    'm1',
  );
  const realQuiet = describeSpeech(quiet, 3000) === '';
  const broken = mutated.describeSpeech(quiet, 3000) === '她闲着。';
  if (broken) reversed.push('反证 1 生效：改坏后没事可说也说话了');
  else unmoved.push('反证 1 没能改动源码（找不到那一段 return）');
  ok('反证 1：没事可说时的空串是被执行出来的，不是注释里写着的', realQuiet && broken,
    `原版 ${JSON.stringify(describeSpeech(quiet, 3000))} / 改坏 ${JSON.stringify(mutated.describeSpeech(quiet, 3000))}`);
}

// 反证 2：每拍都刷新开始时刻 —— 「不刷新」那条判据必须翻。
{
  /*
   * ★ 反证必须**整条链**都用改过的那份模块（state 与函数同源）。混着用
   * （改过的 state + 原版的函数）验的是原版的逻辑：反证会安静地报「改坏没
   * 生效」，而其实只是没跑到改坏的那一行。
   */
  const mutated = await reimport(
    speechSource.replace(
      'since: report.speaking ? (changed ? now : (before.since || now)) : 0,',
      'since: report.speaking ? now : 0,',
    ),
    'm2',
  );
  const first = mutated.mergeSpeechReport(mutated.createSpeechState(), speakingReport(), 1000);
  const later = mutated.mergeSpeechReport(first, speakingReport(), 4000);
  const broken = later.since === 4000;
  if (broken) reversed.push('反证 2 生效：改坏后开始时刻每拍被重置');
  else unmoved.push('反证 2 没能改动源码（找不到 since 那一行）');
  const real = mergeSpeechReport(live, speakingReport({ queued: 2 }), 103000);
  ok('反证 2：开始时刻不刷新是被跑出来的', broken && real.since === live.since,
    `改坏 since=${later.since} / 原版 since=${real.since}`);
}

// 反证 3：去掉新鲜度检查 —— 「陈旧即沉默」那条判据必须翻。
{
  const mutated = await reimport(
    speechSource.replace(
      'return now - speech.at <= SPEECH_STALE_MS;',
      'return true;',
    ),
    'm3',
  );
  const stale = mergeSpeechReport(mutated.createSpeechState(), speakingReport(), 1000);
  const broken = mutated.speechIsFresh(stale, 1000 + SPEECH_STALE_MS + 1) === true
    && mutated.describeSpeech(stale, 1000 + SPEECH_STALE_MS + 1) !== '';
  if (broken) reversed.push('反证 3 生效：改坏后陈旧报告仍被当成真的');
  else unmoved.push('反证 3 没能改动源码（找不到新鲜度判断）');
  ok('反证 3：陈旧作废是被跑出来的', broken && describeSpeech(live, 100000 + SPEECH_STALE_MS + 1) === '');
}

// 反证 4：把缺省当成「没在说」—— 「缺省 ≠ 没在说」那条判据必须翻。
{
  const mutated = await reimport(
    speechSource.replace(
      "if (flag !== '0' && flag !== '1') return null;",
      "if (flag !== '1') return { present: false };",
    ),
    'm4',
  );
  const broken = mutated.parseSpeechQuery(params('build=abc&stage=1')) !== null;
  if (broken) reversed.push('反证 4 生效：改坏后缺省被读成一次报告');
  else unmoved.push('反证 4 没能改动源码（找不到 flag 判断）');
  ok('反证 4：缺省返回 null 是被跑出来的', broken && parseSpeechQuery(params('build=abc&stage=1')) === null);
}

// 反证 5：把「说完了」的通知从 pump 里删掉 —— 顺序判据必须翻。
{
  const mutated = laneCode.replace('notify(hooks.onSettled, request);', '');
  const gone = !mutated.includes('notify(hooks.onSettled, request)');
  if (gone) reversed.push('反证 5 生效：改坏后 onSettled 不再被调用');
  else unmoved.push('反证 5 没能改动源码（找不到 onSettled 调用）');
  ok('反证 5：`onSettled` 的存在是可判定的', gone && iSettled !== -1);
}

// 反证 6：把「她说话时心跳变快」去掉 —— 那条判据必须翻。
{
  const mutated = pluginCode.replace('fast ? SPEECH_STATUS_POLL_MS : intervalMs', 'intervalMs');
  const gone = !/fast \? SPEECH_STATUS_POLL_MS : intervalMs/.test(mutated);
  if (gone) reversed.push('反证 6 生效：改坏后心跳不再跟着她说话变快');
  else unmoved.push('反证 6 没能改动源码（找不到三元表达式）');
  ok('反证 6：快慢切换是可判定的', gone);
}

ok('六条反证都能把对应的判据翻过来', unmoved.length === 0,
  reversed.join('；') + (unmoved.length === 0 ? '' : ` —— 没生效：${unmoved.join('；')}`));

/* 最后一步：确认上面所有「改坏」都发生在内存里。 */
const afterMutations = readFileSync(resolve(PACKAGE, 'lib/host/speech.js'), 'utf8');
ok('反证没有改动磁盘上的源码', afterMutations === speechSource
  && readFileSync(resolve(PACKAGE, 'src/client/plugin.ts'), 'utf8') === pluginSource);

console.log('');
if (failures === 0) {
  console.log(`[8] REVERSE CHANNEL GATE PASSED —— ${checks} 项断言全绿`);
} else {
  console.log(`[8] REVERSE CHANNEL GATE FAILED —— ${checks} 项断言里 ${failures} 项失败`);
  process.exitCode = 1;
}
