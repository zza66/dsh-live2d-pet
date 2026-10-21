/**
 * Edge-TTS 连通性门禁（P0 #6）。
 *
 * 为什么这件事必须最先做：Edge-TTS 是**非官方**接口，全靠一组浏览器指纹头 +
 * 一个时间相关的 `Sec-MS-GEC` 签名。它随时可能变，而一旦失效，"AI 说话 + 口型"
 * 整条链就没有音频源了。所以先用一个独立脚本把它验证成一条可重复执行的命令，
 * 再去写插件里的适配器。
 *
 * 用法：
 *   node tools/probe-edge-tts.mjs                        # 默认中文女声
 *   node tools/probe-edge-tts.mjs --voice zh-CN-XiaoxiaoNeural --text "你好"
 *   node tools/probe-edge-tts.mjs --list                 # 只列中文音色
 *
 * 退出码：0 = 拿到音频与词边界；1 = 失败。
 *
 * 协议要点（常量来自 edge-tts 项目，实测有效）：
 *   - WSS: wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
 *          ?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4
 *   - 必需头：Origin / User-Agent（Chromium 版本号要跟 Sec-MS-GEC-Version 一致）
 *             Sec-MS-GEC / Sec-MS-GEC-Version
 *   - 少 Sec-MS-GEC 会 403 或 503。
 *   - 输出格式 audio-24khz-48kbitrate-mono-mp3 是 **CBR 48kbps**，上游注释里明说
 *     时间戳按 CBR 换算做了偏移补偿。
 *   - 元数据里的 Offset/Duration 单位是 100ns tick（TICKS_PER_SECOND = 1e7）。
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSecMsGecV2, generateMuid } from '../dsh-live2d-pet/lib/host/edge-tts-drm.js';

/**
 * 用 `ws` 而不是 Node 内置的全局 WebSocket，理由是**内置的那个发不出请求头**：
 * WHATWG WebSocket 构造器没有 headers 参数，于是 `Sec-MS-GEC` / `Sec-MS-GEC-Version`
 * / `Origin` 全部丢失，服务端直接拒连（表现为 `WebSocket error`，看不出原因）。
 *
 * `ws` 从插件包自己的 node_modules 解析 —— 那正是插件 Host 半区运行时的解析路径，
 * 所以探针验证过的依赖关系与真实运行一致。
 */
const pluginRequire = createRequire(
  resolvePath(dirname(fileURLToPath(import.meta.url)), '../dsh-live2d-pet/package.json'),
);
const WebSocket = pluginRequire('ws');

/**
 * MUID：上游 edge-tts 的 `DRM.generate_muid()` = `secrets.token_hex(16).upper()`，
 * 即 32 个大写十六进制字符，通过 `Cookie: muid=<值>;` 发出。
 * 这是新增的一道校验 —— 不带头会拿到 403。
 */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WSS_ENDPOINT =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const VOICE_LIST_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list' +
  `?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0 Safari/537.36 ` +
  `Edg/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0`;
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const TICKS_PER_SECOND = 10_000_000;

/**
 * 握手地址。
 *
 * **关键点：`Sec-MS-GEC` 与 `Sec-MS-GEC-Version` 是 URL 查询参数，不是请求头。**
 * 早期版本把它们放在请求头里，现在这样做会直接 403 —— 这是本次排查中最费时间
 * 的一条，因为 403 的报错完全不提「你放错位置了」。
 * 另外 `ConnectionId` 也是必需的（上游用 `uuid.uuid4().hex`）。
 */
function buildWssUrl(token, connectionId) {
  const query = new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    ConnectionId: connectionId,
    'Sec-MS-GEC': token,
    'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
  });
  return `${WSS_ENDPOINT}?${query.toString()}`;
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text, voice, rate, pitch) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  );
}

function parseArgs(argv) {
  const options = {
    text: '你好，我是你的 Live2D 桌宠，现在正在测试语音合成。',
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+0%',
    pitch: '+0Hz',
    list: false,
    frames: false,
    timeoutMs: 20000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') options.list = true;
    else if (arg === '--frames') options.frames = true;
    else if (arg === '--text') options.text = argv[++i];
    else if (arg === '--voice') options.voice = argv[++i];
    else if (arg === '--rate') options.rate = argv[++i];
    else if (arg === '--pitch') options.pitch = argv[++i];
  }
  return options;
}

async function listVoices() {
  const response = await fetch(VOICE_LIST_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) {
    throw new Error(`voices/list HTTP ${response.status}`);
  }
  const voices = await response.json();
  const zh = voices.filter((voice) => String(voice.Locale).startsWith('zh'));
  console.log(`[1] 音色表 HTTP ${response.status}，共 ${voices.length} 个，其中中文 ${zh.length} 个：`);
  for (const voice of zh) {
    console.log(`      ${voice.ShortName}  ${voice.Gender}  ${voice.Locale}`);
  }
  return zh;
}

/**
 * 建连 → 发 speech.config → 发 ssml → 收音频与元数据。
 *
 * 返回 `{ audio: Buffer, metadata: Array, turnEnded: boolean }`。
 */
async function synthesize(options) {
  const token = generateSecMsGecV2();
  const muid = generateMuid();
  const connectionId = randomUUID().replace(/-/g, '');
  const requestId = randomUUID().replace(/-/g, '');

  const audioChunks = [];
  const metadata = [];
  const frameLog = [];
  let turnEnded = false;

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

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* 已经关了就算了 */
      }
      reject(new Error(`超时 ${options.timeoutMs}ms 仍未收到 turn.end`));
    }, options.timeoutMs);

    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    socket.on('open', () => {
      console.log(
        `[2] WSS 已连接（v2 令牌 ${token.slice(0, 16)}…，连接 id ${connectionId.slice(0, 8)}…）`,
      );

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
        buildSsml(options.text, options.voice, options.rate, options.pitch);
      socket.send(ssml);
      console.log(`[3] 已发送 speech.config + ssml（requestId=${requestId.slice(0, 8)}…，${options.text.length} 字）`);
    });

    socket.on('error', (error) => {
      finish(new Error(`WebSocket error：${error?.message ?? error}（403/503 通常是 Sec-MS-GEC 失效）`));
    });

    socket.on('close', (code, reason) => {
      if (!turnEnded) {
        finish(new Error(`连接在 turn.end 之前关闭：code=${code} reason=${reason?.toString() || '(空)'}`));
      }
    });

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString('utf8');
        const separator = text.indexOf('\r\n\r\n');
        const headerText = separator >= 0 ? text.slice(0, separator) : text;
        const body = separator >= 0 ? text.slice(separator + 4) : '';
        const path = /Path:([^\r\n]+)/.exec(headerText)?.[1]?.trim() ?? '(无 Path)';
        if (frameLog.length < 40) frameLog.push(`text  path=${path}  bytes=${text.length}`);

        if (path === 'audio.metadata') {
          try {
            const parsed = JSON.parse(body);
            for (const item of parsed.Metadata ?? []) {
              if (item.Type === 'WordBoundary') {
                metadata.push({
                  text: item.Data.text.Text,
                  offsetSeconds: item.Data.Offset / TICKS_PER_SECOND,
                  durationSeconds: item.Data.Duration / TICKS_PER_SECOND,
                });
              }
            }
          } catch {
            /* 元数据坏了不影响音频 */
          }
        } else if (path === 'turn.end') {
          turnEnded = true;
          try {
            socket.close();
          } catch {
            /* 忽略 */
          }
          finish(null);
        }
        return;
      }

      // 二进制帧的真实格式（和文本帧完全不一样，这一点极易踩坑）：
      //     [2 字节 大端 头长度][头文本（该长度）][负载]
      // 头文本里的第一「行」其实是那 2 个长度字节粘在 `X-RequestId:` 前面，
      // 上游 split_headers 也照拆不误 —— 无妨，我们只找 `Path:`。
      // 负载从 `headerLength + 2` 开始（长度前缀本身也要跳过）。
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buffer.length < 2) return;
      const headerLength = buffer.readUInt16BE(0);
      if (headerLength > buffer.length) {
        if (frameLog.length < 40) {
          frameLog.push(`bin   头长度越界 headerLength=${headerLength} bytes=${buffer.length}`);
        }
        return;
      }
      const headerText = buffer.subarray(0, headerLength).toString('utf8');
      const path = /Path:([^\r\n]+)/.exec(headerText)?.[1]?.trim();
      const payload = buffer.subarray(headerLength + 2);
      if (frameLog.length < 40) {
        frameLog.push(`bin   path=${path ?? '(无)'}  bytes=${buffer.length}  负载=${payload.length}`);
      }
      if (path !== 'audio') return;
      audioChunks.push(payload);
    });
  });

  await done;
  return { audio: Buffer.concat(audioChunks), metadata, requestId, frameLog };
}

/** MP3 里第一个帧同步字的位置，用来判断数据像不像真的 MP3。 */
function looksLikeMp3(buffer) {
  if (buffer.length < 4) return false;
  for (let i = 0; i < Math.min(buffer.length - 1, 4096); i += 1) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) return true;
  }
  return false;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    await listVoices();
    return;
  }

  console.log(`[0] 目标音色 ${options.voice}，输出格式 ${OUTPUT_FORMAT}`);
  const { audio, metadata, frameLog } = await synthesize(options);

  if (options.frames) {
    console.log(`[3.5] 收到的帧（前 ${frameLog.length} 条）：`);
    for (const line of frameLog) console.log(`      ${line}`);
  }

  const cbrBytesPerSecond = 48_000 / 8;
  const estimatedSeconds = cbrBytesPerSecond > 0 ? audio.length / cbrBytesPerSecond : 0;

  console.log(`[4] 收到音频 ${audio.length} 字节，MP3 帧同步字=${looksLikeMp3(audio) ? '有' : '无'}`);
  console.log(`    CBR 48kbps 反推时长约 ${estimatedSeconds.toFixed(3)} 秒`);
  console.log(`[5] 词边界 ${metadata.length} 条` + (metadata.length > 0 ? '：' : '（一条都没有 —— 字幕会没有时间轴）'));
  for (const item of metadata.slice(0, 12)) {
    console.log(
      `      ${item.offsetSeconds.toFixed(3)}s +${item.durationSeconds.toFixed(3)}s  ${JSON.stringify(item.text)}`,
    );
  }
  if (metadata.length > 12) {
    console.log(`      …还有 ${metadata.length - 12} 条`);
  }

  if (audio.length === 0) {
    throw new Error('没有拿到任何音频字节');
  }
  if (!looksLikeMp3(audio)) {
    throw new Error('收到的字节里找不到 MP3 帧同步字');
  }

  console.log('[6] EDGE-TTS GATE PASSED');
  console.log(
    `    注意：MP3 解码有 25–50ms 前导延迟，而上面 Offset 基于未压缩流 t=0。\n` +
      `    所以口型主通道要用解码后的 RMS 包络（自洽），词边界只喂字幕。`,
  );
}

main().catch((error) => {
  console.error(`[x] 失败：${error?.message ?? error}`);
  process.exitCode = 1;
});

