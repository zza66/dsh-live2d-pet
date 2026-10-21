/**
 * AI 指令校验门禁（P3 核心契约）。
 *
 * 方案 §5 给 P3 的验收标准原文是「**AI 连续 20 条指令不越界、不卡死**」。
 * 所以这个门禁的重点不是「函数返回得对不对」，而是：
 *
 *   1. 拿**真实模型**的能力清单（8 个官方样本的 model3.json 原文）去喂指令，
 *      断言「任何一条被接受的指令，引用的表达式 / 动作组 / 参数都真实存在，
 *      且参数值落在模型声明的范围内」——这就是「不越界」；
 *   2. 连续灌 20+ 条混合指令（含大量脏输入），断言每一条都有明确去留、
 *      队列长度从不超过上限、且没有异常逃出来 ——这就是「不卡死」。
 *
 * 另外还要钉住一条**本项目特有**的坑：参数名大小写不统一（Wanko 用
 * `PARAM_ANGLE_X`，Haru 用 `ParamAngleX`），而口型独占规则必须在这两种写法上
 * **同时生效** —— 写死精确匹配的话，例外只在一部分模型上静默失效。
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION_KINDS,
  DEFAULT_TTL_MS,
  EXCLUSIVE_PARAMETER_IDS,
  MAX_ACTION_PARAMETERS,
  MAX_TEXT_CHARS,
  MAX_VOICE_NAME_CHARS,
  PRIORITY,
  SPEECH_PITCH_PATTERN,
  SPEECH_RATE_PATTERN,
  TOOL_KINDS,
  VOICE_NAME_PATTERN,
  actionSummary,
  buildAction,
  clampNumber,
  isExclusiveParameter,
  normalizePriority,
  normalizeTtl,
  pruneQueue,
  readSpeechPitch,
  readSpeechRate,
  readVoiceName,
} from '../dsh-live2d-pet/lib/host/actions.js';
import { buildCapabilities } from '../dsh-live2d-pet/lib/host/capabilities.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const SAMPLES = join(ROOT, 'work', 'sdk5', 'CubismSdkForWeb-5-r.5', 'Samples', 'Resources');

let passed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push({ label, detail: String(detail) });
  return false;
}

function eq(label, actual, expected) {
  return check(label, actual === expected, `期望 ${JSON.stringify(expected)}，得到 ${JSON.stringify(actual)}`);
}

const SAMPLE_NAMES = ['Haru', 'Hiyori', 'Mao', 'Mark', 'Natori', 'Ren', 'Rice', 'Wanko'];

/**
 * 真实模型的能力清单：表情与动作组直接来自模型作者写的 model3.json，
 * 参数用一份受控的小清单（真实参数表需要 Cubism Core，那是 `test-capabilities.mjs`
 * 的职责；这里要验的是「校验逻辑对真实名字是否成立」）。
 */
const CONTROLLED_PARAMETERS = [
  { id: 'ParamAngleX', min: -30, max: 30, def: 0 },
  { id: 'ParamAngleY', min: -30, max: 30, def: 0 },
  { id: 'ParamAngleZ', min: -30, max: 30, def: 0 },
  { id: 'ParamBodyAngleX', min: -10, max: 10, def: 0 },
  // 小写驼峰（Haru 的形状）与大写（Wanko 的形状）各来一份 —— 口型独占规则
  // 必须两种都拦住。
  { id: 'ParamMouthOpenY', min: 0, max: 1, def: 0 },
  { id: 'ParamMouthForm', min: -1, max: 1, def: 0 },
  { id: 'PARAM_MOUTH_OPEN_Y', min: 0, max: 1, def: 0 },
  { id: 'PARAM_ANGLE_X', min: -30, max: 30, def: 0 },
];

function loadSampleCapabilities(name) {
  const file = join(SAMPLES, name, `${name}.model3.json`);
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  return buildCapabilities({ settings, parameters: CONTROLLED_PARAMETERS });
}

// ── [1] 形状契约 ────────────────────────────────────────────────────────────
console.log('[1] 导出契约');
check('ACTION_KINDS 是 9 种（`emotion` 是第一期、`microMotion` 是「试演」加进来的）',
  ACTION_KINDS.length === 9 && ACTION_KINDS.includes('say') && ACTION_KINDS.includes('stop')
  && ACTION_KINDS.includes('emotion') && ACTION_KINDS.includes('microMotion'),
  ACTION_KINDS.join(' / '));
eq('PRIORITY.EXPRESSIVE', PRIORITY.EXPRESSIVE, 50);
eq('PRIORITY.INTERRUPT', PRIORITY.INTERRUPT, 100);
check('三个口型参数名都在独占列表里', EXCLUSIVE_PARAMETER_IDS.length === 2);
check('isExclusiveParameter 忽略大小写（驼峰）', isExclusiveParameter('ParamMouthOpenY') === true);
check('isExclusiveParameter 忽略大小写（全大写）', isExclusiveParameter('PARAM_MOUTH_OPEN_Y') === true);
check('isExclusiveParameter 混合大小写也认', isExclusiveParameter('parammouthform') === true);
check('isExclusiveParameter 不误伤别的参数', isExclusiveParameter('ParamAngleX') === false);
check('isExclusiveParameter 非字符串安全', isExclusiveParameter(null) === false && isExclusiveParameter(7) === false);

// ── [2] 不需要能力清单的指令 ────────────────────────────────────────────────
console.log('[2] say / stop / idle 在没有能力清单时也要能用');
{
  const say = buildAction({ kind: 'say', text: '  你好呀  ' }, null);
  check('say 在 capabilities=null 时放行', say.ok === true, say.detail);
  eq('say 去掉了首尾空白', say.command.payload.text, '你好呀');
  eq('say 的 interrupt 默认 true', say.command.payload.interrupt, true);
  // 契约说的是「默认 true」，不是「真值才 true」—— 所以任何不是明确 false 的东西都算打断。
  for (const dirty of [0, '', null, undefined, 'no']) {
    eq(`say 的 interrupt 遇到脏值 ${JSON.stringify(dirty)} 仍算打断`,
      buildAction({ kind: 'say', text: 'x', interrupt: dirty }, null).command.payload.interrupt, true);
  }
  eq('say 的 interrupt 可以关掉', buildAction({ kind: 'say', text: 'x', interrupt: false }, null).command.payload.interrupt, false);

  const empty = buildAction({ kind: 'say', text: '   ' }, null);
  eq('空文本被拒', empty.code, 'E_ACTION_EMPTY_TEXT');
  const long = buildAction({ kind: 'say', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }, null);
  eq('超长文本被拒', long.code, 'E_ACTION_TEXT_TOO_LONG');

  const stop = buildAction({ kind: 'stop' }, null);
  check('stop 放行', stop.ok === true);
  eq('stop 的 payload 是空的', Object.keys(stop.command.payload).length, 0);

  const idle = buildAction({ kind: 'idle', intensity: 5 }, null);
  check('idle 放行', idle.ok === true);
  eq('idle 的 intensity 被夹到 1', idle.command.payload.intensity, 1);

  const unknown = buildAction({ kind: 'dance' }, null);
  eq('不认识的指令类型被拒', unknown.code, 'E_ACTION_UNKNOWN_KIND');
  check('被拒时 command 是 null（调用方不会拿到半成品）', unknown.command === null);
}

// ── [2b] voice / rate 的取值规则 ────────────────────────────────────────────
console.log('[2b] ★ voice / rate：格式不对就丢掉字段，但话照说');
{
  /*
   * 这一段的由来：`voice` / `rate` 原来只被检查了「是不是非空字符串」，
   * 而它们最终要插进 SSML 的 XML 属性（`edge-tts.js` 的 `buildSsml()`）。
   * 实测 `rate: "1'2"` 会让整句话 502 —— 用户听到「她没说话」，
   * 日志写着「语音服务出错了」。现在这两层都挡住了，这里钉住 Host 这一层。
   */
  check('三个正则都是 RegExp',
    SPEECH_RATE_PATTERN instanceof RegExp && SPEECH_PITCH_PATTERN instanceof RegExp
    && VOICE_NAME_PATTERN instanceof RegExp);

  // 合法值原样进指令。
  const good = buildAction({ kind: 'say', text: '你好', voice: 'zh-CN-YunxiNeural', rate: '+15%' }, null);
  check('合法的 voice / rate 放行', good.ok === true, good.detail);
  eq('voice 原样写进指令', good.command.payload.voice, 'zh-CN-YunxiNeural');
  eq('rate 原样写进指令', good.command.payload.rate, '+15%');
  eq('合法值不产生任何丢弃记录', good.droppedParameters.length, 0);

  // 没给 → 用默认值，且**不是空串**（空串会进缓存键、白占一格）。
  const bare = buildAction({ kind: 'say', text: '你好' }, null);
  eq('没给 voice 时是 undefined（不是空串）', bare.command.payload.voice, undefined);
  eq('没给 rate 时是 undefined（不是空串）', bare.command.payload.rate, undefined);
  for (const empty of ['', null, undefined]) {
    eq(`voice 是 ${JSON.stringify(empty)} 时归一成 undefined`,
      buildAction({ kind: 'say', text: '你好', voice: empty }, null).command.payload.voice, undefined);
  }

  // ★ 格式不对 → 丢掉字段、**句子仍然被接受**，并把原因记下来给 LLM。
  for (const [field, bad] of [['rate', "1'2"], ['rate', 'fast'], ['rate', '1.5'], ['voice', 'xiaoxiao'], ['voice', "zh-CN-X'.Neural"]]) {
    const r = buildAction({ kind: 'say', text: '你好', [field]: bad }, null);
    check(`★ 坏 ${field} ${JSON.stringify(bad)}：句子仍被接受`, r.ok === true, r.detail);
    eq(`坏 ${field} 不写进指令`, r.command.payload[field], undefined);
    eq(`坏 ${field} 被记为一条丢弃`, r.droppedParameters.length, 1);
    eq(`坏 ${field} 的记录带着字段名`, r.droppedParameters[0]?.id, field);
    eq(`坏 ${field} 的记录带着原因码`, r.droppedParameters[0]?.reason, 'E_ACTION_SPEECH_VALUE_DROPPED');
    check(`坏 ${field} 的说明是给人看的（含格式提示）`,
      typeof r.droppedParameters[0]?.detail === 'string' && r.droppedParameters[0].detail.length >= 10,
      String(r.droppedParameters[0]?.detail));
  }

  // 两个都坏 → 两条记录，句子还是说出来。
  const both = buildAction({ kind: 'say', text: '你好', rate: 'fast', voice: 'xiaoxiao' }, null);
  check('两个都坏时句子仍被接受', both.ok === true);
  eq('两个都坏时记两条丢弃', both.droppedParameters.length, 2);
  check('两个都坏时记录里两个字段名都在',
    both.droppedParameters.map((d) => d.id).join(',') === 'voice,rate',
    both.droppedParameters.map((d) => d.id).join(','));

  // 非字符串也是坏值（LLM 完全可能传数字）。
  const numeric = buildAction({ kind: 'say', text: '你好', rate: 15 }, null);
  check('rate 是数字时句子仍被接受但字段被丢', numeric.ok === true && numeric.command.payload.rate === undefined);
  check('数字 rate 的说明里点出了收到的类型', String(numeric.droppedParameters[0]?.detail).includes('number'));

  // 超长音色名。
  const longVoice = buildAction({ kind: 'say', text: '你好', voice: `zh-CN-${'A'.repeat(MAX_VOICE_NAME_CHARS)}Neural` }, null);
  check('超长 voice 被丢且句子仍成立',
    longVoice.ok === true && longVoice.command.payload.voice === undefined
    && String(longVoice.droppedParameters[0]?.detail).includes('上限'));

  // 三个 read* 与 buildAction 用的是同一套规则（不能各写一份）。
  eq('readSpeechRate 与指令用的是同一个正则', readSpeechRate('+15%').value, '+15%');
  eq('readVoiceName 认得标准 ShortName', readVoiceName('zh-CN-XiaoxiaoNeural').value, 'zh-CN-XiaoxiaoNeural');
  check('readSpeechPitch 拒掉裸数字', readSpeechPitch('200').ok === false);

  // 其它指令种类不该因为这次改动多出字段来。
  const motion = buildAction({ kind: 'motion', group: 'Idle' }, loadSampleCapabilities('Haru'));
  eq('motion 的丢弃记录仍是空的', motion.droppedParameters.length, 0);
}

// ── [3] capabilities=null 的语义（拒绝而不是假成功） ────────────────────────
console.log('[3] capabilities=null 时，需要清单的指令必须被拒');
for (const raw of [
  { kind: 'expression', name: 'smile' },
  { kind: 'motion', group: 'Idle' },
  { kind: 'param', params: { ParamAngleX: 10 } },
]) {
  const result = buildAction(raw, null);
  eq(`${raw.kind} 被拒且码是 E_ACTION_NO_CAPABILITIES`, result.code, 'E_ACTION_NO_CAPABILITIES');
  check(`${raw.kind} 的提示里说明了「稍后再试」`, /稍后/.test(result.detail), result.detail);
}

// ── [4] 表达式校验 ──────────────────────────────────────────────────────────
console.log('[4] 表达式校验与可自愈的错误');
const capsByName = {};
for (const name of SAMPLE_NAMES) capsByName[name] = loadSampleCapabilities(name);
{
  const haru = capsByName.Haru;
  check('Haru 至少有一个表达式（夹具不是空的）', haru.expressions.length > 0, JSON.stringify(haru.expressions));

  const good = buildAction({ kind: 'expression', name: haru.expressions[0].name }, haru);
  check('存在的表达式被接受', good.ok === true, good.detail);
  eq('表达式名原样保留', good.command.payload.expression.name, haru.expressions[0].name);
  eq('holdMs 默认 0（不自动回弹）', good.command.payload.expression.holdMs, 0);
  /*
   * ★ 反向断言：`weight` 必须**不在**指令里。
   *
   * 契约表 §4.1 写过它，但 Framework 兑现不了「按权重混合单个表情」，所以整条链上
   * 都没有这个字段。这条断言在这里的意义和别处相反：它守的不是「值对不对」，
   * 而是「这个字段没有被重新加回来」—— 一旦有人手滑补上，它会当场红，
   * 而不是等 LLM 用了一个永远不生效的参数之后才发现。详见方案 §4.2.8。
   */
  check(
    '★ weight 不在表达式指令里（契约已删掉这个兑现不了的参数）',
    !Object.prototype.hasOwnProperty.call(good.command.payload.expression, 'weight'),
    JSON.stringify(good.command.payload.expression),
  );
  check(
    '★ 就算调用方硬塞 weight，也不会被写进指令',
    !Object.prototype.hasOwnProperty.call(
      buildAction({ kind: 'expression', name: haru.expressions[0].name, weight: 0.4 }, haru).command.payload.expression,
      'weight',
    ),
  );

  const bad = buildAction({ kind: 'expression', name: '不存在的表情' }, haru);
  eq('不存在的表达式被拒', bad.code, 'E_EXPRESSION_NOT_FOUND');
  // §4.1 硬规则 2：必须把可用列表一并回给 LLM，否则它会反复猜错名字。
  check('错误里带出了真实可用的表达式名', bad.detail.includes(haru.expressions[0].name), bad.detail);
  check('结构化字段里也带出了可用列表', Array.isArray(bad.available) && bad.available.length === haru.expressions.length);

  // Mark 官方样本**没有** Expressions，那是合法模型不是坏包。
  const mark = capsByName.Mark;
  eq('Mark 确实没有表达式（夹具前提）', mark.expressions.length, 0);
  const markBad = buildAction({ kind: 'expression', name: 'smile' }, mark);
  eq('没有表达式的模型上依然报 E_EXPRESSION_NOT_FOUND', markBad.code, 'E_EXPRESSION_NOT_FOUND');
  check('且如实说「（无）」，而不是编造', markBad.detail.includes('（无）'), markBad.detail);
}

// ── [5] 动作组校验 ──────────────────────────────────────────────────────────
console.log('[5] 动作组校验');
{
  const haru = capsByName.Haru;
  check('Haru 有动作组', haru.motionGroups.length > 0, JSON.stringify(haru.motionGroups));
  const group = haru.motionGroups[0];

  const good = buildAction({ kind: 'motion', group: group.name, index: 0 }, haru);
  check('存在的动作组被接受', good.ok === true, good.detail);
  eq('fadeMs 默认 300', good.command.payload.motion.fadeMs, 300);
  eq('loop 默认 false', good.command.payload.motion.loop, false);
  eq('fadeMs 超上限被夹', buildAction({ kind: 'motion', group: group.name, fadeMs: 999999 }, haru).command.payload.motion.fadeMs, 5000);
  eq('fadeMs 负数被夹到 0', buildAction({ kind: 'motion', group: group.name, fadeMs: -50 }, haru).command.payload.motion.fadeMs, 0);

  const bad = buildAction({ kind: 'motion', group: '不存在的组' }, haru);
  eq('不存在的动作组被拒', bad.code, 'E_MOTION_GROUP_NOT_FOUND');
  check('错误里带出了可用的动作组名', bad.detail.includes(group.name), bad.detail);
  check('且带出了每个组有几个动作', /\(\d+ 个动作\)/.test(bad.detail), bad.detail);

  const oob = buildAction({ kind: 'motion', group: group.name, index: group.count + 5 }, haru);
  eq('越界的序号被拒', oob.code, 'E_MOTION_INDEX_OUT_OF_RANGE');
  check('越界提示里说清了从 0 开始', oob.detail.includes('从 0 开始'), oob.detail);
  eq('负序号被拒', buildAction({ kind: 'motion', group: group.name, index: -1 }, haru).code, 'E_MOTION_INDEX_OUT_OF_RANGE');

  // index 省略时随机挑，但必须落在 [0, count) 内。
  const seen = new Set();
  let randomOk = true;
  for (let i = 0; i < 60; i += 1) {
    const picked = buildAction({ kind: 'motion', group: group.name }, haru);
    if (!picked.ok) { randomOk = false; break; }
    const index = picked.command.payload.motion.index;
    if (!Number.isInteger(index) || index < 0 || index >= group.count) { randomOk = false; break; }
    seen.add(index);
  }
  check('index 省略时随机挑且不越界', randomOk);
  check('随机确实散开了（不是恒定同一个）', group.count === 1 || seen.size > 1, `只出现了 ${[...seen].join(',')}`);
}

// ── [6] look 的夹取 ─────────────────────────────────────────────────────────
console.log('[6] look 的范围夹取');
{
  const haru = capsByName.Haru;
  const good = buildAction({ kind: 'look', x: 0.4, y: -0.2, durationMs: 600 }, haru);
  check('look 被接受', good.ok === true);
  eq('x 原样保留', good.command.payload.look.x, 0.4);
  eq('durationMs 原样保留', good.command.payload.look.durationMs, 600);
  eq('x 超上限被夹到 1', buildAction({ kind: 'look', x: 99 }, haru).command.payload.look.x, 1);
  eq('y 超下限被夹到 -1', buildAction({ kind: 'look', y: -99 }, haru).command.payload.look.y, -1);
  eq('x 是 NaN 时落 0', buildAction({ kind: 'look', x: Number.NaN }, haru).command.payload.look.x, 0);
  eq('durationMs 超上限被夹', buildAction({ kind: 'look', durationMs: 999999 }, haru).command.payload.look.durationMs, 5000);
  eq('look 在 capabilities=null 时放行（不需要清单）', buildAction({ kind: 'look', x: 0.1 }, null).ok, true);
}

// ── [7] params 逃生通道 ─────────────────────────────────────────────────────
console.log('[7] params 逃生通道与口型独占');
{
  const haru = capsByName.Haru;

  const good = buildAction({ kind: 'param', params: { ParamAngleX: 15 } }, haru);
  check('合法参数被接受', good.ok === true, good.detail);
  eq('值原样保留', good.command.payload.params.ParamAngleX, 15);
  eq('超出声明范围被夹到上限', buildAction({ kind: 'param', params: { ParamAngleX: 999 } }, haru).command.payload.params.ParamAngleX, 30);
  eq('低于声明范围被夹到下限', buildAction({ kind: 'param', params: { ParamAngleX: -999 } }, haru).command.payload.params.ParamAngleX, -30);
  check('夹取被记录下来（不是悄悄改）', buildAction({ kind: 'param', params: { ParamAngleX: 999 } }, haru).clampedParameters.length === 1);

  // ★ 硬规则 1：口型通道独占，且**两种大小写都要拦**。
  for (const id of ['ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y', 'parammouthform']) {
    const blocked = buildAction({ kind: 'param', params: { [id]: 0.5 } }, haru);
    eq(`口型参数 ${id} 被丢弃`, blocked.code, 'E_ACTION_PARAMETER_EXCLUSIVE');
    check(`${id} 的提示说清了「会和说话打架」`, /打架/.test(blocked.detail), blocked.detail);
    eq(`${id} 一条指令里全是口型参数时整条被拒`, blocked.ok, false);
  }

  // 混合：坏的和好的一起给，好的必须留下。
  const mixed = buildAction({ kind: 'param', params: { ParamMouthOpenY: 0.5, ParamAngleX: 10 } }, haru);
  check('混合指令仍然成立', mixed.ok === true, mixed.detail);
  eq('口型参数没进去', mixed.command.payload.params.ParamMouthOpenY, undefined);
  eq('合法参数进去了', mixed.command.payload.params.ParamAngleX, 10);
  eq('丢弃被记录在案', mixed.droppedParameters.length, 1);

  const unknown = buildAction({ kind: 'param', params: { ParamNotAThing: 1 } }, haru);
  eq('不存在的参数被拒', unknown.code, 'E_ACTION_PARAMETER_NOT_FOUND');
  check('提示指引 AI 去看 capabilitiesDetail', unknown.detail.includes('capabilitiesDetail'), unknown.detail);

  const notObject = buildAction({ kind: 'param', params: 'ParamAngleX=1' }, haru);
  eq('params 不是对象时报 E_ACTION_BAD_VALUE', notObject.code, 'E_ACTION_BAD_VALUE');
  const tooMany = buildAction({ kind: 'param', params: Object.fromEntries(Array.from({ length: MAX_ACTION_PARAMETERS + 1 }, (_, i) => [`P${i}`, 1])) }, haru);
  eq('参数个数超上限被拒', tooMany.code, 'E_ACTION_BAD_VALUE');

  /*
   * 出口。这一段门禁从 P3 就在守 `param` 的**规则**，但那条通道一直「实现了
   * 却没有人能调」—— AI 侧没有任何一个工具会产生 `kind: 'param'` 的指令
   * （`live2d_emote` 走的是 `emotion`）。用户第一次让我「把眼睛闭起来」时
   * 撞上的就是这个缺口：9 个情绪词里没有「闭眼」，而参数通道没有出口。
   * `live2d_param` 补上出口，映射表与「成功也要报清写了什么」跟着一起守。
   */
  eq('`live2d_param` 映射到 `param`（出口）', TOOL_KINDS.live2d_param, 'param');
  check('成功时主句列出写进去的参数与保持时长（不然「写了 3 个」和「5 个全进去」长得一样）',
    good.detail.includes('ParamAngleX=15') && good.detail.includes('保持'), good.detail);
  check('成功时的提示说清了它是硬写而不是叠加',
    good.detail.includes('硬写'), good.detail);
}

// ── [8] 优先级与 TTL ────────────────────────────────────────────────────────
console.log('[8] 优先级与 TTL 的归一化');
eq('priority 缺省是 50', normalizePriority(undefined), PRIORITY.EXPRESSIVE);
eq('priority 80 降到 50（两个档位之间向下取：宁可慢一点，也不要打断用户正在听的话）', normalizePriority(80), PRIORITY.EXPRESSIVE);
eq('priority 100 保持 100', normalizePriority(100), PRIORITY.INTERRUPT);
eq('priority 51 降到 50', normalizePriority(51), PRIORITY.EXPRESSIVE);
eq('priority 是 NaN 时落 50', normalizePriority(Number.NaN), PRIORITY.EXPRESSIVE);
eq('ttl 缺省是 4000', normalizeTtl(undefined), DEFAULT_TTL_MS);
eq('ttl 超上限被夹', normalizeTtl(999999), 60000);
eq('ttl 是 0 时被抬到下限（0 会让指令立刻作废）', normalizeTtl(0), 100);

/*
 * 这里原本还有 5 条 `shouldInterrupt()` 的断言。那个函数已于 P3 收尾时删除
 * （见方案 §4.2.12）：Host 只知道队列、不知道渲染端此刻在播什么，判不出
 * 「该不该打断」。它从来没有被任何地方调用过，断言也是绿的 —— 一条守着一个
 * 死函数的门禁，比没有门禁更糟：它让这一格看起来「验过了」。
 */

// ── [9] 队列裁剪 ────────────────────────────────────────────────────────────
console.log('[9] 队列裁剪：TTL 先于数量上限');
{
  const now = 1_000_000;
  const make = (at, id) => ({ id, command: { kind: 'motion', priority: 50, ttlMs: 4000, at } });

  const fresh = pruneQueue([make(now - 100, 'a'), make(now - 200, 'b')], now, 8);
  eq('新鲜指令全部保留', fresh.kept.length, 2);
  eq('没有过期', fresh.expired.length, 0);

  const stale = pruneQueue([make(now - 10_000, 'old'), make(now - 100, 'new')], now, 8);
  eq('过期的那条被淘汰', stale.expired.length, 1);
  eq('没过期的留下', stale.kept.length, 1);
  eq('留下的是新的那条', stale.kept[0].id, 'new');

  const many = Array.from({ length: 12 }, (_, i) => make(now - i * 10, `q${i}`));
  const overflowed = pruneQueue(many, now, 8);
  eq('超过上限时裁到 8 条', overflowed.kept.length, 8);
  eq('丢的是最旧的 4 条', overflowed.overflow.length, 4);
  eq('丢掉的确实是最旧的那条', overflowed.overflow[0].id, 'q11');
  eq('留下的是最新的那条', overflowed.kept[0].id, 'q0');

  // ★ 顺序很重要：一条 10 秒前排队的动作不该因为「队列还有空位」被留下来执行。
  const both = pruneQueue([make(now - 10_000, 'ancient'), ...Array.from({ length: 9 }, (_, i) => make(now - i, `n${i}`))], now, 8);
  eq('过期判定先发生（不是因为溢出才被丢）', both.expired.length, 1);
  eq('过期的那条是 ancient', both.expired[0].id, 'ancient');

  eq('空队列安全', pruneQueue([], now, 8).kept.length, 0);
  eq('null 安全', pruneQueue(null, now, 8).kept.length, 0);
  const noLimit = pruneQueue(many, now, 0);
  eq('上限非法时退回默认 8', noLimit.kept.length, 8);
}

// ── [10] ★ 验收 §5：AI 连续 20+ 条指令不越界、不卡死 ────────────────────────
console.log('[10] ★ 连续 20+ 条指令：不越界、不卡死');
{
  // 一段「AI 会写出来的东西」的混合样本：有合法的、有猜错名字的、
  // 有越界的、有试图写口型参数的、有根本不是对象的。
  const script = [
    { kind: 'say', text: '欢迎回来！' },
    { kind: 'motion', group: 'Idle' },
    { kind: 'expression', name: 'F01' },
    { kind: 'look', x: 0.3, y: -0.1 },
    { kind: 'param', params: { ParamAngleZ: 15 } },
    { kind: 'say', text: '今天想聊点什么？' },
    { kind: 'expression', name: '不存在的表情' },
    { kind: 'motion', group: '不存在组' },
    { kind: 'param', params: { ParamMouthOpenY: 0.9 } },
    { kind: 'look', x: 99, y: -99 },
    { kind: 'motion', group: 'Idle', index: 999 },
    { kind: 'expression', name: 'F02', holdMs: 999999 },
    { kind: 'say', text: '' },
    { kind: 'param', params: { ParamAngleX: 9999 } },
    { kind: 'stop' },
    { kind: 'say', text: 'x'.repeat(5000) },
    { kind: 'idle' },
    { kind: 'bogus', name: 'nope' },
    { kind: 'motion' },
    { kind: 'look', durationMs: 999999 },
    { kind: 'expression', name: 'F01', holdMs: 999999 },
    { kind: 'param', params: null },
    { kind: 'say', text: '最后一句。' },
    { kind: 'motion', group: 'TapBody', index: 0, priority: 100 },
  ];

  let queue = [];
  const accepted = [];
  const rejected = [];
  let threw = null;
  let maxQueueSeen = 0;

  try {
    script.forEach((raw, i) => {
      const result = buildAction(raw, capsByName.Haru);
      if (result.ok) {
        accepted.push(result);
        queue.push({ id: i, command: result.command });
        const pruned = pruneQueue(queue, result.command.at, 8);
        queue = pruned.kept;
        maxQueueSeen = Math.max(maxQueueSeen, queue.length);
      } else {
        rejected.push(result);
        check(`第 ${i + 1} 条被拒时有错误码`, typeof result.code === 'string' && result.code.startsWith('E_'), result.code);
        check(`第 ${i + 1} 条被拒时有人话解释`, result.detail.length > 4, result.detail);
      }
    });
  } catch (error) {
    threw = error;
  }

  check('★ 24 条指令跑完没有抛异常（不卡死）', threw === null, threw?.stack ?? '');
  check('★ 至少 20 条进了流程（样本不是空跑）', accepted.length + rejected.length >= 20, `接受 ${accepted.length} / 拒绝 ${rejected.length}`);
  check('既不是全部接受、也不是全部拒绝（夹具确实两边都覆盖到）', accepted.length > 0 && rejected.length > 0, `接受 ${accepted.length} / 拒绝 ${rejected.length}`);

  // ── 「不越界」的逐条不变量 ──
  let boundsOk = true;
  let boundsWhy = '';
  for (const result of accepted) {
    const { command } = result;
    const payload = command.payload ?? {};

    if (payload.expression !== undefined) {
      if (payload.expression.name !== undefined && !capsByName.Haru.expressions.some((e) => e.name === payload.expression.name)) {
        boundsOk = false; boundsWhy = `接受了不存在的表达式 ${payload.expression.name}`; break;
      }
      // §4.2.8：`weight` 已从契约里删掉，任何一条指令都不该再带它。
      if (Object.prototype.hasOwnProperty.call(payload.expression, 'weight')) { boundsOk = false; boundsWhy = '表达式指令里又出现了 weight'; break; }
      if (payload.expression.holdMs < 0 || payload.expression.holdMs > 60000) { boundsOk = false; boundsWhy = `holdMs 越界 ${payload.expression.holdMs}`; break; }
    }

    if (payload.motion !== undefined) {
      const group = capsByName.Haru.motionGroups.find((g) => g.name === payload.motion.group);
      if (group === undefined) { boundsOk = false; boundsWhy = `接受了不存在的动作组 ${payload.motion.group}`; break; }
      if (payload.motion.index < 0 || payload.motion.index >= group.count) { boundsOk = false; boundsWhy = `动作序号越界 ${payload.motion.index}/${group.count}`; break; }
      if (payload.motion.fadeMs < 0 || payload.motion.fadeMs > 5000) { boundsOk = false; boundsWhy = `fadeMs 越界 ${payload.motion.fadeMs}`; break; }
    }

    if (payload.look !== undefined) {
      if (Math.abs(payload.look.x) > 1 || Math.abs(payload.look.y) > 1) { boundsOk = false; boundsWhy = `look 越界 ${payload.look.x},${payload.look.y}`; break; }
    }

    if (payload.params !== undefined) {
      for (const [id, value] of Object.entries(payload.params)) {
        if (isExclusiveParameter(id)) { boundsOk = false; boundsWhy = `口型参数漏进了指令：${id}`; break; }
        const declared = CONTROLLED_PARAMETERS.find((p) => p.id === id);
        if (declared === undefined) { boundsOk = false; boundsWhy = `接受了不存在的参数 ${id}`; break; }
        if (value < declared.min || value > declared.max) { boundsOk = false; boundsWhy = `参数 ${id} 越界 ${value} 不在 [${declared.min},${declared.max}]`; break; }
      }
      if (!boundsOk) break;
    }
  }
  check('★ 所有被接受的指令都在模型声明范围内（不越界）', boundsOk, boundsWhy);
  check('★ 队列长度从未超过上限 8', maxQueueSeen <= 8, `峰值 ${maxQueueSeen}`);
  check('★ 口型参数一条都没被接受', accepted.every((r) => !Object.keys(r.command.payload?.params ?? {}).some(isExclusiveParameter)));
  check('★ 没读到能力清单时不放行需要清单的指令', accepted.every((r) => r.command.payload?.params === undefined || r.command.payload.params !== null));

  console.log(`    （接受 ${accepted.length} 条 / 拒绝 ${rejected.length} 条 / 队列峰值 ${maxQueueSeen}）`);
  console.log(`    （被拒的码：${[...new Set(rejected.map((r) => r.code))].join(', ')}）`);
}

// ── [11] 8 个官方样本全部走一遍 20 条 ───────────────────────────────────────
console.log('[11] ★ 8 个真实模型 × 20 条指令，逐模型断言不越界');
{
  let allOk = true;
  const summary = [];
  for (const name of SAMPLE_NAMES) {
    const caps = capsByName[name];
    let modelOk = true;
    let why = '';

    for (let i = 0; i < 20; i += 1) {
      // 轮换各种类型，并且故意每 4 条塞一条错的。
      const bad = i % 4 === 3;
      let raw;
      switch (i % 4) {
        case 0: raw = { kind: 'say', text: `第 ${i} 句` }; break;
        case 1: raw = { kind: 'motion', group: caps.motionGroups[0]?.name ?? 'Idle' }; break;
        case 2: raw = { kind: 'expression', name: caps.expressions[0]?.name ?? 'F01' }; break;
        default: raw = { kind: 'param', params: { ParamAngleX: i } }; break;
      }
      if (bad) raw = { ...raw, kind: raw.kind === 'say' ? 'say' : raw.kind, group: '绝对不存在的组', name: '绝对不存在的表情' };

      const result = buildAction(raw, caps);
      if (result.ok) {
        const p = result.command.payload ?? {};
        if (p.motion && !caps.motionGroups.some((g) => g.name === p.motion.group)) { modelOk = false; why = `${name}: 放行了不存在的组 ${p.motion.group}`; }
        if (p.expression && p.expression.name !== undefined && !caps.expressions.some((e) => e.name === p.expression.name)) { modelOk = false; why = `${name}: 放行了不存在的表情 ${p.expression.name}`; }
      } else if (!result.code.startsWith('E_')) {
        modelOk = false; why = `${name}: 拒绝时没有错误码`;
      }
      if (!modelOk) break;
    }

    check(`${name} 的 20 条指令没有越界`, modelOk, why);
    if (!modelOk) allOk = false;
    summary.push(`${name}(${caps.expressions.length}表情/${caps.motionGroups.length}组)`);
  }
  check('★ 8 个模型全部通过', allOk);
  console.log(`    （${summary.join(' · ')}）`);
}

// ── [12] 反向验证：退化的实现必须被这些断言挡住 ─────────────────────────────
console.log('[12] 反向验证');
{
  // 退化 1：不做校验，原样放行。
  const naiveAccept = () => ({ ok: true, code: '', detail: '', command: { kind: 'param', priority: 50, ttlMs: 4000, at: Date.now(), payload: { params: { ParamMouthOpenY: 0.9, ParamNotAThing: 5 } } }, droppedParameters: [], clampedParameters: [] });
  const naive = naiveAccept();
  check('退化实现（不做校验）确实会放行口型参数', Object.keys(naive.command.payload.params).some(isExclusiveParameter) === true);
  check('而真实现不会', buildAction({ kind: 'param', params: { ParamMouthOpenY: 0.9 } }, capsByName.Haru).ok === false);

  // 退化 2：错误里不带可用列表。
  const noList = { code: 'E_EXPRESSION_NOT_FOUND', detail: '没有这个表达式。' };
  check('退化实现（不带可用列表）确实通不过「可自愈」断言', !noList.detail.includes(capsByName.Haru.expressions[0].name));
  check('而真实现带上了', buildAction({ kind: 'expression', name: 'zzz' }, capsByName.Haru).detail.includes(capsByName.Haru.expressions[0].name));

  // 退化 3：只按数量裁（砍掉最前面两条），完全不判 TTL。
  //
  // 夹具必须构造成「过期的那条不在最前面」，否则两种实现的输出恰好相同、
  // 这条反向验证就是假的：队列按到达顺序排时，最旧的那条通常也正好是最前面
  // 那条。真实会产生分歧的情形是「躺了很久但 TTL 很长的指令」（仍然有效）
  // 和「刚来但 TTL 很短的指令」（已经作废）同时存在。
  const now = 1_000_000;
  const longLived = { id: 'validOld', command: { kind: 'motion', priority: 50, ttlMs: 60000, at: now - 5000 } };
  const babies = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, command: { kind: 'motion', priority: 50, ttlMs: 4000, at: now - i } }));
  const stale = { id: 'expiredRecent', command: { kind: 'motion', priority: 50, ttlMs: 4000, at: now - 20000 } };
  const queue = [longLived, ...babies, stale]; // 10 条，上限 8

  const naivePrune = queue.slice(-8); // 只按数量裁：砍掉最前面 2 条
  check('退化实现（只按数量裁）会把已经过期的指令留在队列里', naivePrune.some((item) => item.id === 'expiredRecent') === true);

  const real = pruneQueue(queue, now, 8);
  check('真实现先淘汰过期的那条', real.expired.length === 1 && real.expired[0].id === 'expiredRecent', JSON.stringify(real.expired.map((i) => i.id)));
  check('真实现的队列里没有任何过期指令', real.kept.every((item) => item.id !== 'expiredRecent'));
  eq('真实现裁到 8 条', real.kept.length, 8);
  check('仍然有效的「老」指令是因为 TTL 没过期才被保留的', real.expired.every((item) => item.id !== 'validOld'));

  // 退化 4：口型独占用精确匹配（大小写敏感）。
  const exact = (id) => EXCLUSIVE_PARAMETER_IDS.includes(id);
  check('退化实现（精确匹配）会漏掉全大写写法', exact('PARAM_MOUTH_OPEN_Y') === false);
  check('而真实现拦得住', isExclusiveParameter('PARAM_MOUTH_OPEN_Y') === true);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
if (failures.length > 0) {
  console.log(`[x] 失败 ${failures.length} 项：`);
  for (const item of failures.slice(0, 30)) console.log(`    ✘ ${item.label}${item.detail ? `\n        ${item.detail}` : ''}`);
  process.exit(1);
}
console.log(`[13] ACTION GATE PASSED —— ${passed} 项断言全绿`);
