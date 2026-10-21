/**
 * Host 半区**启动自检**（重启 DSH 之前跑的那一道）。
 *
 * 存在的理由，和 `simulate-client-boot.mjs` 完全对称：
 *
 *   客户端半区出事 → 整个应用白屏（已经发生过一次，见方案 §9.2）。
 *   Host 半区出事 → 插件整个不激活，桌宠消失，日志里只有一行 `failed to import`。
 *
 * 两种事故的共同点是**都只能靠重启才能发现**，而重启本身对用户是有成本的动作。
 * 所以这里用一个**假的 Cordis 上下文**把 Host 半区在 Node 里真跑起来：注册路由、
 * 起一个真的 http 服务器、把同一套路由断言打一遍、再调用 Agent 工具验证
 * 「工具 → 队列 → 渲染进程」这条链是通的。
 *
 * 它**不能**替代 `test-host-routes.mjs`：这里验证的是「模块是对的」，那里验证的是
 * 「DSH 里跑的确实是这个模块」。ESM 模块缓存不会因为开关插件而失效 —— 这条是实测
 * 撞出来的，也是这两个门禁必须同时存在的原因。
 *
 * 用法：node tools/simulate-host-boot.mjs [--no-live]
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkHostRoutes } from './lib/host-route-checks.mjs';
// 假上下文与挂载逻辑抽到了 host-harness.mjs，与 test-action-chain.mjs 共用同一份。
// 各写一份的话，两份的「假上下文宽容度」迟早分叉，而那份宽容度正是这套门禁唯一的防线。
import { PLUGIN_ENTRY_PATH, ROUTE_PREFIX, createMockContext, mountHandler } from './lib/host-harness.mjs';

const LIVE = !process.argv.includes('--no-live');

/*
 * ── 把 `DSH_HOME` 指到一个临时目录：这道门禁**不许继承用户的设置** ──────────
 *
 * 血案现场：机器上把 TTS 引擎切成「自定义服务」（`settings.json` 里
 * `ttsEngine: "custom"` + `ttsEndpoint: http://127.0.0.1:9881/tts`）之后，
 * 这道门禁突然红了 5 项 —— 空文本的码从 `E_TTS_EMPTY_TEXT` 变成
 * `E_TTS_TEXT_EMPTY`、`degrade` 从 `null` 变成 `"system"`、超长文本变成
 * `E_TTS_UPSTREAM_BAD_STATUS`。**产品一行没坏**，是门禁在按用户偏好跑：
 * Host 的 `resolveTtsSettings()` 读的就是 `<DSH_HOME>/live2d-pet/settings.json`。
 *
 * 一道「用户改了面板设置它就红」的门禁比没有门禁更糟——它会教人忽略红色，
 * 而红色本来是用来提醒「重启前的自检」的。所以这里把 `DSH_HOME` 换成空目录：
 * 没有 `settings.json` → 一切取默认值（edge 引擎）→ 断言有意义且与机器无关。
 *
 * 为什么不是给 TTS 设置加环境变量覆盖：那是**故意不做**的设计（见
 * `lib/index.js` 里 `resolveTtsSettings()` 上方那段注释）——用户的偏好只该有
 * 一个来源，加第二条就成了「面板显示云希、念出来却是晓晓」。
 */
const ISOLATED_DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-host-boot-home-'));
process.env.DSH_HOME = ISOLATED_DSH_HOME;


const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
    failures.push(label);
  }
}

/* ── [1] 模块可以被导入（这一步失败就说明重启也救不了） ───────────────── */
console.log('[1] 导入 Host 半区模块');
let mod;
try {
  mod = await import(pathToFileURL(PLUGIN_ENTRY_PATH).href);
  check('模块导入成功', true);
} catch (error) {
  check('模块导入成功', false, String(error?.message ?? error));
  console.log('\n[x] HOST BOOT GATE FAILED：模块在求值期就抛了，DSH 重启后插件不会激活');
  process.exit(1);
}

check('导出 name 正确', mod.name === 'dsh-live2d-pet', String(mod.name));
check('导出 inject 含 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'), JSON.stringify(mod.inject));
check('导出 apply 是函数', typeof mod.apply === 'function');
check(
  '顶层没有引入 ws（惰性加载的证明：模块在没装 ws 时也能导入）',
  !/\brequire\(['"]ws['"]\)|from\s+['"]ws['"]/.test(String(mod.apply)),
);

/* ── [2] apply 能跑起来，并注册了预期的东西 ───────────────────────────── */
console.log('\n[2] 用假上下文执行 apply');

/*
 * ★ modelsRoot **必须**显式传一个临时目录。
 *
 * 这里踩过一次真实的坑：原来只传 `{ maxFps: 60 }`，于是插件走 `resolveModelsRoot`
 * 的四级回退，最后落到用户 `settings.json` 里那个**真实模型库**。后果是门禁里
 * 「导入成功」那几条断言往用户的库目录里真的写进了 `测试模型`、`测试模型 (2)` …
 * 用户打开列表会看见几个自己从没放过的模型，而且不知道怎么删。
 *
 * 教训不是「记得传参数」，而是「**门禁必须证明自己没碰真实环境**」——
 * 所以下面除了传参数，还有一条断言检查解析出来的 modelsRoot 确实在临时目录里。
 */
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-live2d-hostboot-'));

/*
 * 往临时库里放一个**真的**官方样本模型。
 *
 * 空的模型库会让「每项带体检字段」「ok 与 problems 自洽」「摘要与列表自洽」
 * 这些断言全部退化成「无法证伪」—— 门禁看着是绿的，其实什么都没验。
 * 选 Wanko 是因为它最小（0.7MB）、且是 moc3 v1：一个来自另一个格式世代的样本
 * 比再放一个 v5 更能说明扫描器不是只对某一种版本有效。
 */
const SAMPLE = resolve('work/sdk5/CubismSdkForWeb-5-r.5/Samples/Resources/Wanko');
if (existsSync(SAMPLE)) {
  cpSync(SAMPLE, join(tempRoot, 'Wanko'), { recursive: true });
} else {
  console.log(`      ⚠ 找不到样本模型 ${SAMPLE}，模型库断言会退化成「无法证伪」`);
}

const env = createMockContext();
let pluginApi;
try {
  pluginApi = mod.apply(env.ctx, { maxFps: 60, modelsRoot: tempRoot });
  check('apply 不抛', true);
} catch (error) {
  check('apply 不抛', false, String(error?.message ?? error));
}

if (failures.length > 0) {
  console.log('\n[x] HOST BOOT GATE FAILED：apply 阶段就失败了，后面的断言没有意义');
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}

check(
  '注册了 1 条路由且是 prefix 类型',
  env.registrations.length === 1 && env.registrations[0].kind === 'prefix',
  `${env.registrations.length} 条`,
);
check('路由前缀正确', env.registrations[0]?.path === ROUTE_PREFIX, String(env.registrations[0]?.path));
check('注册了 dispose effect', env.effects.length >= 1, `${env.effects.length} 个`);
check('通过 provide 暴露了 live2dPet 服务', env.provided.has('live2dPet'));
check('live2dPet.status() 可调用', typeof env.provided.get('live2dPet')?.status === 'function');
check(
  '注册了 live2d_status 与 live2d_speak 两个工具',
  env.tools.some((t) => t.name === 'live2d_status') && env.tools.some((t) => t.name === 'live2d_speak'),
  env.tools.map((t) => t.name).join(', '),
);
check('apply 返回了 state 与 modelsRoot', typeof pluginApi?.modelsRoot === 'string', String(pluginApi?.modelsRoot));
/*
 * ★ 隔离断言：门禁**证明**自己用的是临时目录，而不是相信上面那行 `modelsRoot`
 * 参数确实生效了。少了这一条，参数名写错（`modelRoot`？`modelsDir`？）会静默
 * 退回用户真实模型库，而那时唯一的迹象就是「用户的库里多了几个模型」——
 * 用户不会知道那是门禁干的。
 */
check(
  '★ modelsRoot 落在临时目录里（门禁没有碰用户的真实模型库）',
  resolve(pluginApi?.modelsRoot ?? '') === resolve(tempRoot),
  `${pluginApi?.modelsRoot} vs ${tempRoot}`,
);
check('启动日志里有 modelsRoot', env.logs.some((line) => line.includes('modelsRoot')), String(env.logs[0] ?? '').slice(0, 100));

/*
 * ── [2b] 「还没有能力清单」时的行为 ──────────────────────────────────────
 *
 * 这一段**必须**放在 [3] 的 `checkHostRoutes()` 之前：那组断言里有一轮
 * `/capabilities` 往返测试会把清单写进去。放后面的话这一段就永远测不到
 * `capabilities === null` 那条路径 —— 第一次跑正是这样，`set_expression`
 * 报的是「没有这个表情」而不是「还没有清单」，看着像功能坏了、其实是夹具晚了。
 *
 * 所以这里先把 http 服务器挂上（[3] 复用同一个），拿到 `base` 才能查 `/pending`
 * 与 `/status`。
 */
const { server, port } = await mountHandler(env.registrations[0].handler);
const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`;

/*
 * ── [2c] 渲染端上报的失败必须**回到会话里** ──────────────────────────────
 *
 * 起因是「miku 跑一段时间后画面冻住」那次故障：面板上的 fps 停在最后一帧、
 * 没有弹窗、也没有任何地方能看见原因。客户端为此加了帧循环 try/catch 与停摆看门狗，
 * 而这两处都只走 `reportFailure()` —— 它把消息 `sendBeacon` 到 `/client-error`，
 * Host 存进 `state.clientErrors`。
 *
 * **存下来不等于看得见。** 这一段守的就是最后那一跳：`live2d_status` 的 `detail`
 * 里必须出现那条消息。少了它，下一次复现时 `clientErrors` 里躺着确切的原因，
 * 而 AI（和用户）谁也看不到，等于没加。
 *
 * 为什么排在这里而不是跟着 `[4c]` 走：**这一段必须从「一条都没有」出发**。
 * `[3]` 的 `checkHostRoutes()` 自己会往 `/client-error` 发两条（一条正常、一条畸形），
 * 排在它后面就只能验「N 条」的措辞，而「0 条」「1 条」两种措辞永远验不到 ——
 * 这正好是 §8.14 那条教训：**凡是要断言「这个计数器等于几」，先问它在这次运行里
 * 是不是已经涨过了。**
 *
 * POST 走**真实 HTTP**：`/client-error` 是一条公开路由，「Host 收得到」本身就是被验的一部分。
 */
console.log('\n[2c] 渲染端上报的失败要回到 live2d_status 的 detail 里');

const statusToolNow = () => env.tools.find((t) => t.name === 'live2d_status').execute({});
const postClientError = (body) => fetch(`${base}/client-error`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});

// 前提：此刻一条都没有。这是本段其它断言的立足点，不成立就要当场说出来。
const errState0 = await (await fetch(`${base}/status`)).json();
check('[2c] 前提：这一刻 clientErrors 还是空的（否则下面的措辞断言无从验起）',
  Array.isArray(errState0?.clientErrors) && errState0.clientErrors.length === 0,
  `共 ${errState0?.clientErrors?.length ?? '(字段不存在)'} 条`);

const cleanStatus = await statusToolNow();
check('★ 没有上报过错误时，detail 明确说「客户端错误：无」（不是「0 条」）',
  String(cleanStatus?.detail ?? '').includes('客户端错误：无'),
  String(cleanStatus?.detail ?? '').slice(-60));

/*
 * ★ 存活自证不算故障 —— 但必须被数出来。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────
 *
 * `client-alive` / `client-stage-mounted` / `frame-live` 三条走的是**同一条上报
 * 通道**（`reportFailure` → `sendBeacon` → `/client-error`），但它们说的都是
 * 「我跑到了 / 我拿到了像素」，不是「我坏了」。
 *
 * 若把它们混进故障里计数，`live2d_status` 会在一切正常时报「客户端错误：1 条」——
 * 而排查卡死时「有故障」与「没故障」是相反的两个方向，我自己就被这种噪音
 * 引偏过一次（见 `进度快照.md` §8.29 教训 5）。
 *
 * 反过来，**直接把它们丢掉**也不行：它们是「上报通道是通的」这件事的**唯一**证据。
 * 丢了之后，`客户端错误：无` 又会同时对应「真没坏」与「护栏根本没在跑」。
 * 所以规矩是：不计入故障，但要说出来。
 */
await postClientError(JSON.stringify({
  scope: 'client-stage-mounted',
  message: '渲染舞台已挂载并开始排帧（本条不是故障）：模型=miku/miku.model3.json。',
}));
await postClientError(JSON.stringify({
  scope: 'frame-live',
  message: '画面活性探针自证（本条不是故障）：已采样 5 次。',
}));
const selfProofStatus = await statusToolNow();
const selfProofDetail = String(selfProofStatus?.detail ?? '');
check('★ 两条存活自证不会把「无故障」变成「2 条」',
  selfProofDetail.includes('客户端错误：无'),
  selfProofDetail.slice(-120));
check('★ 但它们被数出来、并写明是自证（丢了它们，「无故障」就又不可信了）',
  selfProofDetail.includes('存活自证') && selfProofDetail.includes('client-stage-mounted'),
  selfProofDetail.slice(-120));

await postClientError(JSON.stringify({
  scope: 'frame-stall',
  message: '渲染循环已 7 秒没有画出一帧（maxFps=60）。',
  stack: '',
}));
const oneStatus = await statusToolNow();
check('★ 上报一条之后，它的 scope 与 message 都出现在 detail 里',
  String(oneStatus?.detail ?? '').includes('frame-stall')
    && String(oneStatus?.detail ?? '').includes('7 秒没有画出一帧'),
  String(oneStatus?.detail ?? '').slice(-90));
check('★ 恰好一条时措辞是「1 条 ——」，不带「（最后一条）」',
  String(oneStatus?.detail ?? '').includes('客户端错误：1 条 ——')
    && !String(oneStatus?.detail ?? '').includes('客户端错误：1 条（最后一条）'),
  String(oneStatus?.detail ?? '').slice(-90));
check('★ 返回值里**没有**多余字段 —— 上报的原文只走 detail，不另开一个键',
  oneStatus !== null && typeof oneStatus === 'object' && !('clientErrors' in oneStatus),
  Object.keys(oneStatus ?? {}).join(', '));

await postClientError(JSON.stringify({ scope: 'frame', message: '帧循环抛错（累计 3 次）：boom' }));
const twoStatus = await statusToolNow();
check('★ 两条时措辞变成「2 条（最后一条）」，且报的是**最新**那条（scope 与 message 都对得上）',
  String(twoStatus?.detail ?? '').includes('客户端错误：2 条（最后一条）')
    && String(twoStatus?.detail ?? '').includes('frame：帧循环抛错（累计 3 次）：boom'),
  String(twoStatus?.detail ?? '').slice(-100));

/*
 * 坏 JSON：这是一条谁都能 POST 的路由，一个畸形请求体**不能让 `live2d_status`
 * 整个挂掉** —— 那是 AI 查状态的唯一入口，它一挂 AI 就彻底瞎了。
 */
await postClientError('这不是 JSON {{{');
const garbageStatus = await statusToolNow();
check('★ 畸形上报不会让 live2d_status 抛，且原文被当消息带出来',
  String(garbageStatus?.detail ?? '').includes('这不是 JSON'),
  String(garbageStatus?.detail ?? '').slice(-90));

// 一条消息 5000 字：进 LLM 上下文前必须被截断，**并且说明截断了**。
await postClientError(JSON.stringify({ scope: 'frame', message: 'x'.repeat(5000) }));
const hugeStatus = await statusToolNow();
const hugeDetail = String(hugeStatus?.detail ?? '');
check('★ 超长消息被截断且说明「已截断，共 5000 字」（不能悄悄截）',
  hugeDetail.includes('已截断，共 5000 字') && hugeDetail.length < 1200,
  `detail 全长 ${hugeDetail.length}`);

// 本段跑完 `clientErrors` 里有 6 条（其中 2 条是存活自证）。后面只有 [3] 的
// `checkHostRoutes()` 会碰它，而它用的是 `.some(包含 marker)` —— 与条数无关，所以不必清。
console.log('\n[2b] 还没有能力清单时（模型未加载完）的指令行为');
const noCapsResult = await env.tools.find((t) => t.name === 'live2d_set_expression').execute({ name: 'smile' });
check('set_expression 被拒且码是 E_ACTION_NO_CAPABILITIES',
  noCapsResult?.ok === false && noCapsResult?.code === 'E_ACTION_NO_CAPABILITIES',
  JSON.stringify({ ok: noCapsResult?.ok, code: noCapsResult?.code }));
check('被拒时提示「稍后再试」（AI 据此知道该等而不是换名字猜）',
  String(noCapsResult?.detail ?? '').includes('稍后'), String(noCapsResult?.detail ?? '').slice(0, 90));

const motionNoCaps = await env.tools.find((t) => t.name === 'live2d_play_motion').execute({ group: 'Idle' });
check('play_motion 同样被拒', motionNoCaps?.code === 'E_ACTION_NO_CAPABILITIES', String(motionNoCaps?.code));
check('被拒的指令没有进队列（不是「先排上再说」）',
  String(motionNoCaps?.queued ?? '') !== '' && motionNoCaps?.queued === 0, String(motionNoCaps?.queued));

const lookNoCaps = await env.tools.find((t) => t.name === 'live2d_look_at').execute({ x: 5, y: 0 });
check('look_at 不需要清单，放行', lookNoCaps?.ok === true, String(lookNoCaps?.detail ?? '').slice(0, 80));
check('look_at 的越界值被夹到 1', lookNoCaps?.ok === true && String(lookNoCaps.detail).includes('look (1'), String(lookNoCaps?.detail ?? '').slice(0, 90));

const capsNoCaps = await env.tools.find((t) => t.name === 'live2d_list_capabilities').execute({});
check('list_capabilities 给出可读解释而不是空结果',
  String(capsNoCaps?.detail ?? '').includes('还没读到'), String(capsNoCaps?.detail ?? '').slice(0, 90));
check('list_capabilities 的数组字段是空数组而不是 undefined',
  Array.isArray(capsNoCaps?.expressions) && Array.isArray(capsNoCaps?.motionGroups), JSON.stringify(capsNoCaps));

const stopNoCaps = await env.tools.find((t) => t.name === 'live2d_stop_speaking').execute({});
check('stop_speaking 永远放行（它不需要知道模型有什么）', stopNoCaps?.ok === true, String(stopNoCaps?.detail ?? '').slice(0, 80));

const earlyDrain = await (await fetch(`${base}/pending`)).json();
check('[2b] 队列里只有 look 与 stop 两条', earlyDrain?.items?.length === 2,
  JSON.stringify(earlyDrain?.items?.map((i) => i.command?.kind)));
check('[2b] 两种指令的 kind 正确',
  earlyDrain?.items?.[0]?.command?.kind === 'look' && earlyDrain?.items?.[1]?.command?.kind === 'stop',
  JSON.stringify(earlyDrain?.items?.map((i) => i.command?.kind)));
check('[2b] stop 的 priority 是 100（§4.1：必须立即执行）',
  earlyDrain?.items?.[1]?.command?.priority === 100, String(earlyDrain?.items?.[1]?.command?.priority));
check('[2b] look 的 x 被夹到 1', earlyDrain?.items?.[0]?.command?.payload?.look?.x === 1,
  JSON.stringify(earlyDrain?.items?.[0]?.command?.payload));

const statusNoCaps = await (await fetch(`${base}/status`)).json();
check('★ /status 带 commands 诊断块（AI 到底发了什么）',
  statusNoCaps?.commands !== undefined && typeof statusNoCaps.commands.queued === 'number',
  JSON.stringify(statusNoCaps?.commands));
check('commands 记录最后一条指令的摘要',
  String(statusNoCaps?.commands?.lastSummary ?? '').includes('stop'),
  String(statusNoCaps?.commands?.lastSummary));
check('commands 记录被拒的指令不算入队（lastKind 仍是 stop）',
  statusNoCaps?.commands?.lastKind === 'stop', String(statusNoCaps?.commands?.lastKind));

/* ── [3] 完整路由断言（服务器已在 [2b] 挂好） ────────────────────────── */
console.log('\n[3] 在同一个服务器上跑完整路由断言');
console.log(`      ${base}`);

/*
 * `allowImport: true` 只有这里能传：`simulate-host-boot.mjs` 的 modelsRoot 是
 * 临时目录，往里面写测试模型没有副作用。`test-host-routes.mjs` 打的是用户
 * 真实的模型库，绝不允许（见 `lib/host-route-checks.mjs` 的说明）。
 */
const routeFailures = await checkHostRoutes(base, { live: LIVE, expectFresh: true, allowImport: true, allowStageProbe: true });
failures.push(...routeFailures.map((f) => `[路由] ${f}`));

/* ── [4] Agent 工具 → 队列 → 渲染进程 这条链 ─────────────────────────── */
console.log('\n[4] live2d_* 工具 → /pending → 渲染进程 这条链');
const speakTool = env.tools.find((t) => t.name === 'live2d_speak');
const queued = await speakTool.execute({ text: '门禁测试的一句话。' });
check('live2d_speak 返回 queued（数字，表示队列里现有几条）',
  typeof queued?.queued === 'number' && queued.queued >= 1,
  String(queued?.detail ?? '').slice(0, 90));
check('live2d_speak 带 ok=true 与空错误码', queued?.ok === true && queued?.code === '');

const drained = await (await fetch(`${base}/pending`)).json();
check('队列里取到 1 条', drained?.items?.length === 1, JSON.stringify(drained?.items));
const first = drained?.items?.[0];
check('条目带归一化后的 command（P3 的新契约）',
  first?.command?.kind === 'say'
    && first.command.payload?.text === '门禁测试的一句话。'
    && typeof first.command.ttlMs === 'number'
    && typeof first.command.priority === 'number',
  JSON.stringify(first?.command));
check('条目带 id 与 at（队列诊断用）',
  typeof first?.id === 'number' && typeof first?.at === 'number',
  JSON.stringify({ id: first?.id, at: first?.at }));
/*
 * 兼容垫片：旧客户端只认 `{ kind: 'speak', text }`。Host 重启之后、浏览器刷新
 * 之前的那段窗口里，桌宠还能不能说话全靠这三个字段。
 */
check('★ 兼容垫片：顶层仍然有 kind="speak" / text / at（旧客户端能读）',
  first?.kind === 'speak' && first?.text === '门禁测试的一句话。' && typeof first?.at === 'number',
  JSON.stringify({ kind: first?.kind, text: first?.text }));

const drainedAgain = await (await fetch(`${base}/pending`)).json();
check('/pending 取走即清空（第二次为空）', drainedAgain?.items?.length === 0);

const emptyTool = await speakTool.execute({ text: '   ' });
check('空文本不进队列', emptyTool?.ok === false && emptyTool?.code === 'E_ACTION_EMPTY_TEXT',
  JSON.stringify({ ok: emptyTool?.ok, code: emptyTool?.code }));

/* ── [4b] P3：有清单之后的工具行为（清单由上面 [3] 的路由断言写入） ──── */
console.log('\n[4b] P3 的其余 live2d_* 工具（清单已就位）');
const toolNames = env.tools.map((t) => t.name);
for (const name of ['live2d_play_motion', 'live2d_set_expression', 'live2d_look_at', 'live2d_emote', 'live2d_param', 'live2d_stop_speaking', 'live2d_list_capabilities']) {
  check(`注册了 ${name}`, toolNames.includes(name), toolNames.join(', '));
}

const tool = (name) => env.tools.find((t) => t.name === name);

// 清单来自 `[3]` 里 POST 上去的那一份：表达式「开心」、动作组 Idle(2)。
const goodExpr = await tool('live2d_set_expression').execute({ name: '开心' });
check('存在的表达式被接受', goodExpr?.ok === true, String(goodExpr?.detail ?? '').slice(0, 90));
check('提示里说清了排的是哪个表达式', String(goodExpr?.detail ?? '').includes('开心'), String(goodExpr?.detail ?? '').slice(0, 90));

const badExpr = await tool('live2d_set_expression').execute({ name: 'smile' });
check('不存在的表达式被拒', badExpr?.ok === false && badExpr?.code === 'E_EXPRESSION_NOT_FOUND',
  JSON.stringify({ ok: badExpr?.ok, code: badExpr?.code }));
check('★ 错误里带出可用表达式列表（§4.1 硬规则 2：可自愈）',
  String(badExpr?.detail ?? '').includes('开心'), String(badExpr?.detail ?? '').slice(0, 120));
check('被拒的指令没有进队列', badExpr?.queued === 0, String(badExpr?.queued));

const badGroup = await tool('live2d_play_motion').execute({ group: '跳舞' });
check('不存在的动作组被拒', badGroup?.code === 'E_MOTION_GROUP_NOT_FOUND', String(badGroup?.code));
check('错误里带出可用动作组', String(badGroup?.detail ?? '').includes('Idle'), String(badGroup?.detail ?? '').slice(0, 120));

const oobIndex = await tool('live2d_play_motion').execute({ group: 'Idle', index: 9 });
check('越界的动作序号被拒', oobIndex?.code === 'E_MOTION_INDEX_OUT_OF_RANGE', String(oobIndex?.code));

const goodMotion = await tool('live2d_play_motion').execute({ group: 'Idle' });
check('存在的动作组被接受', goodMotion?.ok === true, String(goodMotion?.detail ?? '').slice(0, 90));

const mouthParam = await tool('live2d_stop_speaking').execute({});
check('stop_speaking 放行', mouthParam?.ok === true);

const capsList = await tool('live2d_list_capabilities').execute({});
check('list_capabilities 报出表达式', Array.isArray(capsList?.expressions) && capsList.expressions.includes('开心'), JSON.stringify(capsList?.expressions));
check('list_capabilities 报出动作组（带动作数）',
  Array.isArray(capsList?.motionGroups) && capsList.motionGroups.some((g) => g.includes('Idle')), JSON.stringify(capsList?.motionGroups));
check('list_capabilities 的 detail 里说明「不要编造」', String(capsList?.detail ?? '').includes('不要编造'), String(capsList?.detail ?? '').slice(0, 90));

const after = await (await fetch(`${base}/pending`)).json();
const kinds = (after?.items ?? []).map((i) => i.command?.kind);
check('放行的指令都进了队列', kinds.length === 3, JSON.stringify(kinds));
check('队列顺序与调用顺序一致', JSON.stringify(kinds) === JSON.stringify(['expression', 'motion', 'stop']), JSON.stringify(kinds));
check('★ stop 的 priority 是 100（§4.1：必须立即执行）',
  after?.items?.[2]?.command?.priority === 100, String(after?.items?.[2]?.command?.priority));
check('motion 的 fadeMs 用了默认 300',
  after?.items?.[1]?.command?.payload?.motion?.fadeMs === 300, JSON.stringify(after?.items?.[1]?.command?.payload));
check('motion 的 index 落在 [0,2) 内（省略时随机挑且不越界）',
  [0, 1].includes(after?.items?.[1]?.command?.payload?.motion?.index),
  String(after?.items?.[1]?.command?.payload?.motion?.index));
check('被拒的指令一条都没进队列（没有「先排上再说」）',
  !kinds.includes('param'), JSON.stringify(kinds));

/* ── [4b-状态] 回合的开始与结束：思考态、说完回正（`host/mood.js`） ────── */
console.log('\n[4b-状态] 回合开始 → 思考态；回合结束 → 收掉它');

/*
 * 这一段守的是 D 期最容易被忽略的那条链：**没有情绪词的那些回合**。
 *
 * `agent/assistant-stream` 是 DSH 的**进程本地事件** —— 订阅它不花一个 token、
 * 不占一次工具调用（`cordis_inspect_query` 的 host/Event 契约：`start` / `chunk`
 * / `end` 三种 frame）。它的 `start`/`end` 决定她「在想 / 说完了」，与我说的话里
 * 有没有情绪词无关。C 期做完之后这一点恰恰最缺：埋头算一道题、连调十次工具、
 * 三十秒不出一句带情绪词的话 —— 屏幕上那个人完全静止，和掉线长得一样。
 *
 * 这里不 mock 事件处理器，而是**真的 emit 一帧**进总线，再从真的 `/pending` 与
 * `/status` 里把结果读出来：与真实运行时走同一段代码。
 *
 * 放在 `[4b-情绪]` **之前**是必要的，不是排版：显式情绪会置 6 秒的静默期
 * （`state.emotionMuteUntil`），而思考态受它管辖 —— 先跑 emote 那一段会让这里
 * 永远看到「不推」，于是这一段的断言全部退化成无法证伪。
 */
process.env.DSH_LIVE2D_AUTO_EMOTION = '1'; // 与 `settings.json` 里的用户开关解耦
const moodAgent = { sessionId: 'boot-mood-session' };
const moodFrames = {
  start: { type: 'start', attemptId: 'boot-turn-1' },
  end: { type: 'end', attemptId: 'boot-turn-1', outcome: { kind: 'committed', eventType: 'turn', seq: 1 } },
};

const statusOf = async () => (await (await fetch(`${base}/status`)).json());

const idleStatus = await statusOf();
check('★ 还没说话时状态是「闲着」（诊断面能回答「她现在在干什么」）',
  idleStatus?.mood?.state === 'idle', JSON.stringify(idleStatus?.mood ?? null));

env.emit('agent/assistant-stream', { agent: moodAgent, frame: moodFrames.start });
const moodQueue = await (await fetch(`${base}/pending`)).json();
const thinkingItem = (moodQueue?.items ?? []).find((i) => i.command?.payload?.emotion?.name === '思考');
check('★ 回合开始 → 队列里真的多出一条「思考」',
  thinkingItem !== undefined,
  JSON.stringify((moodQueue?.items ?? []).map((i) => i.command?.payload?.emotion?.name ?? i.command?.kind)));
check('★ 思考态强度 0.5（底噪；真实情绪必须一眼盖过它）',
  thinkingItem?.command?.payload?.emotion?.intensity === 0.5,
  String(thinkingItem?.command?.payload?.emotion?.intensity));
check('★ 思考态保持 30 秒（它的寿命由「回合什么时候结束」决定，不由内容）',
  thinkingItem?.command?.payload?.emotion?.holdMs === 30000,
  String(thinkingItem?.command?.payload?.emotion?.holdMs));
check('思考态淡入 420ms（渐起，不是反应）',
  thinkingItem?.command?.payload?.emotion?.attackMs === 420,
  String(thinkingItem?.command?.payload?.emotion?.attackMs));
check('思考态带着参数包（不是一个只有名字的空指令）',
  Object.keys(thinkingItem?.command?.payload?.emotion?.params ?? {}).length > 0,
  JSON.stringify(thinkingItem?.command?.payload?.emotion?.params ?? null).slice(0, 200));
check('思考态也算「自动情绪」（同一个 origin，占同一个队列配额）',
  thinkingItem?.origin === 'stream', String(thinkingItem?.origin));

const thinkingStatus = await statusOf();
check('★ `/status` 说她在思考（回合进行中）',
  thinkingStatus?.mood?.state === 'thinking', String(thinkingStatus?.mood?.state));
check('状态里带着这一轮的回合号（对账用）',
  thinkingStatus?.mood?.turnId === 'boot-turn-1', String(thinkingStatus?.mood?.turnId));
check('每个回合的思考态单独计数（`moodPushes` 与「跟着话动」的 `pushes` 不是一笔账）',
  thinkingStatus?.streamEmotion?.moodPushes >= 1,
  JSON.stringify(thinkingStatus?.streamEmotion ?? null));

const thinkingTool = await statusToolNow();
check('★ `live2d_status` 的正文里也写着她在想（我看得见）',
  /思考/.test(String(thinkingTool?.detail ?? '')), String(thinkingTool?.detail ?? '').slice(0, 200));

env.emit('agent/assistant-stream', { agent: moodAgent, frame: moodFrames.end });
const settledQueue = await (await fetch(`${base}/pending`)).json();
const queueKinds = (settledQueue?.items ?? []).map(
  (i) => i.command?.payload?.emotion?.release ?? i.command?.payload?.emotion?.name ?? i.command?.kind,
);
check('★ 走完一步时**不推任何东西**（`end` 帧是按步来的：逐步清脸会把我点名让她保持的情绪一起抹掉）',
  (settledQueue?.items ?? []).every(
    (i) => i.command?.payload?.emotion?.name !== '平静'
      && !Array.isArray(i.command?.payload?.emotion?.release),
  ),
  JSON.stringify(queueKinds));

const settledStatus = await statusOf();
check('★ 状态跟着走到「说完了」', settledStatus?.mood?.state === 'settling', String(settledStatus?.mood?.state));

/*
 * 坏帧不许炸总线：这条路是**进程本地事件**，别人（别的插件）也会 emit 它。
 * 一帧形状不对就抛异常，等于把整条流式链断在自己家里。
 */
let busSurvived = true;
for (const broken of [null, {}, { frame: null }, { agent: moodAgent }, { agent: moodAgent, frame: { type: 'chunk' } }]) {
  try {
    env.emit('agent/assistant-stream', broken);
  } catch (error) {
    busSurvived = false;
    check(`坏帧不许炸：${JSON.stringify(broken)}`, false, String(error?.message ?? error));
  }
}
check('★ 五种残缺的帧都不会把事件总线炸掉', busSurvived);
check('坏帧之后状态没有被改坏（还在「说完了」）',
  (await statusOf())?.mood?.state === 'settling');

/*
 * ★ 收思考态发生在**说完 8 秒之后**（`MOOD_SETTLING_MS`）—— 也就是状态真的回到
 * `idle` 的那一刻，而不是每一步结束时。所以这一段必须真的等：等到就往下走，
 * 通常 8 秒出头。等的是**用户看得见的那件事** —— 我停下之后，她脸上那张思考脸
 * 会自己松开，而且只松开那一层。
 *
 * ★ 它是这一段里**唯一烧墙上时间**的部分，所以排在最后：排在前面的话，后面那些
 * 「状态是不是还在说完了」的断言会因为它把状态推到了 `idle` 而全部读错（第一版
 * 就是这样红的 —— 红的不是代码，是顺序）。
 */
const waitUntil = async (probe, budgetMs) => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const idleAgain = await waitUntil(async () => {
  const status = await statusOf();
  return status?.mood?.state === 'idle' ? status : null;
}, 15000);
check('★ 说完 8 秒后状态自己回到「闲着」（过期不是措辞问题，是状态问题）',
  idleAgain !== null, JSON.stringify((await statusOf())?.mood ?? null));

const releaseQueue = await (await fetch(`${base}/pending`)).json();
const releaseItem = (releaseQueue?.items ?? []).find(
  (i) => Array.isArray(i.command?.payload?.emotion?.release),
);
check('★ 到期时真的推出一条「按名字收掉思考态」（不是「平静」那种一把全清）',
  releaseItem !== undefined
  && (releaseItem?.command?.payload?.emotion?.release ?? []).includes('思考'),
  JSON.stringify((releaseQueue?.items ?? []).map((i) => i.command?.kind)));
check('收的那一条既没有名字也没有参数（它是「只收」，不是又一个表情）',
  releaseItem?.command?.payload?.emotion?.name === undefined
  && Object.keys(releaseItem?.command?.payload?.emotion?.params ?? {}).length === 0,
  JSON.stringify(releaseItem?.command?.payload?.emotion ?? null));

delete process.env.DSH_LIVE2D_AUTO_EMOTION;
// 清空队列：`[4b-情绪]` 那一段读的是 `items[0]`，这里不清就会读到思考态。
await fetch(`${base}/pending`);

/* ── [4b-情绪] `live2d_emote`：情绪层这条新链（Host 半区真跑一遍） ────── */
console.log('\n[4b-情绪] live2d_emote → emotion 指令 → 对话里的情绪标记');

const emote = await tool('live2d_emote').execute({ name: '开心' });
check('★ 情绪指令被接受（能力清单里有它要的参数）', emote?.ok === true, String(emote?.detail ?? '').slice(0, 160));
check('★ 正文逐条列出叠了哪些参数（「显式可检查」这条设计价值观的落点）',
  /Param[A-Za-z]+ [+-]\d/.test(String(emote?.detail ?? '')),
  String(emote?.detail ?? '').slice(0, 200));

const emoteQueue = await (await fetch(`${base}/pending`)).json();
const emoteItem = emoteQueue?.items?.[0];
check('★ 队列里那条是 emotion 指令，且带着参数包',
  emoteItem?.command?.kind === 'emotion'
    && emoteItem.command.payload?.emotion?.name === '开心'
    && Object.keys(emoteItem.command.payload.emotion.params ?? {}).length > 0,
  JSON.stringify(emoteItem?.command ?? null).slice(0, 240));
check('情绪指令带 priority 与 ttlMs（和其它指令同一套队列语义）',
  typeof emoteItem?.command?.priority === 'number' && typeof emoteItem?.command?.ttlMs === 'number',
  JSON.stringify({ p: emoteItem?.command?.priority, ttl: emoteItem?.command?.ttlMs }));
check('情绪指令的 priority 是 50（表现类，不打断说话）',
  emoteItem?.command?.priority === 50, String(emoteItem?.command?.priority));

/*
 * ★ 开关管的是「说不说」，不是「做不做」。
 * 关掉之后：指令照进队列（她脸上照做），但正文不再逐条列参数。
 */
process.env.DSH_LIVE2D_EMOTION_MARKER = '0';
const emoteQuiet = await tool('live2d_emote').execute({ name: '难过' });
delete process.env.DSH_LIVE2D_EMOTION_MARKER;
check('★ 关掉情绪标记后：指令照旧排队（开关不管「做不做」）', emoteQuiet?.ok === true,
  String(emoteQuiet?.detail ?? '').slice(0, 120));
check('★ 关掉情绪标记后：正文不再逐条列参数',
  !/Param[A-Za-z]+ [+-]\d/.test(String(emoteQuiet?.detail ?? '')),
  String(emoteQuiet?.detail ?? '').slice(0, 160));

const quietQueue = await (await fetch(`${base}/pending`)).json();
check('关掉标记后那条仍然带着完整参数包（渲染端拿到的没变）',
  (quietQueue?.items ?? []).some((i) => i.command?.kind === 'emotion'
    && Object.keys(i.command.payload?.emotion?.params ?? {}).length > 0),
  JSON.stringify((quietQueue?.items ?? []).map((i) => i.command?.kind)));

const emoteUnknown = await tool('live2d_emote').execute({ name: '暴躁' });
check('未知情绪被拒，且正文列出可用名字（自愈）',
  emoteUnknown?.ok === false && String(emoteUnknown?.detail ?? '').includes('开心'),
  String(emoteUnknown?.detail ?? '').slice(0, 140));

/* ── [4b-参数] `live2d_param`：参数逃生通道的出口 ──────────────────────── */
console.log('\n[4b-参数] live2d_param → param 指令（P3 就实现了，一直没有出口）');

/*
 * 这一段是补出来的，起因是一次真实对话：用户让我「把眼睛闭起来」。
 *
 * 9 个情绪词里没有「闭眼」，而情绪层是**加法** —— 它叠在眨眼之上，眨眼每帧
 * 仍然写 1.0，所以加法永远钉不住一只眼睛（`0.7 - 1.0` 还是被眨眼拉回来）。
 * 那件事只能靠硬写，而硬写那条通道（`kind: 'param'`）当时**没有任何工具能产生**：
 * `test-actions.mjs` 的 [7] 一直在守它的规则，守的是一个没有入口的东西。
 */
const paramWrite = await tool('live2d_param').execute({ params: { ParamCheek: 0.4 }, holdMs: 1500 });
check('★ 参数逃生通道被接受（这一格在补出工具之前是空的）',
  paramWrite?.ok === true, String(paramWrite?.detail ?? '').slice(0, 140));
check('★ 正文列出写了哪个参数、什么值、保持多久（硬写不能是「黑箱成功」）',
  /ParamCheek=0\.4/.test(String(paramWrite?.detail ?? '')) && /1500ms/.test(String(paramWrite?.detail ?? '')),
  String(paramWrite?.detail ?? '').slice(0, 200));

const mouthWrite = await tool('live2d_param').execute({ params: { ParamMouthOpenY: 0.5 } });
check('★ 口型参数写不进去（独占），理由说清了「会和说话打架」',
  mouthWrite?.ok === false && mouthWrite?.code === 'E_ACTION_PARAMETER_EXCLUSIVE'
    && /打架/.test(String(mouthWrite?.detail ?? '')),
  JSON.stringify({ ok: mouthWrite?.ok, code: mouthWrite?.code }));

const paramQueue = await (await fetch(`${base}/pending`)).json();
const paramItem = (paramQueue?.items ?? []).find((i) => i.command?.kind === 'param');
check('★ 队列里那条是 param 指令，且 ttlMs 就是保持时长（渲染端拿指令的 TTL 当保持时长）',
  paramItem?.command?.payload?.params?.ParamCheek === 0.4 && paramItem?.command?.ttlMs === 1500,
  JSON.stringify(paramItem?.command ?? null).slice(0, 200));

// 队列清空，别让下面 `[4c]` 那一轮把 8 条的额度挤爆（`MAX_PENDING` 满了会丢指令）。
await fetch(`${base}/pending`);

/* ── [4a-bindings] 参数绑定的**读点** ──────────────────────────────────────
 *
 * 写点（POST → 真的落进 settings.json）由 `tools/test-emotions.mjs` 拿临时目录验，
 * 这里只验「这条路是通的」：路由注册顺序 / 拼写错一个字母就是 404，而面板上
 * 表现成「参数绑定一直是空的」—— 没有报错、没有日志，只有那张空下拉框。
 */
const bindingsInfo = await (await fetch(`${base}/bindings`)).json();
check('/bindings 是一条真的路由（不是 404、也不是被 /model/ 之类抢走）',
  bindingsInfo?.ok === true && Array.isArray(bindingsInfo?.roles),
  JSON.stringify(bindingsInfo).slice(0, 200));
check('★ /bindings 报出全部 18 个角色，每个都有中文标签与候选表',
  (bindingsInfo?.roles ?? []).length === 18
  && (bindingsInfo?.roles ?? []).every((item) => typeof item?.label === 'string' && item.label !== ''
    && Array.isArray(item?.candidates) && typeof item?.source === 'string'),
  JSON.stringify((bindingsInfo?.roles ?? []).slice(0, 2)));
check('★ /bindings 把当前模型能绑的参数 id 列了出来（面板下拉的数据源）',
  /*
   * 这里**不能**断言某个具体参数名（`ParamAngleX` 之类）：这个门禁挂的是一个
   * 最小的假模型（`SAMPLE`），它只有十来个参数 —— 断言具体名字等于把门禁绑在
   * 那个夹具的具体形状上，夹具一换就红，而它想守的是「清单真的被透出来了」。
   */
  Array.isArray(bindingsInfo?.parameters)
  && bindingsInfo.parameters.length > 0
  && bindingsInfo.parameters.every((id) => typeof id === 'string' && id !== ''),
  `${(bindingsInfo?.parameters ?? []).length} 个参数`);
check('/bindings 的每个角色都说得清「自动选中谁 / 最终用谁」',
  (bindingsInfo?.roles ?? []).every((item) => typeof item?.auto === 'string'
    && typeof item?.resolved === 'string' && typeof item?.bindingMissing === 'boolean'),
  JSON.stringify((bindingsInfo?.roles ?? []).slice(0, 1)));

/* ── [4b-朗读] 反向通道：她「正在说 / 说完了」回到 Host（D-2） ──────────── */
console.log('\n[4b-朗读] /status 心跳带回来的朗读状态');

/*
 * ★ 这一段跑在**没有 `systemPrompt` 服务**的宿主里 —— 这个门禁的假上下文
 * 从来不给 `services`，那正是「宿主没装那个包」的样子。于是它同时守两件事：
 *
 *   1. 缺服务时只记日志、其余一切照常（`/status` 照常、工具照常）；
 *   2. 心跳查询串那条链真的把状态送进了 Host 的账本。
 *
 * 第 1 条在别处守不到：`test-reverse-channel.mjs` 为了让「注册了什么上下文、
 * 那一行写的是什么」可断言，**必须**给一个假的 `systemPrompt` —— 于是
 * 「服务不在」这条分支只有这里会真的跑一遍。
 */
const speechAlive = await (await fetch(`${base}/status?build=boot-speech&speech=1&speechState=speaking&speechQueued=1&speechStarted=1&speechSettled=0`)).json();
check('★ 心跳里的朗读字段进了账本（渲染端说「她在念」）',
  speechAlive?.speech?.speaking === true, JSON.stringify(speechAlive?.speech ?? null));
check('「念了多久」从现在开始算（而不是从进程启动算）',
  speechAlive?.speech?.since > 0 && speechAlive?.speech?.settledAt === 0,
  JSON.stringify(speechAlive?.speech ?? null));

const speechDetail = String((await tool('live2d_status').execute({}))?.detail ?? '');
check('★ 没有 systemPrompt 服务时 `live2d_status` 仍报出朗读状态（按需入口不依赖那条上下文）',
  speechDetail.includes('正在说话'), speechDetail.split('，').slice(-2).join('，'));
check('★ 缺服务这件事被说出来（而不是静默地什么都不做）',
  env.logs.some((line) => String(line).includes('[speech]')),
  env.logs.filter((line) => String(line).includes('speech')).join(' | ').slice(0, 200));

await fetch(`${base}/status?build=boot-speech&speech=1&speechState=idle&speechQueued=0&speechStarted=1&speechSettled=1`);
const speechDone = await (await fetch(`${base}/status`)).json();
check('★ 「说完了」也被记下来（这一条才是 AI 敢不敢接着开口的依据）',
  speechDone?.speech?.speaking === false && speechDone?.speech?.settledAt > 0,
  JSON.stringify(speechDone?.speech ?? null));
check('念完的句数报得出来（对账用）',
  String((await tool('live2d_status').execute({}))?.detail ?? '').includes('第 1 句'));

const speechBeforeDefault = JSON.stringify(speechDone?.speech ?? null);
await fetch(`${base}/status`);
await fetch(`${base}/status`);
const speechAfterDefault = JSON.stringify((await (await fetch(`${base}/status`)).json())?.speech ?? null);
check('★ 不带朗读字段的心跳（旧客户端 / curl）一个字都不改账本',
  speechAfterDefault === speechBeforeDefault, `${speechBeforeDefault} → ${speechAfterDefault}`);

/* ── [4c] 每一个注册过的工具都真的能调 ──────────────────────────────── */
console.log('\n[4c] 每一个 live2d_* 工具都执行一遍（「注册了」不等于「能调」）');

/*
 * 手写的极简 JSON Schema 校验器 —— 只认插件真的用到的形状。
 *
 * 存在的理由见下面那条 `output.schema` 断言的注释：不校验返回值，就会漏掉
 * 「多一个没申报的键 → 工具整个失败」这一类。返回**问题描述数组**，
 * 空数组表示通过（比抛异常更好用：断言里能直接把问题打出来）。
 */
const validateAgainstSchema = (schema, value, path = 'value') => {
  if (schema === null || typeof schema !== 'object') return [];
  const problems = [];

  const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

  if (typeof schema.type === 'string' && typeOf(value) !== schema.type) {
    return [`${path} 应为 ${schema.type}，实际是 ${typeOf(value)}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => Object.is(e, value))) {
    problems.push(`${path} 不在 enum 里：${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.items) && Array.isArray(value)) {
    value.forEach((item, i) => problems.push(...validateAgainstSchema(schema.items[0], item, `${path}[${i}]`)));
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const declared = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${path} 缺少必填键 ${key}`);
    }
    for (const key of Object.keys(value)) {
      if (!(key in declared)) {
        // 这一条就是那次事故的形状：多一个没申报的键。
        if (schema.additionalProperties === false) problems.push(`${path}.${key} 不是已申报的属性`);
        continue;
      }
      problems.push(...validateAgainstSchema(declared[key], value[key], `${path}.${key}`));
    }
  }
  return problems;
};

check('★ 校验器自己也要被验一次：多一个没申报的键必须报错',
  validateAgainstSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { a: 'x', b: 1 }).length === 1
    && validateAgainstSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { a: 'x' }).length === 0
    && validateAgainstSchema({ type: 'object', properties: { a: { type: 'number' } }, required: ['a', 'z'] }, {}).length === 2,
  '多键 / 少必填 / 类型不符三种都要报出来');

/*
 * ★ 这一段是补出来的，起因是一次真实事故。
 *
 * `live2d_status` 曾经**每一次调用都抛** `ReferenceError: capabilities is not
 * defined` —— `registerTools()` 里写了一个只存在于 `apply()` 作用域的变量名。
 * 而它偏偏是工具描述里让 AI「动手之前先调一次」的那一个，所以症状是 AI 一上来
 * 就撞一个莫名其妙的错。
 *
 * 上面 `[2]` 只断言了它**注册过**，于是门禁一直是绿的。**「注册了」与「能调」
 * 之间隔着整整一次调用** —— 所以这里逐个真调，参数表也一并写死：必填项本身
 * 就是一类知识，漏了会让下面第一条断言红。
 */
const TOOL_ARGS = {
  live2d_status: {},
  live2d_list_capabilities: {},
  live2d_stop_speaking: {},
  live2d_look_at: { x: 0, y: 0 },
  live2d_speak: { text: '工具自检。' },
  live2d_set_expression: { name: '开心' },
  live2d_play_motion: { group: 'Idle' },
  live2d_emote: { name: '开心' },
  live2d_micro_motion: {},
  live2d_param: { params: { ParamCheek: 0.4 }, holdMs: 1500 },
};

check('工具清单与参数表逐个对上（新增工具必须来这张表里登记）',
  JSON.stringify(env.tools.map((t) => t.name).slice().sort()) === JSON.stringify(Object.keys(TOOL_ARGS).slice().sort()),
  env.tools.map((t) => t.name).join(', '));

for (const spec of env.tools) {
  const args = TOOL_ARGS[spec.name] ?? {};
  let outcome = null;
  let error = null;
  try {
    outcome = await spec.execute(args);
  } catch (caught) {
    error = caught;
  }
  check(`调用 ${spec.name} 不抛异常`, error === null, error === null ? '' : String(error?.message ?? error));
  check(`${spec.name} 返回对象且 detail 非空`,
    outcome !== null && typeof outcome === 'object' && typeof outcome.detail === 'string' && outcome.detail !== '',
    JSON.stringify(outcome ?? null).slice(0, 110));

  /*
   * ★ 光「工具跑成功了」还不够 —— AI 看见的是 `output.render()` 交回去的东西。
   *
   * 契约是 `render(args, value)`：**第二个参数才是返回值**。这里曾经写成 `(args)`，
   * 于是六七个工具全部交回空字符串：桌宠照做，AI 却什么都看不到，连「渲染端未连接」
   * 那句警告也一起丢掉。而上面那条 `detail 非空` 的断言是绿的 —— 因为它看的是
   * `execute()` 的返回值，不是 AI 真正读到的东西。
   */
  let blocks = null;
  let renderError = null;
  try {
    blocks = spec.output?.render?.(args, outcome) ?? null;
  } catch (caught) {
    renderError = caught;
  }
  check(`★ ${spec.name} 的 render(args, value) 不抛`, renderError === null,
    renderError === null ? '' : String(renderError?.message ?? renderError));
  check(`★ ${spec.name} 的 render 交回非空文本（AI 只看得见这个）`,
    Array.isArray(blocks) && blocks.length > 0
      && blocks.every((b) => typeof b?.text === 'string' && b.text !== ''),
    JSON.stringify(blocks ?? null).slice(0, 110));

  /*
   * ★ 返回值必须过得了**它自己申报的 schema**。
   *
   * 这一条是补出来的，起因是一次真实事故，而且**是我自己造的**：
   * 我给 `live2d_status` 的返回值加了一个 `clientErrors` 字段，
   * 而它的 `output.schema` 是 `additionalProperties: false` 且没申报这个键 ——
   * 于是工具在真实调用时被注册表挡下来，AI 收到的是
   *   `tool "live2d_status" returned invalid output: "value.clientErrors"
   *    is not a declared property (additionalProperties: false)`
   * 而**整段门禁依旧是绿的**：上面每一条断言都直接调 `execute()` / `render()`，
   * 谁都没拿 `output.schema` 去校验返回值。**门禁绕过的那一层，正是出事的那一层。**
   *
   * 校验器是手写的（门禁脚本不带依赖）。它只认插件真的用到的形状：
   * `type` / `properties` / `required` / `additionalProperties` / `items` / `enum`。
   * 手写校验器自己也会撒谎，所以下面紧跟一条**反向验证**：喂一个多字段的对象，
   * 断言它必须报错。
   */
  const schemaProblems = validateAgainstSchema(spec.output?.schema, outcome);
  check(`★ ${spec.name} 的返回值过得了自己申报的 output.schema`,
    schemaProblems.length === 0,
    schemaProblems.slice(0, 2).join(' | '));
}

const statusTool = await tool('live2d_status').execute({});
check('★ live2d_status 报出能力清单摘要（它曾经每次都抛 ReferenceError）',
  String(statusTool?.detail ?? '').includes('能力清单：'), String(statusTool?.detail ?? '').slice(0, 130));
check('★ live2d_status 的 capabilitiesDetail 非空（清单已就位时）',
  typeof statusTool?.capabilitiesDetail === 'string' && statusTool.capabilitiesDetail.length > 0,
  String(statusTool?.capabilitiesDetail ?? '').slice(0, 90));
check('live2d_status 报出的模型库是临时目录（没有偷看用户真实的库）',
  String(statusTool?.detail ?? '').includes(tempRoot), String(statusTool?.modelsRoot ?? ''));

/* ── [5] 反向验证：门禁必须能红 ──────────────────────────────────────── */
console.log('\n[5] 反向验证：故意挂一个「什么都 404」的 handler，断言门禁会失败');
const broken = createServer((req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: 'E_ROUTE_NOT_FOUND' }));
});
const brokenPort = await new Promise((resolve) => broken.listen(0, '127.0.0.1', () => resolve(broken.address().port)));
const brokenFailures = await checkHostRoutes(`http://127.0.0.1:${brokenPort}${ROUTE_PREFIX}`, { live: false, allowStageProbe: true });
await new Promise((resolve) => broken.close(resolve));
check('坏 handler 下门禁确实报了失败', brokenFailures.length > 0, `${brokenFailures.length} 项失败`);
check('并且失败项里包含 /status', brokenFailures.some((f) => f.includes('/status')), brokenFailures.slice(0, 3).join(' | '));

/* ── [6] 卸载：路由必须真的被摘掉 ────────────────────────────────────── */
console.log('\n[6] 卸载');
await new Promise((resolve) => server.close(resolve));
for (const effect of env.effects) {
  if (typeof effect.dispose === 'function') effect.dispose();
}
check('路由已标记为 disposed', env.registrations[0]?.disposed === true);
check('卸载日志存在', env.logs.some((line) => line.includes('已卸载')), env.logs[env.logs.length - 1]);

/*
 * 临时模型库用完就删。留着的代价不是磁盘空间，而是**下一次排查时的困惑**：
 * 一个叫 `dsh-live2d-hostboot-xxxx` 的目录出现在 %TEMP% 里、里面还躺着几个模型，
 * 半年后没人知道那是谁建的。
 */
rmSync(tempRoot, { recursive: true, force: true });
check('临时模型库已清理', !existsSync(tempRoot));

// 同理由清理那个临时 DSH_HOME：里面只有子目录，但留下来同样会让未来的排查困惑。
rmSync(ISOLATED_DSH_HOME, { recursive: true, force: true });
check('临时 DSH_HOME 已清理（门禁没有碰用户设置）', !existsSync(ISOLATED_DSH_HOME));

console.log('');
if (failures.length === 0) {
  console.log('[7] HOST BOOT GATE PASSED');
} else {
  console.log(`[x] HOST BOOT GATE FAILED：${failures.length} 项未通过`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exitCode = 1;
}
