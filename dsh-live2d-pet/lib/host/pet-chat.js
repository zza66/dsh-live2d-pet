/**
 * 「和桌宠对话」的账本（§13.36）。
 *
 * ── 这个模块负责什么 ──────────────────────────────────────────────────
 *
 * 一句话：**谁说了什么**，以及「她那句话还没说」这件事。它不联网、不知道
 * DSH 的会话服务长什么样，也不碰 TTS —— 那些都在 `lib/index.js` 里。
 *
 * 分开的理由与微动作那一层相同：这一半是纯逻辑（能被门禁按毫秒推演），
 * 另一半是「把话送进会话」（只能在真机上验）。混在一起会得到一个
 * 「测试里全绿、真机上静默」的模块 —— 这个插件已经吃过两次那种亏
 * （§9.2 的 `capabilities is not defined`、§13.30 的 `rendererOnline` 作用域）。
 *
 * ── 为什么对话要绕一圈回到 Agent ──────────────────────────────────────
 *
 * 面板上说的那句话**不是**让她复读，而是要一个回答。回答由谁想？由我（模型）。
 * 所以这句话必须真的进入 DSH 的会话（`sessionController.prompt`），变成一次
 * 我能看见的提问；而我回答的方式只有一个 —— `live2d_speak`。她自己没有
 * 「说话」的入口，那是设计使然：声音、口型、字幕都挂在那个工具上。
 *
 * 这条链意味着**等待是常态**：用户按下发送之后，面板要先显示「她正在想…」，
 * 等下一轮真的调了 `live2d_speak` 才把那一句落进账本。这段等待有一个上限
 * （`PET_CHAT_WAIT_MS`），超过之后账本就认定「这一轮她没说话」，不能让
 * 「她正在想…」永久挂在那里 —— 那会让用户以为插件卡死了。
 */

/** 账本格式版本。形状变了就换数字，旧文件按「读不懂 = 空账」处理。 */
export const PET_CHAT_VERSION = 1;

/** 最多留多少条。对话是「最近发生了什么」，不是档案。 */
export const PET_CHAT_MAX_MESSAGES = 200;

/** 单条最长多少字。与 `MAX_TEXT_CHARS`（speak 的上限）取齐，避免「存得下、念不出」。 */
export const PET_CHAT_MAX_TEXT = 2000;

/** 注入会话时加的前缀。它是提示词那一侧的**唯一**判据（见 `chatReplyPrompt`）。 */
export const PET_CHAT_PROMPT_PREFIX = '[桌宠对话]';

/**
 * 等一句回答最多等多久。
 *
 * 10 分钟：比一次真实回合长得多（这个会话里一次回合几分钟是常事），
 * 又短到「用户离开再回来」时不会看到一条永远转圈的面板。
 */
export const PET_CHAT_WAIT_MS = 10 * 60 * 1000;

/** 角色只两种。写成常量是为了让「她说的」在账本里只有一个字符串。 */
export const PET_CHAT_ROLES = ['user', 'pet'];

/**
 * 提示词里能点的九个表情名。
 *
 * 和 `lib/host/emotions.js` 的 `EMOTION_TABLE` 是同一份名单，但这里**故意不 import** ——
 * 这个模块零依赖（门禁直接 `node lib/host/pet-chat.js` 也能跑）。名单漂了由
 * `tools/test-pet-chat.mjs` 的对账断言抓：它两边都 import 再比。
 */
export const PET_CHAT_EMOTE_NAMES = ['平静', '开心', '好奇', '思考', '认真', '惊讶', '抱歉', '难过', '得意'];

/** 空账。`seq` 从 0 开始，第一条消息是 1。 */
export function createChatState() {
  return {
    version: PET_CHAT_VERSION,
    seq: 0,
    items: [],
    /** 正在等回答的那一问（`waitingSeq` 是用户那条消息的 seq，0 = 没在等）。 */
    waitingSince: 0,
    waitingSeq: 0,
    waitingText: '',
  };
}

/**
 * 把用户输入归一化。
 *
 * 折叠空白是**必须**的：这段文本会被拼进提示词，而一个满屏换行的输入会让
 * 那次注入看起来像一段新指令。截断也在这里做 —— 2000 字是 speak 的上限，
 * 更长的输入既念不完，也会把会话里的那一轮撑得很奇怪。
 */
export function normalizeChatText(value) {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > PET_CHAT_MAX_TEXT ? collapsed.slice(0, PET_CHAT_MAX_TEXT) : collapsed;
}

/** 一条消息的归一化。形状不对返回 null（账本里不留半条）。 */
function normalizeChatItem(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const role = typeof raw.role === 'string' && PET_CHAT_ROLES.includes(raw.role) ? raw.role : '';
  if (role === '') return null;
  const text = normalizeChatText(raw.text);
  if (text === '') return null;
  const at = Number(raw.at);
  const seq = Number(raw.seq);
  return {
    seq: Number.isFinite(seq) && seq > 0 ? Math.trunc(seq) : 0,
    role,
    text,
    at: Number.isFinite(at) && at > 0 ? Math.trunc(at) : 0,
    source: typeof raw.source === 'string' ? raw.source.slice(0, 32) : '',
  };
}

/**
 * 读盘/读网络之后的第一道净化。
 *
 * 不抛：坏文件等于空账（和微动作包一样的取舍 —— 一份坏账本不该让面板整块报错）。
 * `seq` 取「文件里写的」与「消息里最大的」两者较大值，这样即使文件被手改过、
 * 序号倒退，新消息也不会撞号。
 */
export function normalizeChatState(raw) {
  const state = createChatState();
  if (raw === null || typeof raw !== 'object') return state;
  const items = [];
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    const item = normalizeChatItem(entry);
    if (item !== null) items.push(item);
  }
  items.sort((left, right) => (left.at - right.at) || (left.seq - right.seq));
  const kept = items.slice(Math.max(0, items.length - PET_CHAT_MAX_MESSAGES));
  let seq = Number(raw.seq);
  if (!Number.isFinite(seq) || seq < 0) seq = 0;
  for (const item of kept) {
    if (item.seq > seq) seq = item.seq;
    if (item.seq === 0) item.seq = ++seq;
  }
  state.seq = seq;
  state.items = kept.map((item) => ({ ...item }));

  const waitingSince = Number(raw.waitingSince);
  const waitingText = normalizeChatText(raw.waitingText);
  if (Number.isFinite(waitingSince) && waitingSince > 0 && waitingText !== '') {
    state.waitingSince = Math.trunc(waitingSince);
    state.waitingText = waitingText;
    const waitingSeq = Number(raw.waitingSeq);
    state.waitingSeq = Number.isFinite(waitingSeq) && waitingSeq > 0 ? Math.trunc(waitingSeq) : 0;
  }
  return state;
}

/**
 * 追加一条消息，返回**新的**账本与那一条（调用方通常只关心 `item.seq`）。
 *
 * 为什么不可变：`state.chat` 会被 `/status` 与面板同时读，原地改会让
 * 「这一条是什么时候进来的」在代码里变得看不出来；微动作那次也是同一个理由。
 */
export function appendChat(chat, entry) {
  const base = chat !== null && typeof chat === 'object' ? chat : createChatState();
  const item = normalizeChatItem({
    seq: 0,
    role: entry?.role,
    text: entry?.text,
    at: entry?.at,
    source: entry?.source,
  });
  if (item === null) return { chat: base, item: null };

  const seq = (Number(base.seq) || 0) + 1;
  item.seq = seq;
  if (item.at === 0) item.at = Date.now();

  const items = [...base.items, item];
  const next = {
    ...base,
    seq,
    items: items.slice(Math.max(0, items.length - PET_CHAT_MAX_MESSAGES)),
  };
  return { chat: next, item };
}

/** 最近若干条（面板一次画不了太多）。 */
export function recentChat(chat, limit = 40) {
  const items = Array.isArray(chat?.items) ? chat.items : [];
  const count = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : 40;
  return items.slice(Math.max(0, items.length - count)).map((item) => ({ ...item }));
}

/**
 * 记下「正在等她回答这一问」。
 *
 * `text` 进账本是为了让提示词那一节能写出「用户刚刚说：…」—— 提示词里只说
 * 「用户在跟你说话」而不说内容，模型就得回去翻上一条消息；那句前缀本来
 * 就是给模型看的，把内容也带上更直接。
 */
export function beginChatWait(chat, { seq, text, now }) {
  const base = chat !== null && typeof chat === 'object' ? chat : createChatState();
  const at = Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : Date.now();
  return {
    ...base,
    waitingSince: at,
    waitingSeq: Number.isFinite(Number(seq)) ? Math.trunc(Number(seq)) : 0,
    waitingText: normalizeChatText(text),
  };
}

/** 她说了（或者这一轮已经过去），不再等。 */
export function settleChatWait(chat) {
  const base = chat !== null && typeof chat === 'object' ? chat : createChatState();
  if (base.waitingSince === 0 && base.waitingText === '') return base;
  return { ...base, waitingSince: 0, waitingSeq: 0, waitingText: '' };
}

/**
 * 现在还在等吗？
 *
 * 过期判断放在这里而不是定时器里：这个插件没有「每轮都跑」的主循环，
 * 一个 setTimeout 只会在重启后丢、在没有面板时白跑。按读的时候算，
 * 状态就永远只有一份（`Date.now()` 是唯一的时钟）。
 */
export function chatWaiting(chat, now = Date.now()) {
  const since = Number(chat?.waitingSince);
  if (!Number.isFinite(since) || since <= 0) return false;
  return now - since <= PET_CHAT_WAIT_MS;
}

/** 拼给会话的那一句。前缀是提示词那一侧认人的唯一凭据。 */
export function buildChatPrompt(text) {
  const line = normalizeChatText(text);
  if (line === '') return '';
  return `${PET_CHAT_PROMPT_PREFIX} ${line}`;
}

/**
 * 提示词里那一节（每步重新装配，所以它会随「在等/不在等」出现与消失）。
 *
 * 为什么要写成函数：`systemPrompt.context({ text })` 在每步都会调用它，
 * 不在等的时候返回空串 —— 空的 context 会被装配器整条丢掉，于是这条规则
 * 只在她真的该说话的那一轮存在。这和朗读状态那条一样（§9.13）。
 */
export function chatReplyPrompt(chat, now = Date.now(), stage = {}) {
  if (!chatWaiting(chat, now)) return '';
  const said = normalizeChatText(chat?.waitingText);
  const quoted = said === '' ? '（那句话没能带过来）' : `「${said}」`;
  const lines = [
    `用户刚在桌宠面板上跟她说话：${quoted}。`,
    '',
    '这一轮的回答**从她嘴里说出来**：用 `live2d_speak` 说 1–2 句、口语、像坐在桌边说出来的，'
      + '不要 markdown、不要分条、不要解释你在做什么，也不要提「工具」「面板」这些词。',
    '面板上显示的就是你说出来的话：正文回复没人看得到，所以别写正文。',
  ];

  /*
   * 「让他做个动作」这一类要求（§13.36.8）。清单由调用方给 —— 因为动作组与微动作
   * 是**这个模型专属**的，这里凭空写不出来；给不出清单时整段省略，回到纯说话。
   */
  const microMotions = typeof stage?.microMotions === 'string' ? stage.microMotions : '';
  const motionGroups = typeof stage?.motionGroups === 'string' ? stage.motionGroups : '';
  if (microMotions !== '' || motionGroups !== '') {
    lines.push('');
    lines.push('如果她让你做个动作、表情，或者「演一下」：**先演，再说话**，一轮里最多演一次。');
    lines.push(`- 表情：\`live2d_emote\`，名字可选 ${PET_CHAT_EMOTE_NAMES.join(' / ')}；`);
    if (microMotions !== '') {
      lines.push(`- 微动作（最像「小动作」的那种）：\`live2d_micro_motion\`，这个模型能演 ${microMotions}；`);
    }
    if (motionGroups !== '') {
      lines.push(`- 整段动作：\`live2d_motion\`，这个模型的动作组是 ${motionGroups}；`);
    }
    lines.push('演完还是要用 `live2d_speak` 说一句 —— 动作是回答她的要求，话不能省。');
  }

  return lines.join('\n');
}

/** `/status` 与 `live2d_status` 读的一句话。 */
export function describeChat(chat, now = Date.now()) {
  const count = Array.isArray(chat?.items) ? chat.items.length : 0;
  if (chatWaiting(chat, now)) {
    return `对话：${count} 条，正在等她回答`;
  }
  return `对话：${count} 条`;
}
