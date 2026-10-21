#!/usr/bin/env node
/**
 * 门禁：**音色清单与「换音色」设置的归一化**（`lib/host/tts-voices.js`）。
 *
 * ## 为什么需要这个文件
 *
 * 用户要把 TTS 换成另一种音色（m25769），于是「音色」从一条**只能由调用方给的
 * 可选参数**变成了一件**要存进 `settings.json` 的偏好**。这一步把两个新风险带进来：
 *
 *   - 存进配置的值是**用户手写的**：`ttsVoice` 写成中文、写成 `xiaoxiao`、
 *     写成带引号的 `"zh-CN-XiaoxiaoNeural'"` —— 都不会崩，只会**静默地**
 *     退回默认音色（用户以为改成功了，听到的还是晓晓）；
 *   - 语速 `ttsRate` 是字符串 `'+15%'`：`parseInt` 一把梭会把 `'-10%'` 变成 `-10`
 *     再变成 `'-10%'`？不会 —— 会变成 `'+0%'` 或者 `'NaN%'`，取决于写法。
 *
 * 所以判据必须是「坏值退回默认**并且说出来**」（`notes` 里留一句），而不是
 * 「不抛错就算通过」。
 *
 * ## 为什么 import 源码
 *
 * `tts-voices.js` 零 import，门禁直接 import 它 —— 跑的是用户装上的那一份。
 *
 * ## 用法
 *
 *     node tools/test-tts-voices.mjs     （离线：无网络、无 DOM）
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_ENGINE_ID,
  DEFAULT_RATE,
  DEFAULT_VOICE_ID,
  MAX_RATE_PERCENT,
  TTS_ENGINES,
  VOICE_PRESETS,
  describeVoice,
  engineById,
  isVoiceShortName,
  normalizeRate,
  normalizeTtsSettings,
  voiceOptions,
  voicePresetById,
} from '../dsh-live2d-pet/lib/host/tts-voices.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', 'dsh-live2d-pet');
const sourcePath = resolve(packageRoot, 'lib/host/tts-voices.js');

let passed = 0;
let failed = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`);
  }
};

/* ══════════════════════════════════════════════════════════════════════════ *
 * [1] 清单本身
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[1] 音色清单');

check('清单非空', VOICE_PRESETS.length > 0, `${VOICE_PRESETS.length} 项`);
check('清单至少 15 个可选音色（少于这个数，「换音色」等于没得选）', VOICE_PRESETS.length >= 15, `${VOICE_PRESETS.length}`);
check('默认音色在清单里（否则面板下拉框没有选中项）', voicePresetById(DEFAULT_VOICE_ID) !== null, DEFAULT_VOICE_ID);
check('默认音色就是 edge-tts.js 里的 zh-CN-XiaoxiaoNeural', DEFAULT_VOICE_ID === 'zh-CN-XiaoxiaoNeural');
check('默认语速是 +0%', DEFAULT_RATE === '+0%');
check('默认引擎是 edge', DEFAULT_ENGINE_ID === 'edge');
check('引擎表里有 edge 与 custom',
  engineById('edge') !== null && engineById('custom') !== null);

const ids = VOICE_PRESETS.map((preset) => preset.id);
check('音色 id 不重复', new Set(ids).size === ids.length,
  `${ids.length} 项 / ${new Set(ids).size} 个不同 id`);
check('清单里每个 id 都过形状检查', ids.every((id) => isVoiceShortName(id) === true),
  ids.filter((id) => isVoiceShortName(id) !== true).join(', '));
check('清单里每个 label 非空', VOICE_PRESETS.every((preset) => typeof preset.label === 'string' && preset.label.trim() !== ''));
check('清单里每个 note 非空（面板要拿它解释「听起来像什么」）',
  VOICE_PRESETS.every((preset) => typeof preset.note === 'string' && preset.note.trim() !== ''));
check('清单里每个 locale 形如 zh-CN / zh-TW / en-US',
  VOICE_PRESETS.every((preset) => /^[a-z]{2,3}-[A-Z]{2}$/.test(preset.locale)),
  VOICE_PRESETS.filter((preset) => !/^[a-z]{2,3}-[A-Z]{2}$/.test(preset.locale)).map((preset) => preset.locale).join(', '));
check('locale 与 id 的前缀一致（「晓北（东北话）」写的是 zh-CN 就不能挂 zh-TW 的 id）',
  VOICE_PRESETS.every((preset) => preset.id.startsWith(`${preset.locale}-`)),
  VOICE_PRESETS.filter((preset) => !preset.id.startsWith(`${preset.locale}-`)).map((preset) => preset.id).join(', '));
check('清单里都是女/男/中性三档之一',
  VOICE_PRESETS.every((preset) => ['female', 'male', 'neutral'].includes(preset.gender)));
check('有中文女声也有中文男声（只有一种的话「换音色」只换了个寂寞）',
  VOICE_PRESETS.some((p) => p.locale === 'zh-CN' && p.gender === 'female')
  && VOICE_PRESETS.some((p) => p.locale === 'zh-CN' && p.gender === 'male'));

/* ══════════════════════════════════════════════════════════════════════════ *
 * [2] isVoiceShortName —— 形状检查（不查在线可用性）
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[2] 音色 id 的形状检查');

check('zh-CN-XiaoxiaoNeural 合法', isVoiceShortName('zh-CN-XiaoxiaoNeural') === true);
check('zh-CN-liaoning-XiaobeiNeural（三段地区）合法', isVoiceShortName('zh-CN-liaoning-XiaobeiNeural') === true);
check('en-US-AriaNeural 合法', isVoiceShortName('en-US-AriaNeural') === true);
check('首尾空格被容错', isVoiceShortName('  zh-CN-YunxiNeural  ') === true);

check('空串不合法', isVoiceShortName('') === false);
check('纯中文不合法（用户最容易犯的错）', isVoiceShortName('晓晓') === false);
check('短名不合法（写成 xiaoxiao）', isVoiceShortName('xiaoxiao') === false);
check('带引号不合法（从文档里复制时最容易带上）', isVoiceShortName("zh-CN-XiaoxiaoNeural'") === false);
check('带空格不合法', isVoiceShortName('zh-CN-Xiao xiaoNeural') === false);
check('没有地区段不合法', isVoiceShortName('XiaoxiaoNeural') === false);
check('超长（>64）不合法', isVoiceShortName(`zh-CN-${'a'.repeat(80)}Neural`) === false);
check('非字符串不合法', isVoiceShortName(42) === false && isVoiceShortName(null) === false && isVoiceShortName({}) === false);
check('末尾得是名字而不是 Neural 之前就断了（zh-CN-XiaoxiaoNeuralNeural 也合法：名字部分不设限）',
  isVoiceShortName('zh-CN-XiaoxiaoNeuralNeural') === true);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [3] describeVoice / voiceOptions —— 面板上显示什么
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[3] 显示名与下拉选项');

check('清单内的音色显示成「晓晓（zh-CN）」', describeVoice('zh-CN-XiaoxiaoNeural') === '晓晓（zh-CN）');
check('清单外的音色原样显示（不遮成「未知」）',
  describeVoice('zh-CN-MyOwnNeural') === 'zh-CN-MyOwnNeural');
check('空值显示成空串', describeVoice('') === '' && describeVoice(undefined) === '');
check('首尾空格被吃掉', describeVoice(' zh-CN-YunxiNeural ') === '云希（zh-CN）');

const optionsDefault = voiceOptions(DEFAULT_VOICE_ID);
check('下拉框包含清单里的每一项', optionsDefault.length === VOICE_PRESETS.length,
  `${optionsDefault.length} vs ${VOICE_PRESETS.length}`);
check('下拉框里没有「手写」补位项（当前值在清单里）',
  optionsDefault.every((option) => option.custom === false));
check('下拉框的 label 带地区', optionsDefault.every((option) => option.label.includes('（')));
// 性别必须在 label 里：23 个选项长得一样时，「换一种声音」这件事就变成逐个试听。
check('下拉框的 label 带性别（男声 / 女声都出现）',
  optionsDefault.every((option) => option.label.includes('男声') || option.label.includes('女声'))
  && optionsDefault.some((option) => option.label.includes('男声'))
  && optionsDefault.some((option) => option.label.includes('女声')),
  optionsDefault.slice(0, 2).map((option) => option.label).join(' / '));

const optionsCustom = voiceOptions('zh-CN-MyOwnNeural');
check('当前值不在清单里时，补一项在**最前面**（用户一打开就看见自己存的那个）',
  optionsCustom.length === VOICE_PRESETS.length + 1 && optionsCustom[0].custom === true
  && optionsCustom[0].id === 'zh-CN-MyOwnNeural',
  optionsCustom[0]?.id);
check('补位项标了「手写」', optionsCustom[0].label.includes('手写'), optionsCustom[0].label);
check('空当前值不补位', voiceOptions('').length === VOICE_PRESETS.length);
check('非字符串当前值不补位', voiceOptions(null).length === VOICE_PRESETS.length);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [4] normalizeRate —— '+15%' 这种字符串
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[4] 语速归一化');

const rate = (value) => {
  const result = normalizeRate(value);
  return result.ok ? result.value : `!${result.code}`;
};

check('+15% 原样', rate('+15%') === '+15%');
check('-10% 原样', rate('-10%') === '-10%');
check('15%（省加号）补成 +15%', rate('15%') === '+15%');
check('0 补成 +0%', rate('0') === '+0%');
check('数字 15 也认', rate(15) === '+15%');
check('空格容错', rate(' +20% ') === '+20%');
check('undefined → 默认 +0%', rate(undefined) === '+0%');
check('null → 默认 +0%', rate(null) === '+0%');
check('空串 → 默认 +0%', rate('') === '+0%');
check('上限 +100% 合法', rate(`+${MAX_RATE_PERCENT}%`) === `+${MAX_RATE_PERCENT}%`);
check('下限 -100% 合法', rate(`-${MAX_RATE_PERCENT}%`) === `-${MAX_RATE_PERCENT}%`);
check('超过上限被拒（+150%）', rate('+150%') === '!E_TTS_BAD_RATE');
check('低于下限被拒（-150%）', rate('-150%') === '!E_TTS_BAD_RATE');
check('fast 这种写法被拒', rate('fast') === '!E_TTS_BAD_RATE');
check('1.5 这种小数被拒（不是 ±N%）', rate('1.5') === '!E_TTS_BAD_RATE');
check('百分比里带空格被拒', rate('+1 5%') === '!E_TTS_BAD_RATE');

const ratePercent = normalizeRate('-10%');
check('归一化同时给出数字（面板滑块要用）', ratePercent.ok === true && ratePercent.percent === -10,
  JSON.stringify(ratePercent));

/* ══════════════════════════════════════════════════════════════════════════ *
 * [5] normalizeTtsSettings —— settings.json 那三个扁平键
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[5] 设置归一化');

const fresh = normalizeTtsSettings(undefined);
check('没配置时用默认音色', fresh.voice === DEFAULT_VOICE_ID, fresh.voice);
check('没配置时 voiceSource = default（面板据此显示「默认」）', fresh.voiceSource === 'default');
check('没配置时语速 +0%', fresh.rate === DEFAULT_RATE);
check('没配置时引擎 edge', fresh.engine === 'edge');
check('没配置时不报 noise', fresh.notes.length === 0, fresh.notes.join(' | '));
check('null / 数组 / 字符串都当空配置', normalizeTtsSettings(null).voice === DEFAULT_VOICE_ID
  && normalizeTtsSettings([]).voice === DEFAULT_VOICE_ID
  && normalizeTtsSettings('nope').voice === DEFAULT_VOICE_ID);

const chosen = normalizeTtsSettings({ ttsVoice: 'zh-CN-YunxiNeural', ttsRate: '-10%' });
check('配置里的音色被采用', chosen.voice === 'zh-CN-YunxiNeural', chosen.voice);
check('采用配置时 voiceSource = settings', chosen.voiceSource === 'settings');
check('配置里的语速被采用', chosen.rate === '-10%', chosen.rate);
check('配置完好时不报 noise', chosen.notes.length === 0, chosen.notes.join(' | '));

const badVoice = normalizeTtsSettings({ ttsVoice: '晓晓' });
check('坏音色退回默认', badVoice.voice === DEFAULT_VOICE_ID, badVoice.voice);
check('坏音色要**说出来**（notes 非空），不能静默退回',
  badVoice.notes.length === 1 && badVoice.notes[0].includes('ttsVoice'), badVoice.notes.join(' | '));
check('坏音色时 voiceSource = default', badVoice.voiceSource === 'default');

const badRate = normalizeTtsSettings({ ttsRate: 'fast' });
check('坏语速退回 +0%', badRate.rate === DEFAULT_RATE);
check('坏语速也要说出来', badRate.notes.length === 1 && badRate.notes[0].includes('ttsRate'), badRate.notes.join(' | '));

const badEngine = normalizeTtsSettings({ ttsEngine: 'openai' });
check('未知引擎退回 edge', badEngine.engine === 'edge');
check('未知引擎要说出来', badEngine.notes.some((note) => note.includes('ttsEngine')), badEngine.notes.join(' | '));

const customNoEndpoint = normalizeTtsSettings({ ttsEngine: 'custom' });
check('custom 引擎被接受', customNoEndpoint.engine === 'custom');
check('custom 没配 endpoint 时留一句提醒（否则用户会以为是插件坏了）',
  customNoEndpoint.notes.some((note) => note.includes('ttsEndpoint')), customNoEndpoint.notes.join(' | '));

const customOk = normalizeTtsSettings({ ttsEngine: 'custom', ttsEndpoint: 'http://127.0.0.1:9880/tts' });
check('custom + endpoint 不报 noise', customOk.notes.length === 0, customOk.notes.join(' | '));
check('endpoint 首尾空格被吃掉', customOk.endpoint === 'http://127.0.0.1:9880/tts');
check('非字符串 endpoint 归成空串', normalizeTtsSettings({ ttsEndpoint: 42 }).endpoint === '');

// 键名是扁平的：嵌套 `tts: {...}` 不认 —— 这条断言是为了防止有人「顺手改成嵌套」
// 却忘了 applySettingsPatch 是浅合并（会把用户手写的另一半抹掉）。
check('嵌套 tts 对象不被当成配置（扁平键是有意的）',
  normalizeTtsSettings({ tts: { voice: 'zh-CN-YunxiNeural' } }).voice === DEFAULT_VOICE_ID);

/*
 * 「用哪份」（§13.28）：这两项必须能进 settings.json —— 选择只存在面板 state 里
 * 的话，点一次「检测本机」就会被探测结果的默认值顶掉。
 */
check('没配「用哪份」时是空串（面板据此显示「默认安装」）',
  fresh.localRoot === '' && fresh.localConfig === '');

const localChosen = normalizeTtsSettings({
  ttsLocalRoot: ' D:\\GPT-SoVITS\\GPT-SoVITS-v5pro ',
  ttsLocalConfig: ' tts_infer_dafei-v5.yaml ',
});
check('ttsLocalRoot / ttsLocalConfig 收下并去掉两端空白',
  localChosen.localRoot === 'D:\\GPT-SoVITS\\GPT-SoVITS-v5pro'
  && localChosen.localConfig === 'tts_infer_dafei-v5.yaml');

const localBadRoot = normalizeTtsSettings({ ttsLocalRoot: 42 });
check('ttsLocalRoot 不是字符串 → 空串 + 一条 notes',
  localBadRoot.localRoot === '' && localBadRoot.notes.some((note) => note.includes('ttsLocalRoot')));

const localTooLong = normalizeTtsSettings({ ttsLocalRoot: `D:\\${'x'.repeat(600)}` });
check('ttsLocalRoot 超过 512 字符 → 空串（不把一整段垃圾拼进命令行）',
  localTooLong.localRoot === '' && localTooLong.notes.some((note) => note.includes('ttsLocalRoot')));

for (const bad of ['GPT_SoVITS/configs/tts_infer.yaml', 'a\\b.yaml', '..\\..\\evil.yaml', 'x'.repeat(80)]) {
  const result = normalizeTtsSettings({ ttsLocalConfig: bad });
  check(`ttsLocalConfig 只收文件名：${bad.slice(0, 24)} → 空串`,
    result.localConfig === '' && result.notes.some((note) => note.includes('ttsLocalConfig')));
}

const localNonStringConfig = normalizeTtsSettings({ ttsLocalConfig: ['tts_infer.yaml'] });
check('ttsLocalConfig 不是字符串 → 空串 + 一条 notes',
  localNonStringConfig.localConfig === '' && localNonStringConfig.notes.some((note) => note.includes('ttsLocalConfig')));

/* ══════════════════════════════════════════════════════════════════════════ *
 * [6] 反证：把三条守卫弄坏，判据必须变假
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[6] 反证（坏守卫必须让判据变假）');

const source = readFileSync(sourcePath, 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'dsh-tts-voices-'));

/**
 * 把源码里的某段替换掉，写成 .mjs 再 import。
 * （临时目录没有 package.json，`.js` 会被当成 CJS —— 必须写 `.mjs`。）
 */
const importMutated = async (name, from, to) => {
  const text = source.replace(from, to);
  if (text === source) throw new Error(`反证 ${name} 没找到要替换的片段：${from}`);
  const file = join(tmp, `${name}.mjs`);
  writeFileSync(file, text, 'utf8');
  return import(pathToFileURL(file).href);
};

try {
  // ① 名字长度上限失效 → 任意长的名字都会被当成合法音色存进配置
  //
  // 这里**不能**去删 «text.length > 64» 那条守卫：它其实永远为假（正则里的
  // `{0,40}` 已经把整串卡在 61 字符内），第一版反证就是这么写的，结果两条判据
  // 同时为真、反证自己没红。要弄坏的是正则里那个真正起作用的界。
  const brokenShape = await importMutated('shape', '[A-Za-z][A-Za-z0-9]{0,40}$', '[A-Za-z][A-Za-z0-9]{0,400}$');
  check('反证①：弄坏名字长度界后，超长 id 变成合法（真代码里是 false）',
    brokenShape.isVoiceShortName(`zh-CN-${'a'.repeat(80)}Neural`) === true
    && isVoiceShortName(`zh-CN-${'a'.repeat(80)}Neural`) === false);

  // ② 语速上限失效 → ±9999% 也会被写进配置
  const brokenRate = await importMutated('rate', 'percent > MAX_RATE_PERCENT || percent < -MAX_RATE_PERCENT', 'false');
  check('反证②：弄坏上限守卫后，+9999% 变成合法（真代码里是 E_TTS_BAD_RATE）',
    brokenRate.normalizeRate('+9999%').ok === true
    && normalizeRate('+9999%').ok === false);

  // ③ 手写音色补位失效 → 用户存了清单外的音色，面板会显示成清单第一项
  const brokenOptions = await importMutated('options', 'if (text !== \'\' && voicePresetById(text) === null) {', 'if (false) {');
  check('反证③：弄坏补位后，清单外的当前值不在选项里（真代码里在最前面）',
    brokenOptions.voiceOptions('zh-CN-MyOwnNeural').every((option) => option.id !== 'zh-CN-MyOwnNeural')
    && voiceOptions('zh-CN-MyOwnNeural')[0].id === 'zh-CN-MyOwnNeural');

  // ④ 坏值静默退回（不报 noise）→ 用户永远不知道自己写错了
  const brokenSilent = await importMutated('silent', "notes.push(`ttsVoice 不是合法的音色 id（${JSON.stringify(source.ttsVoice)}），已忽略`);", '');
  check('反证④：弄坏提示后，坏音色静默退回（真代码里 notes 有一条）',
    brokenSilent.normalizeTtsSettings({ ttsVoice: '晓晓' }).notes.length === 0
    && normalizeTtsSettings({ ttsVoice: '晓晓' }).notes.length === 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * [7] 接线：Host 的路由与 /speak 的默认值
 *
 * 这一段的每一条都在防同一类失败：**模块写对了，但没人用它**。
 * 「能跑的门禁覆盖不到的只有接错线」—— 所以这里读的是 `lib/index.js` 的源码，
 * 钉的是「谁在什么时候调用了什么」，不是模块自己的行为。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[7] 接线（Host）');

const hostSource = readFileSync(resolve(packageRoot, 'lib/index.js'), 'utf8');
const ttsRouteAt = hostSource.indexOf("if (rest === '/tts')");
const ttsRoute = ttsRouteAt < 0 ? '' : hostSource.slice(ttsRouteAt, ttsRouteAt + 9000);

check('Host 注册了 /tts 路由', ttsRouteAt > 0);
check('/tts 有 GET（面板读偏好）与 POST（面板写偏好）', ttsRoute.includes('req.method === \'GET\'') && ttsRoute.includes('req.method !== \'POST\''));
check('/tts GET 交出「为什么是它」的三样：voiceSource / notes / settingsPath',
  ttsRoute.includes('voiceSource: settings.voiceSource')
  && ttsRoute.includes('notes: settings.notes')
  && ttsRoute.includes('settingsPath:'));
check('/tts GET 的清单来自 voiceOptions(当前值)（而不是客户端写死一份）',
  ttsRoute.includes('voices: voiceOptions(settings.voice)'));
check('/tts POST 对坏音色回 E_TTS_BAD_VOICE（写坏值必须拒绝，不静默吞）',
  ttsRoute.includes('E_TTS_BAD_VOICE') && ttsRoute.includes('isVoiceShortName(payload.voice)'));
check('/tts POST 对坏引擎回 E_TTS_BAD_ENGINE', ttsRoute.includes('E_TTS_BAD_ENGINE'));
check('/tts POST 是**补丁式**合并：只给 voice 时保留原有 rate',
  ttsRoute.includes('payload.rate !== undefined ? payload.rate : current.rate'));
check('/tts POST 不把默认值写进文件（文件里只留与默认不同的键）',
  ttsRoute.includes('ttsVoice: merged.voice === DEFAULT_VOICE_ID ? undefined : merged.voice'));
check('/tts POST 写完清掉设置缓存（下一条 /speak 立刻用新音色）',
  ttsRoute.includes("ttsSettingsCache = { key: '', value: null };"));

// /speak 的默认值：用户没点名音色时，必须走面板上保存的那个。
// （这一段在 `/speak` 的处理函数里，没有独立的函数名可锚，所以用那句赋值当锚点。）
const requestedAt = hostSource.indexOf('const requestedVoice = typeof payload?.voice');
const speakBlock = requestedAt < 0 ? '' : hostSource.slice(requestedAt, requestedAt + 900);
check('/speak 的默认音色来自 ttsSettings（不是 edge-tts 的 DEFAULT_VOICE）',
  speakBlock.includes(': ttsSettings.voice') && speakBlock.includes(': ttsSettings.rate'));
check('/speak 的优先级是「本次调用 > 用户偏好」（AI 点名仍能压过面板）',
  requestedAt > 0
  && speakBlock.indexOf("payload?.voice") < speakBlock.indexOf('ttsSettings.voice'));

/* ══════════════════════════════════════════════════════════════════════════ *
 * [8] 接线：客户端的「音色」一节
 *
 * 面板是这一轮**唯一让用户能改音色**的入口，所以它消失、错位、或者「试听顺手
 * 保存了」，用户都会以为功能坏了。这里钉四件事：存在、装在设置区、试听不落盘、
 * 失败的措辞说得出「可能是 Host 没重启」。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[8] 接线（客户端面板）');

const clientSource = readFileSync(resolve(packageRoot, 'src/client/plugin.ts'), 'utf8');
const toneAt = clientSource.indexOf('function VoiceToneSection()');

/**
 * 取一个顶层函数的**完整**函数体。
 *
 * 固定长度切片踩过两次坑：函数一长，后面的断言就落在裁剪边界外（假红），
 * 或者把下一个函数吞进来（`saveTts` 一进块，「试听不落盘」立刻假红）。
 * 所以按「下一个同级 function 声明」当右边界。
 */
const sliceFunction = (source, startAt) => {
  if (startAt < 0) return '';
  const candidates = ['\n  async function ', '\n  function ']
    .map((marker) => source.indexOf(marker, startAt + 10))
    .filter((at) => at > 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(startAt, end);
};

/*
 * 「音色」这一节的切片用它**自己的右边界**（下一个同级 function），不再写死长度：
 * 这一节已经因为长出去被切掉红过三次（自定义 TTS → 本地 TTS 一键 → 音色包），
 * 每次都要手改一个数字，而数字一过时断言就变成假红（看着像代码坏了）。
 */
const toneBlock = sliceFunction(clientSource, toneAt);

const auditionAt = clientSource.indexOf('async function auditionTtsVoice');
const auditionBlock = sliceFunction(clientSource, auditionAt);

check('面板有「音色」一节', toneAt > 0);
check('「音色」装在设置区、且在「语音包」之前（主要需求在前）',
  clientSource.includes('h(VoiceToneSection, {})')
  && clientSource.indexOf('h(VoiceToneSection, {})') < clientSource.indexOf('h(VoiceSection, {})'));
check('音色下拉的数据来自 Host（view.voices），客户端没有写死清单',
  toneBlock.includes('view.voices.map') && !/zh-CN-XiaoxiaoNeural/.test(toneBlock));
check('保存会把 voice 与 rate 一起交给 /tts',
  /saveTts\(\{[\s\S]{0,300}?rate,[\s\S]{0,300}?voice:/.test(toneBlock));
check('试听走 /speak 且**带**待保存的音色与语速',
  auditionBlock.includes('/speak') && auditionBlock.includes('voice,') && auditionBlock.includes('rate,'));
check('试听**不落盘**：试听函数里没有保存调用', !auditionBlock.includes('saveTts') && !auditionBlock.includes('/tts'));
/*
 * 试听的音源名要按 Host 回告的 engine 走（Edge → 'edge'，本地服务 → 'custom'），
 * 默认仍是 'edge' —— 早期这一行写死过 `adapterId: 'edge'`，接上自定义服务后
 * 面板会一直说「Edge-TTS」，而声音其实来自本地模型。
 */
check('试听的音源名跟着 engine 走，默认 edge（不会把本地声音说成 Edge-TTS）',
  auditionBlock.includes("data.engine === 'custom' ? 'custom' : 'edge'"));
check('Host 没重启时说得出来（404 → 「重启 DSH 再看」）', toneBlock.includes('Host 还是旧代码'));
check('notes 会显示（「你的配置被忽略了」不能吞掉）', toneBlock.includes('view.notes.join'));
check('清单外的手写音色有入口（自定义 ShortName）', toneBlock.includes('CUSTOM_VOICE_OPTION'));
check('「来源」写出来（默认 / settings.json 路径）', toneBlock.includes('当前来源'));

/* ══════════════════════════════════════════════════════════════════════════ *
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
