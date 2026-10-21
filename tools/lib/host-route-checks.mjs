/**
 * Host 路由断言集合（被两道门禁共用）。
 *
 *   - `test-host-routes.mjs`  —— 打**正在运行的 DSH**（验证真实服务器）
 *   - `simulate-host-boot.mjs` —— 打**本地临时服务器上的插件实例**（验证模块本身）
 *
 * 抽出来的理由很实际：这两处要验的是同一份契约。如果各写一套，就会出现
 * 「模块测试通过但路由测试用另一套宽松断言」的错位，而错位的那一半永远不会红。
 *
 * @module tools/lib/host-route-checks
 */

import { makeZip, PNG_1X1, zipOfPackage } from './make-zip.mjs';
import { rarOfPackage } from './rar-fixture.mjs';
import { findExtractor } from '../../dsh-live2d-pet/lib/host/rar.js';

/** 逐条断言并记录失败项。 */
export function makeChecker(failures) {
  return function check(label, condition, detail = '') {
    if (condition) {
      console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
    } else {
      console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
      failures.push(label);
    }
  };
}

async function req(base, path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应留 null，调用方自己看 text */
  }
  return { status: response.status, json, text };
}

/** MP3 帧同步字的位置（前 1KB 内找不到就返回 -1）。 */
function mp3SyncOffset(buffer) {
  for (let i = 0; i < Math.min(buffer.length - 1, 1024); i += 1) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) return i;
  }
  return -1;
}

/**
 * 跑完整套路由断言。
 *
 * @param {string} base  形如 `http://127.0.0.1:19387/.dsh-live2d-pet`
 * @param {object} [options]
 * @param {boolean} [options.live]     是否真的联网合成（false 只验不联网的那几条）
 * @param {boolean} [options.expectFresh] true = 断言 tts 计数从 0 开始（模拟启动时）
 * @param {boolean} [options.allowImport] true = 允许真的往模型库导入一个测试模型。
 *        只有 `simulate-host-boot.mjs` 该传它（那里的 modelsRoot 是临时目录）；
 *        `test-host-routes.mjs` 打的是用户真实的库，**绝不允许**。
 * @returns {Promise<string[]>} 失败项标签
 */
export async function checkHostRoutes(base, options = {}) {
  const live = options.live !== false;
  const expectFresh = options.expectFresh === true;
  const failures = [];
  const check = makeChecker(failures);

  /* ── /status ───────────────────────────────────────────────────────── */
  const status = await req(base, '/status');
  check('/status 返回 200', status.status === 200, `HTTP ${status.status}`);
  check('status.ok 为 true', status.json?.ok === true);
  check('带 tts 诊断块', typeof status.json?.tts === 'object' && status.json.tts !== null);
  check(
    'tts 诊断块字段齐全',
    ['lastAt', 'lastVoice', 'successCount', 'failureCount', 'lastError'].every(
      (key) => key in (status.json?.tts ?? {}),
    ),
    Object.keys(status.json?.tts ?? {}).join(','),
  );
  check('modelsRootExists 为 true', status.json?.modelsRootExists === true, String(status.json?.modelsRoot));

  /**
   * ★ 「渲染舞台这会儿在不在」必须跟着心跳回到 Host。
   *
   * ── 为什么这一条要放在**看守真机**的门禁里 ────────────────────────────────
   *
   * 五道 `frame-*` 护栏全都住在渲染舞台那个 effect 里，而面板一收起，
   * 客户端 JSX 里的 `collapsed ? null : h(…, Live2DStage …)` 就把整个舞台
   * 连同五道护栏一起卸载。于是「零条 frame-* 记录」有两种完全相反的成因：
   * *真的没事*，或者 *一个守卫都不在* —— 而在 `/status` 上它们长得一模一样。
   *
   * 我自己就是被这一点引到错方向上的：拿着「零条记录」当证据去推断
   * 「画面没有被重新呈现」。所以这一条不是普通的字段存在性检查，它是那次
   * 误判的回归锁。
   *
   * ── 两半分开验 ────────────────────────────────────────────────────────
   *
   * · **在真机上**只验「这个键在」—— 键在就证明跑的是新 Host 代码（这就是
   *   它作为陈旧模块探针的价值）。**刻意不伪造心跳**：`clientStage` 是用户
   *   那只客户端每隔几秒就会重写的状态，我在这里塞一个假的，接下来几秒里
   *   任何一次诊断读到的都是假的。
   * · 往返（真的把 `stage=1` / `stage=0` 发一遍）只在调用方**显式允许**时做
   *   （`allowStageProbe: true`）。这个开关的规矩与下面的 `allowImport` 完全
   *   一样：只有 `simulate-host-boot.mjs` 传 —— 它的服务器是本地临时起的，
   *   伪造不覆盖任何人的真相；`test-host-routes.mjs` 打的是用户正在用的那只
   *   DSH，绝不允许。
   *
   * ★ 第一版这里写的是 `if (!live)`，于是它**从来没有绿过**：`simulate-host-boot`
   *   的 `LIVE` 是 `!process.argv.includes('--no-live')`，默认就是 `true`，
   *   而唯一 `live: false` 的那次调用是末尾「故意挂一个什么都 404 的 handler」
   *   的反证段 —— 那一段里所有断言都应当变红。结果是：这几条断言只在一种
   *   注定要红的场景里执行过，全绿的报告里它们一次都没跑。
   *   这正是 §8.29 教训 2 的形状：**一条从不在成功路径上执行的断言，
   *   与不存在没有区别，而它在报告里看起来是绿的。**
   */
  const hasStageKey = status.json !== null
    && typeof status.json === 'object'
    && Object.prototype.hasOwnProperty.call(status.json, 'clientStage');
  check(
    '带 clientStage 字段（渲染舞台在不在；null = 这个进程还没收到过带 stage 的心跳）',
    hasStageKey,
    hasStageKey ? JSON.stringify(status.json.clientStage) : '（缺字段 —— 跑的是改动前的 Host 模块）',
  );
  if (hasStageKey && status.json.clientStage !== null) {
    const s = status.json.clientStage;
    check(
      'clientStage 形状正确',
      typeof s === 'object' && typeof s.present === 'boolean'
        && typeof s.modelPath === 'string' && typeof s.frames === 'number' && typeof s.at === 'number',
      JSON.stringify(s),
    );
  }

  /*
   * ★ `clientReport` —— 「上报通道自己通不通」的账本，同样跟着心跳回来。
   *
   * ── 它为什么比前面所有 frame-* 判据都基础 ──────────────────────────────
   *
   * 五轮里 `clientErrors` 一条浏览器发来的记录都没有，而我把它读成「护栏没说话」。
   * 现场三条事实把真相钉死了：`clientStage` 抵达了（走 `/status` 查询串）、
   * `/capabilities` 抵达了（走 fetch）、只有 `sendBeacon` 从来没有过。
   * 也就是说：**那些护栏一直对着一条坏掉的线喊，而它们的沉默被我当成了证据。**
   *
   * 这张账本存在的唯一理由，就是让「通道通不通」从推测变成读数 ——
   * 而它自己**不能**走那条可能已经坏掉的通道，只能搭心跳。这条判据钉的就是
   * 「这个字段还在」：字段在，就说明跑的是带账本的 Host，而账本一旦到了，
   * 「零条记录」才第一次有了两种可分辨的含义。
   *
   * 与 `clientStage` 一样，真机上**只验键存在**，刻意不伪造心跳 ——
   * 那是用户的客户端每隔几秒就在重写的东西，去改它会污染之后几秒的诊断。
   */
  const hasReportKey = status.json !== null
    && typeof status.json === 'object'
    && Object.prototype.hasOwnProperty.call(status.json, 'clientReport');
  check(
    '带 clientReport 字段（上报通道自己的账本；null = 还没收到过带账本的心跳）',
    hasReportKey,
    hasReportKey ? JSON.stringify(status.json.clientReport) : '（缺字段 —— 跑的是改动前的 Host 模块）',
  );
  if (hasReportKey && status.json.clientReport !== null) {
    const r = status.json.clientReport;
    check(
      'clientReport 形状正确',
      typeof r === 'object' && typeof r.total === 'number' && typeof r.delivered === 'number'
        && typeof r.failed === 'number' && typeof r.fetchTried === 'number'
        && typeof r.beaconTried === 'number' && typeof r.at === 'number',
      JSON.stringify(r),
    );
    /*
     * ★ 分母恒等式：一次上报只能算一次成败。
     *
     * `delivered + failed === total` 是这张账本唯一的算术不变式，而它守的是一个
     * 真发生过的缺陷：早先 `fail()` 记一次失败、`viaBeacon()` 又记一次，于是
     * 「两条路都不通」变成 `failed += 2` 而 `total` 只加了 1。它的症状是
     * `failed > total` —— 而那个数字看上去只像「失败挺多」，不像坏掉。
     */
    check(
      '账本自洽：送达 + 失败 = 总数（一次上报只算一次成败）',
      Number.isFinite(r.total) && r.delivered + r.failed === r.total,
      `delivered=${r.delivered} failed=${r.failed} total=${r.total}`,
    );
  }

  /*
   * ★ `statusReads` —— 「渲染端在线」这句话的**测量污染**的回归锁。
   *
   * ── 它修的是什么 ────────────────────────────────────────────────────────
   *
   * `lastClientSeenAt` 原来在**每一个** `GET /status` 上刷新：curl、门禁、
   * 我自己的探针脚本、以及 `live2d_status` 这一次查询本身，全都算「渲染端心跳」。
   * 于是「渲染端 在线」这句话在客户端早就死了的时候依然成立 ——
   * 而它正是「她为什么不动了」要问的第一个问题。
   *
   * 观测这件事不需要客户端，也不需要重启：**打几个裸的 `/status`**（不带
   * `build=`、不带 `stage=`），然后看 `fromOther` 涨了没有、`lastClientSeenAt`
   * 动了没有。前者必须涨，后者必须不动。
   *
   * 只在调用方显式允许时做（`allowStageProbe`），理由与上面 `clientStage`
   * 的往返完全一样：真机上正有一只客户端在轮询，`lastClientSeenAt` 本来就会动，
   * 拿它做判据必然误报。
   */
  const hasReadsKey = status.json !== null
    && typeof status.json === 'object'
    && Object.prototype.hasOwnProperty.call(status.json, 'statusReads');
  check(
    '带 statusReads 计数（裸请求不许刷新心跳；缺字段 = 跑的是改动前的 Host 模块）',
    hasReadsKey,
    hasReadsKey ? JSON.stringify(status.json.statusReads) : '（缺字段 —— 跑的是改动前的 Host 模块）',
  );

  if (options.allowStageProbe === true && hasReadsKey) {
    // 裸请求 = 模拟 curl / 门禁 / 探针脚本：不带 build，也不带 stage。
    const bare1 = await req(base, '/status');
    const seen1 = Number(bare1.json?.lastClientSeenAt ?? -1);
    const other1 = Number(bare1.json?.statusReads?.fromOther ?? -1);
    const client1 = Number(bare1.json?.statusReads?.fromClient ?? -1);
    await req(base, '/status');
    const bare2 = await req(base, '/status');
    const seen2 = Number(bare2.json?.lastClientSeenAt ?? -1);
    const other2 = Number(bare2.json?.statusReads?.fromOther ?? -1);
    const client2 = Number(bare2.json?.statusReads?.fromClient ?? -1);
    check(
      '★ 裸请求算进 statusReads.fromOther',
      other2 > other1,
      `fromOther ${other1} → ${other2}`,
    );
    check(
      '★ 裸请求**不**刷新 lastClientSeenAt（否则「渲染端在线」被自己的查询刷成真的）',
      seen2 === seen1,
      `lastClientSeenAt ${seen1} → ${seen2}`,
    );
    check(
      '★ 裸请求不算渲染端心跳（fromClient 不动）',
      client2 === client1,
      `fromClient ${client1} → ${client2}`,
    );
  }

  if (options.allowStageProbe === true) {
    /*
     * 往返：先声明「舞台在，画的是 a/b.model3.json，画了 7 帧」。
     *
     * 模型路径刻意同时带 `/` 与中文 —— 客户端用 `encodeURIComponent` 编码它，
     * 而「编码了没有」在真机上一年也看不出来一次：漏编码时 URL 会在这里被
     * 截断，`stageModel` 变成 `a`，而 `present` 仍然是 true，于是
     * `live2d_status` 会平静地说「渲染舞台：在（a，已画 7 帧）」。
     */
    await req(base, '/status?build=stage-gate&stage=1&stageModel=a%2F%E4%B8%AD%E6%96%87.model3.json&stageFrames=7');
    const on = await req(base, '/status');
    check(
      'stage=1 被解析进 clientStage.present',
      on.json?.clientStage?.present === true,
      JSON.stringify(on.json?.clientStage),
    );
    check(
      'stageModel 原样（含 / 与中文）',
      on.json?.clientStage?.modelPath === 'a/中文.model3.json',
      String(on.json?.clientStage?.modelPath),
    );
    check('stageFrames 是数字 7', on.json?.clientStage?.frames === 7, String(on.json?.clientStage?.frames));

    await req(base, '/status?build=stage-gate&stage=0');
    const off = await req(base, '/status');
    check(
      'stage=0 让 present 变回 false（面板收起 = 守卫不在）',
      off.json?.clientStage?.present === false,
      JSON.stringify(off.json?.clientStage),
    );
    check(
      'stage=0 也带来 modelPath/frames（形状不随 present 变形）',
      typeof off.json?.clientStage?.modelPath === 'string' && typeof off.json?.clientStage?.frames === 'number',
      JSON.stringify(off.json?.clientStage),
    );

    /*
     * ★ 反向：**不带 `stage`** 的心跳不许把已知状态抹掉，也不许凭空造一个。
     *
     * 这正是「旧客户端」的形状 —— 它不会发这个参数。若把它当成「舞台不在」，
     * `live2d_status` 就会对着一只正在渲染的桌宠说「渲染舞台：不在」，
     * 而那句话的用途恰恰是让人**别信** frame-* 的沉默。一条会说谎的判据
     * 比没有判据更糟：它会让我把真实证据丢掉。
     */
    await req(base, '/status?build=stage-gate');
    const bare = await req(base, '/status');
    check(
      '不带 stage 的心跳不改动已知状态（旧客户端 ≠ 舞台不在）',
      bare.json?.clientStage?.present === false,
      JSON.stringify(bare.json?.clientStage),
    );

    /*
     * ★ 账本往返：这是「通道坏了」唯一能被说出来的那条路，所以要验到头。
     *
     * 数值刻意选得不对称（total 9 = delivered 4 + failed 5），这样
     * 「把 delivered 当成 total」之类的抄错会当场露馅。
     * `rMsg` 里放中文与空格：客户端用 `encodeURIComponent` 编码它，
     * 漏编码时 Host 读到的会是乱码或截断 —— 而这条正文恰恰是
     * **通道坏掉时唯一还能看见那条错误的窗口**，它失真了就等于没有。
     */
    await req(base, '/status?build=report-gate&rTotal=9&rOk=4&rFail=5'
      + '&rFetchTry=9&rFetchOk=2&rBeaconTry=7&rBeaconOk=2'
      + `&rLast=${encodeURIComponent('frame-wake')}`
      + `&rMsg=${encodeURIComponent('画布 0×0，取不到 2D 上下文')}&rAt=1700000000000`);
    const ledger = await req(base, '/status');
    const rep = ledger.json?.clientReport;
    check('账本被解析（rTotal 在就认）', rep !== null && typeof rep === 'object', JSON.stringify(rep));
    check('total / delivered / failed 各就各位',
      rep?.total === 9 && rep?.delivered === 4 && rep?.failed === 5, JSON.stringify(rep));
    check('两条路各自的次数没有混在一起',
      rep?.fetchTried === 9 && rep?.fetchOk === 2 && rep?.beaconTried === 7 && rep?.beaconOk === 2,
      JSON.stringify(rep));
    check('最近一条的 scope 原样', rep?.lastScope === 'frame-wake', String(rep?.lastScope));
    check('★ 最近一条的正文原样（含中文与空格）',
      rep?.lastMessage === '画布 0×0，取不到 2D 上下文',
      JSON.stringify(rep?.lastMessage));
    check('分母恒等式在这个夹具上也成立（4 + 5 = 9）',
      rep !== undefined && rep.delivered + rep.failed === rep.total, JSON.stringify(rep));
    check('差分归零：同一份账本读数第二次不会被算成「新增」',
      typeof rep?.sinceLast === 'number', String(rep?.sinceLast));
  }
  if (expectFresh) {
    check('启动时 successCount 为 0', status.json?.tts?.successCount === 0, String(status.json?.tts?.successCount));
    check('启动时 failureCount 为 0', status.json?.tts?.failureCount === 0, String(status.json?.tts?.failureCount));
  }

  /* ── /models ───────────────────────────────────────────────────────── */
  const models = await req(base, '/models');
  check('/models 返回 200', models.status === 200, `HTTP ${models.status}`);
  check(
    '模型列表是数组且每项字段齐全',
    Array.isArray(models.json?.models)
      && models.json.models.every((m) => typeof m.id === 'string' && typeof m.path === 'string' && typeof m.name === 'string'),
    `${models.json?.models?.length ?? 0} 个`,
  );
  /*
   * 只断言「是数组、三个字段是字符串」是不够的：那是**旧**接口的形状，
   * 富信息（体检结果）全部是**新增**字段，恰好一个都不在断言里。
   * 于是「客户端拿不到 ok/problems，于是坏包在界面上和好包长得一样」
   * 这个真 bug 可以让两个门禁同时全绿。下面把新契约逐条钉住。
   */
  /*
   * 下面几条检查**必须自己对缺字段免疫**。它们跑在「真机上那个可能是旧版本的
   * Host」上，所以 `m.problems` 极可能就是 `undefined` —— 一条检查写崩了会让
   * 整个门禁以异常收场，报出来的是「无法连接」，于是真正的问题（Host 是旧代码）
   * 被伪装成网络故障。断言只能是布尔表达式，不能是可能抛异常的调用。
   */
  const list = Array.isArray(models.json?.models) ? models.json.models : [];
  const problemsOf = (m) => (Array.isArray(m?.problems) ? m.problems : null);
  check(
    '每项带体检字段（ok/problems/moc3/textures/motions/bytes）',
    list.every((m) => typeof m.ok === 'boolean'
      && Array.isArray(m.problems)
      && (m.moc3 === null || typeof m.moc3?.version === 'number')
      && typeof m.textures?.count === 'number'
      && Array.isArray(m.motions?.groups)
      && typeof m.bytes === 'number'),
    list.length === 0 ? '（模型库是空的，这条无法证伪）' : `${list.length} 个`,
  );
  /*
   * ★ 下面两条是**专门为「正在运行的 Host 是不是旧代码」而加的**，而且只能这么加。
   *
   * 上面那一大段断言（ok / problems / motions.groups / bytes…）**在旧 Host 上一条都不会红**
   * —— 旧代码交出来的形状完全合法，只是少了几个字段、多了几个错误码。实测过：
   * 全套 `verify-all` 24 项全绿，而真机 `/models` 里连 `looseFiles` 这个词都没有，
   * `E_MOTION_FILES_UNREFERENCED` 也还在往外发。「目录里散着没登记的动作/表情自动认领」
   * 这个功能在真机上**根本没生效**，却没有任何一道门禁说得出话。
   *
   * 所以新契约必须在**真机上**被钉住：字段有没有出现，是「进程里跑的是哪份代码」的
   * 唯一可观测证据。判据只用存在性与**已删除**的错误码 —— 不依赖具体模型库，
   * 模型库为空时也依然成立（空列表 `every` 为真，但那两条删除码与它无关）。
   */
  check(
    '每项带 looseFiles 字段（散落动作/表情的认领结果；null = 这棵子树里没有多余的）',
    list.every((m) => m !== null && typeof m === 'object' && 'looseFiles' in m
      && (m.looseFiles === null
        || (Array.isArray(m.looseFiles.addedExpressions)
          && Array.isArray(m.looseFiles.addedMotions)
          && Array.isArray(m.looseFiles.addedGroups)))),
    list.length === 0
      ? '（模型库是空的，这条无法证伪）'
      : `缺字段的：${list.filter((m) => !(m !== null && typeof m === 'object' && 'looseFiles' in m)).map((m) => m.id).join(',') || '（无）'}`
        + `；形状不对的：${list.filter((m) => 'looseFiles' in (m ?? {}) && m.looseFiles !== null
          && !(Array.isArray(m.looseFiles.addedExpressions)
            && Array.isArray(m.looseFiles.addedMotions)
            && Array.isArray(m.looseFiles.addedGroups))).map((m) => `${m.id}=${JSON.stringify(m.looseFiles).slice(0, 120)}`).join(' ') || '（无）'}`,
  );
  const REMOVED_CODES = ['E_MOTION_FILES_UNREFERENCED', 'E_EXPRESSION_FILES_UNREFERENCED'];
  check(
    '不再发已删除的错误码（改成「自动认领」了，留着就说明跑的是旧模块）',
    list.every((m) => problemsOf(m) !== null
      && !problemsOf(m).some((p) => REMOVED_CODES.includes(p.code))),
    list.flatMap((m) => (problemsOf(m) ?? []).filter((p) => REMOVED_CODES.includes(p.code)).map((p) => `${m.id}:${p.code}`)).join(',') || '（无）',
  );

  check(
    'problems 每项带稳定错误码与级别',
    list.every((m) => problemsOf(m) !== null && problemsOf(m).every(
      (p) => typeof p.code === 'string' && p.code.startsWith('E_')
        && (p.level === 'error' || p.level === 'warn')
        && typeof p.message === 'string',
    )),
  );
  check(
    'ok 与 problems 自洽（有 error 级问题就不能是 ok）',
    list.every((m) => problemsOf(m) !== null && m.ok === !problemsOf(m).some((p) => p.level === 'error')),
    list.filter((m) => problemsOf(m) !== null && m.ok === problemsOf(m).some((p) => p.level === 'error')).map((m) => m.id).join(','),
  );
  check(
    '带模型库摘要（total/ok/broken）',
    typeof models.json?.summary?.total === 'number'
      && typeof models.json?.summary?.ok === 'number'
      && typeof models.json?.summary?.broken === 'number',
    JSON.stringify(models.json?.summary),
  );
  check(
    '摘要与列表自洽',
    models.json?.summary?.total === list.length
      && models.json?.summary?.ok === list.filter((m) => m.ok).length,
    `summary.total=${models.json?.summary?.total} 列表=${list.length}`,
  );

  /*
   * ★ 对账：`/models` 说有几个，SDK 真的就得能拿到几个。
   *
   * 「列表说有 8 个表情、实际一个都点不出来」是本项目第八个缺陷的形状，而它
   * **在 `/models` 这一个响应里完全看不出来**：体检走 `inspectModel`、客户端走
   * `/model/<path>`，是两条路、各合一次。两条路一旦分叉，数字是对的、功能是死的。
   *
   * 所以这里去打那条**真正会被 SDK 读**的路由，拿它交出去的 JSON 逐项对账。
   * 断言方向是 `>=`：说得多、给得少才是缺陷；给得比说得多不算（那是列表漏报，
   * 属于另一个方向的毛病，不该混进这条的红里）。同时把两个数字都打出来，
   * 让人一眼看见偏差 —— 只看红绿是看不出偏差朝向的。
   */
  const reconcile = [];
  for (const m of list) {
    if (typeof m?.path !== 'string') continue;
    const served = await req(base, `/model/${m.path}`);
    if (served.status !== 200 || served.json === null) {
      reconcile.push(`${m.id}: HTTP ${served.status}`);
      continue;
    }
    const refs = served.json?.FileReferences ?? {};
    const servedMotions = Object.values(refs.Motions ?? {})
      .reduce((n, group) => n + (Array.isArray(group) ? group.length : 0), 0);
    const servedExpressions = Array.isArray(refs.Expressions) ? refs.Expressions.length : 0;
    if (servedMotions < m.motions.count) reconcile.push(`${m.id}: 动作 说=${m.motions.count} 交=${servedMotions}`);
    if (servedExpressions < m.expressions) reconcile.push(`${m.id}: 表情 说=${m.expressions} 交=${servedExpressions}`);
  }
  check(
    '交出去的 model3.json 与列表对得上（说几个就得能拿到几个）',
    reconcile.length === 0,
    reconcile.join('; ') || `${list.length} 个模型逐一对账`,
  );

  /* ── /models/refresh（强制重扫，绕开指纹缓存） ─────────────────────── */
  const refreshed = await req(base, '/models/refresh');
  check('/models/refresh 返回 200', refreshed.status === 200, `HTTP ${refreshed.status}`);
  check(
    '/models/refresh 也返回完整清单',
    Array.isArray(refreshed.json?.models)
      && typeof refreshed.json?.summary?.total === 'number'
      && refreshed.json.models.length === models.json?.models?.length,
    `${refreshed.json?.models?.length ?? 0} 个`,
  );
  check(
    /*
     * 模型库为空时这条无法证伪（misses 恒为 0），所以只在非空时要求严格增长：
     * `force` 的语义是**直接跳过 lookup**，所以每个模型都会重新记一次 miss。
     * 写成 `>=` 的话，一个把 `force` 参数吞掉、退化成普通查询的实现照样能过。
     */
    list.length === 0
      ? '强制重扫跳过缓存（模型库为空，无法证伪，跳过）'
      : '强制重扫确实跳过了缓存（misses 严格增长）',
    list.length === 0
      || (typeof refreshed.json?.cache?.misses === 'number'
        && typeof models.json?.cache?.misses === 'number'
        && refreshed.json.cache.misses > models.json.cache.misses),
    `before=${models.json?.cache?.misses} after=${refreshed.json?.cache?.misses}`,
  );

  /* ── /import ────────────────────────────────────────────────────────── *
   *
   * ★ 这里**只测不会改动磁盘的失败路径**。
   *
   * `test-host-routes.mjs` 打的是用户**正在使用**的 DSH，它的 modelsRoot 就是
   * 用户真实的模型库 —— 门禁往里面塞一个测试模型是极其失礼的事（用户会看见
   * 一个自己没放过的模型，而且不知道怎么删）。真正「导入成功」的断言只在
   * `options.allowImport` 下跑，那是 `simulate-host-boot.mjs` 用的临时目录。
   * ------------------------------------------------------------------- */
  /*
   * 下面三条是**故意失败**的导入，会往 `importFailureCount` 上加 3。与 TTS 那一段
   * 同样的道理：先拍快照，之后只断言**差值**，绝不写死绝对值 —— 写死就意味着
   * 这道门禁「跑第二遍必红」。（TTS 那一段真的踩过这个坑，见那边的注释。）
   */
  const importBefore = (await req(base, '/status')).json ?? {};

  const importMethod = await req(base, '/import', { method: 'GET' });
  check('/import 用 GET 返回 405', importMethod.status === 405, `HTTP ${importMethod.status} ${importMethod.json?.code ?? ''}`);

  const notZip = await req(base, '/import?name=x.zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('这不是一个 zip 文件，只是一段中文文本。'),
  });
  check('导入非 zip 返回 400', notZip.status === 400, `HTTP ${notZip.status}`);
  /*
   * 断言的是 `E_IMPORT_NOT_ARCHIVE` 而不是 `E_ZIP_NOT_ARCHIVE`：`/import` 现在先过
   * `importModelArchive`，它自己判一次魔数（zip / rar 都不是就直接拒），所以走这条路
   * 时永远拿不到 zip.js 那个更靠内的码。门禁必须钉住**实际会发出的那一个** ——
   * 钉错了就会变成「门禁红着而功能是对的」，那是最容易被忽略过去的一种红。
   */
  check('导入非压缩包给出 E_IMPORT_NOT_ARCHIVE', notZip.json?.code === 'E_IMPORT_NOT_ARCHIVE', String(notZip.json?.code));
  check('失败时带可读的 detail', typeof notZip.json?.detail === 'string' && notZip.json.detail.length > 0, String(notZip.json?.detail));

  // 合法 zip 但没有 .model3.json：这是「用户下错了包」最常见的情形，
  // 必须与「包坏了」区分开 —— 前者让用户去重新下载，后者让他去修文件。
  const noModel = await req(base, '/import?name=photos.zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: makeZip([{ name: 'a.png', data: PNG_1X1, method: 'deflate' }]),
  });
  check('合法 zip 里没有模型定义返回 400', noModel.status === 400, `HTTP ${noModel.status}`);
  check('给出 E_IMPORT_NO_MODEL（区别于「包坏了」）', noModel.json?.code === 'E_IMPORT_NO_MODEL', String(noModel.json?.code));

  // 压缩炸弹：300KB 的零字节压完只有几百字节，比值远超上限。
  // 这是本插件唯一处理不可信输入的地方，值得真的打一次。
  const bomb = await req(base, '/import?name=bomb.zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: makeZip([{ name: 'zeros.bin', data: Buffer.alloc(300 * 1024), method: 'deflate' }]),
  });
  check('压缩炸弹被拦下', bomb.json?.code === 'E_ZIP_BOMB_SUSPECT', String(bomb.json?.code));

  /*
   * ★ 失败的导入**一个字节都不该落进模型库**。
   * 只断言「返回了 400」是不够的：一个解到一半才失败的实现照样返回 400，
   * 但会在库目录里留下半个模型 —— 用户看到的是「导入失败了，但列表里多了个坏模型」。
   */
  const afterFailures = await req(base, '/models');
  const idsOf = (payload) => (Array.isArray(payload?.models) ? payload.models.map((m) => m.id).sort().join('|') : null);
  check(
    '三次失败的导入没有改动模型库',
    idsOf(afterFailures.json) === idsOf(models.json) && afterFailures.json?.summary?.total === models.json?.summary?.total,
    `before=${models.json?.summary?.total} after=${afterFailures.json?.summary?.total}`,
  );

  const status2 = await req(base, '/status');
  check(
    '失败的导入被记进诊断（lastImport.ok === false）',
    status2.json?.lastImport?.ok === false && typeof status2.json?.lastImport?.code === 'string',
    JSON.stringify(status2.json?.lastImport),
  );
  check(
    '失败计数相对快照涨了（成功计数一格都没动）',
    typeof status2.json?.importFailureCount === 'number'
      && status2.json.importFailureCount > (importBefore.importFailureCount ?? 0)
      && status2.json.importCount === (importBefore.importCount ?? 0),
    `importFailureCount ${importBefore.importFailureCount} → ${status2.json?.importFailureCount}`
      + `，importCount 仍是 ${status2.json?.importCount}`,
  );

  if (options.allowImport === true) {
    const imported = await req(base, '/import?name=%E6%B5%8B%E8%AF%95%E6%A8%A1%E5%9E%8B.zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: zipOfPackage(),
    });
    check('合法模型包导入成功', imported.status === 200, `HTTP ${imported.status} ${imported.json?.code ?? ''} ${imported.json?.detail ?? ''}`);
    check('返回里带导入结果', imported.json?.imported?.ok === true, JSON.stringify(imported.json?.imported));
    check(
      '导入结果里 id/dir/name 齐全',
      typeof imported.json?.imported?.id === 'string'
        && typeof imported.json?.imported?.dir === 'string'
        && typeof imported.json?.imported?.name === 'string',
      JSON.stringify(imported.json?.imported),
    );
    // 中文文件名走查询串要能原样落地 —— 目录名是用户唯一能在资源管理器里找到它的线索。
    check('中文包名的目录名正确', imported.json?.imported?.dir === '测试模型', String(imported.json?.imported?.dir));
    check('响应里顺手带回了刷新后的清单', Array.isArray(imported.json?.models), `${imported.json?.models?.length ?? 0} 个`);
    check(
      '新模型立刻出现在清单里（没被缓存挡住）',
      Array.isArray(imported.json?.models) && imported.json.models.some((m) => m.id === imported.json?.imported?.id),
      String(imported.json?.imported?.id),
    );
    check(
      '新模型的体检结果是可加载',
      imported.json?.models?.find((m) => m.id === imported.json?.imported?.id)?.ok === true,
      JSON.stringify(imported.json?.models?.find((m) => m.id === imported.json?.imported?.id)?.problems),
    );

    const dup = await req(base, '/import?name=%E6%B5%8B%E8%AF%95%E6%A8%A1%E5%9E%8B.zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: zipOfPackage(),
    });
    check('重名导入不会被覆盖，而是顺延', dup.json?.imported?.dir === '测试模型 (2)', String(dup.json?.imported?.dir));
    check('两个都在清单里', Array.isArray(dup.json?.models) && dup.json.models.length === imported.json.models.length + 1, `${dup.json?.models?.length}`);

    /*
     * ★ rar 走的是**外部解包器**（这台机器上是 Windows 自带的 bsdtar）。
     * 门禁不能假设「一定有解包器」：没有时这条路该给 409 + E_IMPORT_RAR_NO_EXTRACTOR
     * （让用户去装 7-Zip），有解包器时才断言「一键导入」真的通 —— 两种情形都要钉，
     * 否则到了没装解包器的机器上，红的是门禁而不是功能。
     */
    const extractor = findExtractor();
    const rarImport = await req(base, '/import?name=rar-test.rar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: rarOfPackage('rar-check'),
    });
    if (extractor === null) {
      check(
        '没有解包器时 rar 导入回 409 + E_IMPORT_RAR_NO_EXTRACTOR',
        rarImport.status === 409 && rarImport.json?.code === 'E_IMPORT_RAR_NO_EXTRACTOR',
        `HTTP ${rarImport.status} ${rarImport.json?.code ?? ''}`,
      );
    } else {
      check(
        `rar 导入成功（用 ${extractor.kind}）`,
        rarImport.status === 200 && rarImport.json?.imported?.ok === true,
        `HTTP ${rarImport.status} ${rarImport.json?.code ?? ''} ${rarImport.json?.detail ?? ''}`,
      );
      check('rar 内那层顶层目录被剥掉，目录名是 rar-check', rarImport.json?.imported?.dir === 'rar-check', String(rarImport.json?.imported?.dir));
      check(
        'rar 导入的模型立刻出现在清单里且体检可加载',
        Array.isArray(rarImport.json?.models)
          && rarImport.json.models.some((m) => m.id === rarImport.json?.imported?.id && m.ok === true),
        JSON.stringify(rarImport.json?.models?.find((m) => m.id === rarImport.json?.imported?.id)?.problems),
      );
    }
  }

  /* ── /capabilities（能力清单，模型 → 宿主方向） ─────────────────────── */
  /*
   * 这个路由的方向与其余全部路由**相反**：渲染进程 POST 上来，Host 存着，
   * `live2d_status` 工具再带进会话。它是 P2 / P3 唯一的「AI 能控制什么」来源，
   * 所以断言的是一整条往返：POST 进去的形状，GET 出来必须逐字段一样。
   */
  const caps0 = await req(base, '/capabilities');
  check('/capabilities 返回 200', caps0.status === 200, `HTTP ${caps0.status}`);
  check(
    '初始状态字段齐全（capabilities/digest/summary/detail）',
    'capabilities' in (caps0.json ?? {})
      && 'digest' in (caps0.json ?? {})
      && 'summary' in (caps0.json ?? {})
      && typeof caps0.json?.detail === 'string',
    Object.keys(caps0.json ?? {}).join(','),
  );
  /*
   * ★ 这里**不能**断言「初始时 capabilities 是 null」。
   * 门禁打的是正在运行的 DSH，而用户可能早已打开过页面 —— 那时清单是真的有值。
   * 「null 代表还没报过」这条区分属于 `simulate-host-boot.mjs`（进程刚起来，
   * 一定没人报过），在这里断言会把一个正常的运行状态报成失败。
   */
  if (expectFresh) {
    check('刚启动时还没收到过清单', caps0.json?.capabilities === null, JSON.stringify(caps0.json?.capabilities));
    check('刚启动时 digest 为 null（与「空清单」不是一件事）', caps0.json?.digest === null, String(caps0.json?.digest));
  }

  const capsGet = await req(base, '/capabilities', { method: 'GET' });
  check('/capabilities 明确用 GET 也是 200', capsGet.status === 200, `HTTP ${capsGet.status}`);

  const capsWrong = await req(base, '/capabilities', { method: 'DELETE' });
  check('/capabilities 用 DELETE 返回 405', capsWrong.status === 405, `HTTP ${capsWrong.status} ${capsWrong.json?.code ?? ''}`);

  const capsBadJson = await req(base, '/capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ 这不是 JSON',
  });
  check(
    '/capabilities 坏 JSON 返回 400 + E_BAD_JSON',
    capsBadJson.status === 400 && capsBadJson.json?.code === 'E_BAD_JSON',
    `HTTP ${capsBadJson.status} ${capsBadJson.json?.code ?? ''}`,
  );

  /*
   * 垃圾 body：不是数组、数字带 NaN、id 是空串、字段名写错。期望是
   * **归一化成四个空数组 + 200**，而不是 500 —— 这个路由的输入来自渲染进程，
   * 而渲染进程刚经历过一次「抛错拖着整个外壳一起死」的事故（§9.2）。
   * 只要是数据就能归一化，就没有理由让它变成异常。
   */
  const capsJunk = await req(base, '/capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capabilities: { parameters: 'nope', expressions: 7, motionGroups: null } }),
  });
  check(
    '垃圾 body 被归一化而不是 500',
    capsJunk.status === 200 && capsJunk.json?.ok === true,
    `HTTP ${capsJunk.status} ${capsJunk.json?.code ?? ''}`,
  );
  check('垃圾 body 的指纹仍然可读', typeof capsJunk.json?.digest === 'string', String(capsJunk.json?.digest));

  const capsJunkGet = await req(base, '/capabilities');
  check(
    '垃圾 body 归一化成四个空数组',
    Array.isArray(capsJunkGet.json?.capabilities?.parameters)
      && capsJunkGet.json.capabilities.parameters.length === 0
      && Array.isArray(capsJunkGet.json?.capabilities?.expressions)
      && Array.isArray(capsJunkGet.json?.capabilities?.motionGroups)
      && Array.isArray(capsJunkGet.json?.capabilities?.hitAreas),
    JSON.stringify(capsJunkGet.json?.capabilities),
  );

  /*
   * 往返一致：POST 一份**完整**的清单，GET 出来必须逐字段一样。
   * 这条是「Host 不会悄悄改写客户端说的东西」的唯一保证 —— 一旦 Host 顺手
   * 做了排序或大小写整理，P3 的 AI 指令就会在部分模型上静默失效（参数名
   * 不匹配时 `setParameterValue` 什么都不做，也不报错）。
   */
  const ROUNDTRIP = {
    parameters: [
      { id: 'PARAM_ANGLE_X', min: -30, max: 30, def: 0 },
      { id: 'ParamAngleX', min: -30, max: 30, def: 0 },
      { id: 'ParamMouthOpenY', min: 0, max: 1, def: 0 },
      /*
       * 下面这几个是**情绪层**要用的（`live2d_emote` 的第一期）。
       *
       * 它们在这里不是为了测情绪 —— 是为了让这一份夹具像**真模型**：真实模型的
       * 能力清单里有几十个参数，其中就包括眼睛笑意、眉毛、脸颊这些「有表情可做」
       * 的家什。夹具里一个都没有时，`live2d_emote` 会走「这个模型没有任何一个
       * 「开心」需要的参数」那条分支，于是 Host 半区那条链**一次都没被真跑过**：
       * 绿的是「拒绝得对」，不是「能做事」。
       *
       * 范围照 hiyori.moc3 的真实值写（`ParamCheek` ±1、`ParamAngleZ` ±30、
       * `ParamHairAhoge` ±10），这样夹取行为也和真机一致。
       */
      { id: 'ParamEyeLSmile', min: 0, max: 1, def: 0 },
      { id: 'ParamEyeRSmile', min: 0, max: 1, def: 0 },
      { id: 'ParamCheek', min: -1, max: 1, def: 0 },
      { id: 'ParamBrowLY', min: -1, max: 1, def: 0 },
      { id: 'ParamBrowRY', min: -1, max: 1, def: 0 },
      { id: 'ParamAngleZ', min: -30, max: 30, def: 0 },
      { id: 'ParamHairAhoge', min: -10, max: 10, def: 0 },
    ],
    expressions: [{ name: '开心', file: 'exp/fun.exp3.json' }],
    motionGroups: [{ name: 'Idle', count: 2 }],
    hitAreas: [{ id: 'Head', name: '头' }],
  };
  const capsPost = await req(base, '/capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '路由测试/测试.model3.json', capabilities: ROUNDTRIP }),
  });
  check('/capabilities 接收清单返回 200', capsPost.status === 200 && capsPost.json?.ok === true, `HTTP ${capsPost.status}`);
  check(
    '响应带回 id / digest / summary',
    capsPost.json?.id === '路由测试/测试.model3.json'
      && typeof capsPost.json?.digest === 'string'
      && typeof capsPost.json?.summary === 'string',
    JSON.stringify({ id: capsPost.json?.id, digest: capsPost.json?.digest, summary: capsPost.json?.summary }),
  );
  check(
    '摘要说的是人话（带数量，且认出了口型参数）',
    typeof capsPost.json?.summary === 'string' && /表情/.test(capsPost.json.summary) && /参数/.test(capsPost.json.summary),
    String(capsPost.json?.summary),
  );

  const capsBack = await req(base, '/capabilities');
  check(
    '★ GET 出来的清单与 POST 进去的逐字段一致（顺序与大小写都没被改写）',
    JSON.stringify(capsBack.json?.capabilities) === JSON.stringify(ROUNDTRIP),
    JSON.stringify(capsBack.json?.capabilities),
  );
  check('往返后 id 也保留', capsBack.json?.id === '路由测试/测试.model3.json', String(capsBack.json?.id));
  check(
    'detail 是给 LLM 看的文本（含「不要编造」与真实表情名）',
    typeof capsBack.json?.detail === 'string'
      && capsBack.json.detail.includes('不要编造')
      && capsBack.json.detail.includes('开心')
      && capsBack.json.detail.includes('ParamMouthOpenY'),
    String(capsBack.json?.detail).slice(0, 120),
  );

  /*
   * ★ 把清单还回去 —— 这一段是补出来的，起因是一次真机上撞见的事故。
   *
   * 上面那两串 POST 打的是**正在运行的 DSH**，不是夹具；而 `/capabilities` 是宿主里
   * 唯一一份「当前模型会什么」的记录。不还原的后果非常具体：用户回到桌宠说「做个脸红的」，
   * 而 `buildAction()` 手里是这套测试清单（只有 `开心`），于是回
   * `E_EXPRESSION_NOT_FOUND`、**桌宠毫无反应**，而这条门禁自己是绿的。
   *
   * 这与「反证探针改写了用户的模型文件」是同一个形状（方案 §4.2.18）：门禁检查了
   * 自己想验的那一面，没有检查自己**留下了什么**。
   *
   * 不能在开头就断言「一定有清单可还」：刚重启、页面还没报过时 `capabilities` 就是 `null`，
   * 而那种情况下没有任何东西需要还原 —— 用 `else` 分支如实说明，而不是假装验证过了。
   */
  /*
   * ── 微动作（§13.26）──────────────────────────────────────────────── *
   *
   * 这一层最容易变成「看起来有、其实没动」：包生成失败时面板只是空着，
   * 而 `live2d_status` 照样回一句「还没生成」—— 外面看不出区别。所以这里
   * 用真清单真生成一份包，再按面板的三条路（取 / 改强度 / 改开关）各走一遍。
   *
   * 夹具里的 ROUNDTRIP 只认得出头部（`ParamAngleX` / `ParamAngleZ`）与眉毛、
   * 呆毛 —— 没有眼球、身体、肩膀。所以包一定**少于**动作表全量，这正是
   * 「缺的部位不能硬编进去」那条规矩。
   */
  const microGet = await req(base, '/micro-motions');
  check('GET /micro-motions 生成得出包', microGet.status === 200 && microGet.json?.ok === true, `HTTP ${microGet.status} ${microGet.json?.code ?? ''} ${microGet.json?.message ?? ''}`);
  check(
    '包是给刚上报的那只模型的',
    microGet.json?.model === '路由测试/测试.model3.json',
    String(microGet.json?.model),
  );
  check(
    '★ 响应里带 version（渲染端严格校验它；漏了整份包被判不认识 = 「试演没效果」）',
    microGet.json?.version === 2,
    String(microGet.json?.version),
  );
  const microParts = (gesture) => (Array.isArray(gesture?.parts) ? gesture.parts : []).flatMap((part) => Object.keys(part?.params ?? {}));
  check(
    '夹具认不出眼球/身体，所以只生成了头部相关的动作',
    Array.isArray(microGet.json?.gestures)
      && microGet.json.gestures.length > 0
      /*
       * 上界放宽到 20：v2 的动作表是 16 条，而夹具虽然缺眼球 / 身体 / 肩，
       * 头部与眉毛却都认得 —— 大部分动作靠主段 + 眉 / 呆毛那一段就能成立。
       * 原来写 14 是拿 v1 的条数当上界，v2 一加动作就红了。
       */
      && microGet.json.gestures.length <= 20
      && microGet.json.gestures.every((gesture) => microParts(gesture).every((id) => !/EyeBall|BodyAngle|Shoulder/.test(id))),
    `${microGet.json?.gestures?.length ?? 0} 条：${(microGet.json?.gestures ?? []).map((gesture) => gesture.id).join(',')}`,
  );
  check(
    '★ v2 的包是多段错峰：至少有一条不止一段，且没有空段',
    Array.isArray(microGet.json?.gestures)
      && microGet.json.gestures.some((gesture) => microParts(gesture).length > 0 && (gesture.parts ?? []).length >= 2)
      && microGet.json.gestures.every((gesture) => (gesture.parts ?? []).every((part) => Object.keys(part?.params ?? {}).length > 0)),
    (microGet.json?.gestures ?? []).map((gesture) => `${gesture.id}:${(gesture.parts ?? []).length}`).join(' '),
  );
  check(
    '缺的部位如实列在 missing 里（面板要照实说「这个模型没有眼球」）',
    Array.isArray(microGet.json?.missing)
      && microGet.json.missing.includes('eyeBallX')
      && microGet.json.missing.includes('bodyAngleX'),
    JSON.stringify(microGet.json?.missing),
  );
  check(
    '包里的增量不碰嘴',
    Array.isArray(microGet.json?.gestures)
      && microGet.json.gestures.every((gesture) => microParts(gesture)
        .every((id) => id !== 'ParamMouthOpenY' && id !== 'ParamMouthForm')),
  );
  check(
    '一条人话摘要（条数 / 启用 / 待机与说话两档）',
    typeof microGet.json?.summary === 'string' && /条/.test(microGet.json.summary) && /启用/.test(microGet.json.summary),
    String(microGet.json?.summary).slice(0, 60),
  );

  const microStrength = await req(base, '/micro-motions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strength: 1.1 }),
  });
  check('POST /micro-motions 改强度返回 200', microStrength.status === 200 && microStrength.json?.ok === true, `HTTP ${microStrength.status}`);
  check('强度真的改了', microStrength.json?.strength === 1.1, `${microStrength.json?.strength}`);
  check('越界的强度被夹到 1.4', (await req(base, '/micro-motions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strength: 99 }),
  })).json?.strength === 1.4);

  const firstId = microGet.json?.gestures?.[0]?.id ?? '';
  const microOff = await req(base, '/micro-motions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: { [firstId]: false } }),
  });
  check('POST /micro-motions 关掉一条', microOff.status === 200 && microOff.json?.gestures?.find((gesture) => gesture.id === firstId)?.enabled === false, firstId);
  check(
    '面板不许改段与参数（只合并开关与强度）',
    Array.isArray(microOff.json?.gestures)
      && microOff.json.gestures.every((gesture) => Array.isArray(gesture.parts)
        && gesture.parts.every((part) => typeof part.params === 'object' && Object.keys(part.params).length > 0))
      && JSON.stringify(microOff.json.gestures.find((gesture) => gesture.id === firstId)?.parts)
        === JSON.stringify(microGet.json.gestures.find((gesture) => gesture.id === firstId)?.parts),
  );
  await req(base, '/micro-motions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: { [firstId]: true }, strength: 0.75 }),
  });

  const microRegen = await req(base, '/micro-motions/generate', { method: 'POST' });
  check('POST /micro-motions/generate 强制重生成', microRegen.status === 200 && microRegen.json?.ok === true && microRegen.json?.source === 'generated', `HTTP ${microRegen.status} ${microRegen.json?.source ?? ''}`);
  check('重生成后仍然是同一只模型', microRegen.json?.model === '路由测试/测试.model3.json', String(microRegen.json?.model));

  /*
   * 「试演」（§13.30）：点名演一条。
   *
   * 这一段只验到 **Host 的答复**为止 —— 真让人演起来要看渲染进程的 `/pending`
   * 被谁取走，那不是这条活体检查能等的。所以断言的是三件可观察的事实：
   * 认识的 id 回 200 且说得出中文名；不认识的 id 回 409 并把现有 id 列出来；
   * 漏给 id 回 409（而不是「演了空」）。
   */
  const playId = microRegen.json?.gestures?.[0]?.id ?? '';
  const played = await req(base, '/micro-motions/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: playId }),
  });
  check(
    'POST /micro-motions/play 认识的 id 回 200 并带上中文名',
    played.status === 200 && played.json?.ok === true && typeof played.json?.label === 'string' && played.json.label !== '',
    `HTTP ${played.status} ${playId} ${played.json?.label ?? ''}`,
  );
  check('试演也回队列长度（AI 与面板看同一份诊断）', typeof played.json?.queued === 'number', String(played.json?.queued));

  const playedMissing = await req(base, '/micro-motions/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'no-such-micro-motion' }),
  });
  check('不认识的 id 回 409 + 可自愈的可用清单', playedMissing.status === 409
    && playedMissing.json?.code === 'E_MICRO_UNKNOWN_GESTURE'
    && Array.isArray(playedMissing.json?.available) && playedMissing.json.available.length > 0,
  `HTTP ${playedMissing.status} ${playedMissing.json?.code ?? ''}`);

  const playedEmpty = await req(base, '/micro-motions/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('漏给 id 回 409（不会「演了空」）', playedEmpty.status === 409 && playedEmpty.json?.code === 'E_ACTION_BAD_VALUE', `HTTP ${playedEmpty.status} ${playedEmpty.json?.code ?? ''}`);

  check('GET /micro-motions/play 被拒（会动的东西不许用 GET）', (await req(base, '/micro-motions/play')).status === 405);

  /*
   * 把刚排进去的那一条**取出来看**，顺便把队列腾空。
   *
   * 两件事必须一起做：
   *  1) 「回了 200」不等于「指令真的进了队列」—— 真值在 `/pending` 里。
   *  2) 下面还有一条 `启动时队列为空`（它要求这一次启动是干净的）。不清空的话，
   *     那条会红在一个**跟我们无关**的原因上：试演留下的指令还在队列里。
   */
  const drained = await req(base, '/pending');
  const drainedMicro = Array.isArray(drained.json?.items)
    ? drained.json.items.find((item) => item?.command?.kind === 'microMotion')
    : undefined;
  check(
    '★ 那一条真的进了渲染队列（不是只回了一句 200）',
    drainedMicro?.command?.payload?.microMotion?.id === playId,
    JSON.stringify(drainedMicro ?? drained.json?.items ?? null).slice(0, 90),
  );

  /*
   * 对话（§13.36）：面板说的那句话要能落账、能注入、能清空。
   *
   * 三条断言各有分工：
   *  - `GET` 要回一份能渲染的视图（`items` 是数组、带摘要）；
   *  - `POST` 即使注入失败也必须 **200 + 先落账**（这句话是用户说的，不能丢），
   *    失败信息走 `injected:false` + 一个 `E_CHAT_*` 码，而不是 500；
   *  - 空文本必须是 400 —— 让它进账本会得到一条永远等不到回答的空行。
   */
  const chat0 = await req(base, '/chat');
  check(
    'GET /chat 回一份能渲染的视图',
    chat0.status === 200 && chat0.json?.ok === true && Array.isArray(chat0.json?.items)
    && typeof chat0.json?.summary === 'string',
    JSON.stringify(chat0.json ?? null).slice(0, 90),
  );

  const chatSend = await req(base, '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '  路由检查：你好呀  ' }),
  });
  const chatSentItems = Array.isArray(chatSend.json?.view?.items) ? chatSend.json.view.items : [];
  check(
    'POST /chat 先落账（注入成功与否，这句话都在账本里）',
    chatSend.status === 200 && chatSentItems.some((item) => item?.role === 'user'
      && String(item.text ?? '').includes('路由检查：你好呀')),
    JSON.stringify(chatSend.json ?? null).slice(0, 120),
  );
  check(
    'POST /chat 把「送没送到」分开回（注入失败带 E_CHAT_* 码，不是 500）',
    chatSend.json?.injected === true
    || (chatSend.json?.injected === false && String(chatSend.json?.code ?? '').startsWith('E_CHAT_')),
    JSON.stringify({ injected: chatSend.json?.injected, code: chatSend.json?.code }),
  );

  const chatEmpty = await req(base, '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });
  check('POST /chat 空文本被拒（400 E_CHAT_EMPTY）',
    chatEmpty.status === 400 && chatEmpty.json?.code === 'E_CHAT_EMPTY');

  const chatCleared = await req(base, '/chat/clear', { method: 'POST' });
  check('POST /chat/clear 清空账本',
    chatCleared.status === 200 && (chatCleared.json?.view?.items ?? []).length === 0);
  check('GET /chat/clear 被拒（清空只能用 POST）', (await req(base, '/chat/clear')).status === 405);

  /*
   * 参数实测（§13.34）：渲染端把「哪几根写了会动」送回来，Host 据此重算包。
   *
   * 这里只喂**会动**的结果（changed 都 ≥ 0.01）：喂一个「不动」会把对应参数
   * 标成死的、整包重算成另一副样子，反过来影响后面几条断言的基线。
   * 两条脏条目（空 id、changed 不是数）顺便验「过滤而不是整单拒绝」。
   */
  const probePost = await req(base, '/binding-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: caps0.json?.id ?? '',
      results: [
        { id: 'ParamAngleZ', changed: 0.42 },
        { id: 'ParamEyeBallX', changed: 0.18 },
        { id: '', changed: 0.5 },
        { id: 'ParamNope', changed: 'x' },
      ],
    }),
  });
  check(
    'POST /binding-probe 收下实测结果，脏条目被丢掉',
    probePost.status === 200 && probePost.json?.ok === true && probePost.json?.probe?.total === 2,
    `HTTP ${probePost.status} total=${probePost.json?.probe?.total}`,
  );
  check('实测结果里「会动」的根数被数出来', probePost.json?.probe?.bound === 2, String(probePost.json?.probe?.bound));
  check(
    '有了新实测就顺手重算包（或这台 Host 上当前模型对不上，如实回 null）',
    probePost.json?.regenerated === null || probePost.json?.regenerated?.ok === true,
    JSON.stringify(probePost.json?.regenerated ?? null).slice(0, 80),
  );
  check('GET /binding-probe 被拒（实测只能由渲染端 POST 进来）', (await req(base, '/binding-probe')).status === 405);

  const originalCaps = caps0.json?.capabilities ?? null;

  /*
   * ★ 清空清单（§13.25）：`POST /capabilities { capabilities: null }`。
   *
   * 这一段打的是**活体 Host**，所以顺序很重要 —— 先记下原清单（上面那行），
   * 再清空，最后在下面那段还原回原样。清空本身验三件事：
   *   1. 请求被收下（`cleared: true`，不是被归一化成一份空清单）；
   *   2. 三样一起变 null（清单 / digest / summary）—— 只清一半会让 `/status`
   *      与 `/capabilities` 互相矛盾；
   *   3. `detail` 换成了「舞台不在了」那句，而不是「模型还没加载完」。
   *
   * 为什么这条重要：`buildAction()` 拿 `capabilities === null` 才拒需要清单的指令。
   * 清空不生效 = 舞台没了以后指令继续往下走，在渲染端变成 `E_ACTION_NO_MODEL`。
   */
  const cleared = await req(base, '/capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capabilities: null, reason: 'stage-unmounted' }),
  });
  check(
    '★ POST capabilities:null 表示「舞台不在了」（200 + cleared:true）',
    cleared.status === 200 && cleared.json?.cleared === true,
    `HTTP ${cleared.status} ${JSON.stringify(cleared.json ?? null).slice(0, 160)}`,
  );
  const capsGone = await req(base, '/capabilities');
  check(
    '★ 清空后三样一起归零（capabilities / digest / summary）',
    capsGone.json?.capabilities === null
      && capsGone.json?.digest === null
      && capsGone.json?.summary === null,
    JSON.stringify({ caps: capsGone.json?.capabilities ?? 'null', digest: capsGone.json?.digest ?? 'null' }),
  );
  check(
    '★ 清空后的 detail 说的是「舞台不在了」，不是「模型还没加载完」',
    typeof capsGone.json?.detail === 'string'
      && capsGone.json.detail.includes('舞台')
      && !capsGone.json.detail.includes('还没有读到'),
    String(capsGone.json?.detail ?? '').slice(0, 120),
  );

  /*
   * 把清单**当场放回去**：这一段之后还有几十条断言（动作 / 情绪 / 参数 / bindings
   * 全都要用清单）。不清空就还、等下面那个「还原成跑之前那一份」的块来兜底是不够的
   * —— 那一段还原的是 `originalCaps`，而夹具里它本来就是 null，等于没还。
   */
  const capsRefill = await req(base, '/capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '路由测试/测试.model3.json', capabilities: ROUNDTRIP }),
  });
  check(
    '清空用例之后把清单放回去（后面的断言都靠它）',
    capsRefill.status === 200 && (await req(base, '/capabilities')).json?.capabilities !== null,
    `HTTP ${capsRefill.status}`,
  );
  if (originalCaps === null) {
    check('★ 跑之前宿主还没有清单，无需还原（首次运行 / 刚重启）', true, 'capabilities = null');
  } else {
    const restored = await req(base, '/capabilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: caps0.json?.id ?? '', capabilities: originalCaps }),
    });
    const afterRestore = await req(base, '/capabilities');
    check(
      '★ 跑完之后清单被还原成跑之前那一份（门禁不许把活体 Host 留在测试态）',
      restored.status === 200
        && JSON.stringify(afterRestore.json?.capabilities) === JSON.stringify(originalCaps),
      `id=${afterRestore.json?.id} summary=${afterRestore.json?.summary}`,
    );
  }

  /* ── /pending（必须在 /speak 之前查，因为下面会往队列里塞东西） ────── */
  const pending0 = await req(base, '/pending');
  check('/pending 返回 200', pending0.status === 200, `HTTP ${pending0.status}`);
  check('items 是数组', Array.isArray(pending0.json?.items), JSON.stringify(pending0.json?.items));
  if (expectFresh) {
    check('启动时队列为空', pending0.json?.items?.length === 0);
  }

  /*
   * ── /speak 的方法与请求体校验（这三条不该联网） ─────────────────────
   *
   * ⚠️ 下面这一小段里有两个**故意失败**的合成请求，它们会往 Host 的
   * `tts.failureCount` 上加 2。所以**先拍一张计数器快照**，后面只断言
   * 「相对这张快照涨了 2 格」——**绝不能写 `failureCount === 2`**。
   *
   * 那是这道门禁真实踩过的坑：`=== 2` 只在「刚重启完 DSH 的第一次运行」成立，
   * 第二次跑就变成 4、第三次 6……于是 `verify-all --live` 连着跑两遍必然报红。
   * 而一道「你跑第二遍它就红」的门禁比没有门禁更糟 —— 它教人忽略红色，
   * 而真正要它守的那件事（正在跑的 Host 是不是新代码）就混在噪声里了。
   * 绝对计数写在这里，症状与第十三轮那个「假注释」同类：看起来验过了，其实没有。
   */
  const ttsBefore = (await req(base, '/status')).json?.tts ?? {};

  const wrongMethod = await req(base, '/speak', { method: 'GET' });
  check('/speak 用 GET 返回 405', wrongMethod.status === 405, `HTTP ${wrongMethod.status} ${wrongMethod.json?.code ?? ''}`);

  const badJson = await req(base, '/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ 这不是 JSON',
  });
  check('/speak 坏 JSON 返回 400', badJson.status === 400, `HTTP ${badJson.status} ${badJson.json?.code ?? ''}`);

  const emptyText = await req(base, '/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });
  check(
    '/speak 空文本返回 502 + E_TTS_EMPTY_TEXT',
    emptyText.status === 502 && emptyText.json?.code === 'E_TTS_EMPTY_TEXT',
    `HTTP ${emptyText.status} ${emptyText.json?.code ?? ''}`,
  );

  const tooLong = await req(base, '/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '好'.repeat(2001) }),
  });
  check(
    '/speak 超长文本返回 502 + E_TTS_TEXT_TOO_LONG',
    tooLong.status === 502 && tooLong.json?.code === 'E_TTS_TEXT_TOO_LONG',
    `HTTP ${tooLong.status} ${tooLong.json?.code ?? ''}`,
  );

  /*
   * ── 降级信号（方案文档 §6.1 #8） ─────────────────────────────────────
   *
   * Host 在失败响应里必须**明确回答**「这次该不该换系统语音」。渲染端照它做，
   * 不自己判断 —— 两边各判一次迟早会不一致，而那种不一致只有用户能发现。
   *
   * 上面那两条用的都是「请求本身写错了」的码，策略上**不该**降级：换系统语音
   * 也只会把一串空格念出来。所以它们必须报 `degrade: null`，而不是省略这个字段
   * ——「字段不在」和「字段说是 null」在渲染端是同一件事，但只有后者是**承诺**。
   */
  check(
    '/speak 失败响应带 degrade 字段（渲染端据此决定是否降级）',
    emptyText.json !== null && 'degrade' in emptyText.json,
    JSON.stringify(emptyText.json?.degrade ?? '(字段不存在)'),
  );
  check(
    '空文本 → degrade:null（换引擎也是一样的结果，不该降级）',
    emptyText.json?.degrade === null,
    String(emptyText.json?.degrade),
  );
  check(
    '空文本 → degradeReason 说清了为什么没换',
    typeof emptyText.json?.degradeReason === 'string' && emptyText.json.degradeReason.includes('没有降级'),
    String(emptyText.json?.degradeReason ?? ''),
  );
  check(
    '超长文本同理不降级',
    tooLong.json?.degrade === null,
    String(tooLong.json?.degrade),
  );

  /*
   * 两次故意失败各记一格 —— 用**差值**断言，理由见上面 `ttsBefore` 那段注释。
   * 顺带把「失败不该被算成成功」也钉住：两次失败期间 successCount 一格都不许涨。
   */
  const ttsAfterFails = (await req(base, '/status')).json?.tts ?? {};
  check(
    '两次失败各记一格（相对快照，不写死绝对值）',
    (ttsAfterFails.failureCount ?? 0) - (ttsBefore.failureCount ?? 0) === 2,
    `${ttsBefore.failureCount} → ${ttsAfterFails.failureCount}`,
  );
  check(
    '失败的那 2 次没有污染 successCount',
    (ttsAfterFails.successCount ?? 0) === (ttsBefore.successCount ?? 0),
    `successCount 仍是 ${ttsAfterFails.successCount}`,
  );

  /* ── /speak 真合成 ─────────────────────────────────────────────────── */
  if (live) {
    console.log('  ── /speak 真合成（联网，约 1–3 秒）');
    /*
     * ⚠️ 这句话**必须每次都不一样**。
     *
     * 原来是写死的 `'路由测试。'`，于是「第二次比第一次快」这条断言里，
     * 两次调用**都可能命中缓存**（上一次运行留下的），谁快谁慢全看当天运气。
     * 一句随运行变化的话保证了：第一次一定是**真的联网合成**（`cached: false`），
     * 第二次一定是**缓存命中**（`cached: true`）—— 这样「第二次明显更快」
     * 才真的在说「缓存起作用了」，而不是在掷骰子。
     */
    const PHRASE = `路由测试 ${Date.now()}。`;
    const t0 = Date.now();
    const speak = await req(base, '/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: PHRASE }),
    });
    const elapsed = Date.now() - t0;
    check('/speak 返回 200', speak.status === 200, `HTTP ${speak.status} ${speak.json?.detail ?? speak.text.slice(0, 120)}`);
    check('声明 audio/mpeg + base64', speak.json?.mimeType === 'audio/mpeg' && speak.json?.encoding === 'base64');
    check('第一次是真合成而不是缓存命中', speak.json?.cached === false, `cached=${speak.json?.cached}`);

    const audio = Buffer.from(String(speak.json?.audioBase64 ?? ''), 'base64');
    const syncAt = mp3SyncOffset(audio);
    check('解出来的字节是真 MP3', syncAt >= 0, `${audio.length} 字节，同步字在偏移 ${syncAt}`);
    check('带词边界数组', Array.isArray(speak.json?.words), `${speak.json?.words?.length ?? 0} 条`);
    check(
      '带时长',
      typeof speak.json?.durationSeconds === 'number' && speak.json.durationSeconds > 0,
      `${Number(speak.json?.durationSeconds ?? 0).toFixed(3)}s`,
    );
    check('耗时可接受', elapsed < 15000, `${elapsed}ms`);

    const t1 = Date.now();
    const cached = await req(base, '/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: PHRASE }),
    });
    const cachedElapsed = Date.now() - t1;
    check('第二次标记为 cached', cached.json?.cached === true);
    check('第二次明显更快', cachedElapsed < elapsed, `${cachedElapsed}ms vs ${elapsed}ms`);

    const after = await req(base, '/status');
    check(
      'status.tts.successCount 相对快照涨了',
      (after.json?.tts?.successCount ?? 0) > (ttsBefore.successCount ?? 0),
      `${ttsBefore.successCount} → ${after.json?.tts?.successCount}`,
    );
    check('status.tts.lastVoice 有值', typeof after.json?.tts?.lastVoice === 'string', String(after.json?.tts?.lastVoice));
    check('status.tts.lastError 已清空', after.json?.tts?.lastError === null);
  } else {
    console.log('  ── 跳过真合成（未开 --live）');
  }

  /* ── /client-error ─────────────────────────────────────────────────── */
  /*
   * ★ 自报身份：`scope: 'probe'`。
   *
   * 这条 POST 是**真的**写进 Host 的 `state.clientErrors` 里的（那正是这道判据
   * 要验的东西：生产通道真的通），而 `clientErrors` 是 Host **内存**里的、最后 20 条，
   * 一重启才清空 —— 也就是说**每跑一次门禁就往真机的故障清单里留下一条伪造的故障**。
   *
   * 后果不是「难看」：`live2d_status` 是唯一的故障入口，而它报出来的会是
   * 「客户端错误：N 条 —— route-gate-…」，看起来正是一条客户端故障。
   * 排查真卡死时（§8.29 教训 1：先读 `/status` 再重启）这一点噪音会直接误导判断。
   *
   * 修法不是「不写进去」（那就没验到），也不是「事后删掉」（删得掉的诊断信息等于
   * 没有诊断信息，见 §8.29 教训 1），而是**让它自报身份**。
   * `describeClientErrors()` 见到 `scope === 'probe'` 会把它数出来、但明说是自测标记。
   */
  const marker = `route-gate-${Date.now()}`;
  const reported = await req(base, '/client-error', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: JSON.stringify({ scope: 'probe', message: marker }),
  });
  check('/client-error 返回 200', reported.status === 200, `HTTP ${reported.status}`);

  const withError = await req(base, '/status');
  check(
    'status.clientErrors 收到了刚才那条',
    Array.isArray(withError.json?.clientErrors)
      && withError.json.clientErrors.some((line) => String(line).includes(marker)),
    `共 ${withError.json?.clientErrors?.length ?? 0} 条`,
  );

  /*
   * ★ 光「收到了」还不够：那条记录必须**带着 `scope: 'probe'`** 一起躺进清单里。
   *
   * 因为读出端（`describeClientErrors()`）就是靠这个字段把它和真故障分开的。
   * 如果哪天有人把这里的请求体改回裸字符串，POST 仍然 200、上面那条判据仍然绿，
   * 而 `live2d_status` 会重新开始把门禁自测报成「客户端错误：N 条」——
   * 一条只在出事时才说话的护栏（§4.2.26）。所以判据钉在**存储后的形状**上，
   * 不是钉在请求上。
   */
  check(
    '那条记录自报身份（scope=probe），读出端才分得开',
    (withError.json?.clientErrors ?? []).some((line) => {
      try {
        return JSON.parse(String(line))?.scope === 'probe';
      } catch {
        return false;
      }
    }),
    '没有任何一条能解析出 scope=probe —— describeClientErrors() 会把它当成真故障',
  );

  /* ── /tts/local（「用哪份」的回声与校验，§13.28） ──────────────────── */
  const localBare = await req(base, '/tts/local');
  check('/tts/local 返回 200', localBare.status === 200, `HTTP ${localBare.status}`);
  check(
    '/tts/local 带 selection（root/config 与来路）',
    typeof localBare.json?.selection === 'object' && localBare.json.selection !== null
      && typeof localBare.json.selection.source === 'string',
    localBare.json?.selection?.source ?? '缺失',
  );

  /*
   * 回声而不是覆盖：把一份绝对路径当 query 传进去，Host 必须原样认下来。
   * 这里**不去挑真实安装**（门禁不该假设这台机器装在哪），随便给一个不存在的
   * 路径反而更好用：它同时验证了「不在清单里就退回第一处 + requestedRoot 说清楚」。
   */
  const bogusRoot = 'Z:\\dsh-route-check\\不存在的安装';
  const localBogus = await req(base, `/tts/local?root=${encodeURIComponent(bogusRoot)}`);
  check('/tts/local 收到不认识的 root 也返回 200（探测不该失败）', localBogus.status === 200);
  /*
   * 这台机器一处安装都没有时，下面两条没有意义（`pickInstall` 早退、没有可退回的
   * 那一处）—— 门禁跑在别的机器上也不该红，所以按「有安装」分支断言。
   */
  const hasInstalls = (localBare.json?.installs ?? []).length > 0;
  check(
    hasInstalls
      ? 'requestedRoot 说出了被退回的那份（面板据此加一句「已退回」）'
      : '没有安装目录时跳过「退回」断言（机器上没装 GPT-SoVITS）',
    hasInstalls ? (typeof localBogus.json?.requestedRoot === 'string' && localBogus.json.requestedRoot !== '') : true,
    localBogus.json?.requestedRoot ?? '(空)',
  );
  check(
    '/tts/local 的 selection.source 是 query（面板的选择优先于 settings）',
    localBogus.json?.selection?.source === 'query',
    localBogus.json?.selection?.source ?? '缺失',
  );

  const selectBogus = await req(base, '/tts/local/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: bogusRoot }),
  });
  check(
    hasInstalls
      ? '/tts/local/select 拒收不认识的 root（409 + E_LOCAL_TTS_BAD_ROOT），且不写 settings'
      : '没有安装目录时 select 也拒绝（409 + E_LOCAL_TTS_NO_INSTALL）',
    selectBogus.status === 409
      && selectBogus.json?.code === (hasInstalls ? 'E_LOCAL_TTS_BAD_ROOT' : 'E_LOCAL_TTS_NO_INSTALL'),
    `HTTP ${selectBogus.status} ${selectBogus.json?.code ?? ''}`,
  );

  /* ── 未知路由 ──────────────────────────────────────────────────────── */
  const notFound = await req(base, '/这个路由不存在');
  check(
    '未知路由返回 404 + E_ROUTE_NOT_FOUND',
    notFound.status === 404 && notFound.json?.code === 'E_ROUTE_NOT_FOUND',
    `HTTP ${notFound.status} ${notFound.json?.code ?? ''}`,
  );

  return failures;
}
