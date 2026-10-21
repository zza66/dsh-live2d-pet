#!/usr/bin/env node
/**
 * 门禁：**自定义 TTS 服务**（`lib/host/custom-tts.js`）与它的三条接线。
 *
 * ## 为什么这个门禁比别的都硬
 *
 * 前面几轮的对手是「我自己的逻辑写错了」；这一轮的对手是**别人的服务**：
 * GPT-SoVITS、CosyVoice、Fish Speech，以及用户明天随便找来的一个一键包。
 * 它们回什么都有可能 —— `audio/wav`、`application/octet-stream`、
 * `{"audioBase64": …}`、405 对 GET、甚至 200 加一句 HTML 报错。
 *
 * 所以这里的判据不能是「函数没抛错」，而是**真的起一个 HTTP 服务，把每一种
 * 服务都扮演一遍**，看契约两头是否还接得上。`fetch` 走的是真的 `fetch`。
 *
 * ## 三条不能被「看起来能用」骗过的
 *
 *   1. `content-type` 不可信 → 必须靠文件头嗅探（`application/octet-stream` 也要认）；
 *   2. 「连不上」与「服务在跑但拒绝 GET」是两回事 → 探测判据是**收到响应**，不是 2xx；
 *   3. 服务把整段音频当一句话返回 → 必须有上限，否则一次响应能把标签页打死。
 *
 * ## 用法
 *
 *     node tools/test-tts-custom.mjs     （离线：只在 127.0.0.1 上起临时服务）
 */

import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CustomTtsError,
  DEFAULT_CUSTOM_TTS_TIMEOUT_MS,
  MAX_CUSTOM_TTS_BYTES,
  PROBE_TIMEOUT_MS,
  mp3DurationSeconds,
  normalizeEndpoint,
  probeCustomTts,
  sniffAudioMime,
  synthesizeCustom,
  wavDurationSeconds,
} from '../dsh-live2d-pet/lib/host/custom-tts.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(packageRoot, 'lib/host/custom-tts.js');
const hostPath = resolve(packageRoot, 'lib/index.js');
const clientPath = resolve(packageRoot, 'src/client/plugin.ts');
const speechPath = resolve(packageRoot, 'src/client/speech.ts');

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

/** 造一段静音 WAV（时长与采样率可控，用来验时长解析与上限）。 */
function makeWav({ seconds = 1, sampleRate = 16000, channels = 1 } = {}) {
  const bytesPerSample = 2;
  const dataBytes = Math.round(seconds * sampleRate * channels * bytesPerSample);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(8 * bytesPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * [1] 契约常量
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[1] 契约常量');

check('默认超时 120 秒（实测 GPT-SoVITS 第一句 41 秒、之后 1 秒；60 秒卡在边缘）', DEFAULT_CUSTOM_TTS_TIMEOUT_MS === 120_000, `${DEFAULT_CUSTOM_TTS_TIMEOUT_MS}`);
check('响应体积上限是 32MB', MAX_CUSTOM_TTS_BYTES === 32 * 1024 * 1024, `${MAX_CUSTOM_TTS_BYTES}`);
check('探测超时 4 秒（面板上点一下要立刻有反应，不能等 120 秒）', PROBE_TIMEOUT_MS === 4_000, `${PROBE_TIMEOUT_MS}`);
check('探测超时远小于合成超时', PROBE_TIMEOUT_MS * 5 < DEFAULT_CUSTOM_TTS_TIMEOUT_MS);
check('CustomTtsError 带 code（/speak 的 catch 用 error.code 当响应码）', new CustomTtsError('E_X', 'm', 'd').code === 'E_X');

const source = readFileSync(modulePath, 'utf8');
check('模块零 import（门禁 import 的就是用户装上的那一份，不依赖安装环境）', !/^\s*import\s/m.test(source));

/* ══════════════════════════════════════════════════════════════════════════ *
 * [2] 地址校验
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[2] 地址校验');

const emptyEndpoint = normalizeEndpoint('');
check('空地址 → E_TTS_ENDPOINT_EMPTY', emptyEndpoint.ok === false && emptyEndpoint.code === 'E_TTS_ENDPOINT_EMPTY');
check('非字符串 → E_TTS_ENDPOINT_EMPTY', normalizeEndpoint(null).code === 'E_TTS_ENDPOINT_EMPTY');
check('漏协议头 127.0.0.1:9880/tts → 不合法（用户最常犯的错）',
  normalizeEndpoint('127.0.0.1:9880/tts').ok === false);
check('ftp:// → 不合法（只收 http/https）',
  normalizeEndpoint('ftp://127.0.0.1/tts').ok === false
  && normalizeEndpoint('ftp://127.0.0.1/tts').detail.includes('ftp:'));
check('合法地址原样返回（不乱改用户的 URL）',
  normalizeEndpoint(' http://127.0.0.1:9880/tts ').ok === true
  && normalizeEndpoint(' http://127.0.0.1:9880/tts ').url === 'http://127.0.0.1:9880/tts');
check('https 也收', normalizeEndpoint('https://tts.example.com/v1/tts').ok === true);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [3] 文件头嗅探与时长
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[3] 文件头嗅探与时长');

const wav = makeWav({ seconds: 1.5, sampleRate: 16000 });
check('WAV 认得出', sniffAudioMime(wav) === 'audio/wav');
check('WAV 时长算得准（1.5s）', Math.abs((wavDurationSeconds(wav) ?? 0) - 1.5) < 0.01, `${wavDurationSeconds(wav)}`);
check('OggS → audio/ogg', sniffAudioMime(Buffer.from('OggS\0\0\0\0\0\0')) === 'audio/ogg');
check('ID3 → audio/mpeg', sniffAudioMime(Buffer.from('ID3\0\0\0\0\0\0')) === 'audio/mpeg');
check('fLaC → audio/flac', sniffAudioMime(Buffer.from('fLaC\0\0\0\0\0\0')) === 'audio/flac');
check('MP3 帧同步 0xFF 0xFB → audio/mpeg', sniffAudioMime(Buffer.from([0xff, 0xfb, 0x90, 0x00])) === 'audio/mpeg');
check('ftyp（m4a）→ audio/mp4', sniffAudioMime(Buffer.from('\0\0\0\0ftypM4A ')) === 'audio/mp4');
check('HTML 认不出（返回 null，不硬猜）', sniffAudioMime(Buffer.from('<html>oops</html>')) === null);
check('太短不崩（< 4 字节返回 null）', sniffAudioMime(Buffer.from([0x52])) === null);
check('mp3 时长估不出就返回 null，不编数', mp3DurationSeconds(Buffer.from([0xff])) === null);
check('wav 时长对非 wav 返回 null', wavDurationSeconds(Buffer.from('OggS\0\0\0\0\0\0\0\0')) === null);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [4] 真起一个服务：合成
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[4] 合成（真的 HTTP 往返）');

const seen = [];
const wavShort = makeWav({ seconds: 0.8, sampleRate: 16000 });

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      parsed = null;
    }
    seen.push({ url: req.url, method: req.method, body: parsed });

    if (req.url === '/wav' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(wavShort);
      return;
    }
    if (req.url === '/raw' && req.method === 'POST') {
      // 一键包常见：音频回来了，但 content-type 是八位字节流。
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(wavShort);
      return;
    }
    if (req.url === '/json' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        audioBase64: wavShort.toString('base64'),
        mimeType: 'audio/wav',
        durationSeconds: 0.8,
        voice: 'my-cloned-speaker',
        words: [{ text: '你', start: 0, end: 0.2 }],
      }));
      return;
    }
    if (req.url === '/boom' && req.method === 'POST') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('CUDA out of memory');
      return;
    }
    /*
     * 4xx：服务看懂了这个请求、但拒绝执行（超长 / 格式不认 / 鉴权不对）。
     * 这一条与 `/boom` 的 5xx 是**相反**的意思，所以两条都要有 —— 见
     * `custom-tts.js` 里 `rejected` 那段注释。
     */
    if (req.url === '/reject' && req.method === 'POST') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'text too long for this service' }));
      return;
    }
    if (req.url === '/text' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('<html>服务没启动对</html>');
      return;
    }
    if (req.url === '/empty' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end();
      return;
    }
    if (req.url === '/nokey' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: '合成的结果在这里' }));
      return;
    }
    if (req.url === '/slow' && req.method === 'POST') {
      return; // 永不响应，等客户端超时
    }
    if (req.method === 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('only POST');
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const expectCode = async (label, promise, code) => {
  try {
    await promise;
    check(label, false, '没有抛错（本应抛 ' + code + '）');
  } catch (error) {
    check(label, error?.code === code, `抛出的是 ${error?.code ?? error?.message}，本应是 ${code}`);
  }
};

const wavResult = await synthesizeCustom({ text: '你好', endpoint: `${base}/wav`, voice: 'zh-CN-YunxiNeural', rate: '-10%' });
check('WAV 直传：拿到字节', wavResult.audio.length === wavShort.length, `${wavResult.audio.length} vs ${wavShort.length}`);
check('WAV 直传：mimeType 是 audio/wav', wavResult.mimeType === 'audio/wav');
check('WAV 直传：时长为 0.8s（服务没给时长时自己算）', Math.abs(wavResult.durationSeconds - 0.8) < 0.02, `${wavResult.durationSeconds}`);
check('WAV 直传：没有词边界时 words 是空数组', Array.isArray(wavResult.words) && wavResult.words.length === 0);
check('WAV 直传：不标缓存（自定义服务没缓存语义）', wavResult.cached === false);

const sentBody = seen.find((entry) => entry.url === '/wav')?.body ?? {};
check('请求体带 text', sentBody.text === '你好', JSON.stringify(sentBody));
check('请求体带 voice（面板选的音色真的传出去了）', sentBody.voice === 'zh-CN-YunxiNeural');
check('请求体带 rate', sentBody.rate === '-10%');
check('请求体带 format=wav（告诉服务期望格式，不做格式协商）', sentBody.format === 'wav');
check('请求用 POST', seen.find((entry) => entry.url === '/wav')?.method === 'POST');

const rawResult = await synthesizeCustom({ text: '你好', endpoint: `${base}/raw` });
check('content-type 是八位字节流时靠文件头嗅探出 wav', rawResult.mimeType === 'audio/wav', rawResult.mimeType);

const jsonResult = await synthesizeCustom({ text: '你好', endpoint: `${base}/json` });
check('JSON 形态：audioBase64 解出来了', jsonResult.audio.length === wavShort.length);
check('JSON 形态：mimeType 用服务给的', jsonResult.mimeType === 'audio/wav');
check('JSON 形态：时长用服务给的 0.8s', jsonResult.durationSeconds === 0.8);
check('JSON 形态：词边界透传（字幕要用）', jsonResult.words.length === 1);
check('JSON 形态：服务自报的 voice 优先（面板能显示「你的克隆音色」）', jsonResult.voice === 'my-cloned-speaker');

await expectCode('HTTP 500 → E_TTS_UPSTREAM_BAD_STATUS', synthesizeCustom({ text: 'x', endpoint: `${base}/boom` }), 'E_TTS_UPSTREAM_BAD_STATUS');
await expectCode('HTTP 400 → E_TTS_UPSTREAM_BAD_REQUEST（服务拒了请求，不是它挂了）', synthesizeCustom({ text: 'x', endpoint: `${base}/reject` }), 'E_TTS_UPSTREAM_BAD_REQUEST');
await expectCode('返回 HTML → E_TTS_UPSTREAM_NOT_AUDIO（不把错误页当音频播）', synthesizeCustom({ text: 'x', endpoint: `${base}/text` }), 'E_TTS_UPSTREAM_NOT_AUDIO');
await expectCode('0 字节 → E_TTS_UPSTREAM_NO_AUDIO', synthesizeCustom({ text: 'x', endpoint: `${base}/empty` }), 'E_TTS_UPSTREAM_NO_AUDIO');
await expectCode('JSON 里没有音频键 → E_TTS_UPSTREAM_NO_AUDIO', synthesizeCustom({ text: 'x', endpoint: `${base}/nokey` }), 'E_TTS_UPSTREAM_NO_AUDIO');
await expectCode('不响应 → E_TTS_UPSTREAM_TIMEOUT', synthesizeCustom({ text: 'x', endpoint: `${base}/slow`, timeoutMs: 200 }), 'E_TTS_UPSTREAM_TIMEOUT');
await expectCode('端口没人听 → E_TTS_UPSTREAM_UNREACHABLE', synthesizeCustom({ text: 'x', endpoint: 'http://127.0.0.1:1/tts' }), 'E_TTS_UPSTREAM_UNREACHABLE');
await expectCode('空文本 → E_TTS_EMPTY_TEXT（不发无用请求，与 edge 同一个码名）', synthesizeCustom({ text: '   ', endpoint: `${base}/wav` }), 'E_TTS_EMPTY_TEXT');
await expectCode('坏地址 → E_TTS_ENDPOINT_INVALID', synthesizeCustom({ text: 'x', endpoint: 'nope' }), 'E_TTS_ENDPOINT_INVALID');
await expectCode('体积超上限 → E_TTS_UPSTREAM_TOO_LARGE',
  synthesizeCustom({ text: 'x', endpoint: `${base}/wav`, maxBytes: 100 }), 'E_TTS_UPSTREAM_TOO_LARGE');

const errorDetail = await (async () => {
  try {
    await synthesizeCustom({ text: 'x', endpoint: `${base}/boom` });
    return '';
  } catch (error) {
    return String(error?.detail ?? '');
  }
})();
check('HTTP 500 的 detail 带服务原话（排障时这句话最值钱）', errorDetail.includes('CUDA out of memory'), errorDetail);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [5] 探测：判据是「收到响应」，不是 2xx
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[5] 探测（测试连接）');

const probe405 = await probeCustomTts({ endpoint: `${base}/wav` });
check('只开 POST 的服务回 405 也算通（面板不该说「连不上」）', probe405.reachable === true, JSON.stringify(probe405));
check('探测结果里带 status 与耗时（面板能显示 HTTP 405 / 3ms）',
  probe405.status === 405 && Number.isFinite(probe405.elapsedMs));
const probeDead = await probeCustomTts({ endpoint: 'http://127.0.0.1:1/tts', timeoutMs: 500 });
check('端口没人听 → reachable false + 错误码', probeDead.reachable === false && typeof probeDead.code === 'string', JSON.stringify(probeDead));
check('探测失败也带人话 message（面板直接显示它）', String(probeDead.message ?? '').length > 0);
const probeBad = await probeCustomTts({ endpoint: '' });
check('空地址探测不抛错，回 reachable false', probeBad.reachable === false);
check('探测不发 POST（不在探测阶段就让服务合成一句话）',
  seen.filter((entry) => entry.url === '/wav' && entry.method === 'POST').length >= 1
  && probe405.reachable === true);

/* ══════════════════════════════════════════════════════════════════════════ *
 * [6] 反证：把守门的那行弄坏，判据必须变假
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[6] 反证');

const tmp = mkdtempSync(join(tmpdir(), 'dsh-tts-custom-'));
const mutate = async (from, to, tag) => {
  const mutated = source.split(from).join(to);
  if (mutated === source) return { ok: false, path: '' };
  const target = join(tmp, `custom-tts-${tag}.mjs`);
  writeFileSync(target, mutated, 'utf8');
  const mod = await import(`${pathToFileURL(target).href}?v=${tag}`);
  return { ok: true, path: target, mod };
};

const emptyGuard = await mutate('if (audioBytes.length === 0) {', 'if (false) {', 'empty');
check('反证 1 生效（真的改到了源码）', emptyGuard.ok);
if (emptyGuard.ok) {
  let code = '';
  try {
    await emptyGuard.mod.synthesizeCustom({ text: 'x', endpoint: `${base}/empty` });
  } catch (error) {
    code = error?.code ?? '';
  }
  check('反证 1：去掉「0 字节」守卫后，空响应的报错码变了（守卫生效）', code !== 'E_TTS_UPSTREAM_NO_AUDIO', code);
}

const sniffGuard = await mutate(
  "if (ascii(0, 4) === 'RIFF' && bytes.length >= 12 && ascii(8, 12) === 'WAVE') return 'audio/wav';",
  "if (false) return 'audio/wav';",
  'sniff',
);
check('反证 2 生效', sniffGuard.ok);
if (sniffGuard.ok) {
  let code = '';
  let mime = '';
  try {
    const result = await sniffGuard.mod.synthesizeCustom({ text: 'x', endpoint: `${base}/raw` });
    mime = result.mimeType;
  } catch (error) {
    code = error?.code ?? '';
  }
  check('反证 2：去掉 WAV 嗅探后，八位字节流的响应不再被认成音频', code === 'E_TTS_UPSTREAM_NOT_AUDIO' && mime === '', `${code} / ${mime}`);
}

const sizeGuard = await mutate('if (audioBytes.length > maxBytes) {', 'if (false) {', 'size');
check('反证 3 生效', sizeGuard.ok);
if (sizeGuard.ok) {
  let threw = '';
  try {
    await sizeGuard.mod.synthesizeCustom({ text: 'x', endpoint: `${base}/wav`, maxBytes: 100 });
  } catch (error) {
    threw = error?.code ?? '';
  }
  check('反证 3：去掉体积上限后，超限的音频被放过去了（上限真的在拦）', threw === '', threw);
}

const probeGuard = await mutate('reachable: true,', 'reachable: false,', 'probe');
check('反证 4 生效', probeGuard.ok);
if (probeGuard.ok) {
  const flipped = await probeGuard.mod.probeCustomTts({ endpoint: `${base}/wav` });
  check('反证 4：把 reachable 写死 false 后，探测不再说通（面板的「连通了」真的来自探测结果）', flipped.reachable === false);
}

rmSync(tmp, { recursive: true, force: true });

/* ══════════════════════════════════════════════════════════════════════════ *
 * [7] Host 接线
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[7] Host 接线');

const host = readFileSync(hostPath, 'utf8');
const speakAt = host.indexOf("if (rest === '/speak')");
const speakBlock = speakAt >= 0 ? host.slice(speakAt, speakAt + 6000) : '';

check('/speak 里有引擎分叉（useCustom）', /const useCustom = /.test(speakBlock));
check('分叉看的是 settings.engine，不是硬编码', speakBlock.includes("=== 'custom'"));
check('没填地址时**不走** custom（否则桌宠会突然哑掉）', speakBlock.includes("&& customEndpoint !== ''"));
check('overrideEngine 存在（试听能试还没保存的引擎）', speakBlock.includes('overrideEngine'));
check('overrideEndpoint 存在（试听能试还没保存的地址）', speakBlock.includes('overrideEndpoint'));
check('custom 分支调 synthesizeCustom', speakBlock.includes('synthesizeCustom('));
check('Edge 分支保持不变（走 loadTtsModule + synthesize）', speakBlock.includes('loadTtsModule()') && speakBlock.includes('tts.synthesize('));
check('响应带 engine 字段（渲染端才能把音源名字说准）', speakBlock.includes("engine: useCustom ? 'custom' : 'edge'"));
check('响应 mimeType 是动态的（自定义服务可能回 wav/ogg）', speakBlock.includes('mimeType: result.mimeType'));
check('/tts/check 路由存在', host.includes("rest === '/tts/check'"));
check('/tts/check 只收 POST', host.includes("if (rest === '/tts/check')") && host.slice(host.indexOf("rest === '/tts/check'"), host.indexOf("rest === '/tts/check'") + 400).includes("req.method !== 'POST'"));
check('/tts/check 用 probeCustomTts', host.includes('probeCustomTts('));
check('/tts/check 允许 endpoint 覆盖且不写盘', /endpoint: settings\.endpoint/.test(host) && host.includes('probeCustomTts({ endpoint })'));
check('/tts POST 拒绝坏地址（写配置时不能静默吞掉）', host.includes('normalizeEndpoint(payload.endpoint)'));
check('GET /tts 带 customReady（面板据此说「还不能用」）', host.includes('customReady:'));
check('GET /tts 带 endpointValid（区分「没填」与「填错了」）', host.includes('endpointValid:'));
check('GET /tts 带 defaultEngine', host.includes('defaultEngine: DEFAULT_ENGINE_ID'));
check('日志区分两种引擎（排障时一眼看出声音从哪来）', host.includes("${useCustom ? '自定义 TTS' : 'Edge-TTS'}"));

/* ══════════════════════════════════════════════════════════════════════════ *
 * [8] 客户端接线
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n[8] 客户端接线');

const client = readFileSync(clientPath, 'utf8');
const speech = readFileSync(speechPath, 'utf8');

check('面板有引擎下拉（data-role=tts-engine）', client.includes("'data-role': 'tts-engine'"));
check('面板有地址输入（data-role=tts-endpoint）', client.includes("'data-role': 'tts-endpoint'"));
check('面板有「测试连接」按钮（data-role=tts-probe）', client.includes("'data-role': 'tts-probe'"));
check('测试连接打的是 /tts/check（不是直接 fetch 用户地址 —— 那会被 CORS 拦）',
  client.includes('probeTtsEndpoint(') && /ROUTE_PREFIX\}\/tts\/check/.test(client));
check('选了 custom 时隐藏音色下拉（本地服务的音色由服务自己决定）', /isCustom\s*\?\s*null\s*:\s*h\(/.test(client));
check('保存时把 engine 与 endpoint 一起送', /engine,\s*endpoint: endpoint\.trim\(\)/.test(client.replace(/\s+/g, ' ')) || client.includes('endpoint: endpoint.trim()'));
check('切回 Edge 时不清掉地址（下次还想用）', /endpoint: endpoint\.trim\(\),\s*voice: isCustom \? undefined : targetVoice/.test(client.replace(/\r/g, '')) || client.includes('voice: isCustom ? undefined : targetVoice'));
check('试听自定义服务时不传 Edge 音色 id（免得服务莫名其妙收到 zh-CN-*）', client.includes("isCustom ? '' : targetVoice"));
check('试听带 engine/endpoint 覆盖（还没保存也能试）', /engine: 'custom', endpoint: endpoint\.trim\(\)/.test(client));
check('说话成功后按 engine 标音源（adapterId custom）', client.includes("data.engine === 'custom' ? { adapterId: 'custom' } : undefined"));
check('音源名字认识 custom', speech.includes("adapterId === 'custom'") && speech.includes('本地 TTS'));

/* ══════════════════════════════════════════════════════════════════════════ */

server.close();
await new Promise((done) => server.close(done));

console.log('');
console.log(`━━━ 自定义 TTS：${passed} 项通过 / ${failed} 项失败 ━━━`);
if (failed > 0) {
  console.log('❌ FAILED');
  process.exit(1);
}
console.log('✅ PASSED');
