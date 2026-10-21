/**
 * dsh-live2d-pet — Host 半区（Node / 主进程侧）。
 *
 * 职责（与 Client 半区的分工是硬边界，见 §8 目录结构）：
 *   - HTTP 路由：把模型库里的文件按白名单喂给渲染进程（浏览器不能读本地磁盘）
 *   - 模型库扫描 / 校验 / 依赖解析（纯 IO + JSON，不需要 WebGL）
 *   - TTS 合成（网络访问 + 密钥保管，**绝不下发渲染进程**）
 *   - 向 Agent 注册 `live2d_*` 工具
 *
 * 不在这里做的事：渲染循环、参数仲裁、口型驱动。那三件事必须在 Client 半区
 * 同一线程同一时钟内完成，拆到 Host 会让口型抖动。
 *
 * @module dsh-live2d-pet
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 模型库体检器。
 *
 * 这里是**静态 import**，与其他 Host 模块（`./host/edge-tts.js` 走惰性）不同，
 * 理由是失败模式不一样：edge-tts 惰性化是因为它依赖 `ws`，而裸模块名可能解析不到
 * （插件以 `link:` 装进 profile，那条解析路径绕不过去）。`model-library.js`
 * **零外部依赖、只用 node: 内置模块**，那种失败模式在它身上不存在；
 * 它自己也有独立的门禁（`tools/test-model-library.mjs`）和 `simulate-host-boot.mjs`
 * 的导入检查兜着。改成惰性只会让 `/models` 多一层异步与状态，换不到安全性。
 */
import { libraryCacheStats, scanLibrary, summarizeLibrary } from './host/model-library.js';
import { importModelArchive } from './host/model-import.js';
/*
 * 语音库（磁盘侧）。
 *
 * 与 `voice-pack.js` 的分工是硬的：那边零 import、只认字符串；这边只做 IO。
 * 静态 import 的理由与 model-library 相同 —— 零外部依赖，那种「裸模块名解析不到」
 * 的失败模式在它身上不存在。
 */
import { resolveVoiceClip, scanVoiceLibrary } from './host/voice-library.js';
/*
 * 能力清单的归一化与文本生成。
 *
 * 这个模块还有第二个用处方：**客户端 bundle 也 import 它**（esbuild 直接内联）。
 * 这是刻意的 —— 清单的形状「AI 能控制什么」是 P2 与 P3 共同的冻结契约，两边
 * 各写一份实现迟早会理解成两种形状，而症状是「AI 说了个不存在的表情名」这种
 * 查起来很绕的问题。所以它被写成零依赖、不碰 node: 内置模块的纯 ESM，
 * 谁都能 import。见文件头那条硬约束。
 */
import {
  capabilitiesDigest,
  describeCapabilities,
  normalizeCapabilities,
  summarizeCapabilities,
} from './host/capabilities.js';
/*
 * TTS 适配器的降级策略。同样是与渲染端共用的零依赖纯 ESM —— 见该文件头。
 * 它只做判断，不做合成；`system` 那个适配器跑在浏览器里，Host 这边不存在。
 */
import { chooseAdapter, describeDegradation } from './host/tts-adapters.js';
/*
 * 自定义 TTS 服务（用户本地跑的语音克隆模型）。
 *
 * 它只做「发文本、收音频」，不含模型；协议写在 `custom-tts.js` 头部。
 * 单独一个模块而不是塞进 `edge-tts.js`：那条路要 WebSocket 与 SSML，
 * 这条路只是一次 HTTP POST，混在一起会让两条链路的错误码互相污染。
 */
import { DEFAULT_CUSTOM_TTS_TIMEOUT_MS, normalizeEndpoint, probeCustomTts, synthesizeCustom } from './host/custom-tts.js';
import { createVoicePackStore } from './host/voice-packs.js';
/*
 * 微动作（§13.26）：模型一导进来就自己长出来的一小套小动作。
 *
 * 生成与挑选是纯函数（`micro-motions.js`，只依赖 `capabilities.js` /
 * `emotions.js` 这两份同样纯的模块），落盘单独一层 —— 这样门禁能直接喂一份
 * 假 capabilities 进去，逐条断言「幅度不超量程 / 难过时不挑开心那条」，
 * 不需要 Cubism、不需要浏览器、也不需要磁盘。
 */
import {
  buildMicroMotionPack,
  buildMicroMotionView,
  describeMicroMotionPack,
  normalizeMicroMotionPack,
  normalizeMicroMotionStrength,
} from './host/micro-motions.js';
import { createMicroMotionStore, describeMicroMotionTime } from './host/micro-motion-library.js';
/*
 * 面板上的「和桌宠对话」（§13.36）。
 *
 * 这一层只记「谁说了什么、她那一句还没说」。把话送进会话（`sessionController`）
 * 与把她的回答落账（`live2d_speak` 入队时）都在 `apply()` 里 —— 那两件事都需要
 * `ctx`，而纯逻辑不该认识 `ctx`：这样「等多久算超时」「前缀长什么样」这类规则
 * 可以按毫秒推演，不需要起一个 Host。
 */
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
  recentChat,
  settleChatWait,
} from './host/pet-chat.js';
/*
 * 本地 TTS 的「一键」：探测 / 启动 / 停止。
 *
 * 与 `custom-tts.js` 的分界：那边只发文本、收音频，**不知道**模型装在哪；
 * 这边只管「把服务拉起来」，一次 HTTP 都不发。混在一起的后果是「探测安装目录」
 * 这种纯本地 IO 也要先过一遍网络层。
 */
import { createLocalTtsManager } from './host/local-tts.js';
/*
 * 上限从 `zip.js` 直接取，而不是让 `model-import.js` 转一道手：
 * 那个数字的**定义处**在 zip.js（它同时是 `E_ZIP_TOO_LARGE` 的判据），
 * 转一道手就会出现「路由说 192MB、解析器说 64MB」这种两边各自自洽的错位。
 */
import { MAX_ZIP_BYTES } from './host/zip.js';
import { actionSummary, buildAction, MAX_TEXT_CHARS, pruneQueue } from './host/actions.js';
import {
  EMOTION_MAX_HOLD_MS,
  ROLE_LABELS,
  ROLE_PARAMETER_IDS,
  canonicalEmotionName,
  emotionCatalogText,
  emotionNames,
  emotionRoleNames,
  normalizeEmotionBindings,
  pickRoleParameter,
} from './host/emotions.js';
import {
  describeStreamPlan,
  feedStream,
  createStreamBuffer,
  MAX_QUEUED_AUTO_EMOTIONS,
  MUTE_AFTER_EXPLICIT_EMOTION_MS,
  planStreamEmotion,
} from './host/emotion-stream.js';
/*
 * 关键词表的场景档（`coding` / `chat` / `story`）与用户追加。
 *
 * 从 `emotion-stream.js` 里搬出来的理由：那张表是**数据**，而「当前用哪一档、
 * 追加了哪些词、忽略了哪些词」是**配置解析**——两者混在判定模块里，判定就没法
 * 被单独断言（每加一个配置字段都要动判定）。
 */
import { describeKeywordTable, resolveKeywordTable, SCENE_NAMES } from './host/emotion-keywords.js';
import {
  advanceMood,
  createMood,
  describeMood,
  moodOnEmotion,
  moodOnTurnEnd,
  moodOnTurnStart,
  moodToIdle,
} from './host/mood.js';
import {
  createSpeechState,
  describeSpeech,
  mergeSpeechReport,
  parseSpeechQuery,
  SPEECH_CONTEXT_NAME,
  SPEECH_CONTEXT_ORDER,
  speechSummary,
} from './host/speech.js';
/*
 * 每个会话一条流缓冲，会话结束后**不删**（节流与「上一条是什么」要跨轮活着）。
 * 那就得有个上限：这个数是「同时记得多少个会话的脸」，不是「同时开多少个会话」，
 * 记不住的那些只是失去跨轮节流，不影响任何功能。
 */
const MAX_TRACKED_STREAMS = 128;
/*
 * `maxFps` 同样从定义处取：`normalizeFps()` 与它的三个边界住在一起，
 * 渲染端（`src/client/frame-budget.ts`）import 的是同一份。这里只负责
 * 「报进 `/status` 的数字一定是**能用的**那个数」，不负责决定帧率。
 */
import { normalizeFps } from './host/render-config.js';
import { mergeSettingBytes } from './host/vts-profile.js';
import { applySettingsPatch } from './host/settings-write.js';
/*
 * 「换音色」的数据层：音色清单、语速校验、`ttsVoice`/`ttsRate` 这一组扁平键的
 * 归一化。放在纯模块里是为了让**面板与 `/speak` 读到同一份默认值** ——
 * 两边各写一次「没配置就用晓晓」，迟早会出现「面板显示云希、念出来是晓晓」。
 */
import {
  DEFAULT_ENGINE_ID,
  DEFAULT_VOICE_ID,
  TTS_ENGINES,
  describeVoice,
  engineById,
  isVoiceShortName,
  normalizeRate,
  normalizeTtsSettings,
  voiceOptions,
} from './host/tts-voices.js';

/** Cordis 插件名。必须与 cordis.patch.yml 的 id、package.json 的 name 一致。 */
export const name = 'dsh-live2d-pet';

/**
 * 需要就绪后才能激活的 Host 服务。
 *
 * 这里只列**硬依赖**：`webServer` 用来给渲染进程喂模型文件，没有它这个插件没有意义。
 * `tools` 走 `ctx.get('tools')` 懒取——它晚一点就绪也不该把插件卡在 pending。
 */
export const inject = ['webServer'];

/**
 * 本插件**不导出 `Config` schema**，这是被运行环境逼出来的决定，不是偷懒：
 *
 * 插件是以 `link:` 方式装进 profile 的（源码留在工作区，改完重启即生效），
 * Node 会按**真实路径**解析裸模块名（即本文件所在目录），永远走不到 profile 的
 * `node_modules`。
 * 实测症状：`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
 * imported from …\lib\index.js`，loader 报 `dsh-live2d-pet (dsh-live2d-pet):
 * failed to import`，整个 entry 不激活。
 *
 * 因此 Host 半区**只用 node: 内置模块**（已安装的 dsh-plugin-whale-pet@0.2.9 的
 * `lib/index.js` 同样是零外部 import，是同一个约束的产物）。
 *
 * 配置照旧可用：cordis.patch.yml 里那一行的 `config:` 会原样传进 `apply(ctx, config)`。
 * 当前读取的键（都有默认值，见 apply）：
 *   modelsRoot: string  模型库根目录（默认见 resolveModelsRoot：配置 → 环境变量 →
 *                       settings.json → <DSH_HOME>/live2d-pet/models → 仓库自带 models-inbox）
 *   maxFps: number      渲染帧率上限，默认 60（合法区间见 host/render-config.js）
 *   enableAgentTools: boolean  是否注册 live2d_* 工具，默认 true
 */

/** 路由前缀。模型文件走这里，浏览器因此不需要任何本地文件系统权限。 */
const ROUTE_PREFIX = '/.dsh-live2d-pet';

/** 允许被浏览器取走的扩展名白名单——只放渲染必需的文件类型。 */
const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.exp3.json': 'application/json; charset=utf-8',
  '.motion3.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

/** 单文件上限：8192×8192 的 PNG 实测约 36 MB，留一倍余量。 */
const MAX_FILE_BYTES = 96 * 1024 * 1024;

/**
 * 单条语音上限。
 *
 * 32 MB 对一条**角色语音**来说是荒谬的上限（10 分钟的有声书大概 10 MB），
 * 它挡的不是正常人，而是「用户把整张专辑丢进包里、清单写错了 file」这种情况：
 * 没有这道线时，一次点播会把 Host 的内存和一次 JSON 响应同时推到几十 MB，
 * 而症状是**浏览器标签页直接卡死** —— 比报错难查得多。
 *
 * 超限不是静默跳过：`/voice` 回 413 并把真实体积报出来。
 */
const MAX_VOICE_CLIP_BYTES = 32 * 1024 * 1024;

/** 插件包根目录（本文件在 lib/ 下）。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Cubism Core 的存放处。
 *
 * Core 是 Live2D 株式会社的专有软件，但官方 `RedistributableFiles.txt` 明确把
 * `live2dcubismcore.min.js` 列为可再分发文件，所以它随插件走、离线也可用——
 * 这是与参考实现（运行时从 CDN 现拉）不同的取舍，换来的是「断网一样能跑」。
 */
const CORE_DIR = join(PACKAGE_ROOT, 'vendor', 'cubism');

/**
 * Framework 的 13 个 shader 源文件。
 *
 * 为什么必须由 Host 喂：Framework 的 `CubismShader_WebGL` 用 `fetch()` 按路径取
 * shader 文本（默认相对路径 `'../../Framework/Shaders/WebGL/'` 在插件里必然 404），
 * 只能由我们把 `setShaderPath()` 指到这里。
 */
const SHADER_DIR = join(PACKAGE_ROOT, 'shaders');

/** shader 文件名白名单：Framework 只会要这 13 个，没必要开放目录遍历。 */
const SHADER_NAME = /^[a-z0-9]+\.(vert|frag)$/;

export function apply(ctx, config) {
  const cfg = config ?? {};
  const log = (msg) => ctx.logger?.info?.(`[live2d] ${msg}`) ?? console.log(`[live2d] ${msg}`);

  const resolved = resolveModelsRoot(cfg);

  /** 模型库根目录：见 resolveModelsRoot 的优先级说明。 */
  const modelsRoot = resolved.path;

  /*
   * 语音库根目录。与模型库**各走一条独立的解析链**（同一个函数、同一个优先级），
   * 而不是共用 `modelsRoot` 的父目录：用户的语音包与实际模型不一定在同一个盘，
   * 而「语音放在模型库里」会让 `/models` 的递归扫描把几十条 mp3 当成噪声。
   */
  const resolvedVoices = resolveVoicesRoot(cfg);
  const voicesRoot = resolvedVoices.path;

  /*
   * 「本地 TTS 一键」的管理器：探测安装、拉起 API 与适配层、停止。
   *
   * 日志写到工作区的 `work/`（启动失败时用户唯一能看的东西）；那里不存在就退回
   * 插件包根 —— 插件被拷到别的机器上时，至少不会因为「目录不存在」而启动不了。
   * cwd 给工作区根：适配层脚本在 `../tools/` 下，它自己的留档目录也按工作区解析。
   */
  const workspaceRoot = resolve(PACKAGE_ROOT, '..');
  const localTts = createLocalTtsManager({
    packageRoot: PACKAGE_ROOT,
    logDir: existsSync(join(workspaceRoot, 'work')) ? join(workspaceRoot, 'work') : PACKAGE_ROOT,
    adapterCwd: workspaceRoot,
    /*
     * 「我起过什么」落在 settings 旁边（`<DSH_HOME>/live2d-pet/`）。
     *
     * 不落在这里的话，「停止」只认本进程内存，而 DSH 每改一次 Host 就重启一次 ——
     * 重启后它对着还在 9880 上听着的、自己拉起的引擎说「没有需要停的」（§13.24）。
     */
    statePath: join(dirname(String(resolved.settingsPath)), 'local-tts-processes.json'),
  });

  /*
   * 音色包（参考音 registry）的磁盘层。
   *
   * 放在 `<DSH_HOME>/live2d-pet/voice-packs`（与 `models`、`voices` 并列）：
   *   - 与 `settingsPath` 同一个家目录 —— 「谁在用哪个包」是偏好（存 settings），
   *     「包本身长什么样」是数据（存目录），两者分开才不会因为换用户而错位；
   *   - 刻意不用 cwd：插件被拷到别的机器、或从别的目录起 DSH，包不该跟着丢。
   */
  const voicePacks = createVoicePackStore({
    root: join(dirname(String(resolved.settingsPath)), 'voice-packs'),
  });

  /*
   * 微动作包（§13.26）。与 voice-packs 同一个家目录、同一个理由：
   * 「动作本身长什么样」是数据（存目录），「这个模型开哪几条、多大幅度」是偏好。
   * 分开之后，换一份 settings.json 不会把她的小动作一起弄丢。
   */
  const microMotionStore = createMicroMotionStore({
    root: join(dirname(String(resolved.settingsPath)), 'micro-motions'),
  });

  /**
   * 对话账本落在 settings.json **旁边**（§13.36）。
   *
   * 为什么不写进 settings.json：那是「配置」，每次面板保存都会被整份重写；
   * 而对话是**发生的事**，两边的写入频率差着两个数量级，混在一份文件里
   * 迟早会出现「保存音色把对话覆盖掉」这种事。和语音包、微动作包同一个理由。
   */
  const chatPath = join(dirname(String(resolved.settingsPath)), 'pet-chat.json');

  const state = {
    version: '0.1.0',
    modelsRoot,
    modelsRootExists: existsSync(modelsRoot),
    modelsRootSource: resolved.source,
    voicesRoot,
    voicesRootExists: existsSync(voicesRoot),
    voicesRootSource: resolvedVoices.source,
    settingsPath: resolved.settingsPath,
    /**
     * 语音库的最近一次使用记录（诊断用）。
     *
     * `/voices` 是「有没有配好」，这里记的是「有没有真的播出去」——
     * 用户说「点了没声音」时，这两个问题的答案完全不同：清单里有三条语音、
     * 但一次点播都没发生过，说明按钮那一侧没通；有过一次 200 却听不到，
     * 说明解码或播放那一侧。
     */
    voice: {
      lastAt: 0,
      lastPack: null,
      lastClip: null,
      lastBytes: 0,
      lastFallback: false,
      lastError: null,
      servedCount: 0,
      scannedAt: 0,
      scanSummary: null,
    },
    /*
     * 微动作的摘要（§13.26）。写完才填，`source` 记「这一份从哪来」：
     * `disk` = 上次生成好留在磁盘上的、`generated` = 这一次刚生成的、
     * `memory` = 落盘失败但仍在演、`none` = 这个模型长不出动作来。
     */
    microMotion: {
      model: '',
      source: 'none',
      generatedAt: 0,
      gestures: 0,
      enabled: 0,
      strength: normalizeMicroMotionStrength(undefined),
      summary: '',
      updatedAt: 0,
      lastError: null,
    },
    /*
     * 参数实测的结果（§13.34）。
     *
     * 微动作这一层一直在「按名字猜」哪些部位能动。灵梦那套模型把待机动作接在
     * `Param305…319` 这类自定义参数上，标准 `ParamAngle*` 在参数表里但骨架未必接，
     * 于是「眼睛动、头不动」。这一份是**渲染端实测**的产物：它把每根候选参数
     * 推到两端各画一帧、量像素差，把「写了会动」与「写了没反应」分开。
     *
     * `changed` 是「参与变化的像素比例」（0–1），Host 只按阈值用，不解释它。
     */
    bindingProbe: {
      model: '',
      at: 0,
      total: 0,
      bound: 0,
      results: [],
    },
    /*
     * 对话账本（§13.36）：面板上「和桌宠对话」的那一条线。
     *
     * 三个字段回答三个不同的问题：`items` 是「说过什么」、
     * `waitingSince/waitingText` 是「她那句还没说」、`transport` 是
     * 「这句话到底有没有真的进到会话里」。第三个最容易骗人 ——
     * 注入失败时面板照旧会把用户那句话写进账本，看起来像发出去了。
     */
    chat: createChatState(),
    chatTransport: {
      at: 0,
      ok: false,
      code: '',
      message: '',
      sessionId: '',
      injected: 0,
      failed: 0,
    },
    /*
     * 渲染帧率上限。**这一行的产物有两个读者**：`/status`（诊断面）
     * 与渲染端（真正的消费者 —— 它每帧问一次「到点了吗」）。
     *
     * 这里就夹取，而不是把原始配置原样报出去：`/status` 是**唯一**能看到
     * 这个值的地方，报 `0` 等于告诉用户「上限是 0fps」，而渲染端实际会用
     * 10。两个数字各自自洽，正是第八个缺陷的形状。
     */
    maxFps: normalizeFps(cfg.maxFps),
    /**
     * 最近一次**渲染进程自己**发来的心跳，用来显示「渲染端是否活着」。
     *
     * ★ 2026-06 更正：它以前在**每一个** `GET /status` 上刷新，包括 curl、
     * 门禁、我自己写的探针脚本、以及 `live2d_status` 这一次查询本身。于是
     * 「渲染端 在线」这句话在客户端早就死了的时候依然成立 —— 它是**测量的污染**，
     * 不是证据；而「渲染端到底活没活」正是排查卡死时第一个要问的问题。
     * 现在只认带了 `stage=`（新包）或 `build=`（旧包）的请求，见 `statusReads`。
     */
    lastClientSeenAt: 0,
    /** 任何一个 GET /status（含工具与脚本），只用于区分「没人在看」与「客户端没来」。 */
    lastStatusReadAt: 0,
    /**
     * `GET /status` 的来源计数。
     *
     * `total` 是所有读取；`fromClient` 是渲染进程（带 `stage=` 或 `build=`）；
     * `fromOther` 是脚本、门禁、工具查询。**这三个数放在一起才有意义**：
     * 只有 `fromOther` 涨而 `fromClient` 不动，说明「不是没人在看，是客户端没来」。
     */
    statusReads: { total: 0, fromClient: 0, fromOther: 0 },
    clientBuild: 'unknown',
    lastError: null,
    /** 渲染进程报上来的失败，最多留 20 条——浏览器 console 在没有 DevTools 时看不见。 */
    clientErrors: [],
    /**
     * 渲染端每次心跳带上来的「渲染舞台这会儿在不在」。
     *
     * ── 为什么需要一个单独的字段 ──────────────────────────────────────────
     *
     * 「她冻住了，而且一条记录都没有」查了三轮。五道护栏（`frame-live` /
     * `frame-blind` / `frame-frozen` / `frame-hidden` / `frame-nostart`）
     * 全都住在渲染舞台那个 effect 里，而那个 effect 的挂载是有条件的：
     * 面板一收起，客户端 JSX 里 `collapsed ? null : h(…, Live2DStage …)`
     * 就把整个舞台连同五道护栏一起卸载掉。
     *
     * 于是 **「面板收着」与「一切正常」在 `/status` 上是同一个样子**：
     * 都是零条 `frame-*`。这正是 §8.29 教训 2 说的一种结构性失明。
     *
     * 现在轮询那个 effect（与 `collapsed` 无关）把这件事编进查询串，
     * 这里只负责记下来 —— 于是「零条记录」终于能被拆成两种意思之一。
     *
     * `null` = 这个 Host 进程还从没收到过带 `stage` 的心跳（旧客户端）。
     */
    clientStage: null,
    /**
     * 上报通道自己的账本（跟着心跳回来，见 `/status` 里那段注释）。
     *
     * ── 为什么这张账本必须存在 ────────────────────────────────────────────
     *
     * 五轮里 `clientErrors` 一条浏览器发来的记录都没有，而我一直把它读成
     * 「护栏没说话」。真相是**通道根本没把话送到**：`clientStage` 走查询串、
     * 抵达了；`/capabilities` 走 fetch、抵达了；只有 `sendBeacon` 从来没有过。
     *
     * 一个诊断通道不能自己证明自己通 —— 它坏了的时候正是它最需要说话的时候。
     * 所以它的健康度只能由**另一条已知能通的通道**来背书，也就是这条心跳。
     *
     * `null` = 这个 Host 进程还从没收到过带账本的心跳（旧客户端）。
     */
    clientReport: null,
    /**
     * ★ 反向通道：她「开始说 / 说完了」的账本（D-2）。
     *
     * ── 它回答的那个问题 ─────────────────────────────────────────────────
     *
     * `live2d_speak` 是 fire-and-forget：工具返回「已排队」时那句话还没出声，
     * 更没念完。于是 AI 侧对朗读的认知只有「我刚排了一句」和「大概早念完了吧」
     * 两种，中间那段「她**正在**念」根本不存在 —— 而抢话、掐断、说完立刻甩头
     * 这三个毛病全都落在那一段里。
     *
     * 事实由渲染端的朗读通道登记（`src/client/speech-presence.ts`），
     * 搭 `/status` 心跳的查询串回来（那是唯一被证明能通的回程通道）。
     * 这里只负责记账与**判新鲜度**：标签页关掉时若她正在念，报告会永远停在
     * `speaking: true` 上，所以超过 `SPEECH_STALE_MS` 没有心跳就当作不知道。
     *
     * 账本由 `lib/host/speech.js` 的纯函数维护（那份文件同时决定这一行怎么
     * 写进提示词），这里只存结果。
     */
    speech: createSpeechState(),
    /**
     * 语音合成的最近一次结果。
     *
     * 放在 `state` 里而不是只写日志：TTS 是**联网 + 非官方接口**，出问题时
     * 「上一次是什么时候成功的、当时什么音色、失败原因是什么」是唯一能区分
     * 「密钥/签名失效」与「用户网络断了」的证据。
     */
    tts: {
      lastAt: 0,
      lastChars: 0,
      lastVoice: null,
      lastDurationSeconds: 0,
      lastCached: false,
      successCount: 0,
      failureCount: 0,
      lastError: null,
      /**
       * 上一次失败是否提示了「降级到系统语音」。诊断用：用户说「她突然变机器音了」时，
       * 这里能直接看出是不是 Edge-TTS 那一侧在失败。
       */
      lastDegrade: false,
    },
    /**
     * 上一次 `/models` 扫描的摘要（`null` = 还没扫过）。
     *
     * 刻意**不**在 `/status` 里现扫：那是每 5 秒一次的心跳，现扫等于每 5 秒
     * stat 几千次。这里存的是「上次看到的」，而要点是「模型库现在有几个、
     * 几个是坏的」在诊断时能立刻读到，不必再去打一次 `/models`。
     */
    library: null,
    /**
     * 导入诊断：最近一次 zip 导入的结果。
     *
     * 与 `tts` 同一个理由 —— 导入是这个插件里**唯一处理不可信输入**的功能，
     * 出问题时「上一次成功是什么时候、导入了什么、失败在哪个错误码」必须能
     * 一眼读到，否则用户只会说「导入没反应」。
     */
    lastImport: null,
    importCount: 0,
    importFailureCount: 0,
    /**
     * 当前模型能力清单的**摘要**（不是清单本身）。
     *
     * 清单本体存在闭包变量 `capabilities` 里，刻意不进 `state` —— `/status` 是
     * 每 5 秒一次的心跳，而一个真实模型的清单有 130+ 个参数（8KB 上下）。
     * 把它塞进心跳等于每 5 秒重新传一遍基本不变的东西。要清单就打 `/capabilities`。
     *
     * `capabilitiesDigest === null` 的意思是「还没有任何渲染进程报过」（页面没开、
     * 或者模型还没加载完），而不是「模型没有能力」—— 后者是报上来了一个空清单。
     * P3 的 AI 指令要靠这个区分来决定是「拒绝」还是「稍后再试」。
     */
    capabilitiesDigest: null,
    capabilitiesSummary: null,
    /**
     * 「清单为什么没了」—— 只有渲染端**主动清空**时才写（§13.25）。
     *
     * 它要解的那件事：`capabilities === null` 有两个完全不同的来因，而给用户的
     * 答复不该一样 ——
     *   · 「还没报过」（页面从没打开过）：等一会儿就有了；
     *   · 「舞台不在了」（面板收起 / 页面刷新 / 换装中）：现在**没有脸可动**，
     *     发过来的表情/动作会被 `E_ACTION_NO_CAPABILITIES` 拒绝，这是对的。
     * 所以这个字段只记后者的来因（渲染端 POST 的 `reason`），正常上报一份清单时清空。
     */
    capabilitiesClearedReason: null,
    activeModelId: '',
    /**
     * AI 指令队列的诊断面（P3）。
     *
     * 与 `tts` / `lastImport` 同一个理由：指令是「AI 让它做了什么」，出问题时
     * 「上一条是什么、什么时候、有没有被丢掉」是唯一能区分「AI 没发」
     * 与「发了但被 TTL 淘汰了」的证据。`droppedCount` 是累计值，
     * `lastDropped` 是本轮丢了几条。
     */
    commands: {
      queued: 0,
      lastAt: 0,
      lastKind: '',
      lastSummary: '',
      lastPriority: 0,
      lastTtlMs: 0,
      droppedCount: 0,
      lastDropped: 0,
    },
  };

  log(`Host 半区已加载  modelsRoot=${modelsRoot} (${resolved.source}) exists=${state.modelsRootExists}`);
  log(`               voicesRoot=${voicesRoot} (${resolvedVoices.source}) exists=${state.voicesRootExists}`);

  /*
   * 对话账本：把上一次（以及上一次重启前）说过的话读回来（§13.36）。
   *
   * 放在这里而不是第一次 GET /chat 时懒加载：`saveChat()` 是「整份覆盖」，
   * 如果面板在加载完成前就先发了一句，那份空账会把磁盘上的历史**整个抹掉**。
   * 一次同步读（几百条消息）换来「永远不会自伤」，值。
   */
  loadChat();

  /**
   * 当前模型的能力清单本体（`model:capabilities`，方案文档 §4.3）。
   *
   * 它是「AI 能控制什么」的唯一事实来源，而**只有客户端能产出它** ——
   * 参数要用 Cubism Core 枚举，Host 这边没有 Core。所以渲染进程在模型
   * 换装成功后 POST 上来，Host 存着，`live2d_status` 工具再把它带进会话。
   *
   * 为什么不放进 `state`：`/status` 是每 5 秒一次的心跳，而真实模型的清单有
   * 130+ 个参数。心跳只带摘要（`state.capabilitiesDigest` / `capabilitiesSummary`），
   * 要清单本体就打 `/capabilities`。
   */
  let capabilities = null;
  /** 上一次真正写进日志的能力清单指纹，用来压掉「同一只模型重报一遍」的重复日志。 */
  let lastLoggedCapabilitiesDigest = null;

  /**
   * 微动作当前状态的摘要（§13.26）。
   *
   * 只存摘要，包本身留在磁盘上：真实模型的包有十几条动作、每条几个参数，
   * 挂在 `state` 上会让 `/status` 那一次每 5 秒的序列化变重 —— 而心跳只需要
   * 回答「有没有、几条、什么模型」，需要本体就打 `/micro-motions`。
   */
  const microMotionView = (pack, source, extra = {}) => {
    /*
     * 视图的形状归 `buildMicroMotionView()` 管（§13.32 的真 bug 之后搬过去的）：
     * 这是**跨边界**的数据，手拼在这里就会漏字段，而漏掉的那个（`version`）
     * 正好是渲染端严格校验的那一个。这里只补 Host 自己的诊断字段
     * （`code` / `message` / `available`）并更新心跳摘要。
     */
    const view = buildMicroMotionView(pack, {
      ...extra,
      source,
      generatedAtText: describeMicroMotionTime(pack?.generatedAt ?? 0),
    });
    const enabled = view.gestures.filter((gesture) => gesture.enabled !== false).length;
    state.microMotion = {
      model: view.model,
      source,
      generatedAt: view.generatedAt,
      gestures: view.gestures.length,
      enabled,
      strength: view.strength,
      summary: view.summary,
      updatedAt: Date.now(),
      lastError: extra.code ?? null,
    };
    return view;
  };

  /**
   * 实测出来的「写了没反应」的参数（§13.34）。
   *
   * 只有拿着**这个模型**的实测结果才算数：换模型之后，旧的 id → changed 表
   * 可能对应完全不同的参数（不同作者的 `Param305` 不是一回事）。
   */
  function deadParametersFor(modelId) {
    const dead = new Set();
    const probe = state.bindingProbe;
    if (probe === null || typeof probe !== 'object') return dead;
    if (probe.model !== modelId || !Array.isArray(probe.results)) return dead;
    for (const item of probe.results) {
      if (item === null || typeof item !== 'object') continue;
      if (typeof item.id !== 'string' || item.id === '') continue;
      const changed = Number.isFinite(item.changed) ? item.changed : 1;
      /*
       * 阈值 0.01：渲染端按 48×48 采样（2304 个像素），1% 是 23 个像素。
       * 呼吸与眨眼在「两帧之间」通常改动不到这个量级，而有骨架绑定的参数
       * （哪怕只是 5 度的头）一动就是几十个百分点 —— 中间留得很开。
       */
      if (changed < 0.01) dead.add(item.id);
    }
    return dead;
  }

  /**
   * 保证「当前模型」有一份能用的微动作包（§13.26）。
   *
   * 顺序是「磁盘上那份 → 能不能对上这个模型 → 对不上就重生成」。判「对不上」用的是
   * 一条很实在的判据：包里写的参数 id，现在的模型还认不认得。换过模型文件（同一个
   * 目录名、不同的参数表）时，旧的包会写着已经不存在的参数，渲染端会静默跳过它们 ——
   * 表现成「一半动作不动了」，比整份失效更难查。
   *
   * @param {string} modelId
   * @param {{force?: boolean, capabilities?: object|null}} [options]
   */
  function ensureMicroMotions(modelId, options = {}) {
    const id = typeof modelId === 'string' && modelId !== ''
      ? modelId
      : (typeof state.activeModelId === 'string' ? state.activeModelId : '');
    if (id === '') {
      return {
        ok: false,
        code: 'E_MICRO_NO_MODEL',
        message: '还没有模型，先加载一个',
        // 「还没有模型」是**等一会儿就会变**的状态，面板据此自动重试。
        retryable: true,
        gestures: [],
      };
    }
    const caps = options.capabilities ?? capabilities;
    if (caps === null || typeof caps !== 'object') {
      return {
        ok: false,
        code: 'E_MICRO_NO_CAPABILITIES',
        message: '渲染端还没有上报能力清单，等模型加载完再试',
        retryable: true,
        model: id,
        gestures: [],
      };
    }

    const probeAt = state.bindingProbe?.model === id ? (Number(state.bindingProbe.at) || 0) : 0;
    if (options.force !== true) {
      const cached = microMotionStore.load(id);
      if (cached.ok === true) {
        const declaredIds = new Set((Array.isArray(caps.parameters) ? caps.parameters : [])
          .map((item) => (item !== null && typeof item === 'object' ? item.id : null)));
        /*
         * v2 的包把参数摊在 `parts[].params` 里（§13.32）。这里必须逐段看 ——
         * 早先只查 `gesture.params`，v2 之前那份写法会让每一条都「看着不 stale」，
         * 换过模型文件之后半边动作静默不动。
         */
        const stale = cached.pack.gestures.some((gesture) => (Array.isArray(gesture.parts) ? gesture.parts : [])
          .some((part) => Object.keys(part?.params ?? {}).some((paramId) => !declaredIds.has(paramId))));
        /*
         * 实测比包新 ⇒ 也要重生成（§13.34）。这是「先按名字猜、再按实测纠」那一拍的
         * 落点：包在实测回来之前就生成好了，里面还写着「写了没反应」的参数。
         */
        const probed = probeAt > (Number(cached.pack.probeAt) || 0);
        if (!stale && !probed) return microMotionView(cached.pack, 'disk');
        log(`微动作包与当前模型对不上（${stale ? '参数表变了' : '有了新的实测结果'}），重新生成：${id}`);
      }
    }

    const setting = resolveEmotionBindings(state.settingsPath);
    const pack = buildMicroMotionPack({
      capabilities: caps,
      bindings: setting.roles,
      model: id,
      name: id,
      now: Date.now(),
      /*
       * 实测判定「写了没反应」的参数，生成时当作「这个部位不存在」处理 ——
       * 于是 `MICRO_MOTION_ROLE_SUBSTITUTES` 会给它找替代部位，
       * 而不是让一整条动作在画面上什么都不发生。
       */
      deadParameters: deadParametersFor(id),
    });
    pack.probeAt = probeAt;
    if (pack.gestures.length === 0) {
      const view = microMotionView(null, 'none', {
        code: 'E_MICRO_NO_GESTURES',
        message: describeMicroMotionPack(pack),
        // 认不出角色是**模型本身**的事，重试一百次也一样 —— 别让面板空转。
        retryable: false,
        model: id,
        roles: pack.roles,
        missing: pack.missing,
      });
      return view;
    }
    const saved = microMotionStore.save(id, pack);
    if (saved.ok !== true) {
      /*
       * 存不下也照样能用：包先在内存里演，只是重启后没了。
       * 这一条不能变成失败 —— 磁盘满 / 目录只读的时候，用户没理由连小动作都看不到。
       */
      log(`微动作包落盘失败（仍会在本次运行里生效）：${saved.message}`);
      return microMotionView(pack, 'memory', { warning: saved.message });
    }
    log(`微动作已生成 ${id}：${pack.gestures.length} 条 / 认出 ${pack.roles.length} 个部位`
      + `${pack.missing.length > 0 ? ` / 这个模型没有 ${pack.missing.length} 个` : ''}`);
    return microMotionView(saved.pack, 'generated', { path: saved.path });
  }

  /**
   * 面板改的那几条：开关与强度（§13.26）。
   *
   * 只合并面板能改的字段，**不**让面板改写 `params` / 时长 —— 那是生成器的产物，
   * 面板改坏一条就等于让某个部位动到量程之外。要换一份就重新生成。
   */
  function patchMicroMotions(modelId, payload) {
    const id = typeof modelId === 'string' && modelId !== '' ? modelId : state.activeModelId;
    const loaded = microMotionStore.load(id);
    if (loaded.ok !== true) {
      return { ok: false, code: 'E_MICRO_NOT_FOUND', message: '这个模型还没有微动作包，先生成', model: id };
    }
    const pack = loaded.pack;
    if (payload?.strength !== undefined) pack.strength = normalizeMicroMotionStrength(payload.strength);
    /*
     * 两种形状都收：
     *   · `{ enabled: { id: true|false } }` —— 面板现在发的是这一种（一次改一条时
     *     不必把整张表重发一遍）；
     *   · `{ gestures: [{ id, enabled }] }` —— 更啰嗦的数组形状，留给脚本/门禁。
     * 只认这两个字段，`params` / 时长**一律不合并**（见上面的注释）。
     */
    if (payload?.enabled !== null && typeof payload?.enabled === 'object' && !Array.isArray(payload.enabled)) {
      for (const [gestureId, enabled] of Object.entries(payload.enabled)) {
        const gesture = pack.gestures.find((entry) => entry.id === gestureId);
        if (gesture === undefined || typeof enabled !== 'boolean') continue;
        gesture.enabled = enabled;
      }
    }
    const wanted = Array.isArray(payload?.gestures) ? payload.gestures : [];
    for (const item of wanted) {
      if (item === null || typeof item !== 'object' || typeof item.id !== 'string') continue;
      const gesture = pack.gestures.find((entry) => entry.id === item.id);
      if (gesture === undefined) continue;
      if (typeof item.enabled === 'boolean') gesture.enabled = item.enabled;
    }
    const saved = microMotionStore.save(id, pack);
    if (saved.ok !== true) return { ok: false, code: saved.code, message: saved.message, model: id };
    return microMotionView(saved.pack, 'disk');
  }

  /**
   * 「点名演一条」（§13.30）：面板的「试演」按钮与 `live2d_micro_motion` 工具共用。
   *
   * 三段职责，缺一段都会给出「看起来成功、其实没动」的结果：
   *  1. 先确认当前模型**有一份包**（没有就现生成）。包不存在时不能排队 ——
   *     渲染端是按 id 在自己那份包里查的，查不到就静默清空
   *     （`micro-motion.ts` 的「无包即清空」），用户按了按钮什么都不会发生；
   *  2. 按 id 找到那一条，找不到就把现有 id + 中文名一起回出去
   *     （§4.1 硬规则 2：错误必须可自愈，不能让调用方再猜一次）；
   *  3. 走正常的 `buildAction → pushCommand`，让「已排队 / 渲染端未连接」
   *     这些既有诊断照旧生效。Host 与浏览器之间只有轮询这一条路，
   *     绕开队列直接让渲染端演是做不到的。
   */
  /**
   * 渲染进程是否「在线」：最近 15 秒内来取过指令。
   *
   * 与 `registerTools()` 里那份同义（它也有一份局部箭头函数）。为什么不共用：
   * 那个函数在 `registerTools()` 的作用域里，`apply()` 这边看不见 —— 第一版
   * 直接写了 `rendererOnline()`，结果是 `ReferenceError` → 试演路由 HTTP 500
   * （§13.30 的门禁第一跑就是这么红的）。两处都只有一行，宁可各写一次。
   */
  function rendererOnlineFor(state) {
    return Date.now() - (Number(state?.lastClientSeenAt) || 0) < 15000;
  }

  function playMicroMotionById(id) {
    const wanted = typeof id === 'string' ? id.trim() : '';
    if (wanted === '') {
      return { ok: false, code: 'E_ACTION_BAD_VALUE', message: '没说要演哪一条（id 是空的）。' };
    }
    const view = ensureMicroMotions(state.activeModelId, {});
    if (view.ok !== true) {
      // 三个码原样带出去（`E_MICRO_NO_CAPABILITIES` 还是可重试的），
      // 只是把成功位翻成 false：调用方拿到的必须是「没演」。
      return { ...view, ok: false, id: wanted };
    }
    const gesture = view.gestures.find((entry) => entry !== null && typeof entry === 'object' && entry.id === wanted);
    if (gesture === undefined) {
      return {
        ok: false,
        code: 'E_MICRO_UNKNOWN_GESTURE',
        message: `这个模型的微动作里没有 ${JSON.stringify(wanted)}。`,
        id: wanted,
        available: view.gestures.map((entry) => ({ id: entry.id, label: entry.label })),
      };
    }
    const built = buildAction({ kind: 'microMotion', id: wanted }, capabilities);
    if (built.ok !== true) {
      return { ok: false, code: built.code, message: built.detail, id: wanted };
    }
    const pushed = pushCommand(built.command);
    return {
      ok: true,
      id: wanted,
      label: typeof gesture.label === 'string' ? gesture.label : wanted,
      // 关掉的条目**也允许点名演**：那是显式指令，不是自动播放。
      // 但要把「它本来是关着的」告诉调用方，否则用户会以为开关坏了。
      enabled: gesture.enabled !== false,
      queued: pushed.queued,
      dropped: pushed.dropped,
      rendererAlive: rendererOnlineFor(state),
    };
  }


  /*
   * ── 对话（§13.36） ───────────────────────────────────────────────────
   *
   * 三件事：读盘、把用户那句送进会话、把她的回答落账。
   *
   * 只有第二件依赖别的东西：`sessionController` 是可选的
   * （`ctx.get('sessionController')`）。没有它的时候面板必须能说
   * 「这个 Host 没有会话服务」，而不是看起来发出去了、其实谁也没收到 ——
   * 那正是这个插件反复踩过的「静默失效」。
   */

  function loadChat() {
    try {
      if (!existsSync(chatPath)) return;
      state.chat = normalizeChatState(JSON.parse(readFileSync(chatPath, 'utf8')));
    } catch (error) {
      log(`对话账本读不出来（按空账继续）：${error?.message ?? error}`);
    }
  }

  function saveChat() {
    try {
      mkdirSync(dirname(chatPath), { recursive: true });
      const body = JSON.stringify({
        version: state.chat.version,
        seq: state.chat.seq,
        items: state.chat.items,
        waitingSince: state.chat.waitingSince,
        waitingSeq: state.chat.waitingSeq,
        waitingText: state.chat.waitingText,
      });
      // 原子写（tmp + rename）：DSH 改一次 Host 就重启一次，写一半被杀会留下
      // 一份截断的 JSON —— 与微动作包同一个理由（§13.24）。
      writeFileSync(`${chatPath}.tmp`, body, 'utf8');
      renameSync(`${chatPath}.tmp`, chatPath);
      return null;
    } catch (error) {
      return String(error?.message ?? error);
    }
  }

  /** 会话服务的可选取用。没有就返回 null（面板据此显示「这个 Host 收不到话」）。 */
  function chatSessionService() {
    const service = typeof ctx.get === 'function' ? ctx.get('sessionController') : null;
    if (service === null || typeof service !== 'object') return null;
    if (typeof service.list !== 'function' || typeof service.prompt !== 'function') return null;
    return service;
  }

  function chatView(extra = {}) {
    const now = Date.now();
    const waiting = chatWaiting(state.chat, now);
    return {
      ok: true,
      seq: state.chat.seq,
      items: recentChat(state.chat, 40),
      waiting,
      waitingText: waiting ? state.chat.waitingText : '',
      summary: describeChat(state.chat, now),
      sessionId: state.chatTransport.sessionId,
      transport: { ...state.chatTransport },
      canInject: chatSessionService() !== null,
      ...extra,
    };
  }

  /**
   * 把一句用户的话送进**当前那个会话**。
   *
   * 选哪个会话：`sessionController.list()` 按活跃度排序，取第一条
   * 「能跑（agentAvailable）、不是空白会话」的；正在跑的那条优先 ——
   * 用户此刻正对着它说话，答案自然该出现在那里。
   *
   * 为什么用 `queue` 而不是 `steer`：`steer` 是「打断这一轮、改我说的」，
   * 用在聊天上会把正在做的事截断。聊天该排队。
   */
  async function injectChatPrompt(text) {
    const service = chatSessionService();
    if (service === null) {
      return {
        ok: false,
        code: 'E_CHAT_NO_SESSION_SERVICE',
        message: '这个 Host 没有会话服务（sessionController），她收不到这句话。',
      };
    }
    const controller = new AbortController();
    let chosen = null;
    try {
      const value = await service.list({}, controller.signal);
      const items = Array.isArray(value?.items) ? value.items : [];
      const usable = items.filter((item) => item !== null && typeof item === 'object'
        && item.agentAvailable !== false && item.blank !== true);
      chosen = usable.find((item) => item.running === true) ?? usable[0] ?? null;
    } catch (error) {
      return {
        ok: false,
        code: 'E_CHAT_SESSION_LIST_FAILED',
        message: `列会话失败：${error?.message ?? error}`,
      };
    }
    if (chosen === null) {
      return {
        ok: false,
        code: 'E_CHAT_NO_SESSION',
        message: '现在没有可以说话的会话（先开一个对话，再回来跟她说）。',
      };
    }
    const sessionId = typeof chosen.sessionId === 'string' ? chosen.sessionId : '';
    if (sessionId === '') {
      return { ok: false, code: 'E_CHAT_NO_SESSION', message: '会话服务没给出会话 id。' };
    }
    try {
      await service.prompt({
        requestId: `live2d-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: buildChatPrompt(text) }],
      }, controller.signal);
    } catch (error) {
      return {
        ok: false,
        code: typeof error?.code === 'string' ? error.code : 'E_CHAT_PROMPT_FAILED',
        message: `送进会话失败：${error?.message ?? error}`,
      };
    }
    return { ok: true, sessionId };
  }

  /** 面板按下发送：先落账（用户那句话不能丢），再谈送不送得进去。 */
  async function sendChat(rawText) {
    const text = normalizeChatText(rawText);
    if (text === '') {
      return { ok: false, code: 'E_CHAT_EMPTY', message: '这句话是空的。' };
    }
    const appended = appendChat(state.chat, { role: 'user', text, at: Date.now(), source: 'panel' });
    if (appended.item === null) {
      return { ok: false, code: 'E_CHAT_EMPTY', message: '这句话是空的。' };
    }
    state.chat = appended.chat;

    const injected = await injectChatPrompt(text);
    state.chatTransport = {
      at: Date.now(),
      ok: injected.ok === true,
      code: injected.ok === true ? '' : injected.code,
      message: injected.ok === true ? '' : injected.message,
      sessionId: injected.ok === true ? injected.sessionId : state.chatTransport.sessionId,
      injected: (Number(state.chatTransport?.injected) || 0) + (injected.ok === true ? 1 : 0),
      failed: (Number(state.chatTransport?.failed) || 0) + (injected.ok === true ? 0 : 1),
    };
    if (injected.ok === true) {
      state.chat = beginChatWait(state.chat, { seq: appended.item.seq, text, now: Date.now() });
    }
    const saved = saveChat();
    return {
      ok: true,
      item: appended.item,
      injected: injected.ok === true,
      code: injected.ok === true ? '' : injected.code,
      message: injected.ok === true ? '' : injected.message,
      sessionId: state.chatTransport.sessionId,
      saved: saved === null ? '' : saved,
    };
  }

  /**
   * 她说了（`live2d_speak` 入队的那一刻）。
   *
   * 为什么挂在入队而不是「播完」：Host 不知道播放进度（那条链在浏览器里），
   * 而入队是**唯一**一个「这句话确实要说了」的确定时刻。等她真的念完才落账，
   * 面板上会多出几秒空白；而少记一句不会造成错误的理解。
   */
  function noteChatSpoken(text) {
    const line = normalizeChatText(text);
    if (line === '') return false;
    if (!chatWaiting(state.chat, Date.now())) return false;
    const appended = appendChat(state.chat, { role: 'pet', text: line, at: Date.now(), source: 'speak' });
    if (appended.item === null) return false;
    state.chat = settleChatWait(appended.chat);
    saveChat();
    return true;
  }

  /**
   * 对话那一轮能点的动作清单（§13.36.8）。
   *
   * 只在「她真的在等回答」时才算（调用点先判 `chatWaiting`）：平时一个字节都不花，
   * 而清单本身是这个模型专属的 —— 动作组来自能力清单，微动作来自已经生成好的包，
   * 凭空写不出来，所以提示词那边只能由这里喂。
   */
  function chatStageHints() {
    const hints = { microMotions: '', motionGroups: '' };
    const caps = capabilities;
    if (caps !== null && typeof caps === 'object' && Array.isArray(caps.motionGroups)) {
      hints.motionGroups = caps.motionGroups
        .map((group) => (group !== null && typeof group === 'object'
          ? `${group.name}×${Number(group.count) || 0}`
          : null))
        .filter((line) => line !== null)
        .join('、');
    }
    const view = ensureMicroMotions(state.activeModelId, {});
    if (view.ok === true && Array.isArray(view.gestures)) {
      hints.microMotions = view.gestures
        .filter((gesture) => gesture !== null && typeof gesture === 'object' && gesture.enabled !== false)
        .map((gesture) => `${gesture.label}（${gesture.id}）`)
        .join('、');
    }
    return hints;
  }

  /**
   * Host → 渲染进程的单向指令队列。
   *
   * 上游是 Agent 工具（`live2d_*`）或路由；下游是渲染进程的 `/pending` 轮询。
   *
   * 队列里装的是 `lib/host/actions.js` 归一化过的 **ActionCommand**，不是原始工具参数。
   * 归一化在**入队之前**完成，理由是这个模块住在 Host 里而「模型有什么」的知识
   * 也住在 Host 里：等渲染端收到再判断，错误就只能在浏览器控制台里被看见，
   * 而 AI 那边已经拿到「成功」了 —— 那是最坏的一种失败。
   *
   * 裁剪（TTL 过期 + 数量上限）交给 `pruneQueue`，它是纯函数、有门禁。
   * 上限 8 条并**丢最旧的**：这是一条「说了就过期」的通道，当 Agent 连发十句话时，
   * 让桌宠念最后八句远比念最前面八句符合直觉。
   */
  const pendingCommands = [];
  const MAX_PENDING = 8;
  let commandSeq = 0;

  /**
   * @param {object} command 已归一化的指令（来自 `buildAction`）
   * @param {'tool'|'stream'} [origin] 这条指令是谁下的。
   *
   * ★ 来源要记在**队里那一份**上，因为 C 期的自动情绪需要数「队列里还压着几条
   * 我自己推的表情」来保护这条通道（`MAX_QUEUED_AUTO_EMOTIONS`）—— 数错了就会
   * 把 `live2d_speak` 这种真的要求她做事的指令挤出队列。
   */
  const pushCommand = (command, origin = 'tool') => {
    const now = Date.now();
    /*
     * 兼容垫片：`live2d_speak` 的命令**额外**带上旧客户端的字段。
     *
     * 为什么值得写：新的 Host 会在 DSH 重启后立刻生效，而浏览器里可能还跑着
     * 刷新前的旧 `client.js`（它只认 `{ kind: 'speak', text }`）。没有这个垫片，
     * 那段窗口里桌宠会**彻底不说话了**，而且不报任何错 —— 排查方向会跑到
     * TTS 上去。`motion` / `expression` 这些新指令旧客户端本来就不认识，
     * 忽略它们是正确行为，不需要垫片。
     *
     * 垫片必须加在**入队的那个对象**上，而不是返回给调用方的副本上 ——
     * 会被旧客户端读到的是队列里的这一份。
     */
    const legacy = command.kind === 'say'
      ? { kind: 'speak', text: command.payload.text, voice: command.payload.voice, rate: command.payload.rate }
      : {};
    const item = { id: ++commandSeq, command, at: now, origin, ...legacy };
    pendingCommands.push(item);

    const pruned = pruneQueue(pendingCommands, now, MAX_PENDING);
    pendingCommands.length = 0;
    pendingCommands.push(...pruned.kept);

    const dropped = pruned.expired.length + pruned.overflow.length;

    /*
     * 对话落账（§13.36）：她这句话确实要说了。
     *
     * 放在**剪枝之后**、用 `includes(item)` 再确认一次 —— 如果这一条当场
     * 就被挤掉（队列满了、或 ttl 已过），面板上不该出现一句她其实没说的话。
     * 这里只记文字，不记「播完」：播放进度在浏览器里，Host 拿不到。
     */
    if (command.kind === 'say'
      && typeof command.payload?.text === 'string'
      && pendingCommands.includes(item)) {
      noteChatSpoken(command.payload.text);
    }

    state.commands = {
      queued: pendingCommands.length,
      lastAt: now,
      lastKind: command.kind,
      lastSummary: actionSummary(command),
      lastPriority: command.priority,
      lastTtlMs: command.ttlMs,
      droppedCount: (state.commands?.droppedCount ?? 0) + dropped,
      lastDropped: dropped,
    };
    if (dropped > 0) {
      log(`[actions] 丢弃 ${dropped} 条指令（过期 ${pruned.expired.length} / 超出上限 ${pruned.overflow.length}）`);
    }

    return { item, queued: pendingCommands.length, dropped };
  };

  /**
   * 给渲染进程的模型清单（带体检结果）。
   *
   * 顺手把摘要写进 `state.library`，让 `/status` 能**免费**报出模型库状况 ——
   * `/status` 是每 5 秒一次的心跳，在那里做全量扫描等于每 5 秒 stat 三千次；
   * 而「上一次扫描看到了什么」对诊断来说已经够了。真正要新数据时客户端会打 `/models`。
   */
  const listModels = (force) => {
    const scan = scanLibrary(modelsRoot, { force });
    const summary = summarizeLibrary(scan);
    state.library = { ...summary, at: Date.now(), cache: libraryCacheStats() };
    return {
      ok: true,
      models: scan.models,
      rootExists: scan.rootExists,
      truncated: scan.truncated,
      summary,
      cache: state.library.cache,
    };
  };

  /**
   * 语音库清单。
   *
   * **每次现扫，不缓存**（与模型库相反）。理由写在 `voice-library.js` 文件头：
   * 这里的全部 IO 是「列目录 + 读一个小 json + stat 每个文件」，一个 500 条的包
   * 也就几毫秒；而用户的迭代方式是「改完 voices.json 立刻试听」—— 缓存只会让
   * 他看到旧清单，且这种过期**没有任何可见信号**。
   *
   * `defaultPack` 是「面板该默认选中哪个包」的唯一答案，规则在这里定死：
   * 清单里显式写 `"default": true` 的第一个 → 否则第一个可用的包 → 否则 null。
   * 让客户端自己挑会出现「两个包都写了 default，界面每次刷新选的不一样」。
   */
  const listVoices = () => {
    const scan = scanVoiceLibrary(voicesRoot, { canonicalEmotion: canonicalEmotionName });
    const explicit = scan.packs.find((pack) => pack.isDefault === true && pack.ok === true);
    const usable = scan.packs.find((pack) => pack.ok === true);
    state.voice.scannedAt = Date.now();
    state.voice.scanSummary = scan.summary;
    return {
      ok: true,
      root: voicesRoot,
      rootExists: scan.rootExists,
      rootSource: resolvedVoices.source,
      packs: scan.packs,
      summary: scan.summary,
      truncated: scan.truncated,
      durationMs: scan.durationMs,
      defaultPack: (explicit ?? usable)?.dirName ?? null,
      defaultIsExplicit: explicit !== undefined,
      error: scan.error ?? null,
    };
  };

  /**
   * 注册模型文件路由。
   *
   * 路径穿越防护是**必须的**：渲染进程能构造任意 URL，`..` 必须在这里被吃掉，
   * 否则整个磁盘都会变成可读资源。解析后强制校验仍在 modelsRoot 之内。
   */
  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length)) || '/';

      if (rest === '/status') {
        // 渲染进程把 bundle 的构建号带在查询串上：这样「浏览器有没有换上新的
        // client.js」在 Host 侧是可观测的，不必让用户开 DevTools 去确认。
        const build = url.searchParams.get('build');
        const stage = url.searchParams.get('stage');
        /*
         * ★ 心跳只认渲染进程真的发来的那一类请求。
         *
         * 判据：新包一定带 `stage=1|0`（舞台在不在），旧包至少带 `build=`；
         * curl / 门禁 / 探针脚本两个都不带。不带的那一类只进 `statusReads`，
         * 绝不刷新 `lastClientSeenAt` —— 否则「渲染端在线」会被自己的查询刷成真的。
         */
        const fromClient = stage === '0' || stage === '1'
          || (typeof build === 'string' && build !== '');
        state.statusReads.total += 1;
        state.lastStatusReadAt = Date.now();
        if (fromClient) {
          state.statusReads.fromClient += 1;
          state.lastClientSeenAt = Date.now();
        } else {
          state.statusReads.fromOther += 1;
        }
        if (typeof build === 'string' && build !== '') state.clientBuild = build;
        /*
         * ★ 「渲染舞台在不在」跟着心跳一起来。
         *
         * `stage` 缺省时**不动** `clientStage` —— 旧客户端不发这个参数，
         * 把它当成「舞台不在」会造出一个凭空的故障；保持原值（初次为 `null`）
         * 才是诚实的：不知道。
         *
         * `stage=1` 必须带上 `since` 之外的两个事实里的 `modelPath`：舞台在、
         * 但它上面那一只还没换上（`renderedPath` 为空）与「舞台在、正画着
         * miku」是两种需要区别对待的处境。
         */
        if (stage === '0' || stage === '1') {
          const model = url.searchParams.get('stageModel');
          const frames = Number(url.searchParams.get('stageFrames'));
          state.clientStage = {
            present: stage === '1',
            modelPath: typeof model === 'string' ? model : '',
            frames: Number.isFinite(frames) && frames >= 0 ? Math.floor(frames) : 0,
            at: Date.now(),
          };
        }
        /*
         * ★ 上报通道自己的账本，同样跟着心跳回来。
         *
         * 这一条的存在理由是个循环，必须说清楚：`/client-error` 那条通道坏掉的时候，
         * 恰恰是「它坏了」这件事最需要送到的时候 —— 而那时它送不到。
         * 所以账本只能走**另一条**通道，也就是这条心跳（已经不止一次证明它能通：
         * `clientStage` 就是这么抵达的，而五轮里 `sendBeacon` 一条都没抵达过）。
         *
         * `rFetchTry > 0 && rFetchOk === 0` 是「主路不通」；`rBeaconTry > 0` 是
         * 「退路被动用过」；`rMsg` 是最近一条上报的正文开头 —— 上报送不出去的时候，
         * 它就是我们唯一还能看见那条错误的窗口。
         */
        if (url.searchParams.has('rTotal')) {
          const num = (key) => {
            const value = Number(url.searchParams.get(key));
            return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
          };
          const sinceLast = state.clientReport === null
            ? 0
            : Math.max(0, num('rTotal') - state.clientReport.total);
          state.clientReport = {
            total: num('rTotal'),
            delivered: num('rOk'),
            failed: num('rFail'),
            fetchTried: num('rFetchTry'),
            fetchOk: num('rFetchOk'),
            beaconTried: num('rBeaconTry'),
            beaconOk: num('rBeaconOk'),
            lastScope: url.searchParams.get('rLast') ?? '',
            lastMessage: url.searchParams.get('rMsg') ?? '',
            lastAt: num('rAt'),
            /** 这一拍里**新**产生了多少条上报 —— 差分才能看出「此刻正在刷屏」。 */
            sinceLast,
            at: Date.now(),
          };
        }
        /*
         * ★ 反向通道：她「开始说 / 说完了」（D-2）。
         *
         * 与 `stage` 同一个规矩：**缺省时不动**。旧客户端不发这些字段，
         * 把它读成「她没在说话」会造出一个凭空的结论（AI 于是敢在她念的时候
         * 抢话，而真相是我们不知道）。`speech=0` 是「新客户端、还没念过」，
         * 那才是一次真实的报告。
         *
         * 过渡时刻一律记在**这里**（Host 的钟）：客户端报的 `Date.now()`
         * 跨机器没有意义，何况页面重载会让它跳。它只提供「状态变没变」与
         * 两个单调计数器，`mergeSpeechReport()` 负责把回退读成一次重载。
         */
        const speechReport = parseSpeechQuery(url.searchParams);
        if (speechReport !== null) {
          state.speech = mergeSpeechReport(state.speech, speechReport, Date.now());
        }
        /*
         * ★ 每次心跳都让状态追上时间：心跳是**唯一**随时都在跑的东西，所以
         * 「说完了之后过了多久」这件事只有在这里才看得见（见 `refreshMood`）。
         */
        refreshMood();
        return sendJson(res, 200, { ok: true, ...state });
      }

      /**
       * 渲染进程的失败上报口。
       *
       * 存在的理由很具体：client bundle 里的报错只出现在浏览器 console 里，而插件的
       * 调试期常常没有 DevTools。写进 Host 日志、`state.clientErrors`
       * （随 `/status` 一起出去），并由 `live2d_status` 的 `detail` 带进会话里 ——
       * 三处都要有，因为它要回答的那个问题（「她为什么不动了」）发生时，
       * 用户手边可能一个能看的地方都没有。
       */
      if (rest === '/client-error') {
        const body = await readBody(req);
        log(`[client-error] ${body || '(空请求体)'}`);
        state.lastError = body;
        state.clientErrors = [...state.clientErrors.slice(-19), body];
        return sendJson(res, 200, { ok: true });
      }

      /**
       * 模型能力清单（`model:capabilities`）。
       *
       * 方向是**渲染进程 → Host**，与 `/speak` 相反。理由：参数只能用 Cubism Core
       * 枚举，而 Core 只在浏览器里跑；Host 若自己解析 moc3 就等于把一套私有格式
       * 解析器再实现一遍，而且版本一升级就得跟着改。
       *
       * GET 拿当前的清单，POST 覆盖它。渲染进程在**每次换装成功后**都会 POST，
       * 所以这里存的就是「当前这只桌宠能做什么」，换模型时自动跟着变。
       */
      if (rest === '/capabilities') {
        if (req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            id: state.activeModelId,
            capabilities,
            digest: state.capabilitiesDigest,
            summary: state.capabilitiesSummary,
            /*
             * `null` 有两种来因，答复必须分开（§13.25）：
             * 「还没报过」是等一会儿就好；「舞台不在了」是现在真的没脸可动 ——
             * 后者若仍说「模型未加载完成」，AI 会以为再等等就行，然后一直发。
             */
            detail:
              capabilities === null
                ? (state.capabilitiesClearedReason === null
                  ? '当前模型能力：还没有读到（模型未加载完成，或者模型里没有任何表情 / 动作 / 参数）。'
                  : `当前模型能力：渲染端报告舞台不在了（${state.capabilitiesClearedReason}），现在没有脸可动 —— `
                    + '需要清单的指令会被 E_ACTION_NO_CAPABILITIES 拒绝，等模型重新挂上再试。')
                : describeCapabilities(capabilities),
          });
        }

        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 GET 或 POST', detail: req.method });
        }

        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, {
            code: 'E_BAD_JSON',
            message: '请求体不是合法 JSON',
            detail: String(error?.message ?? error),
          });
        }

        /*
         * ★ 显式清空：`{ capabilities: null, reason: 'stage-unmounted' }`（§13.25）。
         *
         * 为什么需要这一条：`capabilities` 以前**只增不减** —— 面板收起、页面刷新、
         * 换装途中，渲染端都没有模型可执行，而 Host 手里还留着上一次的清单，
         * 于是 `/pending` 里会推过去一条表情/动作，渲染端只能回
         * `E_ACTION_NO_MODEL`，真机 `clientErrors` 里就是这么留下一条的。
         *
         * 清空之后，`buildAction()` 会在 Host 侧就把需要清单的指令拒掉
         * （`E_ACTION_NO_CAPABILITIES`）—— 那条路**不产生假成功**，也不往渲染端扔垃圾。
         *
         * 必须写在归一化**之前**：`payload?.capabilities ?? payload` 对 `null` 会
         * 落到 `payload` 上，把一个清空请求归一化成一份空清单（等于「报了但什么都没」）。
         */
        if (payload !== null && typeof payload === 'object' && payload.capabilities === null) {
          const reason = typeof payload.reason === 'string' ? payload.reason.slice(0, 64) : '';
          const had = capabilities !== null;
          capabilities = null;
          state.capabilitiesDigest = null;
          state.capabilitiesSummary = null;
          state.capabilitiesClearedReason = reason === '' ? '未说明原因' : reason;
          if (had) {
            log(`能力清单已清空（${state.capabilitiesClearedReason}）—— 需要清单的指令现在会被拒绝`);
          }
          return sendJson(res, 200, {
            ok: true,
            id: state.activeModelId,
            digest: null,
            summary: null,
            cleared: true,
            reason: state.capabilitiesClearedReason,
          });
        }

        /*
         * 用 Host 侧的归一化器而不是直接存 `payload` —— 这是从渲染进程来的数据，
         * 而这个插件已经有过一次「客户端抛错拖着整个外壳一起死」的事故（§9.2），
         * 所以凡是进 Host 的外部数据都先过一道形状归一化：坏字段被丢掉，
         * 而不是让 `undefined` 一路渗到 system prompt 里。
         *
         * 归一化器与客户端用的是**同一个模块**（客户端 bundle 直接内联它），
         * 所以两边对「清单长什么样」不可能产生不同理解。门禁里有一条恒等式
         * 断言钉着这件事：`normalize(build(x))` 必须逐字段等于 `build(x)`。
         */
        const normalised = normalizeCapabilities(payload?.capabilities ?? payload);
        const id = typeof payload?.id === 'string' && payload.id !== '' ? payload.id : state.activeModelId;
        const digest = capabilitiesDigest(normalised);
        const summary = summarizeCapabilities(normalised);

        capabilities = normalised;
        state.capabilitiesDigest = digest;
        state.capabilitiesSummary = summary;
        // 新清单一到，「舞台不在了」那句话就作废了（§13.25）。
        state.capabilitiesClearedReason = null;
        state.activeModelId = id;

        /*
         * 新模型一到就顺手把微动作准备好（§13.26）——「导入之后它自己就会」的落点。
         *
         * 放在这里而不是等面板打开再生成：生成需要能力清单，而清单只有这一刻在手上。
         * 失败**不能**影响清单本身（清单是命脉，微动作是加分项），所以吞掉异常只记日志；
         * 面板打开时还会再试一次，那时会看到 `E_MICRO_NO_*` 的原因。
         */
        try {
          ensureMicroMotions(id, { capabilities: normalised });
        } catch (error) {
          log(`微动作生成失败（不影响能力清单）：${error?.message ?? error}`);
        }

        // 只在指纹变化时打日志：换装会重报一次，而「同一只模型报了两遍同样的清单」
        // 不该在日志里占两行 —— 日志要留给真正变化的事件。
        if (digest !== lastLoggedCapabilitiesDigest) {
          lastLoggedCapabilitiesDigest = digest;
          log(`能力清单已更新 ${id || '(未知模型)'} ${digest}  ${summary}`);
        }

        /*
         * 这份清单**已经有实测结果**了吗（§13.37）？有就告诉渲染端别再测一遍：
         * 实测会把每根参数推来推去（那是画面的抽搐），页面刷新时重测一遍没有新信息。
         *
         * 判据是「模型 + 清单指纹」都要对上 —— 只对模型名会让「换了同一只模型的
         * 另一个版本」拿着旧结论跑（参数表可能已经变了）。
         */
        const probeFresh = state.bindingProbe !== null
          && typeof state.bindingProbe === 'object'
          && state.bindingProbe.model === id
          && typeof state.bindingProbe.digest === 'string'
          && state.bindingProbe.digest === digest;

        return sendJson(res, 200, { ok: true, id, digest, summary, probeFresh });
      }

      /**
       * 语音合成。
       *
       * 为什么走 Host 而不是让渲染进程直连：Edge-TTS 是**非官方**接口，靠一组
       * 浏览器指纹头 + 时间签名握手。签名算法与常量都属于「随时会被改」的东西，
       * 必须集中在一处，改一次就够；散在渲染进程里意味着每次改动都要重新构建、
       * 重新加载 bundle，而且渲染进程改坏了会拖垮整个界面（见 §9.2）。
       *
       * 方法限定 POST，且**不把文本放进查询串**：文本会进 Host 日志、也会留在
       * 浏览器历史里，而用户可能让桌宠念一些不该出现在那里的东西。
       */
      if (rest === '/speak') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
        }

        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, {
            code: 'E_BAD_JSON',
            message: '请求体不是合法 JSON',
            detail: String(error?.message ?? error),
          });
        }

        const text = typeof payload?.text === 'string' ? payload.text : '';
        try {
          /*
           * ★ 调用方没指定音色时用**用户存的偏好**，而不是永远用晓晓。
           *
           * 这一行就是「换音色」真正生效的地方：在它之前，`voice` 只能由调用方给
           * （`live2d_speak({voice})`），而 AI 从来不会主动给 —— 于是面板上选什么都
           * 改变不了声音。优先级刻意是「本次调用 > 用户偏好 > 内置默认」：
           * AI 点一句特定音色的台词仍然能压过偏好，但日常说话跟着用户走。
           */
          const ttsSettings = resolveTtsSettings(state.settingsPath);
          const requestedVoice = typeof payload?.voice === 'string' && payload.voice.trim() !== ''
            ? payload.voice.trim()
            : ttsSettings.voice;
          const requestedRate = typeof payload?.rate === 'string' && payload.rate.trim() !== ''
            ? payload.rate.trim()
            : ttsSettings.rate;
          const started = Date.now();

          /*
           * 试听要能用**还没保存**的引擎与地址（面板上挑了但没点保存）。
           *
           * 只允许覆盖引擎与地址，不覆盖音色/语速 —— 那两个本来就有「本次调用优先」
           * 的语义，再加一层 `override` 会有两种写法干同一件事。
           */
          const overrideEngine = typeof payload?.engine === 'string' ? payload.engine.trim() : '';
          const overrideEndpoint = typeof payload?.endpoint === 'string' ? payload.endpoint.trim() : '';
          const customEndpoint = overrideEndpoint !== '' ? overrideEndpoint : ttsSettings.endpoint;

          /*
           * ★ 引擎分叉：内置 Edge-TTS 还是用户自己的服务。
           *
           * `custom` 只在**真的填了地址**时才走：`normalizeTtsSettings()` 已经对
           * 「选了 custom 但没填地址」留了 notes 并退回 edge，这里再判一次是因为
           * 用户可能手改文件把 endpoint 删了 —— 那种情况宁可继续用 Edge 出声，
           * 也不要让桌宠突然哑掉。
           *
           * 失败时**不退回 Edge-TTS**，但会按 §6.1 #8 的既有策略降级到
           * **浏览器自带的系统语音**（`degrade: 'system'`，渲染端会显示一行原因）。
           * 两者不是一回事：用户选本地服务多半就是不想听在线音色，所以绝不偷偷
           * 换回 Edge；但「什么都不响」比「机器音 + 一行解释」更糟，那是这条降级
           * 策略从一开始就定下的取舍（`tts-adapters.js` 的 `isDegradable` 是白名单：
           * 只有调用方写错了参数才不降级）。
           */
          const useCustom = (overrideEngine !== '' ? overrideEngine : ttsSettings.engine) === 'custom'
            && customEndpoint !== '';
          const tts = useCustom ? null : await loadTtsModule();
          /*
           * 音色包只有在自定义引擎下才有意义（Edge 用的是 ShortName，不认识参考音）。
           * 取不到包（被删了、清单坏了）时**不报错**：退回适配层自己的默认音色，
           * 桌宠继续能说话 —— 一个坏掉的音色包不该让她哑掉。
           */
          const voiceProfile = useCustom && ttsSettings.voicePack !== ''
            ? voicePacks.voiceProfile(ttsSettings.voicePack)
            : null;
          const result = useCustom
            ? await synthesizeCustom({
              text,
              endpoint: customEndpoint,
              voice: requestedVoice,
              rate: requestedRate,
              pitch: typeof payload?.pitch === 'string' ? payload.pitch : undefined,
              voiceProfile,
              timeoutMs: Number.isFinite(payload?.timeoutMs) ? payload.timeoutMs : DEFAULT_CUSTOM_TTS_TIMEOUT_MS,
            })
            : await tts.synthesize({
              text,
              voice: requestedVoice,
              rate: requestedRate,
              pitch: typeof payload?.pitch === 'string' ? payload.pitch : undefined,
              timeoutMs: Number.isFinite(payload?.timeoutMs) ? payload.timeoutMs : undefined,
            });

          state.tts.lastAt = Date.now();
          state.tts.lastChars = text.length;
          state.tts.lastVoice = result.voice;
          state.tts.lastDurationSeconds = result.durationSeconds;
          state.tts.lastCached = result.cached;
          state.tts.lastError = null;
          state.tts.successCount += 1;
          log(
            `[speak] ${text.length} 字 → ${result.audio.length} 字节 ${result.mimeType} / `
            + `${result.durationSeconds.toFixed(2)}s / ${result.words.length} 词边界 / `
            + `${Date.now() - started}ms${result.cached ? '（缓存）' : ''} / `
            + `${useCustom ? '自定义 TTS' : 'Edge-TTS'} / ${result.voice}`,
          );

          /**
           * 用 base64 装进 JSON，而不是直接把 MP3 当响应体。
           *
           * 代价是 +33% 体积，换来的是**一次往返同时拿到音频与词边界**（字幕要用），
           * 且渲染进程侧不必处理「响应头里塞 JSON」这种脆弱做法。一句话的音频
           * 通常几十到几百 KB，这个代价换得回来。
           *
           * `mimeType` 现在是动态的：自定义服务可能回 wav/ogg，客户端不看它
           * （`decodeAudioData` 直接吃字节），但日志和面板要能说出拿到的到底是什么。
           * `engine` 让渲染端把音源名字说得准（`engineLabel()` 认 `custom`）。
           */
          return sendJson(res, 200, {
            ok: true,
            mimeType: result.mimeType,
            encoding: 'base64',
            engine: useCustom ? 'custom' : 'edge',
            voice: result.voice,
            cached: result.cached,
            durationSeconds: result.durationSeconds,
            audioBase64: result.audio.toString('base64'),
            words: result.words,
            cache: tts === null ? null : tts.cacheStats(),
          });
        } catch (error) {
          const message = String(error?.message ?? error);
          const code = error?.code ?? 'E_TTS_FAILED';
          state.tts.lastError = message;
          state.tts.failureCount += 1;
          state.lastError = message;

          /*
           * ★ 降级提示（方案文档 §6.1 #8）。
           *
           * Host 只说「你可以换系统语音再试」，**换不换由渲染端决定** ——
           * 因为 `system` 适配器跑在浏览器里（`speechSynthesis`），Host 这边
           * 连它存不存在都不知道。`degrade` 为 `null` 时渲染端照旧报错。
           *
           * 判断逻辑放在 `./host/tts-adapters.js`，与渲染端**共用同一份实现** ——
           * 断网时渲染端可能根本没走到 Host（`fetch` 直接失败），那条路径要
           * 自己判断，两边不一致的话会出现「Host 说别降级、客户端降级了」。
           */
          const decision = chooseAdapter({ failureCode: code });
          state.tts.lastDegrade = decision.degraded;

          log(`[speak] 失败：${message}${decision.degraded ? '（已提示渲染端降级到系统语音）' : ''}`);
          return sendJson(res, 502, {
            code,
            message: '语音合成失败',
            detail: message,
            degrade: decision.degraded ? decision.adapterId : null,
            degradeReason: decision.reason,
          });
        }
      }

      /**
       * 音色偏好（「换一种音色说话」）。
       *
       * 为什么需要一条独立路由，而不是让面板去改 `/speak`：
       *   这是**配置**（存进 `settings.json`，下次启动还在），`/speak` 是**一次性
       *   动作**。混在一起的话，「试听」会顺手把偏好改掉 —— 用户点一下试听，
       *   回来发现默认音色变了。
       *
       * GET 返回三样东西：当前偏好、**为什么是它**（`voiceSource` 为 `default` 还是
       * `settings`，以及 `notes` 里那条「你写坏的字段被忽略了」）、以及面板要画的
       * `voices` 清单。第三样由 Host 给而不是客户端写死：清单要与 `/speak` 接受的
       * 东西一致，客户端自己抄一份迟早对不上。
       */
      if (rest === '/tts') {
        if (req.method === 'GET') {
          const settings = resolveTtsSettings(state.settingsPath);
          return sendJson(res, 200, {
            ok: true,
            source: settings.source,
            settingsPath: typeof state.settingsPath === 'string' ? state.settingsPath : '',
            voice: settings.voice,
            voiceLabel: describeVoice(settings.voice),
            voiceSource: settings.voiceSource,
            rate: settings.rate,
            engine: settings.engine,
            engineLabel: engineById(settings.engine)?.label ?? settings.engine,
            endpoint: settings.endpoint,
            /*
             * 「自定义服务现在到底能不能用」由 Host 算，面板不自己拼条件。
             * 三个字段而不是一个布尔：面板要能分别说清「选了 custom」「没填地址」
             * 「填了但地址不合法」，而一个 false 说不清是哪一种。
             */
            endpointValid: settings.endpoint === '' ? false : normalizeEndpoint(settings.endpoint).ok,
            customReady: settings.engine === 'custom' && settings.endpoint !== ''
              && normalizeEndpoint(settings.endpoint).ok,
            defaultEngine: DEFAULT_ENGINE_ID,
            notes: settings.notes,
            defaultVoice: DEFAULT_VOICE_ID,
            voices: voiceOptions(settings.voice),
            engines: TTS_ENGINES.map((engine) => ({ ...engine })),
            /*
             * 音色包：当前启用的是哪个 + 有哪些可选。
             *
             * 清单跟 `/tts` 一起返回，而不是让面板再打一次 `/tts/packs`：
             * 面板只有一处要画它，多一次往返只多一个「两个列表对不上」的机会。
             * `voicePacks.broken` 也一起给 —— 「目录里有东西但读不出来」必须
             * 看得见，否则用户只会觉得「我放进去的包不见了」。
             */
            voicePack: settings.voicePack,
            voicePackRoot: voicePacks.root,
            voicePacks: voicePackListing(voicePacks, settings.voicePack),
          });
        }

        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 GET 或 POST', detail: req.method });
        }

        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, {
            code: 'E_BAD_JSON',
            message: '请求体不是合法 JSON',
            detail: String(error?.message ?? error),
          });
        }
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          return sendJson(res, 400, { code: 'E_BAD_PATCH', message: '要写入的内容不是一个对象', detail: typeof payload });
        }

        /*
         * ★ 明确给了坏值就**拒绝**，不静默忽略。
         *
         * `normalizeTtsSettings()` 对坏值的选择是「退回默认并留一句 notes」——
         * 那对**读**配置是对的（读坏了也必须能说话），但对**写**配置是错的：
         * 用户把音色写成「晓晓」并点了保存，如果 Host 悄悄存了个空、面板回头
         * 显示默认音色，他得到的结论是「保存按钮坏了」。
         */
        if (payload.voice !== undefined && payload.voice !== null && payload.voice !== ''
          && !isVoiceShortName(payload.voice)) {
          return sendJson(res, 400, {
            code: 'E_TTS_BAD_VOICE',
            message: '音色 id 形状不对',
            detail: `要写成 ShortName，例如 'zh-CN-XiaoxiaoNeural'，收到的是 ${JSON.stringify(payload.voice)}`,
          });
        }
        if (payload.rate !== undefined) {
          const rateResult = normalizeRate(payload.rate);
          if (!rateResult.ok) {
            return sendJson(res, 400, { code: rateResult.code, message: '语速格式不对', detail: rateResult.detail });
          }
        }
        if (payload.engine !== undefined && engineById(payload.engine) === null) {
          return sendJson(res, 400, {
            code: 'E_TTS_BAD_ENGINE',
            message: '不认识的 TTS 引擎',
            detail: `可用：${TTS_ENGINES.map((engine) => engine.id).join(' / ')}，收到的是 ${JSON.stringify(payload.engine)}`,
          });
        }
        /*
         * 地址单独校验：`normalizeTtsSettings()` 对坏地址是「留一句 notes 后静默丢掉」
         * —— 那是**读**配置该有的宽容，但对**写**是错的。用户填了 `127.0.0.1:9880/tts`
         * （漏了 `http://`）并点保存，如果 Host 悄悄存了个空串，面板回头显示「没填地址」，
         * 他得到的结论是「保存按钮坏了」，而不是「这个地址缺协议头」。
         */
        if (payload.endpoint !== undefined && payload.endpoint !== null && `${payload.endpoint}` !== '') {
          const endpointResult = normalizeEndpoint(payload.endpoint);
          if (!endpointResult.ok) {
            return sendJson(res, 400, {
              code: endpointResult.code,
              message: endpointResult.message,
              detail: endpointResult.detail,
            });
          }
        }

        const current = resolveTtsSettings(state.settingsPath);
        /*
         * 音色包 id 的写入校验。
         *
         * 与 `ttsVoice` 同样的取舍：读配置时宽容（坏值忽略并留 notes），
         * 写配置时严格 —— 面板上选了「大肥鱼」却存下一个空串，用户得到的
         * 结论是「保存坏了」。这里也允许空串，那是「不用音色包」。
         */
        if (payload.voicePack !== undefined && payload.voicePack !== null) {
          const rawPack = `${payload.voicePack}`.trim().toLowerCase();
          if (rawPack !== '' && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(rawPack)) {
            return sendJson(res, 400, {
              code: 'E_TTS_BAD_VOICE_PACK',
              message: '音色包 id 形状不对',
              detail: `只能是小写 ASCII（字母/数字/点/下划线/短横），收到 ${JSON.stringify(payload.voicePack)}`,
            });
          }
          if (rawPack !== '') {
            const loaded = voicePacks.load(rawPack);
            if (loaded.ok !== true) {
              return sendJson(res, 400, {
                code: 'E_TTS_NO_VOICE_PACK',
                message: '没有这个音色包',
                detail: `${rawPack}：${loaded.message}`,
              });
            }
          }
        }

        const merged = normalizeTtsSettings({
          ttsVoice: payload.voice !== undefined ? payload.voice : current.voice,
          ttsRate: payload.rate !== undefined ? payload.rate : current.rate,
          ttsEngine: payload.engine !== undefined ? payload.engine : current.engine,
          ttsEndpoint: payload.endpoint !== undefined ? payload.endpoint : current.endpoint,
          ttsVoicePack: payload.voicePack !== undefined ? payload.voicePack : current.voicePack,
        });

        /*
         * 等于默认值就**删键**（`undefined` 让 `applySettingsPatch` 删）：
         * 配置文件里留一句 `"ttsVoice": "zh-CN-XiaoxiaoNeural"` 会让人误以为
         * 「这个值是必须的」，而它其实只是默认值——下次默认变了它反而成了钉子。
         */
        const written = applySettingsPatch(state.settingsPath, {
          ttsVoice: merged.voice === DEFAULT_VOICE_ID ? undefined : merged.voice,
          ttsRate: merged.rate === '+0%' ? undefined : merged.rate,
          ttsEngine: merged.engine === 'edge' ? undefined : merged.engine,
          ttsEndpoint: merged.endpoint === '' ? undefined : merged.endpoint,
          ttsVoicePack: merged.voicePack === '' ? undefined : merged.voicePack,
        });
        if (written.ok !== true) {
          return sendJson(res, 400, { code: written.code, message: written.message, detail: written.detail });
        }

        // 写完立刻作废缓存：`applySettingsPatch` 用的是「写临时文件再改名」，
        // 同一毫秒内两次保存可能拿到相同 mtime，靠 mtime 失效不可靠。
        ttsSettingsCache = { key: '', value: null };

        const settings = resolveTtsSettings(state.settingsPath);
        log(`[tts] 音色偏好已保存：${describeVoice(settings.voice)} / ${settings.rate} / ${settings.engine}`);
        return sendJson(res, 200, {
          ok: true,
          voice: settings.voice,
          voiceLabel: describeVoice(settings.voice),
          voiceSource: settings.voiceSource,
          rate: settings.rate,
          engine: settings.engine,
          engineLabel: engineById(settings.engine)?.label ?? settings.engine,
          endpoint: settings.endpoint,
          endpointValid: settings.endpoint === '' ? false : normalizeEndpoint(settings.endpoint).ok,
          customReady: settings.engine === 'custom' && settings.endpoint !== ''
            && normalizeEndpoint(settings.endpoint).ok,
          notes: settings.notes,
          voices: voiceOptions(settings.voice),
          voicePack: settings.voicePack,
          voicePacks: voicePackListing(voicePacks, settings.voicePack),
          settingsPath: typeof state.settingsPath === 'string' ? state.settingsPath : '',
        });
      }

      /**
       * 「测试连接」：自定义 TTS 服务到底在不在。
       *
       * 为什么要有这条路由，而不是让面板自己 fetch 那个地址：
       *   ① 面板跑在渲染进程里，跨源请求会被 CORS 拦住 —— 而本地服务几乎不带
       *      `Access-Control-Allow-Origin`，于是「服务明明在跑、面板说连不上」；
       *   ② Host 到 Host 的探测与 `/speak` 走同一条网络栈，探通了就**真的**能合成。
       *
       * 判据是「收到了 HTTP 响应」而不是 2xx：只开 POST 的服务对 GET 会回 405，
       * 那恰恰说明它在跑（见 `custom-tts.js` 的 `probeCustomTts`）。
       *
       * 允许带 `endpoint` 覆盖并**不写盘**：用户要先试通再保存，不用为了测试先存
       * 一个坏地址进去。
       */
      if (rest === '/tts/check') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
        }
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, {
            code: 'E_BAD_JSON',
            message: '请求体不是合法 JSON',
            detail: String(error?.message ?? error),
          });
        }

        const settings = resolveTtsSettings(state.settingsPath);
        const endpoint = typeof payload?.endpoint === 'string' && payload.endpoint.trim() !== ''
          ? payload.endpoint.trim()
          : settings.endpoint;
        const probe = await probeCustomTts({ endpoint });
        log(
          `[tts] 连通性探测${probe.reachable ? '通过' : '失败'}：${probe.endpoint}`
          + `${probe.reachable ? `（HTTP ${probe.status} / ${probe.elapsedMs}ms）` : `（${probe.code}: ${probe.message}）`}`,
        );
        return sendJson(res, 200, { ok: true, ...probe });
      }

      /**
       * 「本地 TTS 一键」的探测面。
       *
       * 它回答的问题是**「我该填什么」**：9880/9881 有没有人在听、机器上哪几个
       * 目录看起来像 GPT-SoVITS、适配层脚本在哪。面板把这三条拼成一句话，
       * 用户就不用先读一遍部署文档才知道地址里该写 9880 还是 9881。
       *
       * 只读、无副作用；探测本身有 400ms 超时，按钮点下去不会卡住面板。
       */
      if (rest === '/tts/local') {
        if (req.method !== 'GET') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 GET', detail: req.method });
        }
        /*
         * 「用哪份」的优先级：query（面板上正选着的那一份）→ settings.json
         * （上次存下来的）→ 探测结果的第一处。
         *
         * 这条链是 §13.28 修的那个 bug 的正身：原来这里直接 `scan()`，等于每次都
         * 回答「默认那处」，面板再把答案写回自己的下拉框，用户挑的 v5 就被顶掉了。
         */
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const queryRoot = (url.searchParams.get('root') ?? '').trim();
        const queryConfig = (url.searchParams.get('config') ?? '').trim();
        const settings = resolveTtsSettings(state.settingsPath);
        const preferredRoot = queryRoot !== '' ? queryRoot : settings.localRoot;
        const preferredConfig = queryConfig !== '' ? queryConfig : settings.localConfig;
        const status = await localTts.scan({ root: preferredRoot, config: preferredConfig });
        log(
          `[tts] 本地服务探测：9880 ${status.ports.engine.listening ? '在跑' : '没跑'} / `
          + `9881 ${status.ports.adapter.listening ? '在跑' : '没跑'} / 安装 ${status.installs.length} 处`
          + ` / 当前选 ${status.selected === null ? '(无)' : `${status.selected.root} › ${status.selected.config}`}`,
        );
        return sendJson(res, 200, {
          ok: true,
          ...status,
          selection: {
            root: status.selected === null ? '' : status.selected.root,
            config: status.selected === null ? '' : status.selected.config,
            preferredRoot,
            preferredConfig,
            source: queryRoot !== '' ? 'query' : (settings.localRoot !== '' ? 'settings' : 'default'),
          },
        });
      }

      /**
       * 把「用哪份」存进 settings.json（§13.28）。
       *
       * 单独一条路由而不是塞进 start：选择发生在**点启动之前**，用户换一份 yaml
       * 就刷新页面是很正常的动作，那时还没有启动过 —— 只在 start 里存等于没存。
       *
       * 校验只有两条：root 必须在探测结果里、config 必须是那处安装里的 yaml。
       * 校验通过才写盘，且只写 `ttsLocalRoot` / `ttsLocalConfig` 两个键
       * （`applySettingsPatch` 的原子写与「只动自己那个键」见 settings-write.js）。
       */
      if (rest === '/tts/local/select') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
        }
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, {
            code: 'E_BAD_JSON',
            message: '请求体不是合法 JSON',
            detail: String(error?.message ?? error),
          });
        }
        const root = typeof payload?.root === 'string' ? payload.root.trim() : '';
        const config = typeof payload?.config === 'string' ? payload.config.trim() : '';
        if (root.length > 512 || config.length > 64) {
          return sendJson(res, 400, {
            code: 'E_LOCAL_TTS_BAD_ROOT',
            message: 'root / config 太长了',
            detail: `root ${root.length} 字符，config ${config.length} 字符`,
          });
        }
        const status = await localTts.scan({ root, config });
        if (root !== '' && status.requestedRoot !== '') {
          return sendJson(res, 409, {
            code: 'E_LOCAL_TTS_BAD_ROOT',
            message: '指定的安装目录不在探测结果里（先点「检测本机」看看它认得哪些）',
            detail: status.requestedRoot,
            installs: status.installs.map((install) => install.root),
          });
        }
        const chosen = status.selected;
        if (chosen === null) {
          return sendJson(res, 409, {
            code: 'E_LOCAL_TTS_NO_INSTALL',
            message: '没有找到 GPT-SoVITS 的安装目录（可以用环境变量 DSH_GSV_ROOT 指过去）',
            detail: '',
          });
        }
        const install = status.installs.find((entry) => entry.root === chosen.root);
        if (config !== '' && !(install?.configs ?? []).some((name) => name.toLowerCase() === config.toLowerCase())) {
          return sendJson(res, 409, {
            code: 'E_LOCAL_TTS_NO_CONFIG',
            message: '这份 yaml 不在这处安装的 GPT_SoVITS\\configs 里',
            detail: config,
            configs: install?.configs ?? [],
          });
        }
        const written = applySettingsPatch(state.settingsPath, {
          ttsLocalRoot: chosen.root,
          ttsLocalConfig: chosen.config,
        });
        if (written.ok !== true) {
          return sendJson(res, 409, {
            code: written.code ?? 'E_SETTINGS_WRITE_FAILED',
            message: written.message ?? '写 settings.json 失败',
            detail: written.detail ?? '',
          });
        }
        log(`[tts] 记住「用哪份」：${chosen.root} › ${chosen.config}`);
        return sendJson(res, 200, { ok: true, selection: { root: chosen.root, config: chosen.config, source: 'settings' } });
      }

      /**
       * 拉起 / 停掉本机的两个服务进程。
       *
       * `target` 只认三选一，`config` 只认探测到的那几份 yaml —— 这条路由的入参
       * **不能变成命令行片段**，否则面板就成了本机任意命令执行的入口（见模块头的
       * 硬约束 1）。启动是分离进程：Host 退出它还在，所以停止要单独一条路由，
       * 而且只杀我们自己起的（`managed` 里的 pid）。
       */
      if (rest === '/tts/local/start' || rest === '/tts/local/stop') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
        }
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, {
            code: 'E_BAD_JSON',
            message: '请求体不是合法 JSON',
            detail: String(error?.message ?? error),
          });
        }
        const target = typeof payload?.target === 'string' && payload.target !== '' ? payload.target : 'all';
        const config = typeof payload?.config === 'string' ? payload.config : '';
        const root = typeof payload?.root === 'string' ? payload.root : '';
        if (config.length > 64) {
          return sendJson(res, 400, {
            code: 'E_LOCAL_TTS_BAD_CONFIG',
            message: 'config 只能是 yaml 文件名',
            detail: `收到 ${config.length} 个字符`,
          });
        }
        if (root.length > 512) {
          return sendJson(res, 400, {
            code: 'E_LOCAL_TTS_BAD_ROOT',
            message: 'root 只能是探测到的安装目录',
            detail: `收到 ${root.length} 个字符`,
          });
        }
        const result = rest === '/tts/local/start'
          ? await localTts.start({ target, config, root })
          : await localTts.stop({ target });
        if (result.ok !== true) {
          const status = result.code === 'E_LOCAL_TTS_ALREADY_RUNNING' ? 409 : 400;
          log(`[tts] 本地服务${rest.endsWith('/start') ? '启动' : '停止'}未执行：${result.code} ${result.message}`);
          return sendJson(res, status, { ok: false, ...result });
        }
        log(
          `[tts] 本地服务${rest.endsWith('/start') ? '启动' : '停止'}：`
          + `${(result.started ?? result.stopped ?? []).map((entry) => `${entry.name}(${entry.pid})`).join(' / ') || '无'}`,
        );
        const status = await localTts.scan({ config, root });
        /*
         * 起来之后把「刚才用的那一份」记下来（§13.28）：用户点的是「启动」，
         * 但他同时已经用下拉框做了选择 —— 不记的话，刷新一次页面就得重挑。
         * 写失败不影响启动结果，只是下次要重选，所以不拦。
         */
        if (rest === '/tts/local/start' && status.selected !== null) {
          const written = applySettingsPatch(state.settingsPath, {
            ttsLocalRoot: status.selected.root,
            ttsLocalConfig: status.selected.config,
          });
          if (written.ok !== true) log(`[tts] 记住「用哪份」失败：${written.code ?? 'E_SETTINGS_WRITE_FAILED'}`);
        }
        return sendJson(res, 200, { ok: true, ...result, status });
      }

      /**
       * 音色包（参考音 registry）。
       *
       * 为什么是四条路由而不是一条 `POST /tts/voice`：
       *   「导入一个包」「选用一个包」「删掉一个包」「听一下这个包的参考音」
       *   是四件不同的事，混成一条的话，任何一次调用都得先判断调用方想干哪件。
       *
       * 为什么编排逻辑全在 `host/voice-packs.js` 里，这里只做协议：
       *   那个模块能造临时目录测（门禁 `test-voice-packs`），而路由不能 ——
       *   校验规则写在路由里，就只能在「跑起一个 Host」的前提下去测。
       */
      if (rest === '/tts/packs' || rest === '/tts/packs/audio' || rest === '/tts/packs/weights') {
        if (req.method !== 'GET') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 GET', detail: req.method });
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const settings = resolveTtsSettings(state.settingsPath);
        if (rest === '/tts/packs/weights') {
          // 预览：这一包带的模型是哪一版、多大、sha256 对不对。**不换**，只回答。
          const wanted = url.searchParams.get('id') ?? settings.voicePack;
          const info = voicePacks.weightsInfo(wanted);
          if (info.ok !== true) {
            const status = info.code === 'E_PACK_NOT_FOUND' ? 404 : 400;
            return sendJson(res, status, { ok: false, ...info });
          }
          return sendJson(res, 200, { ok: true, ...info });
        }
        if (rest === '/tts/packs/audio') {
          const wanted = url.searchParams.get('id') ?? settings.voicePack;
          const audio = voicePacks.audio(wanted);
          if (audio.ok !== true) {
            return sendJson(res, 404, { code: audio.code, message: audio.message, detail: audio.detail ?? '' });
          }
          return sendFile(res, audio.path, audio.mime);
        }
        return sendJson(res, 200, { ok: true, ...voicePackListing(voicePacks, settings.voicePack) });
      }

      if (rest === '/tts/packs/import' || rest === '/tts/packs/activate' || rest === '/tts/packs/remove') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
        }
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, { code: 'E_BAD_JSON', message: '请求体不是合法 JSON', detail: `${error?.message ?? error}` });
        }
        const action = rest.slice('/tts/packs/'.length);

        if (action === 'import') {
          const source = typeof payload?.path === 'string' ? payload.path.trim() : '';
          if (source.length > 4096) {
            return sendJson(res, 400, { code: 'E_PACK_BAD_SOURCE', message: '路径太长', detail: `收到 ${source.length} 个字符` });
          }
          const imported = voicePacks.importFrom(source, { overwrite: payload?.overwrite === true });
          if (imported.ok !== true) {
            log(`[voicepack] 导入失败：${imported.code} ${imported.message}`);
            return sendJson(res, 400, { ok: false, ...imported });
          }
          const settings = resolveTtsSettings(state.settingsPath);
          log(`[voicepack] 已导入「${imported.pack.name}」（${imported.pack.id}，参考音 ${imported.pack.refBytes} 字节）`);
          return sendJson(res, 200, {
            ok: true,
            pack: imported.pack,
            ...voicePackListing(voicePacks, settings.voicePack),
          });
        }

        if (action === 'activate') {
          const wanted = typeof payload?.id === 'string' ? payload.id.trim().toLowerCase() : '';
          const before = resolveTtsSettings(state.settingsPath);
          let switched = null;
          if (wanted !== '') {
            const loaded = voicePacks.load(wanted);
            if (loaded.ok !== true) {
              return sendJson(res, 400, { code: 'E_TTS_NO_VOICE_PACK', message: '没有这个音色包', detail: loaded.message });
            }
            /*
             * 带训练权重的包：启用它不只是「换参考音」，而是**换模型**。
             *
             * 顺序很关键 —— 先在正在跑的服务上换成功，再写偏好。反过来的话，
             * 换权重失败会留下「设置里说在用这个包、实际还在用上一个模型」的错位。
             */
            if (loaded.pack.weights !== undefined && loaded.pack.weights !== null) {
              if (before.engine !== 'custom') {
                return sendJson(res, 409, {
                  code: 'E_PACK_NEEDS_CUSTOM',
                  message: '这个音色包带训练好的模型，只有「自定义 TTS 服务」才能换',
                  detail: '先把引擎切到自定义服务，或者把这个包的权重删掉，只留参考音',
                });
              }
              const info = voicePacks.weightsInfo(wanted);
              if (info.ok !== true) {
                return sendJson(res, 400, { ok: false, ...info });
              }
              /*
               * 不能热换的权重（PK 容器）：明确拒绝，而不是让它「200 success 但声音不对」。
               *
               * 这类权重只能改 yaml 重启引擎：位置在 `GPT_SoVITS/configs/`，
               * 面板下方「本地 TTS 一键」里的两个维护下拉能选到它。
               */
              if (info.canHotSwap !== true) {
                log(`[voicepack] 拒绝热换「${loaded.pack.name}」：${info.hotSwapBlockedReason ?? ''}`);
                return sendJson(res, 409, {
                  code: 'E_PACK_WEIGHTS_NEED_RESTART',
                  message: `「${loaded.pack.name}」的权重不能热换，要换 yaml 重启引擎`,
                  detail: info.hotSwapBlockedReason ?? '',
                  version: info.version,
                  packId: wanted,
                  restartRequired: true,
                });
              }
              const pushed = await pushAdapterWeights(before.endpoint, info.sovits.path, info.gpt.path);
              if (pushed.ok !== true) {
                log(`[voicepack] 换权重失败：${pushed.code} ${pushed.message}`);
                /*
                 * v5 的 LoRA 只能换进「同样是 v5」的引擎：它要合并到官方底模上，
                 * 而 v2/v2Pro 的包里根本没有 v5 的底模配置。这种失败对用户来说
                 * 最像「点了没反应」，所以把该走的路直接写出来。
                 */
                const versionHint = /^v5/.test(info.version)
                  ? `这份权重属于 ${info.version}：只有引擎自己就是 ${info.version} 时才能热换。`
                    + '请用下面的「本地 TTS 一键」停止服务，选包里对应的 yaml（安装目录 GPT_SoVITS/configs/tts_infer_*.yaml）再启动。'
                  : '';
                return sendJson(res, 409, {
                  code: pushed.code,
                  message: pushed.message,
                  detail: [pushed.detail ?? '', versionHint].filter((part) => part !== '').join(' '),
                });
              }
              switched = { version: info.version, bytes: info.bytes, elapsedMs: pushed.elapsedMs };
              log(`[voicepack] 已换入「${loaded.pack.name}」的 ${info.version} 权重（${info.bytes} 字节，${pushed.elapsedMs} ms）`);
            }
          }
          const written = applySettingsPatch(state.settingsPath, { ttsVoicePack: wanted === '' ? undefined : wanted });
          if (written.ok !== true) {
            return sendJson(res, 400, { code: written.code, message: written.message, detail: written.detail });
          }
          ttsSettingsCache = { key: '', value: null };
          const settings = resolveTtsSettings(state.settingsPath);
          /*
           * 从「带权重的包」切到「只有参考音的包」时，引擎里跑的还是那份换进来的模型 ——
           * 这件事**没法靠换参考音还原**，只能重启引擎。面板要如实说出来，
           * 否则用户会以为换回去了，其实声音还挂着上一个包。
           */
          let restartRequired = false;
          if (switched === null && before.voicePack !== '' && before.voicePack !== wanted) {
            const previous = voicePacks.load(before.voicePack);
            restartRequired = previous.ok === true
              && previous.pack.weights !== undefined
              && previous.pack.weights !== null;
          }
          log(`[voicepack] 启用音色包：${wanted === '' ? '（无，用适配层默认音色）' : wanted}`);
          return sendJson(res, 200, {
            ok: true,
            voicePack: settings.voicePack,
            switched,
            restartRequired,
            ...voicePackListing(voicePacks, settings.voicePack),
          });
        }

        // remove
        const removed = voicePacks.remove(payload?.id);
        if (removed.ok !== true) {
          return sendJson(res, 400, { ok: false, ...removed });
        }
        const settings = resolveTtsSettings(state.settingsPath);
        if (settings.voicePack === removed.id) {
          // 删掉的正是当前启用的那个：顺手清掉偏好，否则设置里留着一个不存在的 id。
          applySettingsPatch(state.settingsPath, { ttsVoicePack: undefined });
          ttsSettingsCache = { key: '', value: null };
        }
        const after = resolveTtsSettings(state.settingsPath);
        log(`[voicepack] 已删除音色包 ${removed.id}`);
        return sendJson(res, 200, { ok: true, removed: removed.id, ...voicePackListing(voicePacks, after.voicePack) });
      }

      /**
       * Cubism Core 本体。
       *
       * 渲染进程必须用 `<script src>` 加载它，**不能** import：Core 的 UMD 尾部是
       * `typeof exports === 'object' && typeof module === 'object' ? module.exports = …`，
       * 一旦被当模块加载就挂不到全局，后面所有 `Live2DCubismCore.*` 调用都会 undefined。
       */
      if (rest === '/core/live2dcubismcore.min.js') {
        return sendFile(res, join(CORE_DIR, 'live2dcubismcore.min.js'), 'text/javascript; charset=utf-8');
      }

      if (rest.startsWith('/shaders/')) {
        const shaderName = rest.slice('/shaders/'.length);
        if (!SHADER_NAME.test(shaderName)) {
          return sendJson(res, 403, { code: 'E_SHADER_NAME_REJECTED', message: '非法 shader 文件名', detail: shaderName });
        }
        return sendFile(res, join(SHADER_DIR, shaderName), 'text/plain; charset=utf-8');
      }

      /**
       * 模型库清单。
       *
       * 渲染进程看不到磁盘，所以「模型库里有哪些模型」必须由 Host 告诉它。
       * 用递归扫描而不是维护一份索引文件：用户的模型文件夹是**他自己**放的，
       * 任何「导入」动作都可能被绕过（直接拖进目录），索引一旦和现实不一致，
       * 症状就是「模型明明在里面却不在列表里」——最难查的一类 bug。
       */
      /**
       * 渲染进程的指令拉取口（Host → Client 的单向队列）。
       *
       * 为什么用「渲染进程轮询」而不是 WebSocket / SSE：桌宠已经每 15 秒打一次
       * 心跳（`/status`），再加一条轮询几乎没有额外成本；而长连接要在 Host 重启、
       * 页面休眠、代理超时这些情况下处理重连与半开连接——那是这个功能**不值得**
       * 付的复杂度。队列丢失一条「说句话」是可以接受的，丢失一个渲染状态不是。
       */
      if (rest === '/pending') {
        state.lastClientSeenAt = Date.now();
        const items = pendingCommands.splice(0, pendingCommands.length);
        /*
         * 顺带报一次状态机的状态（`host/mood.js`）。
         *
         * 渲染端只用得上 `state === 'thinking'` 一个值：她在想事情的时候要把
         * 待机动作的幅度收小（`src/client/motion-calm.ts`）。搭这条轮询而不是
         * 另开一条推送，是因为它本来就在每秒被调一次、每次都要读一遍 Host 状态；
         * 真正的时效性要求只是「几百毫秒内」，1.2 秒的轮询完全够。
         *
         * 字段名用 `mood` 而不是 `state`：这个响应体里 `state` 已经被
         * `state.lastClientSeenAt` 那条线占用了（下面 500 行的 `/status` 也是
         * 一个 `state`），混在一起最容易在排查时看错一个层级。
         *
         * 旧版渲染端不认这个字段（多出来就多出来）；新版渲染端在旧 Host 上
         * 拿到的是 `undefined`，收幅不生效 —— 两边各自降级，互不牵连。
         */
        return sendJson(res, 200, { ok: true, items, mood: state.mood ?? null });
      }

      /**
       * 模型库清单。
       *
       * 渲染进程看不到磁盘，所以「模型库里有哪些模型」必须由 Host 告诉它。
       * 用递归扫描而不是维护一份索引文件：用户的模型文件夹是**他自己**放的，
       * 任何「导入」动作都可能被绕过（直接拖进目录），索引一旦和现实不一致，
       * 症状就是「模型明明在里面却不在列表里」——最难查的一类 bug。
       *
       * 返回的是**体检过的**条目（`lib/host/model-library.js`），不只是三个字段：
       * 原先客户端拿到 `{ id, path, name }`，于是「缺一张纹理的模型」和健康的模型
       * 在下拉框里长得一模一样，用户只能靠「点进去看会不会炸」来发现坏包，
       * 而点进去的代价是当前模型已经被释放了。现在坏包在**点之前**就带着
       * 错误码出现在列表里。
       */
      if (rest === '/models') {
        return sendJson(res, 200, listModels(false));
      }

      /**
       * 强制重扫模型库。
       *
       * 体检缓存本身靠「每个引用文件的 mtime+size 指纹」失效，正常情况下
       * 用户往目录里丢个模型、`/models` 就会带上它（目录遍历每次都真做）。
       * 这条路由存在的意义是绕开指纹判断本身 —— 网络盘 / 虚拟文件系统上的
       * mtime 可能粗到秒级，指纹会漏；这时用户需要一个「别管缓存，重来」的按钮。
       */
      if (rest === '/models/refresh') {
        const listed = listModels(true);
        log(`[models] 强制重扫：${JSON.stringify(listed.summary)}`);
        return sendJson(res, 200, listed);
      }

      /**
       * 语音库清单。
       *
       * 与 `/models` 同一个道理：渲染进程看不到磁盘，所以「有哪些语音包、
       * 每个包里有几条、哪几条有问题」必须由 Host 告诉它。**坏包也照样列出来**
       * —— 只列好包会让用户以为「我建的包不见了」，而实际是 json 写错了一个字段。
       */
      if (rest === '/voices') {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 GET', detail: req.method });
        }
        return sendJson(res, 200, listVoices());
      }

      /**
       * 取一条语音（base64 装进 JSON，与 `/speak` **同一个形状**）。
       *
       * ★ 为什么复用 `/speak` 的响应形状而不是直接把音频当响应体：
       * 客户端那条播放链（`src/client/speech.ts` 的 `playBase64`）只认
       * `{ audioBase64, mimeType }`，它已经被 TTS 那条路验证过一遍（解码、
       * 包络、口型、打断、看门狗）。让语音包走**同一个入口**意味着口型、
       * 字幕、打断这些行为不需要再实现一次 —— 也不会出现两套播放器。
       *
       * 参数：`?pack=<目录名>&clip=<id>`，或者 `?pack=&emotion=<情绪>` 按情绪挑。
       * 两个都不给时随机挑一条（面板「随便来一条」与 AI 的兜底都走这条路）。
       *
       * 挑不到时的语义（`voice-pack.js` 的 `pickClip` 定的）：
       *   点了名但没有 → 报错（E_VOICE_UNKNOWN_CLIP），**不退让**，
       *   否则面板上「试听第三条」永远播第一条，用户会以为是文件坏了；
       *   按情绪但没有该情绪的语音 → 退到任意一条，并把 `fallback: true` 报出来。
       */
      if (rest === '/voice') {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 GET', detail: req.method });
        }

        const packParam = url.searchParams.get('pack') ?? '';
        const clipParam = url.searchParams.get('clip') ?? '';
        const emotionParam = url.searchParams.get('emotion') ?? '';

        const picked = resolveVoiceClip(
          voicesRoot,
          { pack: packParam, clip: clipParam, emotion: emotionParam },
          { canonicalEmotion: canonicalEmotionName },
        );

        if (picked.ok !== true) {
          const notFound = picked.code === 'E_VOICE_UNKNOWN_CLIP'
            || picked.code === 'E_VOICE_PACK_EMPTY'
            || picked.code === 'E_VOICE_EMPTY_PACK'
            || picked.code === 'E_VOICE_NO_EMOTION_CLIP';
          const message = notFound ? '这个语音包里没有你要的那条语音' : '语音取不出来';
          state.voice.lastError = `${picked.code}: ${picked.detail}`;
          log(`[voice] 失败 ${picked.code} pack=${JSON.stringify(packParam)} clip=${JSON.stringify(clipParam)} → ${picked.detail}`);
          return sendJson(res, notFound ? 404 : 400, {
            code: picked.code,
            message,
            detail: picked.detail,
            available: Array.isArray(picked.available) ? picked.available : null,
          });
        }

        let bytes;
        try {
          const size = statSync(picked.path).size;
          if (size > MAX_VOICE_CLIP_BYTES) {
            state.voice.lastError = `E_VOICE_CLIP_TOO_LARGE: ${size}`;
            return sendJson(res, 413, {
              code: 'E_VOICE_CLIP_TOO_LARGE',
              message: '这条语音太大了，拒绝发送',
              detail: `${size} 字节 > ${MAX_VOICE_CLIP_BYTES} 字节上限（${picked.clip.file}）`,
            });
          }
          bytes = readFileSync(picked.path);
        } catch (error) {
          state.voice.lastError = String(error?.message ?? error);
          return sendJson(res, 404, {
            code: 'E_VOICE_FILE_UNREADABLE',
            message: '清单里写着这个文件，但读不出来',
            detail: `${picked.clip.file}: ${error?.message ?? error}`,
          });
        }

        state.voice.lastAt = Date.now();
        state.voice.lastPack = picked.pack;
        state.voice.lastClip = picked.clip.id;
        state.voice.lastBytes = bytes.length;
        state.voice.lastFallback = picked.fallback === true;
        state.voice.lastError = null;
        state.voice.servedCount += 1;
        log(
          `[voice] ${picked.pack}/${picked.clip.id} → ${bytes.length} 字节 ${picked.mimeType}`
          + `${picked.fallback ? '（按情绪挑不到，退到任意一条）' : ''}`,
        );

        return sendJson(res, 200, {
          ok: true,
          pack: picked.pack,
          clip: {
            id: picked.clip.id,
            text: picked.clip.text,
            emotion: picked.clip.emotion,
            file: picked.clip.file,
          },
          fallback: picked.fallback === true,
          mimeType: picked.mimeType,
          encoding: 'base64',
          bytes: bytes.length,
          audioBase64: bytes.toString('base64'),
        });
      }

      /**
       * 导入模型包（zip 或 rar）。
       *
       * 这是本插件**唯一接收不可信输入**的路由 —— 用户从网上下载的压缩包。
       * 因此校验全部集中在 `lib/host/zip.js` / `lib/host/rar.js` +
       * `lib/host/model-import.js`，这条路由本身只负责「读字节 → 交给它们 →
       * 把结果变成 HTTP 状态码」，不自己做任何路径判断（判断散在两处时，
       * 漏掉的那一处永远是攻击面）。
       *
       * 请求体是**原始压缩包字节**，不是 JSON —— 用 base64 装进 JSON 会多 33%
       * 体积，而这里传的可能是近百 MB。文件名走查询串（`?name=`），它只是一个
       * 目录名建议值，且 fetch 不会把它写进浏览器历史。
       *
       * 关于**同步阻塞**：zip 那条（`importModelZip`）是同步的，导入一个 90MB 的包
       * 会让 Host 的事件循环停约 1 秒。这是刻意的取舍而不是疏忽 —— 解压的 CPU 工作
       * （`inflateRawSync`）无法在不引入 worker 线程的前提下变成真并发，
       * 「async 化」只能把同一份总工作量切成带 yield 的片段，收益远小于
       * 一个多线程导入器的维护成本。而这是一次**用户主动点击**的动作，
       * 客户端会显示「导入中…」，停一秒不会被察觉。rar 那条本来就要等外部解包器，
       * 天然是 async 的，所以这里统一 `await`。
       */
      if (rest === '/import') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
        }

        const requestedName = url.searchParams.get('name') ?? '';
        let buffer = null;
        try {
          buffer = await readBodyBuffer(req, MAX_ZIP_BYTES);
        } catch (error) {
          const code = error?.code ?? 'E_BODY_READ_FAILED';
          const tooLarge = code === 'E_BODY_TOO_LARGE';
          state.importFailureCount += 1;
          state.lastImport = { at: Date.now(), ok: false, code, detail: String(error?.message ?? error) };
          log(`[import] 读取请求体失败：${code} ${error?.message ?? error}`);
          return sendJson(res, tooLarge ? 413 : 400, {
            code,
            message: tooLarge ? `模型包超过 ${MAX_ZIP_BYTES} 字节上限` : '请求体读取失败',
            detail: String(error?.message ?? error),
          });
        }

        try {
          const started = Date.now();
          const imported = await importModelArchive(buffer, { modelsRoot, name: requestedName });
          const elapsed = Date.now() - started;

          // 强制重扫而不是用缓存：刚写进去的东西必须立刻在清单里可见，
          // 否则用户导入完看到的下拉框还是旧的，会以为导入失败了。
          const listed = listModels(true);

          state.importCount += 1;
          state.lastImport = {
            at: Date.now(),
            ok: true,
            name: imported.name,
            dir: imported.dir,
            bytes: buffer.byteLength,
            elapsedMs: elapsed,
          };
          log(
            `[import] ${imported.dir} ← ${buffer.byteLength} 字节 / `
            + `${imported.stats?.files ?? '?'} 个文件 / ${elapsed}ms`
            + `${imported.entry?.ok === false ? '（体检不通过，已入库待修）' : ''}`,
          );

          return sendJson(res, 200, {
            ok: true,
            imported: {
              id: imported.id,
              path: imported.path,
              name: imported.name,
              dir: imported.dir,
              ok: imported.entry?.ok !== false,
              problems: imported.entry?.problems ?? [],
              stats: imported.stats,
            },
            // 顺手把刷新后的清单一起回给客户端：省一次往返，也避免出现
            // 「导入成功但下拉框还是旧的」这个中间状态。
            ...listed,
          });
        } catch (error) {
          const code = error?.code ?? 'E_IMPORT_FAILED';
          const detail = String(error?.message ?? error);
          state.importFailureCount += 1;
          state.lastImport = { at: Date.now(), ok: false, code, detail, name: requestedName };
          state.lastError = detail;
          log(`[import] 失败：${code} ${detail}`);
          /**
           * 一律 400 而不是 500：这些错误码全部表示**用户给的文件有问题**
           * （不是 zip、损坏、炸弹、没有模型定义），不是服务端故障。
           * 客户端据此把 `detail` 直接显示给用户 —— 那正是用户修包需要的线索。
           */
          return sendJson(res, 400, { code, message: '模型包导入失败', detail });
        }
      }

      /**
       * ★ 参数绑定：把「一块肌肉」和「模型上的某个参数」对上。
       *
       * 存在理由：模型之间的参数 id 根本不统一 —— hiyori 的笑眼叫 `ParamEyeLSmile`，
       * 下一套模型可能叫 `ParamEyeSmile2`，也可能根本没有笑眼。而情绪表是按**角色**
       * 写的（`leftEyeSmile` / `browY` / `bodyAngleX` …），`resolveEmotion()` 靠
       * `ROLE_PARAMETER_IDS` 的候选表猜第一个存在的那个。猜不中时用户看到的是
       * 「点了『开心』，她的眼睛没笑」—— 而日志里一切正常。
       *
       * 这条路由就是那个「猜」的出口：GET 报出每个角色的候选、当前自动选中的那个、
       * 以及用户绑定的那个（含「绑了但本模型没有」这种最危险的情况）；POST 把面板
       * 里那张表写进 `settings.json` 的 `emotionBindings`。
       *
       * 三条设计约束：
       *   - **绑定按角色存，不按模型存**。多套模型共用一张表是刻意的：用户绑的是
       *     「我想让笑眼走哪个参数」这件事，而不是这一套模型的一次性设置。绑了本模型
       *     没有的 id 时退回自动候选，并在 `bindingMissing` 里报出来。
       *   - **只合并，不覆盖**。settings.json 里还有 modelsRoot / emotionScene /
       *     autoEmotion 等别人的键；这条路由只动 `emotionBindings` 一个键，写之前
       *     先把整个文件读出来合并，并且坏 JSON 时**拒绝写**（不拿一份不完整的配置
       *     覆盖用户手写的东西）。
       *   - **写盘是原子的**（临时文件 + rename），并在写完清掉解析缓存 ——
       *     同一毫秒内写完再读时 mtime 可能没变，缓存会假装没事。
       */
      /**
       * 微动作（§13.26）：模型导入之后自己长出来的那套小动作。
       *
       * 三条路：
       *   - `GET  /micro-motions`：取当前模型的包（没有就现生成，并落盘）；
       *   - `POST /micro-motions`：面板改开关与强度（只合并这两样）；
       *   - `POST /micro-motions/generate`：重新生成一份（换了绑定表、或者想重置改动）。
       *
       * 为什么 `GET` 也允许生成：面板打开的那一刻是最自然的时机，而此时宿主手上
       * 通常已经有清单了（客户端换装成功才会把清单送上来）。用户不需要先点一次
       * 「生成」才看得到东西 —— 那个按钮留给「重生成」。
       *
       * 为什么包要落盘而不是每次现算：用户会改（关掉某条、拉强度），现算会把这两样
       * 一起抹掉；而生成是确定性的，落盘之后同一份包每次读到都一样。
       */
      if (rest === '/micro-motions' || rest === '/micro-motions/generate') {
        if (rest === '/micro-motions/generate') {
          if (req.method !== 'POST') {
            return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
          }
        } else if (req.method !== 'GET' && req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 GET 或 POST', detail: req.method });
        }

        const url = new URL(req.url ?? '/', 'http://localhost');
        const modelId = url.searchParams.get('model') ?? '';

        if (req.method === 'GET' || rest === '/micro-motions/generate') {
          const view = ensureMicroMotions(modelId, { force: rest === '/micro-motions/generate' });
          return sendJson(res, view.ok === true ? 200 : 409, view);
        }

        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, { code: 'E_BAD_JSON', message: '请求体不是合法 JSON', detail: String(error?.message ?? error) });
        }
        const target = typeof payload?.model === 'string' && payload.model !== '' ? payload.model : modelId;
        const view = patchMicroMotions(target, payload);
        return sendJson(res, view.ok === true ? 200 : 409, view);
      }

      /**
       * 「试演」：让某一条微动作现在就演一遍（§13.30）。
       *
       * 它是 `/micro-motions` 的第三条路，但语义与另外两条完全不同：那两条改
       * **包**，这一条不改包、只往指令队列里塞一条 `microMotion`。所以它必须
       * 走 POST（会动）、而且**不和 GET 混在同一个 if 里** —— 混在一起之后，
       * 面板只要刷新一次就会演一次。
       */
      if (rest === '/micro-motions/play') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
        }
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, { code: 'E_BAD_JSON', message: '请求体不是合法 JSON', detail: String(error?.message ?? error) });
        }
        const played = playMicroMotionById(payload?.id);
        return sendJson(res, played.ok === true ? 200 : 409, played);
      }

      /*
       * 对话（§13.36）。
       *
       * GET 取最近 40 条；POST 发送一句；POST /chat/clear 清空。
       *
       * 发送是「**先落账，再注入**」：用户那句话不能因为会话服务缺席就消失 ——
       * 她是用户说的话，不是插件成功的副产品。注入失败时 `injected:false`
       * 与错误码一起回面板，面板据此说「这句话没送到她那边」，不假装成功。
       */
      if (rest === '/chat') {
        if (req.method === 'GET') {
          return sendJson(res, 200, chatView());
        }
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 GET 或 POST', detail: req.method });
        }
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, { code: 'E_BAD_JSON', message: '请求体不是合法 JSON', detail: String(error?.message ?? error) });
        }
        const text = typeof payload?.text === 'string' ? payload.text : '';
        if (normalizeChatText(text) === '') {
          return sendJson(res, 400, { code: 'E_CHAT_EMPTY', message: '这句话是空的。' });
        }
        const sent = await sendChat(text);
        return sendJson(res, sent.ok === true ? 200 : 409, { ...sent, view: chatView() });
      }

      if (rest === '/chat/clear') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
        }
        state.chat = createChatState();
        const saved = saveChat();
        return sendJson(res, 200, { ok: true, view: chatView(), saved: saved === null ? '' : saved });
      }

      /**
       * 参数实测结果（§13.34）：渲染端在模型刚加载时把候选参数推到两端各画一帧，
       * 量出「这根写了会不会动」，POST 回来。
       *
       * 为什么由渲染端测、而不是 Host 猜：只有它手里有画布与像素。Host 只做两件事 ——
       * 按阈值把「写了没反应」的参数记下来，以及**拿它重算一次包**（这一次会把
       * 那些部位换成替代部位）。
       */
      if (rest === '/binding-probe') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 POST', detail: req.method });
        }
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, { code: 'E_BAD_JSON', message: '请求体不是合法 JSON', detail: String(error?.message ?? error) });
        }
        const model = typeof payload?.model === 'string' ? payload.model : '';
        const results = [];
        for (const item of Array.isArray(payload?.results) ? payload.results : []) {
          if (item === null || typeof item !== 'object') continue;
          if (typeof item.id !== 'string' || item.id === '' || item.id.length > 128) continue;
          const changed = Number(item.changed);
          if (!Number.isFinite(changed)) continue;
          results.push({ id: item.id, changed: Math.max(0, Math.min(1, changed)) });
        }
        state.bindingProbe = {
          model,
          at: Date.now(),
          /*
           * 这份实测是**对着哪一份能力清单**做的（§13.37）。页面刷新之后渲染端会
           * 想再测一遍，而 Host 手里的结果其实还有效 —— 指纹对得上就不用测，
           * 用户也就不会每隔一会儿看见一次「正在校准关节…」。
           */
          digest: typeof state.capabilitiesDigest === 'string' ? state.capabilitiesDigest : null,
          total: results.length,
          bound: results.filter((item) => item.changed >= 0.01).length,
          results,
        };
        log(`参数实测回来了（${model || '无模型'}）：${state.bindingProbe.bound}/${results.length} 根会动`);
        /*
         * 实测比包新 ⇒ 立刻重算。失败不改变响应（实测本身已经收到了），
         * 只记一行日志 —— 这一步是加分项，不该让渲染端的一整轮探测白跑。
         */
        let regenerated = null;
        if (model !== '' && model === state.activeModelId) {
          try {
            regenerated = ensureMicroMotions(model, { force: true });
          } catch (error) {
            log(`按实测重算微动作失败：${String(error?.message ?? error)}`);
          }
        }
        return sendJson(res, 200, {
          ok: true,
          probe: { model, total: state.bindingProbe.total, bound: state.bindingProbe.bound },
          regenerated: regenerated === null ? null : {
            ok: regenerated.ok === true,
            gestures: Array.isArray(regenerated.gestures) ? regenerated.gestures.length : 0,
            missing: Array.isArray(regenerated.missing) ? regenerated.missing : [],
            summary: typeof regenerated.summary === 'string' ? regenerated.summary : '',
          },
        });
      }

      if (rest === '/bindings') {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return sendJson(res, 405, { code: 'E_METHOD_NOT_ALLOWED', message: '请用 GET 或 POST', detail: req.method });
        }

        const describeBindings = () => {
          const setting = resolveEmotionBindings(state.settingsPath);
          const params = Array.isArray(capabilities?.parameters) ? capabilities.parameters : [];
          const declared = new Map(
            params.filter((item) => item && typeof item.id === 'string').map((item) => [item.id, item]),
          );
          return {
            ok: true,
            settingsPath: typeof state.settingsPath === 'string' ? state.settingsPath : '',
            source: setting.source,
            ignored: setting.ignored,
            roles: emotionRoleNames().map((role) => {
              const pick = pickRoleParameter(role, declared, setting.roles);
              const auto = pickRoleParameter(role, declared, {});
              return {
                role,
                label: ROLE_LABELS[role] ?? role,
                candidates: ROLE_PARAMETER_IDS[role] ?? [],
                bound: typeof setting.roles[role] === 'string' ? setting.roles[role] : '',
                // 空串而不是 null：面板拿这三个值直接当 <option value> 用，
                // null 会被模板渲染成字符串 "null"，比空串更难发现。
                auto: typeof auto.id === 'string' ? auto.id : '',
                resolved: typeof pick.id === 'string' ? pick.id : '',
                source: pick.source,
                bindingMissing: pick.bindingMissing === true,
              };
            }),
            // 当前模型能绑的 id（面板的下拉框用）。模型还没上报清单时是空表 ——
            // 那与「模型没有参数」是两件事，面板据此显示「等模型加载」。
            parameters: params.filter((item) => item && typeof item.id === 'string').map((item) => item.id),
          };
        };

        if (req.method === 'GET') return sendJson(res, 200, describeBindings());

        if (typeof state.settingsPath !== 'string' || state.settingsPath === '') {
          return sendJson(res, 500, {
            code: 'E_NO_SETTINGS_PATH',
            message: '解析不出 settings.json 的路径，没有写入',
            detail: String(state.settingsPath ?? ''),
          });
        }

        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (error) {
          return sendJson(res, 400, { code: 'E_BAD_JSON', message: '请求体不是合法 JSON', detail: String(error?.message ?? error) });
        }

        const normalised = normalizeEmotionBindings(payload?.bindings ?? {});
        const bindingCount = Object.keys(normalised.roles).length;

        /*
         * 读 / 合并 / 落盘全在 `host/settings-write.js` 里 —— 那是本插件唯一写用户
         * 配置文件的地方，抽出去是为了让门禁能拿临时目录把它真跑一遍（坏 JSON
         * 不许覆盖、别的键不许丢、不许留临时文件）。路由这边只负责把结果翻成响应。
         *
         * 绑定清空时传 `undefined`：那个键应当从文件里**消失**，而不是留一个 `{}`
         * ——留个空对象会让「用户手动删掉这一节」和「面板上清空」看起来不一样。
         */
        const written = applySettingsPatch(state.settingsPath, {
          emotionBindings: bindingCount === 0 ? undefined : normalised.roles,
        });
        if (!written.ok) {
          return sendJson(res, 500, {
            code: written.code,
            message: written.message,
            detail: written.detail,
          });
        }

        // ★ 清缓存：同一毫秒内写完再读，mtime 可能一模一样。
        bindingsCache = { key: '', value: null };
        log(
          `[bindings] 保存 ${bindingCount} 条`
          + `${normalised.ignored.length > 0 ? `，忽略 ${normalised.ignored.length} 条（${normalised.ignored.map((item) => `${item.role}=${item.reason}`).join('，')}）` : ''}`,
        );

        return sendJson(res, 200, describeBindings());
      }

      if (rest.startsWith('/model/')) {
        const rel = rest.slice('/model/'.length);
        const target = resolve(modelsRoot, rel);
        if (target !== modelsRoot && !target.startsWith(modelsRoot + sep)) {
          return sendJson(res, 403, { code: 'E_PATH_ESCAPE', message: '路径越界', detail: rel });
        }
        if (!existsSync(target)) {
          return sendJson(res, 404, { code: 'E_MODEL_FILE_MISSING', message: '文件不存在', detail: rel });
        }
        try {
          const buf = await readFile(target);
          if (buf.byteLength > MAX_FILE_BYTES) {
            return sendJson(res, 413, {
              code: 'E_FILE_TOO_LARGE',
              message: `文件超过 ${MAX_FILE_BYTES} 字节上限`,
              detail: `${rel} = ${buf.byteLength}`,
            });
          }
          const ext = extname(target).toLowerCase();
          // .exp3.json / .motion3.json 这类双扩展名要整体匹配
          const mime = MIME[ext] && target.toLowerCase().endsWith('.exp3.json')
            ? MIME['.exp3.json']
            : target.toLowerCase().endsWith('.motion3.json')
              ? MIME['.motion3.json']
              : MIME[ext] ?? 'application/octet-stream';

          /*
           * 模型定义要在**这一层**把 VTube Studio 的登记表合并进来再交出去。
           *
           * Cubism SDK 按标准只读 `model3.json`，而大量从模型站下载的包把表情与
           * 待机动作登记在同目录的 `*.vtube.json` 里。不合并的话，`/models` 说
           * 「8 个表情」而实际一个都点不出来 —— 因为 SDK 根本没拿到那 8 条。
           *
           * 具体怎么合并在 `mergeSettingBytes()` 里，不在这儿写：那段逻辑的
           * 正确性对用户是隐形的（没合并时交出去的**依然是一个合法的模型定义**，
           * 只是少了几个表情，加载不报错、数字也对），所以它必须能被门禁直接
           * 喂一个真夹具断言 —— 而不是靠读这段源码里出现过哪些字符串。
           * 合并只在内存里做、**绝不写盘**（版权声明写着「不可二传二改」）。
           */
          const body = target.toLowerCase().endsWith('.model3.json')
            ? mergeSettingBytes(buf, target)
            : buf;

          res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': String(body.byteLength),
            'Cache-Control': 'no-cache',
          });
          res.end(body);
        } catch (error) {
          state.lastError = String(error?.message ?? error);
          sendJson(res, 500, { code: 'E_MODEL_READ_FAILED', message: '读取失败', detail: state.lastError });
        }
        return;
      }

      sendJson(res, 404, { code: 'E_ROUTE_NOT_FOUND', message: '未知路由', detail: rest });
    },
  });

  ctx.effect(() => () => {
    disposeRoute?.();
    log('Host 半区已卸载');
  }, 'live2d-pet.host.route');

  /** 给 Client 半区一个自检入口：确认 Host 活着、模型库在哪。 */
  ctx.provide('live2dPet', {
    status: () => ({ ...state }),
    modelsRoot: () => modelsRoot,
  });

  /*
   * ★ C 期：流式情绪 —— 让她的表情跟着**正在流出来的回答**走。
   *
   * ── 为什么这条链不是「又一个工具」 ────────────────────────────────────────
   *
   * `live2d_emote` 要占一次工具调用：我得停下手里的活、花一个来回、写一行
   * `{name:'开心'}`。而我说话的时候本来就在流式输出文字，那些文字里已经写着
   * 情绪（「全绿」「抱歉，我漏了」「没想到」）。`agent/assistant-stream` 是 DSH
   * 的**进程本地事件**，订阅它不花一个 token、不占一次工具调用 —— 这不是让
   * 模型更聪明地控制表情，这是**读已经存在的东西**。
   *
   * ── 判定的三件事，全在 `host/emotion-stream.js` 里（纯模块、有门禁） ─────
   *
   * 这个文件只做「什么时候看一眼」和「往哪推」：
   *   · 切句、挖掉代码块、关键词判定、节流 —— 全是纯函数；
   *   · 这里只负责把结果翻译成一条正常的 `emotion` 指令，**走和工具完全相同的
   *     那条路**（`buildAction` 校验 → `pushCommand` 入队）。这是故意的：自动
   *     情绪不该有绕过契约的特权，它的夹取、独占检查、TTL 和 AI 手动下发的
   *     那一条**逐字节相同**。
   *
   * ── 三条「不让它变成噪音」的规则（都在纯模块里，这里只是它们的动机） ────
   *
   *   1. **只跟根会话**。子 Agent 的流式文本是**我看不见的**（我派出一个子 Agent
   *      去读十个文件，它内部说的话不该写在我脸上）。判据是 `agents.roots()`
   *      里有它的 sessionId。
   *   2. **显式指令之后的静默期**。我刚调过 `live2d_emote{name:'抱歉'}`，紧接着
   *      解释「失败是为什么」——「失败」这个词会立刻盖掉那声道歉。
   *   3. **队列保护**。一次最多压两条没人取的自动情绪：这条通道是给「她跟着说」
   *      用的，不能把 `live2d_speak` 这种**真的要求她做事**的指令挤出队列
   *      （队列上限 8 条、丢最旧的）。
   *
   * ── 失败时的行为：静默，但**有账** ────────────────────────────────────────
   *
   * 事件处理函数里**绝不向外抛**（一个坏 frame 不能让 DSH 的事件总线炸掉），
   * 全部 catch 成一行日志。但「她为什么没动」必须答得出来 —— 所以每一次拒绝
   * 都记进 `state.streamEmotion.skipped[理由]`，`/status` 直接能看到。
   */
  const streamStats = {
    since: Date.now(),
    sessions: 0,
    chars: 0,
    pushes: 0,
    /**
     * 思考态推了几条（D 期）。
     *
     * 单独计数而不是并进 `pushes`：这两个数字回答的是不同的问题 ——
     * `pushes` 是「她因为我说的话动了几次」，`moodPushes` 是「她替我想了几次」。
     * 合成一个数，就没法回答「她是不是只在有情绪词的时候才活着」。
     */
    moodPushes: 0,
    last: null,
    lastScope: 'unknown',
    skipped: {},
  };
  state.streamEmotion = streamStats;

  /** 从 Agent 上取 sessionId。取不到就返回空串（= 这个事件不处理）。 */
  const streamSessionId = (agent) => {
    const id = agent?.sessionId ?? agent?.session?.id ?? agent?.id;
    return typeof id === 'string' ? id : '';
  };

  /**
   * 这个 Agent 是不是根会话？
   *
   * **取不到证据时一律返回 `true`**（宁可她多动一下，也不要因为服务不在、
   * 或者版本变了就整条链静默失效 —— 「静默失效」是这套插件里最贵的一种 bug，
   * 已经吃过一次：`param` 通道实现了却没有出口）。判成子会话时它只影响**这一条
   * 流**，而且 `lastScope` 会把判定结果写在 `/status` 里，可查。
   */
  const isRootAgent = (agent) => {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null;
    if (agents === null || typeof agents?.roots !== 'function') return true;

    let roots = null;
    try {
      roots = agents.roots();
    } catch {
      return true;
    }
    if (!Array.isArray(roots) || roots.length === 0) return true;

    const id = streamSessionId(agent);
    if (id === '') return true;
    return roots.some((candidate) => streamSessionId(candidate) === id);
  };

  /** sessionId → 一条流的缓冲与节流状态。 */
  const autoEmotionStreams = new Map();

  /*
   * 她的**状态**（D 期）。与每条流分开：脸只有一张，会话可以有很多个。
   *
   * 用 `let` 而不是塞进 `state`：状态机是纯函数（`host/mood.js`），每次转移都
   * 换一个新的对象 —— 这样「它什么时候变的」在代码里是看得见的，而不是某个
   * 字段被别处悄悄改掉。
   */
  let mood = createMood();

  /** 把一次状态转移落到 `state` 上（`/status` 与 `live2d_status` 读它）。 */
  const applyMood = (outcome, detail) => {
    if (outcome !== null && typeof outcome.mood === 'object') mood = outcome.mood;
    state.mood = {
      state: mood.state,
      since: mood.since,
      turnId: mood.turnId,
      description: describeMood(mood),
      detail: typeof detail === 'string' && detail !== '' ? detail : '',
    };
    return mood;
  };
  applyMood({ mood }, '');

  /**
   * 读之前先让状态追上时间 —— 目前只做一件事：把**过期**的「说完了」清掉。
   *
   * 状态机里唯一一条与时间有关的转移在这里被触发，而它没有别的触发者：回合的
   * 开始与结束都有事件（`start` / `end` 帧），只有「说完了之后又过了多久」没有。
   * 让两个读点各推一次：`/status`（心跳，她说话时 500ms 一拍）与 `live2d_status`
   * （我读它的那一刻，正是需要它准确的那一刻）。
   *
   * 这不是「读时顺手改状态」那种坏味道：改的是**事实**而不是**措辞** —— 一个
   * 心里想着「闲着」、嘴上说着 `settling` 的字段，比一句过期的中文更容易骗到
   * 下一轮读它的代码。`advanceMood` 不改变时**不换对象**（`changed: false`），
   * 所以一小时被读 720 次也只是看了 720 次同一份状态。
   *
   * ★ 它同时是**收思考态**的唯一时机（`advanced.release`）：说到这一步说明这一轮
   * 真的结束了、而且 8 秒里没有新的回合接上。放在这里而不是每一步结束时，是因为
   * `end` 帧是按步来的（见 `host/mood.js` 的注释）—— 逐步清脸会把我点名让她保持
   * 30 秒的情绪、和每一句自动情绪都抹掉。
   */
  const refreshMood = () => {
    const advanced = advanceMood(mood, { now: Date.now() });
    if (advanced.changed) {
      applyMood(advanced, advanced.detail);
      pushMoodRelease(advanced.release);
    }
    return mood;
  };

  const noteSkip = (reason) => {
    const key = String(reason ?? 'unknown');
    streamStats.skipped[key] = (streamStats.skipped[key] ?? 0) + 1;
  };

  /**
   * 推一条**不是**由话的内容决定的情绪（目前只有思考态）。
   *
   * 与 `pushStreamEmotion()` 走同一条通道（`emotion` 指令、同一套解析与夹取、
   * 同一个 `origin: 'stream'` 队列配额），但不碰「上一条自动情绪是什么」那笔账：
   * 思考态不是一次反应，把它记进去会让后面第一句真话被误判成「和上一条重复」。
   */
  const pushMoodEmotion = (spec) => {
    if (capabilities === null) {
      noteSkip('no-capabilities');
      return false;
    }
    const outcome = buildAction({
      kind: 'emotion',
      name: spec.name,
      intensity: spec.intensity,
      holdMs: spec.holdMs,
      attackMs: spec.attackMs,
      releaseMs: spec.releaseMs,
    }, capabilities, { bindings: resolveEmotionBindings(state.settingsPath).roles });

    if (!outcome.ok) {
      noteSkip(outcome.code);
      log(`[mood] 「${spec.name}」没能下发：${outcome.code} ${outcome.detail}`);
      return false;
    }

    pushCommand(outcome.command, 'stream');
    streamStats.moodPushes += 1;
    return true;
  };

  /**
   * ★ 推一条**「按名字收掉某几层」**（目前只有收思考态那一个名字）。
   *
   * 与 `pushMoodEmotion({name:'平静'})` 的差别就是这一步的全部意义：「平静」是一把
   * 全收，而这一步结束时该收的只有思考态那一层 —— 全收会顺手把我点名让她保持
   * 30 秒的「开心」、或者一句刚挂上不到一秒的自动情绪一起抹掉，用户看到的是
   * 「她笑了一下就收」，而日志里一个字都没有。
   *
   * 收一个当时不在场的层不算错（思考态可能已经自己到期了），渲染端会把它报在
   * `unknown` 里 —— 那正是我在 `live2d_status` 想区分的情况。
   *
   * 与思考态走同一条通道、同一个队列配额（`origin: 'stream'`）：它不是一次表达，
   * 所以不该挤掉我明确下的那几条。
   */
  const pushMoodRelease = (names) => {
    if (!Array.isArray(names) || names.length === 0) return false;
    if (capabilities === null) {
      noteSkip('no-capabilities');
      return false;
    }
    const outcome = buildAction({ kind: 'emotion', release: names }, capabilities);
    if (!outcome.ok) {
      noteSkip(outcome.code);
      log(`[mood] 收 ${names.join(' / ')} 没能下发：${outcome.code} ${outcome.detail}`);
      return false;
    }
    pushCommand(outcome.command, 'stream');
    streamStats.moodPushes += 1;
    return true;
  };

  /** 一句话说完了 —— 判定它像哪种情绪，像就推一条正常的 `emotion` 指令。 */
  const pushStreamEmotion = (stream, sentence, now) => {
    const queuedAuto = pendingCommands.filter((item) => item?.origin === 'stream').length;
    const plan = planStreamEmotion(sentence, {
      last: stream.last,
      lastPushAt: stream.lastPushAt,
      now,
      mutedUntil: state.emotionMuteUntil ?? 0,
      queueFull: queuedAuto >= MAX_QUEUED_AUTO_EMOTIONS,
      table: stream.table,
    });

    if (typeof plan.name !== 'string') {
      noteSkip(plan.skip);
      return;
    }

    if (capabilities === null) {
      // 渲染端还没上报过能力清单：没有脸可动（也说明面板没开）。
      noteSkip('no-capabilities');
      return;
    }

    const outcome = buildAction({
      kind: 'emotion',
      name: plan.name,
      intensity: plan.intensity,
      holdMs: plan.holdMs,
    }, capabilities, { bindings: resolveEmotionBindings(state.settingsPath).roles });

    if (!outcome.ok) {
      noteSkip(outcome.code);
      log(`[emotion-stream] 「${plan.name}」没能下发：${outcome.code} ${outcome.detail}`);
      return;
    }

    pushCommand(outcome.command, 'stream');
    stream.last = { name: plan.name };
    stream.lastPushAt = now;
    streamStats.pushes += 1;
    streamStats.last = {
      name: plan.name,
      keyword: plan.keyword,
      chars: plan.chars,
      holdMs: plan.holdMs,
      at: now,
    };
    streamStats.summary = describeStreamPlan(plan);
    // 脸现在归这条情绪管：状态从「思考中」翻到「情绪中」（`host/mood.js`）。
    applyMood(moodOnEmotion(mood, { now, name: plan.name }), '');
  };

  const onAssistantStream = (payload) => {
    try {
      const frame = payload?.frame;
      if (frame === null || typeof frame !== 'object') return;

      const sessionId = streamSessionId(payload?.agent);
      if (sessionId === '') return;

      const now = Date.now();

      if (frame.type === 'start') {
        /*
         * 开关与作用域都**在这一刻判定一次**：chunk 的密度是每秒几十次，
         * 在这里读文件、查 Agent 树都属于「一轮一次」的量级。
         * 代价写在这里：中途改开关要**下一轮**才生效。
         */
        const enabled = resolveAutoEmotion(cfg, state.settingsPath).value;
        const root = enabled ? isRootAgent(payload.agent) : false;
        streamStats.lastScope = enabled ? (root ? 'root' : 'child') : 'off';
        if (!enabled || !root) {
          autoEmotionStreams.delete(sessionId);
          applyMood(moodToIdle(mood, { now }), '这个回合不驱动她的脸（开关关掉了，或者这是子会话）');
          return;
        }
        /*
         * ★ D 期第一件：回合开始 → 思考态（`host/mood.js`）。
         *
         * 为什么在**这里**而不是「等她第一句话」：思考态要表达的恰恰是「还没说话
         * 的那段时间」。C 期做完之后，如果我不说带情绪词的话，她一整个回合都是
         * 静止的 —— 和掉线没有区别。
         *
         * `canThink` 的三个否决条件，每一个都对应一种「不该动」：
         *   · 能力清单还没到 —— 没有脸可动；
         *   · 显式情绪刚下过（`emotionMuteUntil`）—— 你明确要的表情，自动化系统
         *     六秒内不许盖掉；
         *   · 队列里已经压着两条自动情绪 —— 别把 `say` 挤出去。
         */
        const queuedAuto = pendingCommands.filter((item) => item?.origin === 'stream').length;
        const started = moodOnTurnStart(mood, {
          now,
          turnId: typeof frame.attemptId === 'string' ? frame.attemptId : '',
          canThink: capabilities !== null && now >= (state.emotionMuteUntil ?? 0) && queuedAuto < MAX_QUEUED_AUTO_EMOTIONS,
        });
        applyMood(started, started.detail);
        if (started.emotion !== null) {
          /*
           * ★ 只有**真的推上去了**才记「这个回合推过思考态」。
           *
           * 这个标记管的是下一件事：`end` 帧没送到（会话被切走、进程被杀）时
           * 又一个 `start` 进来，那条思考态还挂在她脸上，不该再推一条 —— 同名
           * 的层会被 `setEmotionLayers` 复用（保持时间续上），等于白占一个队列位。
           * 所以标记必须由**真的推成功**这一刻来置，不能由状态机自己猜。
           *
           * 反过来，推失败（模型没这个角色、队列满、清单还没到）就**不置**：
           * 一次失败不该让她整个进程都不再有思考态。
           */
          const pushed = pushMoodEmotion(started.emotion);
          if (pushed) applyMood({ mood: { ...mood, thinkingPushed: true } }, '');
        }
        /*
         * 关键词表**一轮定一次**（和上面的开关同一个理由：chunk 的密度是每秒
         * 几十次）。定表的时候把「实际用哪一档、要的是哪一档、加了几个词、
         * 忽略了几个词」一起记进 `/status` —— 「她为什么不认那个词」必须有一个
         * 能查的地方，否则调这张表就是盲调。
         */
        const keywordSetting = resolveKeywordSetting(cfg, state.settingsPath);
        streamStats.keywords = {
          scene: keywordSetting.scene,
          requested: keywordSetting.requested,
          words: keywordSetting.words,
          source: keywordSetting.source,
          fallback: keywordSetting.fallback,
          added: Object.values(keywordSetting.added).reduce((total, list) => total + list.length, 0),
          ignored: keywordSetting.ignored.slice(),
          description: describeKeywordTable(keywordSetting),
        };
        /*
         * ★ 只重置缓冲，**不重置节流与「上一条是什么」**（门禁抓出来的）。
         *
         * 一开始这里写的是 `last: null, lastPushAt: -Infinity`，理由是「新的一轮
         * 重新开始」。那样等于说节流只在一轮之内有效：她说完「太好了」立刻开始
         * 下一轮，第二轮的第一个句子又能马上推一次 —— 而她的脸正在走上一层的
         * 保持时间，于是同一张脸被打断两次。节流的目的是**脸不要抖**，这个目的
         * 不认「轮次」这条边界。
         */
        const previous = autoEmotionStreams.get(sessionId);
        if (previous !== undefined) autoEmotionStreams.delete(sessionId); // 挪到队尾 = LRU
        // 会话不清理，但也不能无限涨：超过上限就丢最久没用过的那个。
        while (autoEmotionStreams.size >= MAX_TRACKED_STREAMS) {
          const oldest = autoEmotionStreams.keys().next().value;
          if (oldest === undefined) break;
          autoEmotionStreams.delete(oldest);
        }
        autoEmotionStreams.set(sessionId, {
          buffer: createStreamBuffer(),
          last: previous?.last ?? null,
          lastPushAt: previous?.lastPushAt ?? -Infinity,
          at: now,
          table: keywordSetting.table,
        });
        streamStats.sessions += 1;
        return;
      }

      const stream = autoEmotionStreams.get(sessionId);
      if (stream === undefined) return;

      if (frame.type === 'end') {
        // 收尾那半句也要判：很多回答的最后一句就是情绪最强的那句。
        const tail = feedStream(stream.buffer, '', { flush: true });
        for (const sentence of tail.sentences) pushStreamEmotion(stream, sentence, now);
        /*
         * ★ D 期第二件：说完回正 —— 但**不在这里**。
         *
         * `end` 帧是**按步**来的（一步 = 我一次输出，加上它带的那些工具调用），
         * 一个回合里可以有几十步。原来在这里推一条「平静」，等于每几秒把她脸上
         * 所有东西抹一遍：我点名让她保持 30 秒的「开心」、或者一句自动情绪
         * （保持 5 秒），都活不过下一步 —— 屏幕上就是「刚笑半秒就没了」。
         *
         * 现在收在**状态真的回到 idle** 的那一刻（`refreshMood` →
         * `advanceMood().release`，也就是说完 8 秒、脸上确实不会再有人来收的时候），
         * 而且只按名字收思考态那一层。所以这里只翻状态，不动脸。
         *
         * 只在 `end` 帧翻，因为 `end` 是**唯一的终局信号**：`committed`（正常结束）
         * 与 `abandoned`（被中断/丢弃）都走这里，这正是它比「最后一段文字到了」
         * 更可靠的地方。
         */
        const ended = moodOnTurnEnd(mood, { now });
        applyMood(ended, ended.detail);
        /*
         * 结束的是**这一轮**，不是这个会话的节流状态：条目不删，只换一个新缓冲。
         * （删掉的话上面 start 处那段保留就成了空话 —— 门禁正是在这里抓到的。）
         */
        stream.buffer = createStreamBuffer();
        return;
      }

      if (frame.type !== 'chunk') return;

      const chunk = frame.chunk;
      if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'text-delta') return;
      if (typeof chunk.text !== 'string' || chunk.text === '') return;

      const fed = feedStream(stream.buffer, chunk.text);
      stream.buffer = fed.buffer;
      streamStats.chars += chunk.text.length;
      for (const sentence of fed.sentences) pushStreamEmotion(stream, sentence, now);
    } catch (error) {
      log(`[emotion-stream] 处理失败（已忽略这一帧）：${String(error?.message ?? error)}`);
    }
  };

  const disposeAssistantStream = typeof ctx.on === 'function'
    ? ctx.on('agent/assistant-stream', onAssistantStream)
    : null;

  if (disposeAssistantStream === null) {
    log('[emotion-stream] 这个 Host 没有事件总线（ctx.on 不可用），流式情绪关闭');
  }

  ctx.effect(() => () => {
    if (typeof disposeAssistantStream === 'function') disposeAssistantStream();
    autoEmotionStreams.clear();
  }, 'live2d-pet.host.emotion-stream');

  /*
   * ★ 反向通道的最后一段：把「她这会儿在不在说话」写进**运行时上下文**（D-2）。
   *
   * ── 为什么是运行时上下文，而不是又一条工具 ────────────────────────────
   *
   * 「说完了」这件事的价值全在**时机**上：等到 AI 想起来调 `live2d_status`
   * 去问的时候，该抢的话已经抢了、该等的已经白等了。运行时上下文是每走一步
   * 都会被重新装配的（`text` 是函数，每步现调），所以它问的正好是
   * 「**这一步**她还在念吗」—— 不需要任何工具调用，也就不花任何延迟。
   *
   * ── 为什么它不花 token ────────────────────────────────────────────────
   *
   * `describeSpeech()` 在她闲着且没有近况时返回 `''`，而装配器会把空文本的
   * context 整条丢掉（`dsh-system-prompt/lib/index.js` 里
   * `.filter((section) => section.text.length > 0)`）。所以这一行只在它真的会
   * 影响判断的那几秒里存在：平时她闲着，提示词里就等于没有这条。
   *
   * ── 为什么服务可能是空的 ──────────────────────────────────────────────
   *
   * `systemPrompt` 是可选依赖（`ctx.get('systemPrompt')`），宿主没装这个包时
   * 返回 undefined —— 那种情况下反向通道的**会话侧**失效，但 `/status` 与
   * `live2d_status` 照旧能读到账本。所以只记一行日志，不抛、不拦。
   */
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null;
  if (systemPrompt !== null && systemPrompt !== undefined
    && typeof systemPrompt.context === 'function') {
    const disposeSpeechContext = systemPrompt.context({
      name: SPEECH_CONTEXT_NAME,
      order: SPEECH_CONTEXT_ORDER,
      text: () => describeSpeech(state.speech, Date.now()),
    });
    ctx.effect(() => () => {
      if (typeof disposeSpeechContext === 'function') disposeSpeechContext();
    }, 'live2d-pet.host.speech-context');
  } else {
    log('[speech] 这个 Host 没有 systemPrompt 服务，朗读状态不会进运行时上下文（账本照旧可查）');
  }

  /*
   * 对话提示（§13.36）：她那一句还没说的时候，往运行时上下文里放一条
   * 「这一轮用 `live2d_speak` 回答她」的指令。
   *
   * 和上面那条朗读状态同一个技巧：`chatReplyPrompt()` 不在等的时候返回空串，
   * 而空 context 会被装配器整条丢掉 —— 平时不占 token，只在用户刚说完话、
   * 等她那句话的那一轮出现。`order` 排在朗读状态之后：先知道「她正在念上一句」，
   * 再知道「这一句该你说」。
   *
   * 动作清单（§13.36.8）也在这里喂：她要是让你「点点头」，模型得知道这个模型
   * 有哪些动作组/微动作才点得出来 —— 那份清单只有 Host 知道。
   */
  if (systemPrompt !== null && systemPrompt !== undefined
    && typeof systemPrompt.context === 'function') {
    const disposeChatContext = systemPrompt.context({
      name: 'live2d-pet-chat',
      order: SPEECH_CONTEXT_ORDER + 1,
      text: () => (chatWaiting(state.chat, Date.now())
        ? chatReplyPrompt(state.chat, Date.now(), chatStageHints())
        : ''),
    });
    ctx.effect(() => () => {
      if (typeof disposeChatContext === 'function') disposeChatContext();
    }, 'live2d-pet.host.chat-context');
  }

  if (cfg.enableAgentTools !== false) {
    registerTools(ctx, state, modelsRoot, pushCommand, () => capabilities, cfg, {
      onExplicitEmotion: (name, now) => {
        applyMood(moodOnEmotion(mood, { now, name }), `你点名了「${name}」`);
      },
      /*
       * `live2d_status` 也要能读到一个**没过期**的状态，但它是注册在
       * `registerTools()` 里的（另一个函数作用域），看不到 `apply()` 里的
       * `refreshMood` —— 所以走这个把手，而不是把状态机搬到模块级。
       * 包里是箭头函数：`refreshMood` 在这次调用之后才被 `const` 定义，
       * 但这只可能在我读 `live2d_status` 的那一刻被调用，那时它早就定义好了。
       */
      refresh: () => refreshMood(),
    }, {
      /*
       * 微动作的两个入口（§13.30）。
       *
       * 为什么不直接调 `ensureMicroMotions` / `playMicroMotionById`：那两个都在
       * `apply()` 的作用域里，而工具注册在 `registerTools()` —— 这里踩过一次，
       * 症状是工具抛 `ensureMicroMotions is not defined`，而面板那条路却是好的
       * （它在 `apply()` 里）。和上面的 `moodApi.refresh` 同一种手法：给把手，
       * 不搬状态机。
       */
      ensure: (modelId, options) => ensureMicroMotions(modelId, options),
      play: (id) => playMicroMotionById(id),
    });
  }

  return { state, modelsRoot, voicesRoot };
}

/**
 * 把渲染端上报的失败压成**一行能进 LLM 上下文**的文本。
 *
 * 为什么单独抽出来：`state.clientErrors` 里存的是 `/client-error` 收到的**原始请求体**
 * （一个 JSON 字符串）。原样拼进 `detail` 会把 `{"scope":…,"message":…,"stack":"…"}`
 * 连同换行与引号一起塞进去，一段栈就能占满半屏 —— 而这里真正要回答的只有一个问题：
 * **「她为什么不动了」**。所以只取 `scope` + `message`，其余丢掉。
 *
 * 解析失败**不抛**：这个字符串来自网络请求体，任何人都能 POST 进来，
 * 一个坏值不能让 `live2d_status` 整个工具挂掉（那是 AI 查状态的唯一入口）。
 *
 * 只报最后一条而不是全部 20 条：这些上报是**同一次故障**的重复（帧循环每 5 秒最多一条），
 * 20 条一起报只会把上下文里的其他内容挤掉。数量仍然报出来，因为「1 条」和
 * 「一直没停过」在处理上是两回事。
 *
 * ★ 自测标记（`scope === 'probe'`）单独数、单独说。
 *
 * `tools/lib/host-route-checks.mjs` 会往这条路由 POST 一条假故障来验「生产通道真的通」，
 * 而这条路由写的是 Host **内存**里的清单 —— 于是**每跑一次门禁，真机的故障清单里就多
 * 一条伪造的故障**，`live2d_status` 会把它报成「客户端错误：N 条 —— route-gate-…」。
 * 排查真卡死时（纪律：先读 `/status` 再重启，见进度快照 §8.29 教训 1）这点噪音会直接
 * 把人引到错的方向 —— 我自己就被引过一次。
 *
 * 修法**不是**过滤掉它们（那是隐瞒证据），而是让它们自报身份、然后**分开计数**：
 * 真实故障一条不少地报出来；全是自测标记时说「无」，但把条数留在括号里。
 * 这样「没有故障」与「没有在看」仍然分得开。
 */
function describeClientErrors(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length === 0) return '客户端错误：无';

  /** 判定一律解析出结构化字段，不按文本前缀猜（猜错的代价是真故障被吞掉）。 */
  const scopeOf = (entry) => {
    try {
      const scope = JSON.parse(String(entry))?.scope;
      return typeof scope === 'string' ? scope : '';
    } catch {
      return '';
    }
  };
  const probes = [];
  const liveness = [];
  const real = [];
  for (const entry of list) {
    const scope = scopeOf(entry);
    if (scope === 'probe') probes.push(entry);
    else if (LIVENESS_SCOPES.has(scope)) liveness.push(scope);
    else real.push(entry);
  }

  const parts = [];
  if (liveness.length > 0) {
    parts.push(`${liveness.length} 条存活自证 ${[...new Set(liveness)].join('、')}`);
  }
  if (probes.length > 0) parts.push(`${probes.length} 条门禁自测标记 route-gate-*`);
  const tail = parts.length === 0 ? '' : `（另有 ${parts.join('，')} —— 都不是故障）`;

  if (real.length === 0) return `客户端错误：无${tail}`;

  const last = real[real.length - 1];
  let scope = '';
  let message = '';
  try {
    const parsed = JSON.parse(String(last));
    scope = typeof parsed?.scope === 'string' ? parsed.scope : '';
    message = typeof parsed?.message === 'string' ? parsed.message : '';
  } catch {
    /* 见上：坏值退化成原文截断，不抛。 */
  }
  if (message === '') message = String(last);

  const text = `${scope === '' ? '' : `${scope}：`}${clip(message, CLIENT_ERROR_TEXT_CHARS)}`;
  return real.length === 1
    ? `客户端错误：1 条 —— ${text}${tail}`
    : `客户端错误：${real.length} 条（最后一条）—— ${text}${tail}`;
}

/** `describeClientErrors()` 里单条消息的字符上限。 */
const CLIENT_ERROR_TEXT_CHARS = 300;

/**
 * ★ 「存活自证」—— 声明自己不是故障的 scope 集合。
 *
 * 这几条走的是**同一条上报通道**，但说的都是「我跑到了 / 我拿到了像素」，不是故障。
 * 把它们混进 `real` 里计数，`live2d_status` 就会在一切正常时报「客户端错误：1 条」，
 * 而排查卡死时「有错误」与「没错误」是相反的两个方向。
 *
 * ── 为什么这条规则必须存在（2026-06 的现场） ─────────────────────────────
 *
 * 装了五道 `frame-*` 护栏之后，用户报卡死，`clientErrors` 依然是空的。空同时对应
 * 三种处境：① 真没冻；② 护栏根本没挂载（面板收起）；③ 护栏跑了但上报通道不通。
 * 分不开的原因就是**通道本身从来没有被观测过**。所以加了 `client-alive`
 * （轮询 effect 每页第一条）+ `client-stage-mounted`（舞台 effect 登记时一条）：
 * 它们一到，就说明通道是通的，于是「一条故障都没有」才是可信的。
 *
 * 判定按 `scope` 精确匹配，不按文本前缀 —— 前缀猜错会让一条**真**故障被当成自证吞掉。
 */
const LIVENESS_SCOPES = new Set(['client-alive', 'client-stage-mounted', 'frame-live']);

/**
 * 把「渲染舞台这会儿在不在」压成一句能进 `live2d_status` 的话。
 *
 * ── 它为什么必须进 `detail` ──────────────────────────────────────────────
 *
 * 五道 `frame-*` 护栏全都住在渲染舞台那个 effect 里，而面板一收起，
 * 客户端 JSX 里 `collapsed ? null : h(…, Live2DStage …)` 就把整个舞台
 * ——连同五道护栏——一起卸载。于是「零条 `frame-*` 记录」有两种完全相反的
 * 成因：*真的没事*，或者 *一个守卫都不在*。
 *
 * 我自己在这上面栽过：拿着「零条记录」当证据，去推断「画面没被重新呈现」，
 * 而当时面板很可能就是收着的。这句话存在的唯一目的，是让那种推断
 * 下一次开口之前先被这句话拦住。
 *
 * 三态而不是两态：
 * - `null`  —— 这个 Host 进程还没收到过带 `stage` 的心跳（客户端比这个
 *   Host 老）。说「不知道」，不说「不在」。
 * - `false` —— 舞台不在。此刻**任何** `frame-*` 的沉默都不构成证据。
 * - `true`  —— 舞台在，且带了它画到第几帧。此时沉默才是有意义的沉默。
 */
function describeClientStage(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.present !== 'boolean') {
    return '渲染舞台：未知（该客户端没有上报这一项）';
  }
  if (raw.present !== true) return '渲染舞台：**不在**（面板收着？—— 此刻 frame-* 的沉默不算证据）';
  const model = typeof raw.modelPath === 'string' && raw.modelPath !== '' ? raw.modelPath : '（尚未换上模型）';
  const frames = Number.isFinite(raw.frames) ? raw.frames : 0;
  /*
   * `frames` 是**单调**的累计帧数（客户端那边报的是 `host.drawnTotal`）。
   *
   * 这句话曾经是错的：客户端报过 `host.frames` —— 那是算 fps 用的
   * **500ms 窗口计数器**，每半秒归零一次。于是「已画 0 帧」既可能是
   * 「一帧都没画」，也可能只是读的时机恰好落在窗口开头；实测健康的桌宠
   * 每 5 秒采样一次会读出 25 → 20 → 16 → 8 → 0 → 25 的锯齿，那个 0
   * 与冻住一模一样。换成单调计数之后，0 只有一个意思：从挂载到现在一帧都没画。
   */
  return `渲染舞台：在（${model}，已画 ${frames} 帧）`;
}

/**
 * 「上报通道自己通不通」—— 由心跳带回来的那张账本说出来的话。
 *
 * ── 为什么这句话比前面五道护栏加起来还基础 ──────────────────────────────
 *
 * 前面所有 `frame-*` 判据的**全部价值**都建立在「话能送到」这个前提上。
 * 而那个前提我一次都没验过：门禁里那些 `route-gate-*` 是**门禁进程**发的
 * （node 的 `fetch`），只证明「Host 那条路由能收」，不证明「浏览器发得出」。
 *
 * 现场把这件事钉死了：同一个正在冻结的实例里，`clientStage` 抵达了
 * （走 `/status` 查询串），`/capabilities` 抵达了（走 fetch），
 * 而 `clientErrors` 五轮全空（走 `sendBeacon`）。
 *
 * 三态，与 `describeClientStage` 同构：
 * - `null`         —— 还没收到过账本（旧客户端）。说「不知道」。
 * - `total === 0`  —— 账本到了，但一次上报都还没发生过。此时「零条记录」
 *   仍然什么都说明不了 —— 因为没有东西可送。
 * - `total > 0`    —— 有东西送出过。这时 `delivered === 0` 才是**硬结论**：
 *   **通道坏了**，而不是「没出事」。
 */
function describeClientReport(raw) {
  if (raw === null || typeof raw !== 'object' || !Number.isFinite(raw.total)) {
    return '上报通道：未知（该客户端还没有带账本回来）';
  }
  const total = raw.total;
  const delivered = Number.isFinite(raw.delivered) ? raw.delivered : 0;
  const failed = Number.isFinite(raw.failed) ? raw.failed : 0;
  if (total === 0) return '上报通道：还在等第一条（客户端一次都还没上报过）';
  const last = typeof raw.lastScope === 'string' && raw.lastScope !== ''
    ? `最近一条 \`${raw.lastScope}\`：${typeof raw.lastMessage === 'string' ? raw.lastMessage : ''}`
    : '';
  if (delivered === 0) {
    return `上报通道：**不通** —— 客户端上报过 ${total} 次，送到 ${delivered} 次，`
      + `失败 ${failed} 次（fetch 试 ${raw.fetchTried ?? 0} 成 ${raw.fetchOk ?? 0}；`
      + `sendBeacon 试 ${raw.beaconTried ?? 0} 自称成 ${raw.beaconOk ?? 0}）。`
      + ' **此前所有「零条记录」都不能当作「没出事」** —— 话根本送不出来。'
      + (last === '' ? '' : ` ${last}`);
  }
  const busy = Number.isFinite(raw.sinceLast) && raw.sinceLast > 0
    ? `（这一拍新增 ${raw.sinceLast} 条）`
    : '';
  return `上报通道：通（上报 ${total} 次，送达 ${delivered} 次，失败 ${failed} 次）${busy}`
    + (last === '' ? '' : `；${last}`);
}

/** 截断到 `max` 个字符，**并说明截断了**（不说明的话读者会以为这就是全文）。 */
function clip(text, max) {  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max)}…（已截断，共 ${s.length} 字）`;
}

/**
 * 解析模型库根目录。
 *
 * 优先级（先命中者胜），每一步的存在理由：
 *   1. `config.modelsRoot` —— profile 的 cordis.patch.yml 里显式写的值，最高优先。
 *   2. 环境变量 `DSH_LIVE2D_MODELS_ROOT` —— 让脚本化测试能不碰任何配置文件。
 *   3. `<DSH_HOME>/live2d-pet/settings.json` 的 `modelsRoot` —— 插件自己的配置面。
 *      存在的理由很实际：desktop profile 的 cordis.patch.yml 由 Electron 应用独占
 *      （`dsh plugin --profile desktop` 会直接报 "managed exclusively by the Electron
 *      application"），所以插件必须有一条不依赖改 profile 的配置通道。
 *   4. `<DSH_HOME>/live2d-pet/models` —— 插件自有的模型库默认位置。
 *
 * 注意第 4 条刻意**不是** `process.cwd()`：实测 Electron 主进程的 cwd 是 profile
 * 目录（`…\.dsh\profiles\desktop`），在那儿建模型库既难找又会随 profile 重建而丢。
 */
function resolveModelsRoot(cfg) {
  const dshHome = process.env.DSH_HOME
    ? resolve(process.env.DSH_HOME)
    : resolve(homedir(), '.dsh');
  const home = join(dshHome, 'live2d-pet');
  const settingsPath = join(home, 'settings.json');

  if (typeof cfg.modelsRoot === 'string' && cfg.modelsRoot.trim() !== '') {
    return { path: resolve(cfg.modelsRoot), source: 'config', settingsPath };
  }

  const fromEnv = process.env.DSH_LIVE2D_MODELS_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { path: resolve(fromEnv), source: 'env', settingsPath };
  }

  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (typeof parsed?.modelsRoot === 'string' && parsed.modelsRoot.trim() !== '') {
        return { path: resolve(parsed.modelsRoot), source: 'settings.json', settingsPath };
      }
    } catch (error) {
      // 配置文件坏了不该让插件起不来——退到默认值，并把原因留给 /status。
      return { path: join(home, 'models'), source: `settings.json 解析失败: ${error?.message ?? error}`, settingsPath };
    }
  }

  /*
   * 4. 默认位置 `<DSH_HOME>/live2d-pet/models`。
   *
   * 但仓库是自带一个模型的（`models-inbox/hiyori_vts`，见 README 的第三方许可）：
   * 第一次装进来时用户的模型库目录还不存在，若一味退回默认位置，界面上会是「0 个模型」，
   * 自带的那只永远看不见。所以默认位置**不存在**时才去看插件旁边的 `models-inbox` ——
   * 一旦用户自己建了库（或导入过模型），优先级立刻回到默认位置，不会被仓库里的样例挡住。
   */
  const defaultRoot = join(home, 'models');
  if (!existsSync(defaultRoot)) {
    const bundled = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'models-inbox');
    if (existsSync(bundled)) {
      return { path: bundled, source: 'bundled', settingsPath };
    }
  }

  return { path: defaultRoot, source: 'default', settingsPath };
}

/**
 * 解析语音库根目录。
 *
 * 优先级与 `resolveModelsRoot` **一模一样**（config → 环境变量 → settings.json → 默认），
 * 一个字都不改。这不是偷懒，是「为什么 config 里设了没用」这类问题只应该有一种答案：
 * 两个目录用两套顺序，就会出现「模型库改了 settings.json 生效、语音库改了没生效」。
 *
 * 键名：`voicesRoot` / `DSH_LIVE2D_VOICES_ROOT` / `settings.json` 的 `voicesRoot`；
 * 默认 `<DSH_HOME>/live2d-pet/voices`（与 `models` 并列，同样刻意不用 cwd）。
 */
function resolveVoicesRoot(cfg) {
  const dshHome = process.env.DSH_HOME
    ? resolve(process.env.DSH_HOME)
    : resolve(homedir(), '.dsh');
  const home = join(dshHome, 'live2d-pet');
  const settingsPath = join(home, 'settings.json');

  if (typeof cfg.voicesRoot === 'string' && cfg.voicesRoot.trim() !== '') {
    return { path: resolve(cfg.voicesRoot), source: 'config', settingsPath };
  }

  const fromEnv = process.env.DSH_LIVE2D_VOICES_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { path: resolve(fromEnv), source: 'env', settingsPath };
  }

  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (typeof parsed?.voicesRoot === 'string' && parsed.voicesRoot.trim() !== '') {
        return { path: resolve(parsed.voicesRoot), source: 'settings.json', settingsPath };
      }
    } catch (error) {
      return { path: join(home, 'voices'), source: `settings.json 解析失败: ${error?.message ?? error}`, settingsPath };
    }
  }

  return { path: join(home, 'voices'), source: 'default', settingsPath };
}

/**
 * 「情绪标记是否写进对话」这个开关。
 *
 * 它回答的是一个**设计价值观**问题，不是技术问题：AI 没有情绪可「表达」——
 * 它只能给自己的文本打标签。所以整条路线的前提是**显式可检查**：她脸上是什么，
 * 对话里就读得到什么；而不是「模型偷偷设了个心情」。开关默认**开**，因为
 * 默认看不见的东西没法被审计。
 *
 * 关掉之后差别只在一处：`live2d_emote` 的返回值不再逐条列出叠了哪些参数，
 * 只留一行摘要。她脸上的表情**完全不变** —— 这个开关管的是「说不说」，
 * 不是「做不做」。
 *
 * 来源与优先级和 `resolveModelsRoot` 一致：`config.emotionMarker` →
 * 环境变量 `DSH_LIVE2D_EMOTION_MARKER` → `<DSH_HOME>/live2d-pet/settings.json`
 * 的 `emotionMarker` → 默认 `true`。
 *
 * ⚠️ **每次调用现读，不缓存**。一个需要重启 DSH 才生效的开关不是开关；
 * 而这个文件是几百字节的 JSON，读它的代价远小于一次 TTS。
 */
function resolveEmotionMarker(cfg, settingsPath) {
  return resolveBooleanSetting(cfg, settingsPath, 'emotionMarker', 'DSH_LIVE2D_EMOTION_MARKER');
}

/**
 * ★ C 期开关：流式自动情绪（订阅 `agent/assistant-stream`，按句驱动表情）。
 *
 * 与 `emotionMarker` 是两个**正交**的开关，别把它们混成一件事：
 *
 *   · `emotionMarker` 管「她做了表情之后，**对话里留不留下那一行痕迹**」；
 *   · `autoEmotion`  管「**她的脸会不会自己动**」。
 *
 * 默认 `true`，因为 C 期这条链的**全部价值**就是「不用我开口，她跟着我说的话
 * 变脸」；一个默认关闭的自动行为等于没做。但它必须**能关**，理由很实在：
 * 自动情绪是**猜的**（关键词表），而猜错的时候用户会看到她的脸表达了一个
 * 我根本没打算表达的情绪 —— 那比不动更糟。关掉它，`live2d_emote` 照旧可用，
 * 也就是说关掉的是「猜」，不是「表情」。
 *
 * 读取时机**每条流一次**（`start` frame），不是每个 chunk 一次：这是一次文件
 * 读取，而 chunk 的密度是每秒几十次。代价是**一轮回答中途改这个开关要下一轮
 * 才生效** —— 这一条写在这里，因为它是一个真实的、可观察的行为。
 */
function resolveAutoEmotion(cfg, settingsPath) {
  return resolveBooleanSetting(cfg, settingsPath, 'autoEmotion', 'DSH_LIVE2D_AUTO_EMOTION');
}

/**
 * ★ 关键词表用哪一档（`coding` / `chat` / `story`）—— 场景化。
 *
 * 优先级与两个布尔开关**完全一样**（`config` → 环境变量 → `settings.json` → 默认），
 * 不另立一套顺序：「为什么 config 里设了没用」这类问题只应该有一种答案。
 *
 * 三个要点写在代码里，而不是文档里：
 *
 *   · **档名写错不报错，回落 `coding` 并在 `fallback` 里说明。** 一个笔误不该让
 *     整条自动情绪链死掉，但也不能假装没发生 —— `/status` 与 `live2d_status`
 *     都会把「要的是 chat，没有这一档」读出来。
 *   · **追加词（`emotionKeywords`）与档一起解析。** 它们是同一件事的两半：档是
 *     底子，追加是我的话。分开解析就会出现「换了档，我加的词还在」这种错位。
 *   · **每次现读，不缓存**（与两个布尔开关一致）：改完 settings.json 刷新页面
 *     就生效，不用重启 —— 一个需要重启才能改的词表，实际上没人会去调它。
 *
 * 读取的频率：`start` 帧一次 + `live2d_status` 一次。前者是「一轮一次」的量级，
 * 后者是我主动查状态 —— 都不会落在每秒几十个 chunk 的路径上。
 */
function resolveKeywordSetting(cfg, settingsPath) {
  const readScene = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

  /** 档名从哪儿来（`config` / `env` / `settings.json` / `default`）—— 报给 `/status`。 */
  let source = 'default';
  let scene = readScene(cfg?.emotionScene);
  if (scene !== null) {
    source = 'config';
  } else {
    const fromEnv = readScene(process.env.DSH_LIVE2D_EMOTION_SCENE);
    if (fromEnv !== null) {
      scene = fromEnv;
      source = 'env';
    }
  }

  let additions = (cfg?.emotionKeywords !== null && typeof cfg?.emotionKeywords === 'object')
    ? cfg.emotionKeywords
    : null;

  if ((scene === null || additions === null) && typeof settingsPath === 'string' && existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (scene === null) {
        const fromSettings = readScene(parsed?.emotionScene);
        if (fromSettings !== null) {
          scene = fromSettings;
          source = 'settings.json';
        }
      }
      if (additions === null && parsed?.emotionKeywords !== null && typeof parsed?.emotionKeywords === 'object') {
        additions = parsed.emotionKeywords;
      }
    } catch {
      // 与 `resolveModelsRoot` 同样的处理：配置文件坏了不该让情绪链失效。
      if (source === 'default') source = 'settings.json 解析失败';
    }
  }

  return { ...resolveKeywordTable({ scene, additions }), source };
}

/**
 * 面板里攒的「角色 → 参数 id」绑定表，来自 `<DSH_HOME>/live2d-pet/settings.json`
 * 的 `emotionBindings` 字段。
 *
 * 为什么要缓存 mtime 而不是每次现读：这条链在**流式情绪**那条路径上（一句话一次），
 * 一个回合可以说几十句。几百字节的 JSON 读一次不贵，但几十次乘上每个回合就不该了。
 * 缓存键是 `路径:mtimeMs` —— 面板一保存，文件 mtime 就变，下一次解析自然换账，
 * 不需要任何「通知 Host 刷新」的协议。
 *
 * 坏文件不抛：与 `resolveKeywordSetting()` 同样的处理，配置坏了不该让情绪链失效。
 * `source` 里写明它为什么是空的，`/bindings` 会把它原样报给面板。
 */
let bindingsCache = { key: '', value: null };

function resolveEmotionBindings(settingsPath) {
  const empty = { roles: {}, ignored: [], source: 'default' };
  if (typeof settingsPath !== 'string' || !existsSync(settingsPath)) return empty;

  let key = '';
  try {
    key = `${settingsPath}:${statSync(settingsPath).mtimeMs}`;
  } catch {
    return empty;
  }
  if (bindingsCache.key === key && bindingsCache.value !== null) return bindingsCache.value;

  let value = empty;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const raw = parsed?.emotionBindings;
    if (raw !== undefined && raw !== null) {
      const normalised = normalizeEmotionBindings(raw);
      value = { ...normalised, source: 'settings.json' };
    }
  } catch (error) {
    value = { roles: {}, ignored: [], source: `settings.json 解析失败: ${error?.message ?? error}` };
  }

  bindingsCache = { key, value };
  return value;
}

/**
 * 「桌宠用什么音色、说多快」——从 `settings.json` 的 `ttsVoice` / `ttsRate` /
 * `ttsEngine` / `ttsEndpoint` 读出来，归一成一份**永远可用**的设置。
 *
 * 为什么不像布尔开关那样也接 `config` 与环境变量：
 *   这三个值是**用户对着面板挑出来的**，不是部署参数。给它们再加两级优先级，
 *   症状会是「面板上明明选了云希，念出来还是晓晓」—— 而面板正显示云希。
 *   一个偏好只该有一个来源。
 *
 * 缓存键带 mtime：面板保存后要**立刻**生效（下一条 `live2d_speak`），
 * 而用户手改文件也该同样立刻生效。几百字节的 JSON，读它比一次 TTS 便宜得多，
 * 所以这里宁可每次 stat 一次也不做「重启才生效」。
 *
 * @returns {{ voice: string, voiceSource: string, rate: string, engine: string, endpoint: string, notes: string[], source: string }}
 */
let ttsSettingsCache = { key: '', value: null };

/**
 * 音色包清单（给面板与 `/tts` 用）。
 *
 * `broken` 单独一栏，不混进 `packs`：一个放错格式的目录既不是「可用」，
 * 也不该让整个列表变成错误 —— 它需要被**看见**（用户会问「我放进去的包呢」）。
 *
 * @param {ReturnType<typeof createVoicePackStore>} store
 * @param {string} active
 */
function voicePackListing(store, active) {
  const listing = store.list();
  if (listing.ok !== true) {
    return { root: store.root, packs: [], broken: [{ dir: '', reason: listing.message }] };
  }
  return {
    root: listing.root,
    packs: listing.packs.map((pack) => ({ ...pack, active: pack.id === active })),
    broken: listing.broken,
  };
}

/**
 * 让适配层把这两份权重换进它连着的那个 GPT-SoVITS。
 *
 * 为什么不直接打 `api_v2.py`：适配层的地址才是「用户配置的那个服务」，
 * 换权重也得走同一个人 —— 否则插件可能把权重换进 A 进程，说话却发给 B 进程。
 *
 * 端点推导：用户填的是 `http://127.0.0.1:9881/tts`，权重路由在同级的 `/weights`，
 * 所以去掉末尾的 `/tts` 再加 `/weights`；没写 `/tts` 的也当成 base 处理。
 */
async function pushAdapterWeights(endpoint, sovits, gpt) {
  const base = String(endpoint).trim().replace(/\/+$/, '');
  if (base === '') {
    return { ok: false, code: 'E_PACK_NEEDS_ENDPOINT', message: '还没填自定义 TTS 的地址' };
  }
  const url = base.endsWith('/tts') ? `${base.slice(0, -'/tts'.length)}/weights` : `${base}/weights`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sovits, gpt }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return {
      ok: false,
      code: 'E_PACK_WEIGHTS_UNREACHABLE',
      message: '换权重时连不上自定义 TTS 服务',
      detail: `${url}：${error?.message ?? error}`,
    };
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false) {
    return {
      ok: false,
      code: payload?.code ?? 'E_PACK_WEIGHTS_REFUSED',
      message: payload?.detail ?? payload?.message ?? `适配层回了 HTTP ${response.status}`,
      detail: url,
    };
  }
  return { ok: true, elapsedMs: Number.isFinite(payload?.elapsedMs) ? payload.elapsedMs : 0 };
}

function resolveTtsSettings(settingsPath) {
  const fallback = { ...normalizeTtsSettings(undefined), source: 'default' };
  if (typeof settingsPath !== 'string' || !existsSync(settingsPath)) return fallback;

  let key = '';
  try {
    key = `${settingsPath}:${statSync(settingsPath).mtimeMs}`;
  } catch {
    return fallback;
  }
  if (ttsSettingsCache.key === key && ttsSettingsCache.value !== null) return ttsSettingsCache.value;

  let value = fallback;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    value = { ...normalizeTtsSettings(parsed), source: 'settings.json' };
  } catch (error) {
    value = { ...normalizeTtsSettings(undefined), source: `settings.json 解析失败: ${error?.message ?? error}` };
  }

  ttsSettingsCache = { key, value };
  return value;
}

/**
 * 布尔开关的解析器：`config` → 环境变量 → `<DSH_HOME>/live2d-pet/settings.json` → 默认 `true`。
 *
 * 抽成一个函数而不是复制两份，是因为 `emotionMarker` 与 `autoEmotion` **必须**
 * 有完全一样的优先级链 —— 「为什么 config 里设了没用」这类问题，只有在两份
 * 实现真的共用一段代码时才能靠读一遍代码回答。复制出去的两份会漂移。
 *
 * ⚠️ **每次调用现读，不缓存**。一个需要重启 DSH 才生效的开关不是开关；
 * 而这个文件是几百字节的 JSON，读它的代价远小于一次 TTS。
 */
function resolveBooleanSetting(cfg, settingsPath, configKey, envKey) {
  const read = (value) => (value === true ? true : (value === false ? false : null));

  const fromConfig = read(cfg?.[configKey]);
  if (fromConfig !== null) return { value: fromConfig, source: 'config' };

  const raw = process.env[envKey];
  const fromEnv = read(raw === '0' ? false : (raw === '1' ? true : null));
  if (fromEnv !== null) return { value: fromEnv, source: 'env' };

  if (typeof settingsPath === 'string' && existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const fromSettings = read(parsed?.[configKey]);
      if (fromSettings !== null) return { value: fromSettings, source: 'settings.json' };
    } catch {
      // 与 resolveModelsRoot 同样的处理：配置文件坏了不该让工具调用失败。
      return { value: true, source: 'settings.json 解析失败' };
    }
  }

  return { value: true, source: 'default' };
}

/**
 * 注册 `live2d_*` 工具。
 *
 * 只用**一个**诊断工具起步：它同时验证三件事——工具能被注册、Agent 能看到它、
 * Host 侧状态能回传。真正的 `live2d_speak` / `live2d_play_motion` 等要在
 * Client 半区能渲染、口型通道打通之后再加，否则就是给 LLM 一堆点了没反应的工具。
 */
function registerTools(ctx, state, modelsRoot, pushCommand, getCapabilities, cfg, moodApi, microApi) {
  const tools = ctx.get('tools');
  if (!tools) {
    ctx.logger?.warn?.('[live2d] tools 服务不可用，跳过 live2d_* 工具注册');
    return;
  }

  const rendererOnline = () => Date.now() - state.lastClientSeenAt < 15000;

  /**
   * 所有 `live2d_*` 动作工具的唯一入口。
   *
   * 校验、夹取、口型独占、TTL、队列裁剪全部发生在 `lib/host/actions.js` 里
   * （纯函数、157 项门禁）。这个包装只负责三件事：把结果翻译成人话、
   * 在失败时**把错误原样交给 LLM**（§4.1 硬规则 2：错误必须可自愈）、
   * 以及告诉它渲染端在不在线。
   *
   * 「渲染端不在线」不当作失败：指令照常入队。理由是它可能只是面板被折叠了
   * 一瞬间，而拒绝入队等于让 AI 的判断被一个 5 秒前的心跳左右。但**必须说清**
   * ——否则 AI 会以为桌宠已经在说了，而用户什么都没听到。
   */
  const dispatch = (raw) => {
    const result = buildAction(raw, getCapabilities(), { bindings: resolveEmotionBindings(state.settingsPath).roles });
    const online = rendererOnline();

    if (!result.ok) {
      return {
        detail: `没有执行这条指令：${result.detail}`,
        ok: false,
        code: result.code,
        queued: 0,
        rendererAlive: online,
      };
    }

    const pushed = pushCommand(result.command);

    /*
     * ★ 显式情绪指令之后的静默期（C 期）。
     *
     * 这条规则在防一种很具体的抢戏：我调 `live2d_emote{name:'抱歉'}` 是因为我
     * 真的要道歉，而我紧接着说出来的那句话里全是「失败」「报错」—— 流式判定会
     * 立刻把它盖成「难过」，于是那声道歉在她脸上只活了不到一秒。
     * **明确的指令优先于猜测**，所以让路的是猜测。
     *
     * 记在 `state` 上而不是某个闭包里：`/status` 会把它一起报出来，
     * 「她为什么没跟着我的话说」就有了一个可查的答案。
     *
     * ★ 静默期的长度跟着**这条情绪的寿命**走（而不是固定 6 秒）：她说 30 秒的
     * 「开心」和保持 5 秒的自动情绪，让路的时长显然不该一样。固定值的症状是
     * 「我让她保持 30 秒，6 秒后流式判定照样能盖上去」—— 而且看起来像她善变。
     * `holdMs === 0` 是「一直保持到下一个情绪」，那就取情绪层的上限。
     *
     * ★ 按名字收（`release`）的那一条**不是显式情绪**：它不该静默流式判定，也不该
     * 把状态翻成 reacting（她的脸并没有因此变成某种表情）。这里必须挡掉，否则
     * 一条「收掉思考态」会被当成「她现在的表情是 ''」。
     */
    const explicitEmotion = result.command.kind === 'emotion'
      && !(Array.isArray(result.command.payload?.emotion?.release) && result.command.payload.emotion.release.length > 0)
      ? result.command.payload?.emotion
      : null;
    if (explicitEmotion !== null && explicitEmotion !== undefined) {
      const holdMs = typeof explicitEmotion.holdMs === 'number' && isFinite(explicitEmotion.holdMs)
        ? explicitEmotion.holdMs
        : 0;
      const releaseMs = typeof explicitEmotion.releaseMs === 'number' && isFinite(explicitEmotion.releaseMs)
        ? explicitEmotion.releaseMs
        : 0;
      const alive = holdMs === 0 ? EMOTION_MAX_HOLD_MS : Math.min(holdMs, EMOTION_MAX_HOLD_MS) + releaseMs;
      state.emotionMuteUntil = Date.now() + Math.max(MUTE_AFTER_EXPLICIT_EMOTION_MS, alive);
      /*
       * 显式情绪也要翻状态（D 期）：她脸上现在是什么，由**这条**决定 ——
       * 哪怕此刻正处在一个回合里、脸上还挂着思考态，思考态也已经让位了。
       * 不翻的话 `/status` 会说她「思考中」，而她的脸明明在笑。
       *
       * 状态机住在 `apply()` 里（脸只有一张，状态是它的一部分），这里拿到的是
       * 一个**只有一个方法的把手** —— 比把整个 state 机搬到模块级、或者把可变
       * 对象塞进 `state` 都窄。
       */
      if (typeof moodApi?.onExplicitEmotion === 'function') {
        moodApi.onExplicitEmotion(explicitEmotion.name ?? '', Date.now());
      }
    }
    const notes = [];
    /*
     * ★ 丢弃 / 夹取的参数要**逐条翻成人话**，不能只报个数。
     *
     * 例如 `rate: "1'2"` —— 原来的写法只会说「丢弃了 1 个不可写的参数」，
     * 那句话里的「不可写」是给 `param` 逃生通道用的措辞，用在语速上既看不懂、
     * 也指不出该怎么改。而 §4.1 硬规则 2 要求的正是「错误必须可自愈」：
     * LLM 得知道**哪个字段、什么格式、这次是怎么处理的**。
     */
    for (const item of result.droppedParameters) {
      notes.push(item.detail ? `丢弃了 ${item.id}：${item.detail}` : `丢弃了参数 ${item.id}`);
    }
    if (result.clampedParameters.length > 0) notes.push(`夹取了 ${result.clampedParameters.length} 个超范围的参数`);
    if (pushed.dropped > 0) notes.push(`队列挤掉了 ${pushed.dropped} 条旧指令`);

    const base = result.detail !== ''
      /*
       * 有些指令会在 `result.detail` 里补充「具体叠了哪几个参数、哪些角色这个模型
       * 没有」——`emotion` 就是这样。那是 AI 唯一能知道「我这次情绪打了折扣」的
       * 地方，丢掉它，一次部分成功就变成了看不出来的完全成功。
       *
       * `emotionMarker` 开关关掉时，这条线不写进返回值：她脸上照做，只是对话里
       * 不再留痕（开关管「说不说」，不管「做不做」）。
       */
      && (result.command.kind !== 'emotion' || resolveEmotionMarker(cfg, state.settingsPath).value)
      ? `已排队：${actionSummary(result.command)}。${result.detail}`
      : `已排队：${actionSummary(result.command)}`;
    const suffix = notes.length > 0 ? `（${notes.join('，')}）` : '';
    const tail = online
      ? '渲染进程会在下一次轮询（约 1 秒内）取走。'
      : '但**渲染端当前未连接**（超过 15 秒没有心跳）——桌宠面板可能没打开，这条指令不会被看到。';

    return {
      detail: `${base}${suffix}。${tail}`,
      ok: true,
      code: '',
      queued: pushed.queued,
      rendererAlive: online,
    };
  };

  /** 6 个动作工具的输出形状完全一致，抽出来免得某一次漏掉一个字段。 */
  const ACTION_OUTPUT = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        detail: { type: 'string' },
        ok: { type: 'boolean' },
        code: { type: 'string' },
        queued: { type: 'number' },
        rendererAlive: { type: 'boolean' },
      },
      required: ['detail'],
    },
    /*
     * ★ `render(args, value)` 的**第二个参数才是工具的返回值**。
     *
     * 这里原来写的是 `(args) => String(args.detail ?? '')`，交回去的永远是空字符串
     * —— `args` 是**调用入参**（`{ name: '脸红', holdMs: 4000 }`），里面没有 `detail`。
     * 后果：桌宠照做，而 AI **什么都看不到**，连「渲染端当前未连接」那句专门写来
     * 防止 AI 误以为话已经说出口的警告也一起丢掉。
     */
    render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }],
  };

  tools.register({
    name: 'live2d_status',
    description:
      'Check whether the Live2D desktop pet plugin is alive and where its model library lives. '
      + 'Use it before any other live2d_* tool to confirm the renderer is running.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          detail: { type: 'string' },
          modelsRoot: { type: 'string' },
          modelsRootExists: { type: 'boolean' },
          rendererAlive: { type: 'boolean' },
          capabilitiesSummary: { type: 'string' },
          capabilitiesDetail: { type: 'string' },
          /*
           * 微动作摘要（§13.26）。**必须申报**：这个 schema 是
           * `additionalProperties: false`，漏一个键整条工具就失败（见下面
           * `clientErrors` 那次事故的注释）。
           */
          microMotion: {
            type: 'object',
            additionalProperties: false,
            properties: {
              model: { type: 'string' },
              source: { type: 'string' },
              gestures: { type: 'number' },
              enabled: { type: 'number' },
              strength: { type: 'number' },
              summary: { type: 'string' },
            },
            required: ['source', 'gestures', 'summary'],
          },
          /*
           * 关键词表的当前状态。**必须登记在这个 schema 里**：它是
           * `additionalProperties: false`，漏一个字段的后果就是那条
           * `tool "live2d_status" returned invalid output: "value.xxx"`
           * —— 工具照跑，AI 只收到一句「返回不合法」（§8.x 记过一次）。
           */
          emotionKeywords: {
            type: 'object',
            additionalProperties: false,
            properties: {
              scene: { type: 'string' },
              requested: { type: 'string' },
              words: { type: 'number' },
              source: { type: 'string' },
              fallback: { type: 'boolean' },
              ignored: { type: 'array', items: { type: 'string' } },
              description: { type: 'string' },
              scenes: { type: 'array', items: { type: 'string' } },
            },
            required: ['scene', 'words', 'source', 'description'],
          },
        },
        required: ['detail'],
      },
      /*
     * ★ `render(args, value)` 的**第二个参数才是工具的返回值**。
     *
     * 这里原来写的是 `(args) => String(args.detail ?? '')`，交回去的永远是空字符串
     * —— `args` 是**调用入参**（`{ name: '脸红', holdMs: 4000 }`），里面没有 `detail`。
     * 后果：桌宠照做，而 AI **什么都看不到**，连「渲染端当前未连接」那句专门写来
     * 防止 AI 误以为话已经说出口的警告也一起丢掉。
     */
    render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }],
    },
    execute: async () => {
      const lib = state.library;
      const libraryText = lib === null
        ? '模型库还没被扫描过'
        : `模型库里有 ${lib.total} 个模型（${lib.ok} 个可用${lib.broken > 0 ? `，${lib.broken} 个有问题` : ''}）`;

      /*
       * ★ 清单本体从 `getCapabilities()` 拿，**不是**闭包里的 `capabilities`。
       *
       * 这里曾经写的就是 `capabilities`，而那是插件 `apply()` 作用域里的一个
       * `let`，`registerTools()` 根本看不见它 —— 于是这个工具**每一次调用都抛
       * `ReferenceError: capabilities is not defined`**。它偏偏是工具描述里让 AI
       * 「动手之前先调一次」的那一个，所以症状是「AI 一上来就撞一个莫名其妙的错」。
       *
       * 门禁没抓住它的原因值得记一笔：`simulate-host-boot.mjs` 逐个执行了其余
       * 五个 `live2d_*` 工具，唯独 `live2d_status` 只断言了「注册过」（见那一行
       * `注册了 live2d_status 与 live2d_speak 两个工具`）—— **「注册了」不等于
       * 「能调」**。现在那一段会遍历 `env.tools` 全部执行一遍。
       */
      const caps = getCapabilities();
      const online = rendererOnline();

      /*
       * 能力清单也要带出来 —— 它是「AI 能控制什么」的唯一事实来源，而 AI 在
       * 动手之前先调一次 `live2d_status` 是最自然的顺序。把它放在这里而不是
       * 单独开一个工具：少一个工具就少一次「AI 忘了先查」的机会。
       *
       * 注意 `capabilitiesSummary === null` 与「空清单」是两件不同的事：
       * 前者是「还没读到」（页面没开 / 模型没加载完），后者是「模型确实没有
       * 表情和动作」。措辞必须分开，否则 AI 会把「稍后再试」当成「做不到」。
       */
      const capsText = state.capabilitiesSummary === null
        ? '能力清单还没读到（渲染端没报过）'
        : `能力清单：${state.capabilitiesSummary}`;

      /*
       * ★ 渲染端上报的失败要**跟着状态一起回到会话里**。
       *
       * 起因：`miku` 跑一段时间后整个画面冻住，面板上的 fps 停在最后一帧、
       * 没有弹窗、也没有任何地方能看见原因 —— 客户端为此加了帧循环 try/catch 与
       * 停摆看门狗（`src/client/plugin.ts` 的 `frame` / `frame-stall`），
       * 但如果这些上报只躺在 `/status` 的 JSON 里，AI 依然看不到，
       * 那次复现就白复现了。`live2d_status` 是 AI 唯一会主动查的状态入口，
       * 所以它必须把这件事说出来。
       *
       * 措辞刻意做成「N 条」而不是「无」：`0 条` 与「渲染端没上报过」是两件事，
       * 而后者在 `rendererAlive` 里已经说了，不在这里混为一谈。
       *
       * ★ 原文**只放这一句**里，不另开一个 `clientErrors` 字段 —— 两个原因：
       *
       * ① `render()` 只交回 `value.detail`，所以**没进 `detail` 的东西 AI 一个字
       *    都读不到**。多带的字段不会「顺便」让人看见，它只是躺在返回值里。
       * ② 这个工具的 `output.schema` 是 `additionalProperties: false`，
       *    多一个没申报的键会让工具**整个失败**（不是被忽略）——
       *    曾经真的这么坏过一次：AI 那边收到的是
       *    `tool "live2d_status" returned invalid output: "value.clientErrors"
       *    is not a declared property`，而门禁全绿，因为它只调 `execute()`
       *    与 `render()`，**从不拿 schema 校验返回值**。
       */
      const clientErrorText = describeClientErrors(state.clientErrors);

      /*
       * ★ 「舞台在不在」必须紧挨着错误条数说。
       *
       * 顺序是有意的：先报「有几条记录」，紧跟一句「此刻有没有人在记录」。
       * 反过来（先舞台、后记录）读起来像是两个不相干的事实，而它们其实是
       * 同一个判断的两半 —— 零条记录意味着什么，取决于舞台在不在。
       */
      const clientStageText = describeClientStage(state.clientStage);
      /*
       * ★ 顺序有意：先报「有几条故障」，紧接着报「舞台在不在」，最后报
       * 「送故障的那条路通不通」。三句连起来才是一句完整的话 ——
       * 「零条故障」在最后那句说「不通」的时候，一个字都不能信。
       */
      const clientReportText = describeClientReport(state.clientReport);
      /*
       * ★ D 期：她的**状态**要能读。
       *
       * 与「情绪」是两件事，所以写成独立的一句而不是并进上面那句：情绪是脸上
       * 此刻叠着什么，状态是「她在想 / 在说 / 说完了」。这一句是回答「她为什么不
       * 动」的第一手证据 —— 没有它，静止的脸和掉线的脸长得一模一样。
       *
       * 读之前先让状态追上时间（`moodApi.refresh` → `advanceMood`）：我把这一句读
       * 出来的时候，正是需要它准确的那一刻 —— 上一次心跳可能在几秒前。没有这一步，
       * 一个离开一晚之后再问「她怎么样了」的人会读到「说完了（脸上的东西正在自己
       * 化掉）」。走把手而不是直接调 `refreshMood()`：这一段在 `registerTools()`
       * 里，看不见 `apply()` 的局部函数（写错会是一个只有真跑才暴露的 ReferenceError）。
       */
      if (typeof moodApi?.refresh === 'function') moodApi.refresh();
      const moodText = typeof state.mood?.description === 'string' && state.mood.description !== ''
        ? state.mood.description
        : '闲着';
      /*
       * ★ D-2：朗读状态同样要能读。
       *
       * 与 `moodText` 分开写，因为它们是两个不同的问题：状态答「她在想什么」，
       * 这一句答「她的嘴这会儿在不在动」。同一条信息也走运行时上下文
       * （每步自动装配），但**这里也必须有一份** —— 它是不进提示词的那条
       * 按需入口：AI 想确认「她到底说完没有」时可以主动查一次，
       * 而不是只能等下一步的上下文。
       */
      const speechText = speechSummary(state.speech, Date.now());
      /*
       * ★ 关键词表：她现在按哪一档认我的情绪、那一档有多少词。
       *
       * 这一句回答的是「她为什么不动」的**第二个**答案（第一个是 mood 与 speech）：
       * 脸没动可能不是链断了，而是这一档表里没有我刚说的那个词。**现读一次配置**
       * 而不是读 `streamEmotion.keywords`（那个是上一轮 start 帧的快照）：我查的
       * 是「此刻的配置会造成什么」，不是「上一轮用了什么」。
       */
      const keywordSetting = resolveKeywordSetting(cfg, state.settingsPath);
      const keywordText = `${describeKeywordTable(keywordSetting)}，来源 ${keywordSetting.source}`;

      /*
       * 微动作摘要（§13.26）。两种「没有」必须分开：还没生成（模型刚上、或者
       * 渲染端没报过清单）与生成不出来（这个模型没有骨骼参数）—— 前者过一会儿就有，
       * 后者永远不会有，AI 的下一句话完全不同。
       */
      const microText = (state.microMotion?.gestures ?? 0) > 0
        ? `微动作 ${state.microMotion.gestures} 条（启用 ${state.microMotion.enabled}，强度 ${state.microMotion.strength}）`
        : (state.microMotion?.lastError === 'E_MICRO_NO_GESTURES'
          ? '微动作：这个模型生成不出（没有可用的骨骼参数）'
          : '微动作：还没生成（等渲染端上报能力清单）');

      return {
        detail: `live2d-pet ${state.version}：模型库 ${modelsRoot}（${state.modelsRootExists ? '存在' : '不存在'}），`
          + `${libraryText}，`
          + `渲染端 ${online ? '在线' : '未连接'}，`
          + `${capsText}，`
          + clientErrorText
          + `，${clientStageText}`
          + `，${clientReportText}`
          + `，她${moodText}`
          + `，${speechText}`
          + `，${microText}`
          + `，关键词表 ${keywordText}`,
        modelsRoot,
        modelsRootExists: state.modelsRootExists,
        rendererAlive: online,
        capabilitiesSummary: state.capabilitiesSummary ?? '',
        capabilitiesDetail: caps === null ? '' : describeCapabilities(caps),
        /*
         * 微动作摘要（§13.26）。AI 不需要知道每一条的幅度，但它需要知道
         * 「她会不会自己动」以及「哪些动作因为模型没那个部位而消失」——
         * 否则用户问「她怎么不歪头了」时，它只能猜。
         */
        microMotion: {
          model: state.microMotion?.model ?? '',
          source: state.microMotion?.source ?? 'none',
          gestures: state.microMotion?.gestures ?? 0,
          enabled: state.microMotion?.enabled ?? 0,
          strength: state.microMotion?.strength ?? 0,
          summary: state.microMotion?.summary ?? '',
        },
        emotionKeywords: {
          scene: keywordSetting.scene,
          requested: keywordSetting.requested,
          words: keywordSetting.words,
          source: keywordSetting.source,
          fallback: keywordSetting.fallback,
          ignored: keywordSetting.ignored,
          description: keywordText,
          scenes: SCENE_NAMES,
        },
      };
    },
  });

  tools.register({
    name: 'live2d_speak',
    description:
      'Make the Live2D desktop pet say something out loud. The text is synthesized to speech '
      + 'on the host (Edge-TTS) and played by the renderer, with the mouth driven by the audio '
      + 'envelope. Use it when the user asks the pet to talk, or when a short spoken line adds '
      + 'value. Keep lines short (one or two sentences): this is a pet on the desktop, not a '
      + 'narrator. Returns as soon as the line is queued — it does NOT wait for playback to end.',
    parameters: {
      type: 'object',
      properties: {
        /*
         * 上限**拼进描述里**，不写死 2000。
         *
         * 这句话是给 LLM 看的「广告」，而广告与实现必须来自同一个数字：
         * 描述里写 2000、`buildAction()` 按 `MAX_TEXT_CHARS` 拒，两份一旦
         * 分叉，LLM 会照着描述交一段它以为合法的文本然后被拒 —— 与 P3 收尾
         * 查出来的那批「工具广告了却兑现不了」的缺陷是同一个形状，只是方向反过来
         * （这一次是实现真的能收，广告说的比它能收的少）。
         */
        text: { type: 'string', description: `要念出来的文本（中文或英文），1–${MAX_TEXT_CHARS} 字。` },
        voice: {
          type: 'string',
          description:
            '可选音色 ShortName，例如 "zh-CN-XiaoxiaoNeural"（默认）、"zh-CN-YunxiNeural"（男声）、'
            + '"zh-CN-YunjianNeural"（男声，适合解说）。**必须是连字符分段的短标识符**；'
            + '写成 "xiaoxiao" 或 "晓晓" 这种会被当成格式错误丢掉，那一句仍会念，但用默认音色。',
        },
        rate: {
          type: 'string',
          description:
            "可选语速，必须写成百分比，例如 '+15%'（快一点）、'-10%'（慢一点）、'+0%'（默认）。"
            + '格式不对（比如 "fast" 或 "1.5"）会被丢掉，那一句仍会念，但用默认语速。',
        },
        interrupt: {
          type: 'boolean',
          description:
            '是否打断她正在说的话（默认 true）。默认值同时也意味着「忘掉还没轮到的那几句」—— '
            + '所以如果你要她连着说几句，请在第一句之后都传 false，否则只有最后一句会被听到。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: ACTION_OUTPUT,
    execute: async (args) => dispatch({
      kind: 'say',
      text: args?.text,
      voice: args?.voice,
      rate: args?.rate,
      interrupt: args?.interrupt,
    }),
  });

  /*
   * 下面五个工具是 P3「AI 控制闭环」的其余部分（方案 §4.1 的契约表）。
   *
   * 每一个的参数名都**逐字**照抄方案文档：`group` / `index` / `fadeMs` / `loop`、
   * `name` / `weight` / `holdMs`、`x` / `y` / `durationMs`。改名看起来更自然
   * （`motionGroup`？）但方案 §4.1 是已经冻结的契约，而契约的价值全在于
   * 两边叫同一个名字。
   */
  tools.register({
    name: 'live2d_play_motion',
    description:
      'Play one of the pet\'s built-in motions. Call live2d_status first to see which motion '
      + 'groups this model actually has — the group name must match exactly. Omitting `index` '
      + 'picks a random motion from the group. Returns immediately; the motion plays in the '
      + 'background and does not block speech.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '动作组名，例如 Idle 或 TapBody。必须与能力清单里的完全一致。' },
        index: { type: 'number', description: '组内序号，从 0 开始。省略则随机挑一个。' },
        fadeMs: { type: 'number', description: '淡入淡出时长（毫秒），默认 300，上限 5000。' },
        loop: { type: 'boolean', description: '是否循环播放，默认 false。' },
      },
      required: ['group'],
      additionalProperties: false,
    },
    output: ACTION_OUTPUT,
    execute: async (args) => dispatch({
      kind: 'motion',
      group: args?.group,
      index: args?.index,
      fadeMs: args?.fadeMs,
      loop: args?.loop,
    }),
  });

  tools.register({
    name: 'live2d_set_expression',
    description:
      'Set the pet\'s facial expression by name. The name must match exactly one of the '
      + 'expressions listed by live2d_status — expressions are authored per model, so do not '
      + 'guess names like "smile" or "happy". If the name is wrong the tool returns the full '
      + 'list of expressions that DO exist, so you can retry with a real one.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '表达式名。必须与能力清单里的完全一致（大小写敏感）。' },
        // 契约表里的 weight 刻意没有暴露：Framework 不支持按权重混合单个表情，
        // 参数会一路传到底然后什么都不发生且不报错。详见方案 §4.2.8。
        holdMs: { type: 'number', description: '保持多少毫秒后回到默认表情。0（默认）表示一直保持。' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: ACTION_OUTPUT,
    execute: async (args) => dispatch({
      kind: 'expression',
      name: args?.name,
      holdMs: args?.holdMs,
    }),
  });

  tools.register({
    name: 'live2d_look_at',
    description:
      // ⚠️ 这一句原来写的是「(-1 = her left, +1 = her right)」—— 那是**反的**。
      // 真机实测（2026-02，hiyori）：x=+1 让她朝**屏幕右侧**转，也就是她自己的左边。
      // 符号跟着 Live2D 官方 `lappmodel.ts` 的系数走（`ParamAngleX` 取正），
      // 参照系是**看的人**，不是她的身体。改说明而不是改符号：符号一旦在插件里
      // 翻一次，它就和官方样本对不上了，以后没人说得清哪一层是正的。
      'Make the pet look in a direction. x is horizontal: +1 turns her toward the RIGHT SIDE '
      + 'OF THE SCREEN, -1 toward the left side. The sign follows Live2D\'s own convention '
      + '(ParamAngleX > 0) and is measured FROM THE VIEWER — because she faces you, screen-right '
      + 'is HER OWN left. She holds the angle until you send another look; send (0, 0) to bring '
      + 'her back to centre. y is vertical (-1 = down, +1 = up). Use it to make the pet glance '
      + 'toward something, or to acknowledge the user. Works on any model — models without '
      + 'eye/head parameters simply do nothing.',
    parameters: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: '水平方向，-1 到 1。+1 = 朝屏幕右侧转（= 她自己的左边），'
            + '-1 = 朝屏幕左侧转（= 她自己的右边）。',
        },
        y: { type: 'number', description: '垂直方向，-1 到 1（-1 向下、+1 向上）。' },
        durationMs: {
          type: 'number',
          description: '**转过去**的时长（毫秒），默认 400，上限 5000。'
            + '转完她会保持在这个角度，所以这不是「保持多久」。',
        },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    output: ACTION_OUTPUT,
    execute: async (args) => dispatch({
      kind: 'look',
      x: args?.x,
      y: args?.y,
      durationMs: args?.durationMs,
    }),
  });

  tools.register({
    name: 'live2d_emote',
    description:
      // 这个工具是「AI 当操控者」的第一个落地点：它让 AI 用**情绪词**说话，
      // 而不是用参数名。描述里的清单由 emotions.js 生成，所以加了新情绪
      // 不会出现「代码里有、描述里没有」。
      'Give the pet a feeling — pick the emotion that matches what you are saying, and she wears '
      + 'it while you talk. This is the tool to reach for mid-conversation; it needs no parameter '
      + 'names and no model knowledge. '
      + 'Emotions are ADDITIVE: they layer on top of blinking, breathing and whatever motion is '
      + 'playing, so she keeps living while she feels (a hard parameter write would freeze her '
      + 'blink). The mouth is off limits — it belongs to the speech channel — so a smile is built '
      + 'from eyes, brows and cheeks. Send "平静" (or "neutral") to clear the layer. '
      + `Available: ${emotionCatalogText()}. `
      + 'English aliases work too: happy, curious, thinking, serious, surprised, sorry, sad, '
      + 'proud, neutral. '
      + 'Emotions a model cannot express (it may lack the cheek or brow parameters) are skipped '
      + 'and named in the result — read that line, it is the only place a partial success shows up.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: `情绪名（中文），或用英文别名。可用：${emotionNames().join(' / ')}。`,
        },
        intensity: {
          type: 'number',
          description: '强度 0–1.5，默认 1。想「克制一点」就用 0.5。',
        },
        holdMs: {
          type: 'number',
          description: '保持多少毫秒后淡出，默认 2500，上限 30000。0 = 一直保持到你换一个情绪。',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: ACTION_OUTPUT,
    execute: async (args) => dispatch({
      kind: 'emotion',
      name: args?.name,
      intensity: args?.intensity,
      holdMs: args?.holdMs,
    }),
  });

  tools.register({
    name: 'live2d_micro_motion',
    description:
      /*
       * 「点名演一条」（§13.30）。
       *
       * 与 `live2d_emote` 的分工：情绪是**状态**（她保持一种心情），微动作是
       * **一个瞬间**（歪一下头就回正）。自动播放本来就按节奏挑，这个工具的
       * 价值在于「现在，就这一条」—— 演示、配合某句话、或者用户点了「试演」。
       */
      'Play ONE specific micro-motion right now — a small gesture (a head tilt, a body turn, '
      + 'a glance) that lasts under two seconds and returns to rest by itself. '
      + 'The pack is generated per model from its own parameters, so ids are model-specific: '
      + 'call this tool with no id first to list what this model has. '
      + 'Ids look like "head-tilt" or "glance-left"; the label in the result is the Chinese name. '
      + 'Use live2d_emote for a feeling that should last; use this for a single beat. '
      + 'Micro-motions also play on their own while idle and while speaking — this tool is for '
      + '"now, that one", not for starting them.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '微动作 id（kebab-case，来自这个模型的包）。省略时只列出可用的 id 与中文名，不演。',
        },
      },
      additionalProperties: false,
    },
    output: ACTION_OUTPUT,
    execute: async (args) => {
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      if (typeof microApi?.ensure !== 'function' || typeof microApi?.play !== 'function') {
        return {
          detail: '这个 Host 还没有接上微动作（重启 DSH 之后才有）。',
          ok: false,
          code: 'E_MICRO_NOT_WIRED',
          queued: 0,
          rendererAlive: rendererOnline(),
        };
      }
      if (id === '') {
        const view = microApi.ensure(state.activeModelId, {});
        if (view.ok !== true) {
          return {
            detail: `${view.message ?? '还拿不到这个模型的微动作包。'}`,
            ok: false,
            code: view.code ?? 'E_MICRO_NOT_FOUND',
            queued: 0,
            rendererAlive: rendererOnline(),
          };
        }
        const lines = view.gestures.map((gesture) => {
          const modes = Array.isArray(gesture.modes) ? gesture.modes.join('/') : '';
          const state = gesture.enabled === false ? '，已关闭' : '';
          return `${gesture.id} —— ${gesture.label}（${modes}${state}）`;
        });
        return {
          detail: `这个模型有 ${lines.length} 条微动作：\n${lines.join('\n')}`,
          ok: true,
          code: '',
          queued: 0,
          rendererAlive: rendererOnline(),
        };
      }
      const played = microApi.play(id);
      if (played.ok !== true) {
        const available = Array.isArray(played.available) && played.available.length > 0
          ? ` 可用：${played.available.map((entry) => entry.id).join('、')}。`
          : '';
        return {
          detail: `${played.message ?? '没演成'}${available}`,
          ok: false,
          code: played.code ?? 'E_MICRO_PLAY_FAILED',
          queued: 0,
          rendererAlive: rendererOnline(),
        };
      }
      const off = played.enabled === false
        ? '（这一条在面板里是关着的 —— 显式点名仍然演，自动播放不会挑它）'
        : '';
      const tail = played.rendererAlive
        ? '渲染进程会在下一次轮询（约 1 秒内）取走。'
        : '但**渲染端当前未连接**（超过 15 秒没有心跳）——这一条不会被看到。';
      return {
        detail: `已排队：${played.label}（${played.id}）${off}。${tail}`,
        ok: true,
        code: '',
        queued: played.queued,
        rendererAlive: played.rendererAlive,
      };
    },
  });

  tools.register({
    name: 'live2d_param',
    description:
      /*
       * 逃生通道。它存在的前提是「情绪词不够用」：情绪层是按**角色**（眼睛笑 /
       * 眉毛 / 脸颊）写的，换模型照样成立；参数名是**模型专属**的，写错一个
       * 字母就什么都不发生。所以第一句就是「平时别用它」。
       *
       * 反过来说，它做得到情绪层做不到的事：情绪层是加法（叠在眨眼之上），
       * 而有些指令本来就要**压住**眨眼 —— 「把眼睛闭上」就是。硬写是这里
       * 唯一的正确答案，也是这里唯一的危险，所以描述里两件事都写清楚。
       */
      'ESCAPE HATCH — write raw Live2D parameters directly. Reach for live2d_emote first: it takes '
      + 'an emotion word and survives a model swap, while parameter names are model-specific, so '
      + 'look them up with live2d_list_capabilities before naming one (a name this model does not '
      + 'have is dropped and reported, never silently ignored). '
      + 'This is a HARD write — it lands last every frame and covers blinking, breathing and the '
      + 'face curves of whatever motion is playing. That is the point for "hold her eyes closed" '
      + '(additive emotion cannot pin an eye shut, because the blink keeps writing 1.0 underneath), '
      + 'and the reason it must not be used for a feeling. '
      + 'Values are absolute targets, not deltas, and are clamped to the range the model declares. '
      + 'The mouth (ParamMouthOpenY / ParamMouthForm) belongs to the speech channel and can never '
      + 'be written here. The write releases itself after holdMs.',
    parameters: {
      type: 'object',
      properties: {
        params: {
          type: 'object',
          description: '参数名 → 目标值（**绝对值，不是增量**）。例：{"ParamEyeLOpen": 0, "ParamEyeROpen": 0}。',
          additionalProperties: { type: 'number' },
        },
        holdMs: {
          type: 'number',
          description: '保持多少毫秒后自动释放，默认 4000，范围 100–60000。要「一直闭着」就一次给到 60000。',
        },
      },
      required: ['params'],
      additionalProperties: false,
    },
    output: ACTION_OUTPUT,
    /*
     * `holdMs` 直接当指令的 `ttlMs` 传下去 —— 这不是偷懒：渲染端本来就是拿
     * 指令自己的 TTL 当参数保持时长的（`action-runner.ts` 的 `case 'param'`，
     * 注释写着「一条 4 秒的指令不该把参数钉上一辈子」）。所以这里传 TTL，
     * 顺带白拿 `normalizeTtl()` 那层范围校验（100–60000）。
     */
    execute: async (args) => dispatch({
      kind: 'param',
      params: args?.params,
      ttlMs: args?.holdMs,
    }),
  });

  tools.register({
    name: 'live2d_stop_speaking',
    description:
      'Stop the pet mid-sentence immediately: audio goes silent and the mouth closes within '
      + 'one frame. Also clears anything already queued. Use it when the user interrupts, or '
      + 'when you need to say something else right now.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: ACTION_OUTPUT,
    // priority 100 = §4.1 的「必须立即执行」。这是唯一一个自带打断语义的工具，
    // 所以它不通过 `interrupt` 参数表达，而是直接在指令里定优先级。
    execute: async () => dispatch({ kind: 'stop', priority: 100 }),
  });

  tools.register({
    name: 'live2d_list_capabilities',
    description:
      'List exactly what the current model can do: its expressions, motion groups, hit areas '
      + 'and parameters. Use this before live2d_set_expression or live2d_play_motion when you '
      + 'are not sure which names exist. Unlike live2d_status, this returns the full list rather '
      + 'than a summary.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          detail: { type: 'string' },
          model: { type: 'string' },
          expressions: { type: 'array', items: { type: 'string' } },
          motionGroups: { type: 'array', items: { type: 'string' } },
          parameterCount: { type: 'number' },
        },
        required: ['detail'],
      },
      /*
     * ★ `render(args, value)` 的**第二个参数才是工具的返回值**。
     *
     * 这里原来写的是 `(args) => String(args.detail ?? '')`，交回去的永远是空字符串
     * —— `args` 是**调用入参**（`{ name: '脸红', holdMs: 4000 }`），里面没有 `detail`。
     * 后果：桌宠照做，而 AI **什么都看不到**，连「渲染端当前未连接」那句专门写来
     * 防止 AI 误以为话已经说出口的警告也一起丢掉。
     */
    render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }],
    },
    execute: async () => {
      const caps = getCapabilities();
      if (caps === null) {
        return {
          detail: '还没读到当前模型的能力清单 —— 桌宠面板可能没打开，或者模型还在加载。'
            + '稍后再试；如果一直这样，先调 live2d_status 看渲染端是否在线。',
          model: state.activeModelId,
          expressions: [],
          motionGroups: [],
          parameterCount: 0,
        };
      }
      return {
        detail: describeCapabilities(caps, { maxParameters: 64 }),
        model: state.activeModelId,
        expressions: caps.expressions.map((item) => item.name),
        motionGroups: caps.motionGroups.map((item) => `${item.name}(${item.count} 个动作)`),
        parameterCount: caps.parameters.length,
      };
    },
  });
}

/**
 * 惰性加载 TTS 适配器。
 *
 * **这是刻意的，不是绕远路。** 客户端 bundle 的白屏事故（§9.2）根因是「插件在求值期
 * 依赖了一个还没到位的全局」；Host 半区是同一个形状的风险，只是后果轻一些——模块
 * 在求值期抛错，Cordis 会判定这个 entry 导入失败，**整个插件不激活**，桌宠直接消失，
 * 而且日志里只有一行 `failed to import`。
 *
 * 所以 `lib/host/edge-tts.js` 不写进文件顶部的 import，改成第一次真正要合成时才加载。
 * 这样它的依赖（`ws`、`node:crypto`）出任何问题，爆炸半径都被限制在 `/speak` 这一个
 * 路由上：桌宠照常渲染，只是说话报错，而错误信息会原样回给渲染进程与日志。
 *
 * 失败后把 promise 清空，让下一次请求可以重试——否则一次瞬时故障会永久废掉这个路由。
 */
let ttsModulePromise = null;

function loadTtsModule() {
  if (ttsModulePromise === null) {
    ttsModulePromise = import('./host/edge-tts.js').catch((error) => {
      ttsModulePromise = null;
      throw error;
    });
  }
  return ttsModulePromise;
}

/**
 * 读完整请求体，带硬上限。
 *
 * 只在 `/client-error` 用得到；上限是为了不让一个坏掉的渲染进程把 Host 内存灌满。
 */
async function readBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) return `(请求体超过 ${limitBytes} 字节，已截断)`;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 读完整请求体为 Buffer，超限**抛异常**而不是截断。
 *
 * 与上面的 `readBody` 是两个不同契约，不能合并：那条路是 `/client-error`
 * 的错误上报口，**截断比失败有用**（有前半段报错信息总比什么都没有好）；
 * 而二进制上传截断的后果是「一个看起来合法、实际上末尾少了几百 KB 的 zip」，
 * 它会被 CRC 校验拦下，但报出来的错是「文件损坏」—— 把「包太大」这个
 * 真实原因伪装成了「你的包坏了」，用户会去反复重新下载。
 *
 * 知道 `Content-Length` 时预分配一整块再往里拷：一个 190MB 的上传如果先攒
 * 一堆 chunk 再 `Buffer.concat`，峰值内存是两倍（380MB），而预分配是一次。
 */
async function readBodyBuffer(req, limitBytes) {
  const declared = Number(req.headers['content-length']);
  const known = Number.isFinite(declared) && declared >= 0 ? declared : null;
  if (known !== null && known > limitBytes) {
    throw bodyError('E_BODY_TOO_LARGE', `声明长度 ${known} 字节 > 上限 ${limitBytes}`);
  }

  const target = known !== null ? Buffer.allocUnsafe(known) : null;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw bodyError('E_BODY_TOO_LARGE', `实际收到 ${total} 字节 > 上限 ${limitBytes}`);
    }
    if (target !== null) chunk.copy(target, total - chunk.length);
    else chunks.push(chunk);
  }
  if (target !== null) return target.subarray(0, total);
  return Buffer.concat(chunks);
}

/** 带稳定 `code` 的请求体错误 —— 路由据此区分「包太大」与「读取失败」。 */
function bodyError(code, detail) {
  const error = new Error(detail);
  error.code = code;
  return error;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * 静态文件回应（Core、shader 走这里）。
 *
 * 这两个是**不可变**资源：带 ETag 之外的强缓存没有意义（Core 换了版本就是换了
 * 文件），所以只发 no-cache + 长度，让浏览器每次回源校验一次的代价换掉「改了
 * 文件却还在跑旧代码」这类难查问题。
 */
function sendFile(res, absolutePath, contentType) {
  if (!existsSync(absolutePath)) {
    return sendJson(res, 404, { code: 'E_ASSET_MISSING', message: '资源不存在', detail: absolutePath });
  }
  return readFile(absolutePath)
    .then((buf) => {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': String(buf.byteLength),
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    })
    .catch((error) => {
      sendJson(res, 500, { code: 'E_ASSET_READ_FAILED', message: '资源读取失败', detail: String(error?.message ?? error) });
    });
}
