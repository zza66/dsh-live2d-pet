/**
 * 上报通道的账本门禁。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────
 *
 * 「她卡住了，而且一条记录都没有」查了五轮。真相不是护栏没说话，而是
 * **话送不出来**：`clientStage`（走 `/status` 查询串）抵达了、`/capabilities`
 * （走 fetch）抵达了，而 `clientErrors` 里从来没有过任何一条浏览器发来的记录
 * —— 唯一与它们不同的地方就是这个模块用了 `navigator.sendBeacon`。
 *
 * 所以这道门禁钉两件事，缺一不可：
 *
 *   1. **主路必须是 `fetch(..., { keepalive: true })`**，`sendBeacon` 只能是退路。
 *      当初反着写是为了「页面被拆掉时不被取消」，而 `keepalive` 就是为这件事
 *      设计的；反过来 `sendBeacon` 失败**没有任何回调**，返回值还被旧的实现
 *      丢掉了 —— 一个专门负责「不许静默失败」的函数，自己身上挂着最大的静默失败。
 *   2. **账本必须跟着心跳回去**（`reportQuerySuffix()`）。这是个循环，必须说清楚：
 *      通道坏掉的时候，恰恰是「它坏了」最需要送到的时候，而那时它送不到。
 *      所以账本只能走另一条已经证明能通的通道。
 *
 * 第 2 条尤其容易被后来的改动悄悄削掉（「查询串太长了，删几个字段吧」），
 * 而削掉之后的表现是**安静** —— 与一切正常完全一样。这就是它值得一道门禁的理由。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', 'dsh-live2d-pet');

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

const { reportFailure, reportQuerySuffix, reportSnapshot } = await import(
  pathToFileURL(resolve(PACKAGE, 'lib/test/report.mjs')).href
);

/* ───────────────────────── 假环境 ───────────────────────── */

const realFetch = globalThis.fetch;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

/**
 * 装一个假的 `fetch` / `navigator`，跑一段，再把环境还原。
 *
 * 还原是必须的：这几个全局在 Node 里是真的存在的东西，污染了会让后面
 * 别的门禁拿到一个奇怪的 `fetch`。
 */
async function withTransport({ fetchImpl, beacon }, body) {
  if (fetchImpl === undefined) {
    delete globalThis.fetch;
  } else {
    globalThis.fetch = fetchImpl;
  }
  if (beacon === undefined) {
    setNavigator({});
  } else {
    setNavigator({ sendBeacon: beacon });
  }
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    if (realNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', realNavigator);
  }
}

/** 记一次「调用了什么」，用来断言退路真的被走/没被走。 */
function recorder() {
  const calls = [];
  return { calls, fn: (...args) => { calls.push(args); return true; } };
}

const okFetch = (calls) => (url, init) => {
  calls.push({ url, init });
  return Promise.resolve({ ok: true, status: 200 });
};
const badFetch = (calls) => (url, init) => {
  calls.push({ url, init });
  return Promise.reject(new Error('网络挂了'));
};

const delta = (before, after, key) => after[key] - before[key];

/* ───────────────── [1] 主路：fetch + keepalive ───────────────── */

section('[1] 主路是 `fetch(..., { keepalive: true })`，而且送到之后账本要记上');

{
  const calls = [];
  const before = reportSnapshot();
  await withTransport({ fetchImpl: okFetch(calls) }, async () => {
    reportFailure('unit-main', new Error('主路正常'));
    await new Promise((r) => setImmediate(r));
  });
  const after = reportSnapshot();

  ok('真的调了 fetch', calls.length === 1, `实际 ${calls.length} 次`);
  ok('打的是 /client-error 那条路由',
    calls[0]?.url === '/.dsh-live2d-pet/client-error', String(calls[0]?.url));
  ok('用了 POST', calls[0]?.init?.method === 'POST');
  ok('★ 带了 keepalive（这是「页面被拆掉也不取消」的正解）',
    calls[0]?.init?.keepalive === true,
    '没有 keepalive 的话，选 fetch 就丢掉了当初选 sendBeacon 的那个理由，'
    + '而这不是一个可以糊过去的取舍：两者必须至少有一样在。');
  ok('请求体是 JSON 且带 scope', String(calls[0]?.init?.body).includes('"scope":"unit-main"'));
  ok('账本记了 total +1', delta(before, after, 'total') === 1);
  ok('账本记了 fetchTried +1', delta(before, after, 'fetchTried') === 1);
  ok('账本记了 fetchOk +1', delta(before, after, 'fetchOk') === 1);
  ok('账本记了 delivered +1', delta(before, after, 'delivered') === 1);
  ok('没记失败', delta(before, after, 'failed') === 0);
  ok('没动用退路', delta(before, after, 'beaconTried') === 0);
  ok('最近一条被记下来了', after.lastScope === 'unit-main' && after.lastMessage === '主路正常');
}

/* ───────────────── [2] 退路：主路失败时才走 sendBeacon ───────────────── */

section('[2] 主路失败时退到 `sendBeacon`，并且退路自称成功也算送达');

{
  const fetched = [];
  const beacons = recorder();
  const before = reportSnapshot();
  await withTransport({ fetchImpl: badFetch(fetched), beacon: beacons.fn }, async () => {
    reportFailure('unit-fallback', new Error('主路挂了'));
    await new Promise((r) => setImmediate(r));
  });
  const after = reportSnapshot();

  ok('主路试过了', delta(before, after, 'fetchTried') === 1);
  ok('★ 退路接住了：这一次算送达，不算失败',
    delta(before, after, 'failed') === 0 && delta(before, after, 'delivered') === 1,
    '`failed` 的语义是「两条路都不通」。主路失败而退路成功时记成失败，'
    + '账本就会把「其实送到了」说成「没送到」—— [3] 段才是两条路都断的那种。'
    + '（这条断言第一版写反了，是它自己把自己抓红的。）');
  ok('★ 退路被动用了', delta(before, after, 'beaconTried') === 1,
    '退路没被动用，说明主路一失败就直接放弃 —— 那正是旧实现在做的事');
  ok('退路自称成功', delta(before, after, 'beaconOk') === 1);
  ok('送达到底算数了', delta(before, after, 'delivered') === 1,
    '两条路都不通才叫失败；退路成了就该记送达，否则账本会把「其实送到了」说成「没送到」');
  ok('退路发的是同一个请求体', beacons.calls.length === 1);
}

/* ───────────────── [3] 两条路都断 = 硬结论：通道坏了 ───────────────── */

section('[3] 两条路都断掉时，账本必须能说出「通道不通」');

{
  const before = reportSnapshot();
  await withTransport({ fetchImpl: badFetch([]), beacon: () => false }, async () => {
    reportFailure('unit-dead', new Error('两条路都不通'));
    await new Promise((r) => setImmediate(r));
  });
  const after = reportSnapshot();

  ok('total 长了', delta(before, after, 'total') === 1);
  ok('delivered 没长', delta(before, after, 'delivered') === 0);
  ok('failed 长了', delta(before, after, 'failed') === 1);
  ok('退路自称失败', delta(before, after, 'beaconOk') === 0);

  const suffix = reportQuerySuffix();
  const params = new URLSearchParams(suffix.replace(/^&/, ''));
  ok('账本里 delivered 与 failed 分得开',
    params.get('rOk') === String(after.delivered) && params.get('rFail') === String(after.failed),
    `rOk=${params.get('rOk')} rFail=${params.get('rFail')}`);
}

/* ───────────────── [4] fetch 根本不存在时也要有退路 ───────────────── */

section('[4] `fetch` 不存在（老环境）时直接走退路，而不是静默什么都没发生');

{
  const beacons = recorder();
  const before = reportSnapshot();
  await withTransport({ fetchImpl: undefined, beacon: beacons.fn }, async () => {
    reportFailure('unit-nofetch', new Error('没有 fetch'));
  });
  const after = reportSnapshot();

  ok('没有去试 fetch', delta(before, after, 'fetchTried') === 0);
  ok('★ 直接走了退路', delta(before, after, 'beaconTried') === 1,
    '没有 fetch 又不去试 sendBeacon，等于这条上报凭空消失');
  ok('退路成了', delta(before, after, 'beaconOk') === 1);
}

/* ───────────────── [5] fetch 同步抛异常也不能逃出去 ───────────────── */

section('[5] `reportFailure` 永远不抛（它的职责就是不许失败升级）');

{
  let threw = null;
  const before = reportSnapshot();
  await withTransport({
    fetchImpl: () => { throw new Error('同步就炸了'); },
    beacon: recorder().fn,
  }, async () => {
    try {
      reportFailure('unit-throw', new Error('同步抛'));
    } catch (error) {
      threw = error;
    }
  });
  const after = reportSnapshot();

  ok('没有抛出去', threw === null, String(threw));
  ok('同步抛也记进了账本', delta(before, after, 'total') === 1);
  ok('同步抛走了退路', delta(before, after, 'beaconTried') === 1);
}

/* ───────────────── [6] 账本跟着心跳回去 ───────────────── */

section('[6] ★ 账本必须能拼进 `/status` 的查询串（这是它唯一能抵达 Host 的方式）');

{
  // 先制造一条够长的错误，验截断。
  await withTransport({ fetchImpl: () => Promise.reject(new Error('x')), beacon: () => true }, async () => {
    reportFailure('unit-long', new Error('长'.repeat(500)));
    await new Promise((r) => setImmediate(r));
  });

  const suffix = reportQuerySuffix();
  const params = new URLSearchParams(suffix.replace(/^&/, ''));

  ok('以 & 开头（直接拼在 build= 之后）', suffix.startsWith('&'));
  ok('★ 带上了 total', params.has('rTotal'));
  ok('★ 带上了 delivered 与 failed', params.has('rOk') && params.has('rFail'));
  ok('★ 带上了两条路各自的次数',
    params.has('rFetchTry') && params.has('rFetchOk') && params.has('rBeaconTry') && params.has('rBeaconOk'),
    '只报总数的话，「主路从来没成过」这个最关键的读数就丢了');
  ok('★ 带上了最近一条的 scope', params.get('rLast') === 'unit-long');
  ok('★ 带上了最近一条的正文（这是通道坏掉时唯一还能看见错误的地方）',
    (params.get('rMsg') ?? '').startsWith('长长长'),
    `实际 ${JSON.stringify((params.get('rMsg') ?? '').slice(0, 20))}`);
  ok('正文被截断了（GET 查询串不能无限长）',
    (params.get('rMsg') ?? '').length <= 141 && (params.get('rMsg') ?? '').endsWith('…'),
    `长度 ${(params.get('rMsg') ?? '').length}`);
  ok('带上了时间戳', Number(params.get('rAt')) > 0);
  ok('中文没有被裸放进去（必须编码）', !suffix.includes('长'), '查询串里出现了未编码的中文');
}

/* ───────────────── [7] 源码级：主路/退路/账本的形状 ───────────────── */

section('[7] 源码级判据 —— 每一条都配一次「真实的忘记」做反证');

const reportSource = readFileSync(resolve(PACKAGE, 'src/client/report.ts'), 'utf8');
const pluginSource = readFileSync(resolve(PACKAGE, 'src/client/plugin.ts'), 'utf8');

/** 一条判据 = 一个具名谓词。`[7]` 段对真源码断言为真，`[8]` 段对弄坏的源码断言为假。 */
const P = {
  /**
   * 主路是 fetch，而且是带 keepalive 的 fetch。
   *
   * ★ 判据里那个尾逗号是**必须的**：文件头的注释里也写着
   * `` `fetch(..., { keepalive: true })` 是主路 ``，不带逗号的谓词会被
   * **描述这段代码的那句话**满足 —— 于是删掉真代码之后断言照样绿。
   * 这不是假设，是第一版反证抓出来的（与 §8.29「更正注释引用了旧措辞」
   * 是同一类：**判据必须只认代码的形状，不能认散文**）。
   */
  fetchPrimary: (s) => s.includes('fetch(ERROR_ENDPOINT, {') && s.includes('keepalive: true,'),
  /** 退路的存在形态：一个独立的函数，并且在结算口被**真的调用**。 */
  beaconFallback: (s) => s.includes('function viaBeacon(payload: string): boolean')
    && s.includes('if (viaBeacon(payload))'),
  /** 失败路径**两条**：reject 走一个，非 2xx 走一个，且都经过同一个结算口。 */
  twoFailurePaths: (s) => s.includes('const fail = (): void => {')
    && s.includes('if (res.ok) {')
    && (s.match(/settleFailed\(payload\);/g) ?? []).length >= 2,
  /**
   * ★ 一次上报只能算一次成败。
   *
   * 守的是门禁自己抓出来的那个缺陷：`fail()` 记一次失败、`viaBeacon()` 又记一次，
   * 于是「两条路都不通」变成 `failed += 2` 而 `total` 只加了 1 —— 账本的分子
   * 与分母在描述两件不同的事。它的表现是 `failed > total`，而那个数字看上去
   * 只像「失败挺多」，不像坏掉。
   */
  singleCount: (s) => s.includes('function settleFailed(payload: string): void {')
    && (s.match(/counters\.failed \+= 1;/g) ?? []).length === 1,
  /** 同步抛与 reject 都要被兜住。 */
  syncAndAsync: (s) => s.includes('} catch {\n      fail();\n    }'),
  /** 账本要出去。 */
  querySuffix: (s) => s.includes('export function reportQuerySuffix()')
    && s.includes('&rTotal=') && s.includes('&rOk=') && s.includes('&rFail='),
  /** 最近一条正文也要出去。 */
  lastMessage: (s) => s.includes("out += `&rLast=") && s.includes('&rMsg='),
  /** 截断常量在，而且真的被用。 */
  truncates: (s) => s.includes('LAST_MESSAGE_CHARS') && s.includes('message.slice(0, LAST_MESSAGE_CHARS)'),
  /** ★ 关键接线：心跳那条 URL 必须把账本拼上去。 */
  wiredIntoHeartbeat: (s) => s.includes('${stageQuerySuffix()}${reportQuerySuffix()}'),
};

for (const [name, predicate] of Object.entries(P)) {
  const where = name === 'wiredIntoHeartbeat' ? pluginSource : reportSource;
  ok(`${name}`, predicate(where) === true);
}

ok('★ 心跳真的用了它（不是只导入了没用）',
  pluginSource.includes("import { reportFailure, reportQuerySuffix } from './report';"),
  '只导入不拼进 URL，账本永远不会离开浏览器');

/* ───────────────── [8] 反向验证：把每条判据对应的「忘记」做出来 ───────────────── */

section('[8] 反向验证 —— 弄坏源码，同一个谓词必须变红');

const mutations = [
  ['fetchPrimary', (s) => s.replace('keepalive: true,', '')],
  ['beaconFallback', (s) => s.replace(
    'if (viaBeacon(payload)) counters.delivered += 1;\n  else counters.failed += 1;',
    'counters.failed += 1;',
  )],
  ['twoFailurePaths', (s) => s.replace('if (res.ok) {', 'if (true) {')],
  ['singleCount', (s) => s.replace(
    'function settleFailed(payload: string): void {\n  if (viaBeacon(payload)) counters.delivered += 1;\n  else counters.failed += 1;\n}',
    'function viaBeacon2(payload: string): void { void payload; }',
  )],
  ['syncAndAsync', (s) => s.replace('} catch {\n      fail();\n    }', '} catch {\n      void 0;\n    }')],
  ['querySuffix', (s) => s.replace('&rFail=', '&rNoFail=')],
  ['lastMessage', (s) => s.replace('&rMsg=', '&rBody=')],
  ['truncates', (s) => s.replace('message.slice(0, LAST_MESSAGE_CHARS)', 'message')],
  ['wiredIntoHeartbeat', (s) => s.replace('${stageQuerySuffix()}${reportQuerySuffix()}', '${stageQuerySuffix()}')],
];

for (const [name, mutate] of mutations) {
  const where = name === 'wiredIntoHeartbeat' ? pluginSource : reportSource;
  const broken = mutate(where);
  ok(`反证 ${name}：源码真的被改动了`, broken !== where, '这次突变没有命中任何字符 —— 断言是空转的');
  ok(`反证 ${name}：谓词变红`, P[name](broken) === false,
    '弄坏之后谓词仍然为真 —— 这条断言守不住它声称要守的东西');
}

// 还原一次，确认恢复原状（防止上面的字符串替换漏改了什么）。
ok('反证没有改动磁盘上的源码',
  readFileSync(resolve(PACKAGE, 'src/client/report.ts'), 'utf8') === reportSource
    && readFileSync(resolve(PACKAGE, 'src/client/plugin.ts'), 'utf8') === pluginSource);

/* ───────────────── 收尾 ───────────────── */

console.log('');
if (failures === 0) {
  console.log(`[16] REPORT GATE PASSED —— ${checks} 项断言全绿`);
  process.exit(0);
}
console.log(`[16] REPORT GATE FAILED —— ${failures} / ${checks} 项未通过`);
process.exit(1);
