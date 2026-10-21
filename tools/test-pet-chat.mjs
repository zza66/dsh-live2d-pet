#!/usr/bin/env node
/**
 * 门禁：**面板上的「和桌宠对话」**（§13.36）。
 *
 * ## 为什么需要这个文件
 *
 * 这条链有四个环节，其中三个失败了都不会报错：
 *
 *   1. 面板把她那句话 POST 给 Host（这一步会报错，HTTP 状态码在）；
 *   2. Host 把话**送进会话**（拿不到 `sessionController` 时只是回一个码，
 *      面板若把它当成功，用户看到的是「她没理我」）；
 *   3. 我那一轮**只调用 `live2d_speak`** 回答（这一条完全靠提示词，写错了
 *      我会回一段正文，面板上什么都不出现，也没有任何日志）；
 *   4. 她那句话**落进账本**（挂在指令入队时；写错位置就会「她明明说了，
 *      面板没记」，或者「她没说完，面板已经记了」）。
 *
 * 第 3、4 条都是「看起来正常工作」的失败，所以必须由源码对账来钉住它们。
 *
 * ## 用法
 *
 *     node tools/test-pet-chat.mjs     （离线：纯函数真跑 + 源码对账）
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendChat,
  beginChatWait,
  buildChatPrompt,
  chatReplyPrompt,
  chatWaiting,
  createChatState,
  describeChat,
  normalizeChatState,
  normalizeChatText,
  PET_CHAT_EMOTE_NAMES,
  PET_CHAT_MAX_MESSAGES,
  PET_CHAT_MAX_TEXT,
  PET_CHAT_WAIT_MS,
  recentChat,
  settleChatWait,
} from '../dsh-live2d-pet/lib/host/pet-chat.js';
import { emotionNames } from '../dsh-live2d-pet/lib/host/emotions.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', 'dsh-live2d-pet');

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

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const hostPath = resolve(packageRoot, 'lib/index.js');
const clientPath = resolve(packageRoot, 'src/client/plugin.ts');
const host = stripComments(readFileSync(hostPath, 'utf8'));
const client = stripComments(readFileSync(clientPath, 'utf8'));

/* ── [1] 账本纯逻辑 ─────────────────────────────────────────────────── */

section('[1] 账本：说过什么、谁还没说');

const empty = createChatState();
check('空账的形状', empty.version === 1 && empty.seq === 0
  && Array.isArray(empty.items) && empty.items.length === 0
  && empty.waitingSince === 0 && empty.waitingText === '');

check('把空白折叠成一句', normalizeChatText('  你\n在  干嘛  ') === '你 在 干嘛');
check('非字符串当空', normalizeChatText(null) === '' && normalizeChatText(42) === '');
check('超长截断', normalizeChatText('字'.repeat(PET_CHAT_MAX_TEXT + 50)).length === PET_CHAT_MAX_TEXT);

const first = appendChat(empty, { role: 'user', text: '你好', at: 1000, source: 'panel' });
check('追加后原账不变（不可变）', empty.items.length === 0);
check('追加给出递增 seq', first.item.seq === 1 && first.chat.seq === 1);
check('追加保留角色与文字', first.item.role === 'user' && first.item.text === '你好');

const second = appendChat(first.chat, { role: 'pet', text: '嗯', at: 2000, source: 'speak' });
check('第二条 seq 接着涨', second.item.seq === 2);
check('最近 N 条取的是尾部', recentChat(second.chat, 1).length === 1
  && recentChat(second.chat, 1)[0].text === '嗯');

check('注入前缀', buildChatPrompt('在吗') === '[桌宠对话] 在吗');

check('没在等时提示词是空串（不占 token）', chatReplyPrompt(second.chat, 5000) === '');

const waiting = beginChatWait(second.chat, { seq: 2, text: '在吗', now: 5000 });
check('开始等待记下时间与那句话', waiting.waitingSince === 5000
  && waiting.waitingSeq === 2 && waiting.waitingText === '在吗');
check('等的时候 chatWaiting 为真', chatWaiting(waiting, 5000) === true);
check('等超时会自己结束（不靠定时器）', chatWaiting(waiting, 5000 + PET_CHAT_WAIT_MS + 1) === false);

const reply = chatReplyPrompt(waiting, 5000);
check('等待时给出「从嘴里说出来」的指令', reply.includes('live2d_speak') && reply.includes('在吗'));
check('指令里点明正文没人看得到', reply.includes('没人看得到'));
check('没给动作清单时一个字都不提动作', !reply.includes('live2d_micro_motion') && !reply.includes('live2d_motion'));

const stageReply = chatReplyPrompt(waiting, 5000, {
  microMotions: '歪头（head-tilt）、点头（nod）',
  motionGroups: 'hiyori_m×10',
});
check('给了清单就允许「先演再说话」', stageReply.includes('先演，再说话'));
check('微动作清单原样写进提示词', stageReply.includes('歪头（head-tilt）'));
check('动作组清单原样写进提示词', stageReply.includes('hiyori_m×10'));
check('三种表演工具都点到', stageReply.includes('live2d_emote')
  && stageReply.includes('live2d_micro_motion') && stageReply.includes('live2d_motion'));
check('演完仍要说话（动作不是回答）', stageReply.includes('话不能省'));
check('只给动作组也能用（微动作那行省略）', (() => {
  const only = chatReplyPrompt(waiting, 5000, { motionGroups: 'hiyori_m×10' });
  return only.includes('live2d_motion') && !only.includes('live2d_micro_motion');
})());
check('九个表情名与 emotions.js 的名单一致', (() => {
  const names = new Set(emotionNames());
  return PET_CHAT_EMOTE_NAMES.length === names.size
    && PET_CHAT_EMOTE_NAMES.every((name) => names.has(name));
})());

const settled = settleChatWait(waiting);
check('回答落账后等待清空', settled.waitingSince === 0 && settled.waitingText === '');

check('摘要说得出条数', describeChat(settled, 0).includes('条'));

const messy = normalizeChatState({
  version: 3,
  seq: 2,
  items: [
    { seq: 9, role: 'pet', text: '后', at: 3000 },
    { seq: 4, role: 'user', text: '前', at: 1000 },
    { role: 'ghost', text: '不该出现', at: 2000 },
    { role: 'user', text: '   ', at: 2500 },
  ],
});
check('坏形状不抛，按账本读', messy.version === 1);
check('按时间排序', messy.items.length === 2 && messy.items[0].text === '前');
check('seq 取文件值与最大 seq 的较大者', messy.seq >= 9);
check('空行被丢掉', messy.items.every((item) => item.text.trim() !== ''));
check('坏输入当空账', normalizeChatState(null).items.length === 0);

const many = normalizeChatState({
  items: Array.from({ length: PET_CHAT_MAX_MESSAGES + 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'pet', text: `第 ${i} 句`, at: i,
  })),
});
check('超过上限只留最近 200 条', many.items.length === PET_CHAT_MAX_MESSAGES);
check('留下的是尾部', many.items[many.items.length - 1].text
  === `第 ${PET_CHAT_MAX_MESSAGES + 19} 句`);

/* ── [2] Host 接线 ──────────────────────────────────────────────────── */

section('[2] Host：路由、注入、落账');

check('引入了纯逻辑模块', host.includes("from './host/pet-chat.js'"));
check('账本落在 settings 旁边', /const chatPath = join\(dirname\(String\(resolved\.settingsPath\)\), 'pet-chat\.json'\)/.test(host));
check('启动时把账本读回来', /^\s*loadChat\(\);/m.test(host));
check('读盘时坏文件不抛', host.includes('对话账本读不出来（按空账继续）'));
check('写盘是 tmp + rename 的原子写', host.includes('`${chatPath}.tmp`') && host.includes('renameSync(`${chatPath}.tmp`, chatPath)'));
check('state 里有 chat 与 chatTransport', host.includes('chat: createChatState(),')
  && host.includes('chatTransport: {'));

check('GET /chat 存在', host.includes("if (rest === '/chat')") && host.includes('return sendJson(res, 200, chatView());'));
check('POST /chat 先校验空文本', host.includes("code: 'E_CHAT_EMPTY'"));
check('POST /chat/clear 存在', host.includes("if (rest === '/chat/clear')"));

check('发送是「先落账，再注入」', /appendChat\(state\.chat,[\s\S]{0,400}?injectChatPrompt\(text\)/.test(host));
check('注入成功才进入等待', /if \(injected\.ok === true\) \{\s*state\.chat = beginChatWait/.test(host));
check('注入失败也记进 transport', host.includes('failed: (Number(state.chatTransport?.failed) || 0) + (injected.ok === true ? 0 : 1)'));
check('从 sessionController 取服务', host.includes("ctx.get('sessionController')"));
check('列会话挑「能跑、不空白」的', host.includes('item.agentAvailable !== false && item.blank !== true'));
check('正在跑的优先', host.includes("usable.find((item) => item.running === true) ?? usable[0]"));
check('用 queue 不打断正在跑的那一轮', host.includes("mode: 'queue'") && !host.includes("mode: 'steer'"));
check('注入正文带前缀', host.includes('content: [{ type: \'text\', text: buildChatPrompt(text) }]'));
check('注入失败有明确的码', host.includes("'E_CHAT_NO_SESSION_SERVICE'")
  && host.includes("'E_CHAT_SESSION_LIST_FAILED'")
  && host.includes("'E_CHAT_NO_SESSION'")
  && host.includes("'E_CHAT_PROMPT_FAILED'"));

check('她那句话在指令入队时落账', host.includes('noteChatSpoken(command.payload.text)'));
check('落账前确认这一条没被剪掉', /pendingCommands\.includes\(item\)/.test(host));
check('只记 say，不记别的指令', /command\.kind === 'say'[\s\S]{0,200}?pendingCommands\.includes\(item\)/.test(host));

check('提示词注册进运行时上下文', host.includes("name: 'live2d-pet-chat'"));
check('提示词排在朗读状态之后', host.includes('order: SPEECH_CONTEXT_ORDER + 1'));
check('提示词是每步现调的（等待结束就消失）', host.includes("text: () => (chatWaiting(state.chat, Date.now())")
  && host.includes('? chatReplyPrompt(state.chat, Date.now(), chatStageHints())'));
check('动作清单已接进提示词（§13.36.8）', /function chatStageHints\(\)[\s\S]{0,900}?caps\.motionGroups/.test(host)
  && /function chatStageHints\(\)[\s\S]{0,1800}?ensureMicroMotions\(state\.activeModelId/.test(host));
check('清单只取启用的微动作', host.includes("gesture.enabled !== false"));

/* ── [3] 渲染端 ─────────────────────────────────────────────────────── */

section('[3] 渲染端：一节对话，两档轮询');

check('视图形状有 items/waiting/transport', client.includes('interface PetChatView')
  && client.includes('interface PetChatTransport'));
check('GET 取账本', client.includes('async function fetchChat()') && client.includes('`${ROUTE_PREFIX}/chat`'));
check('POST 发送', client.includes('async function sendChat(text: string)'));
check('清空有独立接口', client.includes('async function clearChat()') && client.includes('`${ROUTE_PREFIX}/chat/clear`'));
check('把「没送到」与「送不到」分开说', client.includes('这句没送到她那边：'));
check('等待时 1.5 秒看一眼', client.includes('view?.waiting === true ? 1500 : 6000'));
check('自己带 AudioContext 手势解挂', client.includes('void getSpeechPlayer().warmUp();'));
check('只画最近 8 条（卡片只有 268px）', client.includes('.slice(-8)'));
check('卡片用对话节替换了「说一句」', client.includes('h(PetChatSection, {})') && !client.includes("placeholder: '让桌宠说一句…'"));
check('对话样式在（限高可滚）', client.includes('.dsh-l2d-chatlist') && client.includes('max-height: 132px'));
check('没有说话入口的旧状态残留', !client.includes('const onSay = useCallback'));

/* ── [4] 反证 ───────────────────────────────────────────────────────── */

section('[4] 反证：把关键的那一行弄坏，判据必须变假');

const brokenHook = host.replace('noteChatSpoken(command.payload.text);', '');
check('反证 1：去掉入队落账 → 「落账」判据为假',
  !brokenHook.includes('noteChatSpoken(command.payload.text)') && host.includes('noteChatSpoken(command.payload.text)'));

const brokenMode = host.replace("mode: 'queue'", "mode: 'steer'");
check('反证 2：把 queue 改成 steer → 「不打断」判据为假',
  !(brokenMode.includes("mode: 'queue'") && !brokenMode.includes("mode: 'steer'")));

const brokenCard = client.replace('h(PetChatSection, {})', '');
check('反证 3：把对话节从卡片撤掉 → 「卡片有对话」判据为假',
  !brokenCard.includes('h(PetChatSection, {})'));

const brokenPrefix = host.replace('buildChatPrompt(text)', 'text');
check('反证 4：去掉注入前缀 → 判据为假', !brokenPrefix.includes('buildChatPrompt(text)'));

const brokenPoll = client.replace('view?.waiting === true ? 1500 : 6000', '2000');
check('反证 5：把两档轮询改成固定 2 秒 → 判据为假', !brokenPoll.includes('? 1500 : 6000'));

/* ── 汇总 ───────────────────────────────────────────────────────────── */

console.log('');
if (failed > 0) {
  console.error(`✘ PET CHAT GATE FAILED  ${passed} 通过 / ${failed} 失败`);
  process.exit(1);
}
console.log(`[4] PET CHAT GATE PASSED  ${passed} 通过 / 0 失败`);
