#!/usr/bin/env node
/**
 * 门禁：口型增益与字幕的**纯逻辑**（`lib/test/pet-settings.mjs` ＝ `src/client/settings.ts`）。
 *
 * 为什么需要这个文件：这两件事的判断（「用户存的这坨东西该被理解成什么设置」、
 * 「这一刻字幕该显示什么」）如果留在 `plugin.ts` 里，就永远只能靠「我在浏览器里
 * 拖了一下滑块，看着是对的」来验收。搬进纯函数之后，脏输入、边界值、以及那几条
 * 「写反了只有用户能发现」的规则才第一次有了断言。
 *
 * 用法：`node tools/test-pet-settings.mjs`（离线，无网络、无文件系统、无 DOM）
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, '..', 'dsh-live2d-pet', 'lib/test/pet-settings.mjs');

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
  console.error(`设置测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const {
  applyLipGain,
  DEFAULT_SETTINGS,
  describeLipGain,
  describeSubtitles,
  highlightRange,
  LIP_GAIN_STEP,
  MAX_LIP_GAIN,
  MIN_LIP_GAIN,
  normalizeSettings,
  readSettings,
  serializeSettings,
  SETTINGS_KEY,
  subtitleView,
  writeSettings,
} = mod;

/* ───────────────────────── [1] 导出契约 ───────────────────────── */

console.log(`[1] 导出契约  ${modulePath.replace(here, 'tools')}`);
for (const name of [
  'applyLipGain',
  'describeLipGain',
  'describeSubtitles',
  'highlightRange',
  'normalizeSettings',
  'readSettings',
  'serializeSettings',
  'subtitleView',
  'writeSettings',
]) {
  check(`导出 ${name} 是函数`, typeof mod[name] === 'function');
}
for (const name of ['DEFAULT_SETTINGS', 'MIN_LIP_GAIN', 'MAX_LIP_GAIN', 'LIP_GAIN_STEP', 'SETTINGS_KEY']) {
  check(`导出 ${name} 存在`, mod[name] !== undefined);
}
check('DEFAULT_SETTINGS 被冻结', Object.isFrozen(DEFAULT_SETTINGS));
check('默认增益是 1', DEFAULT_SETTINGS.lipGain === 1, String(DEFAULT_SETTINGS.lipGain));
check('默认开字幕', DEFAULT_SETTINGS.subtitles === true);
check('增益下限大于 0（0 等于关掉口型，那是另一档功能）', MIN_LIP_GAIN > 0, String(MIN_LIP_GAIN));
check('增益上限大于默认值', MAX_LIP_GAIN > DEFAULT_SETTINGS.lipGain, String(MAX_LIP_GAIN));
check('步进能整除到 1', Math.abs(1 / LIP_GAIN_STEP - Math.round(1 / LIP_GAIN_STEP)) < 1e-9, String(LIP_GAIN_STEP));
check(
  'SETTINGS_KEY 与既有两个键同一套命名',
  SETTINGS_KEY === 'dsh-live2d-pet.settings',
  SETTINGS_KEY,
);

/* ───────────────────────── [2] normalizeSettings 的脏输入 ───────────────────────── */

console.log('\n[2] normalizeSettings（永不抛，缺的用默认值补）');
{
  const cases = [
    ['undefined', undefined],
    ['null', null],
    ['数字', 42],
    ['字符串', 'abc'],
    ['数组', [1, 2, 3]],
    ['空对象', {}],
  ];
  for (const [label, input] of cases) {
    let result;
    let threw = null;
    try {
      result = normalizeSettings(input);
    } catch (error) {
      threw = error;
    }
    check(`${label} 不抛异常`, threw === null, threw ? String(threw?.message ?? threw) : '');
    check(
      `${label} 落到默认值`,
      threw === null && result.lipGain === 1 && result.subtitles === true,
      threw === null ? JSON.stringify(result) : '',
    );
  }

  check('增益超上限被夹住', normalizeSettings({ lipGain: 99 }).lipGain === MAX_LIP_GAIN);
  check('增益超下限被夹住', normalizeSettings({ lipGain: -5 }).lipGain === MIN_LIP_GAIN);
  check('增益是 NaN 时退回默认', normalizeSettings({ lipGain: NaN }).lipGain === 1);
  check('增益是 Infinity 时退回默认', normalizeSettings({ lipGain: Infinity }).lipGain === 1);
  check('增益是字符串数字时被接受', normalizeSettings({ lipGain: '1.5' }).lipGain === 1.5);
  check('增益是 "abc" 时退回默认', normalizeSettings({ lipGain: 'abc' }).lipGain === 1);
  check('字幕开关非布尔时退回默认', normalizeSettings({ subtitles: 'yes' }).subtitles === true);
  check('字幕开关 false 被保留', normalizeSettings({ subtitles: false }).subtitles === false);
  check('只给一半时另一半补默认', normalizeSettings({ subtitles: false }).lipGain === 1);
  check('结果只有这两个字段', Object.keys(normalizeSettings({ lipGain: 1.2, subtitles: false, extra: 1 })).length === 2);
}

/* ───────────────────────── [3] 序列化与读写往返 ───────────────────────── */

console.log('\n[3] serialize / read / write');
{
  const text = serializeSettings({ lipGain: 1.35, subtitles: false });
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    check('序列化结果是合法 JSON', false, String(error?.message ?? error));
  }
  check('序列化结果是合法 JSON', parsed !== null, text);
  check('序列化保留增益', parsed?.lipGain === 1.35, String(parsed?.lipGain));
  check('序列化保留字幕开关', parsed?.subtitles === false, String(parsed?.subtitles));
  check('序列化会先归一化（脏输入不会写进存储）', JSON.parse(serializeSettings({ lipGain: 99 })).lipGain === MAX_LIP_GAIN);

  // 假存储：只实现 getItem / setItem，正是 StorageLike 声明的两个方法。
  function makeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
      map,
      getItem(key) {
        return map.has(key) ? map.get(key) : null;
      },
      setItem(key, value) {
        map.set(key, String(value));
      },
    };
  }

  const empty = makeStorage();
  check('空存储读到默认值', readSettings(empty).lipGain === 1 && readSettings(empty).subtitles === true);
  check('null 存储不抛且读到默认值', readSettings(null).lipGain === 1);
  check('undefined 存储不抛且读到默认值', readSettings(undefined).lipGain === 1);

  const written = writeSettings(empty, { lipGain: 1.6 });
  check('写入返回归一化后的完整设置', written.lipGain === 1.6 && written.subtitles === true, JSON.stringify(written));
  check('写进存储用的是约定键', empty.map.has(SETTINGS_KEY), SETTINGS_KEY);
  const roundTrip = readSettings(empty);
  check('读回来与写入一致', roundTrip.lipGain === 1.6 && roundTrip.subtitles === true, JSON.stringify(roundTrip));

  const partial = writeSettings(empty, { subtitles: false });
  check('局部更新保留另一半', partial.lipGain === 1.6 && partial.subtitles === false, JSON.stringify(partial));

  const broken = makeStorage({ [SETTINGS_KEY]: '{ 半截 JSON' });
  check('半截 JSON 读到默认值而不是抛', readSettings(broken).lipGain === 1);

  const stored = makeStorage({ [SETTINGS_KEY]: JSON.stringify({ lipGain: 0.5, subtitles: false }) });
  check('存储里的合法值被读出来', readSettings(stored).lipGain === 0.5 && readSettings(stored).subtitles === false);

  const throwing = {
    getItem() {
      throw new Error('SecurityError: 隐私模式');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  let threw = null;
  try {
    readSettings(throwing);
  } catch (error) {
    threw = error;
  }
  check('存储抛异常时读不炸', threw === null, threw ? String(threw.message) : '');
  threw = null;
  let wrote = null;
  try {
    wrote = writeSettings(throwing, { lipGain: 1.2 });
  } catch (error) {
    threw = error;
  }
  check('存储抛异常时写不炸', threw === null, threw ? String(threw.message) : '');
  check('存储抛异常时设置本会话仍然生效', wrote?.lipGain === 1.2, JSON.stringify(wrote));
}

/* ───────────────────────── [4] applyLipGain ───────────────────────── */

console.log('\n[4] applyLipGain（出口一定夹在 [0,1]）');
{
  check('1.0 倍原样通过', applyLipGain(0.5, 1) === 0.5, String(applyLipGain(0.5, 1)));
  check('2.0 倍放大', applyLipGain(0.5, 2) === 1, String(applyLipGain(0.5, 2)));
  check('0.5 倍缩小', applyLipGain(0.8, 0.5) === 0.4, String(applyLipGain(0.8, 0.5)));
  check('放大后仍然不超过 1', applyLipGain(0.9, 2) === 1);
  check('缩小后不会变成负数', applyLipGain(0.1, 0.5) >= 0);
  check('0 输入恒为 0（静音时嘴巴必须闭着）', applyLipGain(0, 2) === 0);
  check('超范围增益被夹住', applyLipGain(0.5, 99) === 1);
  check('负增益被夹到下限而不是变负', applyLipGain(0.5, -3) === 0.5 * MIN_LIP_GAIN);
  check('openness 是 NaN 时输出 0', applyLipGain(NaN, 1) === 0);
  check('openness 是字符串时输出 0', applyLipGain('0.5', 1) === 0);
  check('gain 不是数字时按默认值算', applyLipGain(0.5, 'x') === 0.5);
  let allInRange = true;
  for (let i = 0; i <= 100; i += 1) {
    for (const gain of [MIN_LIP_GAIN, 0.5, 1, 1.5, MAX_LIP_GAIN]) {
      const value = applyLipGain(i / 100, gain);
      if (!(value >= 0 && value <= 1)) allInRange = false;
    }
  }
  check('任意输入下输出恒在 [0,1]', allInRange);
}

/* ───────────────────────── [5] describeLipGain ───────────────────────── */

console.log('\n[5] describeLipGain（要说清往哪边是更大）');
{
  check('默认值', describeLipGain(1) === '口型幅度 100%（默认）', describeLipGain(1));
  const bigger = describeLipGain(1.5);
  check('比默认大时说清方向', bigger.includes('150%') && bigger.includes('比默认大'), bigger);
  const smaller = describeLipGain(0.8);
  check('比默认小', smaller.includes('80%') && smaller.includes('比默认小'), smaller);
  check('超上限按上限报', describeLipGain(99).includes(`${Math.round(MAX_LIP_GAIN * 100)}%`), describeLipGain(99));
  check('脏输入按默认报', describeLipGain('abc') === '口型幅度 100%（默认）', describeLipGain('abc'));
  check('不出现 undefined', !describeLipGain(undefined).includes('undefined'));
}

/* ───────────────────────── [6] highlightRange ───────────────────────── */

console.log('\n[6] highlightRange（按顺序匹配、找到就推进光标）');
{
  const text = '你好，世界你好';
  const words = [{ text: '你好' }, { text: '世界' }, { text: '你好' }];
  check('第一个词', JSON.stringify(highlightRange(text, words, 0)) === '[0,2]', JSON.stringify(highlightRange(text, words, 0)));
  check('第二个词', JSON.stringify(highlightRange(text, words, 1)) === '[3,5]', JSON.stringify(highlightRange(text, words, 1)));
  check(
    '★ 重复出现的词定位到第二处而不是第一处',
    JSON.stringify(highlightRange(text, words, 2)) === '[5,7]',
    JSON.stringify(highlightRange(text, words, 2)),
  );
  check('过大的下标返回未命中（不猜、不高亮最后一个词）', JSON.stringify(highlightRange(text, words, 99)) === '[-1,-1]');
  check('负下标返回未命中', JSON.stringify(highlightRange(text, words, -1)) === '[-1,-1]');
  check('词不在原文里返回未命中（而不是抛）', JSON.stringify(highlightRange('abc', [{ text: 'zzz' }], 0)) === '[-1,-1]');
  check('空文本返回未命中', JSON.stringify(highlightRange('', words, 0)) === '[-1,-1]');
  check('words 不是数组返回未命中', JSON.stringify(highlightRange(text, null, 0)) === '[-1,-1]');
  check('空词被跳过返回未命中', JSON.stringify(highlightRange(text, [{ text: '' }], 0)) === '[-1,-1]');
  check('下标不是数字返回未命中', JSON.stringify(highlightRange(text, words, 'a')) === '[-1,-1]');
  check('NaN 下标返回未命中', JSON.stringify(highlightRange(text, words, NaN)) === '[-1,-1]');
  const slice = highlightRange(text, words, 1);
  check('区间是半开区间（slice 出来就是那个词）', text.slice(slice[0], slice[1]) === '世界', text.slice(slice[0], slice[1]));
}

/* ───────────────────────── [7] subtitleView ───────────────────────── */

console.log('\n[7] subtitleView（什么时候不显示，和显示什么）');
{
  const on = { lipGain: 1, subtitles: true };
  const off = { lipGain: 1, subtitles: false };
  const source = { speaking: true, text: '你好，世界', activeWordIndex: 1, words: [{ text: '你好' }, { text: '世界' }] };

  check('关掉字幕时不可见', subtitleView(source, off).visible === false);
  check('源为 null 时不可见', subtitleView(null, on).visible === false);
  check('源为 undefined 时不可见', subtitleView(undefined, on).visible === false);
  check('★ 没在说话时不可见（不留「说完再多显示一秒」的尾巴）', subtitleView({ ...source, speaking: false }, on).visible === false);
  check('speaking 是字符串 "true" 时也按不可见处理', subtitleView({ ...source, speaking: 'true' }, on).visible === false);
  check('文本为空时不可见', subtitleView({ ...source, text: '' }, on).visible === false);
  check('文本是 null 时不可见', subtitleView({ ...source, text: null }, on).visible === false);

  const view = subtitleView(source, on);
  check('说话时可见', view.visible === true);
  check('带上整句文本', view.text === '你好，世界', view.text);
  check('高亮落在第二个词上', view.text.slice(view.highlightFrom, view.highlightTo) === '世界', `${view.highlightFrom}-${view.highlightTo}`);
  check('没有词边界时整句显示（高亮区间为 -1）', subtitleView({ ...source, words: [] }, on).highlightFrom === -1);
  check('activeWordIndex 缺失时整句显示', subtitleView({ ...source, activeWordIndex: undefined }, on).highlightFrom === -1);
  check('words 缺失时整句显示', subtitleView({ ...source, words: undefined }, on).highlightFrom === -1);
  const frozen = subtitleView(null, on);
  check('隐藏视图是冻结的（界面改不动它）', Object.isFrozen(frozen));
  check('隐藏视图四个字段齐全', Object.keys(frozen).length === 4, Object.keys(frozen).join(','));
}

/* ───────────────────────── [8] describeSubtitles ───────────────────────── */

console.log('\n[8] describeSubtitles（为什么现在没有字幕）');
{
  const on = { lipGain: 1, subtitles: true };
  const off = { lipGain: 1, subtitles: false };
  check('关掉时明说关掉了', describeSubtitles(off, { visible: false, text: '', highlightFrom: -1, highlightTo: -1 }) === '字幕已关闭');
  const idle = describeSubtitles(on, { visible: false, text: '', highlightFrom: -1, highlightTo: -1 });
  check('开着但没说话时说清「说话时才显示」', idle.includes('说话时才显示'), idle);
  const following = describeSubtitles(on, { visible: true, text: '你好', highlightFrom: 0, highlightTo: 2 });
  check('正在跟读', following.includes('正在跟读'), following);
  const whole = describeSubtitles(on, { visible: true, text: '你好', highlightFrom: -1, highlightTo: -1 });
  check('整句显示', whole.includes('整句显示'), whole);
  check('不出现 undefined', !describeSubtitles(on, undefined ?? { visible: false, text: '', highlightFrom: -1, highlightTo: -1 }).includes('undefined'));
}

/* ───────────────────────── [9] 反向验证 ───────────────────────── */

console.log('\n[9] 反向验证（门禁不是恒真）');
{
  const naive = {
    // 退化实现 1：增益不夹取（界面就会显示 1.97 这种数字）
    applyLipGain: (openness) => (typeof openness === 'number' ? openness : 0) * 2,
    // 退化实现 2：总是显示字幕，不管有没有在说话
    subtitleView: (source, settings) => ({
      visible: settings.subtitles && source != null && source.text !== '',
      text: source?.text ?? '',
      highlightFrom: -1,
      highlightTo: -1,
    }),
    // 退化实现 3：重复词总定位到第一处
    highlightRange: (text, words) => (words?.[0]?.text ? [0, words[0].text.length] : [-1, -1]),
  };

  check('反向：不夹取的实现会超出 1', naive.applyLipGain(0.9, 1) > 1, String(naive.applyLipGain(0.9, 1)));
  check('真实现把它夹住了', applyLipGain(0.9, 2) === 1);
  check(
    '反向：总是显示字幕的实现会在没说话时也可见',
    naive.subtitleView({ speaking: false, text: '你好', words: [] }, { lipGain: 1, subtitles: true }).visible === true,
  );
  check('真实现让它不可见', subtitleView({ speaking: false, text: '你好', words: [] }, { lipGain: 1, subtitles: true }).visible === false);
  const text = '你好世界你好';
  const words = [{ text: '你好' }, { text: '世界' }, { text: '你好' }];
  check('反向：不推进光标的实现会把第三个词也定到第一处', JSON.stringify(naive.highlightRange(text, [words[2]])) === '[0,2]');
  check('真实现定位到第二处', JSON.stringify(highlightRange(text, words, 2)) === '[4,6]', JSON.stringify(highlightRange(text, words, 2)));
}

/* ───────────────────────── 汇总 ───────────────────────── */

console.log('');
if (failed > 0) {
  console.log(`[!] PET SETTINGS GATE FAILED —— ${passed} 项通过，${failed} 项失败`);
  process.exit(1);
}
console.log(`[9] PET SETTINGS GATE PASSED —— ${passed} 项断言全绿`);
