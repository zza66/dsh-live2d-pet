#!/usr/bin/env node
/**
 * 门禁：**渲染舞台的存在性**（`lib/test/stage-presence.mjs` ＝ `src/client/stage-presence.ts`）。
 *
 * ## 为什么需要这个文件
 *
 * 它守的是「她冻住了，而且一条记录都没有」这个问题的**第五轮**答案。
 *
 * 前四轮我在修护栏：`frame-live`（探针自证）、`frame-blind`（探针看不见）、
 * `frame-frozen`（画面不动）、`frame-hidden`（窗口被判隐藏）、`frame-nostart`
 * （一帧都没有）。五道护栏都装好了、都绿了、都写进文档了 ——
 * 而用户报上来的仍然是「零条记录」。
 *
 * 真原因是结构性的：**这五道护栏全都住在渲染舞台那个 effect 里**，而
 * `plugin.ts` 的 JSX 里写着
 *
 *     collapsed ? null : h('div', { className: 'dsh-l2d-body' }, … h(Live2DStage, …))
 *
 * 面板一收起，`Live2DStage` 整个不渲染 → effect 卸载 → cleanup 把五个定时器
 * 全部 `clearInterval` 掉。于是「面板收着」与「一切正常」在 `/status` 上
 * **长得一模一样**：都是零条 `frame-*`。
 *
 * 我自己被这一点骗过：拿着「零条记录」去推断「画面没有被重新呈现」，
 * 而当时面板很可能就是收着的。所以这个文件守的不是「信号对不对」，
 * 而是**「沉默可不可信」**—— 一件推理的前提，没人会去测它。
 *
 * ## 结构：一条判据 = 一个谓词，正反两用
 *
 * [2]/[3] 段把每条判据写成**具名谓词**，对真源码断言为真；
 * [4] 段把每条判据对应的那次「忘记」做出来，对**被弄坏的源码**断言同一个
 * 谓词为假。于是「这条断言有牙」这句话本身也是被验证的，而不是我声称的 ——
 * 一条恒真的断言在报告里与一条有效的断言长得完全一样。
 *
 * ## 用法
 *
 *     node tools/test-stage-presence.mjs     （离线：无网络、无 DOM）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(packageRoot, 'lib/test/stage-presence.mjs');

let failed = 0;
let passed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

if (!existsSync(modulePath)) {
  console.error(`渲染舞台存在性的测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const { getStagePresence, setStagePresence, stageQuerySuffix } = mod;

const pluginSource = readFileSync(resolve(packageRoot, 'src/client/plugin.ts'), 'utf8');
const hostSource = readFileSync(resolve(packageRoot, 'lib/index.js'), 'utf8');

/* ── [1] 模块行为 ───────────────────────────────────────────────────── */
section('[1] 模块行为：登记 / 注销 / 查询串');

/** 每个断言都从一个已知的干净状态出发 —— 模块是**进程级单例**，会串味。 */
function reset() {
  setStagePresence(null);
}

reset();
check('初始没有登记', getStagePresence() === null);
check(
  '★ 没登记时查询串说的是 `stage=0`，而不是「不带这个参数」',
  stageQuerySuffix() === '&stage=0',
  `实际 "${stageQuerySuffix()}"`,
);

reset();
setStagePresence({ since: 111, modelPath: () => 'miku/miku.model3.json', frames: () => 42 });
const on = stageQuerySuffix();
check('登记后 stage=1', on.startsWith('&stage=1'), on);
check('带上模型路径', on.includes('stageModel=miku%2Fmiku.model3.json'), on);
check('带上帧数', on.includes('stageFrames=42'), on);

reset();
setStagePresence({ since: 1, modelPath: () => '空/空 - 免费版.model3.json', frames: () => 3 });
const cn = stageQuerySuffix();
check(
  '★ 中文与空格被编码（漏编码时 URL 会在空格处截断，而 present 仍然是 true）',
  cn.includes('stageModel=%E7%A9%BA%2F') && !cn.includes(' ') && !cn.includes('空'),
  cn,
);

reset();
let liveFrames = 0;
setStagePresence({ since: 1, modelPath: () => 'a.model3.json', frames: () => liveFrames });
check('帧数是**活的**（取值函数，不是登记那一刻的快照）', stageQuerySuffix().includes('stageFrames=0'));
liveFrames = 99;
check('登记之后涨的帧数读得到', stageQuerySuffix().includes('stageFrames=99'));

reset();
setStagePresence({ since: 1, modelPath: () => '', frames: () => Number.NaN });
check(
  '帧数是 NaN 时写成 0（不许把 NaN 送上线缆）',
  stageQuerySuffix() === '&stage=1&stageModel=&stageFrames=0',
  stageQuerySuffix(),
);
setStagePresence({ since: 1, modelPath: () => '', frames: () => -5 });
check('帧数是负数时写成 0', stageQuerySuffix().includes('stageFrames=0'), stageQuerySuffix());
setStagePresence({ since: 1, modelPath: () => '', frames: () => 7.9 });
check('帧数取整（「画了 7.9 帧」是说不通的说法）', stageQuerySuffix().includes('stageFrames=7'), stageQuerySuffix());

reset();
setStagePresence({ since: 1, modelPath: () => 'x.model3.json', frames: () => 1 });
setStagePresence(null);
check('注销之后回到 stage=0', stageQuerySuffix() === '&stage=0', stageQuerySuffix());
check('注销之后 getStagePresence() 是 null（不留半条记录）', getStagePresence() === null);

reset();

/* ── [2]/[3] 判据（具名谓词，[4] 段复用） ──────────────────────────── */
section('[2] 客户端接线：挂载时登记、卸载时注销、轮询时带上');

const indexOfReady = (src) => src.indexOf('hostRef.current.host = host;');
const indexOfPresence = (src) => src.indexOf('setStagePresence({');
const indexOfDispose = (src) => src.indexOf('host.disposed = true;');
const indexOfClear = (src) => src.indexOf('setStagePresence(null);');

/*
 * ★ 这一处必须**从 `host` 就位处往后**找。
 *
 * `host.raf = requestAnimationFrame(frame);` 在源码里出现两次：
 * 一次在 `frame()` 函数体内（每帧的自我重排），一次在 effect 主体里（启动）。
 * 用 `indexOf` 会撞上前者 —— 它在 `host` 赋值**之前**，于是这条判据会
 * 报出一个「登记得太晚」的假故障。第一次跑就撞上了，所以这段话留在这里：
 * **同一个字符串出现两次时，`indexOf` 找的是哪一次，是判据的一部分。**
 */
const indexOfRaf = (src) => {
  const from = indexOfReady(src);
  return from < 0 ? -1 : src.indexOf('host.raf = requestAnimationFrame(frame);', from);
};

const P = {
  import: (src) => /import \{[^}]*\bsetStagePresence\b[^}]*\} from '\.\/stage-presence'/.test(src),

  /*
   * 登记点必须在 `host` 就位之后、且**就在启动那一帧的旁边**。
   *
   * 只找 `setStagePresence({` 是不够的：那个调用若早于 `host` 赋值，
   * Core 加载失败时也会留下一条「舞台在」—— 而那种情况下画面上一帧都没有，
   * 恰恰是最不该说「在」的时候。
   *
   * 距离上限（1600 字符）守的是「同一个基本块」：`host` 与启动之间还夹着
   * WebGL 早退、Core 加载、框架加载。隔着一整个 `await` 去登记，就等于
   * 断言一件还没发生的事。
   */
  order: (src) => {
    const r = indexOfReady(src);
    const p = indexOfPresence(src);
    const f = indexOfRaf(src);
    return r >= 0 && p > r && f > p && f - r < 1600;
  },

  /**
   * 登记的是一份**活的**记录，不是那一刻的快照。
   *
   * ★ 这个谓词原来写成 `/setStagePresence\(\{\s*since: Date\.now\(\),\s*modelPath: \(\) =>[\s\S]{0,200}?frames: \(\) =>/`
   * —— 靠「两个字段之间不超过 200 个字符」来保证它们是同一次登记里的两个字段。
   * 2026-02 它红了：`frames: () => host.drawnTotal,` 上面加了一段说明**为什么**要报
   * 单调计数的注释（§8.33 第二个缺陷），把间距顶过了 200。
   *
   * 那是谓词的错，不是代码的错 —— **「两个字段挨得够近」从来不是这条断言要守的东西**，
   * 它要守的是「两个字段都是函数」。所以改成真的去取那次调用的花括号里有什么，
   * 再逐个字段要求「是函数」。**写死的字符窗口会把「加了注释」判成「改坏了」**，
   * 而注释恰恰是这个项目最鼓励写的东西。
   */
  getters: (src) => {
    const call = /\bsetStagePresence\(\{([\s\S]{0,4000}?)\}\)/.exec(src);
    if (call === null) return false;
    const body = call[1];
    return /since: Date\.now\(\)/.test(body)
      && /modelPath: \(\) =>/.test(body)
      && /frames: \(\) =>/.test(body);
  },

  /*
   * ★ 注销点必须在 cleanup 里、紧跟在 `host.disposed = true` 之后。
   * 这一条是整件事的要害：漏了它，Host 会永远以为有人在守着 ——
   * 于是「舞台不在」这个事实**只在第一次卸载之前是准的**，
   * 而那恰好是最不需要它的时刻。
   */
  unregister: (src) => {
    const d = indexOfDispose(src);
    const c = indexOfClear(src);
    return c > d && d >= 0 && c - d < 400;
  },

  /** ★ 轮询真的把它拼进查询串。模块写对了但这里忘了拼，现象与没写完全一样。 */
  query: (src) => /\$\{ROUTE_PREFIX\}\/status\?build=\$\{encodeURIComponent\(buildId\)\}\$\{stageQuerySuffix\(\)\}/.test(src),
};

check('plugin.ts import 了这两个函数', P.import(pluginSource));
check(
  '★ 登记点在 host 就位之后、启动那一帧之前（且同属一个基本块）',
  P.order(pluginSource),
  `host=${indexOfReady(pluginSource)} presence=${indexOfPresence(pluginSource)} raf=${indexOfRaf(pluginSource)}`,
);
check('登记的是**取值**记录（modelPath 与 frames 都是函数，不是快照）', P.getters(pluginSource));
check(
  '★ 卸载时注销，且紧跟在 `host.disposed = true` 之后',
  P.unregister(pluginSource),
  `disposed=${indexOfDispose(pluginSource)} clear=${indexOfClear(pluginSource)}`,
);
check('★ 轮询真的把它拼进查询串（忘了拼 = 现象与没写一样）', P.query(pluginSource));

section('[3] Host 读端：解析 / 存下来 / 说进 detail');

const P_HOST = {
  field: (src) => /clientStage: null,/.test(src),
  parse: (src) => /if \(stage === '0' \|\| stage === '1'\)/.test(src),

  /*
   * ★ 不带 `stage` 的心跳**不许改动**已知状态。
   *
   * 那正是「旧客户端」的形状。若把它读成「舞台不在」，`live2d_status` 就会
   * 对着一只正在渲染的桌宠说「渲染舞台：不在」，而那句话的用途恰恰是让人
   * **别信** `frame-*` 的沉默 —— 一条会说谎的判据比没有判据更糟：
   * 它会让我把真实证据丢掉。
   */
  noClobber: (src) => {
    const at = src.indexOf("const stage = url.searchParams.get('stage');");
    if (at < 0) return false;
    const gate = src.indexOf("if (stage === '0' || stage === '1')", at);
    const assign = src.indexOf('state.clientStage = {', at);
    return gate > at && assign > gate;
  },

  detail: (src) => /\$\{clientStageText\}/.test(src) && /describeClientStage\(state\.clientStage\)/.test(src),
};

/** `describeClientStage()` 的函数体（判据落在**措辞**上，所以要看这一段）。 */
const describeBlock = (() => {
  const at = hostSource.indexOf('function describeClientStage');
  return at < 0 ? '' : hostSource.slice(at, at + 1600);
})();

const P_SAY = {
  /*
   * ★ 这三句措辞是**判据本身**，不是文案。
   *
   * `describeClientStage()` 存在的全部意义，是拦住「拿 `frame-*` 的沉默当证据」
   * 这个推断。少了「不算证据」这类字样，它就只是多了一个字段 ——
   * 而多一个字段从来救不了任何人。
   */
  absent: (block) => /不在[\s\S]{0,200}不算证据/.test(block),
  unknown: (block) => /未知[\s\S]{0,80}没有上报/.test(block),
  present: (block) => /已画/.test(block),
};

check('状态里有 clientStage 字段', P_HOST.field(hostSource));
check('解析 stage=1 / stage=0', P_HOST.parse(hostSource));
check('★ 不带 stage 时不动已知状态（旧客户端 ≠ 舞台不在）', P_HOST.noClobber(hostSource));
check('detail 里带上它', P_HOST.detail(hostSource));
check(
  '★ 「不在」那一句明说 frame-* 的沉默不算证据',
  P_SAY.absent(describeBlock),
  describeBlock.replace(/\s+/g, ' ').slice(0, 150),
);
check('★ 未知那一句说的是「没有上报这一项」（不是「不在」—— 那会造出一个凭空的故障）', P_SAY.unknown(describeBlock));
check('「在」那一句带上模型与帧数（否则分不出「在但没画」与「在且在画」）', P_SAY.present(describeBlock));

/* ── [3b] ★ 存活自证：让「一条故障都没有」变回可信 ───────────────────── */
section('[3b] ★ 存活自证：上报通道本身必须被观测过，沉默才有意义');

/**
 * 这一段的由来（2026-06，第五轮排查的终点）。
 *
 * 五道 `frame-*` 护栏装好、绿了、写进文档之后，用户报卡死时 `clientErrors`
 * 依然是空的。而「空」同时对应三种处境：
 *   ① 真没冻；② 护栏根本没挂载；③ 护栏跑了但**上报通道**不通。
 *
 * 第三种此前既没被证明也没被证伪 —— 因为通道本身从来没有被观测过。门禁里那些
 * `route-gate-*` 是**门禁进程**用 node 的 fetch 发的，不是渲染进程发的；
 * 它们证明的是「Host 那条路由能收」，不是「浏览器里的 `sendBeacon` 能发」。
 *
 * 所以这里守的是两句话：
 *   · `client-alive` —— 由**唯一一个与面板收起无关的 effect**（轮询 /status 那个）
 *     借 `reportFailure` 发一条。它到了，通道就是通的。
 *   · `client-stage-mounted` —— 由舞台 effect 走到「Core 与 shader 就绪、rAF 排上」
 *     那一刻发一条。它到了，舞台就是真的挂载了。
 * 两条合起来，零条 `frame-*` 才终于只剩一种意思。
 */
const P_LIVE = {
  alive: (src) => /reportFailure\(\s*'client-alive',/.test(src),
  mounted: (src) => /reportFailure\(\s*'client-stage-mounted',/.test(src),

  /*
   * ★ `client-alive` 必须来自 `useHostStatus` 那个 effect。
   *
   * 这一条是整段的要害：若它被放进舞台 effect 里，它就退化成了第六道
   * 「只在舞台活着时才说话」的护栏 —— 而它存在的唯一理由，正是在舞台
   * **不在了**的时候替它说话。放错地方，它自己就成了同一个盲点的一部分。
   */
  aliveOutsideStage: (src) => {
    const poll = src.indexOf('function useHostStatus(');
    const alive = src.indexOf("'client-alive'");
    const stage = src.indexOf('function Live2DStage(');
    return poll >= 0 && alive > poll && (stage < 0 || alive < stage);
  },

  /** 舞台那条必须落在登记之后（登记了才算「在」，反过来就是断言一件还没发生的事）。 */
  mountedAfterPresence: (src) => {
    const p = src.indexOf('setStagePresence({');
    const m = src.indexOf("'client-stage-mounted'");
    return p >= 0 && m > p && m - p < 2500;
  },
};

const P_HOST_LIVE = {
  /* ★ 三个 scope 一个都不能少：`frame-live` 也是自证，不是故障。 */
  scopes: (src) => /const LIVENESS_SCOPES = new Set\(\['client-alive', 'client-stage-mounted', 'frame-live'\]\)/.test(src),

  /** 分桶按结构化 `scope` 判，**不按文本前缀猜**（猜错会让真故障被吞掉）。 */
  byScope: (src) => {
    const at = src.indexOf('function describeClientErrors');
    if (at < 0) return false;
    const block = src.slice(at, at + 2600);
    return /const scopeOf = \(entry\) =>/.test(block)
      && /JSON\.parse\(String\(entry\)\)\?\.scope/.test(block)
      && !/startsWith\(/.test(block)
      && !/route-gate/.test(block.replace(/门禁自测标记 route-gate-\*/g, ''));
  },

  /* 三个桶都真的被填：少一个，要么自证被当成故障，要么故障被当成自证。 */
  buckets: (src) => {
    const at = src.indexOf('function describeClientErrors');
    if (at < 0) return false;
    const block = src.slice(at, at + 2600);
    return /probes\.push\(entry\)/.test(block)
      && /liveness\.push\(scope\)/.test(block)
      && /real\.push\(entry\)/.test(block);
  },

  /*
   * ★ 心跳只认渲染进程发来的请求。
   *
   * 这条修的是一个**测量污染**：「渲染端 在线」曾经由 `lastClientSeenAt` 决定，
   * 而那个时间戳在每个 `GET /status` 上都刷新 —— 包括 curl、门禁、我自己的探针。
   * 于是客户端早就死了的时候，状态里那句「渲染端 在线」依然成立，而它正是
   * 「她为什么不动了」的第一个要问的问题。
   */
  heartbeatGated: (src) => {
    const at = src.indexOf("if (rest === '/status') {");
    if (at < 0) return false;
    const branch = src.indexOf('state.lastClientSeenAt = Date.now();', at);
    const fromClient = src.indexOf('const fromClient =', at);
    return fromClient > at && branch > fromClient && branch - fromClient < 900;
  },

  /** 坏形状：handler 顶上一句无条件刷新。它必须不存在。 */
  heartbeatNotTopLevel: (src) => {
    const at = src.indexOf("if (rest === '/status') {");
    if (at < 0) return false;
    return !/^\s*state\.lastClientSeenAt = Date\.now\(\);/m.test(src.slice(at, at + 400));
  },

  counters: (src) => /statusReads: \{ total: 0, fromClient: 0, fromOther: 0 \}/.test(src)
    && /lastStatusReadAt: 0,/.test(src),
};

check('★ 轮询 effect 里有一条 `client-alive` 自证', P_LIVE.alive(pluginSource));
check(
  '★ 它在**舞台之外**的 effect 里（放进舞台 = 第六道只在活着时才说话的护栏）',
  P_LIVE.aliveOutsideStage(pluginSource),
  `useHostStatus=${pluginSource.indexOf('function useHostStatus(')} alive=${pluginSource.indexOf("'client-alive'")} stage=${pluginSource.indexOf('function Live2DStage(')}`,
);
check('★ 舞台 effect 里有一条 `client-stage-mounted` 自证', P_LIVE.mounted(pluginSource));
check('★ 它在登记之后（登记了才叫「在」）', P_LIVE.mountedAfterPresence(pluginSource));
check('Host 认识三个自证 scope（`frame-live` 也算自证，不算故障）', P_HOST_LIVE.scopes(hostSource));
check('★ 分桶按结构化 scope，不按文本前缀猜', P_HOST_LIVE.byScope(hostSource));
check('★ 三个桶都真的被填', P_HOST_LIVE.buckets(hostSource));
check('详情里数出 `statusReads` 与 `lastStatusReadAt`', P_HOST_LIVE.counters(hostSource));
check(
  '★ 心跳只在 `fromClient` 分支里刷新（否则「渲染端在线」会被自己的查询刷成真的）',
  P_HOST_LIVE.heartbeatGated(hostSource),
);
check('handler 顶上没有无条件刷新心跳', P_HOST_LIVE.heartbeatNotTopLevel(hostSource));

/* ── [4] 反向验证 ───────────────────────────────────────────────────── */
section('[4] ★ 反向验证：每条判据都真的抓得住对应的那次忘记');

/**
 * 把登记调用整段**搬**到 `host` 就位之前 —— 一个真的会犯的错
 * （「反正都在这个 effect 里，放前面更整齐」）。
 */
function relocateRegistrationBeforeReady(src) {
  const start = src.indexOf('        setStagePresence({');
  if (start < 0) return src;
  const endMark = src.indexOf('        });', start);
  if (endMark < 0) return src;
  const call = src.slice(start, endMark + '        });\n'.length);
  const without = src.slice(0, start) + src.slice(endMark + '        });\n'.length);
  return without.replace('        hostRef.current.host = host;', `${call}        hostRef.current.host = host;`);
}

/** 每条退化：一个真人会犯的忘记 + 它应当被哪个谓词抓住。 */
const mutations = [
  {
    label: '忘了把后缀拼进轮询',
    target: 'plugin',
    predicate: P.query,
    broken: pluginSource.replace('${stageQuerySuffix()}', ''),
  },
  {
    label: '卸载时不注销（Host 永远以为有人在守着）',
    target: 'plugin',
    predicate: P.unregister,
    broken: pluginSource.replace('        setStagePresence(null);\n', ''),
  },
  {
    label: '根本不登记',
    target: 'plugin',
    predicate: P.getters,
    broken: pluginSource.replace('setStagePresence({', 'void ('),
  },
  {
    /*
     * ★ 「登记成快照」是最隐蔽的那一种退化：它**不会**让任何一条现有断言变红 ——
     * 舞台在、注销正常、查询串也对，只是那两个字从「每次问都重新取」变成了
     * 「挂载那一刻的值」。于是 `/status` 上「已画 N 帧」会永远停在初始的 0，
     * 与「一帧都没画」同形（这正是 §8.33 第二个缺陷的另一面）。
     */
    label: '登记成快照（frames 变成常量，/status 上永远停在挂载那一刻）',
    target: 'plugin',
    predicate: P.getters,
    broken: pluginSource.replace('frames: () => host.drawnTotal,', 'frames: 42,'),
  },
  {
    label: '登记挪到 host 就位之前（Core 加载失败也说「舞台在」）',
    target: 'plugin',
    predicate: P.order,
    broken: relocateRegistrationBeforeReady(pluginSource),
  },
  {
    label: 'Host 只认 stage=1（「不在」永远说不出口）',
    target: 'host',
    predicate: P_HOST.parse,
    broken: hostSource.replace("if (stage === '0' || stage === '1')", "if (stage === '1')"),
  },
  {
    label: '不带 stage 时也照样赋值（旧客户端被读成「舞台不在」）',
    target: 'host',
    predicate: P_HOST.noClobber,
    broken: hostSource.replace("if (stage === '0' || stage === '1') {", 'if (true) {'),
  },
  {
    label: '「不在」那一句丢掉了「不算证据」',
    target: 'host',
    predicate: P_SAY.absent,
    broken: hostSource.replace(
      "return '渲染舞台：**不在**（面板收着？—— 此刻 frame-* 的沉默不算证据）';",
      "return '渲染舞台：不在';",
    ),
    block: true,
  },
  {
    label: '「未知」被写成「不在」（凭空造出一个故障）',
    target: 'host',
    predicate: P_SAY.unknown,
    broken: hostSource.replace('渲染舞台：未知（该客户端没有上报这一项）', '渲染舞台：不在'),
    block: true,
  },
  {
    label: '`client-alive` 那条自证没写（或 scope 打错字）',
    target: 'plugin',
    predicate: P_LIVE.alive,
    broken: pluginSource.replace("'client-alive',", "'client-alive-typo',"),
  },
  {
    label: '`client-stage-mounted` 那条自证没写',
    target: 'plugin',
    predicate: P_LIVE.mounted,
    broken: pluginSource.replace("'client-stage-mounted',", "'client-stage-mounted-typo',"),
  },
  {
    label: '`frame-live` 从自证名单里掉了（它会被当成一条故障报出来）',
    target: 'host',
    predicate: P_HOST_LIVE.scopes,
    broken: hostSource.replace(
      "const LIVENESS_SCOPES = new Set(['client-alive', 'client-stage-mounted', 'frame-live']);",
      "const LIVENESS_SCOPES = new Set(['client-alive', 'client-stage-mounted']);",
    ),
  },
  {
    label: '自证不再分桶（自证被当成故障，或故障被当成自证）',
    target: 'host',
    predicate: P_HOST_LIVE.buckets,
    broken: hostSource.replace('else if (LIVENESS_SCOPES.has(scope)) liveness.push(scope);\n', ''),
  },
  {
    label: '心跳回到 handler 顶上无条件刷新（测量污染复活）',
    target: 'host',
    predicate: P_HOST_LIVE.heartbeatNotTopLevel,
    broken: hostSource.replace(
      "      if (rest === '/status') {\n",
      "      if (rest === '/status') {\n        state.lastClientSeenAt = Date.now();\n",
    ),
  },
];

for (const m of mutations) {
  const original = m.target === 'plugin' ? pluginSource : hostSource;
  check(`退化「${m.label}」真的改变了源码（空改的话下面的绿就是假的）`, m.broken !== original);
  const caught = m.block
    ? !m.predicate(m.broken.slice(m.broken.indexOf('function describeClientStage'), m.broken.indexOf('function describeClientStage') + 1600))
    : !m.predicate(m.broken);
  check(`退化「${m.label}」被抓住了`, caught);
}

/* ── 收尾 ───────────────────────────────────────────────────────────── */
console.log('');
if (failed > 0) {
  console.log(`[18] STAGE PRESENCE GATE FAILED —— ${failed} 项失败，${passed} 项通过`);
  process.exit(1);
}
console.log(`[18] STAGE PRESENCE GATE PASSED —— ${passed} 项断言全绿`);
