/**
 * test-tts-adapters.mjs — TTS 降级策略门禁（方案文档 §6.1 #8）。
 *
 * 被验对象：`dsh-live2d-pet/lib/host/tts-adapters.js`
 *   —— Host 与客户端**共用**的那一份纯策略（零 import，客户端 bundle 会内联它）。
 *
 * 这一份门禁全是纯逻辑，不联网、不碰文件系统（唯一的例外是 [6] 段：读一眼 Host
 * 源码，核对白名单里的错误码是不是真的存在 —— 那一读读的是**代码**，不是用户数据）。
 *
 *   node tools/test-tts-adapters.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const MODULE_PATH = resolve(ROOT, 'dsh-live2d-pet', 'lib', 'host', 'tts-adapters.js');

const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
    failures.push(`${label}${detail ? `  ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

const {
  TTS_ADAPTERS,
  DEFAULT_ADAPTER_ID,
  FALLBACK_ADAPTER_ID,
  NO_DEGRADE_CODES,
  adapterById,
  isDegradable,
  chooseAdapter,
  describeDegradation,
} = await import(pathToFileURL(MODULE_PATH).href);

/* ── [1] 登记表形状 ──────────────────────────────────────────────────── */
section('[1] 适配器登记表');
{
  check('TTS_ADAPTERS 是数组', Array.isArray(TTS_ADAPTERS));
  check('有且只有两个适配器', TTS_ADAPTERS.length === 2, String(TTS_ADAPTERS.length));
  check('登记表被冻结（不会有人运行时往里塞一个）', Object.isFrozen(TTS_ADAPTERS));

  for (const adapter of TTS_ADAPTERS) {
    const fields = ['id', 'label', 'quality', 'transport', 'needsNetwork', 'note'];
    check(`「${adapter?.id}」六个字段齐全`,
      fields.every((f) => adapter[f] !== undefined), fields.filter((f) => adapter[f] === undefined).join(','));
    check(`「${adapter?.id}」的 note 解释了它为什么是这个质量档`,
      typeof adapter.note === 'string' && adapter.note.length >= 10);
    check(`「${adapter?.id}」的 quality 是 high|low`,
      adapter.quality === 'high' || adapter.quality === 'low', String(adapter.quality));
    check(`「${adapter?.id}」的 transport 是 host|renderer`,
      adapter.transport === 'host' || adapter.transport === 'renderer', String(adapter.transport));
    check(`「${adapter?.id}」被冻结`, Object.isFrozen(adapter));
  }

  const edge = adapterById('edge');
  check('edge 跑在 Host 半区', edge?.transport === 'host', String(edge?.transport));
  check('edge 需要联网', edge?.needsNetwork === true);
  check('edge 是高质量档', edge?.quality === 'high', String(edge?.quality));

  const system = adapterById('system');
  check('system 跑在渲染端', system?.transport === 'renderer', String(system?.transport));
  check('system 不需要联网（这正是它能当兜底的原因）', system?.needsNetwork === false);
  check('system 是低质量档', system?.quality === 'low', String(system?.quality));

  const ids = TTS_ADAPTERS.map((a) => a.id);
  check('id 不重复', new Set(ids).size === ids.length, ids.join(','));

  check('DEFAULT_ADAPTER_ID 是 edge', DEFAULT_ADAPTER_ID === 'edge', DEFAULT_ADAPTER_ID);
  check('FALLBACK_ADAPTER_ID 是 system', FALLBACK_ADAPTER_ID === 'system', FALLBACK_ADAPTER_ID);
  // 默认值与兜底值如果拼错，`chooseAdapter` 会静默退回 edge，那时降级等于没发生。
  check('默认值真的在表里', adapterById(DEFAULT_ADAPTER_ID) !== null);
  check('兜底值真的在表里', adapterById(FALLBACK_ADAPTER_ID) !== null);
  check('默认与兜底不是同一个（降级才有意义）', DEFAULT_ADAPTER_ID !== FALLBACK_ADAPTER_ID);

  check('NO_DEGRADE_CODES 被冻结', Object.isFrozen(NO_DEGRADE_CODES));
  /*
   * 原来这里断言的是「恰好三条」。那种断言在往白名单里**加**一条时会红，
   * 而加一条正确的码本来就不该红 —— 它守的是数字，不是行为。
   * 改成断言成员：该在的都在，且每一个都真的不降级（下面 [3] 段）。
   */
  for (const code of ['E_TTS_EMPTY_TEXT', 'E_TTS_TEXT_TOO_LONG', 'E_BAD_JSON']) {
    check(`白名单里有 ${code}`, NO_DEGRADE_CODES.includes(code));
  }
  // ★ 「请求本身就不该发出去」这一类 —— 入参格式错误与空文本同类。
  for (const code of ['E_TTS_BAD_VOICE', 'E_TTS_BAD_RATE', 'E_TTS_BAD_PITCH']) {
    check(`★ 白名单里有 ${code}（入参错误不该靠换个引擎掩盖）`, NO_DEGRADE_CODES.includes(code));
  }
  check('白名单里没有重复项', new Set(NO_DEGRADE_CODES).size === NO_DEGRADE_CODES.length);
  check('白名单里全是错误码字面量',
    NO_DEGRADE_CODES.every((c) => typeof c === 'string' && /^E_[A-Z0-9_]+$/.test(c)),
    NO_DEGRADE_CODES.join(','));
}

/* ── [2] adapterById ─────────────────────────────────────────────────── */
section('[2] 按 id 找适配器');
{
  check('找得到 edge', adapterById('edge')?.id === 'edge');
  check('找得到 system', adapterById('system')?.id === 'system');
  check('认不出的 id 返回 null', adapterById('edge-tts') === null);
  check('大小写敏感（写错了就该退回去，而不是碰巧命中）', adapterById('Edge') === null);
  check('数字返回 null', adapterById(1) === null);
  check('null 返回 null', adapterById(null) === null);
  check('undefined 返回 null', adapterById(undefined) === null);
  check('对象返回 null', adapterById({ id: 'edge' }) === null);
}

/* ── [3] isDegradable ────────────────────────────────────────────────── */
section('[3] 这个错误码值不值得换个引擎');
{
  for (const code of NO_DEGRADE_CODES) {
    check(`白名单 ${code} 不降级`, isDegradable(code) === false);
  }

  // 这些全都是 `lib/host/edge-tts.js` 真的会抛的码 —— 没有一条是「请求写错了」。
  const transient = [
    'E_TTS_TIMEOUT',
    'E_TTS_SOCKET',
    'E_TTS_CLOSED_EARLY',
    'E_TTS_EMPTY_AUDIO',
    'E_TTS_NOT_MP3',
    'E_TTS_VOICE_LIST',
    'E_WS_MISSING',
    'E_TTS_FAILED',
  ];
  for (const code of transient) {
    check(`${code} 降级`, isDegradable(code) === true);
  }

  /*
   * ★ 这是整个模块最重要的取舍，值得一条单独的断言：
   *   完全没见过的错误码**照样降级**。猜错成「降级」的代价是机器音 + 一行提示；
   *   猜错成「不降级」的代价是什么都没发生也没有解释 —— 正是 §6.1 #8 要防的体验。
   */
  check('★ 完全没见过的错误码也降级（默认降级，不是默认不降）',
    isDegradable('E_SOMETHING_NOBODY_WROTE_YET') === true);
  check('大小写不同就算「没见过」，因此降级',
    isDegradable('e_tts_empty_text') === true);
  check('空字符串视为「不知道出了什么错」，降级', isDegradable('') === true);
  check('非字符串也降级', isDegradable(undefined) === true && isDegradable(500) === true);

  // 反向验证：如果 `isDegradable` 退化成恒真，上面「白名单不降级」那三条会红。
  check('★ isDegradable 不是恒真（存在返回 false 的输入）',
    NO_DEGRADE_CODES.length > 0 && isDegradable(NO_DEGRADE_CODES[0]) === false);
}

/* ── [4] chooseAdapter ───────────────────────────────────────────────── */
section('[4] 决定这次用哪个');
{
  const fresh = chooseAdapter();
  check('没传参数时用默认适配器', fresh.adapterId === 'edge', fresh.adapterId);
  check('没传参数时不算降级', fresh.degraded === false);
  check('没传参数时不产生提示语', fresh.reason === '');

  check('failureCode 为空串不算降级', chooseAdapter({ failureCode: '' }).degraded === false);
  check('failureCode 为 null 不算降级', chooseAdapter({ failureCode: null }).degraded === false);
  check('failureCode 为 undefined 不算降级', chooseAdapter({ failureCode: undefined }).degraded === false);

  for (const code of NO_DEGRADE_CODES) {
    const decision = chooseAdapter({ failureCode: code });
    check(`${code} 不降级，仍在用 edge`,
      decision.degraded === false && decision.adapterId === 'edge', decision.adapterId);
    check(`${code} 给了用户一个「为什么没换」的理由`,
      decision.reason.includes('没有降级'), decision.reason);
    check(`${code} 的理由里带上了原始错误码`, decision.reason.includes(code));
  }

  const degraded = chooseAdapter({ failureCode: 'E_TTS_TIMEOUT' });
  check('E_TTS_TIMEOUT 降级到 system',
    degraded.degraded === true && degraded.adapterId === 'system', degraded.adapterId);
  check('降级理由说清了「从谁换到谁」',
    degraded.reason.includes('Edge-TTS') && degraded.reason.includes('系统语音'), degraded.reason);
  check('降级理由带上了错误码', degraded.reason.includes('E_TTS_TIMEOUT'));

  const unknown = chooseAdapter({ failureCode: 'E_WHATEVER' });
  check('★ 未知错误码也降级（与 [3] 的取舍一致）', unknown.degraded === true);

  // 幂等：兜底适配器自己失败时，还是它（不能再往下掉一层）。
  const alreadyFallback = chooseAdapter({ preferred: 'system', failureCode: 'E_TTS_TIMEOUT' });
  check('已经在用 system 时再降级仍是 system',
    alreadyFallback.adapterId === 'system' && alreadyFallback.degraded === true,
    alreadyFallback.adapterId);

  const typo = chooseAdapter({ preferred: 'Edge-TTS', failureCode: 'E_TTS_TIMEOUT' });
  check('preferred 拼错时退回默认适配器而不是崩',
    typo.adapterId === 'system' && typo.reason.includes('Edge-TTS'), typo.reason);

  const garbage = chooseAdapter({ preferred: 42, failureCode: {} });
  check('preferred 与 failureCode 都是垃圾时仍返回可用结果',
    typeof garbage.adapterId === 'string' && typeof garbage.degraded === 'boolean'
      && typeof garbage.reason === 'string',
    JSON.stringify(garbage));
}

/* ── [5] describeDegradation ─────────────────────────────────────────── */
section('[5] 给用户看的那句话');
{
  check('没降级时不显示任何东西', describeDegradation() === '');
  check('degraded:false 时为空', describeDegradation({ adapterId: 'edge', degraded: false }) === '');

  const text = describeDegradation(chooseAdapter({ failureCode: 'E_TTS_TIMEOUT' }));
  check('降级时非空', text.length > 0);
  check('★ 明说了「音质会明显下降」（§6.1 #8 明确要求界面给提示）',
    text.includes('音质会明显下降'), text);
  check('说清了这是暂时的', text.includes('恢复联网'), text);
  check('保留了原始理由', text.startsWith('Edge-TTS 用不了'), text);

  const noReason = describeDegradation({ adapterId: 'system', degraded: true });
  check('没给理由时自己补一句「已换成系统语音」',
    noReason.includes('已换成系统语音'), noReason);

  const typoAdapter = describeDegradation({ adapterId: 'nope', degraded: true });
  check('adapterId 拼错也给出可读的话（不出现 undefined）',
    typoAdapter.length > 0 && !typoAdapter.includes('undefined'), typoAdapter);

  check('degraded 传了非布尔值时按未降级处理',
    describeDegradation({ degraded: 'yes' }) === '');
  check('文本里不出现 NaN / undefined',
    !text.includes('NaN') && !text.includes('undefined'));
}

/* ── [6] 白名单里的码必须真的存在于 Host 源码里 ──────────────────────── */
section('[6] 白名单没有拼错（读的是代码，不是数据）');
{
  /*
   * 一条白名单条目打错一个字母，那道保护会**静默失效** —— 那个码永远匹配不上，
   * 于是本该「不降级」的情况被降级成机器音，而且没有任何地方会报错。
   * 唯一能自动发现它的办法，就是去 Host 源码里找这个字面量。
   */
  const sources = [
    readFileSync(resolve(ROOT, 'dsh-live2d-pet', 'lib', 'host', 'edge-tts.js'), 'utf8'),
    // 自定义服务那条路也会抛「不该降级」的码（E_TTS_EMPTY_TEXT / …_UPSTREAM_BAD_REQUEST），
    // 少读这个文件的话，白名单里那两个码会被误判成拼错。
    readFileSync(resolve(ROOT, 'dsh-live2d-pet', 'lib', 'host', 'custom-tts.js'), 'utf8'),
    readFileSync(resolve(ROOT, 'dsh-live2d-pet', 'lib', 'index.js'), 'utf8'),
  ].join('\n');

  for (const code of NO_DEGRADE_CODES) {
    check(`白名单里的 ${code} 在 Host 源码里真的存在`,
      sources.includes(`'${code}'`) || sources.includes(`"${code}"`) || sources.includes(`\`${code}`),
      '拼错一个字母就会让这道保护静默失效');
  }

  // 反向验证：随便编一个码，必须找不到 —— 否则上面的断言其实是恒真的。
  check('★ 现编的错误码确实找不到（上一条不是恒真）',
    !sources.includes("'E_THIS_CODE_DOES_NOT_EXIST'"));
}

console.log('');
if (failures.length === 0) {
  console.log('[7] TTS ADAPTER GATE PASSED');
} else {
  console.log(`[x] TTS ADAPTER GATE FAILED：${failures.length} 项未通过`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exitCode = 1;
}
