/*
 * 她的**状态** —— 与「情绪」不是一回事，这正是这个文件存在的理由。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 两个问题，别混在一起
 * ─────────────────────────────────────────────────────────────────────────
 * - 情绪（`emotions.js`）回答「**此刻脸上叠着什么**」：一层参数增量，一两秒
 *   淡入、几秒后化掉。它由**话的内容**驱动（C 期：按句判定关键词），或者由
 *   AI 显式点名（B 期：`live2d_emote`）。
 * - 状态（本文件）回答「**她现在在干什么**」：在想 → 我在说 → 说完了。它是
 *   **回合级**的，由 DSH 的 `agent/assistant-stream` 开头/结尾驱动，和文案里
 *   有没有情绪词无关。
 *
 * 为什么这件事必须有：C 期做完之后，她的脸只在我「说到开心的事」时才动。
 * 我埋头算一道题、连调十次工具、三十秒不出一句带情绪词的话 —— 屏幕上那个人
 * 是完全静止的，和掉线没有区别。真实的人不是这样：**大脑在转的时候脸上就有
 * 东西**，那就是「思考态」。它不需要我说话，因为「我正在处理你这句」这件事
 * 本身就是信息。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 「说完回正」收的是哪一层、在什么时候收
 * ─────────────────────────────────────────────────────────────────────────
 * 情绪层自己会化掉（`EMOTION_RELEASE_MS`），所以「说完了 → 脸回正」不需要状态机
 * 去推一条清空指令。这里要说的是**思考态**那一层：它是个状态，就必须有始有终 ——
 * 一个卡住的思考态就是一张永远皱着的脸。
 *
 * 时机是量出来的，而且改过一次：`start` / `end` 帧是**按步**来的（一步 = 我一次
 * 输出，加上它带的那些工具调用），一个回合里可以有几十步。原来是在**每一步**结束
 * 时推一条「平静」，于是每几秒就把她脸上所有东西抹一遍 —— 我点名让她保持 30 秒的
 * 「开心」、或者一句自动情绪（保持 5 秒），都活不过下一步；屏幕上就是「刚笑半秒
 * 就没了」，日志里一个字都没有。现在收在**状态真的回到 idle** 的那一刻
 * （`advanceMood`：说完 8 秒、脸上确实不会再有人来收的时候），而且只按名字收思考态
 * 那一层（`release`），不是一把全清。
 *
 * 为什么不去接 D-2 的反向通道「这一句念完了」：那会让表情**提前**结束 —— 一句 8 秒
 * 的话念完时，脸上那条情绪本来还有 2 秒要化，中途剪掉反而更假。反向通道只做观测
 * （`/status` 的 `speech` 字段），不动脸。
 *
 * 本文件**零 import**（照 `emotions.js` 的规矩）：Host 半区直接用，门禁也能
 * 直接 import。纯数据 + 纯函数，不读时钟（`now` 由调用方给）。
 */

/** 回合没有在进行，脸上的东西正在自己化掉。 */
export const MOOD_IDLE = 'idle';
/** 回合进行中，还没说出带情绪的话 —— 脸上是思考态。 */
export const MOOD_THINKING = 'thinking';
/** 这个回合里已经推出过真实情绪，脸归那条情绪管。 */
export const MOOD_REACTING = 'reacting';
/** 回合结束了，脸上还剩一点东西在化。 */
export const MOOD_SETTLING = 'settling';

export const MOOD_STATES = [MOOD_IDLE, MOOD_THINKING, MOOD_REACTING, MOOD_SETTLING];

/**
 * 思考态的参数：**强度 0.5**，是刻意压低的。
 *
 * 0.5 的意思不是「思考只有一半」，而是「思考不该抢戏」：它是底噪，是她在听、
 * 在处理。真实情绪（0.85 / 1.0）必须一眼能盖过它 —— 如果思考态和我们主动说的
 * 「开心」看起来一样重，那就没有主次了。
 */
export const THINKING_INTENSITY = 0.5;
/**
 * 保持 30 秒 —— 比任何真实情绪都长得多，因为它的寿命不由内容决定，而由
 * 「这个回合什么时候结束」决定。30 秒是**兜底**：万一 `end` 帧因为任何原因
 * 没到（进程被杀、会话被切走），她的脸也会自己松开，而不是永远皱着。
 *
 * ★ 这个数字不是随手定的：它**正好是情绪层的上限**（`emotions.js` 的
 * `EMOTION_MAX_HOLD_MS = 30000`，`resolveEmotion()` 会把 holdMs 夹到这个值）。
 * 一开始写的是 45000，被 `tools/simulate-host-boot.mjs` 抓出来 —— 队列里那条
 * 指令的 `holdMs` 是 30000。代码里写着 45 秒、实际 30 秒，就是一个谎，而它
 * 不会报错，只会让人以后按 45 秒去推理。
 *
 * 本文件零 import（照 `emotions.js` 的规矩），所以这里不能引用那个常量；
 * 「两者必须一致」这条关系由 `tools/test-mood.mjs` 的 [3] 守着。
 */
export const THINKING_HOLD_MS = 30000;
/** 淡入比情绪慢一点：思考是渐起的，情绪是反应。 */
export const THINKING_ATTACK_MS = 420;
export const THINKING_RELEASE_MS = 650;

/**
 * 思考态用的情绪名 —— 走的是同一个 `emotion` 通道，因为「思考」本来就在
 * B 期的九个词里。这不是偷懒：多一条通道就多一套夹取、多一套跳过规则、
 * 多一处会静默失效的地方。
 */
export const THINKING_EMOTION_NAME = '思考';

/** 思考态那一条可以直接交给 `buildAction()` 的指令参数。 */
export function thinkingEmotion() {
  return {
    name: THINKING_EMOTION_NAME,
    intensity: THINKING_INTENSITY,
    holdMs: THINKING_HOLD_MS,
    attackMs: THINKING_ATTACK_MS,
    releaseMs: THINKING_RELEASE_MS,
  };
}

/** 一个空闲的状态机。 */
export function createMood() {
  return {
    state: MOOD_IDLE,
    since: 0,
    turnId: '',
    /** 这个回合里我推过思考态没有（推失败 —— 比如模型没这个角色 —— 时为 false）。 */
    thinkingPushed: false,
  };
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

/**
 * 一个回合开始了（`assistant-stream` 的 `start` 帧）。
 *
 * 返回 `{mood, emotion, detail}`：`emotion` 非空就代表「推一条思考态上去」，
 * 由调用方走正常的 `buildAction()` / `pushCommand()` 路径。
 *
 * `canThink: false` 用于那几种**不该动**的回合：开关关掉了、能力清单还没到、
 * 队列已经满了。这时不推东西，状态也**停在原地**（不写 `thinking`）—— 
 * 「在思考」与「脸上有没有思考态」是两件事，而这个状态机的职责是后者：
 * 什么都没推上去，也就没什么要收的。写 `thinking` 会让后面的 `end` 帧以为
 * 有一条思考态挂着，于是 8 秒后推一条谁也不需要的 `release` 去收一个空。
 * 记下 `turnId` 是另一回事 —— 那只是说「现在是这一轮」。
 *
 * 上一回合没收到 `end` 就又来一个 `start`（异常路径，实测里会出现：会话被
 * 切走时 `end` 帧不保证送到）时**直接接管**：不推第二条，因为第一条还在她脸上
 * 挂着，再推一次只会把同名的层续上（`setEmotionLayers` 的复用规则）——
 * 那是浪费一次队列位。
 */
export function moodOnTurnStart(mood, options = {}) {
  const now = finiteOr(options?.now, 0);
  const turnId = typeof options?.turnId === 'string' ? options.turnId : '';
  const canThink = options?.canThink !== false;
  const previous = mood !== null && typeof mood === 'object' ? mood : createMood();
  const wasThinking = previous.state === MOOD_THINKING && previous.turnId !== '' && previous.thinkingPushed === true;

  const next = {
    // `canThink: false` 时**连状态都不写** `thinking`：这一轮没往她脸上推任何
    // 东西，所以既没有「正在思考」可报，也没有东西要在 `end` 时收掉
    // （写 `thinking` 会让 `end` 推一条没用的「平静」去清一个空）。
    state: canThink ? MOOD_THINKING : previous.state,
    since: now,
    turnId,
    thinkingPushed: previous.thinkingPushed === true && wasThinking,
  };

  if (!canThink) {
    return { mood: next, emotion: null, detail: '这个回合不推思考态（开关关掉了、或能力清单还没到）' };
  }
  if (wasThinking) {
    return { mood: next, emotion: null, detail: '上一个回合的思考态还挂着，不重复推' };
  }
  return { mood: next, emotion: thinkingEmotion(), detail: '' };
}

/**
 * 这个回合里推出了/收到了一个真实情绪。
 *
 * 状态从 `thinking` 翻到 `reacting`：不是「思考结束了」，而是「脸现在归这条
 * 情绪管」。思考层会自然化掉（它的保持时间比一条情绪长得多，但新情绪在交叉
 * 淡出里会盖过它的权重），不需要在这里收 —— 收掉反而会在两者之间留一个空档，
 * 那正是 D 期要消灭的「换脸」。
 */
export function moodOnEmotion(mood, options = {}) {
  const now = finiteOr(options?.now, 0);
  const current = mood !== null && typeof mood === 'object' ? mood : createMood();
  const name = typeof options?.name === 'string' ? options.name : '';
  const next = {
    state: MOOD_REACTING,
    since: now,
    turnId: current.turnId,
    thinkingPushed: current.thinkingPushed === true,
  };
  return { mood: next, detail: name === '' ? '' : `情绪「${name}」接管了这个回合的脸` };
}

/**
 * 一步走完了（`end` 帧，`committed` 与 `abandoned` 都算）。
 *
 * ★ 这里**什么都不推** —— 这是本文件改过的旧行为。以前它返回一个 `clear: true`，
 * 让调用方推一条「平静」把思考态收掉；两个理由现在都不成立：
 *
 *   1. **时机错了**：`start` / `end` 是**按步**来的，一个回合里可以有几十步。
 *      每一步结束时清一次脸，等于每几秒把她脸上所有东西抹一遍 —— 我点名让她
 *      保持 30 秒的「开心」、或一句自动情绪（保持 5 秒），都活不过下一步。
 *   2. **手段太粗**：「平静」是一把全收（`clearEmotionLayers`），而要收的其实
 *      只有**思考态那一层**。按名字收（`release`）才是这句话的意思。
 *
 * 于是「收思考态」挪到了**状态真的回到 idle** 的那一刻（`advanceMood`：说完 8 秒、
 * 脸上确实不会再有人来收的时候），由它给出 `release` 名单。
 *
 * `thinkingPushed` 要**带过去**，不再在这里清零：它现在的意思是「她脸上可能还挂着
 * 一层没人收的思考态」—— 而知道这件事的时机在 8 秒之后的那一次读。
 */
export function moodOnTurnEnd(mood, options = {}) {
  const now = finiteOr(options?.now, 0);
  const current = mood !== null && typeof mood === 'object' ? mood : createMood();
  const wasThinking = current.state === MOOD_THINKING;
  const next = {
    state: MOOD_SETTLING,
    since: now,
    turnId: '',
    thinkingPushed: current.thinkingPushed === true,
  };
  return { mood: next, detail: wasThinking ? '这一步走完了（思考态等说完之后再收）' : '' };
}

/**
 * 状态变回空闲。
 *
 * 唯一的调用者是**下一个回合的开始**（`moodOnTurnStart` 会覆盖它），或者
 * D-2 的反向通道确认「她不说了」。不是定时器：一个需要有人记得去清的状态，
 * 就会有忘记清的那一天，而忘记清的思考态是一张永远皱着的脸。
 */
export function moodToIdle(mood, options = {}) {
  const current = mood !== null && typeof mood === 'object' ? mood : createMood();
  return {
    mood: {
      state: MOOD_IDLE,
      since: finiteOr(options?.now, 0),
      turnId: '',
      thinkingPushed: false,
    },
    detail: current.state === MOOD_IDLE ? '' : `从「${current.state}」回到闲着`,
  };
}

/**
 * 「说完了」这句话的有效期 —— 8 秒。**过期不是措辞问题，是状态问题。**
 *
 * `settling` 覆盖的是从 `end` 帧到**下一个回合开始**之间的那段时间。问题在于
 * 那段时间可以是 3 秒，也可以是 3 小时：你离开一晚，回来先问我一句「她怎么样了」，
 * 状态机还写着「说完了（脸上的东西正在自己化掉）」—— 她脸上早就什么都没有了。
 * 那句话描述的是**过去**，而状态机该说的是**现在**。
 *
 * 为什么不能只改措辞（让 `describeMood` 自己看时间）：`/status` 里那个
 * `mood.state` 是给机器读的，一个心里想着「闲着」、嘴上说着 `settling` 的
 * 字段，比一句过期的中文更容易骗到下一轮的代码 —— 该修的是状态本身。
 *
 * 8 秒是量出来的，不是拍的：自动情绪的保持最长 5 秒（`STREAM_HOLD_MAX_MS`）
 * 加 0.5 秒淡出（`EMOTION_RELEASE_MS`），再加一次换情绪的交叉淡出
 * （`EMOTION_SWITCH_FADE_MS = 260`）—— 也就是「她脸上最后一点东西化干净」
 * 需要的时间。更短会在她还在化的时候就宣布「闲着」，更长则又变成一句过期的话。
 *
 * 与 `emotions.js` 的关系（本文件零 import，引用不了那几个常量）：
 * `MOOD_SETTLING_MS >= STREAM_HOLD_MAX_MS + EMOTION_RELEASE_MS` 由
 * `tools/test-mood.mjs` 的 [2] 守着。
 */
export const MOOD_SETTLING_MS = 8000;

/**
 * 把**过期**从状态里挤出去 —— 状态机里唯一一条与时间有关的转移，而且只在
 * **读的时候**发生。
 *
 * 不用定时器：定时器需要一个生命周期主人，而这个进程里已经有一串 effect 在管
 * 各自的清理；再加一个「每 8 秒看一眼情绪状态」的定时器，只是多一处会忘记清的东西。
 * 读时顺手推进是同一道理的正面用法 —— `/status` 每 5 秒就有人读（她在说话时
 * 500ms），所以「没人读」不会发生；`live2d_status` 每次自己推一次，因为我读它的
 * 那一刻，正是需要它准确的那一刻。
 *
 * **只推进 `settling`**：`thinking` 与 `reacting` 的寿命由**回合**决定
 * （前者还有 30 秒兜底），替它们在这里做决定，会造出「状态说闲着、脸上还皱着」
 * 那种更坏的话。
 *
 * 返回 `{mood, changed, detail, release}`：`changed` 为假时调用方**不要**写回 ——
 * 一个小时里被读 720 次，状态就该是同一个对象。`release` 是**该按名字收掉的层**
 * （目前只有思考态那一个名字），只在这一次转移里非空；没推过思考态时它是空表 ——
 * 报一条「收掉一个不存在的东西」只会让日志多一行。
 */
export function advanceMood(mood, options = {}) {
  const now = finiteOr(options?.now, 0);
  const current = mood !== null && typeof mood === 'object' ? mood : createMood();
  if (current.state !== MOOD_SETTLING) return { mood: current, changed: false, detail: '', release: [] };
  const since = finiteOr(current.since, 0);
  if (!(now - since >= MOOD_SETTLING_MS)) return { mood: current, changed: false, detail: '', release: [] };
  /*
   * ★ 收思考态就在这里，不在每一步结束时（理由见 `moodOnTurnEnd` 的注释）：
   * 走到这一步说明话真的说完了、而且 8 秒里没有新的回合接上 —— 她的脸确实
   * 不该再皱着。收的是**名字**，不是「清空」：这 8 秒里挂上来的任何真实情绪
   * 都该继续按自己的节奏化掉。
   */
  const release = current.thinkingPushed === true ? [THINKING_EMOTION_NAME] : [];
  return {
    mood: { state: MOOD_IDLE, since: now, turnId: '', thinkingPushed: false },
    changed: true,
    detail: `说完了 ${Math.round((now - since) / 1000)} 秒，脸上的东西早就化干净了 —— 回到闲着`,
    release,
  };
}

/** 一句话说清她现在的状态 —— 诊断面与 `live2d_status` 读它。 */
export function describeMood(mood) {
  const current = mood !== null && typeof mood === 'object' ? mood : createMood();
  switch (current.state) {
    case MOOD_THINKING:
      return '思考中（回合进行中，脸上是思考态）';
    case MOOD_REACTING:
      return '情绪中（这个回合推过情绪，脸归那条情绪管）';
    case MOOD_SETTLING:
      return '说完了（脸上的东西正在自己化掉）';
    case MOOD_IDLE:
      return '闲着';
    default:
      return `未知状态「${String(current.state)}」`;
  }
}
