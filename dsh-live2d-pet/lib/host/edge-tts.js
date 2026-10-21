/**
 * Edge-TTS 适配器（Host 半区）。
 *
 * 这本来是 `tools/probe-edge-tts.mjs` 里的探针代码 —— 先用独立脚本把「这条路能用」
 * 证明成一条可重复执行的命令（P0 #6 门禁），再原样搬进来当生产代码。搬的时候
 * 只改了四件事，每一件都有具体理由：
 *
 *   1. **`ws` 改成惰性解析**。探针在顶层 `createRequire(...)('ws')`，脚本里没问题；
 *      但 Host 半区如果在**求值期**抛 `ERR_MODULE_NOT_FOUND`，整个插件 entry 就不会
 *      激活 —— 这正是客户端 bundle 白屏事故的同一个形状（见方案 §9.2）。所以解析
 *      推迟到第一次真正要合成的时候，失败也只影响这一次调用。
 *   2. **加了结果缓存**。同一句话被反复合成（调试、重复台词）不该反复打网络。
 *   3. **返回结构化结果**而不是 `console.log`。
 *   4. **超时/关闭/错误路径统一收敛**成一个 Promise，避免探针里那种「close 和
 *      turn.end 竞态」的写法被复制到生产。
 *
 * 协议上仍然照抄探针，那四条都是实测撞出来的坑，改任何一条都会 403 或零音频：
 *   - `Sec-MS-GEC` / `Sec-MS-GEC-Version` / `ConnectionId` 是 **URL 查询参数**，不是请求头
 *   - 令牌是 **v2** 格式 `<16位十六进制>-<64位十六进制>`
 *   - 必须带 `Cookie: muid=<32位大写十六进制>;`
 *   - 二进制帧是 `[2字节大端头长度][头文本][负载]`，负载从 `头长度 + 2` 开始
 *
 * @module dsh-live2d-pet/host/edge-tts
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { generateSecMsGecV2, generateMuid } from './edge-tts-drm.js';
import { MAX_TEXT_CHARS, readSpeechPitch, readSpeechRate, readVoiceName } from './actions.js';
/*
 * `sniffAudioMime` 住在自定义 TTS 那一侧（它本来就是为「拿到字节先验一遍」写的），
 * 零 import、无环，直接借来用。
 */
import { sniffAudioMime } from './custom-tts.js';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WSS_ENDPOINT =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const VOICE_LIST_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list' +
  `?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

/**
 * Chrome 大版本号必须与 `SEC_MS_GEC_VERSION` 里的一致。
 * 上游把 UA 和版本号绑在一起校验：UA 写着 Chrome/120 而令牌声明 2-143.x 会 403。
 */
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';

/**
 * 输出格式。
 *
 * 选 48kbps CBR 而不是更高码率有两个理由：一是上游只对这个格式做过时间戳偏移补偿，
 * 二是**它是 CBR**，所以「音频字节数 ÷ 6000」可以反推时长 —— 这条在没有解码器的
 * Host 侧是唯一能给出时长估计的办法。
 */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const CBR_BYTES_PER_SECOND = 48_000 / 8;

/** 元数据里的 Offset/Duration 单位是 100ns tick。 */
const TICKS_PER_SECOND = 10_000_000;

export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
export const DEFAULT_RATE = '+0%';
export const DEFAULT_PITCH = '+0Hz';

/*
 * `MAX_TEXT_CHARS` 从 `actions.js` 取，**本文件不再自己声明一份**。
 *
 * 这里原本写着 `export const MAX_TEXT_CHARS = 2000;` —— 与 `actions.js` 那份
 * 一模一样的名字、一模一样的值，各自被各自那一层用来拒绝超长文本：
 * `buildAction()` 拒一次（工具路径），`synthesize()` 再拒一次（`/speak` 路由）。
 *
 * 两份都写着 2000 的时候看不出任何问题，这正是它危险的地方：**同一个数字被
 * 写了两遍，而没有任何一处会因此报错**。某天把工具的上限放宽到 4000 会出现
 * 这样一条链：AI 收到「已排队」的成功回执 → 客户端拿这句去 POST `/speak`
 * → 这里按 2000 拒掉、而 `E_TTS_TEXT_TOO_LONG` 不在 `NO_DEGRADE_CODES` 里
 * 所以不降级 → **这句话一个字都没说出来**，用户看到的是一行「语音失败」，
 * 而 AI 那边记的是「成功」。
 *
 * 与 `lib/index.js` 顶部那段给 `MAX_ZIP_BYTES` 写的注释是同一条规则：
 * 上限从**定义处**直接取，转一道手就会出现「两边各自自洽的错位」。
 */

/** 缓存条数上限。一句话约 30–300 KB，留 24 条足够覆盖调试期的重复台词。 */
const CACHE_LIMIT = 24;

/** @type {Map<string, {audio: Buffer, words: Array, voice: string, cachedAt: number}>} */
const cache = new Map();

let wsModule = null;

/**
 * 惰性解析 `ws`。
 *
 * 用 `createRequire(import.meta.url)` 而不是 `import 'ws'`：插件以 `link:` 方式装进
 * profile，Node 按**真实路径**解析裸模块名，`import 'ws'` 会走到 profile 的
 * node_modules 里去（那里没有 ws），而 `createRequire` 从本文件出发，命中的是插件
 * 自己的 `node_modules/ws` —— 也就是 `npm install` 真正装进去的那份。
 */
function loadWebSocket() {
  if (wsModule !== null) return wsModule;
  try {
    const requireFromHere = createRequire(import.meta.url);
    wsModule = requireFromHere('ws');
    return wsModule;
  } catch (error) {
    throwWithCode(
      'E_WS_MISSING',
      'E_WS_MISSING: 找不到 ws 模块。Edge-TTS 需要它来发送自定义请求头 '
        + `（Node 内置 WebSocket 没有 headers 参数）。请在插件目录执行 npm install ws。原始错误：${error?.message ?? error}`,
    );
  }
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 造一个**带 `.code`** 的错误。
 *
 * 这个文件里每一个 `new Error(...)` 都出自这里 —— 这是一条被门禁
 * （`tools/test-edge-tts-ssml.mjs` 的 `[4]` 段）钉住的不变式，不是风格偏好。
 * 原因是 `lib/index.js` 的 `/speak` 路由用 `error?.code ?? 'E_TTS_FAILED'`
 * 决定回给客户端的错误码 —— 光秃秃的 `new Error('E_TTS_XXX: …')` 只有人话、
 * 没有 `.code`，于是详细的错误码会被抹成一个笼统的 `E_TTS_FAILED`，
 * 用户与日志都看不到真正的原因（`E_TTS_TIMEOUT` / `E_TTS_SOCKET` /
 * `E_TTS_CLOSED_EARLY` 三个码原来就是这么消失的）。
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** @param {string} code @param {string} message @returns {never} */
function throwWithCode(code, message) {
  throw codedError(code, message);
}

/**
 * 拼 SSML。
 *
 * ★ **四个插值全部要转义，一个都不能漏。**
 *
 * 这里原来只对 `text` 调了 `escapeXml()`，`voice` / `rate` / `pitch` 三个属性值
 * 是直接插进去的 —— 而它们被单引号包着，于是一个 `'` 就能提前闭合属性、把整段
 * SSML 变成畸形 XML。实测（`tools/_probe-speak.mjs`，已删）打真实服务：
 * `rate: "1'2"` / `rate: 'x<y'` / `rate: "x' volume='+100%'"` /
 * `voice: "zh-CN-XiaoxiaoNeural'"` 四个**全部 502 `E_TTS_FAILED`**，
 * 而正常的 `+10%` 是 200。也就是说：值里多一个引号，用户听到的是
 * 「她没有说话」，日志里写的是「语音服务出错了」—— 指向网络，与真正的原因无关。
 *
 * 转义之后这些值会被服务端当成**普通的属性内容**：`rate="1'2"` 是一个服务端
 * 不认识的语速，结果是「按默认语速念」，而不是整句话消失。配合
 * `synthesize()` 里的格式校验与 `actions.js` 的工具入口校验，三层各管一段：
 *   - 工具入口：当场告诉 LLM 格式不对（可自愈）；
 *   - `synthesize()`：直接 POST 到路由的那条路也能拿到可读的错误码；
 *   - 这里：**唯一真正的安全边界** —— 就算上面两层都被绕过，也拼不出畸形 XML。
 *
 * 导出是为了让 `tools/test-edge-tts-ssml.mjs` 能直接问它 —— 转义这件事
 * 只有把拼出来的字符串拿在手里看才验得了（合成一次要打网络）。
 */
export function buildSsml(text, voice, rate, pitch) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${escapeXml(voice)}'>` +
    `<prosody pitch='${escapeXml(pitch)}' rate='${escapeXml(rate)}' volume='+0%'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  );
}

/** 见文件头第 1 条：四个查询参数，一个都不能放进请求头。 */
function buildWssUrl(token, connectionId) {
  const query = new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    ConnectionId: connectionId,
    'Sec-MS-GEC': token,
    'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
  });
  return `${WSS_ENDPOINT}?${query.toString()}`;
}

/** MP3 帧同步字：判断拿到的字节像不像真的音频（服务端偶尔会回一段文本错误）。 */
export function looksLikeMp3(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  for (let i = 0; i < Math.min(buffer.length - 1, 4096); i += 1) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) return true;
  }
  return false;
}

/**
 * 单次合成（**不查缓存**）。上层 `synthesize` 负责缓存。
 *
 * @returns {Promise<{audio: Buffer, words: Array<{text: string, offsetSeconds: number, durationSeconds: number}>, connectionId: string}>}
 */
async function synthesizeOnce({ text, voice, rate, pitch, timeoutMs }) {
  const WebSocket = loadWebSocket();

  const token = generateSecMsGecV2();
  const muid = generateMuid();
  const connectionId = randomUUID().replace(/-/g, '');
  const requestId = randomUUID().replace(/-/g, '');

  const audioChunks = [];
  const words = [];
  let turnEnded = false;
  let failure = null;

  const socket = new WebSocket(buildWssUrl(token, connectionId), {
    headers: {
      'User-Agent': USER_AGENT,
      Origin: ORIGIN,
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: `muid=${muid};`,
    },
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    /*
     * ★ 下面三处抛出的错误必须带 `.code`。
     *
     * 这里抛出来的 `failure` **是给人看的整句话**（`E_TTS_SOCKET: …`），而
     * `lib/index.js` 的 `/speak` 路由读的是 `error.code ?? 'E_TTS_FAILED'` ——
     * 一个光秃秃的 `Error` 没有 `.code`，于是 `E_TTS_TIMEOUT` / `E_TTS_SOCKET` /
     * `E_TTS_CLOSED_EARLY` 三个码**永远到不了客户端**，全被抹成笼统的
     * `E_TTS_FAILED`。后果不是降级决策出错（`tts-adapters.js` 的
     * `isDegradable()` 是「白名单不降级、其余一律降级」，未知码照样降级），
     * 而是**排查时看不到真正的原因** —— 用户看到的只有「语音服务出错了」。
     */
    const failWith = (code, message) => {
      failure = message;
      settle(codedError(code, message));
    };

    const timer = setTimeout(() => {
      const message = failure ?? `E_TTS_TIMEOUT: 超时 ${timeoutMs}ms 仍未收到 turn.end`;
      try {
        socket.close();
      } catch {
        /* 已经关了就算了 */
      }
      failWith('E_TTS_TIMEOUT', message);
    }, timeoutMs);

    socket.on('open', () => {
      const config =
        `X-Timestamp:${new Date().toString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        });
      socket.send(config);

      const ssml =
        `X-RequestId:${requestId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${new Date().toString()}Z\r\n` +
        `Path:ssml\r\n\r\n` +
        buildSsml(text, voice, rate, pitch);
      socket.send(ssml);
    });

    socket.on('error', (error) => {
      failWith(
        'E_TTS_SOCKET',
        `E_TTS_SOCKET: ${error?.message ?? error}`
        + '（403/503 通常是 Sec-MS-GEC 失效，见 lib/host/edge-tts-drm.js）'
      );
    });

    socket.on('close', (code, reason) => {
      // turn.end 之后主动 close 也会走到这里，所以必须先看 turnEnded。
      if (turnEnded) return;
      failWith(
        'E_TTS_CLOSED_EARLY',
        `E_TTS_CLOSED_EARLY: 连接在 turn.end 之前关闭 code=${code} reason=${reason?.toString() || '(空)'}`
      );
    });

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        const textFrame = data.toString('utf8');
        const separator = textFrame.indexOf('\r\n\r\n');
        const headerText = separator >= 0 ? textFrame.slice(0, separator) : textFrame;
        const body = separator >= 0 ? textFrame.slice(separator + 4) : '';
        const path = /Path:([^\r\n]+)/.exec(headerText)?.[1]?.trim() ?? '';

        if (path === 'audio.metadata') {
          try {
            const parsed = JSON.parse(body);
            for (const item of parsed.Metadata ?? []) {
              if (item.Type !== 'WordBoundary') continue;
              words.push({
                text: item.Data.text.Text,
                offsetSeconds: item.Data.Offset / TICKS_PER_SECOND,
                durationSeconds: item.Data.Duration / TICKS_PER_SECOND,
              });
            }
          } catch {
            /* 元数据坏了不影响音频 —— 字幕没时间轴，但声音照出 */
          }
        } else if (path === 'turn.end') {
          turnEnded = true;
          try {
            socket.close();
          } catch {
            /* 忽略 */
          }
          settle(null);
        }
        return;
      }

      // 二进制帧：`[2字节大端头长度][头文本][负载]`。负载要从 headerLength + 2 开始 ——
      // 按文本帧那样找 `\r\n\r\n` 会一字节音频都拿不到，且不报错。
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buffer.length < 2) return;
      const headerLength = buffer.readUInt16BE(0);
      if (headerLength > buffer.length) return;
      const headerText = buffer.subarray(0, headerLength).toString('utf8');
      const path = /Path:([^\r\n]+)/.exec(headerText)?.[1]?.trim();
      if (path !== 'audio') return;
      audioChunks.push(buffer.subarray(headerLength + 2));
    });
  });

  const audio = Buffer.concat(audioChunks);
  if (audio.length === 0) {
    // `failure` 非空时说明这次失败上面已经定过码了，原样抛出去即可。
    throwWithCode('E_TTS_EMPTY_AUDIO', failure ?? 'E_TTS_EMPTY_AUDIO: 连接正常结束但没有拿到任何音频字节');
  }
  if (!looksLikeMp3(audio)) {
    throwWithCode('E_TTS_NOT_MP3', `E_TTS_NOT_MP3: 收到 ${audio.length} 字节但找不到 MP3 帧同步字`);
  }

  return { audio, words, connectionId };
}

/**
 * 合成一句话，带缓存。
 *
 * @param {object} options
 * @param {string} options.text      要念的文本
 * @param {string} [options.voice]   音色 ShortName
 * @param {string} [options.rate]    语速，如 '+10%'
 * @param {string} [options.pitch]   音高，如 '+0Hz'
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.noCache] 调试用：跳过缓存读写
 * @returns {Promise<{audio: Buffer, words: Array, voice: string, cached: boolean, durationSeconds: number}>}
 */
export async function synthesize(options) {
  const text = String(options?.text ?? '').trim();
  if (text === '') {
    throwWithCode('E_TTS_EMPTY_TEXT', 'E_TTS_EMPTY_TEXT: 文本为空');
  }
  if (text.length > MAX_TEXT_CHARS) {
    throwWithCode('E_TTS_TEXT_TOO_LONG', `E_TTS_TEXT_TOO_LONG: 文本 ${text.length} 字，上限 ${MAX_TEXT_CHARS} 字`);
  }

  /*
   * ★ 边界校验：这两个值（以及 pitch）**要插进 SSML 的 XML 属性**。
   *
   * `buildSsml()` 已经对它们做了 XML 转义（那是唯一真正的安全边界），但转义
   * 只能保证「拼得出合法 XML」，保证不了「服务端认得这个值」——`rate="1'2"` 转义
   * 之后是一个服务端不认识的语速，实测结果是 502，用户听到的是「她没说话」。
   * 所以在这里挡一道，给出**带错误码、能自愈**的失败。
   *
   * 位置很关键：**必须在开 socket 之前**。放到后面就等于先打一次网络、
   * 再回头说「参数不对」。
   *
   * 为什么这条路也需要（工具入口不是已经校验过了吗）：`/.dsh-live2d-pet/speak`
   * 是一条公开路由，可以绕过 `live2d_speak` 直接 POST 上来。
   */
  const badVoice = readVoiceName(options?.voice);
  if (!badVoice.ok) {
    throwWithCode('E_TTS_BAD_VOICE', `E_TTS_BAD_VOICE: ${badVoice.detail}`);
  }
  const badRate = readSpeechRate(options?.rate);
  if (!badRate.ok) {
    throwWithCode('E_TTS_BAD_RATE', `E_TTS_BAD_RATE: ${badRate.detail}`);
  }
  const badPitch = readSpeechPitch(options?.pitch);
  if (!badPitch.ok) {
    throwWithCode('E_TTS_BAD_PITCH', `E_TTS_BAD_PITCH: ${badPitch.detail}`);
  }

  const voice = options.voice || DEFAULT_VOICE;
  const rate = options.rate || DEFAULT_RATE;
  const pitch = options.pitch || DEFAULT_PITCH;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20_000;
  const key = `${voice}|${rate}|${pitch}|${text}`;

  if (options.noCache !== true) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      // 重新 set 一次：Map 保持插入序，这样就等价于 LRU 的「最近使用」。
      cache.delete(key);
      cache.set(key, hit);
      return { ...hit, cached: true };
    }
  }

  const { audio, words } = await synthesizeOnce({ text, voice, rate, pitch, timeoutMs });
  const entry = {
    audio,
    words,
    voice,
    /*
     * Edge-TTS 那条 WebSocket 回的是 MP3 —— 但**从字节里验一遍**再声明，
     * 而不是无条件写死：真出现 wav/ogg 的那天（换上游、或者代理插了一手），
     * 这里会跟着变，`/speak` 的日志与面板才说得准。
     *
     * 以前这里没有这个字段，`index.js` 却把它原样放进 JSON —— 于是
     * `mimeType` 一直是 `undefined`（序列化时整条键消失）。客户端不看它，
     * 所以真机上没人发现；是 `hostboot` 那条「声明 audio/mpeg」的断言先红的。
     */
    mimeType: sniffAudioMime(audio) ?? 'audio/mpeg',
    // CBR 反推：Host 侧没有 MP3 解码器，这是唯一能报出时长的办法。
    durationSeconds: audio.length / CBR_BYTES_PER_SECOND,
  };

  if (options.noCache !== true) {
    cache.set(key, entry);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  return { ...entry, cached: false };
}

/** 列音色。只用于诊断，不下发渲染进程。 */
export async function listVoices(localePrefix = 'zh') {
  const response = await fetch(VOICE_LIST_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) {
    throwWithCode('E_TTS_VOICE_LIST', `E_TTS_VOICE_LIST: HTTP ${response.status}`);
  }
  const voices = await response.json();
  return voices
    .filter((voice) => String(voice.Locale).startsWith(localePrefix))
    .map((voice) => ({
      shortName: voice.ShortName,
      gender: voice.Gender,
      locale: voice.Locale,
    }));
}

/** 缓存统计，给 `/status` 用。 */
export function cacheStats() {
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.audio.length;
  return { entries: cache.size, bytes, limit: CACHE_LIMIT };
}
