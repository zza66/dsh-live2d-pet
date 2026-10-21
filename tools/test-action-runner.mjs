#!/usr/bin/env node
/**
 * 门禁：AI 指令的**执行层**（`lib/test/action-runner.mjs` ＝ `src/client/action-runner.ts`）。
 *
 * 为什么需要这个文件：`runAction()` 决定「这条指令调哪个方法、参数怎么取、
 * 过期了要不要丢、认不认得这种 kind」。它跑在 React effect 的轮询里，如果留在
 * `plugin.ts` 就只能靠「我让 AI 说了句话，看着嘴巴动了」。搬进纯函数之后，
 * 一个**记下调用的假 target** 就能把每条分支钉住 —— 尤其是那几条只有出错时
 * 才看得见的：不认得的 kind 有没有如实说、`stop` 过期了会不会被丢掉、
 * 没有模型时说话还能不能进行。
 *
 * 用法：`node tools/test-action-runner.mjs`（离线，无网络、无 DOM；
 * 只有最后那几条**调用点**断言会读一次 `plugin.ts` 的源码，不执行它）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(here, '..', 'dsh-live2d-pet', 'lib/test/action-runner.mjs');

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

if (!existsSync(modulePath)) {
  console.error(`指令执行层的测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const {
  collectParameters,
  FRAMEWORK_PRIORITY,
  getActionTarget,
  HANDLED_KINDS,
  IDLE_AFTER_MS,
  IDLE_HOLD_MAX_MS,
  IDLE_HOLD_MIN_MS,
  IDLE_LOOP_REPEATS,
  idleHoldMsFor,
  isBusyWithRealMotion,
  isExpired,
  isOwnIdleMotion,
  motionPriorityFor,
  pickIdleGroup,
  pickIdleIndex,
  runAction,
  runCurrentAction,
  setActionTarget,
  shouldAutoIdle,
} = mod;

/* ───────────────────────── 夹具 ───────────────────────── */

/**
 * 记下调用的假 target。
 *
 * `mode` 用来制造失败：`{ motion: {ok:false, code:'E_MOTION_LOAD_FAILED'} }`
 * 之类。默认全部成功 —— 大部分断言要验的是「调了哪个方法、参数是什么」，
 * 而不是失败路径。
 */
function makeTarget(options = {}) {
  const calls = [];
  const mode = options.mode ?? {};
  const parameterOutcome = options.parameterOutcome ?? {
    applied: ['ParamAngleX'],
    dropped: [],
    ignored: [],
  };
  const emotionOutcome = options.emotionOutcome ?? {
    applied: ['ParamEyeLSmile'],
    dropped: [],
    ignored: [],
  };
  const target = {
    calls,
    async playMotion(group, index, opts) {
      calls.push(['playMotion', group, index, opts]);
      if (mode.motion) return mode.motion;
      return { ok: true, code: '', detail: `播了 ${group}` };
    },
    async setExpression(name, opts) {
      calls.push(['setExpression', name, opts]);
      if (mode.expression) return mode.expression;
      return { ok: true, code: '', detail: `换了 ${name}` };
    },
    lookAt(x, y, opts) {
      // 第三个参数（`{ durationMs }`）必须记下来：契约里 `durationMs` 曾经
      // 一路传到这一层的前一步就被丢掉，画面上「立刻转」和「慢慢转」一模一样。
      calls.push(['lookAt', x, y, opts]);
      if (mode.look) return mode.look;
      return { ok: true, code: '', detail: '看那边' };
    },
    motionGroupNames() {
      return options.motionGroups ?? ['Idle'];
    },
    currentMotionPriority() {
      // `options.motionPriority` 用来验自动待机的第四个条件。
      // 缺省 `0` = 什么都没在播。
      return options.motionPriority ?? 0;
    },
    stopMotion() {
      calls.push(['stopMotion']);
    },
    clearExpression() {
      calls.push(['clearExpression']);
    },
    setParameterOverride(values, holdMs) {
      calls.push(['setParameterOverride', values, holdMs]);
      if (mode.parameter) return mode.parameter;
      return parameterOutcome;
    },
    clearParameterOverrides() {
      calls.push(['clearParameterOverrides']);
    },
    /*
     * 情绪层（叠加式）。和 `setParameterOverride` 分开是**故意的**：前者是硬写，
     * 会把眨眼 / 呼吸 / 动作全压掉；后者只往当前值上加，所以两者绝不能合并成
     * 一个方法 —— 合并的那天，情绪会把她的呼吸一起按住。
     */
    setEmotion(values, opts) {
      calls.push(['setEmotion', values, opts]);
      if (mode.emotion) return mode.emotion;
      return emotionOutcome;
    },
    clearEmotion() {
      calls.push(['clearEmotion']);
    },
    /*
     * 「按名字收掉指定的层」（D 期加的第三条路）。它和 `clearEmotion()` 的区别是
     * 它是**挑着收**：收思考态的时候不许碰我点名让她保持的那一层。
     *
     * 假 target 必须实现它 —— 接口上少了这个方法，执行层调用时会直接抛
     * `target.releaseEmotion is not a function`，而那看起来像门禁坏了。
     */
    releaseEmotion(names) {
      calls.push(['releaseEmotion', names]);
      if (mode.release) return mode.release;
      return options.releaseOutcome ?? { released: names, unknown: [] };
    },
    /*
     * 单条微动作（§13.30）。**同步**方法 —— 与 `lookAt` 一样，它只是把播放器
     * 指向某一条，不等待演完；等它演完是渲染循环的事，这里等就等于把
     * 「演 1.4 秒」变成工具的响应时间。
     */
    playMicroMotion(id) {
      calls.push(['playMicroMotion', id]);
      if (mode.microMotion) return mode.microMotion;
      return { ok: true, code: '', detail: `演 ${id}` };
    },
  };
  return target;
}

function makeHooks(options = {}) {
  const spoken = [];
  const stopped = [];
  /**
   * `spokenOptions[i]` 是第 i 次 `speak()` 收到的第二个参数。
   *
   * 记下来是因为这条线上出过**两个**「两端都写了、中间没实现」的真缺陷：
   * `interrupt` 是「传到最后一步被丢」（`actions.js` 老实把它写进 `payload`，
   * 工具描述也向 LLM 承诺了「默认 true，false 会排在后面」，而 `say` 分支
   * 根本没读它）；`voice` / `rate` 断得更早，连这个参数对象里都没有它们。
   * 两个缺陷的症状一样：取值随便给、表现完全一样、且不报错。
   *
   * 所以现在断言的是**执行层真的把决定传下去了**，而不只是「Host 放进了队列」。
   */
  const spokenOptions = [];
  return {
    spoken,
    stopped,
    spokenOptions,
    hooks: {
      async speak(text, speakOptions) {
        spoken.push(text);
        spokenOptions.push(speakOptions ?? null);
        if (options.speakThrows === true) throw new Error('合成失败');
      },
      stopSpeech() {
        stopped.push(true);
      },
    },
  };
}

const kinds = (calls) => calls.map((c) => c[0]);

/* ───────────────────────── [1] 导出契约 ───────────────────────── */

console.log(`[1] 导出契约  ${modulePath.replace(here, 'tools')}`);
for (const name of ['runAction', 'runCurrentAction', 'isExpired', 'collectParameters', 'setActionTarget', 'getActionTarget', 'HANDLED_KINDS']) {
  check(`导出了 ${name}`, typeof mod[name] !== 'undefined');
}
check('HANDLED_KINDS 是冻结的数组', Array.isArray(HANDLED_KINDS) && Object.isFrozen(HANDLED_KINDS));
check(
  'HANDLED_KINDS 含全部九种指令',
  ['say', 'motion', 'expression', 'look', 'emotion', 'param', 'microMotion', 'stop', 'idle'].every((k) => HANDLED_KINDS.includes(k)),
  HANDLED_KINDS.join('、'),
);
check('HANDLED_KINDS 不把 gesture 当独立 kind', !HANDLED_KINDS.includes('gesture'));

/* ───────────────────────── [2] 单例登记 ───────────────────────── */

console.log('\n[2] 当前执行目标（单例）');
{
  setActionTarget(null);
  check('初始为 null', getActionTarget() === null);
  const target = makeTarget();
  setActionTarget(target);
  check('登记后取得到', getActionTarget() === target);

  const { spoken, hooks } = makeHooks();
  const result = await runCurrentAction({ kind: 'say', payload: { text: '你好' } }, hooks);
  check('runCurrentAction 用的是登记的那个', spoken.length === 1 && result.ok === true);

  setActionTarget(null);
  check('注销后回到 null', getActionTarget() === null);
}

/* ───────────────────────── [3] say ───────────────────────── */

console.log('\n[3] say：说话');
{
  const target = makeTarget();
  const { spoken, hooks } = makeHooks();
  let r = await runAction(target, { kind: 'say', payload: { text: '你好呀' } }, hooks);
  check('正常说一句', r.ok === true && r.handled === true && spoken[0] === '你好呀', r.detail);

  r = await runAction(target, { kind: 'say', payload: { text: '   ' } }, hooks);
  check('空白文本被拒', r.ok === false && r.code === 'E_ACTION_EMPTY_TEXT', r.code);
  check('空白文本没有真的去念', spoken.length === 1);

  r = await runAction(target, { kind: 'say', payload: {} }, hooks);
  check('缺 text 被拒', r.ok === false && r.code === 'E_ACTION_EMPTY_TEXT');

  // ★ 兼容垫片：旧 Host 的形状是 {kind:'speak', text}
  r = await runAction(target, { kind: 'speak', text: '旧形状' }, hooks);
  check('旧垫片形状（kind:"speak" + 顶层 text）也能说', r.ok === true && spoken.includes('旧形状'), r.detail);

  // ★ 没有模型时也必须能说话 —— 这正是「模型加载失败但人还在说话」那条路径。
  const { spoken: spoken2, hooks: hooks2 } = makeHooks();
  r = await runAction(null, { kind: 'say', payload: { text: '没有模型也能说' } }, hooks2);
  check('★ 没有模型时说话照常进行', r.ok === true && spoken2.length === 1, r.detail);

  // 说话本身失败时要如实报，不能假装成功。
  const { hooks: hooks3 } = makeHooks({ speakThrows: true });
  r = await runAction(target, { kind: 'say', payload: { text: '会炸' } }, hooks3);
  check('说话抛异常被兜住并报 E_ACTION_FAILED', r.ok === false && r.code === 'E_ACTION_FAILED', r.code);
}

/* ───────────────────────── [3b] ★ interrupt（曾经在最后一步被丢掉） ───────────────────────── */

console.log('\n[3b] ★ interrupt：默认打断，false 才排在后面');
{
  /*
   * 这条链曾经是断的，而且**断得很安静**：`actions.js` 把 `interrupt` 写进
   * `payload`、`lib/index.js` 的工具描述也向 LLM 承诺了「默认 true，false 会排
   * 在后面」，但 `say` 分支从头到尾没读过它。于是两个取值表现完全一样 ——
   * 门禁在两端各自都是绿的（`test-actions.mjs` 验 Host 写对了，
   * `test-action-chain.mjs` 验 `handled && ok`），中间那一层没人看。
   */
  const { spokenOptions, hooks } = makeHooks();
  const target = makeTarget();

  let r = await runAction(target, { kind: 'say', payload: { text: '默认的' } }, hooks);
  check('★ 没写 interrupt 时执行层收到的是「打断」（§4.1 默认 true）', spokenOptions[0]?.interrupt === true, JSON.stringify(spokenOptions[0]));

  r = await runAction(target, { kind: 'say', payload: { text: '明确的', interrupt: true } }, hooks);
  check('interrupt:true 原样传给播放端', spokenOptions[1]?.interrupt === true);

  r = await runAction(target, { kind: 'say', payload: { text: '排队的', interrupt: false } }, hooks);
  check('★ interrupt:false 真的传下去了（这正是以前被丢掉的那个值）', spokenOptions[2]?.interrupt === false);
  check('两种情况都成功返回', r.ok === true, r.detail);

  // 旧垫片没有这个字段，按契约也该是「打断」。
  r = await runAction(target, { kind: 'speak', text: '旧形状' }, hooks);
  check('旧垫片（没有 payload）也按默认 true 处理', spokenOptions[3]?.interrupt === true);

  // 脏值：任何不是明确 `false` 的东西都算打断（契约是「默认 true」，不是「真值才 true」）。
  r = await runAction(target, { kind: 'say', payload: { text: '脏零', interrupt: 0 } }, hooks);
  check('interrupt:0 不算明确的 false（按契约仍打断）', spokenOptions[4]?.interrupt === true);
  r = await runAction(target, { kind: 'say', payload: { text: '脏空串', interrupt: '' } }, hooks);
  check('interrupt:"" 同理', spokenOptions[5]?.interrupt === true);
  r = await runAction(target, { kind: 'say', payload: { text: '脏null', interrupt: null } }, hooks);
  check('interrupt:null 同理', spokenOptions[6]?.interrupt === true);
  r = await runAction(target, { kind: 'say', payload: { text: '说了不算' } }, hooks);
  check('每次都恰好说了一句', spokenOptions.length === 8, String(spokenOptions.length));

  // detail 要能看出这条指令是被当成「打断」还是「排队」处理的 —— 排查时全靠它。
  const a = await runAction(target, { kind: 'say', payload: { text: '甲', interrupt: false } }, hooks);
  const b = await runAction(target, { kind: 'say', payload: { text: '乙', interrupt: true } }, hooks);
  check('detail 里写明了这句是打断还是排队', a.detail.includes('排在后面') && b.detail.includes('打断'), `${a.detail} / ${b.detail}`);
}

/* ───────────────────────── [3c] ★ voice / rate（同一个毛病，断在更早一步） ───────────────────────── */

console.log('\n[3c] ★ voice / rate：Host 全都做完了，只差这一层没往外发');
{
  /*
   * 与 `interrupt` 是同一类缺陷的第三个实例，但断点更靠前：`interrupt` 是
   * 「传到最后一步被丢」，而 `voice` / `rate` 连 `hooks.speak()` 都没走到 ——
   * `ActionHooks.speak` 的第二个参数里根本没有这两个字段。
   *
   * 症状同样是全绿：Host 的 schema advertise 了它们、`/speak` 路由收了它们、
   * Edge-TTS 的缓存键 `voice|rate|pitch|text` 也算进去了，只有渲染端没发。
   */
  const { spokenOptions, hooks } = makeHooks();
  const target = makeTarget();

  let r = await runAction(target, { kind: 'say', payload: { text: '快一点', rate: '+30%' } }, hooks);
  check('★ rate 传到了播放端（这正是以前断掉的那一环）', spokenOptions[0]?.rate === '+30%', JSON.stringify(spokenOptions[0]));
  check('只给 rate 时没编造 voice', spokenOptions[0]?.voice === undefined, `${spokenOptions[0]?.voice}`);
  check('rate 不影响成功返回', r.ok === true, r.detail);

  r = await runAction(target, { kind: 'say', payload: { text: '换个嗓子', voice: 'zh-CN-YunxiNeural' } }, hooks);
  check('★ voice 也传到了播放端', spokenOptions[1]?.voice === 'zh-CN-YunxiNeural', `${spokenOptions[1]?.voice}`);

  r = await runAction(
    target,
    { kind: 'say', payload: { text: '都换', voice: 'zh-CN-YunjianNeural', rate: '-10%', interrupt: false } },
    hooks,
  );
  check('voice / rate / interrupt 三个可以同时给',
    spokenOptions[2]?.voice === 'zh-CN-YunjianNeural' &&
      spokenOptions[2]?.rate === '-10%' &&
      spokenOptions[2]?.interrupt === false,
    JSON.stringify(spokenOptions[2]));

  // 缺省：没写就是 undefined，**不能变成空串** —— 空串会进 Edge-TTS 的缓存键，
  // 白占一格缓存，而且让「这一句用了默认嗓子」在日志里看不出来。
  r = await runAction(target, { kind: 'say', payload: { text: '默认嗓子' } }, hooks);
  check('没写 voice 就是 undefined 而不是空串', spokenOptions[3]?.voice === undefined, JSON.stringify(spokenOptions[3]?.voice));
  check('没写 rate 同理', spokenOptions[3]?.rate === undefined, JSON.stringify(spokenOptions[3]?.rate));

  // 脏值：空串 / 全空白 / 非字符串一律当「没写」。
  r = await runAction(target, { kind: 'say', payload: { text: '脏参数', voice: '', rate: '   ' } }, hooks);
  check('空串 voice 被归一成 undefined', spokenOptions[4]?.voice === undefined, JSON.stringify(spokenOptions[4]?.voice));
  check('全空白 rate 被归一成 undefined', spokenOptions[4]?.rate === undefined, JSON.stringify(spokenOptions[4]?.rate));

  r = await runAction(target, { kind: 'say', payload: { text: '数字参数', voice: 42, rate: null } }, hooks);
  check('非字符串 voice 被归一成 undefined', spokenOptions[5]?.voice === undefined, JSON.stringify(spokenOptions[5]?.voice));
  check('null rate 被归一成 undefined', spokenOptions[5]?.rate === undefined, JSON.stringify(spokenOptions[5]?.rate));

  // 旧垫片没有 payload，两个字段同样缺席。
  r = await runAction(target, { kind: 'speak', text: '旧形状' }, hooks);
  check('旧垫片下 voice / rate 都是 undefined', spokenOptions[6]?.voice === undefined && spokenOptions[6]?.rate === undefined);

  check('每一句都恰好说了一次', spokenOptions.length === 7, String(spokenOptions.length));
}

/* ───────────────────────── [4] stop ───────────────────────── */

console.log('\n[4] stop：停下');
{
  const target = makeTarget();
  const { stopped, hooks } = makeHooks();
  const r = await runAction(target, { kind: 'stop' }, hooks);
  check('stop 成功', r.ok === true, r.detail);
  check('先停了声音', stopped.length === 1);
  check(
    '★ 停的顺序是「声音 → 动作 → 表情 → 参数」',
    JSON.stringify(kinds(target.calls)) ===
      JSON.stringify(['stopMotion', 'clearExpression', 'clearParameterOverrides']),
    kinds(target.calls).join(' → '),
  );

  // 没有模型时声音仍要停 —— 用户喊停是最不能打折的一条。
  const { stopped: stopped2, hooks: hooks2 } = makeHooks();
  const r2 = await runAction(null, { kind: 'stop' }, hooks2);
  check('★ 没有模型时也停得掉声音', r2.ok === true && stopped2.length === 1);
}

/* ───────────────────────── [5] idle ───────────────────────── */

console.log('\n[5] idle：待机');
{
  const target = makeTarget();
  const { hooks, stopped } = makeHooks();
  const r = await runAction(target, { kind: 'idle' }, hooks);
  check('idle 成功', r.ok === true);
  check(
    'idle 停了动作/表情/参数并把视线回正',
    JSON.stringify(kinds(target.calls)) ===
      JSON.stringify(['stopMotion', 'clearExpression', 'clearParameterOverrides', 'lookAt']),
    kinds(target.calls).join(' → '),
  );
  check('idle 的 lookAt 目标是原点', target.calls[3][1] === 0 && target.calls[3][2] === 0);
  check('idle 不去动声音', stopped.length === 0);

  const r2 = await runAction(null, { kind: 'idle' }, hooks);
  check('没有模型时 idle 不算失败', r2.ok === true, r2.detail);
}

/* ───────────────────────── [6] motion ───────────────────────── */

console.log('\n[6] motion：播动作');
{
  const target = makeTarget();
  const { hooks } = makeHooks();

  let r = await runAction(
    target,
    { kind: 'motion', payload: { motion: { group: 'Idle', index: 1, fadeMs: 250, loop: true } } },
    hooks,
  );
  check('正常播一组', r.ok === true && target.calls[0][1] === 'Idle' && target.calls[0][2] === 1);
  check('fadeMs 与 loop 透传', target.calls[0][3].fadeMs === 250 && target.calls[0][3].loop === true);
  check('没标打断的指令用 NORMAL 优先级', target.calls[0][3].priority === FRAMEWORK_PRIORITY.NORMAL, String(target.calls[0][3].priority));

  // ★ 优先级 100 必须真的插队 —— 没有这一步，「打断她」会在框架层被压住。
  r = await runAction(
    target,
    { kind: 'motion', priority: 100, payload: { motion: { group: 'Idle', index: 0 } } },
    hooks,
  );
  check('★ priority:100 的指令用 FORCE 优先级（真能打断正在播的动作）', r.ok === true && target.calls[1][3].priority === FRAMEWORK_PRIORITY.FORCE, String(target.calls[1][3].priority));

  check('motionPriorityFor: 100 及以上是 FORCE', motionPriorityFor(100) === 3 && motionPriorityFor(999) === 3);
  check('motionPriorityFor: 50 与非法值是 NORMAL', motionPriorityFor(50) === 2 && motionPriorityFor(undefined) === 2 && motionPriorityFor('快') === 2 && motionPriorityFor(NaN) === 2);

  r = await runAction(target, { kind: 'motion', payload: { motion: {} } }, hooks);
  check('缺 group 被拒', r.ok === false && r.code === 'E_ACTION_BAD_VALUE', r.code);

  r = await runAction(target, { kind: 'motion', payload: {} }, hooks);
  check('缺整个 motion 对象也被拒', r.ok === false && r.code === 'E_ACTION_BAD_VALUE');

  r = await runAction(null, { kind: 'motion', payload: { motion: { group: 'Idle' } } }, hooks);
  check('★ 没有模型时报 E_ACTION_NO_MODEL（不是假装成功）', r.ok === false && r.code === 'E_ACTION_NO_MODEL', r.code);

  // 失败必须原样透传：`E_MOTION_INDEX_OUT_OF_RANGE` 是给 AI 看的线索。
  const failing = makeTarget({ mode: { motion: { ok: false, code: 'E_MOTION_INDEX_OUT_OF_RANGE', detail: '这组只有 2 个动作' } } });
  r = await runAction(failing, { kind: 'motion', payload: { motion: { group: 'Idle', index: 9 } } }, hooks);
  check('目标失败时原样透传错误码与 detail', r.ok === false && r.code === 'E_MOTION_INDEX_OUT_OF_RANGE' && r.detail.includes('2 个动作'), r.code);

  check('index 省略时透传 undefined（随机由 Host 决定）', target.calls[0][2] === 1);
}

/* ───────────────────────── [7] expression ───────────────────────── */

console.log('\n[7] expression：换表情');
{
  const target = makeTarget();
  const { hooks } = makeHooks();

  let r = await runAction(
    target,
    { kind: 'expression', payload: { expression: { name: '开心', holdMs: 2000 } } },
    hooks,
  );
  check('正常换表情并透传 holdMs', r.ok === true && target.calls[0][1] === '开心' && target.calls[0][2].holdMs === 2000);

  /*
   * ★ `weight` 必须**不再被传下去**。
   *
   * 契约表 §4.1 写过 `set_expression(name, weight?, holdMs?)`，但 Framework
   * 兑现不了「按权重混合单个表情」，参数会一路传到底、什么都不发生、还不报错。
   * §4.2.8 把它整条删了；这条断言守的是「别让它悄悄回来」——
   * 它和别处的断言方向相反：别处问「值传到了没有」，这里问「这个字段还在不在」。
   */
  const dirty = makeTarget();
  r = await runAction(dirty, { kind: 'expression', payload: { expression: { name: '开心', weight: 0.4 } } }, hooks);
  check(
    '★ weight 不再出现在交给模型的目标参数里（契约已删掉这个兑现不了的参数）',
    r.ok === true
      && dirty.calls[0][2].weight === undefined
      && !Object.prototype.hasOwnProperty.call(dirty.calls[0][2], 'weight'),
    JSON.stringify(dirty.calls[0]),
  );

  r = await runAction(target, { kind: 'expression', payload: { expression: {} } }, hooks);
  check('缺 name 被拒', r.ok === false && r.code === 'E_ACTION_BAD_VALUE');

  r = await runAction(null, { kind: 'expression', payload: { expression: { name: '开心' } } }, hooks);
  check('没有模型时报 E_ACTION_NO_MODEL', r.ok === false && r.code === 'E_ACTION_NO_MODEL');

  const failing = makeTarget({ mode: { expression: { ok: false, code: 'E_EXPRESSION_NOT_FOUND', detail: '这个模型只有：开心、生气' } } });
  r = await runAction(failing, { kind: 'expression', payload: { expression: { name: 'smile' } } }, hooks);
  check(
    '★ 表情找不到时把可用列表带回去（§4.1 硬规则 2：错误要可自愈）',
    r.ok === false && r.code === 'E_EXPRESSION_NOT_FOUND' && r.detail.includes('开心'),
    r.detail,
  );
}

/* ───────────────────────── [8] look ───────────────────────── */

console.log('\n[8] look：看某处');
{
  const target = makeTarget();
  const { hooks } = makeHooks();

  let r = await runAction(target, { kind: 'look', payload: { look: { x: -0.5, y: 0.25 } } }, hooks);
  check('正常转视线', r.ok === true && target.calls[0][1] === -0.5 && target.calls[0][2] === 0.25);

  r = await runAction(target, { kind: 'look', payload: {} }, hooks);
  check('缺 look 对象时退回看正前方（不报错）', r.ok === true && target.calls[1][1] === 0 && target.calls[1][2] === 0);

  r = await runAction(target, { kind: 'look', payload: { look: { x: '左', y: null } } }, hooks);
  check('非数字一律当 0', r.ok === true && target.calls[2][1] === 0 && target.calls[2][2] === 0);

  r = await runAction(null, { kind: 'look', payload: { look: { x: 1, y: 0 } } }, hooks);
  check('没有模型时报 E_ACTION_NO_MODEL', r.ok === false && r.code === 'E_ACTION_NO_MODEL');
}

/* ─────────────────── [8b] ★ look 的 durationMs 要真的传下去 ─────────────────── */

console.log('\n[8b] ★ durationMs：Host 校验好、门禁钉好、就差点在这一层丢掉');
{
  const target = makeTarget();
  const { hooks } = makeHooks();

  // §4.1 契约：`live2d_look_at(x, y, durationMs?)`。这一层曾经只读 x / y，
  // 第三个参数到此为止 —— 于是「立刻转」和「慢慢转」在画面上完全一样。
  let r = await runAction(
    target,
    { kind: 'look', payload: { look: { x: 0.5, y: 0, durationMs: 3000 } } },
    hooks,
  );
  check('durationMs 透传到目标方法', r.ok === true && target.calls[0][3]?.durationMs === 3000,
    JSON.stringify(target.calls[0][3]));

  // 没写时要传 `undefined`（＝让目标方法去用契约默认的 400），
  // **不能传 0** —— 0 在契约里的意思是「别缓动、立刻到位」。
  r = await runAction(target, { kind: 'look', payload: { look: { x: 0, y: 0 } } }, hooks);
  check('缺省时是 undefined 而不是 0', target.calls[1][3]?.durationMs === undefined,
    String(target.calls[1][3]?.durationMs));

  r = await runAction(target, { kind: 'look', payload: { look: { x: 0, y: 0, durationMs: 0 } } }, hooks);
  check('显式的 0 要原样保留（0 是合法值）', target.calls[2][3]?.durationMs === 0,
    String(target.calls[2][3]?.durationMs));

  for (const bad of ['快一点', null, NaN, Infinity, {}, []]) {
    r = await runAction(target, { kind: 'look', payload: { look: { x: 0, y: 0, durationMs: bad } } }, hooks);
    const got = target.calls[target.calls.length - 1][3]?.durationMs;
    check(`脏值 ${JSON.stringify(bad) ?? String(bad)} 归一成 undefined`, got === undefined, String(got));
  }

  // `idle` 那条路不传时长（它是「视线回正」，越自然越好，用默认值）。
  r = await runAction(target, { kind: 'idle' }, hooks);
  const idleCall = target.calls[target.calls.length - 1];
  check('idle 的 lookAt 不带 durationMs', idleCall[3] === undefined, JSON.stringify(idleCall[3]));
  check('idle 仍然成功', r.ok === true);
}

/* ───────────────────────── [9] param ───────────────────────── */

console.log('\n[9] param：参数逃生通道');
{
  const target = makeTarget();
  const { hooks } = makeHooks();

  let r = await runAction(
    target,
    { kind: 'param', ttlMs: 3000, payload: { params: { ParamAngleX: 20, ParamAngleY: -5 } } },
    hooks,
  );
  check('正常写参数', r.ok === true, r.detail);
  check('holdMs 借用指令自己的 ttlMs', target.calls[0][2] === 3000, String(target.calls[0][2]));

  r = await runAction(target, { kind: 'param', payload: { params: {} } }, hooks);
  check('空参数被拒', r.ok === false && r.code === 'E_ACTION_BAD_VALUE');

  r = await runAction(target, { kind: 'param', payload: { params: { ParamAngleX: '大' } } }, hooks);
  check('全是非数字等于没有参数', r.ok === false && r.code === 'E_ACTION_BAD_VALUE');

  // ★ 口型参数被独占：必须如实说，不能让 AI 以为它改了嘴巴。
  const mouthTarget = makeTarget({
    parameterOutcome: { applied: [], dropped: ['ParamMouthOpenY'], ignored: [] },
  });
  r = await runAction(mouthTarget, { kind: 'param', payload: { params: { ParamMouthOpenY: 1 } } }, hooks);
  check(
    '★ 只写口型参数时如实说「被语音通道独占」',
    r.ok === false && r.code === 'E_ACTION_PARAMETER_IGNORED' && r.detail.includes('独占'),
    r.detail,
  );

  const unknownTarget = makeTarget({
    parameterOutcome: { applied: [], dropped: [], ignored: ['ParamNotThere'] },
  });
  r = await runAction(unknownTarget, { kind: 'param', payload: { params: { ParamNotThere: 1 } } }, hooks);
  check(
    '★ 参数不存在时如实说「模型里没有」',
    r.ok === false && r.code === 'E_ACTION_PARAMETER_IGNORED' && r.detail.includes('没有这些参数'),
    r.detail,
  );

  r = await runAction(null, { kind: 'param', payload: { params: { ParamAngleX: 1 } } }, hooks);
  check('没有模型时报 E_ACTION_NO_MODEL', r.ok === false && r.code === 'E_ACTION_NO_MODEL');

  check('collectParameters 只收有限数字', JSON.stringify(collectParameters({ a: 1, b: NaN, c: Infinity, d: '3', e: true })) === '{"a":1}');
  check('collectParameters 对垃圾输入返回空对象', Object.keys(collectParameters(null)).length === 0 && Object.keys(collectParameters([1, 2])).length === 0 && Object.keys(collectParameters('x')).length === 0);
}

/* ───────────────────────── [9b] ★ emotion ───────────────────────── */

console.log('\n[9b] emotion：情绪层（叠加，不是硬写）');
{
  const target = makeTarget();
  const { hooks } = makeHooks();

  let r = await runAction(
    target,
    {
      kind: 'emotion',
      ttlMs: 4000,
      payload: {
        emotion: {
          name: '开心',
          intensity: 1,
          holdMs: 2500,
          attackMs: 180,
          releaseMs: 500,
          params: { ParamEyeLSmile: 0.7, ParamCheek: 0.5 },
        },
      },
    },
    hooks,
  );
  check('正常下一次情绪', r.ok === true, r.detail);
  check(
    '★ 走的是 setEmotion，而不是 setParameterOverride',
    kinds(target.calls)[0] === 'setEmotion' && !kinds(target.calls).includes('setParameterOverride'),
    kinds(target.calls).join('、'),
  );
  check(
    '★ 参数包原样交下去（一个数都没被改）',
    JSON.stringify(target.calls[0][1]) === '{"ParamEyeLSmile":0.7,"ParamCheek":0.5}',
    JSON.stringify(target.calls[0][1]),
  );
  check(
    '★ 名字与三段时长都传到底了（淡入 / 保持 / 淡出）',
    target.calls[0][2]?.name === '开心'
      && target.calls[0][2]?.holdMs === 2500
      && target.calls[0][2]?.attackMs === 180
      && target.calls[0][2]?.releaseMs === 500,
    JSON.stringify(target.calls[0][2]),
  );
  check('正文报出叠了哪些参数', r.detail.includes('ParamEyeLSmile'), r.detail);

  /*
   * ★ 「平静」= 空参数表 = 清空情绪层。
   * 这不是错误路径 —— 它是一条**要能走通**的正常路：她笑完之后总得收回来，
   * 而收回来和「摆一张平静的脸」是两件不同的事（后者会把她的眉毛按死）。
   */
  const calm = makeTarget();
  r = await runAction(calm, { kind: 'emotion', payload: { emotion: { name: '平静', params: {} } } }, hooks);
  check('★ 空参数表 = 清空情绪层（不是报错）', r.ok === true && kinds(calm.calls)[0] === 'clearEmotion', r.detail);
  check('清空时不碰叠加层', !kinds(calm.calls).includes('setEmotion'));

  r = await runAction(makeTarget(), { kind: 'emotion', payload: { emotion: { params: {} } } }, hooks);
  check('既没名字也没参数 → E_ACTION_BAD_VALUE', r.ok === false && r.code === 'E_ACTION_BAD_VALUE');

  /*
   * ★ 「只收思考态」那条路：payload 里**没有名字也没有参数**，只有一个 `release`
   * 数组。它必须走 `releaseEmotion` —— 落进上面那条空参数表分支的话，一条完全
   * 正确的指令会被答成「这条情绪指令既没有名字也没有参数」，而症状是「说完之后
   * 她的思考脸一直挂着」（指令被丢掉，没人收）。
   */
  const keeper = makeTarget();
  r = await runAction(
    keeper,
    { kind: 'emotion', payload: { emotion: { release: ['思考'], params: {} } } },
    hooks,
  );
  check('★ 「只收」是一条能走通的正常路（没有名字也没有参数，但不是坏指令）',
    r.ok === true && kinds(keeper.calls)[0] === 'releaseEmotion', `${r.code} ${r.detail}`);
  check('★ 收的是点名的那些层，一个不多一个不少',
    JSON.stringify(keeper.calls[0]?.[1]) === '["思考"]', JSON.stringify(keeper.calls[0]?.[1]));
  check('★ 挑着收的时候不碰别的路（既没有 setEmotion，也没有 clearEmotion —— 后者是一把全清）',
    !kinds(keeper.calls).includes('setEmotion') && !kinds(keeper.calls).includes('clearEmotion'),
    kinds(keeper.calls).join('、'));
  check('正文说清了收掉的是什么', /收掉/.test(r.detail) && r.detail.includes('思考'), r.detail);

  const absent = makeTarget({ releaseOutcome: { released: [], unknown: ['开心'] } });
  r = await runAction(absent, { kind: 'emotion', payload: { emotion: { release: ['开心'] } } }, hooks);
  check('★ 那一层本来就不在场上 → 仍然算成功，但如实说「不在场」（既不静默成功，也不假装失败）',
    r.ok === true && /不在场/.test(r.detail), `${r.code} ${r.detail}`);

  const junkRelease = makeTarget();
  r = await runAction(
    junkRelease,
    { kind: 'emotion', payload: { emotion: { release: ['思考', 42, '', '  '] } } },
    hooks,
  );
  check('★ 坏元素被挑掉（只有非空字符串算名字），剩下的照收',
    JSON.stringify(junkRelease.calls[0]?.[1]) === '["思考"]', JSON.stringify(junkRelease.calls[0]?.[1]));

  const emptyRelease = makeTarget();
  r = await runAction(emptyRelease, { kind: 'emotion', payload: { emotion: { release: [] } } }, hooks);
  check('空 release 数组不算「只收」—— 它落回「既没名字也没参数」那条老路',
    r.ok === false && r.code === 'E_ACTION_BAD_VALUE', `${r.code} ${r.detail}`);

  const releaseNoModel = await runAction(
    null,
    { kind: 'emotion', payload: { emotion: { release: ['思考'] } } },
    hooks,
  );
  check('没有模型时「只收」同样报 E_ACTION_NO_MODEL',
    releaseNoModel.ok === false && releaseNoModel.code === 'E_ACTION_NO_MODEL');

  // 模型里一个都没有 ⇒ 如实失败（能力清单与实际模型不一致时唯一诚实的答复）。
  const empty = makeTarget({ emotionOutcome: { applied: [], dropped: [], ignored: ['ParamCheek'] } });
  r = await runAction(
    empty,
    { kind: 'emotion', payload: { emotion: { name: '开心', params: { ParamCheek: 0.5 } } } },
    hooks,
  );
  check(
    '★ 模型里没有这些参数时如实失败，并报出是哪些',
    r.ok === false && r.code === 'E_ACTION_PARAMETER_IGNORED' && r.detail.includes('ParamCheek'),
    r.detail,
  );

  r = await runAction(null, { kind: 'emotion', payload: { emotion: { name: '开心', params: { ParamCheek: 1 } } } }, hooks);
  check('没有模型时报 E_ACTION_NO_MODEL', r.ok === false && r.code === 'E_ACTION_NO_MODEL');

  /*
   * 门禁不替执行层发明默认值：`holdMs` 缺省时应当原样是 `undefined`，
   * 让「默认保持多久」只写在 `pet-model` 一处。两边各写一个 2500 的那天，
   * 改了一边就会得到「Host 说 2.5 秒、她保持 5 秒」。
   */
  const bare = makeTarget();
  await runAction(bare, { kind: 'emotion', payload: { emotion: { name: '好奇', params: { ParamAngleZ: 6 } } } }, hooks);
  check(
    '缺省时长原样是 undefined（默认值只在渲染端一处）',
    bare.calls[0][2]?.holdMs === undefined && bare.calls[0][2]?.attackMs === undefined,
    JSON.stringify(bare.calls[0][2]),
  );
}

/* ───────────────────────── [9c] 单条微动作 ───────────────────────── */

console.log('\n[9c] microMotion：点名演一条（§13.30）');
{
  const target = makeTarget();
  const { hooks } = makeHooks();
  let r = await runAction(target, { kind: 'microMotion', payload: { microMotion: { id: 'head-tilt' } } }, hooks);
  check(
    '正常点名：交给 target.playMicroMotion，参数就是那个 id',
    r.ok === true && r.handled === true
      && target.calls.length === 1 && target.calls[0][0] === 'playMicroMotion' && target.calls[0][1] === 'head-tilt',
    JSON.stringify(target.calls),
  );

  r = await runAction(target, { kind: 'microMotion', payload: { microMotion: { id: '  glance-left  ' } } }, hooks);
  check('id 两头的空白被清掉', target.calls[1][1] === 'glance-left', JSON.stringify(target.calls[1]));

  r = await runAction(target, { kind: 'microMotion', payload: {} }, hooks);
  check('没有 id 时如实拒绝', r.ok === false && r.code === 'E_ACTION_BAD_VALUE', r.code);

  r = await runAction(target, { kind: 'microMotion', payload: { microMotion: { id: 42 } } }, hooks);
  check('id 不是字符串也算没给', r.ok === false && r.code === 'E_ACTION_BAD_VALUE', r.code);

  r = await runAction(null, { kind: 'microMotion', payload: { microMotion: { id: 'nod' } } }, hooks);
  check('没有模型时报 E_ACTION_NO_MODEL', r.ok === false && r.code === 'E_ACTION_NO_MODEL', r.code);

  /*
   * 旧页面（刷新前那份 bundle）+ 新 Host：`playMicroMotion` 根本不在 target 上。
   * 这时必须报「不支持」，不能静默成功 —— 否则 AI 会说「她歪了下头」，
   * 而屏幕上的她一动不动。
   */
  const legacy = makeTarget();
  delete legacy.playMicroMotion;
  r = await runAction(legacy, { kind: 'microMotion', payload: { microMotion: { id: 'nod' } } }, hooks);
  check(
    '★ 旧渲染端没有这个方法时报 E_ACTION_UNSUPPORTED（不是假成功）',
    r.ok === false && r.code === 'E_ACTION_UNSUPPORTED' && r.detail.includes('刷新'),
    `${r.code} ${r.detail}`,
  );

  // 渲染端自己失败（比如这个模型没有那一页）要原样透传。
  const failing = makeTarget({ mode: { microMotion: { ok: false, code: 'E_MICRO_UNKNOWN_GESTURE', detail: '没有这条' } } });
  r = await runAction(failing, { kind: 'microMotion', payload: { microMotion: { id: 'nope' } } }, hooks);
  check(
    '渲染端的失败码与说明原样透传',
    r.ok === false && r.code === 'E_MICRO_UNKNOWN_GESTURE' && r.detail === '没有这条',
    `${r.code} ${r.detail}`,
  );

  check('HANDLED_KINDS 认这个 kind', HANDLED_KINDS.includes('microMotion'));
}

/* ───────────────────────── [10] 过期 ───────────────────────── */

console.log('\n[10] isExpired：过期判定');
{
  const now = 1_000_000;
  check('刚好到点算过期', isExpired({ kind: 'say', ttlMs: 4000 }, now - 4000, now) === false, 'now - at === ttl 不算过期');
  check('超过一点就过期', isExpired({ kind: 'say', ttlMs: 4000 }, now - 4001, now) === true);
  check('没过期', isExpired({ kind: 'say', ttlMs: 4000 }, now - 100, now) === false);
  check('没有 ttlMs 永不过期', isExpired({ kind: 'say' }, now - 999_999, now) === false);
  check('ttlMs 非数字永不过期', isExpired({ kind: 'say', ttlMs: '4s' }, now - 999_999, now) === false);
  check('ttlMs 为 0 或负数当没有限制', isExpired({ kind: 'say', ttlMs: 0 }, now - 999_999, now) === false && isExpired({ kind: 'say', ttlMs: -5 }, now - 999_999, now) === false);
  check('at 不是数字时不过期', isExpired({ kind: 'say', ttlMs: 1 }, 'x', now) === false);

  // ★ 这条是本文件的重点：一条 5 分钟前的 stop 也必须执行。
  check(
    '★ stop 永远不过期（丢掉它等于「立刻停下」变成「什么都不做」）',
    isExpired({ kind: 'stop', ttlMs: 4000 }, now - 300_000, now) === false,
  );
  check(
    '★ 旧垫片形状的 stop 也不过期',
    isExpired({ kind: 'stop' }, now - 300_000, now) === false,
  );
}

/* ───────────────────────── [11] 不认得的指令 ───────────────────────── */

console.log('\n[11] 不认得的 kind 要如实说「没处理」');
{
  const target = makeTarget();
  const { hooks, spoken, stopped } = makeHooks();

  let r = await runAction(target, { kind: 'dance' }, hooks);
  check('★ 不认得的 kind：handled=false 且不假装成功', r.handled === false && r.ok === false && r.code === 'E_ACTION_UNSUPPORTED_KIND', r.code);
  check('不认得的 kind 不会碰模型', target.calls.length === 0);
  check('不认得的 kind detail 里列出已认识的种类', r.detail.includes('say') && r.detail.includes('stop'), r.detail);

  r = await runAction(target, {}, hooks);
  check('没有 kind 也是 UNKNOWN_KIND', r.handled === false && r.code === 'E_ACTION_UNKNOWN_KIND');

  r = await runAction(target, null, hooks);
  check('null 指令不抛异常', r.handled === false && r.ok === false);

  r = await runAction(target, undefined, hooks);
  check('undefined 指令不抛异常', r.handled === false && r.ok === false);

  r = await runAction(target, '这不是对象', hooks);
  check('字符串指令不抛异常', r.handled === false && r.ok === false);

  r = await runAction(target, 42, hooks);
  check('数字指令不抛异常', r.handled === false && r.ok === false);

  check('这些都没有偷偷说话或停下', spoken.length === 0 && stopped.length === 0);
}

/* ───────────────────────── [12] 空闲行为 ───────────────────────── */

console.log('\n[12] 空闲行为：该不该自己动一下');
{
  const now = 1_000_000;
  const idle = IDLE_AFTER_MS;
  // 第四个参数是「现在正在播的动作优先级」：0 = 什么都没在播。
  const nothing = 0;

  check('IDLE_AFTER_MS 是一个合理的秒级常量（10–60 秒）', idle >= 10000 && idle <= 60000, String(idle));

  check('刚有指令来过：不待机', shouldAutoIdle(now - 1000, 0, now, nothing, idle) === false);
  check('刚过一半时间：还不待机', shouldAutoIdle(now - idle / 2, 0, now, nothing, idle) === false);
  check('★ 刚好到点：待机', shouldAutoIdle(now - idle, 0, now, nothing, idle) === true);
  check('久得多：当然待机', shouldAutoIdle(now - idle * 5, 0, now, nothing, idle) === true);

  // ★ 这一条是防「每 1.2 秒重播一次」的：没有它，用户看到的是她一直在抽第一帧。
  check(
    '★ 刚自动待机过：即使还是没人说话也不重复播',
    shouldAutoIdle(now - idle * 3, now - 1000, now, nothing, idle) === false,
  );
  check(
    '上一次自动待机也超过一个周期：才再播一次',
    shouldAutoIdle(now - idle * 3, now - idle, now, nothing, idle) === true,
  );

  // 首次运行：lastActivityAt = 0 代表「还没初始化」，不能当成「很久没动」。
  check('★ lastActivityAt 为 0（未初始化）时不待机', shouldAutoIdle(0, 0, now, nothing, idle) === false);
  check('时间戳非数字时不待机（不抛）', shouldAutoIdle(NaN, 0, now, nothing, idle) === false && shouldAutoIdle(now - idle, NaN, now, nothing, idle) === false && shouldAutoIdle(now - idle, 0, NaN, nothing, idle) === false);

  /*
   * ★ 第四个条件：正在播「正经动作」时不许待机。
   *
   * 框架**不拦**任何新动作（`startMotionPriority()` 无条件开播，见方案 §4.2.12），
   * 所以「待机永远盖不掉正经动作」这句话只能由待机自己先问一句来实现。
   * 没有这条判断时：AI 让播一段 `loop: true` 的动作、或一段比 20 秒还长的动作，
   * 都会在 20 秒后被自动待机顶掉，而且不报任何错。
   */
  check(
    '★ 正在播 AI 要的动作（NORMAL）时不待机',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, FRAMEWORK_PRIORITY.NORMAL, idle) === false,
  );
  check(
    '★ 正在播强制动作（FORCE）时也不待机',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, FRAMEWORK_PRIORITY.FORCE, idle) === false,
  );
  check(
    '在播的是我们自己的待机动作（IDLE）：可以换一个',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, FRAMEWORK_PRIORITY.IDLE, idle) === true,
  );
  check(
    '什么都没在播（0）：可以待机',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, 0, idle) === true,
  );
  check(
    '优先级读数脏（NaN / 字符串 / undefined）时按「没在播」处理，不永久停摆',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, NaN, idle) === true
      && shouldAutoIdle(now - idle * 5, now - idle * 5, now, 'x', idle) === true
      && shouldAutoIdle(now - idle * 5, now - idle * 5, now, undefined, idle) === true,
  );
  check(
    'isBusyWithRealMotion 的边界：0 / 1 不算忙，2 / 3 算忙',
    isBusyWithRealMotion(0) === false && isBusyWithRealMotion(1) === false
      && isBusyWithRealMotion(2) === true && isBusyWithRealMotion(3) === true,
  );
  check(
    'FRAMEWORK_PRIORITY 三档齐全且冻结（IDLE 是待机自己的记号）',
    FRAMEWORK_PRIORITY.IDLE === 1 && FRAMEWORK_PRIORITY.NORMAL === 2 && FRAMEWORK_PRIORITY.FORCE === 3
      && Object.isFrozen(FRAMEWORK_PRIORITY),
  );
  check(
    '★ 待机的第四个条件确实让「时钟说该动、动作说别动」时不动',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, nothing, idle) === true
      && shouldAutoIdle(now - idle * 5, now - idle * 5, now, FRAMEWORK_PRIORITY.NORMAL, idle) === false,
  );

  /*
   * ★ 第五个条件：嘴还在动时不待机（§9.7 第 6 条那个已知边界）。
   *
   * `IDLE_AFTER_MS` 只数「距上次**指令**多久」，而一句长文本能念四十秒 ——
   * 念到第 20 秒计时器就到位，她会在**说话的同时**把姿势换掉。
   * 所以调用方要把「朗读通道忙不忙」传进来；这一条住在函数里，好让门禁
   * 断言得到「待机不打断朗读」这条规则，而不是调用方的一个 if。
   */
  check(
    '★ 朗读通道忙时不待机（哪怕时钟早就到点）',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, 0, idle, true) === false,
  );
  check(
    '朗读通道忙时、在播自己的待机动作也不待机（不然长句会被换姿势）',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, FRAMEWORK_PRIORITY.IDLE, idle, true) === false,
  );
  check(
    '朗读通道不忙时照常待机（第五个条件不能把关机键卡住）',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, 0, idle, false) === true,
  );
  check(
    '不传第五个参数时行为与从前一致（旧调用方不受影响）',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, 0, idle) === true,
  );
  check(
    '脏读数（非 true）不当成「忙」—— 待机不会因为一个坏值永久停摆',
    shouldAutoIdle(now - idle * 5, now - idle * 5, now, 0, idle, undefined) === true
      && shouldAutoIdle(now - idle * 5, now - idle * 5, now, 0, idle, 0) === true
      && shouldAutoIdle(now - idle * 5, now - idle * 5, now, 0, idle, 'yes') === true,
  );

  /*
   * ── §13.31 换片节奏：按片段时长换，而不是整 20 秒一刀切 ──
   *
   * hiyori 的十条动作是 `Loop: true` 的无缝片段（1.6–8.8 秒）。20 秒一刀切时，
   * 1.6 秒的那条要在她身上重复 12 遍 —— 用户看到的就是「一直循环一个动作」。
   */
  check('IDLE_LOOP_REPEATS 是 1–3 之间的小整数', Number.isInteger(IDLE_LOOP_REPEATS) && IDLE_LOOP_REPEATS >= 1 && IDLE_LOOP_REPEATS <= 3, String(IDLE_LOOP_REPEATS));
  check('换片节奏下限 < 上限，且都落在 3–30 秒内', IDLE_HOLD_MIN_MS >= 3000 && IDLE_HOLD_MAX_MS <= 30000 && IDLE_HOLD_MIN_MS < IDLE_HOLD_MAX_MS, `${IDLE_HOLD_MIN_MS}–${IDLE_HOLD_MAX_MS}`);
  check('★ 时长读不到时退回上限（宁可慢，不要一直动）', idleHoldMsFor(undefined) === IDLE_HOLD_MAX_MS && idleHoldMsFor(NaN) === IDLE_HOLD_MAX_MS && idleHoldMsFor(0) === IDLE_HOLD_MAX_MS && idleHoldMsFor(-5) === IDLE_HOLD_MAX_MS, String(idleHoldMsFor(undefined)));
  check('★ 短片段被抬到下限（1.6 秒 → 6 秒）', idleHoldMsFor(1600) === IDLE_HOLD_MIN_MS, String(idleHoldMsFor(1600)));
  check('中等片段按时长 × 循环数（4.6 秒 → 9.2 秒）', idleHoldMsFor(4600) === Math.round(4600 * IDLE_LOOP_REPEATS), String(idleHoldMsFor(4600)));
  check('★ 长片段被封顶（8.8 秒 → 12 秒）', idleHoldMsFor(8770) === IDLE_HOLD_MAX_MS, String(idleHoldMsFor(8770)));
  check('脏输入（字符串 / Infinity / null）也退回上限，不抛', idleHoldMsFor('3000') === IDLE_HOLD_MAX_MS && idleHoldMsFor(Infinity) === IDLE_HOLD_MAX_MS && idleHoldMsFor(null) === IDLE_HOLD_MAX_MS);

  check('★ 只有一个动作时永远挑 0（没有「避开」的余地）', pickIdleIndex(1, 0) === 0 && pickIdleIndex(1, 0, () => 0.99) === 0);
  check('没有动作时回 -1（调用方据此不播）', pickIdleIndex(0, -1) === -1 && pickIdleIndex(NaN, 0) === -1);
  check(
    '★ 避开上一条：随机源穷举时，撞上的那一格被挪到别人身上，且永远不等于 avoidIndex',
    [...Array(100).keys()].every((i) => {
      const r = i / 100;
      const picked = pickIdleIndex(10, 3, () => r);
      return picked !== 3 && picked >= 0 && picked < 10;
    }),
  );
  check(
    '★ 不避开时仍是纯随机（avoidIndex 非法/越界都不影响分布）',
    [...Array(100).keys()].every((i) => {
      const r = i / 100;
      return pickIdleIndex(10, -1, () => r) === pickIdleIndex(10, -1, () => r)
        && pickIdleIndex(10, 99, () => r) === pickIdleIndex(10, -1, () => r)
        && pickIdleIndex(10, NaN, () => r) === pickIdleIndex(10, -1, () => r);
    }),
  );
  check(
    '避开后仍然覆盖所有非 avoid 的序号（不是固定挪一格）',
    new Set([...Array(50).keys()].map((i) => pickIdleIndex(4, 1, () => i / 50))).size === 3,
  );

  /*
   * ★ 两个阈值必须分开：① 距上次指令 20 秒不能被换片节奏带短，
   * ② 距上次待机才随片段时长变。
   */
  check(
    '★ 换片节奏只作用于「距上次待机」，不缩短「距上次指令」的 20 秒',
    shouldAutoIdle(now - 8000, now - 6000, now, 0, idle, false, 6000) === false
      && shouldAutoIdle(now - idle, now - 6000, now, 0, idle, false, 6000) === true,
  );
  check(
    '换片节奏非法（0 / NaN / 负数）时退回 idleAfterMs 的老行为',
    shouldAutoIdle(now - idle, now - 1000, now, 0, idle, false, 0) === false
      && shouldAutoIdle(now - idle, now - 1000, now, 0, idle, false, NaN) === false
      && shouldAutoIdle(now - idle, now - idle, now, 0, idle, false, -1) === true,
  );

  /*
   *
   * 这一段读一次源码（不执行）：第五个条件再好，如果 `plugin.ts` 那一句
   * 还是四参数调用，真机上就一点用都没有 —— 而那种漏法在离线门禁里
   * 完全看不出来（纯函数单测永远绿）。
   */
  const pluginSource = readFileSync(PACKAGE + '/src/client/plugin.ts', 'utf8');
  check(
    'plugin.ts 真的把「朗读通道忙不忙」算出来了',
    /const speechBusy = getSpeechLane\(\)\.busy\(\) \|\| getSpeechPlayer\(\)\.state\.speaking;/.test(pluginSource),
  );
  check(
    '★ plugin.ts 调 shouldAutoIdle 时把 speechBusy 传进去了',
    /shouldAutoIdle\(\s*lastActivityAt,\s*lastAutoIdleAt,\s*now,\s*motionPriority,\s*IDLE_AFTER_MS,\s*speechBusy,/.test(
      pluginSource,
    ),
  );
  /*
   * ★ §13.31：换片节奏与防重演。
   *
   * 这一段的失败模式全都**离线看不出来**：纯函数再对，调用点少传一个参数，
   * 真机上就还是「一条动作循环 20 秒」。
   */
  check(
    '★ plugin.ts 调 shouldAutoIdle 时把换片节奏（idleHoldMs）传进去了',
    /shouldAutoIdle\(\s*lastActivityAt,\s*lastAutoIdleAt,\s*now,\s*motionPriority,\s*IDLE_AFTER_MS,\s*speechBusy,\s*idleHoldMs,?\s*\)/.test(
      pluginSource,
    ),
  );
  check(
    '★ plugin.ts 播待机时把「上一条的序号」传成 avoidIndex',
    /avoidIndex:\s*lastIdleIndex/.test(pluginSource),
  );
  check(
    '★ plugin.ts 播成之后读回 motionIndex / motionDurationMs',
    /idleResult\.motionIndex/.test(pluginSource) && /idleHoldMsFor\(idleResult\.motionDurationMs\)/.test(pluginSource),
  );
  /*
   * `PetModel.playMotion()` 那一侧：`avoidIndex` 只在**没点名**时才生效。
   * AI 说「播第 3 个」，不能因为上次也是第 3 个就擅自换一个。
   */
  const petModelSource = readFileSync(PACKAGE + '/src/client/pet-model.ts', 'utf8');
  check(
    '★ pet-model.ts 先算出 explicitIndex，再决定要不要避开（点名优先于避重）',
    /const explicitIndex = typeof index === 'number' && isFinite\(index\) \? Math\.trunc\(index\) : null;/.test(
      petModelSource,
    ) && /if \(explicitIndex !== null\) \{/.test(petModelSource),
  );
  check(
    '★ pet-model.ts 只在随机挑时读 avoidIndex',
    /wanted === avoid/.test(petModelSource) && /options\?\.avoidIndex/.test(petModelSource),
  );
  check(
    '★ pet-model.ts 用 getLoopDuration() 量片段（循环动作的 getDuration() 是 -1）',
    /getLoopDuration\?\.\(\)/.test(petModelSource) && !/getDuration\?\.\(\)/.test(petModelSource),
  );
  check(
    '★ pet-model.ts 播放成功时回传 motionIndex 与 motionDurationMs',
    /motionIndex: wanted,/.test(petModelSource) && /motionDurationMs,/.test(petModelSource),
  );
  check(
    '★ 「刚念完」会把活动时钟拨回当下（不然长句一结束就立刻换姿势）',
    /if \(speechWasBusy && !speechBusy\) \{\s*lastActivityAt = Date\.now\(\);/.test(pluginSource),
  );
  check(
    '待机决策在 plugin.ts 里只有一处调用（两处就是「顺手又加了一层」，参数会互相打架）',
    pluginSource.split('shouldAutoIdle(').length - 1 === 1,
  );
  /*
   * `isOwnIdleMotion` 守的是「换待机之前先收尸」这一步。
   *
   * 只认 IDLE 这一档，一个数字都不能多认：`2` / `3` 是 AI 要的动作，
   * 把它们判成「自己的待机」会让调用方去 `stopMotion()` —— 那就是
   * 「待机盖掉正经动作」，§4.2.12 明令禁止的那件事。
   * 非有限数一律 `false`（脏读数不该触发一次停动作）。
   */
  check(
    '★ isOwnIdleMotion 只认 IDLE 这一档，2 / 3 绝不认',
    isOwnIdleMotion(FRAMEWORK_PRIORITY.IDLE) === true
      && isOwnIdleMotion(FRAMEWORK_PRIORITY.NORMAL) === false
      && isOwnIdleMotion(FRAMEWORK_PRIORITY.FORCE) === false,
  );
  check(
    'isOwnIdleMotion：0 / 负 / NaN / Infinity / 字符串 / undefined 都不算自己的待机',
    isOwnIdleMotion(0) === false && isOwnIdleMotion(-1) === false
      && isOwnIdleMotion(NaN) === false && isOwnIdleMotion(Infinity) === false
      && isOwnIdleMotion('1') === false && isOwnIdleMotion(undefined) === false
      && isOwnIdleMotion(null) === false,
  );
  check(
    '★ 「忙」与「自己的待机」互斥且合起来覆盖全部三档',
    [0, 1, 2, 3].every(
      (p) => !(isBusyWithRealMotion(p) && isOwnIdleMotion(p)),
    ),
  );

  check('pickIdleGroup 优先挑名字含 idle 的', pickIdleGroup(['Tap', 'Idle', 'Happy']) === 'Idle');
  check('pickIdleGroup 大小写不敏感', pickIdleGroup(['IDLE_01']) === 'IDLE_01');
  check('pickIdleGroup 没有 idle 组时退到第一组', pickIdleGroup(['Tap', 'Happy']) === 'Tap');
  check('pickIdleGroup 空列表返回空串（调用方据此什么都不做）', pickIdleGroup([]) === '');
  check('pickIdleGroup 对垃圾输入返回空串', pickIdleGroup(null) === '' && pickIdleGroup('Idle') === '' && pickIdleGroup([1, 2]) === '');
}

/* ───────────────────────── [13] 反向验证 ───────────────────────── */

console.log('\n[13] 反向验证：退化实现确实与真实现不同');
{
  // 退化 1：不判过期 —— 面板折叠一分钟后回来，八条旧指令全部重放。
  const naiveExpired = () => false;
  const now = 1_000_000;
  const stale = { kind: 'say', ttlMs: 4000 };
  check('退化「不判过期」与真实现结论不同', naiveExpired() !== isExpired(stale, now - 60_000, now));

  // 退化 2：把 stop 也按 TTL 判 —— 用户喊停时可能什么都没发生。
  const naiveStop = isExpired({ kind: 'say', ttlMs: 4000 }, now - 60_000, now);
  check('退化「stop 也判过期」与真实现结论不同', naiveStop !== isExpired({ kind: 'stop', ttlMs: 4000 }, now - 60_000, now));

  // 退化 3：不认得的 kind 当成成功 —— 「她没反应」会被归咎于 AI 而不是版本。
  const naiveRun = async () => ({ handled: true, ok: true, code: '', detail: '' });
  const target = makeTarget();
  const { hooks } = makeHooks();
  const real = await runAction(target, { kind: 'dance' }, hooks);
  const naive = await naiveRun();
  check('退化「不认得的 kind 也算成功」与真实现结论不同', naive.ok !== real.ok || naive.handled !== real.handled);

  // 退化 4：没有模型时 motion 假装成功。
  const naiveNoModel = { ok: true, code: '', detail: '' };
  const realNoModel = await runAction(null, { kind: 'motion', payload: { motion: { group: 'Idle' } } }, hooks);
  check('退化「没有模型也算成功」与真实现结论不同', naiveNoModel.ok !== realNoModel.ok);

  // 退化 5：待机只看「多久没说话」—— 结果是每 1.2 秒重播一次动作。
  const naiveIdle = (lastActivityAt, _lastAutoIdleAt, nowMs, _priority, idleAfterMs) => nowMs - lastActivityAt >= idleAfterMs;
  const args = [now - IDLE_AFTER_MS * 3, now - 1000, now, 0, IDLE_AFTER_MS];
  check('退化「待机不看去重时钟」与真实现结论不同', naiveIdle(...args) !== shouldAutoIdle(...args));

  /*
   * 退化 6：待机不看「现在播的是什么」—— 时钟一到就开播。
   * 这就是修 §4.2.12 之前的行为：AI 要的循环动作会在 20 秒后被顶掉。
   */
  const naiveIdleIgnoreMotion = (lastActivityAt, lastAutoIdleAt, nowMs, _priority, idleAfterMs) => (
    nowMs - lastActivityAt >= idleAfterMs && nowMs - lastAutoIdleAt >= idleAfterMs
  );
  const busyArgs = [now - IDLE_AFTER_MS * 5, now - IDLE_AFTER_MS * 5, now, FRAMEWORK_PRIORITY.NORMAL, IDLE_AFTER_MS];
  check(
    '★ 退化「待机不看在播什么」与真实现结论不同（AI 的循环动作会被顶掉）',
    naiveIdleIgnoreMotion(...busyArgs) !== shouldAutoIdle(...busyArgs),
  );

  /*
   * 退化 7：待机不问「嘴还在不在动」—— 这就是 §9.7 第 6 条：
   * 一句 40 秒的长文本念到第 20 秒，姿势被换掉。
   */
  const naiveIdleIgnoreSpeech = (
    lastActivityAt, lastAutoIdleAt, nowMs, _priority, idleAfterMs, _speechBusy,
  ) => nowMs - lastActivityAt >= idleAfterMs && nowMs - lastAutoIdleAt >= idleAfterMs;
  const speechArgs = [now - IDLE_AFTER_MS * 5, now - IDLE_AFTER_MS * 5, now, 0, IDLE_AFTER_MS, true];
  check(
    '★ 退化「待机不问嘴还在不在动」与真实现结论不同（长句会被换姿势）',
    naiveIdleIgnoreSpeech(...speechArgs) !== shouldAutoIdle(...speechArgs),
  );
}

/* ───────────────────────── 收尾 ───────────────────────── */

console.log('');
if (failed === 0) {
  console.log(`[14] ACTION RUNNER GATE PASSED —— ${passed} 项断言全绿`);
  process.exit(0);
}
console.error(`[14] ACTION RUNNER GATE FAILED —— ${passed} 项通过，${failed} 项失败`);
process.exit(1);
