/**
 * 「自定义 TTS 服务」客户端 —— 让桌宠用**你自己的声音**说话。
 *
 * ## 为什么要有它
 *
 * `edge-tts.js` 能换的是**在线音色**（晓晓 / 云希 …），换不了「某个特定的声音」。
 * 要用角色声线（或者任何你自己训好的声音），只有一条路：本地跑一个语音克隆
 * 模型（GPT-SoVITS / CosyVoice / IndexTTS …），让 Host 把文本发给它、把音频拿回来。
 * 这个模块就是那条「发过去、拿回来」的规范化实现 —— **不含任何模型**。
 *
 * ## 协议（用户自己的服务只要满足这一条就能接上）
 *
 * Host 发：
 *
 * ```
 * POST <ttsEndpoint>
 * content-type: application/json
 *
 * { "text": "要念的话", "voice": "…", "rate": "+0%", "pitch": "+0Hz", "format": "wav" }
 * ```
 *
 * Host 认三种回法，**满足其一即可**（越松越好接 —— 用户可能用别人的一键包，
 * 改不动它的响应形状）：
 *
 * 1. **裸音频**：响应体是 wav/mp3/ogg 字节，`content-type: audio/*`；
 * 2. **JSON + base64**：`{ "audioBase64": "…", "mimeType": "audio/wav" }`
 *    （键名也接受 `audio_base64` / `audio` / `data`）；
 * 3. **裸字节但 content-type 不老实**（`application/octet-stream`）：靠文件头
 *    嗅探，RIFF / ID3 / MP3 帧头 / OggS / fLaC 都认。
 *
 * 可选回：`durationSeconds`、`words`（词边界，供字幕逐词高亮；没有就不逐词）。
 *
 * ## 刻意不做的事
 *
 * - **不回退到 Edge-TTS**。用户选了自定义引擎就是不想听在线音色，静默换成晓晓
 *   会让他以为「克隆成功了但声音不对」，比报错难查得多。失败就是失败，
 *   `/speak` 会返回 502 + 具体原因，面板「测试连接」能当场看到。
 * - **不缓存音频**。Edge-TTS 那条有缓存是因为同一句话会被反复合成；自定义服务
 *   通常自带缓存，且本地推理不值得在 Host 里存第二份。
 * - **不做 SSRF 防护的地址白名单**。这是用户在自己机器上填自己的本地服务；
 *   限制成 127.0.0.1 反而会挡住「TTS 跑在另一台机器/局域网 GPU 上」这种正当用法。
 *   只限协议（http/https），因为 `file:` / `data:` 会让这段代码变成读文件的原语。
 *
 * 零 import：便于门禁直接 import 源码，也便于在别的宿主里复用。
 */

/**
 * 默认超时。本地模型**首次**调用要加载权重（实测 GPT-SoVITS v2 + CUDA：第一句 41 秒，
 * 之后 1 秒左右；CPU 上第一句更久）。60 秒会卡在边缘，所以给 120 秒 ——
 * 用户第一次试听时超时，看到的会是「服务 60 秒内没有响应」，而服务其实好好的。
 */
export const DEFAULT_CUSTOM_TTS_TIMEOUT_MS = 120_000;

/** 单次响应的体积上限。32MB ≈ 十分钟 44.1kHz 单声道 wav，远超一句话。 */
export const MAX_CUSTOM_TTS_BYTES = 32 * 1024 * 1024;

/** 探测连通性时的超时。探测只发一个 GET，不该等半分钟。 */
export const PROBE_TIMEOUT_MS = 4_000;

/** 错误响应体在 `detail` 里最多带多少字符（够看出服务说了什么，又不会淹掉日志）。 */
const MAX_DETAIL_CHARS = 300;

/**
 * 带错误码的错误。`/speak` 的 catch 用 `error.code` 当响应码，所以这里是契约的一部分。
 */
export class CustomTtsError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CustomTtsError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 校验用户填的地址。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, url: string } | { ok: false, code: string, message: string, detail: string }}
 */
export function normalizeEndpoint(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      code: 'E_TTS_ENDPOINT_EMPTY',
      message: '还没填自定义 TTS 服务的地址',
      detail: '例如 http://127.0.0.1:9880/tts',
    };
  }
  const text = raw.trim();
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    return {
      ok: false,
      code: 'E_TTS_ENDPOINT_INVALID',
      message: '地址不是合法的 URL',
      detail: `${text}（${String(error?.message ?? error)}）`,
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      code: 'E_TTS_ENDPOINT_INVALID',
      message: '地址只能用 http 或 https',
      detail: `收到的是 ${url.protocol}，例如 http://127.0.0.1:9880/tts`,
    };
  }
  return { ok: true, url: text };
}

/**
 * 按文件头判断音频格式。
 *
 * 为什么要嗅探而不是只信 `content-type`：一键包服务的响应头经常是
 * `application/octet-stream`，甚至 `text/plain`。只看头会把明明拿到的音频当失败。
 *
 * @param {Uint8Array} bytes
 * @returns {string | null} mime type；认不出返回 null
 */
export function sniffAudioMime(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  const at = (index) => bytes[index] ?? 0;
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));

  if (ascii(0, 4) === 'RIFF' && bytes.length >= 12 && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  // MP3 帧同步：11 个 1。别把 0xFF 0xFB 之类的常见 wav 字节误判 —— wav 已经在上面拦住了。
  if (at(0) === 0xff && (at(1) & 0xe0) === 0xe0) return 'audio/mpeg';
  // MP4/M4A：第 4 字节起是 'ftyp'。
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  return null;
}

/**
 * 从 wav 头算出时长（秒）。算不出来返回 null。
 *
 * 只解析 `fmt ` 与 `data` 两块，用「字节数 / 每秒字节数」算 —— 一句话的音频
 * 不可能带 4GB 的数据块，所以不必考虑流式 wav 的 `0xFFFFFFFF`。
 *
 * @param {Uint8Array} bytes
 * @returns {number | null}
 */
export function wavDurationSeconds(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44) return null;
  if (sniffAudioMime(bytes) !== 'audio/wav') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      byteRate = view.getUint32(body + 8, true);
    } else if (id === 'data') {
      const usable = Math.min(size, bytes.length - body);
      if (byteRate > 0) return usable / byteRate;
      return null;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/**
 * mp3 时长估算（只对第一帧是真帧的 CBR/VBR 有效，且只是估算）。
 *
 * 为什么不精确解析：mp3 里没有总时长字段，精确值要遍历所有帧。这个数字只用于
 * 日志与 `/status` 展示，不值得为它多花几毫秒。
 *
 * @param {Uint8Array} bytes
 * @returns {number | null}
 */
export function mp3DurationSeconds(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  // 常见比特率表（kbps），按 MPEG1 Layer3 的索引顺序。
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  let offset = 0;
  if (bytes.length > 10 && String.fromCharCode(...bytes.subarray(0, 3)) === 'ID3') {
    offset = 10 + ((bytes[6] & 0x7f) << 21) + ((bytes[7] & 0x7f) << 14) + ((bytes[8] & 0x7f) << 7) + (bytes[9] & 0x7f);
  }
  // 跳过一个 Xing/Info 帧（VBR）—— 它没有音频，按比特率算会偏大。
  if (offset + 4 <= bytes.length && String.fromCharCode(...bytes.subarray(offset, offset + 4)).startsWith('Xing')) {
    offset += 4;
  }
  if (offset + 4 > bytes.length) return null;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const kbps = bitrates[(b2 >> 4) & 0x0f];
  if (!kbps) return null;
  const sampleRateTable = [44100, 48000, 32000];
  const sampleRate = sampleRateTable[(b2 >> 2) & 0x03];
  if (!sampleRate) return null;
  const seconds = ((bytes.length - offset) * 8) / (kbps * 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** 从响应头里挑 content-type（有的 fetch 实现没有 headers.get）。 */
function readContentType(response) {
  const headers = response?.headers;
  if (headers === undefined || headers === null) return '';
  if (typeof headers.get === 'function') return String(headers.get('content-type') ?? '');
  if (typeof headers === 'object' && typeof headers['content-type'] === 'string') return headers['content-type'];
  return '';
}

/** 把服务返回的错误体压成一行，够看又不淹日志。 */
function shorten(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

/** 从 JSON 对象里取第一个非空字符串字段（宽松接别人的响应形状）。 */
function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/**
 * 调一次自定义 TTS 服务，拿回音频。
 *
 * @param {{
 *   text: string,
 *   endpoint: string,
 *   voice?: string,
 *   rate?: string,
 *   pitch?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   maxBytes?: number,
 * }} options
 * @returns {Promise<{ audio: Buffer, mimeType: string, durationSeconds: number, voice: string, words: Array<object>, cached: boolean, elapsedMs: number }>}
 */
export async function synthesizeCustom(options) {
  const text = typeof options?.text === 'string' ? options.text : '';
  if (text.trim() === '') {
    /*
     * 码名必须与 edge 那条路**一模一样**（`E_TTS_EMPTY_TEXT`，不是
     * `E_TTS_TEXT_EMPTY`）。
     *
     * 这里原来写成 `E_TTS_TEXT_EMPTY`，看着只是词序差别，后果却是真的：
     * `tts-adapters.js` 的 `NO_DEGRADE_CODES` 白名单里只有 edge 那个名字，
     * 于是同一个「文本是空的」在 edge 引擎下**不降级**、在自定义引擎下
     * 被判成「可以换引擎再试一次」，Host 转身用系统语音把一串空格念一遍。
     * 实测就是这么发声的：`degrade:"system"` +
     * 「Edge-TTS 用不了（E_TTS_TEXT_EMPTY），已换成系统语音。」
     * 也就是说——**调用方写错了参数，用户却听到机器音**。
     */
    throw new CustomTtsError('E_TTS_EMPTY_TEXT', '没有要念的内容', 'text 是空字符串');
  }

  const endpointResult = normalizeEndpoint(options?.endpoint);
  if (!endpointResult.ok) {
    throw new CustomTtsError(endpointResult.code, endpointResult.message, endpointResult.detail);
  }

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new CustomTtsError('E_TTS_NO_FETCH', '当前运行环境没有 fetch', '需要 Node 18+ 或 Electron 主进程');
  }

  const maxBytes = Number.isFinite(options?.maxBytes) ? options.maxBytes : MAX_CUSTOM_TTS_BYTES;
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : DEFAULT_CUSTOM_TTS_TIMEOUT_MS;
  const body = {
    text,
    voice: typeof options?.voice === 'string' ? options.voice : '',
    rate: typeof options?.rate === 'string' ? options.rate : '+0%',
    pitch: typeof options?.pitch === 'string' ? options.pitch : '+0Hz',
    format: 'wav',
  };

  /*
   * 音色包：**契约的加法扩展**，不是替换。
   *
   * 自定义 TTS 的 `voice` 只是一个自由字符串，而零样本克隆的音色其实由
   * 「参考音 + 这段参考音的逐字文本」决定。这两样属于我们这边的数据（用户在
   * 面板上挑的包），引擎不知道它存在，所以随请求一起递过去：
   *
   *   voiceProfile: { id, name, promptText, promptLang, textLang,
   *                   refAudioPath, refAudioSha256, refAudioBase64? }
   *
   * 老适配层读到不认识的字段会**忽略**（它们本来就只读 text/voice/rate），
   * 所以这个字段的存在不会让任何现有服务失效；认它的适配层（我们的
   * `tools/gptsovits-adapter.py`）才会用参考音覆盖自己的默认音色。
   *
   * 路径与 base64 同时给：同机适配层直接读文件（零拷贝），跨机/容器读不到
   * 路径时退回 base64（只在 ≤2MB 时附带，避免把每个请求撑到几 MB）。
   */
  if (options?.voiceProfile !== null && typeof options?.voiceProfile === 'object') {
    const profile = options.voiceProfile;
    body.voiceProfile = {
      id: typeof profile.id === 'string' ? profile.id : '',
      name: typeof profile.name === 'string' ? profile.name : '',
      promptText: typeof profile.promptText === 'string' ? profile.promptText : '',
      promptLang: typeof profile.promptLang === 'string' ? profile.promptLang : 'zh',
      textLang: typeof profile.textLang === 'string' ? profile.textLang : 'zh',
      refAudioPath: typeof profile.refAudioPath === 'string' ? profile.refAudioPath : '',
      refAudioSha256: typeof profile.refAudioSha256 === 'string' ? profile.refAudioSha256 : '',
      refAudioBase64: typeof profile.refAudioBase64 === 'string' ? profile.refAudioBase64 : '',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  let response;
  try {
    response = await fetchImpl(endpointResult.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/*, application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = controller.signal.aborted === true || error?.name === 'AbortError';
    if (aborted) {
      throw new CustomTtsError(
        'E_TTS_UPSTREAM_TIMEOUT',
        `自定义 TTS 服务 ${Math.round(timeoutMs / 1000)} 秒内没有响应`,
        `地址 ${endpointResult.url}；本地模型首次调用要加载权重，可在 ttsEndpoint 旁把超时调大`,
      );
    }
    throw new CustomTtsError(
      'E_TTS_UPSTREAM_UNREACHABLE',
      '连不上自定义 TTS 服务',
      `${endpointResult.url}（${String(error?.message ?? error)}）`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response.status !== 'number') {
    throw new CustomTtsError('E_TTS_UPSTREAM_BAD_RESPONSE', '自定义 TTS 服务没有返回响应', String(response));
  }

  if (response.ok !== true) {
    let detail = '';
    try {
      detail = typeof response.text === 'function' ? shorten(await response.text()) : '';
    } catch {
      detail = '';
    }
    /*
     * 4xx 和 5xx 要分开报，因为它们在「该不该换引擎」上是相反的意思：
     *   - 4xx = **服务看懂了这个请求，但拒绝执行**（文本超长、格式不认、鉴权不对）。
     *     换系统语音只会有两个结果：把请求错误藏起来，或者用机器音念出本该被拒的内容。
     *   - 5xx = 服务自己撞墙了（显存爆了、模型没加载），这才是真的「换个引擎再说一遍」。
     * 所以 4xx 给一个**不在降级白名单里**的码，5xx 保留原来的 `E_TTS_UPSTREAM_BAD_STATUS`。
     */
    const rejected = response.status >= 400 && response.status <= 499;
    throw new CustomTtsError(
      rejected ? 'E_TTS_UPSTREAM_BAD_REQUEST' : 'E_TTS_UPSTREAM_BAD_STATUS',
      `自定义 TTS 服务返回 HTTP ${response.status}`,
      detail === '' ? endpointResult.url : `${endpointResult.url} → ${detail}`,
    );
  }

  const contentType = readContentType(response).toLowerCase();
  const isJson = contentType.includes('json');

  let audioBytes;
  let mimeType = '';
  let durationSeconds = 0;
  let words = [];
  let serviceVoice = '';

  if (isJson) {
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new CustomTtsError('E_TTS_UPSTREAM_BAD_BODY', '自定义 TTS 服务的 JSON 解析失败', String(error?.message ?? error));
    }
    const encoded = pickString(payload, ['audioBase64', 'audio_base64', 'data'])
      || (typeof payload?.audio === 'string' ? payload.audio : '')
      || (typeof payload?.audio?.base64 === 'string' ? payload.audio.base64 : '');
    if (encoded === '') {
      throw new CustomTtsError(
        'E_TTS_UPSTREAM_NO_AUDIO',
        '自定义 TTS 服务的 JSON 里没有音频',
        `认的键：audioBase64 / audio_base64 / data / audio；收到的键：${Object.keys(payload ?? {}).join(', ') || '(空对象)'}`,
      );
    }
    audioBytes = Buffer.from(encoded, 'base64');
    mimeType = pickString(payload, ['mimeType', 'mime_type', 'contentType'])
      || pickString(payload?.audio, ['mimeType', 'mime_type'])
      || '';
    if (Number.isFinite(payload?.durationSeconds)) durationSeconds = payload.durationSeconds;
    else if (Number.isFinite(payload?.duration)) durationSeconds = payload.duration;
    if (Array.isArray(payload?.words)) words = payload.words;
    serviceVoice = pickString(payload, ['voice', 'speaker']);
  } else {
    const raw = await response.arrayBuffer();
    audioBytes = Buffer.from(raw);
  }

  if (audioBytes.length === 0) {
    throw new CustomTtsError('E_TTS_UPSTREAM_NO_AUDIO', '自定义 TTS 服务返回了 0 字节音频', endpointResult.url);
  }
  if (audioBytes.length > maxBytes) {
    throw new CustomTtsError(
      'E_TTS_UPSTREAM_TOO_LARGE',
      `自定义 TTS 服务返回的音频太大（${Math.round(audioBytes.length / 1024 / 1024)}MB）`,
      `上限 ${Math.round(maxBytes / 1024 / 1024)}MB；是不是把整段音频当一句话返回了？`,
    );
  }

  if (mimeType === '') {
    mimeType = sniffAudioMime(audioBytes) ?? '';
  }
  if (mimeType === '') {
    throw new CustomTtsError(
      'E_TTS_UPSTREAM_NOT_AUDIO',
      '自定义 TTS 服务返回的内容不是音频',
      `content-type 是 ${contentType || '(没给)'}，前 8 字节是 ${audioBytes.subarray(0, 8).toString('hex')}`,
    );
  }
  if (durationSeconds <= 0) {
    durationSeconds = wavDurationSeconds(audioBytes) ?? mp3DurationSeconds(audioBytes) ?? 0;
  }

  return {
    audio: audioBytes,
    mimeType,
    durationSeconds,
    voice: serviceVoice !== '' ? serviceVoice : (typeof options?.voice === 'string' && options.voice !== '' ? options.voice : 'custom'),
    words,
    cached: false,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 只探连通性，不合成（面板「测试连接」用它）。
 *
 * 成功判据是「**收到了 HTTP 响应**」，不是 2xx：本地服务常常只开了 POST，
 * GET 会回 405，那恰恰说明它在跑。没开、端口错了、被防火墙挡住才会拿不到响应。
 *
 * @param {{ endpoint: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, endpoint: string, reachable: boolean, status: number, contentType: string, elapsedMs: number, code?: string, message?: string }>}
 */
export async function probeCustomTts(options) {
  const endpointResult = normalizeEndpoint(options?.endpoint);
  if (!endpointResult.ok) {
    return {
      ok: false,
      endpoint: typeof options?.endpoint === 'string' ? options.endpoint : '',
      reachable: false,
      status: 0,
      contentType: '',
      elapsedMs: 0,
      code: endpointResult.code,
      message: `${endpointResult.message}：${endpointResult.detail}`,
    };
  }

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      endpoint: endpointResult.url,
      reachable: false,
      status: 0,
      contentType: '',
      elapsedMs: 0,
      code: 'E_TTS_NO_FETCH',
      message: '当前运行环境没有 fetch',
    };
  }

  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(endpointResult.url, { method: 'GET', signal: controller.signal });
    const contentType = readContentType(response);
    // 不读 body：探测只关心「有没有人应门」。
    try {
      if (typeof response?.body?.cancel === 'function') await response.body.cancel();
    } catch {
      // 取消失败不影响结论。
    }
    return {
      ok: true,
      endpoint: endpointResult.url,
      reachable: true,
      status: typeof response?.status === 'number' ? response.status : 0,
      contentType,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const aborted = controller.signal.aborted === true || error?.name === 'AbortError';
    return {
      ok: false,
      endpoint: endpointResult.url,
      reachable: false,
      status: 0,
      contentType: '',
      elapsedMs: Date.now() - started,
      code: aborted ? 'E_TTS_UPSTREAM_TIMEOUT' : 'E_TTS_UPSTREAM_UNREACHABLE',
      message: aborted
        ? `${Math.round(timeoutMs / 1000)} 秒内没有响应`
        : `${String(error?.message ?? error)}；确认服务在跑、端口对得上，且不是只监听 127.0.0.1 的另一台机器`,
    };
  } finally {
    clearTimeout(timer);
  }
}
