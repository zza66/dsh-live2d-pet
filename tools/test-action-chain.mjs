/**
 * ★ AI 指令**全链路**门禁 —— 方案 §5 给 P3 的验收标准原文：
 *
 *     「AI 连续 20 条指令不越界、不卡死」
 *
 * 为什么在 `test-actions.mjs`（157 项）与 `test-action-runner.mjs`（95 项）之外
 * 还要再来一道？
 *
 * 那两道各自守着一半，中间**没有人守**：
 *
 *     test-actions.mjs        →  Host 会不会把不该发的指令放进队列
 *     test-action-runner.mjs  →  渲染端拿到一条指令会不会做错事
 *     ────────────────────────────────────────────────────────────
 *     test-action-chain.mjs   →  ★ Host 放进队列的，渲染端**真的做得到**吗
 *
 * 最后这一问才是「Host 说合法、客户端做了却什么都没发生」的防线。它只在**两边连起来**
 * 的时候才暴露得出来，而那种故障的现象是「AI 说‘我笑了’，她没笑，日志全绿」。
 *
 * 做法：把 Host 半区真跑起来（真的 http 服务器 + 真的工具注册），连续发 20 条**混合**
 * 指令（一半是故意的脏输入），然后把 `/pending` 取出来，逐条喂给**真的渲染端执行层**
 * （`lib/test/action-runner.mjs`，PetModel 的同源代码），配一个「能力清单与 Host 完全
 * 一致」的假 target。两边任何一处对不上，这里就会红。
 *
 * 用法：node tools/test-action-chain.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION_KINDS,
  buildAction,
  isExclusiveParameter,
} from '../dsh-live2d-pet/lib/host/actions.js';
import { buildCapabilities } from '../dsh-live2d-pet/lib/host/capabilities.js';
import { getJson, postJson, toolByName, bootHost } from './lib/host-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const SAMPLES = join(ROOT, 'work', 'sdk5', 'CubismSdkForWeb-5-r.5', 'Samples', 'Resources');

let passed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    return true;
  }
  failures.push({ label, detail: String(detail) });
  return false;
}

/*
 * 用 Haru 而不是 `空_vts`：它是官方样本里表情最多的一只（8 个表情 / 2 个动作组），
 * 「表情与动作组真的能用」这件事必须有一只**真有这些资源**的模型才验得出来。
 * 而用户库里那两个模型都没有 `Motions` 键 —— 拿它们当夹具，「动作能播」永远无法证伪。
 */
const SAMPLE_NAME = 'Haru';
const SAMPLE_DIR = join(SAMPLES, SAMPLE_NAME);

/** 参数用一份受控清单（真实参数表要 Cubism Core，那是 test-capabilities.mjs 的职责）。 */
const CONTROLLED_PARAMETERS = [
  { id: 'ParamAngleX', min: -30, max: 30, def: 0 },
  { id: 'ParamAngleY', min: -30, max: 30, def: 0 },
  { id: 'ParamBodyAngleX', min: -10, max: 10, def: 0 },
  { id: 'ParamMouthOpenY', min: 0, max: 1, def: 0 },
  { id: 'ParamMouthForm', min: -1, max: 1, def: 0 },
  /*
   * 下面这一组是**情绪层**要用的。
   *
   * 它们的 id 是照着 Haru 自己的 `Haru.cdi3.json` 抄的（不是编的）：Haru 是官方
   * 样本里最「标准」的一只。范围仍按常规值写 —— 真实范围要 Cubism Core 才读得到，
   * 那是 `test-capabilities.mjs` 的职责，这里要的只是「清单里有这些参数」。
   *
   * ★ 它们在这里同时承担一个**证伪**任务：Haru **没有** `ParamCheek`、
   * 也没有 `ParamHairAhoge`，而「开心」这条预设两个都要。所以这一段证明的是
   * 「换一只模型，预设按角色解析、缺的角色自动跳过，而不是整条指令失败」——
   * 换装换了一半时这是唯一正确的行为。
   */
  { id: 'ParamAngleZ', min: -30, max: 30, def: 5 },
  { id: 'ParamEyeLSmile', min: 0, max: 1, def: 0 },
  { id: 'ParamEyeRSmile', min: 0, max: 1, def: 0 },
  { id: 'ParamBrowLY', min: -1, max: 1, def: 0 },
  { id: 'ParamBrowRY', min: -1, max: 1, def: 0 },
  { id: 'ParamEyeBallX', min: -1, max: 1, def: 0 },
  { id: 'ParamEyeBallY', min: -1, max: 1, def: 0 },
];

if (!existsSync(SAMPLE_DIR)) {
  console.log(`[x] 找不到夹具模型 ${SAMPLE_DIR}`);
  console.log('    它是只读的 SDK 样本。work/sdk5 缺失时这道门禁无法证明任何事，直接失败。');
  process.exit(1);
}

const settings = JSON.parse(readFileSync(join(SAMPLE_DIR, `${SAMPLE_NAME}.model3.json`), 'utf8'));
const capabilities = buildCapabilities({ settings, parameters: CONTROLLED_PARAMETERS });

const expressionNames = capabilities.expressions.map((e) => e.name);
const motionGroupNames = capabilities.motionGroups.map((g) => g.name);

console.log(`夹具：${SAMPLE_NAME} —— ${expressionNames.length} 个表情、${motionGroupNames.length} 个动作组`);
console.log(`      表情 ${JSON.stringify(expressionNames.slice(0, 4))}${expressionNames.length > 4 ? ' …' : ''}`);
console.log(`      动作组 ${JSON.stringify(motionGroupNames)}`);

if (expressionNames.length === 0 || motionGroupNames.length === 0) {
  console.log('[x] 夹具模型没有表情或没有动作组，这条链最重要的两段会退化成「无法证伪」');
  process.exit(1);
}

/* ── [1] 把 Host 半区真跑起来 ─────────────────────────────────────────── */
console.log('\n[1] 启动 Host 半区（临时模型库 + 真 http 服务器）');

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-live2d-chain-'));
cpSync(SAMPLE_DIR, join(tempRoot, SAMPLE_NAME), { recursive: true });

const host = await bootHost({ modelsRoot: tempRoot, maxFps: 60 });

check(
  '★ modelsRoot 落在临时目录里（门禁没有碰用户的真实模型库 —— 方案 §9.4）',
  resolve(host.api?.modelsRoot ?? '') === resolve(tempRoot),
  `${host.api?.modelsRoot} vs ${tempRoot}`,
);
check('路由挂载成功', typeof host.base === 'string' && host.base.startsWith('http://127.0.0.1:'));

/* ── [2] 把夹具模型的能力清单报上去（模拟渲染端加载完成后的上报） ────────── */
console.log('\n[2] 上报能力清单');
const capsPost = await postJson(host.base, '/capabilities', {
  id: `${SAMPLE_NAME}/${SAMPLE_NAME}.model3.json`,
  capabilities,
});
check('/capabilities 接收清单返回 200', capsPost.status === 200 && capsPost.json?.ok === true, `HTTP ${capsPost.status}`);

/*
 * 假 target：能力清单**与 Host 完全一致**。
 *
 * 它的每个判断都直接读上面那份 `capabilities`，而口型独占规则用的是**渲染端那个
 * `isExclusiveParameter()`**（与 pet-model.ts 同一个函数）。这样它错就等于渲染端错；
 * 两边漂移时这里的断言会红，而不是等用户看见「AI 说笑了、她没笑」。
 */
/** 情绪层那三笔账：`[4]` 段跨过整条链路来对。 */
const emotionCalls = [];
const emotionClears = [];
const emotionReleases = [];

function makeTarget() {
  const calls = [];
  /*
   * ★ 「现在脸上挂着哪几层」——假 target 自己也记一份，`releaseEmotion` 才能报出
   * 真实的 `released` / `unknown`（渲染端那句「X 当时不在场」必须是真账，不是文案）。
   * 记账规则照 `pet-model.ts` 的语义：`setEmotion` 挂上带名字的那一层、
   * `clearEmotion` 一把全清、`releaseEmotion` 只收点到的。
   */
  const upLayers = new Set();
  return {
    calls,
    motionGroupNames: () => motionGroupNames.slice(),
    /*
     * 框架读回来的「现在播的是哪一档」。
     *
     * 夹具里恒为 0（什么都没在播）—— 这一道门禁验的是「Host 放的指令渲染端做不做得到」，
     * 自动待机的时机判断由 `tools/test-action-runner.mjs` 守。但方法必须存在：
     * 真 target 有它，假 target 缺了就会在「面板打开、AI 刚说完、20 秒到了」那条路上
     * 抛 `target.currentMotionPriority is not a function` —— 那正是 §9.2 说的白屏。
     */
    currentMotionPriority: () => 0,
    async playMotion(group, index, options) {
      calls.push({ op: 'playMotion', group, index, options });
      if (!motionGroupNames.includes(group)) {
        return { ok: false, code: 'E_MOTION_GROUP_NOT_FOUND', detail: `没有动作组 ${group}` };
      }
      const count = capabilities.motionGroups.find((g) => g.name === group)?.count ?? 0;
      const i = index === undefined ? 0 : index;
      if (!Number.isInteger(i) || i < 0 || i >= count) {
        return { ok: false, code: 'E_MOTION_INDEX_OUT_OF_RANGE', detail: `${group} 只有 ${count} 个动作` };
      }
      return { ok: true, code: '', detail: '' };
    },
    async setExpression(name, options) {
      calls.push({ op: 'setExpression', name, options });
      if (!expressionNames.includes(name)) {
        return { ok: false, code: 'E_EXPRESSION_NOT_FOUND', detail: `可用：${expressionNames.join('、')}` };
      }
      return { ok: true, code: '', detail: '' };
    },
    lookAt(x, y, options) {
      calls.push({ op: 'lookAt', x, y, options });
      return { ok: true, code: '', detail: '' };
    },
    stopMotion() {
      calls.push({ op: 'stopMotion' });
    },
    clearExpression() {
      calls.push({ op: 'clearExpression' });
    },
    clearParameterOverrides() {
      calls.push({ op: 'clearParameterOverrides' });
    },
    setParameterOverride(values, holdMs) {
      calls.push({ op: 'setParameterOverride', values, holdMs });
      const applied = [];
      const dropped = [];
      const ignored = [];
      for (const [id, value] of Object.entries(values)) {
        if (isExclusiveParameter(id)) {
          dropped.push(id);
          continue;
        }
        const param = capabilities.parameters.find((p) => p.id === id);
        if (param === undefined) {
          ignored.push(id);
          continue;
        }
        applied.push([id, Math.min(Math.max(value, param.min), param.max)]);
      }
      return { applied, dropped, ignored };
    },
    /*
     * 情绪层：**加法**写入，和上面那个硬写通道分开。
     *
     * 它和 `setParameterOverride` 一样按能力清单筛参数（缺的进 `ignored`），
     * 但记在另一条账上 —— `[4]` 段要拿它证明「Host 按角色解析出来的那包参数，
     * 渲染端真的一颗不少地收到了」。
     */
    setEmotion(values, opts) {
      calls.push({ op: 'setEmotion', values, opts });
      emotionCalls.push({ values, opts });
      const applied = [];
      const dropped = [];
      const ignored = [];
      for (const [id, value] of Object.entries(values)) {
        if (isExclusiveParameter(id)) {
          dropped.push(id);
          continue;
        }
        const param = capabilities.parameters.find((p) => p.id === id);
        if (param === undefined) {
          ignored.push(id);
          continue;
        }
        applied.push(id);
      }
      /*
       * 换一层新的会让别的层退场（`pet-model.ts` 里 `setEmotion` 就是这么做的），
       * 所以账本要跟着换 —— 但只在真的写进去之后（全被忽略时她脸上什么都没变）。
       */
      if (applied.length > 0 && typeof opts?.name === 'string' && opts.name !== '') {
        upLayers.clear();
        upLayers.add(opts.name);
      }
      return { applied, dropped, ignored };
    },
    clearEmotion() {
      calls.push({ op: 'clearEmotion' });
      emotionClears.push(true);
      upLayers.clear();
    },
    /*
     * ★ 「按名字收掉指定的层」（#3）。它与 `clearEmotion` 的区别就是这一步的全部
     * 意义：`平静` 是一把全清，而这里只动点到的那些名字，别的层原样留着。
     */
    releaseEmotion(names) {
      calls.push({ op: 'releaseEmotion', names });
      emotionReleases.push(names.slice());
      const released = [];
      const unknown = [];
      for (const name of names) {
        if (upLayers.has(name)) {
          upLayers.delete(name);
          released.push(name);
        } else {
          unknown.push(name);
        }
      }
      return { released, unknown };
    },
  };
}

const runner = await import('../dsh-live2d-pet/lib/test/action-runner.mjs');

/* ── [3] ★ 连续 20 条指令 ─────────────────────────────────────────────── */
console.log('\n[3] ★ 连续 20 条指令（混合脏输入），逐条计时与断言');

const REAL_EXPR = expressionNames[0];
const REAL_GROUP = motionGroupNames[0];
const FAKE_EXPR = '绝对不存在的表情';
const FAKE_GROUP = '绝对不存在的动作组';

/**
 * 20 条指令。`expect` 是**我们对 Host 的期望**，不是实现里的常量 ——
 * 期望写错时门禁会红，那时要判断的是「实现错了还是期望错了」，而不是改测试让它绿。
 */
const COMMANDS = [
  { tool: 'live2d_speak', args: { text: '你好呀，今天过得怎么样？' }, expect: 'accept' },
  { tool: 'live2d_set_expression', args: { name: REAL_EXPR }, expect: 'accept' },
  { tool: 'live2d_set_expression', args: { name: FAKE_EXPR }, expect: 'reject' },
  { tool: 'live2d_play_motion', args: { group: REAL_GROUP }, expect: 'accept' },
  { tool: 'live2d_play_motion', args: { group: FAKE_GROUP }, expect: 'reject' },
  { tool: 'live2d_play_motion', args: { group: REAL_GROUP, index: 99 }, expect: 'reject' },
  { tool: 'live2d_look_at', args: { x: 0.6, y: -0.4 }, expect: 'accept' },
  { tool: 'live2d_look_at', args: { x: 99, y: -99 }, expect: 'accept' }, // 夹取
  { tool: 'live2d_stop_speaking', args: {}, expect: 'accept' },
  { tool: 'live2d_list_capabilities', args: {}, expect: 'info' }, // 只读，不入队
  { tool: 'live2d_speak', args: { text: '   ' }, expect: 'reject' }, // 空白文本
  { tool: 'live2d_speak', args: { text: '长'.repeat(3000) }, expect: 'reject' }, // 超长
  { tool: 'live2d_play_motion', args: { group: REAL_GROUP, index: 0, fadeMs: 99999 }, expect: 'accept' }, // 夹取
  /*
   * 这一条原来是 `weight: 5`（验夹取）。§4.2.8 把 weight 整条删了，于是换成
   * **`holdMs` 的端到端夹取** —— 它是同一个契约里、真正兑现得了的那个参数，
   * 而在此之前没有任何一处断言它从工具一路走到了队列。
   */
  { tool: 'live2d_set_expression', args: { name: REAL_EXPR, holdMs: 250 }, expect: 'accept' },
  { tool: 'live2d_set_expression', args: { name: REAL_EXPR, holdMs: 999999 }, expect: 'accept' }, // 夹取
  /*
   * ★ 这一条刻意用 `interrupt: false`，而且刻意留一条不传的（上面第 1 条）。
   *
   * 两种取值都要在队列里出现，[4] 段那条「队列里的值原样传到执行层」才真的
   * 能证伪 —— 只发 `true` 的话，一个「永远传 true」的退化实现也能全绿。
   */
  { tool: 'live2d_speak', args: { text: '这条排在前面的话后面。', interrupt: false }, expect: 'accept' },
  { tool: 'live2d_play_motion', args: { group: REAL_GROUP, loop: true }, expect: 'accept' },
  { tool: 'live2d_speak', args: { text: '', motionGroup: FAKE_GROUP }, expect: 'reject' },
  { tool: 'live2d_stop_speaking', args: {}, expect: 'accept' },
  { tool: 'live2d_look_at', args: { x: 0, y: 0, durationMs: 400 }, expect: 'accept' },
];

const ACTION_TOOLS = new Set([
  'live2d_speak',
  'live2d_play_motion',
  'live2d_set_expression',
  'live2d_look_at',
  'live2d_emote',
  'live2d_stop_speaking',
]);

const accepted = [];
const rejected = [];
const durations = [];
let threw = 0;
let shapeBroken = 0;
let queueOverflow = 0;
let maxQueued = 0;

const startedAll = Date.now();

for (const [i, entry] of COMMANDS.entries()) {
  const tool = toolByName(host.env, entry.tool);
  check(`#${i + 1} 工具 ${entry.tool} 已注册`, typeof tool?.execute === 'function');

  const t0 = Date.now();
  let result;
  try {
    result = await tool.execute(entry.args);
  } catch (error) {
    threw += 1;
    check(`#${i + 1} ${entry.tool} 不抛异常`, false, String(error?.message ?? error));
    continue;
  }
  durations.push(Date.now() - t0);

  if (entry.expect === 'info') {
    check(`#${i + 1} list_capabilities 报出表情与动作组`,
      Array.isArray(result?.expressions) && result.expressions.length === expressionNames.length
      && Array.isArray(result?.motionGroups) && result.motionGroups.length === motionGroupNames.length,
      JSON.stringify({ e: result?.expressions?.length, m: result?.motionGroups?.length }));
    continue;
  }

  /*
   * 返回形状。五个动作工具共用同一份 ACTION_OUTPUT，所以这里可以统一断言 ——
   * 形状不统一的话，LLM 会在一部分工具上读到 `queued`、在另一部分上读不到，
   * 而它没有办法从描述里知道为什么。
   */
  const shapeOk = typeof result?.detail === 'string'
    && typeof result?.ok === 'boolean'
    && typeof result?.code === 'string'
    && typeof result?.queued === 'number'
    && typeof result?.rendererAlive === 'boolean';
  if (!shapeOk) {
    shapeBroken += 1;
    check(`#${i + 1} ${entry.tool} 返回形状完整`, false, JSON.stringify(result));
  }

  if (result?.queued > 8) {
    queueOverflow += 1;
    check(`#${i + 1} 队列没有超过上限 8`, false, String(result.queued));
  }
  maxQueued = Math.max(maxQueued, result?.queued ?? 0);

  if (result?.ok === true) {
    accepted.push({ i: i + 1, entry, result });
  } else {
    rejected.push({ i: i + 1, entry, result });
    check(`#${i + 1} 该被拒的被拒（${entry.tool}）`, entry.expect === 'reject',
      `期望 ${entry.expect}，得到 ok=false code=${result?.code}`);
    check(`#${i + 1} 被拒时带了可读的错误码`, typeof result?.code === 'string' && result.code.startsWith('E_'),
      String(result?.code));
    check(`#${i + 1} 被拒的指令没有进队列`, result?.queued === 0, String(result?.queued));
  }
  if (result?.ok === true) {
    check(`#${i + 1} 该被接受的被接受（${entry.tool}）`, entry.expect === 'accept',
      `期望 ${entry.expect}，得到 ok=true`);
  }
}

const totalMs = Date.now() - startedAll;
const maxMs = Math.max(...durations, 0);
const acceptedCount = COMMANDS.filter((c) => c.expect === 'accept').length;

console.log(`      接受 ${accepted.length} 条（期望 ${acceptedCount}）、拒绝 ${rejected.length} 条、`
  + `队列峰值 ${maxQueued}、单条最慢 ${maxMs}ms、总计 ${totalMs}ms`);

check('★ 没有一条工具调用抛异常（「不卡死」的第一层含义）', threw === 0, `${threw} 条抛了`);
check('★ 返回形状全部一致', shapeBroken === 0, `${shapeBroken} 条形状不完整`);
check('★ 队列长度从没超过上限 8（「不越界」）', queueOverflow === 0, `${queueOverflow} 次越界`);
/*
 * 峰值必须真的到过 8：13 条被接受、上限 8。如果峰值是 3，说明有一半的指令被别的原因
 * 悄悄丢掉了 —— 那也是一种 bug，而「≤ 8」这条断言对此完全无感。
 */
check('★ 队列确实被填到过上界（证明裁剪逻辑真的在跑，而不是什么都没进来）',
  maxQueued === 8, `峰值 ${maxQueued}`);
check(`接受条数与期望一致（${acceptedCount} 条）`, accepted.length === acceptedCount,
  `期望 ${acceptedCount}，实际 ${accepted.length}`);
/*
 * 20 条里的每一条都必须有明确去留：要么被接受、要么被拒。
 * `expect: 'info'` 的那条（`live2d_list_capabilities`）是**只读**工具，不入队，
 * 所以它既不在 accepted 也不在 rejected 里 —— 把它减掉再比，否则这条断言会一直红。
 */
const infoCount = COMMANDS.filter((c) => c.expect === 'info').length;
check('20 条指令全部有明确去留（接受 + 拒绝 + 只读 = 20，没有「既没接受也没拒绝」）',
  accepted.length + rejected.length + infoCount === COMMANDS.length,
  `${accepted.length} + ${rejected.length} + ${infoCount} ≠ ${COMMANDS.length}`);
/*
 * 「工具立即返回」是 §4.1 硬规则 3。这里给一个宽松的上界：真正的判据不是毫秒数，
 * 而是「有没有一个 await 悄悄等到了播放结束」—— 那种错误会让单条耗时等于整句话的
 * 时长（几秒），250ms 足以把它抓出来，又不会在慢机器上误报。
 */
check('★ 单条指令都在 250ms 内返回（§4.1 硬规则 3：工具不阻塞）', maxMs < 250, `最慢 ${maxMs}ms`);

/* ── [4] ★ 取队列，逐条喂给**真的**渲染端执行层 ───────────────────────── */
console.log('\n[4] ★ /pending → 真的执行层（Host 说合法的，渲染端真的做得到吗）');

const pending = await getJson(host.base, '/pending');
const items = Array.isArray(pending.json?.items) ? pending.json.items : [];
check('/pending 返回 200 且 items 是数组', pending.status === 200 && Array.isArray(pending.json?.items), `HTTP ${pending.status}`);
check('队列里的条数不超过上限 8', items.length <= 8, `${items.length} 条`);
check('队列非空（20 条里至少有几条活下来，否则这一段无法证伪）', items.length > 0, `${items.length} 条`);

const seenKinds = [];
let runnerThrew = 0;
let notHandled = 0;
let runnerRejected = 0;
const runnerCodes = [];

/*
 * `interrupt` 这条链上出过一个「两端都写了、中间没实现」的真缺陷：
 * `actions.js` 老实把它写进 `payload`，`lib/index.js` 的工具描述也向 LLM 承诺了
 * 「默认 true，false 会排在后面」，而渲染端的 `say` 分支从头到尾没读过它 ——
 * 两个取值表现完全一样，且不报错。所以这里要跨过整条链路把它捞出来看：
 * **Host 放进队列的值，和渲染端真的收到并传给播放端的值，是不是同一个。**
 */
const sayInterrupts = []; // 队列里每一条 say 的 payload.interrupt（原始值）
const spokeInterrupts = []; // 执行层真的传给 hooks.speak 的 interrupt
/*
 * 同一类缺陷的第三个实例：`voice` / `rate` 在 Host 侧从 schema 到 Edge-TTS 的
 * 缓存键 `voice|rate|pitch|text` 全都做完了，断的只是渲染端没往外发。所以和
 * `interrupt` 一样，要把「队列里的值」与「播放端收到的值」两条线并排捞出来比。
 */
const sayVoices = [];
const sayRates = [];
const spokeVoices = [];
const spokeRates = [];

for (const [i, item] of items.entries()) {
  /*
   * ★ 这一条断言是整道门禁的核心：新 Host 发的条目必须带 `command`。
   * 只有顶层 `kind: 'speak'` 的话，说明兼容垫片在、但新的结构没了 —— 那是
   * 「Host 回退了、客户端还在往前看」，症状是除了说话以外全都不动。
   */
  check(`/pending 第 ${i + 1} 条带 command 结构`, item?.command !== undefined && typeof item.command === 'object',
    JSON.stringify(item).slice(0, 120));
  check(`/pending 第 ${i + 1} 条带 id 与 at`, typeof item?.id === 'number' && typeof item?.at === 'number',
    JSON.stringify({ id: item?.id, at: item?.at }));
  check(`/pending 第 ${i + 1} 条的 kind 是已知种类`,
    ACTION_KINDS.includes(item?.command?.kind), String(item?.command?.kind));

  const target = makeTarget();
  const spoken = [];
  let result;
  try {
    result = await runner.runAction(target, item.command, {
      speak: async (text, options) => {
        spoken.push(text);
        if (item?.command?.kind === 'say') {
          sayInterrupts.push(item.command.payload?.interrupt);
          spokeInterrupts.push(options?.interrupt);
          sayVoices.push(item.command.payload?.voice);
          sayRates.push(item.command.payload?.rate);
          spokeVoices.push(options?.voice);
          spokeRates.push(options?.rate);
        }
      },
      stopSpeech: () => { spoken.push(null); },
    });
  } catch (error) {
    runnerThrew += 1;
    check(`执行层处理第 ${i + 1} 条不抛`, false, String(error?.message ?? error));
    continue;
  }

  if (result?.handled !== true) {
    notHandled += 1;
    check(`执行层认得第 ${i + 1} 条的 kind（${item?.command?.kind}）`, false, JSON.stringify(result));
  }

  /*
   * ★★ 这就是「Host 与客户端不漂移」那句断言。
   *
   * 这几类失败意味着**两边对同一只模型的理解不一致**：
   *   - E_EXPRESSION_NOT_FOUND / E_MOTION_GROUP_NOT_FOUND / E_MOTION_INDEX_OUT_OF_RANGE
   *       → Host 用一份清单放行，渲染端手里是另一份
   *   - E_ACTION_NO_MODEL  → 指令排上了，但渲染端根本没有模型可操作
   *   - E_ACTION_PARAMETER_IGNORED → Host 放行的参数，渲染端一个都没写进去
   * 它们都是「日志全绿、她什么都没做」的成因。
   */
  const DRIFT_CODES = [
    'E_EXPRESSION_NOT_FOUND',
    'E_MOTION_GROUP_NOT_FOUND',
    'E_MOTION_INDEX_OUT_OF_RANGE',
    'E_ACTION_NO_MODEL',
    'E_ACTION_PARAMETER_IGNORED',
    'E_ACTION_UNSUPPORTED_KIND',
    'E_ACTION_UNKNOWN_KIND',
  ];
  if (result?.ok !== true) {
    runnerRejected += 1;
    runnerCodes.push(result?.code ?? '(空)');
  }
  check(`★ 第 ${i + 1} 条（${item?.command?.kind}）执行成功 —— 两边对同一只模型的理解一致`,
    result?.ok === true && !DRIFT_CODES.includes(result?.code),
    `code=${result?.code} detail=${String(result?.detail ?? '').slice(0, 100)}`);

  seenKinds.push(item?.command?.kind);
}

check('★ 执行层没有一条抛异常（「不卡死」的第二层含义）', runnerThrew === 0, `${runnerThrew} 条抛了`);
check('★ 执行层认得队列里每一条（没有「Host 发了、客户端不认识」）', notHandled === 0, `${notHandled} 条没认出来`);
check('★ 没有一条因为「两边理解不一致」而失败', runnerRejected === 0, runnerCodes.join(', '));

/*
 * ── interrupt 端到端 ────────────────────────────────────────────────
 *
 * 这一段是补上那道「两端各自都对、中间没人守」的缝。判据不是「有没有这个字段」，
 * 而是**队列里的原始值和执行层真的交出去的值相等**：只查前者的话，渲染端继续
 * 丢掉它也照样绿 —— 那正是当初漏掉它的原因。
 */
check('★ 队列里确实有 say 可以验（否则这一段无法证伪）', sayInterrupts.length > 0, `${sayInterrupts.length} 条`);
/*
 * 这里**不**要求 true / false 都出现：队列只留最新的 8 条，前面的 say 会被挤掉。
 * 两种取值的端到端保证放在 [6b]（单独发两条、单独验），那一段不受数量裁剪影响。
 */
check('★ 队列里每条 say 的 interrupt 都是明确的布尔值（Host 的归一化生效）',
  sayInterrupts.every((v) => v === true || v === false), JSON.stringify(sayInterrupts));
check('★★ 队列里的 interrupt 原样传到了执行层（这条缝曾经没人守）',
  JSON.stringify(sayInterrupts) === JSON.stringify(spokeInterrupts),
  `队列 ${JSON.stringify(sayInterrupts)} → 执行层 ${JSON.stringify(spokeInterrupts)}`);
check('★ 没有任何一条 say 在执行层手里变成 undefined（那等于又丢了一次）',
  spokeInterrupts.every((v) => v === true || v === false), JSON.stringify(spokeInterrupts));

/* ── [5] 一致性：被拒的绝不能出现在队列里 ─────────────────────────────── */
console.log('\n[5] 去留一致性');

/*
 * 用**精确标记**而不是「摘要文本包含」来判断有没有漏进队列。
 *
 * 前面故意用了两个一眼能认出来的假名字（`绝对不存在的表情` / `绝对不存在的动作组`），
 * 所以这里可以直接在队列里搜它们。文本包含式的断言很脆：`detail` 里的措辞一改，
 * 断言就从「验行为」退化成「验文案」，绿得毫无意义。
 */
const leakedExpr = items.filter((item) => item?.command?.payload?.expression?.name === FAKE_EXPR);
const leakedGroup = items.filter((item) => item?.command?.payload?.motion?.group === FAKE_GROUP);
check('★ 被拒的表达式一条都没漏进队列', leakedExpr.length === 0, `${leakedExpr.length} 条`);
check('★ 被拒的动作组一条都没漏进队列', leakedGroup.length === 0, `${leakedGroup.length} 条`);

/*
 * 越界的动作序号也不该出现。注意：**放行**的指令里 index 是 Host 随机挑的，
 * 落在 [0, count) 内；这里是反向确认「没有任何一条越界」。
 */
const oobIndex = items.filter((item) => {
  const motion = item?.command?.payload?.motion;
  if (motion === undefined || item?.command?.kind !== 'motion') return false;
  const count = capabilities.motionGroups.find((g) => g.name === motion.group)?.count ?? 0;
  return typeof motion.index === 'number' && (motion.index < 0 || motion.index >= count);
});
check('★ 队列里的动作序号全部落在合法范围内（「不越界」的逐条证明）',
  oobIndex.length === 0, oobIndex.map((i) => i.command.payload.motion.index).join(', '));

/*
 * 口型参数不该出现在任何一条 `param` 指令里（§4.1 硬规则 1）。
 * Host 已经丢过一道，这里是「队列这个交接面上确实干净」的独立确认。
 */
const mouthLeak = items.filter((item) => {
  const params = item?.command?.payload?.params;
  if (params === null || typeof params !== 'object') return false;
  return Object.keys(params).some((id) => isExclusiveParameter(id));
});
check('★ 队列里没有任何一条指令带着口型参数（§4.1 硬规则 1 在交接面上成立）',
  mouthLeak.length === 0, JSON.stringify(mouthLeak.map((i) => i.command.payload.params)));

/*
 * ── holdMs 端到端 ────────────────────────────────────────────────────
 *
 * §4.2.8 把契约里的 `weight` 删了（Framework 兑现不了），留下 `holdMs` 做同一件事
 * 的位置。但在此之前，**没有任何一处断言 `holdMs` 从工具走到了队列** ——
 * 也就是说：如果哪天它也断在这一层，症状会和 weight 一模一样（值随便给、表现不变、
 * 不报错），而门禁全绿。这一段就是补那条断言。
 */
const expressionHoldMs = items
  .filter((item) => item?.command?.kind === 'expression')
  .map((item) => item?.command?.payload?.expression?.holdMs);
check('★ 队列里确实有 expression 可以验（否则这一段无法证伪）',
  expressionHoldMs.length > 0, `${expressionHoldMs.length} 条`);
check('★ 原样给的 holdMs 原样到达队列（250）',
  expressionHoldMs.includes(250), JSON.stringify(expressionHoldMs));
check('★ 超上限的 holdMs 被夹到 60000 才进队列（不是原样漏过去）',
  expressionHoldMs.includes(60000) && !expressionHoldMs.includes(999999),
  JSON.stringify(expressionHoldMs));
check('★ 每一条 expression 的 holdMs 都是有限的非负数（默认 0 = 一直保持）',
  expressionHoldMs.every((v) => typeof v === 'number' && isFinite(v) && v >= 0),
  JSON.stringify(expressionHoldMs));
check('★ 队列里的表达式指令里没有 weight（§4.2.8 删掉的参数不许回来）',
  items.every((item) => {
    const expression = item?.command?.payload?.expression;
    return expression === null || expression === undefined
      || !Object.prototype.hasOwnProperty.call(expression, 'weight');
  }),
  JSON.stringify(items.map((i) => i?.command?.payload?.expression)));

/*
 * ── fadeMs / loop 端到端 ─────────────────────────────────────────────
 *
 * 这两个参数以前只在 `test-action-runner.mjs` 的 `[6]` 段验过「执行层有没有透传」，
 * 队列这一段没人守。§4.2.8 的 `[6e]` 把六个工具的参数冻成了一份名单、声称每个参数
 * 都有端到端断言 —— 名单一旦这么写，这里就得真的把它们验掉，
 * 否则那份名单自己就变成了新的「向读者承诺了却不兑现」。
 */
const motionFades = items
  .filter((item) => item?.command?.kind === 'motion')
  .map((item) => item?.command?.payload?.motion?.fadeMs);
check('★ 队列里确实有 motion 可以验（否则这一段无法证伪）',
  motionFades.length > 0, `${motionFades.length} 条`);
check('★ 每一条 motion 的 fadeMs 都是有限的非负数（不是 undefined 漏过去）',
  motionFades.every((v) => typeof v === 'number' && isFinite(v) && v >= 0),
  JSON.stringify(motionFades));
check('★ 超上限的 fadeMs 被夹到 5000 才进队列（不是原样漏过去）',
  motionFades.includes(5000) && !motionFades.includes(99999),
  JSON.stringify(motionFades));
check('★ 不写 fadeMs 时 Host 填的是默认 300',
  motionFades.includes(300), JSON.stringify(motionFades));

const motionLoops = items
  .filter((item) => item?.command?.kind === 'motion')
  .map((item) => item?.command?.payload?.motion?.loop);
check('★ 显式 loop:true 原样到达队列（这个参数以前没人端到端验过）',
  motionLoops.includes(true), JSON.stringify(motionLoops));
check('★ 没写 loop 的是 false，不是 undefined / 也不是 true',
  motionLoops.every((v) => v === true || v === false) && motionLoops.includes(false),
  JSON.stringify(motionLoops));

/** 工具名 → 指令种类。用来验「进来的每一条都对应某条被接受的调用」。 */
const KIND_OF_TOOL = {
  live2d_speak: 'say',
  live2d_play_motion: 'motion',
  live2d_set_expression: 'expression',
  live2d_look_at: 'look',
  live2d_stop_speaking: 'stop',
};
const acceptedKinds = new Set(accepted.map((a) => KIND_OF_TOOL[a.entry.tool]));
const orphan = items.filter((item) => !acceptedKinds.has(item?.command?.kind));
check('队列里的每一条都来自一条被接受的指令（没有凭空出现的）',
  orphan.length === 0, orphan.map((i) => i.command?.kind).join(', '));

/* ── [6] 取走即清空 ───────────────────────────────────────────────────── */
console.log('\n[6] 取走即清空');
const drainAgain = await getJson(host.base, '/pending');
check('再取一次是空的（取走即清空，不会重复执行）',
  Array.isArray(drainAgain.json?.items) && drainAgain.json.items.length === 0,
  JSON.stringify(drainAgain.json?.items?.length));

const status = await getJson(host.base, '/status');
check('/status 的 commands 计数器存在', status.json?.commands !== undefined,
  JSON.stringify(status.json?.commands));
check('/status 记下了最近一条指令的种类', typeof status.json?.commands?.lastKind === 'string',
  String(status.json?.commands?.lastKind));

/* ── [6b] ★ interrupt 端到端：两种取值各走一遍完整链路 ──────────────────── */

console.log('\n[6b] ★ interrupt 端到端（队列里的值 = 执行层交出去的值）');

/*
 * 为什么单独发两条，而不是靠 [3] 那 20 条里顺带验：
 * 队列只保留最新的 8 条，前面那几条 `say` 会被后来的指令挤出去，于是
 * 「两种取值都出现过」这种断言会时红时绿 —— 那比没有断言更坏。
 *
 * 这一段要证伪的是一个具体退化：**执行层把 `interrupt` 丢掉、永远按默认处理**。
 * 只发 `true` 的话那种退化照样全绿，所以两种取值都必须走一遍。
 */
const interruptCases = [
  { args: { text: '默认打断的那句。' }, expected: true, label: '没写 interrupt' },
  { args: { text: '排在后面的那句。', interrupt: false }, expected: false, label: 'interrupt:false' },
];

for (const c of interruptCases) {
  const tool = toolByName(host.env, 'live2d_speak');
  const posted = await tool.execute(c.args);
  check(`[6b] ${c.label} 被接受并入队`, posted?.ok === true && posted?.queued >= 1,
    `ok=${posted?.ok} queued=${posted?.queued} ${posted?.detail ?? ''}`);
}

const irqPending = await getJson(host.base, '/pending');
const irqItems = Array.isArray(irqPending.json?.items) ? irqPending.json.items : [];
check('[6b] 两条 say 都在队列里', irqItems.length === 2, `${irqItems.length} 条`);

const irqSeen = [];
for (const item of irqItems) {
  const outcome = await runner.runAction(makeTarget(), item.command, {
    speak: async (_text, options) => { irqSeen.push(options?.interrupt); },
    stopSpeech: () => {},
  });
  check(`[6b] 第 ${irqSeen.length} 条 say 执行成功`, outcome?.ok === true, `${outcome?.code} ${outcome?.detail ?? ''}`);
}
check('★★ [6b] 两种取值都原样穿过整条链路（丢掉 interrupt 的退化实现会在这里红）',
  JSON.stringify(irqSeen) === JSON.stringify([true, false]),
  `收到 ${JSON.stringify(irqSeen)}，期望 [true,false]`);
check('[6b] 队列里的原始值也确实是这两种',
  JSON.stringify(irqItems.map((i) => i?.command?.payload?.interrupt)) === JSON.stringify([true, false]),
  JSON.stringify(irqItems.map((i) => i?.command?.payload?.interrupt)));

// 收干净，后面的段落到的是一个空队列。
await getJson(host.base, '/pending');

/* ── [6c] ★ voice / rate 端到端：同一个毛病，断在更早一步 ─────────────────── */

console.log('\n[6c] ★ voice / rate 端到端（Host 全都做完了，只差渲染端没发）');

/*
 * 与 `[6b]` 同一个理由单独发：队列只留最新 8 条，靠 20 条顺带验会时红时绿。
 *
 * 这一段要证伪的退化是「`ActionHooks.speak` 的参数对象里没有这两个字段」——
 * 那正是修复前的样子：Host 的 schema advertise 了它们、`/speak` 路由收了它们、
 * Edge-TTS 的缓存键 `voice|rate|pitch|text` 也算进去了，唯独渲染端不发，
 * 于是 LLM 收到「说快一点」会传 `rate: '+30%'`，然后什么都不会发生。
 */
const voiceCases = [
  { args: { text: '用默认嗓子说。' }, voice: undefined, rate: undefined, label: '两个都不写' },
  { args: { text: '说快一点。', rate: '+30%' }, voice: undefined, rate: '+30%', label: '只给 rate' },
  { args: { text: '换个嗓子。', voice: 'zh-CN-YunxiNeural' }, voice: 'zh-CN-YunxiNeural', rate: undefined, label: '只给 voice' },
  {
    args: { text: '又换嗓子又快。', voice: 'zh-CN-YunjianNeural', rate: '-10%' },
    voice: 'zh-CN-YunjianNeural',
    rate: '-10%',
    label: '两个都给',
  },
];

for (const c of voiceCases) {
  const tool = toolByName(host.env, 'live2d_speak');
  const posted = await tool.execute(c.args);
  check(`[6c] ${c.label} 被接受并入队`, posted?.ok === true && posted?.queued >= 1,
    `ok=${posted?.ok} queued=${posted?.queued} ${posted?.detail ?? ''}`);
}

const voicePending = await getJson(host.base, '/pending');
const voiceItems = Array.isArray(voicePending.json?.items) ? voicePending.json.items : [];
check('[6c] 四条 say 都在队列里', voiceItems.length === 4, `${voiceItems.length} 条`);

const voiceSeen = [];
for (const item of voiceItems) {
  const outcome = await runner.runAction(makeTarget(), item.command, {
    speak: async (_text, options) => { voiceSeen.push({ voice: options?.voice, rate: options?.rate }); },
    stopSpeech: () => {},
  });
  check(`[6c] 第 ${voiceSeen.length} 条 say 执行成功`, outcome?.ok === true, `${outcome?.code} ${outcome?.detail ?? ''}`);
}

check('★★ [6c] voice / rate 原样穿过整条链路（渲染端不发这两个字段就会在这里红）',
  JSON.stringify(voiceSeen) === JSON.stringify(voiceCases.map((c) => ({ voice: c.voice, rate: c.rate }))),
  `收到 ${JSON.stringify(voiceSeen)}`);
check('[6c] 队列里的原始值也对得上（Host 那一端没把它们吃掉）',
  JSON.stringify(voiceItems.map((i) => ({ voice: i?.command?.payload?.voice, rate: i?.command?.payload?.rate }))) ===
    JSON.stringify(voiceCases.map((c) => ({ voice: c.voice, rate: c.rate }))),
  JSON.stringify(voiceItems.map((i) => ({ voice: i?.command?.payload?.voice, rate: i?.command?.payload?.rate }))));

// 收干净，后面的段落到的是一个空队列。
await getJson(host.base, '/pending');

/* ── [6d] ★ durationMs 端到端：同一类缺陷的第四个实例 ────────────────────── */

console.log('\n[6d] ★ look_at 的 durationMs 端到端（Host 校验好，渲染端曾经看都不看）');

/*
 * 这一段要证伪的退化是「`ActionTarget.lookAt` 只读 x / y」—— 修复前就是这个样子：
 * `lib/index.js` 的 schema 告诉 LLM「默认 400，上限 5000」、工具描述照抄、
 * `actions.js` 夹取好写进 `payload.look.durationMs`、`test-actions.mjs` 还有两条
 * 断言钉着它，**然后渲染端从头到尾没读过它**。症状是「立刻转」和「慢慢转」
 * 画面上完全一样，且不报任何错。
 *
 * 四种取值都要走一遍：显式给了、超上限被夹、不写（此时 `actions.js` 会填默认的
 * 400 —— 所以渲染端收到的是**数字**，`undefined` 只可能出现在拼错了字段名或
 * 根本没读的时候，那正是要抓的）、以及显式的 0（合法值，意思是「别缓动」）。
 */
const lookCases = [
  { args: { x: 0.6, y: -0.3, durationMs: 3000 }, expect: 3000, label: '显式 3000' },
  { args: { x: -1, y: 1, durationMs: 99999 }, expect: 5000, label: '超上限被夹到 5000' },
  { args: { x: 0, y: 0 }, expect: 400, label: '不写时 Host 填默认 400' },
  { args: { x: 0.2, y: 0.2, durationMs: 0 }, expect: 0, label: '显式 0（立刻到位，合法值）' },
];

for (const c of lookCases) {
  const tool = toolByName(host.env, 'live2d_look_at');
  const posted = await tool.execute(c.args);
  check(`[6d] ${c.label} 被接受并入队`, posted?.ok === true && posted?.queued >= 1,
    `ok=${posted?.ok} queued=${posted?.queued} ${posted?.detail ?? ''}`);
}

const lookPending = await getJson(host.base, '/pending');
const lookItems = Array.isArray(lookPending.json?.items) ? lookPending.json.items : [];
check('[6d] 四条 look 都在队列里', lookItems.length === 4, `${lookItems.length} 条`);

const lookSeen = [];
for (const item of lookItems) {
  const target = makeTarget();
  const outcome = await runner.runAction(target, item.command, {
    speak: async () => {},
    stopSpeech: () => {},
  });
  const call = target.calls.find((c) => c.op === 'lookAt');
  lookSeen.push(call?.options?.durationMs);
  check(`[6d] 第 ${lookSeen.length} 条 look 执行成功`, outcome?.ok === true,
    `${outcome?.code} ${outcome?.detail ?? ''}`);
}

check('★★ [6d] durationMs 原样穿过整条链路（渲染端不读它就是 undefined，会在这里红）',
  JSON.stringify(lookSeen) === JSON.stringify(lookCases.map((c) => c.expect)),
  `收到 ${JSON.stringify(lookSeen)}，期望 ${JSON.stringify(lookCases.map((c) => c.expect))}`);

// 收干净。
await getJson(host.base, '/pending');

/* ── [6e] ★ 工具 advertise 的参数，一个都不许多 ───────────────────────────── */

console.log('\n[6e] ★ 工具广告出去的参数必须全都兑现得了');

/*
 * 这一段是 §4.2.8 换来的教训，也是整轮排查的机械化形式。
 *
 * 前面五个缺陷（`interrupt` / `voice` / `rate` / `durationMs` / `weight`）的形态
 * 完全一样：**工具描述向 LLM 承诺了一个参数，参数一路传到某一层然后没了**。
 * 两端各自的门禁都是绿的，因为两端各自都没写错。
 *
 * 靠人一条条去查是不可持续的。所以这里把工具 schema 里 advertise 的参数**冻成一份
 * 名单**：谁想加一个新参数，就必须同时改这份名单 —— 而改名单的那一刻，他就被迫
 * 回答「这个值最后落在哪一层、哪条断言证明它真的落地了」。
 *
 * 名单里的每一个参数都有对应的端到端断言（下面这份对应关系本身也被上面那 18 项
 * 断言逼着兑现 —— 写进来却没人验的参数，正是这一段要防的东西）：
 *   text / interrupt → [6b]，voice / rate → [6c]，durationMs → [6d]，
 *   holdMs → [5]，fadeMs / loop → [5]，x / y / group / index → [4] 与 [5]。
 *
 * `weight` **故意不在这份名单里** —— 它兑现不了，已经从工具上摘掉了。
 */
const ADVERTISED_PARAMETERS = {
  live2d_speak: ['text', 'voice', 'rate', 'interrupt'],
  live2d_play_motion: ['group', 'index', 'fadeMs', 'loop'],
  live2d_set_expression: ['name', 'holdMs'],
  live2d_look_at: ['x', 'y', 'durationMs'],
  live2d_stop_speaking: [],
  live2d_list_capabilities: [],
};

const ADVERTISED_REQUIRED = {
  live2d_speak: ['text'],
  live2d_play_motion: ['group'],
  live2d_set_expression: ['name'],
  live2d_look_at: ['x', 'y'],
  live2d_stop_speaking: [],
  live2d_list_capabilities: [],
};

for (const [name, expected] of Object.entries(ADVERTISED_PARAMETERS)) {
  const spec = toolByName(host.env, name);
  const actual = Object.keys(spec?.parameters?.properties ?? {}).sort();
  check(`[6e] ${name} advertise 的参数恰好是 [${expected.join(', ')}]`,
    JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    `实际 ${JSON.stringify(actual)}`);
}

for (const [name, expected] of Object.entries(ADVERTISED_REQUIRED)) {
  const spec = toolByName(host.env, name);
  const required = Array.isArray(spec?.parameters?.required) ? [...spec.parameters.required].sort() : [];
  check(`[6e] ${name} 的必填项恰好是 [${expected.join(', ')}]`,
    JSON.stringify(required) === JSON.stringify([...expected].sort()),
    `实际 ${JSON.stringify(required)}`);
}

/*
 * 反向确认：`weight` 真的从工具上摘掉了。
 *
 * 这一条比上面那张名单更难绕过 —— 名单是「我列出来的」，这一条是「我不许它出现」。
 * 有人把 `weight` 加回 schema 却忘了接，上面那张名单会红；有人把名单也一起改了，
 * 这一条会红。
 */
for (const name of Object.keys(ADVERTISED_PARAMETERS)) {
  const spec = toolByName(host.env, name);
  check(`[6e] ${name} 没有 weight（Framework 兑现不了的参数不许出现在广告里）`,
    !Object.prototype.hasOwnProperty.call(spec?.parameters?.properties ?? {}, 'weight'),
    JSON.stringify(Object.keys(spec?.parameters?.properties ?? {})));
}

/* ── [6f] ★ 坏 voice / rate：整条链路走完，坏值不许进队列 ─────────────────── */

console.log('\n[6f] ★ 坏 voice / rate 走完整链路（句子照说，坏值不进队列）');

/*
 * 这一段守的是「值到了最后一层会不会出事」—— 与 `[6b]`/`[6c]` 守的
 * 「值有没有传到」是两件事。
 *
 * `voice` / `rate` 最终要插进 SSML 的 XML 属性。实测 `rate: "1'2"` 会让整句话
 * 502（用户听到「她没说话」，日志写着「语音服务出错了」）。修法有两层：
 * `buildSsml()` 转义（`tools/test-edge-tts-ssml.mjs` 验），以及**这里** ——
 * 坏值在工具入口就被丢掉、连队列都不该进，而且要回一句能让人改对的话。
 */
const badSpeechCases = [
  { args: { text: '这句的语速格式是错的。', rate: "1'2" }, field: 'rate', label: 'rate 带单引号（原来会 502）' },
  { args: { text: '这句的语速也读不懂。', rate: 'fast' }, field: 'rate', label: 'rate 是单词' },
  { args: { text: '这句的音色写法不对。', voice: 'xiaoxiao' }, field: 'voice', label: 'voice 不是 ShortName' },
  { args: { text: '这句的音色带引号。', voice: "zh-CN-X'.Neural" }, field: 'voice', label: 'voice 带单引号（原来会 502）' },
];

for (const c of badSpeechCases) {
  const tool = toolByName(host.env, 'live2d_speak');
  const posted = await tool.execute(c.args);
  check(`[6f] ${c.label}：句子仍被接受`, posted?.ok === true && posted?.queued >= 1,
    `ok=${posted?.ok} ${posted?.detail ?? ''}`);
  check(`[6f] ${c.label}：detail 里点出了被丢的字段名`,
    typeof posted?.detail === 'string' && posted.detail.includes(c.field), String(posted?.detail));
  check(`[6f] ${c.label}：说明里带着怎么改（可自愈）`,
    typeof posted?.detail === 'string' && (c.field === 'rate' ? posted.detail.includes('%') : posted.detail.includes('ShortName')),
    String(posted?.detail));
}

const badPending = await getJson(host.base, '/pending');
const badItems = Array.isArray(badPending.json?.items) ? badPending.json.items : [];
check('★★ [6f] 四条坏值指令都在队列里（句子没被丢掉）', badItems.length === 4, `${badItems.length} 条`);
check('★★ [6f] 队列里没有任何一条带着坏 rate / 坏 voice',
  badItems.every((i) => i?.command?.payload?.rate === undefined && i?.command?.payload?.voice === undefined),
  JSON.stringify(badItems.map((i) => ({ rate: i?.command?.payload?.rate, voice: i?.command?.payload?.voice }))));
check('★★ [6f] 每一句的文本都还在（只丢了修饰，没丢内容）',
  badItems.every((i) => typeof i?.command?.payload?.text === 'string' && i.command.payload.text.length > 0));

const badSeen = [];
for (const item of badItems) {
  const outcome = await runner.runAction(makeTarget(), item.command, {
    speak: async (_text, options) => { badSeen.push({ voice: options?.voice, rate: options?.rate }); },
    stopSpeech: () => {},
  });
  check(`[6f] 第 ${badSeen.length} 条仍能正常执行`, outcome?.ok === true, `${outcome?.code} ${outcome?.detail ?? ''}`);
}
check('★★ [6f] 执行层收到的是「用默认值」而不是坏值',
  badSeen.length === 4 && badSeen.every((s) => s.voice === undefined && s.rate === undefined),
  JSON.stringify(badSeen));

// 好值必须仍然进队列 —— 否则「全都丢掉」的退化实现也能让上面全绿。
const goodTool = toolByName(host.env, 'live2d_speak');
await goodTool.execute({ text: '这句是好的。', rate: '+20%', voice: 'zh-CN-YunxiNeural' });
const goodPending = await getJson(host.base, '/pending');
const goodItems = Array.isArray(goodPending.json?.items) ? goodPending.json.items : [];
check('★★ [6f] 对照：合法的 rate / voice 原样进队列（「一律丢掉」的退化实现会在这里红）',
  goodItems.length === 1 && goodItems[0]?.command?.payload?.rate === '+20%'
  && goodItems[0]?.command?.payload?.voice === 'zh-CN-YunxiNeural',
  JSON.stringify(goodItems.map((i) => i?.command?.payload)));

await getJson(host.base, '/pending');

/* ── [6g] ★ 方向契约：「+1 是哪一边」必须只有一个答案 ───────────────────── */

console.log('\n[6g] ★ 方向契约：工具说的方向必须和真机一致');

/*
 * 这一段守的是一句话：**「+1 是哪一边」必须只有一个答案**。
 *
 * 原来的工具描述写的是 `(-1 = her left, +1 = her right)`。真机实测（2026-02，hiyori）：
 * `x=+1` 让她朝**屏幕右侧**转 —— 那正是**她自己的左边**。也就是说描述把方向说反了，
 * 而且没有任何一层会因此报错：调用方照着描述发指令、拿到一个镜像的动作，两边都不知道。
 * 这与 `[6d]` 的 `durationMs` 是同一族（值传到了、语义丢了），只是这次丢的是**符号**。
 *
 * 判据分两半，缺一不可：
 *   1. 说明（调用方真正读的那句话）必须落在「看的人」的参照系上，且不许再出现旧的镜像说法；
 *   2. 实现（`LOOK_PARAMETER_FACTORS` 里 `ParamAngleX` 的系数）必须仍然是正的 ——
 *      「说明改对了、符号却被谁翻了一次」是同样坏的另一种形态。
 */
const LOOK_TOOL_SPEC = toolByName(host.env, 'live2d_look_at');
const LOOK_TOOL_DESC = String(LOOK_TOOL_SPEC?.description ?? '');
const LOOK_X_DESC = String(LOOK_TOOL_SPEC?.parameters?.properties?.x?.description ?? '');
const LOOK_DURATION_DESC = String(LOOK_TOOL_SPEC?.parameters?.properties?.durationMs?.description ?? '');

check('[6g] 读得到 live2d_look_at 的说明文本（读不到就无从验起，直接红）',
  LOOK_TOOL_DESC.length > 0 && LOOK_X_DESC.length > 0,
  `description ${LOOK_TOOL_DESC.length} 字，x ${LOOK_X_DESC.length} 字`);

/** 旧的那句镜像说法。它只要再回来一次，这一段就该红。 */
const MIRRORED_DIRECTION_CLAIM = /\+1\s*=\s*her right/i;
check('★★ [6g] 工具说明里不再出现「+1 = her right」这种镜像说法',
  !MIRRORED_DIRECTION_CLAIM.test(LOOK_TOOL_DESC), LOOK_TOOL_DESC.slice(0, 140));

/** 说明必须点出屏幕侧，并且点明那和她自己的左右相反。 */
const directionIsViewerCentric = (text) => /screen/i.test(text) && /her (own )?left/i.test(text);
check('★★ [6g] 工具说明明说 +1 是屏幕右侧、且点明那就是她自己的左边',
  directionIsViewerCentric(LOOK_TOOL_DESC), LOOK_TOOL_DESC.slice(0, 220));

/** `x` 的参数说明也要说清 —— 中文这一半同样是调用方读的。 */
check('★★ [6g] x 的参数说明里点出了屏幕侧、以及和她自己的左右相反',
  /屏幕右侧/.test(LOOK_X_DESC) && /她自己的左/.test(LOOK_X_DESC), LOOK_X_DESC);

/** `durationMs` 是「转过去的时长」，不是「保持多久」：真机上转完她不弹回来。 */
check('[6g] durationMs 的说明点明「转完会保持住，不是保持时长」',
  /保持/.test(LOOK_DURATION_DESC), LOOK_DURATION_DESC);

const PET_MODEL_SOURCE = readFileSync(
  join(ROOT, 'dsh-live2d-pet', 'src', 'client', 'pet-model.ts'), 'utf8');
const ANGLE_X_FACTOR = "['ParamAngleX', 30.0, 0.0, 0.0]";
const angleXFactorIsPositive = (source) => source.includes(ANGLE_X_FACTOR)
  && !/\[['"]ParamAngleX['"],\s*-/.test(source);
check('★★ [6g] 客户端里 ParamAngleX 的系数仍然是正的（谁翻符号，这里红）',
  angleXFactorIsPositive(PET_MODEL_SOURCE), `找不到 ${ANGLE_X_FACTOR}`);

/* 反向验证：三条判据各自都要能红。 */
const MUTATED_PET_SOURCE = PET_MODEL_SOURCE.replace(
  ANGLE_X_FACTOR, "['ParamAngleX', -30.0, 0.0, 0.0]");
check('反证 [6g] 把系数改成 -30.0 之后，「系数仍然为正」必须变红',
  MUTATED_PET_SOURCE !== PET_MODEL_SOURCE && !angleXFactorIsPositive(MUTATED_PET_SOURCE));
check('反证 [6g] 旧文案喂进方向谓词必须为假（它确实是被这条抓出来的）',
  MIRRORED_DIRECTION_CLAIM.test('x is horizontal (-1 = her left, +1 = her right) and y is vertical')
  && !directionIsViewerCentric('x is horizontal (-1 = her left, +1 = her right) and y is vertical'));
check('反证 [6g] 只说了屏幕侧、没说「她自己的左边」的半吊子文案也必须为假',
  !directionIsViewerCentric('x is horizontal: +1 turns her toward the right side of the screen.'));

/* ── [6h] ★ 情绪端到端：角色解析这一层真的兑现了 ─────────────────────── */

console.log('\n[6h] ★ 情绪端到端（Host 按角色解析 → 队列 → 真的执行层）');

/*
 * 为什么单开一段、而不是塞进 `[3]` 那 20 条里：
 *
 * 队列只留最新 8 条。情绪那两条插进 `[3]` 会把 `fadeMs` / `loop` 的指令挤出窗口，
 * 那**不是**「顺手多测了一点」，是把原来验着的东西悄悄换成没验 —— 门禁变绿了，
 * 但它守的东西少了两样。所以这里自己发、自己取、自己喂给执行层，不受裁剪影响。
 *
 * 这一段要证的是**角色解析这层抽象真的兑现了**，而不只是「多了个 kind」：
 *
 *   1. Host 按角色（眼笑 / 脸颊 / 眉毛 / 头倾 / 呆毛）解析出来的一包参数，
 *      渲染端一颗不少地收到了 —— 不是收到一个名字，然后自己去猜该动哪里。
 *   2. 缺的角色（Haru 没有 `ParamCheek`、没有 `ParamHairAhoge`）在 Host 侧就被
 *      消化掉，指令整体**照旧成功**。换一只模型、或者换装只换了一半时，这是
 *      唯一不会碎的行为：少笑一点，而不是「AI 以为自己笑了、她没笑」。
 *   3. 交下去的是**相对默认值的增量**，不是绝对值。这一条靠夹具里那个
 *      `def: 5` 的 `ParamAngleZ` 才验得出来（见上面夹具的注释）。
 *   4. 「平静」走的是清空那条路，而不是往脸上写一排 0。
 */
await getJson(host.base, '/pending'); // 先清空，下面按「这一段自己发的那几条」来断言

const emoteTool = toolByName(host.env, 'live2d_emote');
check('[6h] live2d_emote 已注册', typeof emoteTool?.execute === 'function');

const emoteRuns = emotionCalls.length;
const emoteResult = await emoteTool.execute({ name: '开心' });
check('[6h] 「开心」被接受', emoteResult?.ok === true, String(emoteResult?.detail ?? '').slice(0, 160));

const emotePending = await getJson(host.base, '/pending');
const emoteItems = Array.isArray(emotePending.json?.items) ? emotePending.json.items : [];
check('[6h] 恰好一条进队列', emoteItems.length === 1, `${emoteItems.length} 条`);

const emoteCmd = emoteItems[0]?.command;
const emotePayload = emoteCmd?.payload?.emotion;
check('[6h] 队列里那是 emotion 指令，且带着名字', emoteCmd?.kind === 'emotion' && emotePayload?.name === '开心',
  JSON.stringify(emoteCmd ?? null).slice(0, 200));

const emoteParams = emotePayload?.params ?? {};
check('★★ [6h] 交到渲染端的是**参数包**，不是一句「开心」（渲染端不猜该动哪里）',
  Object.keys(emoteParams).length > 0
  && Object.values(emoteParams).every((v) => typeof v === 'number' && Number.isFinite(v)),
  JSON.stringify(emoteParams));
check('★★ [6h] 缺的角色在 Host 侧就被消化掉了：Haru 没有的脸颊 / 呆毛不出现在包里，指令照旧成功',
  !('ParamCheek' in emoteParams) && !('ParamHairAhoge' in emoteParams)
  && 'ParamEyeLSmile' in emoteParams && 'ParamBrowLY' in emoteParams,
  JSON.stringify(emoteParams));
/*
 * ★★ 增量 vs 绝对值。
 * 夹具把这个参数声明成 `def: 5`，而「开心」给它的是 `+2` 的增量 ⇒ 交下去必须是
 * `2`。写成绝对值（`def + 增量 = 7`）的实现会在这里红 —— 在 `def: 0` 的参数上
 * 这两种写法**完全同形**，那是这个设计里最容易悄悄写错的一处。
 *
 * 判据抽成函数，只为了能在下面反证它真的会红。
 */
const angleZIsDelta = (params) =>
  typeof params?.ParamAngleZ === 'number' && Math.abs(params.ParamAngleZ - 2) < 1e-6;

check('★★ [6h] 交下去的是相对默认值的增量（不是绝对值）',
  angleZIsDelta(emoteParams),
  `ParamAngleZ=${emoteParams.ParamAngleZ}（夹具 def=5，增量应为 2；写成绝对值会是 7）`);
check('反证 [6h] 「绝对值」那种写法（def + 增量 = 7）必须被这条判据判假',
  !angleZIsDelta({ ParamAngleZ: 7 }) && !angleZIsDelta({}) && angleZIsDelta({ ParamAngleZ: 2 }));
check('★ [6h] 三段时长都跟着指令过来了（淡入 / 保持 / 淡出）',
  typeof emotePayload?.holdMs === 'number' && typeof emotePayload?.attackMs === 'number'
  && typeof emotePayload?.releaseMs === 'number',
  JSON.stringify({ holdMs: emotePayload?.holdMs, attackMs: emotePayload?.attackMs, releaseMs: emotePayload?.releaseMs }));

const emoteTarget = makeTarget();
const emoteOutcome = await runner.runAction(emoteTarget, emoteCmd, { speak: async () => {}, stopSpeech: () => {} });
check('★★ [6h] 真的执行层认这条指令并做成了', emoteOutcome?.ok === true,
  `${emoteOutcome?.code} ${emoteOutcome?.detail ?? ''}`);

const emoteCall = emotionCalls[emoteRuns];
check('★★ [6h] 到达叠加层的参数包与队列里的**逐字节相同**（这条缝上丢过三次东西）',
  emoteCall !== undefined && JSON.stringify(emoteCall.values) === JSON.stringify(emoteParams),
  `队列 ${JSON.stringify(emoteParams)} → 执行层 ${JSON.stringify(emoteCall?.values)}`);
/*
 * ★ 走的是叠加通道，不是硬写通道。
 * 硬写会把眨眼 / 呼吸 / 正在播的动作一起压住 —— 那正是这个功能必须绕开的东西，
 * 所以「有没有误用那条通道」要单独钉一条。
 */
const emoteOps = emoteTarget.calls.map((c) => c.op);
check('★ [6h] 走的是叠加通道 setEmotion，而不是硬写通道 setParameterOverride',
  emoteOps.includes('setEmotion') && !emoteOps.includes('setParameterOverride'),
  emoteOps.join('、'));

// 「平静」= 空参数表 = 清空。它必须是一条**走得通**的正常路。
await getJson(host.base, '/pending');
const clearsBefore = emotionClears.length;
const calmResult = await emoteTool.execute({ name: '平静' });
const calmPending = await getJson(host.base, '/pending');
const calmItems = Array.isArray(calmPending.json?.items) ? calmPending.json.items : [];
check('★★ [6h] 「平静」是一条正常指令（不是错误路径）', calmResult?.ok === true, String(calmResult?.detail ?? '').slice(0, 120));
check('★ [6h] 它的参数表是空的（清空，而不是写一排 0）',
  Object.keys(calmItems[0]?.command?.payload?.emotion?.params ?? {}).length === 0,
  JSON.stringify(calmItems[0]?.command?.payload?.emotion ?? null));
const calmOutcome = await runner.runAction(makeTarget(), calmItems[0]?.command, { speak: async () => {}, stopSpeech: () => {} });
check('★★ [6h] 执行层把它做成「清空情绪层」',
  calmOutcome?.ok === true && emotionClears.length === clearsBefore + 1, `${calmOutcome?.code} ${calmOutcome?.detail ?? ''}`);

/*
 * ── [6i] ★ #3「按名字收掉某一层」也要跨过这条缝 ────────────────────────────
 *
 * 它为什么值得单独一条：「让她脸上少点东西」在这之前只有两条路 —— 装一层新的、
 * 或者「平静」，而两个都是**一把全收**。于是「我停下之后把思考态收掉」顺手抹掉了
 * 我点名让她保持 30 秒的情绪，一句自动情绪也常常是被下一步的清空剪断的。
 * `release` 是第三条路，而它的 payload **没有名字也没有参数**（只有 `release: [...]`）
 * —— 那种形状最容易被渲染端当成坏指令拒掉（「这条情绪指令既没有名字也没有参数」），
 * 而那正是「Host 说发了、她脸上什么都没变、日志全绿」的经典形态。
 *
 * ★ 生产这条指令的是 Host 的 `pushMoodRelease()`，它的**触发器**要等 8 秒
 * （`MOOD_SETTLING_MS`），由 `simulate-host-boot.mjs` 端到端验；这里验的是同一份
 * `buildAction()` 产出的 payload 在渲染端**真的做得到**。
 */
const releaseBuilt = buildAction({ kind: 'emotion', release: ['思考'] }, capabilities);
check('★ [6i] Host 能产出「只收思考态」这条指令（它是合法输入，不是坏指令）',
  releaseBuilt?.ok === true, `${releaseBuilt?.code} ${releaseBuilt?.detail ?? ''}`);
check('★ [6i] 这条 payload 里没有名字、也没有参数（只有 `release`）',
  releaseBuilt?.command?.payload?.emotion?.name === undefined
  && Object.keys(releaseBuilt?.command?.payload?.emotion?.params ?? {}).length === 0
  && Array.isArray(releaseBuilt?.command?.payload?.emotion?.release),
  JSON.stringify(releaseBuilt?.command?.payload?.emotion ?? null));

/* 先照 Host 起手的做法挂上思考态，这样「收」才有东西可收。 */
const thinkingBuilt = buildAction(
  { kind: 'emotion', name: '思考', intensity: 0.5, holdMs: 30000 },
  capabilities,
);
const releaseTarget = makeTarget();
const thinkingOutcome = await runner.runAction(
  releaseTarget, thinkingBuilt?.command, { speak: async () => {}, stopSpeech: () => {} },
);
const releasesBefore = emotionReleases.length;
const releaseOutcome = await runner.runAction(
  releaseTarget, releaseBuilt?.command, { speak: async () => {}, stopSpeech: () => {} },
);
check('★★ [6i] 渲染端认这条「只收」，而且真的收到了思考态那一层（不是静默什么都没做）',
  thinkingOutcome?.ok === true && releaseOutcome?.ok === true
  && emotionReleases.length === releasesBefore + 1
  && emotionReleases[releasesBefore].join('、') === '思考',
  `${releaseOutcome?.code} ${releaseOutcome?.detail ?? ''} / releases=${JSON.stringify(emotionReleases.slice(releasesBefore))}`);
check('★ [6i] 收的时候**没有**走「一把全清」那条路（那是 `平静` 的活）',
  releaseTarget.calls.map((c) => c.op).includes('releaseEmotion')
  && !releaseTarget.calls.map((c) => c.op).includes('clearEmotion'),
  releaseTarget.calls.map((c) => c.op).join('、'));

/*
 * 收一个**当时不在场**的层不算错：思考态可能已经自己到期了（它的寿命是 30 秒）。
 * 但渲染端必须把这件事说出来 —— 我在 `live2d_status` 想区分的正是这两种情况。
 */
const emptyReleaseOutcome = await runner.runAction(
  makeTarget(), releaseBuilt?.command, { speak: async () => {}, stopSpeech: () => {} },
);
check('★ [6i] 收一个当时不在场的层不算错，但要如实报「不在场」',
  emptyReleaseOutcome?.ok === true
  && String(emptyReleaseOutcome?.detail ?? '').includes('不在场'),
  `${emptyReleaseOutcome?.code} ${emptyReleaseOutcome?.detail ?? ''}`);

// 不存在的情绪：拒掉，且不许进队列。
await getJson(host.base, '/pending');
const FAKE_EMOTION = '绝对不存在的情绪';
const bogus = await emoteTool.execute({ name: FAKE_EMOTION });
check('★ [6h] 不存在的情绪被拒', bogus?.ok === false, String(bogus?.detail ?? '').slice(0, 140));
check('★ [6h] 被拒的那条没有进队列',
  (await getJson(host.base, '/pending')).json?.items?.length === 0);
check('★ [6h] 报错里带着可用情绪的名字（可自愈，AI 不用猜）',
  typeof bogus?.detail === 'string' && bogus.detail.includes('开心'), String(bogus?.detail ?? '').slice(0, 200));

await getJson(host.base, '/pending');

/* ── [7] 反向验证：这道门禁必须能红 ───────────────────────────────────── */
console.log('\n[7] 反向验证：两处漂移必须被抓住');

/*
 * 漂移 A：Host 放行了一个渲染端没有的表达式。
 * 这正是「清单漂移」的形态 —— 客户端换了模型但还没上报新清单，Host 手里的旧清单
 * 放行了新模型没有的表情。断言：执行层必须拒绝它。
 */
const driftedTarget = makeTarget();
const driftA = await runner.runAction(driftedTarget, {
  kind: 'expression',
  priority: 50,
  ttlMs: 4000,
  payload: { expression: { name: FAKE_EXPR } },
}, { speak: async () => {}, stopSpeech: () => {} });
check('漂移 A：执行层拒绝「Host 放行但模型没有」的表达式（这道门禁真的能红）',
  driftA?.handled === true && driftA?.ok === false && driftA?.code === 'E_EXPRESSION_NOT_FOUND',
  JSON.stringify(driftA));

/* 漂移 B：Host 放行了一个越界的动作序号。 */
const driftB = await runner.runAction(makeTarget(), {
  kind: 'motion',
  priority: 50,
  ttlMs: 4000,
  payload: { motion: { group: REAL_GROUP, index: 99 } },
}, { speak: async () => {}, stopSpeech: () => {} });
check('漂移 B：执行层拒绝越界的动作序号',
  driftB?.handled === true && driftB?.ok === false && driftB?.code === 'E_MOTION_INDEX_OUT_OF_RANGE',
  JSON.stringify(driftB));

/*
 * 漂移 C：口型独占。Host 已经丢掉了口型参数，但**假想**一条漏过来的 ——
 * 渲染端必须也拦一道（两处各有一份 `isExclusiveParameter()`）。
 */
const driftC = await runner.runAction(makeTarget(), {
  kind: 'param',
  priority: 50,
  ttlMs: 4000,
  payload: { params: { ParamMouthOpenY: 1 } },
}, { speak: async () => {}, stopSpeech: () => {} });
check('漂移 C：执行层拒绝只写口型参数的指令（§4.1 硬规则 1 的第二道防线）',
  driftC?.handled === true && driftC?.ok === false && driftC?.code === 'E_ACTION_PARAMETER_IGNORED',
  JSON.stringify(driftC));

/* 漂移 D：不认得的 kind 必须如实说「没处理」，不能假装成功。 */
const driftD = await runner.runAction(makeTarget(), {
  kind: 'teleport',
  priority: 50,
  ttlMs: 4000,
  payload: {},
}, { speak: async () => {}, stopSpeech: () => {} });
check('漂移 D：不认得的 kind 返回 handled=false（不假装成功）',
  driftD?.handled === false && driftD?.ok === false && driftD?.code === 'E_ACTION_UNSUPPORTED_KIND',
  JSON.stringify(driftD));

/* ── [8] 卸载与清理 ───────────────────────────────────────────────────── */
console.log('\n[8] 卸载');
await host.close();
check('路由已标记为 disposed', host.env.registrations[0]?.disposed === true);
rmSync(tempRoot, { recursive: true, force: true });
check('临时模型库已清理（没给 %TEMP% 留困惑）', !existsSync(tempRoot));

console.log('');
if (failures.length === 0) {
  console.log(`[9] ACTION CHAIN GATE PASSED —— ${passed} 项断言全绿`);
  console.log(`    20 条指令：接受 ${accepted.length} / 拒绝 ${rejected.length} / 只读 ${infoCount}，`
    + `队列峰值 ${maxQueued}，单条最慢 ${maxMs}ms，全链路 ${totalMs}ms`);
  console.log(`    交接面：/pending 交出 ${items.length} 条 → 执行层全部 handled 且 ok`
    + `（种类 ${JSON.stringify(seenKinds)}）`);
} else {
  console.log(`[x] ACTION CHAIN GATE FAILED：${failures.length} 项未通过`);
  for (const f of failures) console.log(`    - ${f.label}${f.detail ? `  ${f.detail}` : ''}`);
  process.exitCode = 1;
}
