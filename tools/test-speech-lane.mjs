#!/usr/bin/env node
/**
 * 门禁：**朗读通道**（`lib/test/speech-lane.mjs` ＝ `src/client/speech-lane.ts`）。
 *
 * ## 为什么需要这个文件
 *
 * 它守的是一个**靠耳朵才发现**的真缺陷：`/pending` 一批里若有两条 `say`，
 * 第一条会被第二条掐断。链路是
 *
 *     runAction 的 say 分支 await hooks.speak(text)
 *       → speakNow 等 /speak 往返（缓存命中约 50ms）
 *       → playBase64() 开头的 teardown() 掐掉上一句
 *       → **而 playBase64() 在「开始播」时就 resolve 了，不是播完**
 *       → 循环立刻处理第二条 → 把第一条掐断
 *
 * 结论：AI 说了一句话，她只哼了半声就跳下一句，而**日志全绿**。`test-speech-player.mjs`
 * 守的是播放器自己（「开播/停/包络」），它永远不会发现这个问题 —— 因为播放器的
 * 行为是**对的**（`playBase64` 就是「现在播这个」的原语）。缺的是原语之上那条队列。
 *
 * ## 用法
 *
 *     node tools/test-speech-lane.mjs     （离线：无网络、无 DOM、无文件系统）
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, '..', 'dsh-live2d-pet', 'lib/test/speech-lane.mjs');

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
  console.error(`朗读通道的测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const { createSpeechLane, speakWithInterrupt, waitForPlayer } = mod;

/** 把微任务队列排空。通道的 pump 全部跑在微任务上，不等一下什么也看不到。 */
const settle = () => new Promise((r) => setTimeout(r, 0));

/* ───────────────────────── 夹具 ───────────────────────── */

/**
 * 假的「播放器 + 合成接口」。
 *
 * 关键能力是**手动决定「这一句播完了」的时刻**：真播放器的结束信号来自音频
 * 解码器，在 Node 里没法复现；而通道要做的全部判断都发生在「这句结束了吗」
 * 这个时间点上。所以 `finish()` 就是这套夹具的核心。
 *
 * `speakDelay` 模拟合成往返（`speak` 里 await 一下），用来复现「叫停发生在
 * 合成途中」那条路径 —— 那是 `isCancelled` 存在的唯一理由。
 */
function makeLane(options = {}) {
  const events = [];
  const errors = [];
  /*
   * 每次 `speak()` 收到的**完整请求**（`{ text, voice, rate }`）。
   *
   * 单独开一个数组而不是塞进 `events`：`events` 的字符串格式被十几条断言
   * 逐字比对（`speak:甲` / `started:甲`），往里加字段会让它们全体改口径。
   * 而 `voice` / `rate` 需要的是「原样透传」这种结构性断言，不是文案比对。
   */
  const requests = [];
  const throwOn = new Set(options.speakThrows ?? []);
  const waitThrowOn = new Set(options.waitThrows ?? []);
  let current = '';
  let release = null;
  let stopCount = 0;

  const hooks = {
    async speak(request, isCancelled) {
      /*
       * 通道交过来的是 `SpeechRequest` 对象（`speech-lane.ts`），不是字符串。
       * 夹具必须照真实现那样读 `.text` —— 直接当字符串用会得到
       * `[object Object]`，于是所有文案断言一起红（这正是第一版发生的事）。
       */
      if (request === null || typeof request !== 'object' || typeof request.text !== 'string') {
        throw new Error(`通道交过来的不是 SpeechRequest：${String(request)}`);
      }
      const text = request.text;
      requests.push({ text, voice: request.voice, rate: request.rate });
      current = text;
      events.push(`speak:${text}`);
      if (typeof options.speakDelay === 'number' && options.speakDelay > 0) {
        await new Promise((r) => setTimeout(r, options.speakDelay));
      }
      if (throwOn.has(text)) throw new Error(`合成失败：${text}`);
      // 真实实现（`speakNow`）就是在这里问一次：合成回来了，这句还算数吗。
      if (typeof isCancelled === 'function' && isCancelled()) {
        events.push(`丢弃:${text}`);
        return;
      }
      events.push(`started:${text}`);
    },
    waitUntilDone() {
      events.push(`wait:${current}`);
      return new Promise((res, rej) => {
        release = () => {
          release = null;
          if (waitThrowOn.has(current)) rej(new Error(`播放器炸了：${current}`));
          else res();
        };
      });
    },
    stop() {
      stopCount += 1;
      events.push('stop');
      /*
       * ★ 真实播放器的 `stop()` 会把 `state.speaking` 置回 false 并 notify，
       * 于是挂在 `waitForPlayer()` 上的那个 Promise **立刻** resolve。这条夹具
       * 必须照做，否则它比真实播放器更「粘」—— 通道在新句子到来之前会显得
       * 一直卡着，而生产代码里根本不会（`speech.ts:513` 的 `stop()`）。
       */
      const r = release;
      if (r !== null) {
        events.push(`wait结束:${current}`);
        r();
      }
    },
    onError(error) {
      errors.push(String(error?.message ?? error));
    },
  };

  const lane = createSpeechLane(hooks);
  return {
    lane,
    hooks,
    events,
    errors,
    /** 每次 `speak()` 收到的完整请求（用来断言 `voice` / `rate` 原样透传）。 */
    requests,
    /** 放行当前这一句。返回 false 表示此刻没有句子在等。 */
    finish() {
      const r = release;
      if (r === null) return false;
      r();
      return true;
    },
    get stopCount() {
      return stopCount;
    },
    get current() {
      return current;
    },
  };
}

/** 用来验 `waitForPlayer()` 的假播放器。 */
function makePlayer(speaking = false, durationSeconds = 0) {
  const listeners = new Set();
  return {
    state: { speaking, durationSeconds },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 模拟 `onended` / `onerror` / `stop()` 三条路径共同的结果。 */
    end() {
      this.state.speaking = false;
      for (const l of [...listeners]) l();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/* ───────────────────────── [1] 导出契约 ───────────────────────── */

console.log('\n[1] 导出契约');
{
  check('createSpeechLane 是函数', typeof createSpeechLane === 'function');
  check('waitForPlayer 是函数', typeof waitForPlayer === 'function');
  check('speakWithInterrupt 是函数', typeof speakWithInterrupt === 'function');

  const h = makeLane();
  const methods = ['enqueue', 'stopAll', 'queued', 'busy'];
  check(
    `通道有这四个方法：${methods.join(' / ')}`,
    methods.every((m) => typeof h.lane[m] === 'function'),
  );
  check('新通道是空闲的', h.lane.busy() === false && h.lane.queued() === 0);
}

/* ───────────────────────── [2] ★ 串行（这次的回归） ───────────────────────── */

console.log('\n[2] ★ 串行：第二句必须等第一句播完');
{
  const h = makeLane();
  h.lane.enqueue('第一句');
  h.lane.enqueue('第二句');
  await settle();

  check('第一句已经开始', h.events.includes('started:第一句'));
  check('正在等第一句播完', h.events.includes('wait:第一句'));
  check('★ 第一句播完之前，第二句不会开始', !h.events.includes('speak:第二句'), `事件：${h.events.join(' → ')}`);
  check('queued() 报出还有 1 句在排队', h.lane.queued() === 1);
  check('busy() 为真（正在说话）', h.lane.busy() === true);

  check('放行第一句', h.finish() === true);
  await settle();
  check('★ 第一句播完之后第二句才开始', h.events.includes('speak:第二句'));
  check('第二句也已开始播', h.events.includes('started:第二句'));
  check('队列已空', h.lane.queued() === 0);

  h.finish();
  await settle();
  check('两句都播完之后通道空闲', h.lane.busy() === false && h.lane.queued() === 0);
  check('没有报任何错', h.errors.length === 0, h.errors.join(' / '));
  check(
    '事件顺序是「一二句严格前后」',
    h.events.indexOf('started:第一句') < h.events.indexOf('speak:第二句'),
  );
}

/* ───────────────────────── [3] stopAll ───────────────────────── */

console.log('\n[3] stopAll：清排队 + 掐当前');
{
  const h = makeLane();
  h.lane.enqueue('甲');
  h.lane.enqueue('乙');
  h.lane.enqueue('丙');
  await settle();

  check('叫停之前队列里有 2 句', h.lane.queued() === 2);
  h.lane.stopAll();
  await settle();

  check('stopAll 清空了排队（§6.1 #6 的「队列清空」）', h.lane.queued() === 0);
  check('stopAll 叫了播放器的 stop（掐掉当前这句）', h.stopCount === 1);
  check('排队中的「乙」不会开始', !h.events.includes('speak:乙'));
  check('排队中的「丙」不会开始', !h.events.includes('speak:丙'));
  check('「甲」当时确实在等结束信号', h.events.includes('wait:甲'));
  check('★ stop 让「甲」的等待立刻结束（真实播放器的 stop 就是这样）', h.events.includes('wait结束:甲'));

  await settle();
  check('★ 放行之后也不会把「乙」「丙」接着播', !h.events.includes('speak:乙') && !h.events.includes('speak:丙'));
  check('通道回到空闲，没有卡在 running', h.lane.busy() === false);
  check('没有多余的等待残留', h.finish() === false);
}

/* ───────────────────────── [4] ★ 叫停时还在合成的那句 ───────────────────────── */

console.log('\n[4] ★ 叫停发生在合成途中：这句话不许再出声');
{
  // 合成要 30ms。在这 30ms 里叫停 —— 正是用户「她刚开口我就喊停」的情形。
  const h = makeLane({ speakDelay: 30 });
  h.lane.enqueue('慢合成');
  await settle();
  check('合成已经发出（speak 已被调用）', h.events.includes('speak:慢合成'));
  check('此刻还没开始出声', !h.events.includes('started:慢合成'));

  h.lane.stopAll();
  check('叫停发生在合成途中', h.stopCount === 1);
  await new Promise((r) => setTimeout(r, 60));

  check('★ 合成回来之后这句话被丢弃，没有出声', h.events.includes('丢弃:慢合成'));
  check('★ 它没有被当成「已开始播」', !h.events.includes('started:慢合成'));
  check('通道空闲（没有为了等一句不会播的话而卡住）', h.lane.busy() === false);
  check('没有去等一个不会来的结束信号', !h.events.includes('wait:慢合成'));
}

/* ───────────────────────── [5] 叫停之后还能说新话（场景 2） ───────────────────────── */

console.log('\n[5] 叫停之后新句子照常播（场景 2「然后说新内容」）');
{
  const h = makeLane();
  h.lane.enqueue('旧话一');
  h.lane.enqueue('旧话二');
  await settle();
  h.lane.stopAll();
  await settle();

  h.lane.enqueue('新话');
  await settle();
  check('★ 叫停之后排的新句子照常开始（代数变了但新句子记的是新代数）', h.events.includes('started:新话'));
  check('旧句子仍然没有复活', !h.events.includes('speak:旧话二'));
  h.finish();
  await settle();
  check('新句子正常收尾', h.lane.busy() === false);
}

/* ───────────────────────── [6] 一句话坏掉不能拖垮整条通道 ───────────────────────── */

console.log('\n[6] speak / waitUntilDone 抛错都不让通道停摆');
{
  const h = makeLane({ speakThrows: ['坏话'] });
  h.lane.enqueue('坏话');
  h.lane.enqueue('好话');
  await settle();

  check('合成的异常被上报了', h.errors.some((e) => e.includes('合成失败')));
  check('★ 坏话之后的好话照样播（通道没有停摆）', h.events.includes('started:好话'));
  check('坏话没有被当成「已开始播」', !h.events.includes('started:坏话'));
  check('坏话不需要结束信号', !h.events.includes('wait:坏话'));
  h.finish();
  await settle();
  check('通道回到空闲', h.lane.busy() === false);
  check('上报了恰好一次错', h.errors.length === 1, h.errors.join(' / '));
}
{
  const h = makeLane({ waitThrows: ['会炸'] });
  h.lane.enqueue('会炸');
  h.lane.enqueue('接着说');
  await settle();
  h.finish();
  await settle();

  check('播放器的异常被上报了', h.errors.some((e) => e.includes('播放器炸了')));
  check('★ 结束信号出错之后，下一句照样播', h.events.includes('started:接着说'));
  h.finish();
  await settle();
  check('通道回到空闲', h.lane.busy() === false);
}
{
  // onError 自己抛：通道必须吞掉，否则一句坏话会把 pump 变成「未处理的拒绝」。
  const boom = createSpeechLane({
    speak: async () => {
      throw new Error('炸');
    },
    waitUntilDone: async () => {},
    stop: () => {},
    onError: () => {
      throw new Error('上报也炸');
    },
  });
  boom.enqueue('随便');
  await settle();
  check('onError 自己抛异常不会让通道崩掉', boom.busy() === false);
}

/* ───────────────────────── [7] 空文本 ───────────────────────── */

console.log('\n[7] 空文本与非字符串直接丢掉');
{
  const h = makeLane();
  h.lane.enqueue('');
  h.lane.enqueue('   ');
  h.lane.enqueue('\n\t');
  h.lane.enqueue(null);
  h.lane.enqueue(undefined);
  h.lane.enqueue(42);
  h.lane.enqueue({});
  await settle();

  check('七种垃圾输入一条也没排进去', h.lane.queued() === 0 && h.events.length === 0);
  check('通道仍然是空闲的', h.lane.busy() === false);
  check('也没有报错（空文本是执行层该拦的事，不是这里）', h.errors.length === 0);
}

/* ───────────────────────── [8] queued() / busy() 读数 ───────────────────────── */

console.log('\n[8] queued() / busy() 的读数（自适应轮询靠它）');
{
  const h = makeLane();
  h.lane.enqueue('一');
  h.lane.enqueue('二');
  h.lane.enqueue('三');
  await settle();
  check('说第一句时 busy 为真、queued 为 2', h.lane.busy() === true && h.lane.queued() === 2);
  h.finish();
  await settle();
  check('第二句进行中、queued 为 1', h.lane.busy() === true && h.lane.queued() === 1);
  h.finish();
  await settle();
  check('第三句进行中、queued 为 0（但仍在忙）', h.lane.busy() === true && h.lane.queued() === 0);
  h.finish();
  await settle();
  check('全部播完：busy 假、queued 0', h.lane.busy() === false && h.lane.queued() === 0);
}

/* ───────────────────────── [9] waitForPlayer ───────────────────────── */

console.log('\n[9] waitForPlayer：把「她还在说话」变成 Promise');
{
  let done = false;
  await waitForPlayer(makePlayer(false)).then(() => {
    done = true;
  });
  check('没在说话时立刻 resolve', done === true);
}
{
  const player = makePlayer(true, 1.5);
  let done = false;
  const p = waitForPlayer(player).then(() => {
    done = true;
  });
  await settle();
  check('正在说话时不 resolve', done === false);
  check('订阅了一个通知', player.listenerCount === 1);

  player.end();
  await settle();
  check('★ 播放结束（onended）时 resolve', done === true);
  check('resolve 之后退订了（不留监听器泄漏）', player.listenerCount === 0);
  await p;
}
{
  // stop() 走的是同一条路：`state.speaking` 翻回 false 并 notify。
  const player = makePlayer(true, 3);
  let done = false;
  void waitForPlayer(player).then(() => {
    done = true;
  });
  await settle();
  check('说话期间还在等', done === false);
  player.end();
  await settle();
  check('★ 被打断（stop 让 speaking 翻回 false）时也 resolve —— 不然叫停之后通道会一直等下去', done === true);
}
{
  // 看门狗：speaking 卡在 true（音频上下文被挂起、onended 丢失）。
  const player = makePlayer(true, 0);
  let done = false;
  const started = Date.now();
  void waitForPlayer(player, { graceMs: 25 }).then(() => {
    done = true;
  });
  await settle();
  check('看门狗到点之前还在等', done === false);
  await new Promise((r) => setTimeout(r, 60));
  check('★ 看门狗到点后放行（通道不会永久卡死）', done === true);
  check('等待时长确实超过了宽限', Date.now() - started >= 25);
  check('放行之后也退订了', player.listenerCount === 0);
}
{
  // 已经在说、但在订阅之前就结束了：必须靠订阅后的那次复查兜住。
  const player = makePlayer(true, 1);
  let done = false;
  const p = waitForPlayer(player);
  player.end(); // 订阅发生之前就结束了
  await p.then(() => {
    done = true;
  });
  check('订阅之前就结束也照样 resolve（不会永远等第二次通知）', done === true);
}
{
  let threw = false;
  try {
    await waitForPlayer(null);
    await waitForPlayer(undefined);
  } catch {
    threw = true;
  }
  check('null / undefined 播放器不抛异常', threw === false);
}
{
  // durationSeconds 是 NaN / 负数时不能算出负预算（会立刻超时放行）。
  const player = makePlayer(true, Number.NaN);
  let done = false;
  void waitForPlayer(player, { graceMs: 20 }).then(() => {
    done = true;
  });
  await settle();
  check('时长为 NaN 时不会立刻放行', done === false);
  player.end();
  await settle();
  check('时长为 NaN 时结束信号仍然管用', done === true);
}

/* ───────────────────────── [9b] ★ speakWithInterrupt（§4.1 的 interrupt） ───────────────────────── */

console.log('\n[9b] ★ speakWithInterrupt：默认打断，false 才排队');
{
  /*
   * 这一段守的是**曾经完全没有人守的那一层**。
   *
   * 当时的状态是「两端各自都对」：`lib/host/actions.js:205` 老实把 `interrupt`
   * 写进 `payload`，`lib/index.js` 的工具描述也向 LLM 承诺了「默认 true，false 会
   * 排在后面」，而渲染端从没读过它 —— 两个取值表现完全一样，且不报任何错。
   * `test-actions.mjs`（Host 侧）绿、`test-action-chain.mjs`（只断言 handled && ok）
   * 也绿。缝就在这两道门禁中间。
   *
   * 现在这段判断住在 `speech-lane.ts` 里、由这个文件直接调，于是它第一次
   * 有了断言。
   */

  // ① 调用面：有没有调 stopAll（= 要不要盖掉前面那些）
  let stops = 0;
  const spyLane = {
    enqueue(text) { spyLane.enqueued.push(text); },
    stopAll() { stops += 1; },
    queued: () => spyLane.enqueued.length,
    busy: () => false,
    enqueued: [],
  };

  speakWithInterrupt(spyLane, '甲');
  check('★ 没写 interrupt → 先 stopAll（默认是打断）', stops === 1 && spyLane.enqueued.length === 1, `stops=${stops}`);

  speakWithInterrupt(spyLane, '乙', { interrupt: true });
  check('interrupt:true → 同样打断', stops === 2 && spyLane.enqueued.length === 2);

  speakWithInterrupt(spyLane, '丙', { interrupt: false });
  check('★ interrupt:false → 不调 stopAll（这句排在后面）', stops === 2 && spyLane.enqueued.length === 3, `stops=${stops}`);

  speakWithInterrupt(spyLane, '丁', {});
  check('空 options → 按默认打断', stops === 3, `stops=${stops}`);

  // 契约是「默认 true」而不是「真值才 true」：脏值一律算打断。
  for (const dirty of [0, '', null, undefined, 'no']) {
    const before = stops;
    speakWithInterrupt(spyLane, `脏${String(dirty)}`, { interrupt: dirty });
    check(`interrupt:${JSON.stringify(dirty)} 不是明确的 false → 仍打断`, stops === before + 1, `stops=${stops}`);
  }

  // 每次都必须真的排一句进去 —— 只打断不排就是「她彻底不说话了」。
  check('每一次调用都排了一句', spyLane.enqueued.length === 9, `${spyLane.enqueued.length} 条`);

  // ② 行为面：跑真通道，看它到底说了什么。
  //    「一句在说 + 两句在排」的时候来一句默认 interrupt 的，前三句都该消失。
  {
    const h = makeLane();
    h.lane.enqueue('第一句');
    h.lane.enqueue('第二句');
    h.lane.enqueue('第三句');
    await settle();
    check('前置：第一句已经开始说了，后面两句在排', h.current === '第一句' && h.lane.queued() === 2,
      `${h.current} / ${h.lane.queued()}`);

    speakWithInterrupt(h.lane, '打断的那句');
    await settle();
    check('★ 默认打断：正在说的被掐掉，改说新的那句', h.current === '打断的那句', h.current);
    check('★ 默认打断：还没轮到的那两句也被丢掉了（§4.1 的默认值就是这个意思）',
      h.lane.queued() === 0, `${h.lane.queued()} 条`);
    check('确实调了播放器的 stop()', h.stopCount === 1, `${h.stopCount}`);

    h.finish();
    await settle();
    check('只说了这一句就安静了（没有旧句子复活）',
      h.events.filter((e) => e.startsWith('started:')).join(',') === 'started:第一句,started:打断的那句',
      h.events.join(' | '));
  }

  // ③ 反过来：interrupt:false 必须让队里那两句**活着**，新的排在它们后面。
  {
    const h = makeLane();
    h.lane.enqueue('第一句');
    h.lane.enqueue('第二句');
    await settle();

    speakWithInterrupt(h.lane, '排队的那句', { interrupt: false });
    await settle();
    check('★ interrupt:false：正在说的那句不受影响', h.current === '第一句', h.current);
    check('★ interrupt:false：整条队列都还在，新的排在最后', h.lane.queued() === 2, `${h.lane.queued()} 条`);
    check('interrupt:false 没有调过播放器的 stop()', h.stopCount === 0, `${h.stopCount}`);

    h.finish();
    await settle();
    check('第二句接着说了', h.current === '第二句', h.current);
    h.finish();
    await settle();
    check('★ 排队的那句最后说了（顺序没乱）', h.current === '排队的那句', h.current);

    h.finish();
    await settle();
    check('说完了，通道安静', h.lane.busy() === false && h.lane.queued() === 0);
  }
}

/* ───────────────────────── [9c] ★ voice / rate（§4.1 的合成参数） ───────────────────────── */

console.log('\n[9c] ★ voice / rate：跟着这一句走，不留在通道上');
{
  // ① 透传：给的那两个字段必须原样出现在 `speak()` 收到的请求里。
  {
    const h = makeLane();
    speakWithInterrupt(h.lane, '快一点说', { rate: '+30%', voice: 'zh-CN-YunxiNeural', interrupt: false });
    await settle();
    check('speak() 收到了这一句', h.requests.length === 1, `${h.requests.length}`);
    check('★ rate 原样透传', h.requests[0]?.rate === '+30%', `${h.requests[0]?.rate}`);
    check('★ voice 原样透传', h.requests[0]?.voice === 'zh-CN-YunxiNeural', `${h.requests[0]?.voice}`);
    check('文本没有被参数挤掉', h.requests[0]?.text === '快一点说', `${h.requests[0]?.text}`);
  }

  // ② 缺省：没给就是 undefined，不能变成空串（空串会进 Edge-TTS 的缓存键）。
  {
    const h = makeLane();
    speakWithInterrupt(h.lane, '用默认嗓子');
    await settle();
    check('没给 voice 就是 undefined（不是空串）', h.requests[0]?.voice === undefined, `${h.requests[0]?.voice}`);
    check('没给 rate 就是 undefined（不是空串）', h.requests[0]?.rate === undefined, `${h.requests[0]?.rate}`);
  }

  // ③ ★ 逐句隔离 —— 这是「参数存在通道上」的退化实现唯一会露馅的地方。
  {
    const h = makeLane();
    speakWithInterrupt(h.lane, '第一句慢的', { rate: '-20%', interrupt: false });
    speakWithInterrupt(h.lane, '第二句快的', { rate: '+50%', voice: 'zh-CN-YunxiNeural', interrupt: false });
    await settle();
    check('第二句已排队（第一句还在说）', h.lane.queued() === 1, `${h.lane.queued()}`);
    h.finish();
    await settle();
    check('★ 第一句用的是它自己的 rate，没被后一句覆盖',
      h.requests[0]?.rate === '-20%', `${h.requests[0]?.rate}`);
    check('★ 第一句没有沾上后一句的 voice',
      h.requests[0]?.voice === undefined, `${h.requests[0]?.voice}`);
    check('★ 第二句用的是它自己的 rate', h.requests[1]?.rate === '+50%', `${h.requests[1]?.rate}`);
    check('★ 第二句用的是它自己的 voice',
      h.requests[1]?.voice === 'zh-CN-YunxiNeural', `${h.requests[1]?.voice}`);
    h.finish();
    await settle();
  }

  // ④ 脏值：空串 / 空白 / 非字符串一律当「没写」，交给 Host 用默认值。
  {
    const h = makeLane();
    speakWithInterrupt(h.lane, '脏参数', { rate: '', voice: '   ', interrupt: false });
    await settle();
    check('空 rate 被归一成 undefined', h.requests[0]?.rate === undefined, `${h.requests[0]?.rate}`);
    check('全空白的 voice 被归一成 undefined', h.requests[0]?.voice === undefined, `${h.requests[0]?.voice}`);
  }

  // ⑤ 直接 `enqueue()` 一条对象请求也必须能走通（通道的公开接口）。
  {
    const h = makeLane();
    h.lane.enqueue({ text: '直接排的对象', rate: '+10%' });
    await settle();
    check('enqueue 接受 SpeechRequest 对象', h.requests[0]?.text === '直接排的对象', `${h.requests[0]?.text}`);
    check('对象里的 rate 也在', h.requests[0]?.rate === '+10%', `${h.requests[0]?.rate}`);
  }

  // ⑥ 字符串是「只给文本」的简写，仍然必须能走通。
  {
    const h = makeLane();
    h.lane.enqueue('就一个字符串');
    await settle();
    check('enqueue 仍然接受字符串', h.requests[0]?.text === '就一个字符串', `${h.requests[0]?.text}`);
  }
}

/* ───────────────────────── [10] 反向验证 ───────────────────────── */

console.log('\n[10] 反向验证：退化实现确实与真实现产生分歧');
{
  /*
   * 退化实现（★ 就是修复前的形状）：没有队列、把「开始播」当成「播完了」、
   * stopAll 只掐当前不清排队、从不问 isCancelled。
   *
   * 这里的教训来自 `test-actions.mjs`：反向验证如果只是「我说退化版会怎样」，
   * 那它什么都没验。所以下面每一条都**真的跑一遍退化实现**，再和真实现的
   * 输出对比 —— 两者必须给出不同的结论，这一条才算数。
   */
  function createNaiveLane(hooks) {
    const queue = [];
    let running = false;
    async function pump() {
      if (running) return;
      running = true;
      try {
        while (queue.length > 0) {
          const request = queue.shift();
          await hooks.speak(request); // 退化：不等播完，也没有 isCancelled
        }
      } finally {
        running = false;
      }
    }
    return {
      enqueue(input) {
        // 退化实现连 `SpeechRequest` 都不认，只会收字符串 —— 这正是它退化的地方之一。
        const text = typeof input === 'string' ? input : input?.text;
        if (typeof text !== 'string' || text.trim() === '') return;
        queue.push({ text });
        void pump();
      },
      stopAll() {
        hooks.stop(); // 退化：队列不清
      },
      queued: () => queue.length,
    };
  }

  // 退化 1 + 退化 5：两句同时开播 / 把「开始播」当成「播完了」。
  {
    const h = makeLane();
    const naive = createNaiveLane(h.hooks);
    naive.enqueue('第一句');
    naive.enqueue('第二句');
    await settle();
    const naiveBothStarted = h.events.includes('started:第一句') && h.events.includes('started:第二句');
    const naiveThinksDone = !h.events.includes('wait:第一句');

    h.events.length = 0;
    h.lane.enqueue('第一句');
    h.lane.enqueue('第二句');
    await settle();
    const realBothStarted = h.events.includes('started:第一句') && h.events.includes('started:第二句');

    check('★ 退化「没有队列」会让两句同时开播，真实现只开第一句', naiveBothStarted === true && realBothStarted === false);
    check('退化「把开始播当成播完了」根本不会去等结束信号，真实现会等', naiveThinksDone === true && h.events.includes('wait:第一句'));
    h.finish();
    await settle();
    h.finish();
    await settle();
  }

  // 退化 2：stopAll 只停当前、不清队列 —— 「停下」之后又冒出一句。
  {
    const h = makeLane();
    const naive = createNaiveLane(h.hooks);
    naive.enqueue('甲');
    naive.enqueue('乙');
    await settle();
    naive.stopAll();
    await settle();
    const naiveKeptPlaying = h.events.includes('speak:乙');
    const naiveWaited = h.events.includes('wait:甲');

    h.events.length = 0;
    const h2 = makeLane();
    h2.lane.enqueue('甲');
    h2.lane.enqueue('乙');
    await settle();
    h2.lane.stopAll();
    await settle();
    const realKeptPlaying = h2.events.includes('speak:乙');
    const realWaited = h2.events.includes('wait:甲');

    check('★ 退化「stopAll 不清队列」叫停后还会说下一句，真实现不会', naiveKeptPlaying === true && realKeptPlaying === false);
    check(
      '退化实现根本没有「等上一句播完」这一步（所以队列早被排空），真实现有',
      naiveWaited === false && realWaited === true,
    );
    h2.finish();
    await settle();
  }

  // 退化 3：不问 isCancelled —— 叫停时正在合成的那句话，回来之后照常出声。
  {
    const h = makeLane({ speakDelay: 20 });
    const naive = createNaiveLane(h.hooks);
    naive.enqueue('慢合成');
    await settle();
    naive.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    const naiveSpoke = h.events.includes('started:慢合成');

    h.events.length = 0;
    const h3 = makeLane({ speakDelay: 20 });
    h3.lane.enqueue('慢合成');
    await settle();
    h3.lane.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    const realSpoke = h3.events.includes('started:慢合成');

    check('★ 退化「不问 isCancelled」让叫停中的那句话出声，真实现丢弃它', naiveSpoke === true && realSpoke === false);
    check('真实现明确记下了「丢弃」这个决定', h3.events.includes('丢弃:慢合成'));
  }

  // 退化 4：waitForPlayer 不看门狗 —— speaking 卡住就永远等下去。
  {
    const naiveWaitForPlayer = (player) => {
      if (!player.state.speaking) return Promise.resolve();
      return new Promise((resolve) => {
        player.subscribe(() => {
          if (!player.state.speaking) resolve();
        });
      });
    };
    const stuck = makePlayer(true, 0);
    let naiveDone = false;
    let realDone = false;
    void naiveWaitForPlayer(stuck).then(() => {
      naiveDone = true;
    });
    void waitForPlayer(stuck, { graceMs: 15 }).then(() => {
      realDone = true;
    });
    await new Promise((r) => setTimeout(r, 45));

    check('★ 退化「没有看门狗」永远悬挂，真实现在超时后放行', naiveDone === false && realDone === true);
    stuck.end();
    await settle();
    check('退化版最终要靠真实结束信号才醒', naiveDone === true);
  }

  // 退化 5：只看一次 state、不订阅 —— 说话中也会立刻「结束」。
  {
    const naiveNoSubscribe = (player) => Promise.resolve();
    const busyPlayer = makePlayer(true, 5);
    let naiveDone = false;
    let realDone = false;
    void naiveNoSubscribe(busyPlayer).then(() => {
      naiveDone = true;
    });
    void waitForPlayer(busyPlayer, { graceMs: 1000 }).then(() => {
      realDone = true;
    });
    await settle();

    check('★ 退化「只看一次状态」在说话中误判为已结束，真实现还在等', naiveDone === true && realDone === false);
    busyPlayer.end();
    await settle();
    check('真实现要等真正的结束信号', realDone === true);
  }

  /*
   * 退化 6：把 `voice` / `rate` 存在**通道**上而不是跟着句子排队。
   *
   * 这是修复过程中真的差点写成的样子 —— 把参数挂在通道上看起来更省事
   * （`setVoice()` 一次，之后每句都用它）。
   *
   * 它什么时候露馅：**后一句没写参数的时候**。后一句没写 = 「用默认的」，
   * 而通道上还留着上一句的设置，于是它沿用了上一句的嗓子与语速 ——
   * 症状是「AI 先说了句快的，接着正常说一句，结果第二句也变快了」，日志全绿。
   *
   * （注意构造：必须让「没写参数的那句」排在「写了参数的那句」后面。两句都写
   *  参数时两种实现看不出区别 —— 第一次就是这么写的，退化版反而全绿。）
   */
  {
    let naiveVoice;
    let naiveRate;
    const naiveStickyLane = (hooks) => {
      const queue = [];
      let running = false;
      async function pump() {
        if (running) return;
        running = true;
        try {
          while (queue.length > 0) {
            const { text } = queue.shift();
            // 退化：用通道上的**当前**设置，而不是这一句入队时的那一份。
            await hooks.speak({ text, voice: naiveVoice, rate: naiveRate });
          }
        } finally {
          running = false;
        }
      }
      return {
        enqueue(input) {
          const request = typeof input === 'string' ? { text: input } : input;
          if (request.voice !== undefined) naiveVoice = request.voice;
          if (request.rate !== undefined) naiveRate = request.rate;
          queue.push({ text: request.text });
          void pump();
        },
      };
    };

    const hN = makeLane();
    const sticky = naiveStickyLane(hN.hooks);
    sticky.enqueue({ text: '第一句快的', rate: '+50%' });
    sticky.enqueue({ text: '第二句没写参数' });
    await settle();
    hN.finish();
    await settle();
    const naiveSecondRate = hN.requests[1]?.rate;

    const hR = makeLane();
    hR.lane.enqueue({ text: '第一句快的', rate: '+50%' });
    hR.lane.enqueue({ text: '第二句没写参数' });
    await settle();
    hR.finish();
    await settle();
    const realSecondRate = hR.requests[1]?.rate;

    check('★ 退化「参数存在通道上」让没写参数的第二句沿用上一句的 rate，真实现交给 Host 用默认值',
      naiveSecondRate === '+50%' && realSecondRate === undefined,
      `退化 ${naiveSecondRate} / 真 ${realSecondRate}`);
    check('两种实现在「写了参数的那一句」上是一致的（分歧只在继承上）',
      hN.requests[0]?.rate === '+50%' && hR.requests[0]?.rate === '+50%');
    hN.finish();
    hR.finish();
    await settle();
  }
}

/* ───────────────────────── 收尾 ───────────────────────── */

console.log('');
if (failed === 0) {
  console.log(`[11] SPEECH LANE GATE PASSED —— ${passed} 项断言全绿`);
  process.exit(0);
}
console.error(`[11] SPEECH LANE GATE FAILED —— ${passed} 项通过，${failed} 项失败`);
process.exit(1);
