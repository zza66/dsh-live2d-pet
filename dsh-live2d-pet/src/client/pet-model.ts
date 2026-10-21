/**
 * PetModel —— Live2D Cubism SDK for Web 5-r.5 的最小可用渲染封装。
 *
 * 加载顺序（顺序本身是有约束的，不能随便调换）：
 *
 *   1. `CubismFramework.startUp(new Option())` → `CubismFramework.initialize()`
 *      全局各一次（模块级 flag 守住），必须在碰任何 Framework 类之前完成。
 *   2. 装 shader 补丁：`CubismShader_WebGL.prototype.loadShader` 被换成从
 *      `SHADER_SOURCES`（build.mjs 内联的 13 个 .vert/.frag 源码）按 basename
 *      取字符串。**13 个 shader 因此完全不发 HTTP 请求**，离线也能跑，也不受
 *      Host 的 `/shaders` 路由是否已重载影响。
 *   3. `generateShaders()` 是**异步**的：它只启动 Promise，立刻返回，真正的
 *      编译在微任务之后。Framework 没有暴露 "await ready" 的 promise，
 *      只能轮询 `_isShaderLoaded`（并确认 program 真的编译出来），带超时。
 *      不轮询的后果不是报错而是**静默不画**：renderer 内部
 *      `drawMeshWebGL` 在 `_isShaderLoaded == false` 时直接 return。
 *   4. 建 renderer → 上传纹理 → 绑到 renderer → 建物理/姿态/眨眼/呼吸 → ready。
 *
 * 两个非常隐蔽的约束（踩过一次就不要再踩）：
 *
 *  - **shader 补丁必须先于 renderer 创建**：`CubismRenderer_WebGL.startUp()`
 *    会 `setGlContext(gl)` 注册实例，随后 `loadShaders()` 才去 `generateShaders()`。
 *    补丁装晚了，13 个 shader 就会沿用 Framework 默认的
 *    `'../../Framework/Shaders/WebGL/'` 去 `fetch()` 一个不存在的相对路径，
 *    而失败是**静默**的（见下）。
 *
 *  - **shader 加载失败不会 reject**：`loadShaders()` 里每个文件的 `.catch`
 *    把源码写成 `''`，外层 Promise 照样 resolve，于是 `_isShaderLoaded` 变成
 *    true 但 program 全编译失败。所以轮询必须检查 program 句柄是否有效，
 *    不能只看那个 boolean。
 *
 * 另外：渲染器必须是**预乘 alpha**。`setupShaderProgramForDrawable` 第一行就是
 * `if (!renderer.isPremultipliedAlpha()) CubismLogError('NoPremultipliedAlpha is not allowed')`，
 * 所以纹理上传要用 `UNPACK_PREMULTIPLY_ALPHA_WEBGL = 1`，并且
 * `renderer.setIsPremultipliedAlpha(true)`。
 */

// Framework 源码**随包分发**（`framework/src`，SDK for Web 5-r.5，Open Software
// License）。刻意不用 `../../../work/sdk5/...`：那个目录是工作区里的解压产物，
// 既不随插件发布，也会让 esbuild 把包外的文件打进来。
import { CubismFramework, Option } from '../../framework/src/live2dcubismframework';
import { CubismUserModel } from '../../framework/src/model/cubismusermodel';
import { CubismModelSettingJson } from '../../framework/src/cubismmodelsettingjson';
import { CubismMatrix44 } from '../../framework/src/math/cubismmatrix44';
import { CubismShader_WebGL, CubismShaderManager_WebGL } from '../../framework/src/rendering/cubismshader_webgl';
import { CubismEyeBlink } from '../../framework/src/effect/cubismeyeblink';
import { CubismBreath, BreathParameterData } from '../../framework/src/effect/cubismbreath';
import { CubismUpdateScheduler } from '../../framework/src/motion/cubismupdatescheduler';
// CubismUpdateOrder 住在 icubismupdater.ts，**不在**各个 updater 文件里。
// 但它也用不上了：每个 Updater 的构造函数都把 executionOrder 默认成自己那个顺序，
// 所以下面全部只传 (updater 实体)，顺序由各自的默认值决定。
import { CubismEyeBlinkUpdater } from '../../framework/src/motion/cubismeyeblinkupdater';
import { CubismBreathUpdater } from '../../framework/src/motion/cubismbreathupdater';
import { CubismPhysicsUpdater } from '../../framework/src/motion/cubismphysicsupdater';
import { CubismPoseUpdater } from '../../framework/src/motion/cubismposeupdater';
import { CubismExpressionUpdater } from '../../framework/src/motion/cubismexpressionupdater';
import { CubismLookUpdater } from '../../framework/src/motion/cubismlookupdater';
import { CubismLook, LookParameterData } from '../../framework/src/effect/cubismlook';
import { CubismTargetPoint } from '../../framework/src/math/cubismtargetpoint';
import { ACubismMotion } from '../../framework/src/motion/acubismmotion';
import type { CubismMotion } from '../../framework/src/motion/cubismmotion';
// 参数 ID 的句柄类型。`getId()` 返回的就是它 —— 手写 `ReturnType<...>` 很容易少剥一层。
import type { CubismIdHandle } from '../../framework/src/id/cubismid';
// 13 个 shader 的源码由 build.mjs 内联进来，替代 Framework 默认的 fetch()。
import { SHADER_SOURCES } from 'virtual:live2d-shaders';
// 动作里的部件透明度曲线（`Target: "PartOpacity"`）。Framework 会**静默丢掉**它们，
// 详见 `part-curves.ts` 顶部那段；hiyori 的「四只手」就是它们被丢掉的后果。
import { parseMotionPartOpacity, motionTimeAt, partOpacitiesAt } from './part-curves';
import type { MotionPartOpacity } from './part-curves';
import { reportFailure } from './report';

/*
 * 能力清单（`model:capabilities`，方案文档 §4.3）的拼接逻辑。
 *
 * ★ 注意这个 import 的方向是「客户端引用 Host 半区的文件」—— 刻意的。
 * `lib/host/capabilities.js` 被写成零依赖、不碰 node: 内置模块的纯 ESM，
 * 就是为了让两边共用同一份实现：Host 归一化网线上来的清单时用的也是它，
 * 于是「清单长什么样」不可能出现两种理解。esbuild 会把它内联进客户端 bundle。
 *
 * 反过来说：谁要是在那个文件里加了一句 `import fs from 'node:fs'`，
 * `node build.mjs` 会当场失败 —— 这是刻意选的失败方式（构建时炸，
 * 而不是运行时让桌宠消失，见 §9.2）。
 */
import { buildCapabilities } from '../../lib/host/capabilities.js';
import type { Capabilities } from '../../lib/host/capabilities.js';
import { expressionFileTable, motionFileTable, resolveMotionFades } from '../../lib/host/capabilities.js';
// 夹取范围与 Host 的 `buildAction()` **取自同一份常量**，不是碰巧一样：
// 两边各写一个 5000 的话，某天 Host 放宽到 8000 而这里没跟着改，症状是
// 「AI 要 8 秒淡入，实际 5 秒」—— 一个没人会去查的差异。
import { DEFAULT_FADE_MS, MAX_FADE_MS, MAX_HOLD_MS, isExclusiveParameter } from '../../lib/host/actions.js';
import {
  EMOTION_ATTACK_MS,
  EMOTION_CLEAR_FADE_MS,
  EMOTION_DEFAULT_HOLD_MS,
  EMOTION_MAX_FADE_MS,
  EMOTION_DECAY_MS,
  EMOTION_MAX_HOLD_MS,
  EMOTION_RELEASE_MS,
  EMOTION_SWITCH_FADE_MS,
  advanceEmotionLayers,
  ambientDriftValues,
  clearEmotionLayers,
  createEmotionLayers,
  describeEmotionLayers,
  releaseEmotionLayers,
  resolveAmbientDrift,
  setEmotionLayers,
} from '../../lib/host/emotions.js';
import { FRAMEWORK_PRIORITY, isBusyWithRealMotion } from './action-runner';
import {
  THINKING_LAYER_NAME,
  advanceCalm,
  calmFactorFor,
  calmTargetFor,
  dampTowardDefault,
  shouldDampMotion,
} from './motion-calm';
import {
  GARNISH_ABORT_DELAY_MS,
  GARNISH_GAZE_ALLOWED_OFFSET,
  GARNISH_MAX_STEP_MS,
  createGarnishState,
  garnishValues,
  nextDelayMs,
  pickGesture,
  type GarnishState,
} from './idle-garnish';
import { createLookTween, glideTo, isSettled, jumpTo, stepLookTween, type LookTweenState } from './look-tween';
import {
  createMicroMotionState,
  microMotionValues,
  normalizeMicroMotionPack,
  startMicroMotion,
  type MicroMotionPack,
  type MicroMotionState,
} from './micro-motion';
import { clampStageView, isDefaultStageView, stageViewToNdc, type StageView } from './stage-view';
import { fetchWithTimeout } from './fetch-timeout';

/** baseUrl 前面拼相对路径用。框架里没有等价物，自己写。 */
function joinRelativePath(prefix: string, relativePath: string): string {
  if (relativePath.length === 0) {
    return prefix;
  }
  const left = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const right = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return left + right;
}

/**
 * 把相对路径编成可用的 URL。
 *
 * 必须是**按段**做，而不是整体 `encodeURI`：这套模型的纹理路径里有带空格的目录
 * （`空 - 免费版.8192/texture_00.png`）和中文文件名。逐段处理既能处理空格，
 * 也不会把路径分隔符一起编掉。
 *
 * 坑：`encodeURIComponent('%20') === '%2520'`。来源字符串如果**已经**被编过
 * （或者本来就写着 `%20`），再编一次就是双重编码，HTTP 上表现为 404。
 * 所以每段先 `decodeURIComponent` 归一化再编码 —— 对源头带 `%20` 的路径幂等。
 * （`decodeURIComponent` 遇到孤立的 `%` 会抛，那就退回按裸串处理。）
 */
function encodeUrlPath(url: string): string {
  // 只处理路径部分，query/hash 原样留着。
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const hash = hashIndex < 0 ? '' : url.slice(hashIndex);

  const queryIndex = withoutHash.indexOf('?');
  const path = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : withoutHash.slice(queryIndex);

  const encodedPath = path
    .split('/')
    .map(segment => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // 不是合法的百分号编码，按原样编。
      }
      return encodeURIComponent(decoded);
    })
    .join('/');

  return encodedPath + query + hash;
}

/** 取 Asset 的完整 URL。 */
function resolveAssetUrl(baseUrl: string, relativePath: string): string {
  return encodeUrlPath(joinRelativePath(baseUrl, relativePath));
}

/** fetch 成 ArrayBuffer。非 2xx 直接抛，附带状态码。 */
async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return await response.arrayBuffer();
}

/** fetch 成文本（model3.json 走这条，方便报错）。 */
async function fetchText(url: string): Promise<string> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

/** JS 的字符串长度算的是 UTF-16 码元，这里只需要"有没有内容"，够了。 */
function isNonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 判断 program 句柄是否有效。
 *
 * `loadShaderProgram()` 编译失败时返回 `null`，成功时返回 WebGLProgram **对象**。
 * WebGL1 里 `gl.createProgram()` 拿到的是对象、清掉之后是 null，
 * 所以"是不是对象"就够判定了。
 */
function isValidProgram(program: unknown): boolean {
  return program !== null && program !== undefined && typeof program === 'object';
}

/** shader 轮询上限。13 个 shader 是内联的，编译本身很快，10s 只是兜底。 */
const SHADER_LOAD_TIMEOUT_MS = 10000;

/** 单帧 dt 上限，防止页面切回来时物理一次性炸开。 */
const MAX_DELTA_SECONDS = 0.1;

/**
 * `stopMotion()` 里重复调用框架 `stopAllMotions()` 的次数上限。
 *
 * 框架那个函数删不干净（见 `stopMotion()` 的注释），所以要循环调用把队列抽干。
 * 每一轮至少删掉一条，队列长度有限，所以实际轮数远小于这个数 —— 它只是防御性的，
 * 防止将来框架改成另一种"删不完"的形状时变成死循环。
 */
const MAX_MOTION_QUEUE_DRAIN = 64;

/**
 * 纹理长边上限。
 *
 * 官方的 8192×8192 纹理在这里必须降下来：RGBA 一张就是 256 MB，
 * 这个测试模型有三张（768 MB），中端集显直接 OUT_OF_MEMORY，
 * 而桌宠卡片上模型总共才画几百像素高 —— 8192 的细节一个像素都用不上。
 * 2048 对桌宠尺寸而言仍有 4 倍以上的余量。
 */
const MAX_TEXTURE_LONG_SIDE = 2048;

/**
 * 只从 PNG 头里读出宽高，不解码像素。
 *
 * PNG 结构固定：8 字节签名 + 4 字节长度 + "IHDR" + 4 字节宽 + 4 字节高，
 * 所以宽在 offset 16、高在 offset 20，都是**大端** uint32。
 * 先拿到尺寸才能在解码**之前**决定要不要缩，这是省下 256 MB 的关键。
 */
function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) {
    return null;
  }
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (!isPng) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) {
    return null;
  }
  return { width, height };
}

/**
 * 兜底缩放：把已经解码的图缩到目标尺寸再上传。
 *
 * 只在 `createImageBitmap(blob, {resize…})` 不可用时才走到这里 —— 这条路径
 * 已经实打实解码过一张原图了，省不回内存，所以它是兜底而不是主路径。
 */
function downscaleToCanvas(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('2d context unavailable');
  }
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

/** 参数 ID 缓存用：`CubismFramework.getIdManager().getId()` 每次都会建新对象，缓存一下。 */
const CACHED_PARAM_IDS: Map<string, CubismIdHandle> = new Map();

function cachedId(id: string): CubismIdHandle {
  let value = CACHED_PARAM_IDS.get(id);
  if (value === undefined) {
    value = CubismFramework.getIdManager().getId(id);
    CACHED_PARAM_IDS.set(id, value);
  }
  return value;
}

/** 模型 3.json 的原始结构。SDK 5-r.5 的 CubismModelSettingJson 没有暴露 DisplayInfo / Motions（用不上），自己解析。 */
interface RawModel3Json {
  Version?: number;
  FileReferences?: {
    Moc?: string;
    Textures?: string[];
    Physics?: string;
    Pose?: string;
    Motions?: Record<
      string,
      Array<{ File?: string; FadeInTime?: number; FadeOutTime?: number }>
    >;
    Expressions?: Array<{ Name?: string; File?: string }>;
  };
  Groups?: Array<{ Name?: string; Ids?: string[] }>;
  Layout?: Record<string, number>;
}

/**
 * 口型参数 id。
 *
 * 放在这里而不是让调用方写字符串字面量：这两个名字是**模型侧的约定**，不是配置。
 * 这个模型（以及绝大多数 Cubism 官方导出模型）用的是 Cubism 标准的
 * `ParamMouthOpenY`（0 = 闭嘴，1 = 最大张开）与 `ParamMouthForm`（-1 = 撇嘴，1 = 笑）。
 * 若某个模型没有这两个参数，`setParameterValue` 会静默忽略 —— 但那正是
 * `hasParameter()` 存在的理由：让调用方能问一句「这个模型到底有没有嘴」。
 */
export const MOUTH_OPEN_PARAMETER_ID = 'ParamMouthOpenY';
export const MOUTH_FORM_PARAMETER_ID = 'ParamMouthForm';

/**
 * 动作/表情加载失败时的**返回形状**。
 *
 * 为什么不抛异常：这些方法的调用方是「每 1.2 秒轮询 `/pending` 的那条循环」。
 * 那条循环跑在 React 的 effect 里，抛出去就是整个外壳一起白屏（§9.2）。
 * 而且「动作文件坏了」是个**局部**故障 —— 该被忽略掉、记一行日志，而不是
 * 让桌宠从屏幕上消失。所以失败是返回值，不是异常。
 */
export interface MotionResult {
  ok: boolean;
  code: string;
  detail: string;
  /** 这一次真正播的是组内第几号（§13.31；自动待机靠它避开重演）。 */
  motionIndex?: number;
  /** 这一条的片段时长（毫秒，一个循环的长度）。读不到时为 `undefined`。 */
  motionDurationMs?: number;
}

/*
 * 注意：`model3.json` 里 `FadeInTime` / `FadeOutTime` 的解读（含「没写时用 0.3 秒」）
 * 已经搬到 `lib/host/capabilities.js` 的 `readFadeSeconds()` / `motionFileTable()`，
 * 与能力清单共用同一份 —— 见 `_collectMotionFiles()` 的注释。
 */

/**
 * 动作优先级。数字来自官方示例 `lappmodel.ts` 的 `LAppDefine`
 * （`PriorityNone = 0` / `PriorityIdle = 1` / `PriorityNormal = 2` / `PriorityForce = 3`）。
 *
 * 它和 §4.1 的指令优先级（50 / 100）**不是同一个东西**，别混：
 * 那边决定「这条指令要不要打断上一条」，这边是**框架记在账上的一个数字**。
 * 指令层已经把该拦的拦掉了，所以到这里统一用 `NORMAL`。
 *
 * ⚠️ 这个数字**不参与「谁能盖住谁」的判断**：`playMotion()` 调的是
 * `CubismMotionManager.startMotionPriority()`，而它只是把值记进 `_currentPriority`
 * 之后**无条件**开播（`framework/src/motion/cubismmotionmanager.ts:62-74`）——
 * 会拦人的是官方 `LAppModel` 包装里的 `reserveMotion()`，我们没走那一层。
 * 所以任何一段动作都会顶掉任何一段动作。详见方案 §4.2.12。
 *
 * 它的实际用途是**被读回来**：`currentMotionPriority()` 把这个数字交给自动待机，
 * 让待机分得清「现在播的是我自己挑的待机动作」与「现在播的是 AI 要的动作」。
 */
export const MOTION_PRIORITY = Object.freeze({ NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 });

/** 视线跟随的六个参数与官方示例 `lappmodel.ts:428-447` 逐字一致 —— 这些系数是调过的。 */
const LOOK_PARAMETER_FACTORS: Array<[string, number, number, number]> = [
  ['ParamAngleX', 30.0, 0.0, 0.0],
  ['ParamAngleY', 0.0, 30.0, 0.0],
  ['ParamAngleZ', 0.0, 0.0, -30.0],
  ['ParamBodyAngleX', 10.0, 0.0, 0.0],
  ['ParamEyeBallX', 1.0, 0.0, 0.0],
  ['ParamEyeBallY', 0.0, 1.0, 0.0],
];

export interface PetModelHost {
  /** Base URL prefix; every asset path from the model3.json is resolved as baseUrl + relativePath. */
  baseUrl: string;
  /** Shader directory URL prefix, ending with '/'. */
  shaderUrl: string;
}

/** 失败时给宿主看的错误码，放在 message 最前面，宿主直接 `startsWith` 取。 */
export class PetModelError extends Error {
  public readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'PetModelError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 模块级状态：整个进程只初始化一次 Framework，以及它是否已经启动成功。
// ---------------------------------------------------------------------------

let frameworkReady = false;
let frameworkBootPromise: Promise<void> | null = null;
let shaderPatchInstalled = false;

/** 从任意形态的路径里取文件名（Framework 传进来的是 `shaderDir + 文件名`）。 */
function shaderFileNameOf(url: unknown): string {
  const text = typeof url === 'string' ? url : String(url ?? '');
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return slash >= 0 ? text.slice(slash + 1) : text;
}

/**
 * 把 `CubismShader_WebGL.prototype.loadShader` 换成读内联表。
 *
 * **为什么非改不可**：Framework 原版是
 * `private async loadShader(url) { const r = await fetch(url); return await r.text(); }`，
 * 而 `loadShaders()` 拼出来的 `url` 是 `this._shaderPath + 文件名`，
 * 默认值 `'../../Framework/Shaders/WebGL/'` 在插件里必然是 404。想走 HTTP 就得让
 * Host 提供 `/shaders/<name>` 路由 —— 而 Host 半区改动要重启 DSH 才生效，
 * 等于把「能不能渲染」绑死在一次重启上。
 *
 * 内联之后：13 个 shader 一次 HTTP 都不发，离线可用，`setShaderPath()` 也彻底失去意义。
 * **必须在建 renderer 之前调用**（renderer.startUp → setGlContext → loadShaders →
 * generateShaders，链上第一次就会用到这个补丁）。
 */
function installShaderPatch(): void {
  if (shaderPatchInstalled) {
    return;
  }
  shaderPatchInstalled = true;

  const proto = CubismShader_WebGL.prototype as unknown as {
    loadShader: (url: string) => Promise<string>;
  };

  proto.loadShader = (url: string): Promise<string> => {
    const fileName = shaderFileNameOf(url);
    const source = Object.prototype.hasOwnProperty.call(SHADER_SOURCES, fileName)
      ? SHADER_SOURCES[fileName]
      : undefined;
    if (typeof source !== 'string' || source.length === 0) {
      // 保持 Promise 形状：Framework 侧是按 `loadShader(...).then(...)` 调的。
      return Promise.reject(
        new Error(`E_SHADER_LOAD_FAILED: 内联表里没有 "${fileName}"（共 ${Object.keys(SHADER_SOURCES).length} 个）`),
      );
    }
    return Promise.resolve(source);
  };
}

/**
 * 幂等地把 shader 实例拿到手。
 *
 * `getShader(gl)` 在没注册过的时候返回 `undefined`（不是 null），必须先
 * `setGlContext(gl)` 建实例，再拿。
 */
function acquireShader(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  installShaderPatch();

  const manager = CubismShaderManager_WebGL.getInstance();
  let shader = manager.getShader(gl as WebGLRenderingContext);
  if (shader === undefined || shader === null) {
    manager.setGlContext(gl as WebGLRenderingContext);
    shader = manager.getShader(gl as WebGLRenderingContext);
  }
  if (shader === undefined || shader === null) {
    throw new PetModelError('E_SHADER_LOAD_FAILED', 'CubismShaderManager_WebGL 未能为本 GL 上下文创建 shader 实例');
  }
  return shader;
}

/**
 * 等 shader 真的编译完。
 *
 * `_isShaderLoaded` 是 public 字段（不是方法），但它**不足以**判定成功：
 * 13 个文件任一失败时 `.catch` 会把源码写成 `''`，Promise 链照样 resolve，
 * 于是 boolean 为 true 而 program 全是 0。所以两个条件都查。
 */
async function waitForShaders(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  timeoutMs: number,
): Promise<void> {
  const shader = acquireShader(gl);

  // `generateShaders()` 是 5-r.5 的公开入口；`loadShaders()` 是私有方法，只作兜底。
  // 私有是 TS 的编译期限制、运行时照样能调 —— 所以走一次窄化 cast，而不是删掉兜底：
  // 官方若在下一版改名，多这一条就少一次「静默不画」的排查。
  const shaderApi = shader as unknown as { generateShaders?: () => void; loadShaders?: () => void };
  if (typeof shaderApi.generateShaders === 'function') {
    shaderApi.generateShaders();
  } else if (typeof shaderApi.loadShaders === 'function') {
    shaderApi.loadShaders();
  }

  const started = Date.now();
  for (;;) {
    const sets = shader._shaderSets;
    const loaded = shader._isShaderLoaded === true;
    let compiled = 0;
    if (Array.isArray(sets)) {
      for (const set of sets) {
        // loadShaderProgram 失败时返回 null，成功时是 WebGLProgram 对象。
        if (set !== undefined && set !== null && isValidProgram(set.shaderProgram)) {
          compiled += 1;
        }
      }
    }
    if (loaded && compiled > 0) {
      return;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new PetModelError(
        'E_SHADER_LOAD_FAILED',
        `shader 编译超时 ${timeoutMs}ms（内联表 ${Object.keys(SHADER_SOURCES).length} 个文件，` +
          `loaded=${loaded}, compiledPrograms=${compiled}, expected=${sets === undefined ? 0 : sets.length}）`,
      );
    }
    await new Promise<void>(resolve => {
      // 16ms ≈ 一帧，别把主线程烧了。
      window.setTimeout(resolve, 16);
    });
  }
}

// ---------------------------------------------------------------------------
// TimedLookTarget：把视线速度从框架手里拿回来
// ---------------------------------------------------------------------------

/**
 * `CubismTargetPoint` 的替身：位置不再是「按固定加速度逼近目标」，而是
 * 「在 `durationMs` 毫秒里走完」（时间线在 `look-tween.ts`，纯函数、有门禁）。
 *
 * 为什么必须有这么一层：框架那套的转头速度是写死的（`faceParamMaxV = 40/10`，
 * 约 4 单位/秒，另有 0.15 秒加速），`set()` 只设目标点。于是 `durationMs: 100`
 * 与 `durationMs: 5000` 在画面上完全一样 —— 「慢慢转过去」根本表达不出来。
 *
 * 为什么是子类而不是改框架：`framework/` 是官方 SDK 的复制品，
 * `tools/sync-vendor.mjs --check` 会逐字节校验。`_dragManager` 在基类里是
 * `protected`，子类可以替换它。
 *
 * 每帧由框架的 `CubismLookUpdater.onLateUpdate()` 调 `update(deltaTimeSeconds)`，
 * 紧接着读 `getX()` / `getY()` 加进 `ParamAngleX/Y/Z` 等参数 —— 所以只要这两个
 * 读函数返回时间线上的值，整条链就通了。
 */
class TimedLookTarget extends CubismTargetPoint {
  private readonly _tween: LookTweenState = createLookTween();

  /** 转向 `(x, y)`，走 `durationMs` 毫秒（省略时用契约默认值 400）。 */
  public glideTo(x: number, y: number, durationMs?: number): void {
    glideTo(this._tween, x, y, durationMs);
  }

  /**
   * 覆写基类的 `set()`：立刻到位，不走时间线。
   *
   * 基类的 `setDrag(x, y)` 走这里，语义是「鼠标拖到哪就看哪」，本来就该是
   * 即时的。我们自己不调它（`lookAt()` 走 `glideTo()`），但既然基类把这个口
   * 开着，就不能让它落进一个没人维护的分支。
   */
  public override set(x: number, y: number): void {
    jumpTo(this._tween, x, y);
  }

  /** 推进时间线。`deltaTimeSeconds` 是秒（框架的约定）。 */
  public override update(deltaTimeSeconds: number): void {
    const ms =
      typeof deltaTimeSeconds === 'number' && isFinite(deltaTimeSeconds) && deltaTimeSeconds > 0
        ? deltaTimeSeconds * 1000
        : 0;
    stepLookTween(this._tween, ms);
  }

  public override getX(): number {
    return this._tween.x;
  }

  public override getY(): number {
    return this._tween.y;
  }

  /**
   * 这一趟转完了没有。
   *
   * 唯一的读者是待机小动作：正在转的途中不该再往同一个参数上叠偏移 ——
   * 那会让 `look_at` 的落点偏一点，而落点是契约里承诺过的东西。
   */
  public settled(): boolean {
    return isSettled(this._tween);
  }
}

// ---------------------------------------------------------------------------
// PetModel
// ---------------------------------------------------------------------------

export class PetModel extends CubismUserModel {
  private readonly _gl: WebGLRenderingContext | WebGL2RenderingContext;
  private _shaderUrl: string;
  private readonly _scheduler: CubismUpdateScheduler;

  /** 自己上传的纹理，release() 时要删 —— renderer 只解绑，不删。 */
  private _ownedTextures: WebGLTexture[] = [];

  private _ready = false;
  private _released = false;
  private _elapsed = 0;
  private _lastError: Error | null = null;

  /**
   * 上一帧动作有没有真正更新过参数。
   *
   * 唯一的使用者是 `CubismEyeBlinkUpdater`：动作在播时不该叠加眨眼，否则
   * 动作里精心做的眼眶关键帧会被程序化眨眼盖掉。
   */
  private _motionUpdated = false;

  /**
   * 参数 id → index 的缓存。
   *
   * 宿主是**每帧**读写 `ParamMouthOpenY` 的，不能每次都 O(n) 扫一遍参数表
   * （这个模型参数不少）。model 在 load() 里建，一帧一次查表的模式很稳定。
   */
  private _parameterIndexCache: Map<string, number> | null = null;

  /**
   * 宿主每帧写入的口型覆盖值。
   *
   * 为什么需要「覆盖」而不是让宿主直接调 `setParameterValue`：`update()` 的**第一件事**
   * 是 `model.loadParameters()`，它会把参数表刷回上一帧 `saveParameters()` 存下的状态。
   * 所以宿主在 `update()` 之前写进去的值会被冲掉，在 `update()` 之后写又太晚 ——
   * Cubism Core 是把参数烘焙进顶点状态之后才画的，晚一帧写等于一直慢一帧。
   * 唯一的正确位置在 `update()` 内部、`model.update()` 之前，于是需要一个入口把它带进去。
   */
  private _mouthOverride: { openness: number; form: number | null } | null = null;

  /**
   * 我们自己解析出来的 `.model3.json` 原文。
   *
   * 留着它不是「顺便」：能力清单里的表情 / 动作组 / 可点区域只能从这里读
   * （`FileReferences.Expressions` / `FileReferences.Motions` / `HitAreas`），
   * 而 Framework 的 `CubismModelSettingJson` 只暴露它自己定义的那几个访问器，
   * 拿不到「所有动作组的名字与条数」这种完整列表。见 `capabilities()`。
   */
  private _rawSettings: RawModel3Json | null = null;

  /**
   * 动作的「眨眼 / 口型目标参数」id（从 `model3.json` 的 `Groups` 里读）。
   *
   * ★★ 这两个数组**不是可选的装饰**，而是动作能不能跑起来的前提。
   * 框架的 `CubismMotion` 构造函数把 `_eyeBlinkParameterIds` / `_lipSyncParameterIds`
   * 都设成 `null`（`framework/src/motion/cubismmotion.ts:781-796`），
   * 而 `doUpdateParameters()` 一进来就读它们的 `.length`（同文件 `:404` / `:410`），
   * **没有 null 保护**；唯一的写入者是 `setEffectIds()`（`:770-776`）。
   * 也就是说：`loadMotion()` 造出来的动作天生是不能更新的，
   * 谁忘了调 `setEffectIds()`，谁就会在第一个动作进队列之后每帧抛
   * `TypeError: Cannot read properties of null (reading 'length')`。
   *
   * 缓存起来：`Groups` 在 `load()` 里才到位，而 `_effectIds()` 可能在那之前被问到。
   * 取不到就给**空数组**（空数组的 `.length` 是 0，安全；`null` 会每帧抛）。
   */
  private _effectIdsCache: { eyeBlink: CubismIdHandle[]; lipSync: CubismIdHandle[] } | null = null;

  // ---- 动作与表情（P3） ----

  /**
   * 动作文件的**清单**（不加载）。键是动作组名，值是「组内第 N 个动作」的
   * 相对路径与淡入淡出时间。
   *
   * 清单与内容分开是刻意的：一个模型可以带几十个动作文件，而一次会话里真正常用的
   * 只有 idle 加一两个。全量预加载会让「切到这只模型」变慢，还会因为**某一个**
   * 动作文件坏掉而让整只模型加载失败 —— 那是个糟糕的取舍，因为动作坏掉只影响
   * 一个动作，模型本身是好的。
   */
  private _motionFiles = new Map<
    string,
    Array<{ file: string; fadeIn: number; fadeOut: number }>
  >();

  /** 已加载的动作，键是 `组名#序号`。值为 null 表示「加载过，失败了」—— 不重试。 */
  private _motionCache = new Map<string, CubismMotion | null>();

  /**
   * 动作里的部件透明度曲线，键与 `_motionCache` 相同。null 表示「读过但没读动」。
   *
   * 为什么必须自己读：Framework 把 `PartOpacity` 曲线当成**参数**去写，部件 id 查不到
   * 就被塞进 `_notExistParameterValues` 然后丢掉，全程静默（`part-curves.ts` 顶部有
   * 完整的调用链）。hiyori 的 10 段动作每段都带 `PartArmA` / `PartArmB` 两条曲线，
   * 负责说明「这一段该露哪一双手臂」。
   */
  private _motionPartOpacity = new Map<string, MotionPartOpacity | null>();

  /**
   * 正在播的那个动作的部件透明度曲线（null = 没有要写的）。
   *
   * `startedAt` 用 `this._elapsed` 起算：那个时钟累加的是与 Framework 内部
   * `userTimeSeconds` **同一个** `delta`（每次 `update()` 传下去的都是夹取过的那一个），
   * 所以两边算出来的「这个动作播了多久」是一致的，不必另建时钟。
   */
  private _activePartOpacity: { motion: MotionPartOpacity; startedAt: number } | null = null;

  /**
   * 静止姿态：没有任何动作在播时，该把部件透明度摆成什么样。
   *
   * 取自**第一个动作**的曲线（见 `_warmUpDefaultPartOpacity()`）。没有它的话，
   * 模型刚加载完、第一个动作还没开始的那段时间里没人写部件不透明度，两套手臂
   * 的初值都是 1 ⇒ 同时可见。用户 2026-02 截图里的「hiyori 四只手」正是它。
   */
  private _defaultPartOpacity: MotionPartOpacity | null = null;

  /** 表情名 → 相对路径。同上，只记清单。 */
  private _expressionFiles = new Map<string, string>();

  /** 已加载的表情，键是表情名。值为 null 表示加载失败。 */
  private _expressionCache = new Map<string, ACubismMotion | null>();

  /**
   * 视线跟随。它**不是**直接写参数，而是把 `CubismTargetPoint` 的当前值
   * 通过 `CubismLookUpdater` 加进 `ParamAngleX/Y/Z` 等参数 ——
   * 所以「看这里」是一次目标点的移动，模型自己会平滑地追过去。
   */
  private _look: CubismLook | null = null;

  /** 当前正在播的动作，只用于诊断（面板 / 日志）。`''` 表示没在播。 */
  private _activeMotion = '';

  /**
   * 资产根 URL。`load()` 的第一个参数里有它，但动作与表情是**懒加载**的
   * —— 它们要等到第一次被播放时才去取文件，那时 `load()` 早就返回了。
   */
  private _baseUrl = '';

  /** `holdMs` 用的定时器句柄；新表情或释放时要清掉，否则旧定时器会把新表情掐掉。 */
  private _expressionReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 自动居中用的水平位移（NDC 单位，`0` = 不动）。由渲染端量出本体实际画在
   * 哪儿之后写进来，见 `setInkCenterX()`。
   */
  private _inkCenterX = 0;

  /**
   * 用户在舞台里调出来的视图（缩放 / 平移）。
   *
   * `null` = 默认视图，不额外套任何矩阵（与加这个功能之前逐像素一致）。
   * 它只影响 `draw()` 最后那一步的投影，**不碰 `update()`** —— 动作、表情、
   * 眨眼、呼吸、口型全部按原样推进，改的只是「画在哪儿、画多大」。
   * 这正是用户第 5 条要求（调大小位置时模型照常动）的落点。
   */
  private _stageView: StageView | null = null;

  /**
   * 参数逃生通道（§4.1 的 `param` 指令）覆盖的参数值。
   *
   * 与 `_mouthOverride` 同一套语义（都在 `update()` 内部、`model.update()` 之前写），
   * 但**口型那两个参数永远进不来** —— 见 `setParameterOverride()`。
   */
  private _parameterOverrides = new Map<string, number>();

  /** 覆盖的过期定时器。`null` 表示「一直保持到下次覆盖或释放」。 */
  private _parameterOverrideTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 情绪层（§4.1 的 `emotion` 指令）。
   *
   * 与 `_parameterOverrides` 的**唯一**差别，也是这一层存在的全部理由：它用
   * `addParameterValueById()` **加法**写入，而那个用 `setParameterValue()` 硬覆盖。
   * 硬覆盖写在每一帧最后、权重 1，会盖掉眨眼、表情和动作自带的脸部曲线；加法
   * 让「开心」和「正在眨眼」「正在点头」同时成立。
   *
   * 里面装的是**多层**（`emotions.js` 的 `EmotionLayers`），不是一个当前情绪：
   * 换情绪时旧的那层要化过去而不是被剪掉，所以任意时刻都可能有 0..n 层同时
   * 在写同一个参数。状态机与包络都在 Host 半区的 `lib/host/emotions.js`（纯函数，
   * 门禁能逐帧对账），这里只负责「过一帧 → 把这一帧的增量写到模型上」。
   *
   * 层里的数值是**增量**（相对模型默认值），不是绝对值 —— 基准来自 Cubism Core
   * 的默认值，由 Host 半区的 `resolveEmotion()` 算好。
   * `elapsedMs` 由 `update()` 的 `delta` 累加，所以暂停（页面隐藏、舞台卸载）
   * 期间它不会偷偷往前走。
   */
  private _emotions: {
    layers: unknown[];
    active: Array<{ name: string; weight: number; residue?: boolean }>;
  } = createEmotionLayers();

  /**
   * 思考时「收着点」的包络（`0` = 正常幅度，`1` = 收到最轻）。
   *
   * 目标由两处给：Host 在 `/pending` 里报的 `mood.state === 'thinking'`（覆盖整个
   * 回合，`_calmFromHost`），或者脸上正挂着 `思考` 那层情绪（没有新版 Host 时的
   * 退路 —— 那一层的 hold 只有 30 秒，所以它只够顶住回合开头）。
   *
   * 每帧只推进一次（`_applyMotionCalm()`），改动之前 `_calm` 恒为 0、一个参数
   * 都不碰。算术全在 `motion-calm.ts`，门禁 `tools/test-motion-calm.mjs` 钉着。
   */
  private _calmFromHost = false;
  private _calm = 0;

  /**
   * 待机小动作（`idle-garnish.ts`）的当前状态与排期。
   *
   * 三件事必须一起看：`_garnish` 是「正在播的那一下」，`_garnishNextAtMs` 是
   * 「下一次什么时候轮到」，`_garnishClockMs` 是只在这里累加的毫秒时钟 ——
   * 用帧里累加的时钟而不是 `Date.now()`，页面隐藏、舞台卸载期间它就不会白走。
   */
  private _garnish: GarnishState = createGarnishState();
  private _garnishClockMs = 0;
  private _garnishNextAtMs = 0;
  private _garnishLastId: string | null = null;
  private _garnishCount = 0;
  private _garnishRng: () => number = Math.random;

  /**
   * ★ 静息漂移（§13.33）：没有任何情绪、没有任何动作时，脸上仍有的那一点低频起伏。
   *
   * 三件事和待机小动作同构（一个只在这里累加的毫秒时钟、一个「解析一次」的
   * 角色表），但差别在于它**没有排期**：它是连续的背景，不是「来一下」。
   * `_driftResolved` 是「角色 → 这个模型上的真实参数 id 与幅度」，换模型时要重算，
   * 所以第一次用到时才解析（`_ensureAmbientDrift()`）。
   */
  private _driftResolved: Record<string, { id: string; amp: number }> | null = null;
  private _driftClockMs = 0;
  private _driftEnabled = true;

  /**
   * 微动作包（§13.26）与它的播放器状态。
   *
   * `_microPack === null` 表示这个模型没有包（生成不出来、或者还没取回）——
   * 那时退回避开手写的那七条（`idle-garnish.ts`）。两层**永远只有一层在演**：
   * 同时演会往同一批参数上做加法，幅度翻倍。
   *
   * `_microTalking` 由插件每帧从语音通道灌进来；PetModel 自己听不到声音，
   * 它只负责「说话档比待机档密一点」这一件事。
   */
  private _microPack: MicroMotionPack | null = null;
  private _microState: MicroMotionState = createMicroMotionState();
  private _microTalking = false;
  private _microRng: () => number = Math.random;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext) {
    super();
    this._gl = gl;
    this._shaderUrl = '';
    this._scheduler = new CubismUpdateScheduler();
  }

  /**
   * 幂等；safe to call once per context。
   *
   * 做三件事：全局 Framework 启动、为本 GL 上下文建 shader 实例并装上内联 shader 补丁、
   * 等 13 个 shader 真的编译完。第三件事是 `load()` 之前唯一能失败的地方之一，
   * 所以宿主应当先 await 它再建 canvas 之外的任何东西。
   *
   * `shaderUrl` 参数**已经不再使用**：13 个 shader 由 `installShaderPatch()` 从内联表取，
   * 不经过任何 URL。保留参数只是为了不改调用方签名与 `PetModelHost` 的形状。
   */
  static async ensureFramework(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shaderUrl: string,
  ): Promise<void> {
    // 补丁必须在 Framework.startUp 之前装好：renderer.startUp → setGlContext →
    // loadShaders → generateShaders 这条链上一旦用到，装晚一步就是 13 次 404。
    installShaderPatch();

    if (!frameworkReady) {
      if (frameworkBootPromise === null) {
        frameworkBootPromise = (async () => {
          // Option 没有 constructor，字段默认 undefined；这里显式写死，图个可读。
          const option = new Option();
          option.loggingLevel = 4; // LogLevel.LogLevel_Warning：verbose 会把每帧的日志刷爆。
          // 不设的话 Framework 内部日志函数是 undefined，出错时连一行提示都拿不到。
          option.logFunction = (message: string): void => {
            console.log('[live2d]', message);
          };
          if (!CubismFramework.startUp(option)) {
            throw new PetModelError('E_SHADER_LOAD_FAILED', 'CubismFramework.startUp() 返回 false');
          }
          CubismFramework.initialize();
        })();
      }
      try {
        await frameworkBootPromise;
        frameworkReady = true;
      } catch (error) {
        // 失败不该被永久缓存，下次重挂组件还能再试一次。
        frameworkBootPromise = null;
        frameworkReady = false;
        throw error instanceof Error
          ? error
          : new PetModelError('E_SHADER_LOAD_FAILED', `CubismFramework 启动失败：${String(error)}`);
      }
    }

    await waitForShaders(gl, SHADER_LOAD_TIMEOUT_MS);
  }

  /** True once load() resolved successfully. */
  public get ready(): boolean {
    return this._ready;
  }

  /** load() 失败时留一份原始错误，宿主诊断用。 */
  public get lastError(): Error | null {
    return this._lastError;
  }

  // -------------------------------------------------------------------------
  // 加载
  // -------------------------------------------------------------------------

  /**
   * Load model3.json + moc3 + textures (+ physics3.json / pose3.json if referenced).
   *
   * 失败一律 reject 带错误码的 `Error`，并且**保证 `release()` 仍然可重入**：
   * 所有半成品状态都在 `_ready = false` 的下方，release() 只按 null 检查清理。
   */
  public async load(host: PetModelHost, modelJsonRelativePath: string): Promise<void> {
    this._released = false;
    this._ready = false;
    this._lastError = null;
    // 上一个模型的参数表已经跟着 release() 一起没了，缓存必须清。
    this._parameterIndexCache = null;

    try {
      // ---- 0. shader 必须先于 renderer 就绪，路径也要在这之前设好 ----
      // 顺序很关键：`EnsureFramework` 里就完成了 setShaderPath + 轮询编译，
      // 所以下面 createRenderer / startUp 时 shader 已经是可用的。
      this._shaderUrl = isNonEmpty(host.shaderUrl) ? host.shaderUrl : this._shaderUrl;
      this._baseUrl = host.baseUrl;
      await PetModel.ensureFramework(this._gl, host.shaderUrl);

      // ---- 1. model3.json ----
      const modelJsonUrl = resolveAssetUrl(host.baseUrl, modelJsonRelativePath);
      let rawText: string;
      try {
        rawText = await fetchText(modelJsonUrl);
      } catch (error) {
        throw new PetModelError(
          'E_MODEL_JSON_INVALID',
          `${modelJsonRelativePath} 取不到（${modelJsonUrl}）：${describeError(error)}`,
        );
      }

      let rawJson: RawModel3Json;
      try {
        rawJson = JSON.parse(rawText) as RawModel3Json;
      } catch (error) {
        throw new PetModelError(
          'E_MODEL_JSON_INVALID',
          `${modelJsonRelativePath} 不是合法 JSON：${describeError(error)}`,
        );
      }

      const fileReferences = rawJson === null || rawJson === undefined ? undefined : rawJson.FileReferences;
      if (fileReferences === undefined || fileReferences === null) {
        throw new PetModelError(
          'E_MODEL_JSON_INVALID',
          `${modelJsonRelativePath} 缺少 FileReferences`,
        );
      }

      // 记下来给 `capabilities()` 用（见那个字段的注释）。放在 FileReferences 校验之后：
      // 一个连 FileReferences 都没有的 JSON 不值得留着。
      this._rawSettings = rawJson;

      // Framework 自己的 model3.json 解析器。给 ArrayBuffer 是因为它内部按字节偏移读。
      const encoded = new TextEncoder().encode(rawText);
      const setting = new CubismModelSettingJson(encoded.buffer as ArrayBuffer, encoded.byteLength);

      // ---- 2. moc3 ----
      const mocRelativePath = fileReferences.Moc;
      if (!isNonEmpty(mocRelativePath)) {
        throw new PetModelError('E_MOC3_MISSING', `${modelJsonRelativePath} 的 FileReferences.Moc 为空`);
      }

      let mocBuffer: ArrayBuffer;
      try {
        mocBuffer = await fetchArrayBuffer(resolveAssetUrl(host.baseUrl, mocRelativePath));
      } catch (error) {
        throw new PetModelError(
          'E_MOC3_MISSING',
          `${mocRelativePath} 取不到：${describeError(error)}`,
        );
      }

      // 先版本后加载，这样不支持的 moc3 能给出准确错误码而不是笼统的"加载失败"。
      const mocVersion = this.getMocVersionFromBuffer(mocBuffer);
      const latestVersion = getLatestMocVersion();
      if (mocVersion === 0 || (latestVersion > 0 && mocVersion > latestVersion)) {
        throw new PetModelError(
          'E_MOC3_VERSION_UNSUPPORTED',
          `${mocRelativePath} 的 moc3 版本为 ${mocVersion}，当前 Core 最高支持 ${latestVersion}`,
        );
      }

      // loadModel 失败时**不抛异常**，只打日志，`getModel()` 返回 null。
      this.loadModel(mocBuffer, false);
      const model = this.getModel();
      if (model === null || model === undefined) {
        throw new PetModelError(
          'E_MOC3_MISSING',
          `${mocRelativePath} 无法创建模型（moc3 版本 ${mocVersion}，Core 最高 ${latestVersion}）`,
        );
      }

      // ---- 3. layout（可选，没有就保持默认的 2.0 高度） ----
      const layout = new Map<string, number>();
      if (setting.getLayoutMap(layout) && layout.size > 0) {
        this.getModelMatrix().setupFromLayout(layout);
      }

      // ---- 4. renderer ----
      const canvasWidth = model.getCanvasWidth();
      const canvasHeight = model.getCanvasHeight();
      this.createRenderer(canvasWidth, canvasHeight);

      const renderer = this.getRenderer();
      if (renderer === null || renderer === undefined) {
        throw new PetModelError('E_MOC3_MISSING', `${mocRelativePath} 已加载但 renderer 创建失败`);
      }

      // renderer.startUp(gl) 必须在 touch() 之前：两者都要 gl 与 program 就位。
      renderer.startUp(this._gl);
      // 预乘 alpha 是硬要求，见文件头。
      renderer.setIsPremultipliedAlpha(true);
      shaderIsPremultiplied(this._gl);

      // ---- 5. textures ----
      const textureCount = setting.getTextureCount();
      if (textureCount <= 0) {
        throw new PetModelError('E_TEXTURE_MISSING', `${modelJsonRelativePath} 的 Textures 为空`);
      }

      // 纹理路径以**我们自己解析的 model3.json 原文**为准。
      //
      // 不能像官方示例那样拼 `getTextureDirectory() + getTextureFileName(i)`：
      // 后者返回的是 JSON 里的**完整原始路径**（本模型是
      // `空 - 免费版.8192/texture_00.png`），而不是文件名；前者又是从这条路径里
      // 猜出来的目录（`空 - 免费版.8192`）。两个一拼就成了
      // `空 - 免费版.8192/空 - 免费版.8192/texture_00.png` → 404。
      // 官方示例不会踩到，因为它的纹理路径里没有目录。
      const rawTextures = Array.isArray(fileReferences.Textures) ? fileReferences.Textures : [];
      const textureDirectory = setting.getTextureDirectory();
      for (let index = 0; index < textureCount; index += 1) {
        const textureFileName = setting.getTextureFileName(index);
        const rawTexture = rawTextures[index];
        const textureRelativePath = isNonEmpty(rawTexture)
          ? rawTexture
          : joinRelativePath(textureDirectory, textureFileName);
        if (!isNonEmpty(textureRelativePath)) {
          throw new PetModelError('E_TEXTURE_MISSING', `纹理 #${index} 路径为空（${modelJsonRelativePath}）`);
        }
        const textureUrl = resolveAssetUrl(host.baseUrl, textureRelativePath);

        const texture = await this.loadTexture(textureUrl, textureRelativePath);
        this._ownedTextures.push(texture);
        renderer.bindTexture(index, texture);
      }

      // ---- 6. 物理（引用即必需；缺失或解析失败都是硬错误） ----
      const physicsRelativePath = setting.getPhysicsFileName();
      if (isNonEmpty(physicsRelativePath)) {
        let physicsBuffer: ArrayBuffer;
        try {
          physicsBuffer = await fetchArrayBuffer(resolveAssetUrl(host.baseUrl, physicsRelativePath));
        } catch (error) {
          throw new PetModelError(
            'E_PHYSICS_INVALID',
            `${physicsRelativePath} 取不到：${describeError(error)}`,
          );
        }
        try {
          this.loadPhysics(physicsBuffer, physicsBuffer.byteLength);
          // 5-r.5 没有 getPhysics()：`_physics` 是 protected 字段，子类直接读。
          // loadPhysics 内部是 this._physics = CubismPhysics.create(...)，失败时为 null。
          const physics = this._physics;
          if (physics !== null && physics !== undefined) {
            this._scheduler.addUpdatableList(new CubismPhysicsUpdater(physics));
          }
        } catch (error) {
          throw new PetModelError(
            'E_PHYSICS_INVALID',
            `${physicsRelativePath} 解析失败：${describeError(error)}`,
          );
        }
      }

      // ---- 7. 姿态（可选，缺了就当没有） ----
      const poseRelativePath = setting.getPoseFileName();
      if (isNonEmpty(poseRelativePath)) {
        const poseBuffer = await tryFetchArrayBuffer(resolveAssetUrl(host.baseUrl, poseRelativePath));
        if (poseBuffer !== null) {
          try {
            this.loadPose(poseBuffer, poseBuffer.byteLength);
            const pose = this._pose;
            if (pose !== null && pose !== undefined) {
              this._scheduler.addUpdatableList(new CubismPoseUpdater(pose));
            }
          } catch {
            // 姿态是装饰性的，解析失败不该让整个模型加载失败。
          }
        }
      }

      // ---- 8. 眨眼（`Groups.EyeBlink` 为空时回退到 Cubism 惯例 id） ----
      // ⚠️ `CubismEyeBlink.create()` **永远不返回 null** —— `framework/src/effect/cubismeyeblink.ts:24-28`
      // 是 `return new CubismEyeBlink(modelSetting);`，构造函数 `:175-177` 只在 setting 为 null 时
      // 提前 return。所以判 `eyeBlink !== null` 是**恒真**判（旧代码就是，且它上面那句
      // 「有对应参数才建」是一句假话）：`Groups.EyeBlink.Ids` 为空数组时，SDK 照样给出一个
      // `_parameterIds` 为空的眨眼器，而它的更新循环 `cubismeyeblink.ts:155`
      // （`for (let i = 0; i < this._parameterIds.length; ++i)`）一次都不跑 ⇒ **那只模型永远不眨眼**。
      // 判据只能是「有没有真的拿到参数」。四只模型里只有 `akari_vts` 的 `Groups.EyeBlink.Ids` 是
      // 空的（`空` / `miku` / `hiyori_vts` 都声明了真 id），而 `akari_vts.cdi3.json` 里
      // `ParamEyeLOpen / ParamEyeROpen` **都在** ⇒ 回退到这两个 Cubism 惯例 id 是安全的。
      const eyeBlink = CubismEyeBlink.create(setting);
      if (eyeBlink.getParameterIds().length === 0) {
        eyeBlink.setParameterIds([cachedId('ParamEyeLOpen'), cachedId('ParamEyeROpen')]);
      }
      // `_eyeBlink` 是 protected 字段，没有 setter；父类 release() 负责 CubismEyeBlink.delete。
      this._eyeBlink = eyeBlink;
      // 第一个参数是「动作这一帧是否更新过」：官方示例传 `() => this._motionUpdated`。
      // 传常量 false 等于宣称「动作永远没在播」，眨眼会盖掉动作里的眼部关键帧。
      this._scheduler.addUpdatableList(new CubismEyeBlinkUpdater(() => this._motionUpdated, eyeBlink));

      // ---- 9. 呼吸 ----
      // CubismBreath 没有 addParameter()：要整组 setParameters()。
      // BreathParameterData 也没有静态工厂，直接 new。签名是
      // **`(id, offset, peak, cycle, weight)` —— 5 个参数**，不是 6 个；
      // 数值照抄官方示例 lappmodel.ts 316–336 行（这些振幅/周期是调过的，别自己拍）。
      const breath = CubismBreath.create();
      breath.setParameters([
        new BreathParameterData(cachedId('ParamAngleX'), 0.0, 15.0, 6.5345, 0.5),
        new BreathParameterData(cachedId('ParamAngleY'), 0.0, 8.0, 3.5345, 0.5),
        new BreathParameterData(cachedId('ParamAngleZ'), 0.0, 10.0, 5.5345, 0.5),
        new BreathParameterData(cachedId('ParamBodyAngleX'), 0.0, 4.0, 15.5345, 0.5),
        new BreathParameterData(cachedId('ParamBreath'), 0.5, 0.5, 3.2345, 1.0),
      ]);
      this._breath = breath;
      this._scheduler.addUpdatableList(new CubismBreathUpdater(breath));

      // ---- 10. 动作与表情的清单（只记路径，不加载） ----
      this._collectMotionFiles(fileReferences);
      this._collectExpressionFiles(fileReferences);

      // ---- 11. 表情更新器 ----
      // 表情走的是与动作**同一个调度器**，靠 `CubismUpdateOrder_Expression = 300`
      // 排在眨眼（200）之后、视线（400）与呼吸（500）之前 —— 顺序由框架的
      // `icubismupdater.ts` 定，我们只是把它挂上去，不自己排序。
      const expressionManager = this._expressionManager;
      if (expressionManager !== null && expressionManager !== undefined) {
        this._scheduler.addUpdatableList(new CubismExpressionUpdater(expressionManager));
      }

      // ---- 12. 视线跟随 ----
      // 注意 `LookParameterData` 的第一项是 `CubismIdHandle`，但 `CubismLook.updateParameters`
      // 内部走的是 `model.addParameterValueById(id, …)`，传**参数名字符串**同样有效
      // （Core 的 id 表按名字查）。用字符串是为了不依赖 Framework 的 id manager 是否已启动。
      const look = CubismLook.create();
      look.setParameters(
        LOOK_PARAMETER_FACTORS.map(([id, factorX, factorY, factorXY]) =>
          new LookParameterData(cachedId(id), factorX, factorY, factorXY),
        ),
      );
      this._look = look;
      // 基类在构造函数里 `new CubismTargetPoint()`，那套的转头速度**是写死的**
      // （约 4 单位/秒 + 0.15 秒加速），没有时长旋钮 —— 于是 §4.1 契约里的
      // `durationMs` 无处落地。`_dragManager` 在基类里是 `protected`，所以这里
      // 换成自己的实现：位置改由 `look-tween.ts` 那条时间线算。
      //
      // 为什么不去改框架那份：`framework/` 是官方 SDK 的复制品，
      // `tools/sync-vendor.mjs --check` 会逐字节校验它没被改动。
      this._dragManager = new TimedLookTarget();
      const dragManager = this._dragManager;
      if (dragManager !== null && dragManager !== undefined) {
        this._scheduler.addUpdatableList(new CubismLookUpdater(look, dragManager));
      }

      // ---- 13. 收尾 ----
      // addUpdatableList 会置 _needsSort，onLateUpdate 自己会排；这里显式排一次便于调试。
      this._scheduler.sortUpdatableList();
      // model 刚建好，参数表清一次，下次查表重新建。
      this._parameterIndexCache = null;
      this._lastError = null;
      this._ready = true;

      // ---- 14. 静止姿态 ----
      // 必须放在 `_ready = true` **之后**：`_loadMotion` 会经过模型的公开方法，
      // 而它们大多以 `_ready` 为前提。这一步只读一个动作文件（hiyori 最大的一个
      // 约 14 KB），失败也不抛，所以它对加载时间的影响可以忽略。
      await this._warmUpDefaultPartOpacity();
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new PetModelError('E_MODEL_JSON_INVALID', `未知失败：${String(error)}`);
      this._lastError = failure;
      this._ready = false;
      // 半成品一律清掉，保证 release() 可重入、且不会留着一个半加载的模型在画。
      this.release();
      throw failure;
    }
  }

  /**
   * 上传一张纹理。
   *
   * 三条路径：createImageBitmap(blob, {resize…}) → objectURL + `<img>` + createImageBitmap
   * → objectURL + `<img>` 直传（最后的兜底给没有 createImageBitmap 的环境）。
   *
   * **降采样是必须的，不是优化**：这个测试模型三张纹理都是 8192×8192，
   * RGBA 解码后一张 256 MB，三张 768 MB —— 中端集显直接 OUT_OF_MEMORY。
   * 卡片上模型总共才画到几百像素高，8192 的细节一个像素都用不上。
   *
   * 关键点是**一步解码到目标尺寸**：`createImageBitmap(blob, {resizeWidth,
   * resizeHeight})` 让浏览器在解码管线内部缩放，全程不会出现一张 8192 的位图；
   * 而「先解码再 canvas.drawImage 缩小」会先实打实吃下 256 MB。所以要**先读 PNG 头
   * 拿到尺寸**（IHDR 在 offset 16/20，大端 uint32），据此决定要不要 resize，
   * 而不是解码完再看。
   */
  private async loadTexture(url: string, relativePath: string): Promise<WebGLTexture> {
    const gl = this._gl;
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    let source: TexImageSource | null = null;
    let width = 0;
    let height = 0;
    let objectUrl: string | null = null;

    /*
     * 纹理也要走带超时的那个包装。它是所有请求里**最大**的一个（miku 六张
     * 4096² 共 25MB、空三张 8192² 共 87MB），也是最可能挂住的一个 ——
     * 而它挂住的症状同样是「没有任何错误，就是永远加载不完」。
     */
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new PetModelError(
        'E_TEXTURE_MISSING',
        `${relativePath} 取不到（${url}）：HTTP ${response.status} ${response.statusText}`,
      );
    }
    const blob = await response.blob();

    // ---- 1. 只读头部 24 字节拿原始尺寸（不解码像素） ----
    let naturalWidth = 0;
    let naturalHeight = 0;
    try {
      const head = await blob.slice(0, 24).arrayBuffer();
      const size = readPngSize(new Uint8Array(head));
      if (size !== null) {
        naturalWidth = size.width;
        naturalHeight = size.height;
      }
    } catch {
      // 读不出头就当作「尺寸未知」，下面按不缩放处理，让 MAX_TEXTURE_SIZE 去拦。
    }

    // ---- 2. 目标尺寸 ----
    const longSide = Math.max(naturalWidth, naturalHeight);
    let targetWidth = 0;
    let targetHeight = 0;
    if (longSide > MAX_TEXTURE_LONG_SIDE) {
      const factor = MAX_TEXTURE_LONG_SIDE / longSide;
      targetWidth = Math.max(1, Math.round(naturalWidth * factor));
      targetHeight = Math.max(1, Math.round(naturalHeight * factor));
    }

    // ---- 3. 解码（尽量带 resize 选项，一步到位） ----
    if (typeof createImageBitmap === 'function') {
      try {
        const options: ImageBitmapOptions =
          targetWidth > 0 ? { resizeWidth: targetWidth, resizeHeight: targetHeight, resizeQuality: 'high' } : {};
        const bitmap = await createImageBitmap(blob, options);
        if (bitmap.width > 0 && bitmap.height > 0) {
          source = bitmap;
          width = bitmap.width;
          height = bitmap.height;
        } else if (typeof bitmap.close === 'function') {
          bitmap.close();
        }
      } catch {
        // 交给下面的 <img> 分支再试一次。
      }
    }

    if (source === null) {
      objectUrl = URL.createObjectURL(blob);
      const image = await loadImageElement(objectUrl, relativePath);
      // 上传完统一走 close() 清理，这里给 <img> 补一个空实现。
      (image as unknown as { close: () => void }).close = () => undefined;

      const imageWidth = image.naturalWidth > 0 ? image.naturalWidth : image.width;
      const imageHeight = image.naturalHeight > 0 ? image.naturalHeight : image.height;

      if (targetWidth > 0 && imageWidth > 0 && imageHeight > 0) {
        // 已经解码出大图了，只能在 canvas 上缩 —— 这条路径比上面多一次大位图，是兜底。
        try {
          source = downscaleToCanvas(image, targetWidth, targetHeight);
          width = targetWidth;
          height = targetHeight;
        } catch {
          // 缩不了就直传，交给 MAX_TEXTURE_SIZE 判断。
        }
      }

      if (source === null) {
        source = image;
        width = imageWidth;
        height = imageHeight;
      }
    }

    if (width > maxTextureSize || height > maxTextureSize) {
      throw new PetModelError(
        'E_TEXTURE_TOO_LARGE',
        `${relativePath} 是 ${width}×${height}，超过 MAX_TEXTURE_SIZE=${maxTextureSize}`,
      );
    }

    const texture = gl.createTexture();
    if (texture === null || texture === undefined) {
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
      throw new PetModelError('E_TEXTURE_MISSING', `${relativePath} 无法创建 GL 纹理对象`);
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    // 预乘 alpha：采样器在阴影里按预乘解释颜色，不设这个边缘会发黑。
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);

    // 先把之前残留的错误码排空：WebGL 的错误是"粘住"的，不排空的话
    // 下面任何一次 getError() 都会捞到别人的旧错误，误报成纹理问题。
    while (gl.getError() !== gl.NO_ERROR) {
      // 丢弃。
    }

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    const uploadError = gl.getError();
    if (uploadError !== gl.NO_ERROR) {
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.deleteTexture(texture);
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
      throw new PetModelError(
        'E_TEXTURE_TOO_LARGE',
        `${relativePath}（${width}×${height}）上传失败，gl.getError()=0x${uploadError.toString(16)}，` +
          `MAX_TEXTURE_SIZE=${maxTextureSize}`,
      );
    }

    // WebGL1 里 NPOT 纹理既不能 generateMipmap 也不能 REPEAT/MIRRORED。
    // 降采样后的 2048 是 2 的幂，但别的尺寸不保证，所以按维数判而不是硬写 true。
    const isPot = (width & (width - 1)) === 0 && (height & (height - 1)) === 0;

    if (isPot) {
      gl.generateMipmap(gl.TEXTURE_2D);
      const mipError = gl.getError();
      if (mipError !== gl.NO_ERROR) {
        // 大图 mipmap 链在某些驱动上就是会挂（OUT_OF_MEMORY）。
        // 退回单层滤波比整块模型黑屏好。
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    gl.bindTexture(gl.TEXTURE_2D, null);

    // ImageBitmap 是显存侧对象，上传完就该关；<img> 上补一个空 close()，两条路径统一。
    const closable = source as unknown as { close?: () => void };
    if (typeof closable.close === 'function') {
      try {
        closable.close();
      } catch {
        // 某些实现上 ImageBitmap.close() 会抛；关不掉不影响已上传的纹理。
      }
    }

    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
    }

    return texture;
  }

  // -------------------------------------------------------------------------
  // 每帧
  // -------------------------------------------------------------------------

  /** Advance one frame. dtSeconds is the delta since the previous update. */
  public update(dtSeconds: number): void {
    if (!this._ready || this._released) {
      return;
    }
    const model = this.getModel();
    if (model === null || model === undefined) {
      return;
    }

    let delta = typeof dtSeconds === 'number' && isFinite(dtSeconds) ? dtSeconds : 0;
    if (delta < 0) {
      delta = 0;
    }
    if (delta > MAX_DELTA_SECONDS) {
      delta = MAX_DELTA_SECONDS;
    }
    this._elapsed += delta;

    // 官方示例 lappmodel.ts 的 update() 顺序，照抄：
    //   loadParameters() → 动作更新 → saveParameters() → 效果（物理/姿态/眨眼/呼吸）→ model.update()
    // 顺序本身是有意义的：saveParameters() 必须在效果之前，效果每一帧都从「动作算完的
    // 干净状态」出发。把效果放在 saveParameters() 之后，效果算出来的值会被下一帧
    // loadParameters() 读回来再次叠加，很快就飘了。
    model.loadParameters();

    this._motionUpdated = false;
    const motionManager = this._motionManager;
    if (motionManager !== null && motionManager !== undefined && !motionManager.isFinished()) {
      this._motionUpdated = motionManager.updateMotion(model, delta) === true;
    } else {
      // 动作播完了：停止写部件透明度。**最后一个值留在部件上** —— 框架自己也不会重置
      // 部件不透明度，所以手臂不会在动作结束的那一刻弹回「两套同时可见」。
      this._activePartOpacity = null;
    }
    this._applyPartOpacity();
    /*
     * 思考时把动作的幅度收一收。
     *
     * 位置是**有讲究的**：必须在 `saveParameters()` 之前。之后是效果链
     * （眨眼 / 表情 / 视线 / 呼吸 / 物理 / 姿态），它们每一帧都从「动作算完的
     * 干净状态」出发 —— 收幅改的是那个基准，效果照常叠在上面。放到之后就会被
     * `loadParameters()` 读回来再叠加一次，越叠越飘。
     */
    this._applyMotionCalm(delta);
    // 动作、表情、视线跟随、物理、姿态、眨眼、呼吸全都走 `_scheduler`，
    // 顺序由各自的 `CubismUpdateOrder`（`icubismupdater.ts:22-31`）决定：
    // 眨眼 200 → 表情 300 → 视线 400 → 呼吸 500 → 物理 600 → 姿态 800。
    // 动作**不**在其中：它是上面这一行单独调的，而且必须最先跑（表情与视线
    // 都是「在动作结果之上叠加」）。

    model.saveParameters();
    this._scheduler.onLateUpdate(model, delta);

    /*
     * 情绪层紧跟在 `onLateUpdate` 之后。
     *
     * 为什么在这里而不是更早：它是**加法**，加在谁身上决定了「和谁共存」。
     * 放在调度器之后 ⇒ 加在眨眼、表情、视线、呼吸、物理、姿态的结果之上，
     * 所有这些层照常生效，只是在它们的结果上再叠一层情绪。放在动作之前也
     * 可以（加法可交换），但放到最后能保证「动作自带的脸部曲线」也被情绪
     * 叠上去 —— 而 hiyori 的 10 段动作每一段都在驱动脸。
     *
     * 必须在 `model.update()` 之前：那一步才把参数烘焙进顶点。
     */
    this._applyEmotion(delta);

    /*
     * ★ 静息漂移（§13.33）夹在情绪层与待机小动作之间。
     *
     * 它必须**排在情绪之后**：情绪层是「她此刻是谁」，漂移是「她还在呼吸」——
     * 后者不该盖掉前者，只该叠在它上面。也必须排在待机小动作之前：小动作是
     * 「来一下」的事件，漂移是背景，事件应该压在背景之上（虽然都是加法，
     * 顺序在这里只影响可读性，不影响结果）。
     */
    this._applyAmbientDrift(delta);

    /*
     * 待机小动作紧跟在情绪层后面，理由完全一样：它也是**加法**，也要加在
     * 眨眼 / 表情 / 视线 / 呼吸 / 物理 / 姿态全算完之后，才能在「不动美术资源」
     * 的前提下再叠一层「忽然瞥一眼 / 抬个眉毛 / 侧个身」。
     */
    this._applyGarnish(delta);

    // 口型覆盖放在最后、`model.update()` 之前：此时动作与呼吸/眨眼都算完了，
    // 用 weight=1 硬写覆盖它们的结果，而 `model.update()` 紧接着把参数烘焙进顶点。
    const mouth = this._mouthOverride;
    if (mouth !== null) {
      this.setParameterValue(MOUTH_OPEN_PARAMETER_ID, mouth.openness);
      if (mouth.form !== null) {
        this.setParameterValue(MOUTH_FORM_PARAMETER_ID, mouth.form);
      }
    }

    // 参数逃生通道放在口型**之后**：口型是每帧都在写的硬通道，它的值必须赢。
    // 顺序反过来时，一条 `param` 指令只要写了一次 `ParamMouthOpenY`，嘴巴就会
    // 在那条指令的整个 TTL 里僵住 —— 而 §4.1 硬规则 1 说的正是「口型通道独占」。
    if (this._parameterOverrides.size > 0) {
      for (const [id, value] of this._parameterOverrides) {
        this.setParameterValue(id, value);
      }
    }

    model.update();
  }

  /**
   * 每帧推进「思考时收着点」的包络，并按包络把动作参数往默认值收。
   *
   * 只对这一帧确实写了参数的**待机动作**（优先级 ≤ `IDLE`）生效 —— AI 点名的
   * 动作是用户要看的，思考不该把它打折。条件全在 `motion-calm.ts` 的
   * `shouldDampMotion()` 里，门禁逐条钉着。
   *
   * 口型两个参数跳过：那条通道独占（§4.1 硬规则 1），而且口型覆盖就写在 `update()`
   * 下面几行，收了也会被盖掉。
   */
  private _applyMotionCalm(deltaSeconds: number): void {
    const thinking =
      this._calmFromHost ||
      this._emotions.active.some((layer) => layer.name === THINKING_LAYER_NAME);
    this._calm = advanceCalm(this._calm, calmTargetFor(thinking), deltaSeconds * 1000);
    const model = this.getModel();
    if (model === null || model === undefined) {
      return;
    }
    if (
      !shouldDampMotion({
        calm: this._calm,
        motionUpdated: this._motionUpdated,
        motionPriority: this.currentMotionPriority(),
        idlePriority: FRAMEWORK_PRIORITY.IDLE,
      })
    ) {
      return;
    }
    const factor = calmFactorFor(this._calm);
    const count = model.getParameterCount();
    const mouthOpen = model.getParameterIndex(cachedId(MOUTH_OPEN_PARAMETER_ID));
    const mouthForm = model.getParameterIndex(cachedId(MOUTH_FORM_PARAMETER_ID));
    for (let index = 0; index < count; index += 1) {
      if (index === mouthOpen || index === mouthForm) {
        continue;
      }
      const value = model.getParameterValueByIndex(index);
      const defaultValue = model.getParameterDefaultValue(index);
      if (value === defaultValue) {
        continue;
      }
      model.setParameterValueByIndex(index, dampTowardDefault(value, defaultValue, factor));
    }
  }

  /**
   * 把当前动作的部件透明度曲线写进模型。
   *
   * 写在动作更新之后、`model.update()` 之前 —— 与 Framework 自己那条（已死的）路径
   * 相对位置一致：它当时在 `doUpdateParameters()` 里，也就是动作参数刚算完的位置。
   * 部件不透明度与参数互不影响，所以顺序其实无所谓，保持一致只是少一个出错的理由。
   *
   * 用的是公开 API `CubismModel.setPartOpacityById()`，不必改 `framework/`
   * （`tools/sync-vendor.mjs --check` 要求它逐字节未改动）。
   */
  private _applyPartOpacity(): void {
    const model = this.getModel();
    if (model === null || model === undefined) {
      return;
    }
    // 有动作在播 → 按动作自己的时钟求值；没有 → 摆成静止姿态（t=0 那一刻的值）。
    // 静止姿态是必须的：否则模型刚加载完、第一个动作还没开始的这段时间里，两套
    // 手臂的初值都是 1，会同时画出来。
    const active = this._activePartOpacity;
    const entries =
      active !== null
        ? partOpacitiesAt(active.motion, motionTimeAt(active.motion, this._elapsed - active.startedAt))
        : this._defaultPartOpacity === null
          ? []
          : partOpacitiesAt(this._defaultPartOpacity, 0);
    for (const entry of entries) {
      if (!isFinite(entry.opacity)) {
        continue;
      }
      model.setPartOpacityById(cachedId(entry.id), entry.opacity);
    }
  }

  /**
   * 用**第一个动作**的部件透明度曲线定一个静止姿态。
   *
   * 为什么需要它：模型刚加载完、第一个动作还没开始（待机是 20 秒之后）的那段时间里，
   * `_activePartOpacity` 是空的，于是没有任何人写部件不透明度，两套手臂的初值都是 1
   * ⇒ 同时画出来。用户 2026-02 的截图（hiyori 四只手）正是这个状态。
   *
   * 取「第一个动作」而不是「第一个带曲线的动作」：顺序确定、可复现，而且作者在第一段
   * 待机动作里摆的通常就是她站着不动时的样子。曲线是**常量**时（hiyori 的 10 段全是）
   * 等价于一个姿态开关；曲线随时间变化时只取 t=0 那一刻的值 —— 静止姿态本来就不该动。
   *
   * 顺带把第一个动作预热进 `_motionCache`，第一次播它时不必再等一次 fetch。
   * 任何失败都只影响这个姿态，不影响模型可用性（`_loadMotion` 自己不抛）。
   */
  private async _warmUpDefaultPartOpacity(): Promise<void> {
    const group = this.motionGroupNames()[0];
    if (group === undefined) {
      return;
    }
    const entry = this._motionFiles.get(group)?.[0];
    if (entry === undefined) {
      return;
    }
    const key = `${group}#0`;
    try {
      await this._loadMotion(group, 0, entry);
    } catch {
      // `_loadMotion` 已经把网络/解析失败吞成 null；这里只是最后一道保险。
    }
    this._defaultPartOpacity = this._motionPartOpacity.get(key) ?? null;
  }

  /** Draw into the currently bound framebuffer. */
  public draw(viewportWidth: number, viewportHeight: number): void {
    if (!this._ready || this._released) {
      return;
    }
    const model = this.getModel();
    if (model === null || model === undefined) {
      return;
    }
    const renderer = this.getRenderer();
    if (renderer === null || renderer === undefined) {
      return;
    }

    const width = Math.max(1, Math.floor(viewportWidth));
    const height = Math.max(1, Math.floor(viewportHeight));

    // 模型矩阵：把模型宽度规范到 2 个单位，于是高度是 2 * canvasHeight/canvasWidth。
    const modelMatrix = this.getModelMatrix();
    modelMatrix.setWidth(2.0);

    const canvasWidth = model.getCanvasWidth();
    const canvasHeight = model.getCanvasHeight();
    const modelAspect = canvasHeight > 0 ? canvasWidth / canvasHeight : 1;
    const viewAspect = width / height;

    // 「contain」铺法：保证等比且不裁切。推导（NDC 下）：
    //   模型半宽 sx、半高 sy * (canvasHeight/canvasWidth)，
    //   不裁切要求 sx ≤ 1 且 sy*canvasHeight/canvasWidth ≤ 1，
    //   等比要求 sx*width = sy*height（两边每单位像素数相等）。
    //   解出来 sy = min(canvasWidth/canvasHeight, width/height)，sx = sy * height/width。
    // 本模型 4000×8000（aspect 0.5）在 260×360 的卡片上：sy=0.5、sx≈0.692。
    const sy = Math.min(modelAspect, viewAspect);
    const sx = sy * (height / width);

    const projection = new CubismMatrix44();
    projection.scale(sx, sy);
    projection.multiplyByMatrix(modelMatrix);

    /*
     * ★ 自动居中：把本体挪到视口水平正中。
     *
     * 为什么需要它 —— 整条链路里**没有任何平移项**：
     *   · 上面的 `scale()` 与 `modelMatrix.setWidth()` 都只设缩放
     *     （`cubismmatrix44.ts:258-261` 的 `scale()` 是**赋值**不是累乘）；
     *   · 没人调过 `setPosition` / `setCenterPosition` / `setupFromLayout`；
     *   · 两个模型的 `model3.json` 也都没有 `Layout` 键。
     * 于是模型在视口里的位置**完全由它自己的顶点相对画布原点的偏移决定**，
     * 那是模型作者的画布摆放。实测（`work/probe-canvas-bbox.mjs`）：
     * miku 的顶点包围盒在 x[-0.213, 0.722]（它的画布半宽只有 0.371！），
     * 换算到 NDC 是 [-0.45, +1.53] —— 中心在 +0.54，也就是偏右四分之一个
     * 视口宽、右边还被裁掉一截；空是 [-0.91, +0.64]，中心 -0.13。
     * 用户报的「miku 偏向屏幕右侧、空还好」就是这个差别的直接后果。
     *
     * `translate()` 也是**赋值**（`cubismmatrix44.ts:200-203` 写 `_tr[12]/[13]`），
     * 所以放在合成之后调用，写进去的就是最终 NDC 平移量。这正是想要的：
     * 量出来的 `_inkCenterX` 本来就是 NDC，直接写进去即可，不会再被 `scale` 乘一遍。
     *
     * ★ 但它赋值的是**两个**分量 —— `translate(x, y)` 会把 y 一起写成参数里的那个
     * 数。今天写 `0` 恰好等于原值（`multiplyByMatrix` 之后 `_tr[13]` 就是 0，
     * 因为两个模型的 `modelMatrix` 平移都是 0），可这是**巧合而不是保证**：
     * 哪天有人给模型加上 `Layout`、或者调了 `setCenterPosition`，
     * 这一行就会把纵向居中**静默**抹掉。所以这里显式地把 y 读出来原样写回。
     *
     * **只修水平**：竖直方向两个模型的墨迹都已经铺满舞台（NDC y 都在 ±1 附近，
     * 中心偏移不到 1%），再动它只会把头顶或脚底裁掉。用户报的也是「偏右」。
     */
    if (this._inkCenterX !== 0) {
      projection.translate(-this._inkCenterX, projection.getTranslateY());
    }

    // 预乘状态是**上下文级**的全局 GL 状态，别的代码碰过 pixelStorei 就会把它关掉，
    // 而关闭后渲染器只会打一行日志、画面静默变黑边。每帧钉一次。
    shaderIsPremultiplied(this._gl);

    this._gl.viewport(0, 0, width, height);
    // **必须自己清屏**：渲染器只在有 offscreen（蒙版）目标时擦自己的 FBO，
    // `beforeDrawModelRenderTarget()` 在 `_modelRenderTargets.length == 0` 时直接
    // return，主帧缓冲一次都没被擦过。不清的后果不是黑屏而是**拖影**：
    // 上一帧的像素一直在，模型一动就留下残影。
    this._gl.clearColor(0.0, 0.0, 0.0, 0.0);
    this._gl.clear(this._gl.COLOR_BUFFER_BIT);

    renderer.setMvpMatrix(this._withStageView(projection, width, height));
    // 传 null 是有意的：`doDrawModel(shaderPath)` 会把它转交给 `loadShaders()`，
    // 而非 null 的路径会在每次 draw 时重新 setShaderPath。shader 在 load() 里
    // 早就编译好了，这里不该再动状态。doDrawModel 自己会保存/恢复
    // FRAMEBUFFER_BINDING 与 VIEWPORT，所以我们也不用管 FBO。
    renderer.doDrawModel(null);
  }

  /**
   * 告诉模型「你的本体实际画在视口的哪儿」，让它把自己挪到水平正中。
   *
   * `inkCenterX` 是**已经算成 NDC 的**本体中心横坐标（`-1` 左边缘、`+1` 右边缘、
   * `0` 正中）。传 `0` 表示不偏移。
   *
   * 量像素的那一侧在 `plugin.ts` 的帧循环里（必须紧跟 `draw()`，否则
   * `preserveDrawingBuffer: false` 会让绘制缓冲已经空掉，量到的是一片透明）。
   *
   * 非有限数一律当成 `0`：一个 `NaN` 平移量会把整个模型推出视口，
   * 而症状是「模型不见了」—— 比「没居中」难查得多。
   */
  public setInkCenterX(inkCenterX: number): void {
    if (!Number.isFinite(inkCenterX)) {
      this._inkCenterX = 0;
      return;
    }
    // 夹一下：量出来的值偶尔会因为模型只露出一角而离谱，把它挡在「最多
    // 挪一个视口宽」以内 —— 再大就一定是量错了，不是模型偏心。
    this._inkCenterX = Math.max(-1, Math.min(1, inkCenterX));
  }

  /** 当前生效的水平居中位移（NDC）。诊断用。 */
  public get inkCenterX(): number {
    return this._inkCenterX;
  }

  /**
   * 设定用户在舞台里调出来的视图（缩放 / 平移）。
   *
   * 传 `null`（或默认视图）恢复原样。每一帧都可以调，代价只是多一次矩阵乘法
   * —— 它不重启渲染循环、不碰动作与表情状态，所以拖动时模型照常在动。
   */
  public setStageView(view: StageView | null): void {
    if (view === null || view === undefined || isDefaultStageView(view)) {
      this._stageView = null;
      return;
    }
    this._stageView = clampStageView(view);
  }

  /** 当前生效的舞台视图（`null` = 默认）。诊断用。 */
  public get stageView(): StageView | null {
    return this._stageView;
  }

  /**
   * 把用户视图套到投影上（**左边乘**，即作用在最终 NDC 上）。
   *
   * 为什么是左乘：右乘（`projection.multiplyByMatrix(view)`）会让平移量先被
   * `scale(sx, sy)` 乘一遍 —— 拖动 100 像素，模型只挪 70 像素，
   * 手感是「拖不太动」，而且这个偏差还随窗口宽高比变。左乘的语义是
   * 「先按模型与舞台算好铺法，再把这张已经铺好的图整体缩放平移」，
   * 位移因此严格等于鼠标位移。
   *
   * 缩放围绕**舞台中心**（NDC 原点），不是围绕鼠标位置：围绕鼠标缩放需要一个
   * 「缩放后把鼠标那个点钉住」的补偿量，而那个补偿量在夹取之后会失效
   * （想放大的地方被上限挡住时，画面会跳）。围绕中心的代价只是「想放大哪块先
   * 拖过去」，但它永远不会跳。
   */
  private _withStageView(projection: CubismMatrix44, width: number, height: number): CubismMatrix44 {
    const view = this._stageView;
    if (view === null) {
      return projection;
    }
    const { zoom, tx, ty } = stageViewToNdc(view);
    const user = new CubismMatrix44();
    user.scale(zoom, zoom);
    user.translate(tx, ty);
    // `multiplyByMatrix` 是「this = this · 参数」，所以这样得到的是 user · projection。
    user.multiplyByMatrix(projection);
    // 舞台尺寸只在这一句里有意义：`tx/ty` 已经是 NDC 小数，与像素无关 ——
    // 换个窗口宽度重画，同一个视图仍然是对的。留参数是为了将来需要
    // 「按像素补偿」时不必改调用点（现在不用）。
    void width;
    void height;
    return user;
  }

  // -------------------------------------------------------------------------
  // 参数
  // -------------------------------------------------------------------------

  /**
   * 找参数下标。
   *
   * Framework 的 `getParameterIndex()` 在找不到时返回 **0**，跟"第 0 个参数"没法区分，
   * 而 `getParameterValueByIndex(0)` 会读取一个无关参数、`CSM_ASSERT` 还会打日志。
   * 所以这里自己按 id 建表，找不到返回 -1。
   */
  private findParameterIndex(id: string): number {
    const model = this.getModel();
    if (model === null || model === undefined || !isNonEmpty(id)) {
      return -1;
    }

    let cache = this._parameterIndexCache;
    if (cache === null || cache.size !== model.getParameterCount()) {
      cache = new Map<string, number>();
      const count = model.getParameterCount();
      for (let index = 0; index < count; index += 1) {
        const handle = model.getParameterId(index);
        if (handle === undefined || handle === null) {
          continue;
        }
        // getString() 返回的是 CubismString，toString() 才是原始 id。
        const name = handle.getString().toString();
        if (!cache.has(name)) {
          cache.set(name, index);
        }
      }
      this._parameterIndexCache = cache;
    }

    const found = cache.get(id);
    return found === undefined ? -1 : found;
  }

  /**
   * 宿主每帧调用：设定这一帧的口型张开度。
   *
   * `openness` 由调用方夹到 [0,1]（这里也夹一次，因为一个越界值会让嘴巴张成
   * 模型没设计过的形状，而 Cubism Core 不会报错，只会画得很怪）。
   * `form` 传 `null` 表示「这一帧不管嘴型」，保留动作/默认值写下的那个值。
   */
  public setMouthOverride(openness: number, form: number | null = null): void {
    const value = typeof openness === 'number' && isFinite(openness) ? Math.max(0, Math.min(1, openness)) : 0;
    const shape =
      typeof form === 'number' && isFinite(form) ? Math.max(-1, Math.min(1, form)) : null;
    this._mouthOverride = { openness: value, form: shape };
  }

  /** 交还口型控制权（例如说话结束、或卸载前）。 */
  public clearMouthOverride(): void {
    this._mouthOverride = null;
  }

  /** 这个模型有没有某个参数。用来在不支持口型的模型上优雅地什么都不做。 */
  public hasParameter(id: string): boolean {
    return this.findParameterIndex(id) >= 0;
  }

  /**
   * 给一个参数**加**一个值（不是覆盖）。
   *
   * 存在的理由只有一个：情绪层必须与眨眼 / 表情 / 动作共存，而 `setParameterValue()`
   * 的语义是「这块地归我了」。加法也是 Framework 自己的效果层用的写法
   * （`cubismlook.ts` / `cubismbreath.ts` 都调 `addParameterValueById`），
   * 所以这不是我们发明的规矩。
   *
   * 夹取由框架在 `setParameterValueByIndex()` 内部完成（`getParameterClampValue`），
   * 这里不重复一遍 —— 重复一遍会出现「两处各自以为自己对」的分叉。
   */
  public addParameterValue(id: string, value: number): void {
    const model = this.getModel();
    if (model === null || model === undefined) {
      return;
    }
    if (typeof value !== 'number' || !isFinite(value) || value === 0) {
      return;
    }
    const index = this.findParameterIndex(id);
    if (index < 0) {
      return;
    }
    model.addParameterValueByIndex(index, value);
  }

  /** Model parameter access; value is clamped by the caller, not here. */
  public getParameterValue(id: string): number | undefined {
    const model = this.getModel();
    if (model === null || model === undefined) {
      return undefined;
    }
    const index = this.findParameterIndex(id);
    if (index < 0) {
      return undefined;
    }
    return model.getParameterValueByIndex(index);
  }

  public setParameterValue(id: string, value: number, weight?: number): void {
    const model = this.getModel();
    if (model === null || model === undefined) {
      return;
    }
    const index = this.findParameterIndex(id);
    if (index < 0) {
      return;
    }
    const w = typeof weight === 'number' && isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 1;

    // 注意（5-r.5）：`setParameterValueByIndex(index, value, weight)` 只有三个参数，
    // **没有** `CubismParameterBlendMode` —— 那个枚举在这个版本里根本不存在。
    // weight === 1 时它是**硬覆盖**（直接赋值），这就是 ParamMouthOpenY /
    // ParamMouthForm 需要的语义。夹取由模型内部完成（getParameterClampValue），
    // 与任务约定一致：值由调用方自己保证范围，这里不额外夹。
    model.setParameterValueByIndex(index, value, w);
  }

  /** All parameter ids with their min/max/default, for building a capability manifest. */
  public describeParameters(): Array<{ id: string; min: number; max: number; def: number }> {
    const model = this.getModel();
    if (model === null || model === undefined) {
      return [];
    }
    const result: Array<{ id: string; min: number; max: number; def: number }> = [];
    const count = model.getParameterCount();
    for (let index = 0; index < count; index += 1) {
      const idHandle = model.getParameterId(index);
      const id = idHandle === undefined || idHandle === null ? '' : idHandle.getString().toString();
      result.push({
        id,
        min: model.getParameterMinimumValue(index),
        max: model.getParameterMaximumValue(index),
        def: model.getParameterDefaultValue(index),
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 能力清单
  // -------------------------------------------------------------------------

  /**
   * 当前模型的完整能力清单（`model:capabilities`，方案文档 §4.3）。
   *
   * 它是「AI 能控制什么」的唯一事实来源，而**只有客户端能产出完整的它**：
   *   - 参数：只能用 Cubism Core 枚举（Host 那边没有 Core）；
   *   - 表情 / 动作组 / 可点区域：只能在 `.model3.json` 里读，而这份原文就存在
   *     `this._rawSettings`。
   *
   * 拼接逻辑不写在这里，而是调 `lib/host/capabilities.js` 的 `buildCapabilities()`
   * —— Host 半区归一化网线上来的清单时用的是**同一个模块**，所以两边不可能对
   * 「清单长什么样」产生不同理解。门禁 `tools/test-capabilities.mjs` 里有一条
   * 恒等式断言钉着这件事。
   */
  public capabilities(): Capabilities {
    return buildCapabilities({
      settings: this._rawSettings,
      parameters: this.describeParameters(),
    });
  }

  // -------------------------------------------------------------------------
  // 动作与表情（P3：AI 控制闭环的落地点）
  // -------------------------------------------------------------------------

  /**
   * 把 `FileReferences.Motions` 读成清单。
   *
   * ★ **解析本身在 `lib/host/capabilities.js` 的 `motionFileTable()` 里**，
   *   这里只负责搬进自己的字段。以前两边各写一遍，对「空动作组」「小写字段名」
   *   这类边缘形状给出了不同的答案 —— 那种分歧不会报错，只会让 AI 拿到一个
   *   自己列出来、自己又拒绝的组名。共用一张表之后这种分歧**表达不出来**。
   *
   *   表里 `File` 为空的条目也占一个位置（`file === ''`），这是刻意的：
   *   `count` 数的是表的长度，Host 校验 `index` 用的也是它，跳过一条两边序号就错位。
   */
  private _collectMotionFiles(fileReferences: NonNullable<RawModel3Json['FileReferences']>): void {
    this._motionFiles.clear();
    this._motionCache.clear();
    this._motionPartOpacity.clear();
    this._activePartOpacity = null;
    this._defaultPartOpacity = null;
    for (const [group, entries] of motionFileTable(fileReferences)) {
      this._motionFiles.set(group, entries);
    }
  }

  /** 同 `_collectMotionFiles`：只保留名字与路径都非空的条目 —— 缺一个就没法被引用。 */
  private _collectExpressionFiles(fileReferences: NonNullable<RawModel3Json['FileReferences']>): void {
    this._expressionFiles.clear();
    this._expressionCache.clear();
    for (const [name, file] of expressionFileTable(fileReferences)) {
      this._expressionFiles.set(name, file);
    }
  }

  /** 模型里有哪些动作组（顺序与 `Capabilities.motionGroups` 一致）。 */
  public motionGroupNames(): string[] {
    return [...this._motionFiles.keys()];
  }

  /**
   * 正在播的那一段动作的优先级，`0` 表示什么都没在播。
   *
   * 直接转述框架的 `CubismMotionManager.getCurrentPriority()`
   * （`framework/src/motion/cubismmotionmanager.ts:34-36`）—— 它在
   * `startMotionPriority()` 里被写、在动作播完时被框架自己清零
   * （`cubismmotionmanager.ts:89-91`），所以这一个数字同时回答了
   * 「有没有在播」和「在播的是谁要的」。
   *
   * 存在的理由只有一个：自动待机需要它来避免把 AI 要的动作顶掉。
   * 见 `shouldAutoIdle()` 的第四个条件与方案 §4.2.12。
   */
  public currentMotionPriority(): number {
    const manager = this._motionManager;
    if (manager === null || manager === undefined) {
      return MOTION_PRIORITY.NONE;
    }
    const value = manager.getCurrentPriority();
    return typeof value === 'number' && isFinite(value) ? value : MOTION_PRIORITY.NONE;
  }

  /**
   * 思考态开关（来自 Host 的 `mood.state === 'thinking'`）。
   *
   * 只记一个布尔，不做任何算术 —— 包络与参数收幅都在每帧的 `_applyMotionCalm()`
   * 里推进，这样「什么时候开始收」与「这一帧要不要收」互不影响：Host 的轮询
   * 1.2 秒一次，而帧是 60 分之一秒。
   */
  public setMotionCalm(active: boolean): void {
    this._calmFromHost = active === true;
  }

  /** 当前包络值（`0`~`1`）。只给诊断与门禁用，渲染不看它。 */
  public get motionCalm(): number {
    return this._calm;
  }

  /** 某个动作组里有几个动作。`0` 表示没有这个组。 */
  public motionCount(group: string): number {
    return this._motionFiles.get(group)?.length ?? 0;
  }

  /** 模型里有哪些表情（顺序与 `Capabilities.expressions` 一致）。 */
  public expressionNames(): string[] {
    return [...this._expressionFiles.keys()];
  }

  /** 正在播的动作，形如 `Idle#2`；没在播时是空串。 */
  public get activeMotion(): string {
    return this._activeMotion;
  }

  /**
   * 从 `model3.json` 的 `Groups` 里取 `EyeBlink` / `LipSync` 两组参数 id。
   *
   * 找不到那一组就给空数组 —— **空数组是正确答案，`null` 是崩溃**（见
   * `_effectIdsCache` 的注释）。模型导出时把这两组写在 `Groups` 里是 Cubism 的
   * 标准做法，但并非强制，所以「没有」必须是一种能正常工作的状态。
   */
  private _effectIds(): { eyeBlink: CubismIdHandle[]; lipSync: CubismIdHandle[] } {
    if (this._effectIdsCache === null) {
      const pick = (name: string): CubismIdHandle[] => {
        const groups: Array<{ Name?: string; Ids?: string[] }> = this._rawSettings?.Groups ?? [];
        const group = groups.find((item) => item !== null && item !== undefined && item.Name === name);
        const list = group?.Ids ?? [];
        const out: CubismIdHandle[] = [];
        for (const id of list) {
          if (typeof id === 'string' && id !== '') {
            out.push(cachedId(id));
          }
        }
        return out;
      };
      this._effectIdsCache = { eyeBlink: pick('EyeBlink'), lipSync: pick('LipSync') };
    }
    return this._effectIdsCache;
  }

  /**
   * 加载（并缓存）一个动作。失败返回 `null`，**不抛**。
   *
   * `null` 会被记进缓存，所以同一个坏文件只会尝试一次。这不是优化：一个坏动作
   * 如果每次播放都重试一遍网络请求，`/pending` 每 1.2 秒轮询一次，用户看到的是
   * 桌宠持续卡顿而日志里刷满同一条错误。
   */
  private async _loadMotion(
    group: string,
    index: number,
    entry: { file: string; fadeIn: number; fadeOut: number },
  ): Promise<CubismMotion | null> {
    const key = `${group}#${index}`;
    const cached = this._motionCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (entry.file === '') {
      this._motionCache.set(key, null);
      return null;
    }
    let motion: CubismMotion | null = null;
    let partOpacity: MotionPartOpacity | null = null;
    try {
      const buffer = await fetchArrayBuffer(resolveAssetUrl(this._baseUrl, entry.file));
      // ★★ 部件透明度曲线必须自己读（2026-02），理由见 `part-curves.ts` 顶部：
      // Framework 拿 `getParameterIndex()` 去查部件 id，查不到就发一个「不存在的参数
      // 下标」，`setParameterValueByIndex()` 见到它把值存进一张 Map 就返回 —— 值永远
      // 到不了渲染器，也永远不报错。解析失败**不能连累动作本身**，所以自己包一层。
      try {
        const parsed = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
        partOpacity = parseMotionPartOpacity(parsed);
      } catch (error) {
        partOpacity = null;
        reportFailure('motion-part-curves', error);
      }
      // 用父类的 loadMotion 而不是直接 CubismMotion.create：前者会顺带把
      // model3.json 里声明的 FadeInTime / FadeOutTime 覆盖上去，并且内部
      // 对空 buffer 有保护（`buffer == null || size == 0` 时打日志返回 null）。
      motion = this.loadMotion(buffer, buffer.byteLength, key, undefined, undefined, undefined);
    } catch {
      motion = null;
    }
    if (motion !== null && motion !== undefined) {
      motion.setFadeInTime(entry.fadeIn);
      motion.setFadeOutTime(entry.fadeOut);
      // ★★ 这一步不能省（2026-02）。
      // 框架的 `CubismMotion` 构造函数把 `_eyeBlinkParameterIds` / `_lipSyncParameterIds`
      // 都设成 `null`（framework/src/motion/cubismmotion.ts:781-796），而
      // `doUpdateParameters()` 一进来就读它们的 `.length`（同文件 :404 / :410），
      // **没有 null 保护**；唯一的写入者就是 `setEffectIds()`（:770-776）。
      // 漏掉这一步的后果不是「眨眼不生效」那么轻：动作一进队列，`updateParameters()`
      // 每帧抛 `TypeError: Cannot read properties of null (reading 'length')`，
      // 异常从帧循环里穿出去 ⇒ 画面定格在最后一帧，而 JS、定时器、命令通道全都正常。
      // `_effectIds()` 保证给的是**数组**（取不到就是空数组），空数组的 `.length` 是 0，安全。
      const ids = this._effectIds();
      motion.setEffectIds(ids.eyeBlink, ids.lipSync);
    } else {
      motion = null;
    }
    this._motionCache.set(key, motion);
    this._motionPartOpacity.set(key, motion === null ? null : partOpacity);
    return motion;
  }

  /** 加载（并缓存）一个表情。失败返回 `null`，不抛。理由同 `_loadMotion`。 */
  private async _loadExpression(name: string, file: string): Promise<ACubismMotion | null> {
    const cached = this._expressionCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    let motion: ACubismMotion | null = null;
    try {
      const buffer = await fetchArrayBuffer(resolveAssetUrl(this._baseUrl, file));
      motion = this.loadExpression(buffer, buffer.byteLength, name);
    } catch {
      motion = null;
    }
    if (motion === null || motion === undefined) {
      motion = null;
    }
    this._expressionCache.set(name, motion);
    return motion;
  }

  /**
   * 播一个动作。
   *
   * `index` 省略时随机挑一个 —— 但**出厂校验过的那一条路径不是这里**：Host 的
   * `buildAction()` 已经把随机数定下来了（见 `actions.js` 的注释），所以
   * 「日志里的指令可复现」。渲染端这一层的随机只是给直接调 API 的场景兜底。
   */
  public async playMotion(
    group: string,
    index?: number,
    options?: { fadeMs?: number; loop?: boolean; priority?: number; avoidIndex?: number },
  ): Promise<MotionResult> {
    if (!this._ready || this._released) {
      return { ok: false, code: 'E_MODEL_NOT_READY', detail: '模型还没准备好，动作没法播。' };
    }
    const entries = this._motionFiles.get(group);
    if (entries === undefined) {
      return {
        ok: false,
        code: 'E_MOTION_GROUP_NOT_FOUND',
        detail: `没有叫「${group}」的动作组。可用：${this.motionGroupNames().join('、') || '（无）'}`,
      };
    }
    /*
     * 序号：显式给了就用它；没给就随机挑一个 —— 但**避开 `avoidIndex`**（§13.31）。
     *
     * 只在「调用方没点名」时才避开：AI 说「播第 3 个」，不能因为上次也是第 3 个
     * 就擅自换成第 4 个。这条区分是这段代码唯一容易写错的地方。
     */
    const explicitIndex = typeof index === 'number' && isFinite(index) ? Math.trunc(index) : null;
    let wanted: number;
    if (explicitIndex !== null) {
      wanted = explicitIndex;
    } else {
      wanted = Math.floor(Math.random() * entries.length);
      const avoid =
        typeof options?.avoidIndex === 'number' && isFinite(options.avoidIndex)
          ? Math.trunc(options.avoidIndex)
          : -1;
      if (entries.length > 1 && wanted === avoid) {
        wanted = (wanted + 1 + Math.floor(Math.random() * (entries.length - 1))) % entries.length;
      }
    }
    if (wanted < 0 || wanted >= entries.length) {
      return {
        ok: false,
        code: 'E_MOTION_INDEX_OUT_OF_RANGE',
        detail: `「${group}」只有 ${entries.length} 个动作，没有第 ${wanted} 个。`,
      };
    }
    const motion = await this._loadMotion(group, wanted, entries[wanted]);
    if (motion === null) {
      return {
        ok: false,
        code: 'E_MOTION_LOAD_FAILED',
        detail: `「${group}」第 ${wanted} 个动作读不出来（${entries[wanted].file || '路径为空'}）。`,
      };
    }
    const manager = this._motionManager;
    if (manager === null || manager === undefined) {
      return { ok: false, code: 'E_MODEL_NOT_READY', detail: '动作管理器不可用。' };
    }
    const fadeMs = options === null || options === undefined ? undefined : options.fadeMs;
    // ★ 淡入淡出**每次都写**，不能只在传了 `fadeMs` 时才写。
    //
    // 动作对象按 `组#序号` 缓存在 `_motionCache` 里、被反复复用，所以「这次不写」
    // 等于「沿用上一次的值」。而 `_loadMotion` 只在**第一次创建**时应用
    // `model3.json` 里声明的 `FadeInTime`/`FadeOutTime` —— 于是：
    //   · 工具调用总带 `fadeMs`（Host 填默认 300），第一次被 AI 播过之后，
    //     模型作者声明的淡入淡出就永久消失了；
    //   · 空闲行为那条路不带 `fadeMs`，复用到一个曾被设过 5000ms 的动作上，
    //     待机动作会一直用 5 秒淡入（看起来像「她愣了一下才动」）。
    // `resolveMotionFades()` 在缺省时把**声明值写回去**，所以这两条都不成立。
    const fades = resolveMotionFades(fadeMs, entries[wanted], MAX_FADE_MS / 1000);
    motion.setFadeInTime(fades.fadeIn);
    motion.setFadeOutTime(fades.fadeOut);
    motion.setLoop(options !== null && options !== undefined && options.loop === true);
    try {
      // `autoDelete = false` 是必须的：动作对象归 `_motionCache` 所有，播完由我们
      // 在 `release()` 里统一释放。传 true 的话框架播完就把它删了，缓存里留下一个
      // 悬空引用，第二次播同一个动作会**静默什么都不发生**。
      manager.startMotionPriority(motion, false, readMotionPriority(options));
      this._activeMotion = `${group}#${wanted}`;
      // 部件透明度：登记这次要写的曲线，之后每帧由 `_applyPartOpacity()` 写。
      // 键与 `_motionCache` / `_loadMotion` 用的完全一样（`组名#序号`）。
      const curves = this._motionPartOpacity.get(this._activeMotion);
      this._activePartOpacity =
        curves === null || curves === undefined || curves.curves.length === 0
          ? null
          : { motion: curves, startedAt: this._elapsed };
    } catch (error) {
      return { ok: false, code: 'E_MOTION_START_FAILED', detail: `动作起不来：${describeError(error)}` };
    }
    /*
     * 片段时长（§13.31）：自动待机拿它决定「这一条该在她身上停多久」。
     *
     * 必须用 `getLoopDuration()` 而不是 `getDuration()` —— 后者对循环动作返回
     * `-1`（`framework/src/motion/cubismmotion.ts:678-680`），而待机动作恰恰
     * 全是循环的。`getLoopDuration()` 永远回「一个循环的长度」（秒）。
     *
     * 读不到就留 `undefined`，让调用方退回 12 秒一刀切 —— 这是老 bundle 与
     * 坏动作文件的共同退路，不能在这里抛。
     */
    let motionDurationMs: number | undefined;
    try {
      const seconds = (motion as { getLoopDuration?: () => number }).getLoopDuration?.();
      if (typeof seconds === 'number' && isFinite(seconds) && seconds > 0) {
        motionDurationMs = Math.round(seconds * 1000);
      }
    } catch {
      motionDurationMs = undefined;
    }
    return {
      ok: true,
      code: '',
      detail: `正在播「${group}」第 ${wanted} 个动作。`,
      motionIndex: wanted,
      motionDurationMs,
    };
  }

  /**
   * 换一个表情。
   *
   * `holdMs` 到点后是**硬切回无表情**（没有淡出）：Framework 的
   * `CubismExpressionMotionManager` 只在「被新表情替换」时才走淡出，没有
   * 「自己淡出到零」的路径。与其造一个假的平滑，不如老实说清这里会跳一下。
   * 省略 `holdMs` 就是一直保持，直到下一个表情或模型被释放。
   *
   * **没有 `weight`**（契约表 §4.1 写过）。曾经这个签名里有一个 `weight?`，
   * 而它从头到尾没被读过 —— 因为 Framework 根本没有「按权重混合单个表情」这条路：
   * `ACubismMotion.setWeight()` 只参与**两个表情交叉淡入**时的混合比例
   * （`framework/src/motion/cubismexpressionmotion.ts:207` 那个
   * `if (expressionIndex == 0)` 分支根本不用 fadeWeight），而真正写进模型的权重是
   * `framework/src/motion/cubismexpressionmotionmanager.ts:207-213` 里**只由淡入时间
   * 算出**的 `expressionWeight`；更糟的是把 `_weight` 设成小于 1 会让
   * `latestFadeWeight >= 1.0` 这个回收条件永远不成立（同文件 `:230-243`），
   * 上一个表情再也退不掉。所以它是**接不上**，不是忘了接 ——
   * 与其留一个永远不生效的参数骗调用方，不如整条链上一个字都不留。详见方案 §4.2.8。
   */
  public async setExpression(
    name: string,
    options?: { holdMs?: number },
  ): Promise<MotionResult> {
    if (!this._ready || this._released) {
      return { ok: false, code: 'E_MODEL_NOT_READY', detail: '模型还没准备好，表情换不了。' };
    }
    const file = this._expressionFiles.get(name);
    if (file === undefined) {
      return {
        ok: false,
        code: 'E_EXPRESSION_NOT_FOUND',
        detail: `没有叫「${name}」的表情。可用：${this.expressionNames().join('、') || '（无）'}`,
      };
    }
    const motion = await this._loadExpression(name, file);
    if (motion === null) {
      return {
        ok: false,
        code: 'E_EXPRESSION_LOAD_FAILED',
        detail: `表情「${name}」的文件读不出来（${file}）。`,
      };
    }
    const manager = this._expressionManager;
    if (manager === null || manager === undefined) {
      return { ok: false, code: 'E_MODEL_NOT_READY', detail: '表情管理器不可用。' };
    }
    this._clearExpressionTimer();
    try {
      manager.startMotion(motion, false);
    } catch (error) {
      return { ok: false, code: 'E_EXPRESSION_START_FAILED', detail: `表情起不来：${describeError(error)}` };
    }
    const holdMs = options === null || options === undefined ? undefined : options.holdMs;
    if (typeof holdMs === 'number' && isFinite(holdMs) && holdMs > 0) {
      const delay = Math.min(holdMs, MAX_HOLD_MS);
      this._expressionReleaseTimer = setTimeout(() => {
        this._expressionReleaseTimer = null;
        this.clearExpression();
      }, delay);
    }
    return { ok: true, code: '', detail: `换成了「${name}」表情。` };
  }

  /**
   * 撤掉当前表情。
   *
   * 与 `_clearExpressionTimer()` 分开是为了让「定时器到点」这条路径也能干净地
   * 走到这里 —— 在定时器回调里再清一次自己的句柄是多余的，但绝不能漏掉
   * 「先清句柄再动手」的顺序，否则回调里清掉的会是**下一个**表情的定时器。
   */
  public clearExpression(): void {
    this._clearExpressionTimer();
    const manager = this._expressionManager;
    if (manager === null || manager === undefined) {
      return;
    }
    try {
      manager.stopAllMotions();
    } catch {
      // 释放路径上不抛。
    }
  }

  private _clearExpressionTimer(): void {
    if (this._expressionReleaseTimer !== null) {
      clearTimeout(this._expressionReleaseTimer);
      this._expressionReleaseTimer = null;
    }
  }

  /**
   * 看向某个方向。`x` / `y` 都在 `[-1, 1]`，用 `options.durationMs` 毫秒转过去
   * （省略时用 §4.1 的默认值 400，上限 5000）。
   *
   * 这里**不写参数**，只移动目标点：`TimedLookTarget` 每帧算出当前视线位置，
   * `CubismLookUpdater` 再把它加进 `ParamAngleX/Y/Z` 等参数。好处是
   * 「看向这里」和呼吸、眨眼、物理是同一套叠加语义，不会互相打架。
   */
  public lookAt(x: number, y: number, options?: { durationMs?: number }): MotionResult {
    const dragManager = this._dragManager;
    if (dragManager === null || dragManager === undefined) {
      return { ok: false, code: 'E_MODEL_NOT_READY', detail: '视线控制器不可用。' };
    }
    const tx = clampUnit(x);
    const ty = clampUnit(y);
    const durationMs =
      options === null || options === undefined ? undefined : options.durationMs;
    try {
      if (dragManager instanceof TimedLookTarget) {
        dragManager.glideTo(tx, ty, durationMs);
      } else {
        // 到不了这里（`load()` 换过了），但真到了也不该静默按框架那套转：
        // 那只会在「时长参数没生效」这件事上再骗一次人。
        dragManager.set(tx, ty);
      }
    } catch (error) {
      return { ok: false, code: 'E_LOOK_FAILED', detail: `视线动不了：${describeError(error)}` };
    }
    const ms = typeof durationMs === 'number' && isFinite(durationMs) ? Math.round(durationMs) : '默认';
    return {
      ok: true,
      code: '',
      detail: `看向 (${tx.toFixed(2)}, ${ty.toFixed(2)})，用时 ${ms}${ms === '默认' ? '' : 'ms'}。`,
    };
  }

  /**
   * 参数逃生通道：直接把一组参数钉在指定值上，直到过期或被清掉。
   *
   * **口型参数会被丢掉**，不是夹取也不是覆盖：§4.1 硬规则 1 说 `ParamMouthOpenY` /
   * `ParamMouthForm` 由 TTS 口型通道独占。丢掉之后这条指令的其余参数照常生效 ——
   * 整条拒掉会让「笑一下同时把头转过来」这种合理指令莫名其妙地失败。
   *
   * 比较 id 时**大小写与下划线都不敏感**（`actions.js` 的 `normalizeParameterKey`
   * 是同一套规则）：从别的格式转过来的模型会写 `PARAM_MOUTH_OPEN_Y`，
   * 只转小写是拦不住的 —— 那个 bug 在 `test-actions.mjs` 里被抓到过一次。
   */
  public setParameterOverride(
    values: Record<string, number> | null | undefined,
    holdMs?: number,
  ): { applied: string[]; dropped: string[]; ignored: string[] } {
    this._clearParameterOverrideTimer();
    const applied: string[] = [];
    const dropped: string[] = [];
    const ignored: string[] = [];
    if (values === null || values === undefined || typeof values !== 'object') {
      return { applied, dropped, ignored };
    }
    this._parameterOverrides.clear();
    for (const id of Object.keys(values)) {
      if (isExclusiveParameter(id)) {
        dropped.push(id);
        continue;
      }
      const value = values[id];
      if (typeof value !== 'number' || !isFinite(value) || !this.hasParameter(id)) {
        // `hasParameter` 为假**不算错**：能力清单是渲染端自己报上去的，
        // 而清单可能落后于一次正在进行的换装。丢掉它，其余参数继续生效。
        ignored.push(id);
        continue;
      }
      this._parameterOverrides.set(id, value);
      applied.push(id);
    }
    if (typeof holdMs === 'number' && isFinite(holdMs) && holdMs > 0) {
      this._parameterOverrideTimer = setTimeout(() => {
        this._parameterOverrideTimer = null;
        this._parameterOverrides.clear();
      }, Math.min(holdMs, MAX_HOLD_MS));
    }
    return { applied, dropped, ignored };
  }

  /** 撤掉参数覆盖。 */
  public clearParameterOverrides(): void {
    this._clearParameterOverrideTimer();
    this._parameterOverrides.clear();
  }

  /**
   * 叠一层情绪（参数**增量**）。
   *
   * 与 `setParameterOverride()` 是两条通道，不是一个东西的两种写法：
   *   - 那个**硬覆盖**（`setParameterValue`，写在每帧最后、权重 1），会盖掉眨眼、
   *     表情和动作自带的脸部曲线；
   *   - 这个**加法**（`addParameterValueById`），与它们共存。
   * 「开心」和「正在眨眼」必须能同时成立 —— 否则她一笑就不眨眼，而眨眼是我们
   * 唯一一直开着的「她还活着」信号。
   *
   * ★ 语义上**和 `setParameterOverride()` 不同的一处**（D 期改的）：这里不是
   * 「先撤旧的再装新的」那种整层替换。旧的层会在 `EMOTION_SWITCH_FADE_MS` 里
   * 化掉，新的层同时在淡入 —— 两层在中间那几十毫秒里同时往同一个参数上写。
   * 这是刻意的：一帧换脸不是表情，是一次抽搐。
   *
   * 口型参数丢掉、模型里没有的 id 丢掉、丢掉的照实回报（与另一条通道一致）。
   * `holdMs === 0` 表示一直保持；`values` 为空对象等于 `clearEmotion()`。
   */
  public setEmotion(
    values: Record<string, number> | null | undefined,
    options?: {
      holdMs?: number;
      attackMs?: number;
      releaseMs?: number;
      /**
       * ★ 退场形状（§13.33）：`> 0` 走指数尾（默认 7 秒的 τ），`0` 走老的线性淡出。
       *
       * 兼容靠「传了 `releaseMs` 就是线性」这个约定（见 `resolveEmotion()`）：
       * 旧 Host 发来的指令里一定带 `releaseMs`，新 Host 不带 —— 所以新老两端
       * 混着跑也不会让一次性表演变成「慢慢消失」。
       */
      decayMs?: number;
      name?: string;
      fadeMs?: number;
    },
  ): { applied: string[]; ignored: string[] } {
    const applied: string[] = [];
    const ignored: string[] = [];

    if (values === null || values === undefined || typeof values !== 'object') {
      return { applied, ignored };
    }

    const params: Record<string, number> = {};
    for (const id of Object.keys(values)) {
      if (isExclusiveParameter(id)) {
        ignored.push(id);
        continue;
      }
      const delta = values[id];
      // `hasParameter` 为假不算错（能力清单可能落后于一次正在进行的换装）。
      if (typeof delta !== 'number' || !isFinite(delta) || !this.hasParameter(id)) {
        ignored.push(id);
        continue;
      }
      params[id] = delta;
      applied.push(id);
    }
    if (applied.length === 0) {
      return { applied, ignored };
    }

    /*
     * ★ 退场形状（§13.33）的优先级：**说清楚了就听它的**。
     *
     *  - 带了 `decayMs`（新 Host，`0` 也算带了）→ 按它走；
     *  - 只带 `releaseMs`（旧 Host）→ 线性淡出，指数尾关掉；
     *  - 两个都没带（手搓的调用）→ 默认指数尾。
     */
    const releaseGiven = typeof options?.releaseMs === 'number' && typeof options?.decayMs !== 'number';
    const decayValue = typeof options?.decayMs === 'number' && isFinite(options.decayMs)
      ? options.decayMs
      : (releaseGiven ? 0 : EMOTION_DECAY_MS);

    this._emotions = setEmotionLayers(this._emotions, {
      name: typeof options?.name === 'string' ? options.name : '',
      params,
      holdMs: Math.round(this._clampEmotionMs(options?.holdMs, 0, EMOTION_MAX_HOLD_MS, EMOTION_DEFAULT_HOLD_MS)),
      attackMs: Math.round(this._clampEmotionMs(options?.attackMs, 0, EMOTION_MAX_FADE_MS, EMOTION_ATTACK_MS)),
      releaseMs: Math.round(this._clampEmotionMs(options?.releaseMs, 0, EMOTION_MAX_FADE_MS, EMOTION_RELEASE_MS)),
      decayMs: Math.round(this._clampEmotionMs(decayValue, 0, 120000, EMOTION_DECAY_MS)),
    }, { fadeMs: this._clampEmotionMs(options?.fadeMs, 0, EMOTION_MAX_FADE_MS, EMOTION_SWITCH_FADE_MS) }).state;
    return { applied, ignored };
  }

  /**
   * 撤掉情绪层。
   *
   * 也是**化掉**而不是剪掉（`EMOTION_CLEAR_FADE_MS`）：「平静」的语义是她的表情
   * 松开，不是有人把画面切了一刀。
   */
  public clearEmotion(): void {
    this._emotions = clearEmotionLayers(this._emotions, { fadeMs: EMOTION_CLEAR_FADE_MS }).state;
  }

  /**
   * ★ 按名字收掉某几层（只收它们）。
   *
   * 退场用的是同一个 `EMOTION_CLEAR_FADE_MS`：收一层同样是「让位」，不是剪掉。
   * 收一层**没挂上**的层是正常情况（思考态可能已经自己到期），所以不报错，
   * 把 `unknown` 交回去让调用方在日志里说清楚。
   */
  public releaseEmotion(names: string[]): { released: string[]; unknown: string[] } {
    const outcome = releaseEmotionLayers(this._emotions, names, { fadeMs: EMOTION_CLEAR_FADE_MS });
    this._emotions = outcome.state;
    return { released: outcome.released, unknown: outcome.unknown };
  }

  /**
   * 此刻这张脸上是什么（没有就是空串）。
   *
   * 面板要显示它，所以必须是**读得到**的。交叉淡出期间会返回两层
   * （`难过(0.62)+开心(0.38)`）—— 那是这一层唯一诚实的答案。
   */
  public emotionName(): string {
    return describeEmotionLayers(this._emotions);
  }

  /**
   * 面板读数用：每层叫什么、还剩多少、是不是余波（§13.33）。
   *
   * `emotionName()` 是给人看的一句话，只有两层同时在场时才带数字 —— 于是
   * 「一层从 1.00 衰减到 0.37」这件事在面板上**完全看不见**，而看不见就等于
   * 没改。这里把权重原样交出去，让面板能写成 `情绪 开心 0.37`。
   */
  public emotionLayers(): { name: string; weight: number; residue: boolean }[] {
    return this._emotions.active.map((layer) => ({
      name: layer.name,
      weight: layer.weight,
      residue: layer.residue === true,
    }));
  }

  private _clampEmotionMs(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !isFinite(value)) return fallback;
    return value < min ? min : (value > max ? max : value);
  }

  /**
   * 每帧把情绪层叠上去。
   *
   * `delta` 是**秒**（框架的 `update(deltaTimeSeconds)` 约定），状态机吃的是毫秒 ——
   * 包络的四个常量都是毫秒，换算只在这一处发生。
   *
   * 权重到 0 的层由状态机从表里摘掉，这一帧就不再写它。两者在画面上一样，但
   * 「当前有没有情绪」这个问题的答案不一样，而面板与开关要读它。
   */
  private _applyEmotion(delta: number): void {
    const state = this._emotions;
    if (state.layers.length === 0) {
      return;
    }
    const model = this.getModel();
    if (model === null || model === undefined) {
      return;
    }
    const step = typeof delta === 'number' && isFinite(delta) && delta > 0 ? delta : 0;
    const frame = advanceEmotionLayers(state, step * 1000);
    this._emotions = frame.state;
    for (const id of Object.keys(frame.values)) {
      this.addParameterValue(id, frame.values[id]);
    }
  }

  /**
   * ★ 静息漂移（§13.33）—— 「她不动的时候也在慢慢动」。
   *
   * 和另外两层（待机小动作、微动作）的分工：
   *  - 那两层是**事件**：隔几秒来一下，有起止；
   *  - 这一层是**背景**：一直都在，幅度小一个量级，没有起止。
   *
   * 三道闸门：
   * ① 只有舞台上有模型、且这个模型有头/视线/眉毛参数时才写（`_ensureAmbientDrift()`）；
   * ② 正在播正经动作（优先级 > `IDLE`）时压到 40% —— 动作本身已经在动头，漂移
   *    再加满幅会和它对冲；不归零是因为「冻结」比「多一点」更容易被看出来；
   * ③ 时钟只在这里累加（和待机小动作同一个理由：页面隐藏期间不该白走）。
   */
  private _applyAmbientDrift(delta: number): void {
    if (!this._driftEnabled) return;
    const model = this.getModel();
    if (model === null || model === undefined) return;
    const step = typeof delta === 'number' && isFinite(delta) && delta > 0 ? delta : 0;
    if (step <= 0) return;
    this._driftClockMs += Math.min(step * 1000, GARNISH_MAX_STEP_MS);
    const resolved = this._ensureAmbientDrift();
    if (resolved === null) return;
    const factor = isBusyWithRealMotion(this.currentMotionPriority()) ? 0.4 : 1;
    const values = ambientDriftValues(this._driftClockMs, resolved, { factor });
    for (const id of Object.keys(values)) {
      this.addParameterValue(id, values[id]);
    }
  }

  /**
   * 角色 → 真实参数 id 的解析，只在第一次用到（或换模型之后）做一次。
   *
   * 换模型时 `describeParameters()` 会变，所以 `load()`/`release()` 里把
   * `_driftResolved` 置空，这里再懒解析 —— 比在每个调用点都记得刷新更不容易漏。
   */
  private _ensureAmbientDrift(): Record<string, { id: string; amp: number }> | null {
    if (this._driftResolved !== null) return this._driftResolved;
    const parameters = this.describeParameters();
    if (parameters.length === 0) return null;
    const resolved = resolveAmbientDrift(parameters);
    this._driftResolved = Object.keys(resolved).length === 0 ? {} : resolved;
    return this._driftResolved;
  }

  /**
   * 开关静息漂移（面板/门禁用；默认开）。
   *
   * 关掉时**不**把已经写进去的增量拉回来 —— 漂移每帧只写几十毫弧度，下一帧
   * 就没有了；反过来「关掉时补一次反向增量」会在画面上留下一次可见的抖动。
   */
  public setAmbientDrift(enabled: boolean): void {
    this._driftEnabled = enabled === true;
  }

  /** 静息漂移此刻是不是开着（面板要显示它）。 */
  public get ambientDriftEnabled(): boolean {
    return this._driftEnabled;
  }

  /**
   * 面板读数用：漂移解析到几根轴、最大幅度多少（参数自己的单位，角度参数就是度）。
   *
   * 幅度是「量程 × 比例」，所以 `1.44` 在 ±30 度的头上是 1.44 度、在 ±10 度上还是
   * 1.44 度但占比更大 —— 面板把它写出来，正是为了让「按比例给幅度」这句可核对。
   * `damped` 说明此刻有正经动作在播（漂移压到 40%）。
   */
  public ambientDriftSummary(): { enabled: boolean; roles: number; maxAmp: number; damped: boolean } {
    const resolved = this._ensureAmbientDrift() ?? {};
    const roles = Object.keys(resolved);
    let maxAmp = 0;
    for (const role of roles) {
      const amp = Math.abs(Number(resolved[role]?.amp ?? 0));
      if (isFinite(amp) && amp > maxAmp) maxAmp = amp;
    }
    return {
      enabled: this._driftEnabled,
      roles: roles.length,
      maxAmp,
      damped: isBusyWithRealMotion(this.currentMotionPriority()),
    };
  }

  /**
   * 待机小动作：排期 → 挑一个 → 按包络叠上去。
   *
   * 三道闸门都得过：
   * ① 正在播正经动作（优先级 > `IDLE`）时不叠 —— AI 点名的动作是用户要看的；
   * ② 视线已经被 `look_at` 拉到一边（或在转的途中）时，跳过会动视线的那几个；
   * ③ 思考时按 `calmFactorFor(_calm)` 打折 —— 「收着点」管的是整个角色的安静
   *    程度，不该只收自带动作、放任小动作照旧满幅。
   *
   * 时序（`_garnishClockMs`）只在这里累加，所以页面隐藏、舞台卸载期间不会白走；
   * 播完才排下一次，间隔在 `idle-garnish.ts` 的 `nextDelayMs()` 里。
   */
  private _applyGarnish(delta: number): void {
    /*
     * 有包就走微动作层，没有才演手写那七条（§13.26）。
     * 只选一层的原因写在 `micro-motion.ts` 的文件头：两层同时演，往同一批
     * 参数上做加法，幅度会翻倍。
     */
    if (this._microPack !== null) {
      this._applyMicroMotion(delta);
      return;
    }
    const rawMs = typeof delta === 'number' && isFinite(delta) && delta > 0 ? delta * 1000 : 0;
    const step = rawMs > GARNISH_MAX_STEP_MS ? GARNISH_MAX_STEP_MS : rawMs;
    this._garnishClockMs += step;

    const busy = isBusyWithRealMotion(this.currentMotionPriority());

    if (this._garnish.gesture !== null) {
      if (busy) {
        // 被打断：立刻撤掉，不然它和正经动作抢同一批参数（加法叠上去会变形）。
        this._garnish = createGarnishState();
        this._garnishNextAtMs = this._garnishClockMs + GARNISH_ABORT_DELAY_MS;
        return;
      }
      // `garnishValues()` 就地推进（`state` 是同一对象），播完时它自己把 gesture 置空。
      const frame = garnishValues(this._garnish, step, calmFactorFor(this._calm));
      for (const id of Object.keys(frame.values)) {
        this.addParameterValue(id, frame.values[id]);
      }
      if (frame.done) {
        this._garnishNextAtMs = this._garnishClockMs + nextDelayMs(this._garnishRng);
      }
      return;
    }

    if (this._garnishNextAtMs <= 0) {
      // 刚加载完：先排一次，别在模型刚出现的第一帧就抽一下。
      this._garnishNextAtMs = this._garnishClockMs + nextDelayMs(this._garnishRng);
      return;
    }
    if (this._garnishClockMs < this._garnishNextAtMs) {
      return;
    }
    if (busy) {
      this._garnishNextAtMs = this._garnishClockMs + GARNISH_ABORT_DELAY_MS;
      return;
    }
    const gesture = pickGesture(this._garnishRng, {
      avoidId: this._garnishLastId,
      allowGaze: this._lookAllowsGaze(),
    });
    if (gesture === null) {
      this._garnishNextAtMs = this._garnishClockMs + GARNISH_ABORT_DELAY_MS;
      return;
    }
    this._garnish = { gesture, elapsedMs: 0 };
    this._garnishLastId = gesture.id;
    this._garnishCount += 1;
  }

  /**
   * 微动作层（§13.26）：十四种「歪头 / 侧身 / 瞟一眼」里挑一条，按包络叠上去。
   *
   * 闸门与手写七条完全一致 —— 正经动作忙就撤、`look_at` 拽着视线就不动眼、
   * 思考时整体打折；换掉的只有「演什么」与「隔多久演一次」。
   *
   * 说话档由 `setTalking()` 灌进来：口型是主角，微动作在说话时只能更轻更短，
   * 所以说话档同样只挑 `modes` 含 `talk` 的那几条。
   */
  private _applyMicroMotion(delta: number): void {
    const pack = this._microPack;
    if (pack === null) return;
    const rawMs = typeof delta === 'number' && isFinite(delta) && delta > 0 ? delta * 1000 : 0;
    const step = rawMs > GARNISH_MAX_STEP_MS ? GARNISH_MAX_STEP_MS : rawMs;
    const frame = microMotionValues(this._microState, {
      deltaMs: step,
      pack,
      mode: this._microTalking ? 'talk' : 'idle',
      emotions: this._emotions.active.map((layer) => layer.name),
      allowGaze: this._lookAllowsGaze(),
      factor: calmFactorFor(this._calm),
      paused: isBusyWithRealMotion(this.currentMotionPriority()),
      random: this._microRng,
    });
    for (const id of Object.keys(frame.values)) {
      this.addParameterValue(id, frame.values[id]);
    }
  }

  /**
   * 换上一份微动作包（插件在能力清单上报之后取回来的那份）。
   *
   * `null` = 这个模型没有包，退回手写那七条。换包时把播放器归零（但**不**归零
   * 时钟）：归零时钟会让「刚换完模型 0.3 秒就抽一下」。
   */
  public setMicroMotionPack(pack: unknown): void {
    const normalised = normalizeMicroMotionPack(pack);
    const clock = this._microState.clockMs;
    this._microState = createMicroMotionState();
    this._microState.clockMs = clock;
    this._microPack = normalised;
  }

  /** 说话中（插件每帧灌一次；只在状态变化时改排期）。 */
  public setTalking(talking: boolean): void {
    const next = talking === true;
    if (next === this._microTalking) return;
    this._microTalking = next;
    // 进入说话：本来就该比待机早一点动，别等满 15 秒。
    if (next && this._microState.gesture === null) {
      this._microState.nextAtMs = this._microState.clockMs + 1200;
    }
  }

  /** 微动作包（诊断用；面板读的是 Host 的那份）。 */
  public get microMotionPack(): MicroMotionPack | null {
    return this._microPack;
  }

  /**
   * 立刻演某一条（§13.30）：面板「试演」与 `live2d_micro_motion` 工具的落点。
   *
   * 返回值与 `playMotion` 同形（`{ok, code, detail}`），因为调用它的是同一层
   * `action-runner`：那一层只认这个形状，多一个类型它就要多一个分支。
   */
  public playMicroMotion(id: string): { ok: boolean; code: string; detail: string } {
    const wanted = typeof id === 'string' ? id.trim() : '';
    if (wanted === '') {
      return { ok: false, code: 'E_MICRO_BAD_ID', detail: '没说要演哪一条。' };
    }
    if (this._microPack === null) {
      return { ok: false, code: 'E_MICRO_NO_PACK', detail: '这个模型还没有微动作包。' };
    }
    const started = startMicroMotion(this._microState, this._microPack, wanted);
    if (started === null) {
      // 错误必须可自愈：把现有的 id 列出来，调用方不用再猜一次（§4.1 硬规则 2）。
      const ids = this._microPack.gestures.map((entry) => entry.id).slice(0, 24).join('、');
      return {
        ok: false,
        code: 'E_MICRO_UNKNOWN_GESTURE',
        detail: `这个模型的微动作里没有 ${JSON.stringify(wanted)}（有：${ids}）。`,
      };
    }
    return { ok: true, code: '', detail: `演「${started.label === '' ? wanted : started.label}」` };
  }

  /** 正在演的这条叫什么（没有就是空串）。 */
  public microMotionName(): string {
    return this._microState.gesture === null ? '' : this._microState.gesture.id;
  }

  /** 这一次加载一共播了多少条微动作。 */
  public get microMotionCount(): number {
    return this._microState.count;
  }

  /** 现在能不能自己加「看这边」的小动作。`look_at` 是这条方向的最终解释者。 */
  private _lookAllowsGaze(): boolean {
    const dragManager = this._dragManager;
    if (!(dragManager instanceof TimedLookTarget)) {
      return true;
    }
    if (!dragManager.settled()) {
      return false;
    }
    return (
      Math.abs(dragManager.getX()) <= GARNISH_GAZE_ALLOWED_OFFSET &&
      Math.abs(dragManager.getY()) <= GARNISH_GAZE_ALLOWED_OFFSET
    );
  }

  /** 正在播的待机小动作名（没有就是空串）。诊断用，面板与门禁都不依赖它。 */
  public garnishName(): string {
    const gesture = this._garnish.gesture;
    return gesture === null ? '' : gesture.id;
  }

  /** 这一次加载一共播了多少个小动作。 */
  public get garnishCount(): number {
    return this._garnishCount;
  }

  private _clearParameterOverrideTimer(): void {
    if (this._parameterOverrideTimer !== null) {
      clearTimeout(this._parameterOverrideTimer);
      this._parameterOverrideTimer = null;
    }
  }

  /** 停掉所有动作（`live2d_stop_speaking` 与打断走这里）。 */
  public stopMotion(): void {
    const manager = this._motionManager;
    this._activeMotion = '';
    this._activePartOpacity = null;
    if (manager === null || manager === undefined) {
      return;
    }
    try {
      /*
       * ★ 重复调用 `stopAllMotions()`，而不是调用一次 —— 框架那个函数删不干净。
       *
       * `CubismMotionQueueManager.stopAllMotions()`（`framework/src/motion/
       * cubismmotionqueuemanager.ts:152-170`）在 `for (i = 0; i < length; i++)`
       * 里做 `splice(i, 1); continue;`：删掉第 i 个之后数组左移，`i++` 于是**跳过**
       * 了原本的第 i+1 个。实测存活情况：n=1 → `[]`、n=2 → `[E1]`、n=3 → `[E1]`、
       * n=4 → `[E1, E3]`。也就是说队列里有两条以上时，它**并不是**「停掉所有动作」。
       *
       * 留一条活的 `loop: true` 会连带两件事：那条永远不会 `isFinished()`，于是
       * `CubismMotionManager.updateMotion()`（`cubismmotionmanager.ts:89-91`）永远
       * 不重置优先级，`currentMotionPriority()` 停在旧值上 —— 待机判定
       * `shouldAutoIdle()` 的第四个条件（`action-runner.ts:529-546`）就此失效，
       * 她会一直重复同一个姿势。
       *
       * 这是**行为**缺陷，不是画面卡死：活着的循环动作照旧每帧在动。别把它当成
       * 「冻住」的解释（那个解释已经被证伪，见 `plugin.ts` 里待机分支的注释）。
       */
      for (let guard = 0; guard < MAX_MOTION_QUEUE_DRAIN; guard += 1) {
        if (manager.getCubismMotionQueueEntries().length === 0) {
          return;
        }
        manager.stopAllMotions();
      }
    } catch {
      // 释放路径上不抛。
    }
  }

  // -------------------------------------------------------------------------
  // 释放
  // -------------------------------------------------------------------------

  /** Frees GL + Core resources. Safe to call twice. */
  public release(): void {
    if (this._released) {
      return;
    }
    this._released = true;
    this._ready = false;

    // 定时器必须先清：它回调里会去碰 `_expressionManager`，而下面父类的 release
    // 会把它置 null。晚一步清就是一条「随机几秒后炸一次」的悬空回调。
    this._clearExpressionTimer();
    this._clearParameterOverrideTimer();
    this._parameterOverrides.clear();

    // 动作与表情的对象归我们管（startMotion 传的是 autoDelete = false）。
    // 先 stopAllMotions 把队列清空，再逐个 delete —— 顺序反过来的话，队列里
    // 的条目会持有一个已经被删掉的动作。
    this.stopMotion();
    for (const motion of this._motionCache.values()) {
      if (motion !== null && motion !== undefined) {
        try {
          ACubismMotion.delete(motion);
        } catch {
          // 释放路径上不抛。
        }
      }
    }
    this._motionCache.clear();
    this._motionFiles.clear();
    this._motionPartOpacity.clear();
    this._activePartOpacity = null;
    this._defaultPartOpacity = null;
    // 情绪层没有定时器，但它持有参数 id 与增量；释放时一并摘掉，免得换装之后
    // 新模型继承上一只的表情（换装会新建一个 PetModel，但 release 也会被走到）。
    this._emotions = createEmotionLayers();
    // 漂移的角色表绑在这个模型的参数 id 上，释放时必须一起清：下一个模型建出来
    // 之前谁都不该拿着上一只模型的 id 往新参数表里写。
    this._driftResolved = null;
    this._driftClockMs = 0;
    // 微动作的包归插件管（换模型时插件会重新灌一份）；这里只清播放器状态，
    // 不清 `_microPack` —— 触发 release 的那个新模型下一秒就要把新包塞进来。
    this._microState = createMicroMotionState();

    const expressionManager = this._expressionManager;
    if (expressionManager !== null && expressionManager !== undefined) {
      try {
        expressionManager.stopAllMotions();
      } catch {
        // 同上。
      }
    }
    for (const motion of this._expressionCache.values()) {
      if (motion !== null && motion !== undefined) {
        try {
          ACubismMotion.delete(motion);
        } catch {
          // 同上。
        }
      }
    }
    this._expressionCache.clear();
    this._expressionFiles.clear();

    if (this._look !== null) {
      try {
        CubismLook.delete(this._look);
      } catch {
        // 同上。
      }
      this._look = null;
    }
    this._activeMotion = '';

    // 先把自定义 updater 摘掉，再走父类的 release（父类会释放 physics/pose/eyeBlink/breath）。
    const scheduler = this._scheduler as unknown as { release?: () => void };
    if (typeof scheduler.release === 'function') {
      try {
        scheduler.release();
      } catch {
        // 释放路径上不抛。
      }
    }

    // 纹理归我们管：renderer.release() 只清 Map，不删 GL 对象。
    for (const texture of this._ownedTextures) {
      try {
        this._gl.deleteTexture(texture);
      } catch {
        // gl 可能已经随 canvas 一起没了。
      }
    }
    this._ownedTextures = [];

    // 模型定义原文也归我们管：释放之后 `capabilities()` 只该描述「这只模型」，
    // 而它已经没了。留着的话换装后若有人误调旧实例，会拿到上一只模型的能力清单。
    this._rawSettings = null;
    // `_effectIdsCache` 是从 `_rawSettings.Groups` 推出来的，同生共死。
    this._effectIdsCache = null;

    try {
      // 父类内部对每个可空成员都做了判空，半加载状态下调是安全的。
      super.release();
    } catch {
      // 幂等优先：第二次调用、或半成品状态下调用都不该炸。
    }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** `<img>` 兜底路径。 */
function loadImageElement(url: string, relativePath: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new PetModelError('E_TEXTURE_MISSING', `${relativePath} 作为图片解码失败（${url}）`));
    };
    image.src = url;
  });
}

/** 可选资源：取不到就返回 null，不抛。 */
async function tryFetchArrayBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    return await fetchArrayBuffer(url);
  } catch {
    return null;
  }
}

/** Core 的最高 moc3 版本；Core 不在或抛异常时返回 0（表示"未知"）。 */
function getLatestMocVersion(): number {
  const core = typeof window === 'undefined' ? undefined : window.Live2DCubismCore;
  if (core === undefined || core === null || core.Version === undefined || core.Version === null) {
    return 0;
  }
  try {
    return core.Version.csmGetLatestMocVersion();
  } catch {
    return 0;
  }
}

/**
 * 把 GL 上下文里的预乘状态确认一遍。
 *
 * 坑：WebGL 的 `UNPACK_PREMULTIPLY_ALPHA_WEBGL` 是**上下文全局**状态，不在纹理对象上。
 * 上传完最后一张纹理后再碰 `pixelStorei`（或者别的库这么干）就会把它关掉，
 * 而渲染器对此的检查只打在日志里（`CubismLogError('NoPremultipliedAlpha is not allowed')`），
 * 画面会静默变成黑边。所以每帧开画前重新钉一次。
 */
function shaderIsPremultiplied(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
}

/** 动作优先级：没指定就用 `NORMAL`（见 `MOTION_PRIORITY` 的注释）。 */
function readMotionPriority(options?: { priority?: number }): number {
  const value = options === null || options === undefined ? undefined : options.priority;
  if (typeof value !== 'number' || !isFinite(value)) {
    return MOTION_PRIORITY.NORMAL;
  }
  return Math.max(MOTION_PRIORITY.NONE, Math.min(MOTION_PRIORITY.FORCE, Math.trunc(value)));
}

/** 夹到 `[-1, 1]`；非数字（`NaN` / 字符串 / `undefined`）一律当 0（看正前方）。 */
function clampUnit(value: unknown): number {
  if (typeof value !== 'number' || !isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}
