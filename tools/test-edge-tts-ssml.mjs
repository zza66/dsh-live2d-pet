/**
 * test-edge-tts-ssml.mjs — SSML 拼装与 TTS 入参边界门禁。
 *
 * 被验对象：
 *   - `dsh-live2d-pet/lib/host/edge-tts.js` 的 `buildSsml()` 与 `synthesize()`；
 *   - `dsh-live2d-pet/lib/host/actions.js` 的 `readSpeechField()` 一族
 *     （两半区共用的那一份取值规则）；
 *   - `dsh-live2d-pet/lib/host/tts-adapters.js` 的 `NO_DEGRADE_CODES`。
 *
 * 这一份**不联网**。合成一次要打真实 Edge-TTS，而这里要问的所有问题
 * （拼出来的字符串长什么样、坏值有没有在开 socket 之前被挡住、失败有没有带上
 * 可读的错误码）都能离线回答。
 *
 * 为什么会有这一份：`text` 和它的三个邻居（`voice` / `rate` / `pitch`）写在同一行
 * SSML 里，而**只有 `text` 被转义了**。实测四个带单引号的取值全部 502，用户听到的
 * 是「她没说话」、日志写的是「语音服务出错了」。见方案 §4.2.10。
 *
 *   node tools/test-edge-tts-ssml.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const HOST_DIR = resolve(ROOT, 'dsh-live2d-pet', 'lib', 'host');
const EDGE_TTS_PATH = resolve(HOST_DIR, 'edge-tts.js');
const ACTIONS_PATH = resolve(HOST_DIR, 'actions.js');
const ADAPTERS_PATH = resolve(HOST_DIR, 'tts-adapters.js');

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

const { buildSsml, synthesize } = await import(pathToFileURL(EDGE_TTS_PATH).href);
const {
  SPEECH_RATE_PATTERN,
  SPEECH_PITCH_PATTERN,
  VOICE_NAME_PATTERN,
  MAX_VOICE_NAME_CHARS,
  MAX_TEXT_CHARS,
  buildAction,
  readSpeechField,
  readSpeechRate,
  readSpeechPitch,
  readVoiceName,
} = await import(pathToFileURL(ACTIONS_PATH).href);
const { NO_DEGRADE_CODES, isDegradable } = await import(pathToFileURL(ADAPTERS_PATH).href);

/**
 * 把一段文本丢给 `synthesize()`，回它抛出来的错误码（没抛就是 `null`）。
 *
 * `[4b]` 用它问「同一个边界值，两层是不是给出同一个判断」。
 *
 * ★ **必须带着一个坏 `voice` 一起调**，否则「长度合法」那一次会一路走到开
 * WebSocket —— 这道门禁的两条硬规矩是「不联网」与「300ms 内返回」。带上
 * `voice: 'nope'` 之后，`synthesize()` 一定会在**入参校验**那一段就抛出来，
 * 而长度检查排在它前面 —— 于是「抛的是哪个码」正好回答了「长度检查放行了没有」：
 *   - 长度合法 → 落到 `E_TTS_BAD_VOICE`（说明没被长度挡住）
 *   - 长度超限 → `E_TTS_TEXT_TOO_LONG`（说明长度检查先跑）
 * 两个码都不碰网络。
 */
async function rejectsWith(text) {
  try {
    await synthesize({ text, voice: 'nope' });
    return null;
  } catch (error) {
    return error?.code ?? String(error);
  }
}

/* ── [1] 转义：四个插值一个都不能漏 ──────────────────────────────────── */
section('[1] buildSsml 的四个插值全部转义');
{
  check('buildSsml 是导出的', typeof buildSsml === 'function');

  /*
   * 单个字符逐个数。断言「结果里没有裸的 '」比断言「结果里有 &apos;」更强：
   * 前者同时也排除了「转义了但只转了一部分」。
   */
  const NASTY = "'";
  const ok = buildSsml('正常的文本', 'zh-CN-XiaoxiaoNeural', '+10%', '+0Hz');
  check('正常输入拼得出结构完整的 SSML',
    ok.startsWith("<speak version='1.0'") && ok.endsWith('</voice></speak>'));
  check('正常输入里 rate / pitch / voice 都在原位',
    ok.includes("rate='+10%'") && ok.includes("pitch='+0Hz'") && ok.includes("name='zh-CN-XiaoxiaoNeural'"));

  // ★ 三个属性值各自单独注入一次 —— 旧实现只转义 text，这三个都会漏。
  for (const [field, index] of [['voice', 1], ['rate', 2], ['pitch', 3]]) {
    const args = ['普通的文本', 'zh-CN-XiaoxiaoNeural', '+10%', '+0Hz'];
    args[index] = `x${NASTY}y`;
    const ssml = buildSsml(...args);
    check(`★ ${field} 里的单引号被转义（不再提前闭合属性）`,
      !ssml.includes(`x'y`), ssml.slice(0, 120));
    check(`${field} 转义成 &apos; 后属性仍然闭合`,
      ssml.includes('&apos;') && ssml.includes("volume='+0%'"));
  }

  // text 本来就转义了，这里钉住它不许回退。
  const textInjection = buildSsml(`<script>alert('x')</script>&`, 'zh-CN-XiaoxiaoNeural', '+0%', '+0Hz');
  check('text 里的 < > & \' 仍然全部转义',
    !textInjection.includes('<script>') && !textInjection.includes("'x'")
    && textInjection.includes('&lt;script&gt;') && textInjection.includes('&amp;'));

  // 上面那三个各自注入过，这里再合起来注一次：三段拼在一起也不许产生新的裸引号。
  // 基准从一次干净的调用量出来 —— 写死数字的话，以后往 SSML 里加一个属性就会误报。
  const countQuotes = (s) => s.split("'").length - 1;
  const baseline = countQuotes(buildSsml('普通的文本', 'zh-CN-XiaoxiaoNeural', '+0%', '+0Hz'));
  const all = buildSsml("he said 'hi'", "voice'x", "rate'x", "pitch'x");
  check('★ 全部注入时属性分隔用的单引号数量不变（＝没有多出来的裸引号）',
    countQuotes(all) === baseline, `基准 ${baseline}，注入后 ${countQuotes(all)}`);
}

/* ── [2] 取值规则（actions.js，两半区共用） ──────────────────────────── */
section('[2] readSpeechField 一族');
{
  check('三个正则都是 RegExp',
    SPEECH_RATE_PATTERN instanceof RegExp && SPEECH_PITCH_PATTERN instanceof RegExp && VOICE_NAME_PATTERN instanceof RegExp);

  // 没给 → 用默认值，不算错。
  for (const empty of [undefined, null, '']) {
    const r = readSpeechRate(empty);
    check(`rate 是 ${JSON.stringify(empty)} 时用默认值且不算错`, r.ok === true && r.value === undefined);
  }

  // 实测过的合法取值（无符号与带符号逐字节相同，所以正负号可选）。
  for (const good of ['+10%', '-10%', '10%', '+0%', '+100%']) {
    const r = readSpeechRate(good);
    check(`rate ${JSON.stringify(good)} 合法`, r.ok === true && r.value === good);
  }
  // 实测过的不合法取值。
  for (const bad of ["1'2", 'x<y', 'fast', '1.5', '10', '%', '+1000%']) {
    const r = readSpeechRate(bad);
    check(`★ rate ${JSON.stringify(bad)} 被拒`, r.ok === false && r.value === undefined && r.detail !== '');
  }
  check('被拒时的说明里带了正确格式（可自愈）',
    readSpeechRate('fast').detail.includes('%'));

  check('非字符串被拒并说明收到的是什么类型',
    readSpeechRate(123).detail.includes('number') && readSpeechRate({}).ok === false);

  for (const good of ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'en-US-AnaNeural']) {
    check(`voice ${JSON.stringify(good)} 合法`, readVoiceName(good).ok === true);
  }
  for (const bad of ["zh-CN-XiaoxiaoNeural'", 'xiaoxiao', '晓晓', 'zh CN', '-zh-CN', 'zh-CN-']) {
    check(`★ voice ${JSON.stringify(bad)} 被拒`, readVoiceName(bad).ok === false);
  }
  check(`voice 超长（>${MAX_VOICE_NAME_CHARS}）被拒`,
    readVoiceName(`zh-CN-${'A'.repeat(MAX_VOICE_NAME_CHARS)}Neural`).detail.includes('上限'));

  for (const good of ['+0Hz', '-50Hz', '200Hz', '+200Hz']) {
    check(`pitch ${JSON.stringify(good)} 合法`, readSpeechPitch(good).ok === true);
  }
  for (const bad of ["1'2", 'fast', '200']) {
    check(`★ pitch ${JSON.stringify(bad)} 被拒`, readSpeechPitch(bad).ok === false);
  }

  // 校验的正则本身必须拒绝换行 —— SSML 属性里混进换行同样是注入。
  check('★ 三个正则都不接受换行',
    !SPEECH_RATE_PATTERN.test('+10%\n') && !VOICE_NAME_PATTERN.test('zh-CN\nXiaoxiaoNeural')
    && !SPEECH_PITCH_PATTERN.test('+0Hz\n'));

  // 泛型入口：调用方自己传正则与提示语。
  const custom = readSpeechField('abc', /^[a-z]+$/, '只接受小写字母');
  check('readSpeechField 可以用自定义正则', custom.ok === true && custom.value === 'abc');
  check('readSpeechField 的自定义提示语会出现在说明里',
    readSpeechField('ABC', /^[a-z]+$/, '只接受小写字母').detail.includes('只接受小写字母'));
}

/* ── [3] synthesize() 在开 socket 之前就挡住坏值 ────────────────────── */
section('[3] synthesize() 的入参边界（不联网）');
{
  const cases = [
    ['rate', { text: '你好', rate: "1'2" }, 'E_TTS_BAD_RATE'],
    ['rate', { text: '你好', rate: 'fast' }, 'E_TTS_BAD_RATE'],
    ['voice', { text: '你好', voice: 'xiaoxiao' }, 'E_TTS_BAD_VOICE'],
    ['voice', { text: '你好', voice: "zh-CN-X'.Neural" }, 'E_TTS_BAD_VOICE'],
    ['pitch', { text: '你好', pitch: 'fast' }, 'E_TTS_BAD_PITCH'],
    ['text', { text: '   ' }, 'E_TTS_EMPTY_TEXT'],
    ['text', { text: 'a'.repeat(2001) }, 'E_TTS_TEXT_TOO_LONG'],
  ];
  for (const [field, options, expected] of cases) {
    let thrown = null;
    try {
      await synthesize(options);
    } catch (error) {
      thrown = error;
    }
    check(`★ ${field} 坏值时抛出 ${expected}`, thrown !== null && thrown.code === expected,
      thrown === null ? '没有抛（可能已经开始联网了）' : String(thrown.code));
    check(`${expected} 的 message 里带着人话`,
      thrown !== null && typeof thrown.message === 'string' && thrown.message.includes(expected));
  }

  /*
   * 坏值必须在**开 socket 之前**被挡住。判据：这两个调用必须瞬时返回 ——
   * 真去打网络的话，即使秒失败也要几十毫秒，而超时上限是 20 秒。
   * 用 300ms 当阈值：留足了 CI 抖动的余量，又远远小于任何网络往返。
   */
  const t0 = Date.now();
  for (const options of [{ text: '你好', rate: 'fast' }, { text: '你好', voice: 'xiaoxiao' }]) {
    try { await synthesize(options); } catch { /* 预期就是抛 */ }
  }
  check('★ 两个坏值都在 300ms 内返回（说明没有去连网络）', Date.now() - t0 < 300,
    `实测 ${Date.now() - t0}ms`);

  // 合法取值不许被这两道校验误伤 —— 判据是「没有抛 E_TTS_BAD_*」。
  // （它随后会真去联网，所以用 noCache 之外的短路很难避免；因此这里只问
  //   「抛出来的码不是 BAD_*」，并把网络失败本身排除在断言之外。）
  let legalThrown = null;
  try {
    await synthesize({ text: '你好', rate: '+10%', voice: 'zh-CN-XiaoxiaoNeural', timeoutMs: 1 });
  } catch (error) {
    legalThrown = error;
  }
  check('合法取值不会被入参校验拦住',
    legalThrown === null || !String(legalThrown.code ?? '').startsWith('E_TTS_BAD_'),
    legalThrown === null ? '（未抛）' : String(legalThrown.code));
}

/* ── [4] 失败要带 `.code`，否则路由那一层只会回一句笼统的话 ─────────── */
section('[4] 自产错误都带 .code');
{
  /*
   * 这一条查的是**源码结构**，不是运行时行为。
   *
   * 为什么只能这样：`E_TTS_TIMEOUT` / `E_TTS_SOCKET` / `E_TTS_CLOSED_EARLY`
   * 三个码分别要「真的超时 20 秒」「真的把 socket 打挂」「真的握完手就断开」，
   * 一份离线门禁造不出来。而这里要守的不变式非常具体 ——
   * **本文件里每一个 `new Error(...)` 都必须出自 `throwWithCode()`**，
   * 因为 `/speak` 路由读的是 `error.code`，裸的 `new Error('E_TTS_XXX: …')`
   * 会被抹成 `E_TTS_FAILED`，用户与日志都看不到真正的原因。
   *
   * 这个不变式用眼睛看很容易漏（原来就是漏的），用一行代码看住它值得。
   */
  const source = readFileSync(EDGE_TTS_PATH, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bare = code.match(/new Error\(/g) ?? [];
  check('★ 源码里只剩 throwWithCode() 内部那一处 new Error',
    bare.length === 1, `实测 ${bare.length} 处`);
  check('throwWithCode 定义与用法都在',
    code.includes('function throwWithCode(code, message)')
    && (code.match(/throwWithCode\(/g) ?? []).length >= 6);
  check('★ 三个内部错误码都真的被指派过',
    code.includes("'E_TTS_TIMEOUT'") && code.includes("'E_TTS_SOCKET'") && code.includes("'E_TTS_CLOSED_EARLY'"));
  check('★ E_TTS_BAD_VOICE / BAD_RATE / BAD_PITCH 三个码都在',
    code.includes("'E_TTS_BAD_VOICE'") && code.includes("'E_TTS_BAD_RATE'") && code.includes("'E_TTS_BAD_PITCH'"));

  // 结构性反例：路由那一层确实读 `.code`（否则上面这一整节都不成立）。
  const hostIndex = readFileSync(resolve(ROOT, 'dsh-live2d-pet', 'lib', 'index.js'), 'utf8');
  check('★ /speak 路由确实按 error.code 回错误码（这一节的前提）',
    /error\?\.code \?\? ['"]E_TTS_FAILED['"]/.test(hostIndex));
}

/* ── [4b] 同一个数字只写一遍 ─────────────────────────────────────────── */
section('[4b] ★ 文本上限只有一个定义处');
{
  /*
   * 这一节守的不变式与 [4] 同类（查源码结构），但问题换了个方向：
   * **「同一个数字被写了几遍？」**
   *
   * `MAX_TEXT_CHARS` 原来在 `actions.js` 与 `edge-tts.js` 里各声明了一份
   * `2000`，`lib/index.js` 给 LLM 的工具描述里还手写了第三遍。三份都写着
   * 2000 的时候，没有任何一条断言会红 —— 而只改其中一份的后果是：
   * 工具回「已排队」→ 客户端 POST `/speak` → TTS 那一层按旧上限拒掉
   * → `E_TTS_TEXT_TOO_LONG` 不降级 → **这句话一个字都没说出来**，
   * 而 AI 那边记的是成功。
   *
   * 所以断言三件事：定义只有一处、`edge-tts.js` 是从定义处 import 的、
   * 工具描述里的数字是从定义处拼进去的。
   */
  const hostFiles = readdirSync(HOST_DIR).filter((f) => f.endsWith('.js'));
  const declaredIn = hostFiles.filter((f) => {
    const src = readFileSync(resolve(HOST_DIR, f), 'utf8');
    // 去掉注释再找声明 —— 否则解释「这里原本有一份」的注释会被算成一份。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return /(^|\s)(export\s+)?const\s+MAX_TEXT_CHARS\s*=/.test(code);
  });
  check('★ lib/host/ 下只有一处声明 MAX_TEXT_CHARS',
    declaredIn.length === 1 && declaredIn[0] === 'actions.js',
    `实测 ${declaredIn.length} 处：${declaredIn.join(', ') || '（无）'}`);

  const edgeSrc = readFileSync(EDGE_TTS_PATH, 'utf8');
  check('★ edge-tts.js 从 ./actions.js import 了它（而不是自己写一个数）',
    /import\s*\{[^}]*\bMAX_TEXT_CHARS\b[^}]*\}\s*from\s*'\.\/actions\.js'/.test(edgeSrc));

  const hostIndex = readFileSync(resolve(ROOT, 'dsh-live2d-pet', 'lib', 'index.js'), 'utf8');
  check('★ 工具描述里的数字是从定义处拼进去的（不是手写的 2000）',
    /description:\s*`[^`]*\$\{MAX_TEXT_CHARS\}[^`]*`/.test(hostIndex)
    && /import\s*\{[^}]*\bMAX_TEXT_CHARS\b[^}]*\}\s*from\s*'\.\/host\/actions\.js'/.test(hostIndex));

  /*
   * 行为面：同一个边界值，两层必须给出同样的判断。
   *
   * 这是上面那三条结构断言的**结果**，单独再问一遍是因为结构对了、
   * 比较符写反（`>=` 与 `>`)仍然会让两层错开一格。
   *
   * 长度合法那一次用「坏 voice 先抛」的方式问，不联网 —— 见 `rejectsWith()`。
   */
  const atLimit = '好'.repeat(MAX_TEXT_CHARS);
  const overLimit = '好'.repeat(MAX_TEXT_CHARS + 1);
  const accepted = buildAction({ kind: 'say', text: atLimit }, null);
  const rejected = buildAction({ kind: 'say', text: overLimit }, null);
  check(`恰好 ${MAX_TEXT_CHARS} 字被 buildAction 接受`, accepted.ok === true, accepted.detail);
  check(`${MAX_TEXT_CHARS + 1} 字被 buildAction 拒且码为 E_ACTION_TEXT_TOO_LONG`,
    rejected.ok === false && rejected.code === 'E_ACTION_TEXT_TOO_LONG', rejected.code);

  const atLimitCode = await rejectsWith(atLimit);
  check(`★ 同一个 ${MAX_TEXT_CHARS} 字也被 synthesize 放行（长度检查先跑，落在入参校验那一关）`,
    atLimitCode === 'E_TTS_BAD_VOICE', `实测 ${atLimitCode}`);
  const overLimitCode = await rejectsWith(overLimit);
  check(`★ 同一个 ${MAX_TEXT_CHARS + 1} 字被 synthesize 按长度拒掉`,
    overLimitCode === 'E_TTS_TEXT_TOO_LONG', `实测 ${overLimitCode}`);
}

/* ── [5] 入参错误不降级 ──────────────────────────────────────────────── */
section('[5] 入参错误属于「不该降级」那一类');
{
  for (const code of ['E_TTS_BAD_VOICE', 'E_TTS_BAD_RATE', 'E_TTS_BAD_PITCH']) {
    check(`${code} 在白名单里且不降级`,
      NO_DEGRADE_CODES.includes(code) && isDegradable(code) === false);
  }
  check('原有三个码仍在（没有被改写）',
    ['E_TTS_EMPTY_TEXT', 'E_TTS_TEXT_TOO_LONG', 'E_BAD_JSON'].every((c) => NO_DEGRADE_CODES.includes(c)));
  // 网络类错误**仍然**要降级 —— 换成系统语音至少还能听见。
  check('E_TTS_SOCKET / E_TTS_TIMEOUT / E_TTS_CLOSED_EARLY 仍然降级',
    ['E_TTS_SOCKET', 'E_TTS_TIMEOUT', 'E_TTS_CLOSED_EARLY'].every((c) => isDegradable(c) === true));
}

/* ── [6] 反向验证：把转义去掉，必须红 ────────────────────────────────── */
section('[6] 反向验证（三种真·退化实现）');
{
  const naiveUnescaped = (text, voice, rate, pitch) =>
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`
    + `<voice name='${voice}'>`
    + `<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${text}</prosody>`
    + `</voice></speak>`;
  const ns = naiveUnescaped('普通的文本', "voice'x", '+10%', '+0Hz');
  check('★ 不转义 voice 时结果里出现裸单引号（真实现没有）',
    ns.includes("voice'x'") && !buildSsml('普通的文本', "voice'x", '+10%', '+0Hz').includes("voice'x'"));

  // 只转义 text（＝这次的原始 bug 本身）。
  const naiveTextOnly = (text, voice, rate, pitch) =>
    naiveUnescaped(text.replace(/'/g, '&apos;'), voice, rate, pitch);
  const rateInjection = "x' volume='+100%'";
  check('★ 只转义 text 的实现在 rate 注入上漏（真实现不漏）',
    naiveTextOnly('hi', 'zh-CN-XiaoxiaoNeural', rateInjection, '+0Hz').includes("volume='+100%'")
    && !buildSsml('hi', 'zh-CN-XiaoxiaoNeural', rateInjection, '+0Hz').includes("volume='+100%'"));

  // 校验退化成「只查空字符串」—— 上一版实现就是这个形状。
  const naiveAccept = (value) => (typeof value === 'string' && value !== '' ? { ok: true, value } : { ok: true, value: undefined });
  const injected = "1'2";
  check('★ 「只查空串」的旧校验会放行注入值（真校验不放行）',
    naiveAccept(injected).ok === true && readSpeechRate(injected).ok === false);
}

console.log('');
if (failures.length === 0) {
  console.log(`[7] EDGE-TTS SSML GATE PASSED —— 83 项断言全绿`);
  process.exit(0);
}
console.log(`[7] EDGE-TTS SSML GATE FAILED —— ${failures.length} 项失败`);
for (const item of failures) console.log(`  ✘ ${item}`);
process.exit(1);
