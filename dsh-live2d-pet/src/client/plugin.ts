/**
 * dsh-live2d-pet — Client 半区的插件实现。
 *
 * 这里做的是**只有渲染进程能做的事**：Slot 注册、WebGL 画布、渲染循环、口型驱动。
 * 读磁盘、走网络、管密钥一律走 Host 半区（`lib/index.js`）——那条边界不是洁癖，
 * 是因为渲染循环、参数仲裁、口型必须在同一线程同一时钟内跑，跨进程等于拿 IPC
 * 抖动换架构整洁。
 *
 * 渲染链路的四段（顺序不能换）：
 *   1. 取 WebGL 上下文
 *   2. 等 Cubism Core 就绪 —— Core 源码由 build.mjs 用 esbuild 的 `banner` **前置执行**，
 *      这里只轮询 `globalThis.Live2DCubismCore`（见 core-loader.ts 与方案 §9.2）
 *   3. `PetModel.ensureFramework(gl, shaderUrl)` —— shader 目录必须先于建 renderer 设好
 *   4. `model.load(...)` → rAF 循环 `update(dt)` + `draw(w, h)`
 */

import { loadCubismCore, formatCoreVersion } from './core-loader';
import { PetModel } from './pet-model';
import { reportFailure, reportQuerySuffix } from './report';
import { fetchWithTimeout, POLL_FETCH_TIMEOUT_MS } from './fetch-timeout';
import {
  applyLipGain,
  describeLipGain,
  LIP_GAIN_STEP,
  MAX_LIP_GAIN,
  MIN_LIP_GAIN,
  readSettings,
  subtitleView,
  writeSettings,
  type PetSettings,
  type SubtitleView,
} from './settings';
import { describeSpeechState, getSpeechPlayer, type SpeechPlayerState, type SpeechWord } from './speech';

/** React 的形状：只声明我们真正用到的部分（DSH 不给 JSX 转换，全程 createElement）。 */
export interface ReactLike {
  createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
  useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]): T;
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  useMemo<T>(factory: () => T, deps: unknown[]): T;
  useRef<T>(initial: T): { current: T };
  useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
}

export interface ClientPlugin {
  name: string;
  inject: string[];
  apply(ctx: ClientContext): void;
}

/** DSH 注入的 Restricted Cordis Context（只列我们用到的成员）。 */
export interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): () => void;
  get(name: string): unknown;
  slots?: SlotService;
}

interface SlotService {
  inject(key: string, callback: () => unknown): () => void;
  register(meta: Record<string, unknown>, render: () => unknown): unknown;
}

const PLUGIN_NAME = 'dsh-live2d-pet';
const DISPLAY_NAME = 'Live2D 桌宠';
const ROUTE_PREFIX = '/.dsh-live2d-pet';
const MODEL_BASE = `${ROUTE_PREFIX}/model/`;
const SHADER_URL = `${ROUTE_PREFIX}/shaders/`;
const STYLE_ID = 'dsh-live2d-pet-style';

/** 记住用户选的模型；切换模型后刷新页面仍然是他选的那只。 */
const MODEL_PREF_KEY = 'dsh-live2d-pet.model';

/**
 * 「模型偏好变了」的广播名。
 *
 * 设置页与桌宠卡片是两棵**互不相识**的组件树（一个在 `settings.section`，
 * 一个在 `shell.overlay`），而「导入完自动切过去」这件事要跨树生效。
 * 用同一个 document 上的自定义事件同步，比两边各轮询 `localStorage` 便宜，
 * 也比把模型选择提到插件顶层（那会让 overlay 与 settings 的渲染彼此牵连）干净。
 */
const MODEL_PREF_EVENT = 'dsh-live2d-pet:model-pref';

/** 一帧最多推进多少秒。切标签页回来时 dt 可能是几十秒，直接喂给物理会炸。 */
const MAX_DELTA_SECONDS = 1 / 10;

/**
 * 多久问一次 Host「有没有话要说」。
 *
 * 用轮询而不是 WebSocket/SSE：桌宠本来就每 5 秒拉一次 `/status`，再加一条长连接
 * 要处理重连、半开连接、代理超时，是「不值得付的复杂度」。代价是说话最多晚 1.2 秒
 * 开口 —— 对桌宠这个场景完全可以接受。真正不能丢的是渲染状态（走内存，不走网络）。
 */
const SPEECH_POLL_MS = 1200;

/**
 * 说话期间的轮询间隔。
 *
 * 比 `SPEECH_POLL_MS` 快 12 倍，只在「正在说话或有话排队」时启用。存在的唯一
 * 理由是**打断**：`live2d_stop_speaking` 要等下一轮才被取走，而 §4.1 要求
 * 「立即生效」、§6.1 #6 要求「100ms 内口型归零、音频静音」。
 *
 * 这个数字**就是打断延迟本身**：指令只能在下一次轮询被取走，所以最坏情况是
 * 一个间隔加一次本地往返（实测 < 5ms）。定成 100 而不是更小，是因为它就是
 * 验收标准里的那个数字 —— 再小一倍只能把最坏情况从 100ms 压到 50ms，
 * 却要让「说话期间」的请求数翻倍。
 *
 * 闲着时仍然是 1.2 秒：那个数字是给「AI 主动说话」用的，晚一点开口没人察觉
 * （§6.2 还要求空闲 CPU ≤5% 单核，没必要时时刻刻问）。
 */
const SPEECH_POLL_BUSY_MS = 100;

/**
 * 她**正在说话**时，`/status` 心跳的间隔。
 *
 * ── 为什么心跳也要跟着变快 ──────────────────────────────────────────────
 *
 * 「说完了」这件事只有一个出口：下一次心跳把它带回去（见 `speech-presence.ts`）。
 * 平时 5 秒一拍无所谓 —— 她闲着的时候「她还闲着」晚 5 秒知道没有任何代价。
 * 但她正在念的时候，这 5 秒就是**AI 的耳背时长**：她 1.5 秒念完的一句话，
 * AI 可能 5 秒后才知道，于是要么白等、要么在她还在念的时候抢话。
 *
 * 500 而不是 100（`/pending` 用的那个数）：`/status` 的响应体大得多
 * （整个诊断面），而这里要压的延迟是「接话」这种以秒计的事，不是打断那种
 * 以毫秒计的事 —— 500ms 已经远在人察觉不出来之下。
 */
const SPEECH_STATUS_POLL_MS = 500;

/**
 * 模型库清单的**纯逻辑**在 `./model-list` 里。
 *
 * 那些函数（标签前缀、默认选中、要不要拦住这次切换）本来是写在这个文件里的，
 * 但它们**在这里无法被验证**：`simulate-client-boot.mjs` 用的是桩 React，
 * `useState` 返回固定值、effect 从不执行，所以渲染永远停在「正在扫描模型库…」
 * 那一帧，下拉框根本没被建出来。挪出去以后它们进了 `lib/test/model-list.mjs`，
 * 可以被真的断言覆盖。约束是那边不许碰 DOM / React / fetch。
 */
import {
  acceptDrop,
  describeImport,
  describeLibrary,
  describeModel,
  evaluatePick,
  IDLE_IMPORT,
  importLevel,
  isImporting,
  modelLabel,
  pickDefault,
  type ImportState,
  type LibrarySummary,
  type ModelEntry,
  type ModelListResult,
} from './model-list';
import {
  bboxOfAlpha,
  fitInto,
  fingerprintOf,
  inkCenterNdc,
  isFresh,
  isStorableThumb,
  MAX_THUMB_SIDE,
  parseStored,
  pickEvictions,
  PROBE_MAX_SIDE,
  serializeThumb,
  THUMB_PREFIX,
  thumbnailKey,
  thumbAlt,
  type StoredThumb,
} from './thumbnail';
import { describeDegradation } from '../../lib/host/tts-adapters.js';
/*
 * 角色 → 候选参数名（18 个角色各给一串写法）。参数实测（§13.34）要按这张表
 * 扫「哪些根真的会让画面动」；它零 import，可以直接打进客户端包。
 */
import { ROLE_PARAMETER_IDS } from '../../lib/host/emotions.js';
import { VOICE_SCOPE, scopePacks } from './voice-scope';
import { normalizeFps } from '../../lib/host/render-config.js';
import { shouldDrawFrame } from './frame-budget';
import { getStagePresence, setStagePresence, stageQuerySuffix } from './stage-presence';
/*
 * 反向通道的渲染端半边：她「开始说 / 说完了」由朗读通道登记在这里，
 * 再由 `/status` 心跳的查询串带回去。见 `speech-presence.ts` 的文件头。
 */
import {
  getSpeechPresence,
  noteSpeechSettled,
  noteSpeechStart,
  speechQuerySuffix,
} from './speech-presence';
import {
  FRAMEWORK_PRIORITY,
  getActionTarget,
  IDLE_AFTER_MS,
  idleHoldMsFor,
  isExpired,
  isOwnIdleMotion,
  pickIdleGroup,
  runCurrentAction,
  setActionTarget,
  shouldAutoIdle,
  type ActionCommand,
} from './action-runner';
import { createSpeechLane, speakWithInterrupt, waitForPlayer, type SpeechLane } from './speech-lane';
/*
 * 窗口形态（固定 / 浮动）的纯逻辑放在 `window-mode.ts`：夹边、容错、持久化
 * 三条规则都在那儿，门禁直接 import 它跑断言，不用读源码形状。
 */
import {
  clampFloatRect,
  COLLAPSED_BAR_W,
  defaultFloatRect,
  fitCollapsedBar,
  moveFloatRect,
  parseWindowState,
  resizeFloatRect,
  serializeWindowState,
  WINDOW_STORAGE_KEY,
  type WindowState,
} from './window-mode';
/*
 * 舞台视图（模型的缩放与平移）的纯逻辑在 `stage-view.ts`：夹取、滚轮倍率、
 * 持久化都在那儿，门禁直接 import 它跑断言。
 *
 * 为什么这件事要抽出来而不是写在帧循环里：三条规则（缩放上下限、平移上限、
 * 存储容错）错了都不会报错，症状全是「模型不见了」—— 而那既可能是渲染坏了，
 * 也可能是用户把它推出去了。分开之后，这一层可以被执行，渲染那半区只剩
 * 「把矩阵套上去」一件事。
 */
import {
  clampStageView,
  defaultStageView,
  isDefaultStageView,
  panStageView,
  parseStageView,
  serializeStageView,
  STAGE_VIEW_STORAGE_KEY,
  wheelZoomFactor,
  zoomStageView,
  type StageView,
} from './stage-view';

/**
 * 指针事件的**最小面**。
 *
 * 不直接用 `PointerEvent`：这个文件里的 React 是 `ReactLike`（宿主给的那一份），
 * DOM 类型在部分构建目标里拿不到；而且这里只用到五个字段，写全反而把
 * 「我们依赖什么」藏进了一堆用不上的类型里。
 */
interface PointerEventLike {
  pointerId: number;
  clientX: number;
  clientY: number;
  target?: { closest?: (selector: string) => unknown } | null;
  currentTarget?: {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
  } | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/**
 * `/pending` 里的一个条目。
 *
 * 新 Host 的形状是 `{ id, at, command }`；`command.kind === 'say'` 时它还额外带着
 * 兼容垫片 `{ kind: 'speak', text, voice, rate }` 摊在顶层（理由见 `lib/index.js` 的
 * `pushCommand`）。两种形状都要能读 —— 页面上的 bundle 与 Host 的版本随时可能
 * 差一次刷新，那段窗口里读错形状的症状是「桌宠彻底不说话了，也不报错」。
 */
interface PendingItem {
  id?: number;
  at?: number;
  command?: ActionCommand;
  /** 兼容垫片字段（旧客户端只看这几个）。 */
  kind?: string;
  text?: string;
  voice?: string;
  rate?: string;
  ttlMs?: number;
  priority?: number;
}

export function createClientPlugin(react: ReactLike, buildId: string): ClientPlugin {
  const h = react.createElement as (
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ) => unknown;
  const { useCallback, useEffect, useMemo, useRef, useState } = react;

  /** 面板是否至少渲染过一次——用来区分「注册成功」与「真的看见了」。 */
  let mountedOnce = false;

  /**
   * 当前视口尺寸。
   *
   * 浮动窗口的每一次夹边都用它现算，**不缓存**：用户可以随时改浏览器窗口大小，
   * 缓存一次就等于把「窗口已经变小了」这件事藏起来，直到下一次拖动才突然生效。
   */
  const viewportOf = () => ({
    w: typeof window === 'undefined' ? 1024 : window.innerWidth || 1024,
    h: typeof window === 'undefined' ? 768 : window.innerHeight || 768,
  });

  const CSS = `
.dsh-l2d-root {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 60;
  /* shell.overlay 整层是点击穿透的，自己的条目要显式把指针事件收回来。 */
  pointer-events: auto;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsh-text, #e6e6e6);
}
/*
 * 卡片自己封顶，而不是让内容把窗口撑高。
 *
 * 这张卡片是 fixed 钉在底边的（right/bottom 各 16px）：内容一旦比视口还高，
 * 多出来的部分只会从**上边**溢出，而 fixed 元素不滚动 —— 被裁掉的正好是
 * .dsh-l2d-head，也就是右上角那个「收起」按钮。用户看到的现象就是
 * 「窗口太高，收回按钮被遮住了」，而按钮不是被挡住，是被挤出了视口。
 *
 * 100vh - 32px 就是上下各 16px 的锚点距离；flex 列让头固定、身体滚动。
 *
 * 注意：这一段在 JS 模板字符串里，**注释里不能出现反引号**（会提前结束字符串）。
 */
.dsh-l2d-card {
  width: 268px;
  max-height: calc(100vh - 32px);
  /* 拉角（浮动形态的右下角）要相对这张卡片定位。 */
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  background: color-mix(in srgb, var(--dsh-surface, #1b1c1f) 88%, transparent);
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 28px rgba(0, 0, 0, .35);
  overflow: hidden;
}
.dsh-l2d-head {
  display: flex; align-items: center; gap: 6px;
  /* 头部永不参与压缩：它是唯一的「收起」入口，任何情况下都得留在视口里。 */
  flex: none;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
.dsh-l2d-title { font-weight: 600; flex: 1; }
.dsh-l2d-dot { width: 7px; height: 7px; border-radius: 50%; background: #8a8a8a; flex: none; }
.dsh-l2d-dot[data-on="1"] { background: #35c46a; }
.dsh-l2d-dot[data-on="0"] { background: #d2544a; }
.dsh-l2d-btn {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  padding: 2px 6px; border-radius: 5px; font: inherit; opacity: .75;
}
.dsh-l2d-btn:hover { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
/*
 * 身体是唯一可滚动的部分。
 *
 * min-height: 0 不是装饰：flex 子项的默认 min-height: auto 会让它拒绝缩到
 * 内容高度以下，于是上面那条 max-height 形同虚设、卡片照样溢出。这一行才是
 * 「卡片封顶」真正生效的地方。
 *
 * overscroll-behavior: contain 拦住滚到底之后继续滚动被外层接走 ——
 * 否则在桌宠上滚轮会把背后的对话列表滚走。
 */
.dsh-l2d-body {
  padding: 10px;
  display: flex; flex-direction: column; gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* 舞台按模型画布的真实比例（4000×8000 = 1:2）留位，避免加载完成后跳一下。 */
.dsh-l2d-stage {
  position: relative;
  /* 舞台不参与弹性压缩：滚动的责任在 .dsh-l2d-body，把它压扁只会让脸变形。 */
  flex: none;
  aspect-ratio: 1 / 2;
  max-height: 42vh;
  margin: 0 auto;
  border-radius: 8px;
  border: 1px dashed color-mix(in srgb, currentColor 22%, transparent);
  overflow: hidden;
  background: color-mix(in srgb, currentColor 4%, transparent);
  /*
   * 舞台可拖动（用户第 4、5 条要求：鼠标调模型的位置与大小，模型照常在动）。
   * overflow: hidden 上面已经有了 —— 它就是「超出边框的部分不展示」那一条。
   * touch-action: none 让触屏拖动不被页面滚动抢走。
   */
  cursor: grab;
  touch-action: none;
}
.dsh-l2d-stage:active { cursor: grabbing; }
.dsh-l2d-canvas { display: block; width: 100%; height: 100%; }
/*
 * 参数实测（§13.34）期间把画面藏起来（§13.37）。
 *
 * 探测会把每根参数推到 ±35% 量程再拉回来，一根 4 帧左右 —— 十几根连起来就是
 * 肉眼看到的「抽搐」。它必须真的发生（A-B-A 要靠像素比），但用户不必看见：
 * 画布的 visibility: hidden 只影响合成，不影响 drawImage 取像素。
 */
.dsh-l2d-stage[data-probing="1"] > .dsh-l2d-canvas { visibility: hidden; }
.dsh-l2d-stage[data-probing="1"]::after {
  content: '正在校准关节…';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  opacity: 0.55;
  pointer-events: none;
}
/*
 * 舞台右上角的手势说明 + 重置按钮（用户要求：放在模型边框的右上角，方便看到）。
 *
 * 「pointer-events: none」在外层、「auto」只在按钮上：角标压着舞台，而舞台整块
 * 都是拖动区。整层吃指针的话，右上角会变成一块「拖不动」的死区，而用户不会
 * 知道那是因为角标 —— 只会以为舞台卡了。
 *
 * 说明文字半透明、字号最小档：它是提示，不是控件；常驻但**不许抢戏**，
 * 因为舞台里真正该被看见的是脸。
 */
.dsh-l2d-stagehud {
  position: absolute; top: 6px; right: 6px; z-index: 3;
  display: flex; align-items: center; gap: 6px;
  max-width: calc(100% - 12px);
  pointer-events: none;
}
.dsh-l2d-hudtip {
  font-size: 10px; line-height: 1.35; opacity: .55;
  padding: 2px 7px; border-radius: 999px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 固定形态的舞台只有 268px 宽，两个东西并排放不下 —— 窄的时候只留按钮。 */
@media (max-width: 640px) { .dsh-l2d-hudtip { display: none; } }
.dsh-l2d-hudbtn {
  pointer-events: auto;
  font: inherit; font-size: 10px; line-height: 1.35;
  padding: 3px 9px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: inherit; cursor: pointer;
}
.dsh-l2d-hudbtn:disabled { opacity: .35; cursor: default; }
.dsh-l2d-hudbtn:not(:disabled):hover { background: color-mix(in srgb, currentColor 20%, transparent); }
/*
 * ★ 窗口形态（用户第 1 条要求：固定 / 浮动两种，且同时只存在一个）。
 *
 * 两种形态共用**同一棵 DOM**：dsh-l2d-main（舞台）与 dsh-l2d-side（设置）
 * 在固定形态下是 display: contents —— 它们不产生盒子，子元素直接落进
 * dsh-l2d-body 的列式布局，所以固定形态的观感与改动之前**逐像素一致**。
 * 浮动形态才让它们变成真正的 flex 项：左 8 份舞台、右 2 份边栏。
 *
 * 为什么不是「两套 JSX」：那会让 React 在切换时卸载再挂载画布，模型实例随之
 * 重建 —— 动作与表情全丢，而这正是用户第 2 条要求里明令禁止的事。
 *
 * 注意：这一段在 JS 模板字符串里，**注释里不能出现反引号**（会提前结束字符串）。
 */
.dsh-l2d-main, .dsh-l2d-side { display: contents; }
.dsh-l2d-root[data-mode="float"] { right: auto; bottom: auto; }
.dsh-l2d-root[data-mode="float"] .dsh-l2d-card { width: 100%; height: 100%; max-height: none; }
/*
 * 收起之后的浮动形态 = 一条只有标题栏的横条。
 *
 * 高度必须显式掰回 auto：上面那条规则给了 height: 100%，而收起的横条父元素
 * 没有高度（内联样式里刻意不写 height），百分比高度落在自动高度上虽然会退化成
 * auto，但那只是规范里的巧合 —— 写明白才不会被哪天多出来的一层 flex 改掉。
 * 宽度保持 100%（＝根元素的 268px，与固定形态的卡片同宽）。
 *
 * 没有这一段，症状就是用户报的那个：「内容清空了，但窗口没收回去」。
 */
.dsh-l2d-root[data-mode="float"][data-collapsed="1"] .dsh-l2d-card {
  width: 100%; height: auto; max-height: none;
}
.dsh-l2d-root[data-mode="float"][data-collapsed="1"] .dsh-l2d-body { display: none; }
.dsh-l2d-root[data-mode="float"] .dsh-l2d-body {
  /* 横屏：gap 归零，舞台贴到卡片边框上（第 3 条要求里「模型占比大」的手感来自这里）。 */
  flex-direction: row; padding: 0; gap: 0; overflow: hidden;
}
.dsh-l2d-root[data-mode="float"] .dsh-l2d-main {
  display: block; flex: 8 1 0; min-width: 0; position: relative; overflow: hidden;
}
.dsh-l2d-root[data-mode="float"] .dsh-l2d-main > .dsh-l2d-stage {
  /* 浮动形态里舞台铺满左半边：不再按 1:2 留位，也没有圆角与虚线框。 */
  width: 100%; height: 100%; max-height: none; aspect-ratio: auto;
  margin: 0; border: 0; border-radius: 0;
}
.dsh-l2d-root[data-mode="float"] .dsh-l2d-side {
  display: flex; flex-direction: column; gap: 8px;
  flex: 2 1 0; min-width: 150px;
  padding: 10px;
  overflow-y: auto; overscroll-behavior: contain;
  border-left: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
/* 浮动形态的标题栏就是拖动把手；touch-action: none 让触屏拖动不被页面滚动抢走。 */
.dsh-l2d-head[data-drag="1"] { cursor: move; user-select: none; touch-action: none; }
/* 右下角的拉角：只在浮动形态出现。 */
.dsh-l2d-grip {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize; touch-action: none; opacity: .5;
}
.dsh-l2d-grip:hover { opacity: .9; }
.dsh-l2d-grip::after {
  content: ''; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
  border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
}
.dsh-l2d-hint {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 10px; opacity: .7; pointer-events: none;
}
/* 切换期间「上一只还在画」时用的两种非遮罩提示：都贴底、半透明、不吃鼠标事件。
   它们是「角标」而不是「遮罩」—— 切换中把画布盖住，就等于把白屏又请了回来。 */
.dsh-l2d-loaderr, .dsh-l2d-switching {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 4px 8px; font-size: 11px; text-align: center;
  background: color-mix(in srgb, #000 45%, transparent);
  border-radius: 0 0 6px 6px; pointer-events: none; word-break: break-word;
}
.dsh-l2d-switching { opacity: .75; }
/* 字幕：贴底、半透明底、不吃鼠标事件（否则它会挡住拖放……不，拖放在整张卡片上，
   但字幕盖在画布上，挡住的话用户就没法点画布了）。 */
.dsh-l2d-subtitle {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 5px 9px; font-size: 12px; line-height: 1.5; text-align: center;
  background: color-mix(in srgb, #000 55%, transparent);
  color: #f5f5f5; border-radius: 0 0 6px 6px;
  pointer-events: none; word-break: break-word;
}
/* 当前正在念的那个词。只换颜色不加粗 —— 加粗会让整行宽度抖动，
   在一句话里抖十几次比不高亮还难受。 */
.dsh-l2d-subword { color: #8ec7ff; }
.dsh-l2d-row {
  display: flex; gap: 8px; align-items: center;
  font-size: 11px; opacity: .8;
}
.dsh-l2d-row > label { flex: none; }
.dsh-l2d-range { flex: 1; min-width: 0; accent-color: #6ea8fe; }
.dsh-l2d-gainval { flex: none; font-variant-numeric: tabular-nums; }
.dsh-l2d-check { display: flex; gap: 6px; align-items: center; font-size: 11px; opacity: .8; }
.dsh-l2d-select {
  width: 100%; font: inherit; padding: 3px 6px; border-radius: 6px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: inherit; border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
}
/* 下拉框 + 刷新按钮同一行；select 占据剩余宽度而不是固定宽度，换语言/长名字都不会挤掉按钮。 */
.dsh-l2d-modelrow { display: flex; gap: 6px; align-items: center; }
.dsh-l2d-modelrow > .dsh-l2d-select { flex: 1; min-width: 0; }
/*
 * ★ 音色那一节（「换一种声音说话」的入口）。
 *
 * 行内布局复用 .dsh-l2d-row，这里只补两件它没有的：
 *   - select / input 吃掉剩余宽度 —— 基类的 width: 100% 放在 flex 行里会和
 *     旁边的按钮一起溢出，长音色名（「中文（中国大陆）· 云希 · 男声」）尤其明显；
 *   - 按钮不参与伸缩，否则「试听 / 保存」会被挤成两行。
 */
.dsh-l2d-tone .dsh-l2d-row > .dsh-l2d-select,
.dsh-l2d-tone .dsh-l2d-row > .dsh-l2d-input { flex: 1 1 auto; width: auto; min-width: 0; }
.dsh-l2d-tone .dsh-l2d-btn { flex: none; padding: 1px 8px; font-size: 11px; }
.dsh-l2d-refresh { flex: none; padding: 3px 7px; font-size: 13px; }
/*
 * ★ 参数绑定那一节（details/summary 折叠）。
 *
 * 17 行选择框塞进这张窄卡片，唯一能接受的形态是「默认折叠 + 每行一行高」：
 * 行内布局复用 .dsh-l2d-row，这里只补三件它没有的 ——
 *   - summary 的指针与折叠三角（原生三角在深色背景下几乎看不见）；
 *   - 行内 select 不占满整行（否则状态标记会被挤到下一行，17 行变 34 行高）；
 *   - data-err 的红色（「绑了但本模型没有」必须一眼可见）。
 */
.dsh-l2d-bindings { font-size: 11px; opacity: .85; }
.dsh-l2d-bindings > summary {
  cursor: pointer; list-style: none; padding: 2px 0; user-select: none;
}
.dsh-l2d-bindings > summary::-webkit-details-marker { display: none; }
.dsh-l2d-bindings > summary::before { content: '▸ '; }
.dsh-l2d-bindings[open] > summary::before { content: '▾ '; }
.dsh-l2d-bindings .dsh-l2d-row > label { flex: none; width: 74px; }
.dsh-l2d-bindings .dsh-l2d-select { flex: 1; min-width: 0; }
/*
 * 语音包那一节复用参数绑定那套折叠样式（同一张卡片里的两个 details 长得一样，
 * 用户就不用重新学一遍）。多出来的只有「一条语音一行」这条：试听按钮是固定宽度，
 * 文字占掉剩下的空间并省略 —— 否则一句带中文标点的长台词会把卡片撑宽。
 */
.dsh-l2d-voices { font-size: 11px; opacity: .85; }
.dsh-l2d-voices > summary {
  cursor: pointer; list-style: none; padding: 2px 0; user-select: none;
}
.dsh-l2d-voices > summary::-webkit-details-marker { display: none; }
.dsh-l2d-voices > summary::before { content: '▸ '; }
.dsh-l2d-voices[open] > summary::before { content: '▾ '; }
.dsh-l2d-voicepack { margin: 4px 0 2px; }
.dsh-l2d-voicepackname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-l2d-voiceclip { display: flex; gap: 6px; align-items: center; padding: 1px 0 1px 6px; }
.dsh-l2d-voiceclip > .dsh-l2d-btn { flex: none; padding: 1px 6px; font-size: 11px; }
.dsh-l2d-cliptext {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8;
}
.dsh-l2d-gainval[data-err='1'] { color: #ff8080; opacity: 1; }
.dsh-l2d-saymeta[data-warn='1'] { color: #ffcc66; }
.dsh-l2d-modelmeta { font-size: 11px; opacity: .62; word-break: break-all; }
/*
 * 选中模型那一行：左边一张小图，右边名字与规格。
 *
 * 用 flex 让文字在图的右边独立换行（上面 modelmeta 那条 word-break 对长路径
 * 很必要）。没有图时这一行不加 -thumb 类，flex 规则不生效，排版与改动前
 * 逐字一致 —— 这也是为什么用第二个类而不是 :has()：不依赖选择器引擎的
 * 新旧程度，且「有没有图」在 DOM 里看得见。
 * align-items: center 让一行文字时图和文字在视觉中线上对齐；三行文字时
 * 图仍然居中，读起来比顶对齐舒服。
 *
 * ⚠️ 这一整段 CSS 是 JS 模板字符串的一部分，注释里**不能出现反引号** ——
 * 一个反引号就会把字符串提前结束掉，报成十几个「',' expected」这种
 * 指向 CSS 的语法错。
 */
.dsh-l2d-modelmeta-thumb { display: flex; gap: 8px; align-items: center; }
/*
 * 缩略图。object-fit: contain 是必须的 —— 裁出来的图长宽比各不相同
 * （一个横着的动作和一个竖着的姿势），不 contain 就会被拉变形。
 * 圆角与背景让它在深浅两套主题下都像个「贴图」而不是一个破洞。
 */
.dsh-l2d-thumb {
  flex: none;
  width: 48px;
  height: 48px;
  object-fit: contain;
  border-radius: 4px;
  background: rgba(127, 127, 127, .12);
}
/* 拖放高亮。用 outline 而不是 border —— 加 border 会让卡片尺寸跳一下。 */
.dsh-l2d-card[data-drag="1"] { outline: 2px dashed #6ea8fe; outline-offset: -3px; }
.dsh-l2d-import { display: flex; gap: 6px; align-items: center; margin-top: 2px; }
/* 真 input 藏起来但**不能用 display:none** —— 那样 .click() 在部分浏览器里不弹窗。 */
.dsh-l2d-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.dsh-l2d-importbtn { flex: none; }
.dsh-l2d-importhint { font-size: 11px; opacity: .5; }
.dsh-l2d-progress { height: 3px; margin-top: 3px; background: color-mix(in srgb, currentColor 18%, transparent); border-radius: 2px; overflow: hidden; }
.dsh-l2d-progressbar { height: 100%; background: #6ea8fe; transition: width .12s linear; }
.dsh-l2d-problems { display: flex; flex-direction: column; gap: 3px; font-size: 11px; }
.dsh-l2d-problem { word-break: break-word; }
.dsh-l2d-problem[data-level="error"] { color: #d2544a; }
.dsh-l2d-problem[data-level="warn"] { color: #cf9b45; }
.dsh-l2d-problemdetail { opacity: .6; }
.dsh-l2d-row { display: flex; gap: 8px; }
.dsh-l2d-row > span:first-child { opacity: .6; flex: none; width: 62px; }
.dsh-l2d-row > span:last-child { word-break: break-all; }
.dsh-l2d-err { color: #d2544a; }
.dsh-l2d-say { display: flex; gap: 6px; align-items: center; }
.dsh-l2d-input {
  flex: 1; min-width: 0; font: inherit; padding: 3px 6px; border-radius: 6px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: inherit; border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
}
.dsh-l2d-btn[disabled] { opacity: .45; cursor: default; }
.dsh-l2d-saymeta { font-size: 11px; opacity: .65; min-height: 14px; word-break: break-all; }
.dsh-l2d-saymeta[data-err="1"] { color: #d2544a; opacity: 1; }
.dsh-l2d-saymeta[data-warn="1"] { color: #cf9b45; opacity: 1; }

/*
 * 对话（§13.36）。
 *
 * 列表限高 132px 并允许滚动：卡片只有 268px 宽，历史一长就会把「话」挤出屏幕 ——
 * 而这一节的重点是**刚说的那两句**，不是全部历史。气泡用左右对齐区分谁在说：
 * 阅读顺序与聊天软件一致，不需要额外的头像或标签去认。
 */
.dsh-l2d-chat { display: flex; flex-direction: column; gap: 6px; }
.dsh-l2d-chatlist {
  display: flex; flex-direction: column; gap: 4px;
  max-height: 132px; overflow-y: auto; overscroll-behavior: contain;
}
.dsh-l2d-chatline { display: flex; gap: 6px; font-size: 12px; line-height: 1.45; }
.dsh-l2d-chatline[data-role="user"] { flex-direction: row-reverse; }
.dsh-l2d-chatrole { flex: none; opacity: .5; font-size: 11px; padding-top: 1px; }
.dsh-l2d-chattext {
  padding: 2px 6px; border-radius: 8px; max-width: 84%;
  background: color-mix(in srgb, currentColor 9%, transparent);
}
.dsh-l2d-chatline[data-role="user"] .dsh-l2d-chattext {
  background: color-mix(in srgb, currentColor 16%, transparent);
}

/*
 * 设置页（settings.section）里的那一节。
 *
 * 它**不能**套 .dsh-l2d-root —— 那个类带 fixed / right / bottom，是给浮层用的，
 * 套到设置页上会把整块内容钉到屏幕右下角。共用的是下面那一批原子类
 * （.dsh-l2d-btn / .dsh-l2d-row / .dsh-l2d-range …），它们本来就是全局的。
 */
.dsh-l2d-settings {
  display: flex; flex-direction: column; gap: 14px;
  font-size: 12px; line-height: 1.6;
  padding: 4px 0; max-width: 720px;
}
.dsh-l2d-settingstitle { font-weight: 600; font-size: 13px; }
.dsh-l2d-section {
  display: flex; flex-direction: column; gap: 8px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
.dsh-l2d-section > h3 { margin: 0; font-size: 12.5px; font-weight: 600; }
.dsh-l2d-sectionrow { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.dsh-l2d-modellist {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 220px; overflow-y: auto;
}
.dsh-l2d-modelline {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 6px; border-radius: 6px;
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.dsh-l2d-modelline[data-broken="1"] { background: color-mix(in srgb, #d2544a 12%, transparent); }
.dsh-l2d-modelline-main { flex: 1; min-width: 0; }
.dsh-l2d-modelline-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-l2d-drop {
  display: flex; align-items: center; gap: 8px;
  padding: 8px; border-radius: 8px;
  border: 1px dashed color-mix(in srgb, currentColor 26%, transparent);
}
.dsh-l2d-drop[data-drag="1"] {
  border-color: #6ea8fe;
  background: color-mix(in srgb, #6ea8fe 12%, transparent);
}
.dsh-l2d-settings .dsh-l2d-range { max-width: 220px; }
.dsh-l2d-settings .dsh-l2d-voiceclip { max-width: 100%; }
.dsh-l2d-settings .dsh-l2d-check { display: flex; align-items: center; gap: 6px; }
`;


  /**
   * 轮询 Host 的 `/status`。
   *
   * 这个请求本身就是心跳：Host 侧收到就记 `lastClientSeenAt`，并把查询串上的
   * `build` 记进 `clientBuild`——于是「浏览器有没有换上刚构建的 bundle」在 Host
   * 侧可查询，不必让用户开 DevTools。
   *
   * ★ 这条请求还是**唯一一条被证明能通的回程通道**，所以两样诊断搭它一起回去：
   *   · `stageQuerySuffix()` —— 渲染舞台这会儿在不在（`stage-presence.ts`）；
   *   · `reportQuerySuffix()` —— 上报通道自己的账本（`report.ts`）。
   * 后者的理由是个循环：上报通道坏掉的时候，恰恰是它自己的账本最需要送到的时候，
   * 所以账本**不能**走那条可能已经坏掉的路。事故现场就是这么来的 ——
   * `clientStage` 抵达了（走查询串），而 `clientErrors` 五轮全空（走 `sendBeacon`）。
   */
  function useHostStatus(intervalMs: number) {
    const [status, setStatus] = useState<Record<string, unknown> | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
      try {
        const res = await fetch(
          `${ROUTE_PREFIX}/status?build=${encodeURIComponent(buildId)}${stageQuerySuffix()}${reportQuerySuffix()}${speechQuerySuffix(sharedLane === null ? 0 : sharedLane.queued())}`,
          { cache: 'no-store' },
        );
        setStatus((await res.json()) as Record<string, unknown>);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, []);

    useEffect(() => {
      /*
       * ★ 存活自证（`client-alive`）—— 每个页面加载只报一次。
       *
       * ── 它要回答的那个问题 ──────────────────────────────────────────────
       *
       * 装了五道 `frame-*` 护栏之后，用户报卡死，`clientErrors` 依然是空的。
       * 而「空」同时对应三种完全不同的处境：① 真没冻；② 护栏根本没挂载；
       * ③ 护栏跑了，但**上报通道本身**不通。
       *
       * 第三种一直没被排除过，因为那条通道从来没有被观测过：门禁里的
       * `route-gate-*` 是**门禁进程**发的（走 node 的 fetch），不是渲染进程发的。
       * 于是「渲染进程能不能把话带回 Host」这件事，此前既没被证明、也没被证伪。
       *
       * 这一条走的就是 `reportFailure` 那条路（`sendBeacon` → `/client-error`），
       * 而且由**唯一一个与面板收起无关的 effect**（轮询 `/status` 的那个）发。
       * 它一到，「一条故障都没有」才是可信的；它不到，那就是通道或页面本身的问题，
       * 与护栏、与模型、与冻不冻全都无关。
       *
       * 报的是**当场量到的事实**（构建号、可见性、窗口尺寸、舞台在不在），
       * 不是一句「我还活着」的自称 —— 自称没法证伪。
       */
      let aliveSent = false;
      const tick = async () => {
        await load();
        if (aliveSent) return;
        aliveSent = true;
        let hidden = false;
        let visibility = '（没有 document）';
        let vw = 0;
        let vh = 0;
        try {
          hidden = document.hidden === true;
          visibility = String(document.visibilityState);
          vw = window.innerWidth;
          vh = window.innerHeight;
        } catch {
          /* 测试环境没有 DOM：上面的兜底值本身就是答案，不抛。 */
        }
        reportFailure(
          'client-alive',
          new Error(
            '客户端存活自证（本条不是故障）：插件已经向 Host 轮询过至少一次 /status。'
            + ` 跑的是构建 ${buildId}；`
            + ` document.hidden=${String(hidden)}（visibilityState=${visibility}）；`
            + ` 窗口=${vw}×${vh}；`
            + ` 此刻渲染舞台${getStagePresence() === null
              ? '还没有登记（面板可能收着，或者还没轮到它挂载）'
              : '已经登记'}。`
            + ' 看到这一条，才说明「客户端一条故障都没报」是可信的 ——'
            + ' 因为它走的就是报故障的那条通道，当场验过了。',
          ),
        );
      };
      void tick();
      /*
       * ★ 自适应心跳：她**正在说话**时问得勤（D-2）。
       *
       * 理由见 `SPEECH_STATUS_POLL_MS`：平时 5 秒一拍没问题，但她念着的时候
       * 那 5 秒就是 AI 的耳背时长 —— 而「说完了」只由这条心跳带回去。
       *
       * 用自重排的 `setTimeout` 而不是 `setInterval`：间隔要每一拍重新算，
       * 而「她刚才开口了」这件事是模块级账本（`speech-presence.ts`）里的状态，
       * 不会触发 React 重渲染 —— 所以只有自重排能立刻跟上。
       * 与下面 `useSpeechQueue` 里那段是同一个套路。
       */
      let timer = 0;
      let cancelled = false;
      const schedule = (): void => {
        if (cancelled) return;
        const fast = getSpeechPresence()?.speaking === true;
        timer = setTimeout(() => {
          void tick().then(schedule, schedule);
        }, fast ? SPEECH_STATUS_POLL_MS : intervalMs);
      };
      schedule();
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, [load, intervalMs]);

    return { status, error, reload: load };
  }

  /**
   * 列出模型库里可用的模型（Host 侧扫描，渲染进程看不到磁盘）。
   *
   * `force` 会打 `/models/refresh` 而不是 `/models`。两者返回同样的东西，
   * 区别只在 Host 侧要不要相信体检缓存 —— 而缓存是靠「每个引用文件的
   * mtime+size 指纹」判断失效的，在网络盘 / 虚拟文件系统上 mtime 可能粗到
   * 秒级，指纹会漏。所以「刚换了一张纹理却没生效」时用户需要一个
   * 「别管缓存，重来」的按钮，而不是重载整个页面。
   */
  async function fetchModels(force = false): Promise<ModelListResult> {
    const url = force ? `${ROUTE_PREFIX}/models/refresh` : `${ROUTE_PREFIX}/models`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`E_MODEL_LIST_FAILED: HTTP ${res.status}`);
    const data = (await res.json()) as { models?: ModelEntry[]; summary?: LibrarySummary };
    return {
      models: Array.isArray(data.models) ? data.models : [],
      summary: data.summary ?? null,
    };
  }

  /**
   * 把当前模型的能力清单上报给 Host（`model:capabilities`，方案文档 §4.3）。
   *
   * Host 那边把它存起来，`live2d_status` 工具再带进会话 —— AI 因此能知道
   * 「这只模型有哪些表情 / 动作组 / 参数」，而不用去猜。清单只有这里产出得了：
   * 参数得用 Cubism Core 枚举，Core 只在浏览器里跑。
   *
   * **本函数绝不抛**。它的调用点在 `Live2DStage` 的 effect 里，而客户端半区
   * 抛出的异常会拖着整个 DSH 外壳一起死（§9.2 那次白屏事故）。上报失败最坏的
   * 后果是 AI 少知道一点信息，那不配用一次白屏来换 —— 所以这里 catch 住，
   * 只走 `reportFailure`。
   */
  async function reportCapabilities(model: PetModel, modelPath: string): Promise<boolean> {
    try {
      const capabilities = model.capabilities();
      const res = await fetch(`${ROUTE_PREFIX}/capabilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: modelPath, capabilities }),
      });
      if (!res.ok) {
        throw new Error(`E_CAPABILITIES_REPORT_FAILED: HTTP ${res.status}`);
      }
      /*
       * 回一个「这份清单量过了吗」（§13.37）：`probeFresh === true` 时调用方会跳过
       * 这一轮参数实测。读不出来就当没量过（false）—— 多测一次只是多一下校准，
       * 少测一次却可能让「不会动的参数」永远被当成会动。
       */
      const body = await res.json().catch(() => null) as { probeFresh?: unknown } | null;
      return body !== null && body.probeFresh === true;
    } catch (err) {
      reportFailure('capabilities', err);
      return false;
    }
  }

  /**
   * 告诉 Host「**舞台不在了**」，让它把能力清单丢掉（§13.25）。
   *
   * 这条的存在理由，是上一版清单**只增不减**：面板一收起、页面一刷新，渲染端
   * 就没有模型可执行，而 Host 手里还留着上一次的清单，于是继续往 `/pending` 里推
   * 表情 / 动作 —— 渲染端只能回 `E_ACTION_NO_MODEL`，真机 `clientErrors` 里那条
   * 就是这么来的。
   *
   * 清空之后 `buildAction()` 会在 Host 侧把需要清单的指令拒成
   * `E_ACTION_NO_CAPABILITIES`：AI 当场知道「现在没有脸」，而不是先看到一条假成功、
   * 再从日志里发现她没动。
   *
   * 两个调用点（都在 `Live2DStage` 的 effect 里）：
   *   · 挂载时 `stage-booting` —— 页面刚刷新，Host 那边还留着刷新前的清单；
   *   · 卸载时 `stage-unmounted` —— 面板收起 / 上下文丢失后重建 / 换页。
   *
   * **绝不抛**：与 `reportCapabilities` 同一条理由（§9.2，客户端半区抛异常会带走整个外壳）。
   */
  async function reportCapabilitiesGone(reason: string): Promise<void> {
    try {
      const res = await fetch(`${ROUTE_PREFIX}/capabilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilities: null, reason }),
      });
      if (!res.ok) {
        throw new Error(`E_CAPABILITIES_CLEAR_FAILED: HTTP ${res.status}`);
      }
    } catch (err) {
      reportFailure('capabilities-clear', err);
    }
  }

  /*
   * ★ 参数实测（§13.34）：把候选参数推到两端、各画一帧、量像素差。
   *
   * 为什么要它：微动作这一层一直在**按名字猜**「哪根参数能让这个部位动」。
   * 博丽灵梦那套模型的待机动作接在 `Param305…319` 这类自定义参数上，标准
   * `ParamAngle*` / `ParamBodyAngle*` 在参数表里、名字也认得，但骨架未必接 ——
   * 写进去的值不产生任何像素变化。用户看到的就是「只有眼睛在动」。
   *
   * 参数表里有 ≠ 骨架接了 ≠ 会动。前两件能用 JSON 回答，第三件只能用画面回答，
   * 而画面只有这里有。
   *
   * 一次探测 ≈ 每根参数 4 帧（推高 → 等 2 帧 → 采样 → 推低 → 等 2 帧 → 采样），
   * 13 根参数约 1 秒。它会**短暂地**把模型推出正常姿态（±35% 量程），
   * 所以只在模型刚加载完做一次，并把漂移层关掉减少噪声。
   */
  const BINDING_PROBE_SIDE = 48;
  const BINDING_PROBE_WARMUP = 2;
  const BINDING_PROBE_SWEEP = 0.35;
  const BINDING_PROBE_PIXEL_DELTA = 12;
  /**
   * 「这根参数写了会动」的门槛。
   *
   * 1% 是 2304 像素里的 23 个 —— 单看这个数毫无意义：她一直在呼吸、眨眼、
   * 播待机动作，两次采样之间本来就会差出几十个百分点。所以真正的判据是
   * **A-B-A**（高 → 低 → 再高）：来回两个方向都要超过这个门槛，而「高」与
   * 「第二个高」之间必须几乎一样（`BINDING_PROBE_NOISE_FLOOR`）。
   * 背景在动 ⇒ 两个 A 不一样 ⇒ 这根参数判不出来，按「不动」处理（宁可借力）。
   */
  const BINDING_PROBE_MIN_CHANGED = 0.01;
  const BINDING_PROBE_NOISE_FLOOR = 0.004;

  interface BindingProbeTarget {
    id: string;
    high: number;
    low: number;
  }

  interface BindingProbeJob {
    model: string;
    targets: BindingProbeTarget[];
    index: number;
    step: 'high' | 'sample-high' | 'low' | 'sample-low' | 'high2' | 'sample-high2';
    wait: number;
    high: Uint8Array | null;
    low2: Uint8Array | null;
    results: { id: string; changed: number }[];
    startedAt: number;
  }

  /** 这个模型上值得实测的参数（角色候选表 ∩ 模型参数表，去重）。 */
  function bindingProbeTargets(model: PetModel): BindingProbeTarget[] {
    const declared = new Map<string, { min: number; max: number; def: number }>();
    for (const item of model.describeParameters()) declared.set(item.id, item);
    const seen = new Set<string>();
    const targets: BindingProbeTarget[] = [];
    for (const role of Object.keys(ROLE_PARAMETER_IDS)) {
      for (const candidate of ROLE_PARAMETER_IDS[role] ?? []) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const param = declared.get(candidate);
        if (param === undefined) continue;
        const span = param.max - param.min;
        if (!(span > 0)) continue;
        const sweep = span * BINDING_PROBE_SWEEP;
        const high = Math.min(param.max, param.def + sweep);
        const low = Math.max(param.min, param.def - sweep);
        if (!(high > low)) continue;
        targets.push({ id: candidate, high, low });
      }
    }
    return targets.slice(0, 32);
  }

  /** 采一张 48×48 的小图（必须在 `draw()` 之后、同一个 rAF 里）。全透明返回 `null`。 */
  function sampleBindingPixels(canvas: HTMLCanvasElement, probe: HTMLCanvasElement): Uint8Array | null {
    try {
      if (probe.width !== BINDING_PROBE_SIDE || probe.height !== BINDING_PROBE_SIDE) {
        probe.width = BINDING_PROBE_SIDE;
        probe.height = BINDING_PROBE_SIDE;
      }
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      if (ctx === null) return null;
      ctx.clearRect(0, 0, BINDING_PROBE_SIDE, BINDING_PROBE_SIDE);
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, BINDING_PROBE_SIDE, BINDING_PROBE_SIDE);
      const data = ctx.getImageData(0, 0, BINDING_PROBE_SIDE, BINDING_PROBE_SIDE).data;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) opaque += data[i];
      if (opaque === 0) return null;
      return new Uint8Array(data);
    } catch {
      return null;
    }
  }

  /** 两张采样之间「变化了多少比例的像素」。读不到任何一张时返回 null。 */
  function changedFraction(left: Uint8Array | null, right: Uint8Array | null): number | null {
    if (left === null || right === null || left.length !== right.length || left.length === 0) return null;
    let changed = 0;
    let total = 0;
    for (let i = 0; i + 3 < left.length; i += 4) {
      total += 1;
      const delta = Math.abs(left[i] - right[i])
        + Math.abs(left[i + 1] - right[i + 1])
        + Math.abs(left[i + 2] - right[i + 2]);
      if (delta > BINDING_PROBE_PIXEL_DELTA) changed += 1;
    }
    return total === 0 ? null : changed / total;
  }

  /** 把实测结果交给 Host（Host 按它重算微动作包）。失败不抛。 */
  async function reportBindingProbe(job: BindingProbeJob): Promise<void> {
    if (job.results.length === 0) return;
    try {
      const res = await fetch(`${ROUTE_PREFIX}/binding-probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: job.model, results: job.results }),
      });
      if (!res.ok) throw new Error(`E_BINDING_PROBE_REPORT_FAILED: HTTP ${res.status}`);
    } catch (err) {
      reportFailure('binding-probe', err);
    }
  }

  /** 一帧走一步。状态机放在这里而不是 `PetModel`：采样必须紧跟 `draw()`。 */
  function stepBindingProbe(host: RenderHost, model: PetModel, canvas: HTMLCanvasElement): void {
    if (host.renderedPath === null) return;
    if (host.bindProbe === null) {
      if (host.bindDoneFor === host.renderedPath) return;
      const targets = bindingProbeTargets(model);
      host.bindDoneFor = host.renderedPath;
      if (targets.length === 0) return;
      host.bindProbe = {
        model: host.renderedPath,
        targets,
        index: 0,
        step: 'high',
        wait: BINDING_PROBE_WARMUP,
        high: null,
        low2: null,
        results: [],
        startedAt: Date.now(),
      };
      /*
       * 探测期间关掉静息漂移：它在两帧之间也在写参数，会把「这根参数会不会动」
       * 混进噪声。测完立刻打开（`finishBindingProbe`）。
       */
      model.setAmbientDrift(false);
      /*
       * 同理，把微动作层也摘掉一整个探测周期，并停掉正在播的动作 ——
       * A-B-A 的前提是「只有我在动」。测完由 `syncMicroMotions()` 把包取回来。
       */
      model.setMicroMotionPack(null);
      model.stopMotion();
    }
    const job = host.bindProbe;
    if (job === null) return;
    if (host.bindProbeCanvas === null) host.bindProbeCanvas = document.createElement('canvas');
    const probe = host.bindProbeCanvas;
    if (probe === null) return;
    if (job.model !== host.renderedPath) {
      // 换模型了：这一份作废（旧的 id 在新模型上不是一回事）。
      model.setAmbientDrift(true);
      host.bindProbe = null;
      return;
    }
    const target = job.targets[job.index] ?? null;
    if (target === null) {
      model.setAmbientDrift(true);
      host.bindProbe = null;
      /*
       * 实测回来之后 Host 会按「哪几根不会动」重算包 —— 现在手里这一份是旧的，
       * 必须再取一次，否则这一轮模型上「借力」永远不会生效（要等下次换模型）。
       */
      void reportBindingProbe(job).then(() => syncMicroMotions(model)).catch(() => {});
      return;
    }

    if (job.step === 'high') {
      if (job.wait === BINDING_PROBE_WARMUP) model.setParameterOverride({ [target.id]: target.high });
      job.wait -= 1;
      if (job.wait <= 0) job.step = 'sample-high';
      return;
    }
    if (job.step === 'sample-high') {
      const pixels = sampleBindingPixels(canvas, probe);
      if (pixels === null) {
        // 画布还没画出东西（刚换模型时的前几帧）：等两帧再试，不是失败。
        job.wait = BINDING_PROBE_WARMUP;
        return;
      }
      job.high = pixels;
      model.setParameterOverride({ [target.id]: target.low });
      job.wait = BINDING_PROBE_WARMUP;
      job.step = 'low';
      return;
    }
    if (job.step === 'low') {
      job.wait -= 1;
      if (job.wait <= 0) job.step = 'sample-low';
      return;
    }
    if (job.step === 'sample-low') {
      const pixels = sampleBindingPixels(canvas, probe);
      if (pixels === null) {
        job.wait = BINDING_PROBE_WARMUP;
        return;
      }
      job.low2 = pixels;
      model.setParameterOverride({ [target.id]: target.high });
      job.wait = BINDING_PROBE_WARMUP;
      job.step = 'high2';
      return;
    }
    if (job.step === 'high2') {
      job.wait -= 1;
      if (job.wait <= 0) job.step = 'sample-high2';
      return;
    }
    // sample-high2：A-B-A 的第二个 A，用来把「她本来就在动」从结论里剔出去。
    const pixels = sampleBindingPixels(canvas, probe);
    if (pixels === null) {
      job.wait = BINDING_PROBE_WARMUP;
      return;
    }
    const up = changedFraction(job.high, job.low2);
    const down = changedFraction(job.low2, pixels);
    const drift = changedFraction(job.high, pixels);
    model.clearParameterOverrides();
    if (up !== null && down !== null) {
      const weaker = Math.min(up, down);
      const noise = drift === null ? 1 : drift;
      if (weaker >= BINDING_PROBE_MIN_CHANGED && noise <= Math.max(BINDING_PROBE_NOISE_FLOOR, weaker * 0.6)) {
        job.results.push({ id: target.id, changed: Math.round(weaker * 1000) / 1000 });
      }
    }
    job.high = null;
    job.low2 = null;
    job.index += 1;
    job.step = 'high';
    job.wait = BINDING_PROBE_WARMUP;
  }

  /**
   * 把当前模型的微动作包取回来交给渲染端（§13.26）。
   *
   * 包是 Host 在能力清单上报时顺手生成的（`ensureMicroMotions`），所以这里
   * 只要在 `reportCapabilities` 之后 GET 一次即可 —— 顺序不能反：清单先到，
   * Host 才知道这个模型有哪些骨骼可用。
   *
   * 取不到不是错误路径：播放器会退回 `idle-garnish.ts` 里手写的那七条。
   */
  async function syncMicroMotions(model: PetModel): Promise<void> {
    try {
      const res = await fetch(`${ROUTE_PREFIX}/micro-motions`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`E_MICRO_FETCH_FAILED: HTTP ${res.status}`);
      }
      const body: unknown = await res.json();
      model.setMicroMotionPack(body);
      /*
       * §13.32 的真 bug 就藏在这两行之间：Host 说「有包」，渲染端归一化后却变成
       * `null`（视图里漏了 `version`，而 `normalizeMicroMotionPack` 严格要它）。
       * 那一刻**没有任何一行日志**：自动微动作与「试演」一起安静地停掉，
       * `live2d_status` 还照旧报「16 条」，用户看到的就是「试演没效果了」。
       *
       * 所以这里把「Host 说 ok、渲染端却不认」变成一条显眼的失败 —— 这类
       * 「两端对同一份数据看法不同」的错，安静本身就是最大的问题。
       */
      if ((body as { ok?: unknown } | null)?.ok === true && model.microMotionPack === null) {
        throw new Error('E_MICRO_BAD_PACK: 这份微动作包渲染端不认（版本或形状对不上）');
      }
    } catch (err) {
      model.setMicroMotionPack(null);
      reportFailure('micro-motions', err);
    }
  }

  /**
   * 面板「参数绑定」一段的数据形状 —— Host `/bindings` 的返回。
   *
   * 这一段的**存在理由**写在 Host 那条路由的注释里（`lib/index.js` 的 `/bindings`）：
   * 情绪表按「角色」写（左眼笑眼 / 眉高 / 身体朝向 …），而每套模型的参数 id 都不
   * 一样，`resolveEmotion()` 只能靠候选表猜。这一节把「猜」变成用户看得见、改得动
   * 的一张表。
   *
   * `auto` 是**不绑定时会被选中的那个**（面板上写成「自动（ParamX）」），
   * `bindingMissing` 是「绑了但本模型没有这个参数」—— 那一种必须显眼，因为
   * 它的症状是「点了开心，她的眼睛没笑」，而日志里一切正常。
   */
  interface BindingRoleView {
    role: string;
    label: string;
    candidates: string[];
    bound: string;
    auto: string | null;
    resolved: string | null;
    source: 'binding' | 'auto' | 'none';
    bindingMissing: boolean;
  }

  interface BindingsView {
    settingsPath: string;
    source: string;
    ignored: { role: string; reason: string }[];
    roles: BindingRoleView[];
    parameters: string[];
  }

  /** 把 `/bindings` 的 JSON 收成 `BindingsView`（Host 版本旧、字段缺失时也不崩）。 */
  function normaliseBindingsView(data: Partial<BindingsView>): BindingsView {
    return {
      settingsPath: typeof data.settingsPath === 'string' ? data.settingsPath : '',
      source: typeof data.source === 'string' ? data.source : '',
      ignored: Array.isArray(data.ignored) ? data.ignored : [],
      roles: Array.isArray(data.roles) ? data.roles : [],
      parameters: Array.isArray(data.parameters) ? data.parameters : [],
    };
  }

  async function fetchBindings(): Promise<BindingsView> {
    const res = await fetch(`${ROUTE_PREFIX}/bindings`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normaliseBindingsView((await res.json()) as Partial<BindingsView>);
  }

  /**
   * 保存绑定。**空表就是「全部恢复自动」**（Host 会把这个键从 settings.json 里删掉，
   * 而不是写一个空对象 —— 一份手写的配置里不该出现 `"emotionBindings": {}`）。
   */
  async function saveBindings(bindings: Record<string, string>): Promise<BindingsView> {
    const res = await fetch(`${ROUTE_PREFIX}/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bindings }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string; detail?: string };
        detail = `${body?.message ?? detail}${typeof body?.detail === 'string' && body.detail !== '' ? `：${body.detail}` : ''}`;
      } catch {
        // 错误体不是 JSON 时保留状态码 —— 面板上有一句话总比什么都没有强。
      }
      throw new Error(detail);
    }
    return normaliseBindingsView((await res.json()) as Partial<BindingsView>);
  }

  /*
   * ── 和桌宠对话（面板「对话」一节，§13.36）────────────────────────────────
   *
   * 面板只做三件事：把用户那句话交给 Host（`POST /chat`）、把她说过的话列出来、
   * 在她「正在想」的时候显示等待。
   *
   * **回复内容不在这里生成**：那句话由 Host 注入到会话里，AI 用 `live2d_speak`
   * 说出来，Host 在指令入队那一刻把它记进账本。所以这一节永远不需要「等一个
   * HTTP 长连接」—— 轮询两秒一次就够，慢的是她那边想。
   */
  interface PetChatItem {
    seq: number;
    role: 'user' | 'pet';
    text: string;
    at: number;
    source: string;
  }

  interface PetChatTransport {
    at: number;
    ok: boolean;
    code: string;
    message: string;
    sessionId: string;
    injected: number;
    failed: number;
  }

  interface PetChatView {
    ok: boolean;
    items: PetChatItem[];
    waiting: boolean;
    waitingText: string;
    summary: string;
    sessionId: string;
    canInject: boolean;
    transport: PetChatTransport;
  }

  const EMPTY_CHAT_TRANSPORT: PetChatTransport = {
    at: 0, ok: false, code: '', message: '', sessionId: '', injected: 0, failed: 0,
  };

  /** 把 `/chat` 的 JSON 收成 `PetChatView`（Host 版本旧、字段缺失时也不崩）。 */
  function normaliseChatView(data: Partial<PetChatView> | null): PetChatView {
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      ok: data?.ok === true,
      items: items.filter((item): item is PetChatItem => item !== null
        && typeof item === 'object'
        && typeof item.text === 'string'
        && (item.role === 'user' || item.role === 'pet')),
      waiting: data?.waiting === true,
      waitingText: typeof data?.waitingText === 'string' ? data.waitingText : '',
      summary: typeof data?.summary === 'string' ? data.summary : '',
      sessionId: typeof data?.sessionId === 'string' ? data.sessionId : '',
      canInject: data?.canInject !== false,
      transport: { ...EMPTY_CHAT_TRANSPORT, ...(data?.transport ?? {}) },
    };
  }

  async function fetchChat(): Promise<PetChatView> {
    const res = await fetch(`${ROUTE_PREFIX}/chat`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normaliseChatView((await res.json()) as Partial<PetChatView>);
  }

  /**
   * 发一句。返回 `{ok, message}`，`ok:false` 表示**这句话没送进会话** ——
   * 但它已经进了面板的账本（Host 先落账再注入）。这两件事必须分开告诉用户，
   * 否则「发出去了、她没反应」与「根本没发出去」是同一个样子。
   */
  async function sendChat(text: string): Promise<{ ok: boolean; message: string }> {
    const res = await fetch(`${ROUTE_PREFIX}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    let body: { injected?: unknown; message?: string; code?: string } | null = null;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = null;
    }
    if (res.ok && body?.injected === true) return { ok: true, message: '' };
    const reason = typeof body?.message === 'string' && body.message !== ''
      ? body.message
      : `HTTP ${res.status}`;
    return { ok: false, message: reason };
  }

  async function clearChat(): Promise<PetChatView> {
    const res = await fetch(`${ROUTE_PREFIX}/chat/clear`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { view?: Partial<PetChatView> };
    return normaliseChatView(body?.view ?? null);
  }

  /*
   * ── 微动作（面板「微动作」一节，§13.26）──────────────────────────────────
   *
   * 形状照抄 Host 的 `microMotionView()`：`gestures` 是**已经算好增量**的那一份，
   * 面板只读不写参数（改幅度不是面板该干的事 —— 那要重新收包络，面板改不出手感）。
   * 面板能改的只有两件：整体强度与逐条开关。
   */
  interface MicroMotionRoleView {
    role: string;
    label: string;
    id: string;
    source: 'binding' | 'auto' | 'none';
  }

  /** 一段：晚 `delayMs` 起步，写这几根参数（§13.32 多段错峰）。 */
  interface MicroMotionPartView {
    delayMs: number;
    params: Record<string, number>;
  }

  interface MicroMotionGestureView {
    id: string;
    label: string;
    /** v2：一条动作拆成 3–4 段，段间错开 90–460 ms。 */
    parts: MicroMotionPartView[];
    attackMs: number;
    holdMs: number;
    releaseMs: number;
    gaze: boolean;
    tags: string[];
    modes: string[];
    weight: number;
    enabled: boolean;
    hidden: boolean;
  }

  interface MicroMotionView {
    ok: boolean;
    model: string;
    name: string;
    source: string;
    generatedAt: number;
    generatedAtText: string;
    strength: number;
    summary: string;
    roles: MicroMotionRoleView[];
    missing: string[];
    substitutions: { from: string; to: string; ratio: number }[];
    gestures: MicroMotionGestureView[];
    message?: string;
    detail?: string;
  }

  function normaliseMicroMotionView(data: Partial<MicroMotionView>): MicroMotionView {
    return {
      ok: data.ok === true,
      model: typeof data.model === 'string' ? data.model : '',
      name: typeof data.name === 'string' ? data.name : '',
      source: typeof data.source === 'string' ? data.source : '',
      generatedAt: typeof data.generatedAt === 'number' ? data.generatedAt : 0,
      generatedAtText: typeof data.generatedAtText === 'string' ? data.generatedAtText : '',
      strength: typeof data.strength === 'number' ? data.strength : 0.9,
      summary: typeof data.summary === 'string' ? data.summary : '',
      roles: Array.isArray(data.roles) ? data.roles : [],
      missing: Array.isArray(data.missing) ? data.missing : [],
      substitutions: Array.isArray(data.substitutions) ? data.substitutions : [],
      gestures: Array.isArray(data.gestures) ? data.gestures : [],
    };
  }

  /**
   * 微动作请求的失败，分成两种：
   *
   * - `retryable`：**等一会儿就好**（模型还没挂上、清单还没上报）。页面刚刷新时
   *   这一节往往比模型的加载先跑，第一把必然是这一种 —— 面板要自己再试，
   *   不能把「等两秒」写成一句「不可用」然后一直挂着（那是这一节第一版的真 bug）。
   * - 不可重试：认不出角色（模型没有可动的骨头）。重试一百次也一样。
   */
  class MicroMotionError extends Error {
    readonly code: string;

    readonly retryable: boolean;

    constructor(message: string, code: string, retryable: boolean) {
      super(message);
      this.name = 'MicroMotionError';
      this.code = code;
      this.retryable = retryable;
    }
  }

  async function readMicroMotionError(res: Response): Promise<MicroMotionError> {
    let detail = `HTTP ${res.status}`;
    let code = '';
    let retryable = false;
    try {
      const body = (await res.json()) as { code?: string; message?: string; detail?: string; retryable?: boolean };
      code = typeof body?.code === 'string' ? body.code : '';
      retryable = body?.retryable === true;
      detail = `${body?.message ?? detail}${typeof body?.detail === 'string' && body.detail !== '' ? `：${body.detail}` : ''}`;
    } catch {
      // 错误体不是 JSON 时保留状态码。
    }
    return new MicroMotionError(detail, code, retryable);
  }

  async function fetchMicroMotions(): Promise<MicroMotionView> {
    const res = await fetch(`${ROUTE_PREFIX}/micro-motions`, { cache: 'no-store' });
    if (!res.ok) throw await readMicroMotionError(res);
    return normaliseMicroMotionView((await res.json()) as Partial<MicroMotionView>);
  }

  /** 面板能改的只有整体强度与逐条开关（`params` / 时长一律不许从面板改）。 */
  async function saveMicroMotions(
    payload: { strength?: number; enabled?: Record<string, boolean> },
  ): Promise<MicroMotionView> {
    const res = await fetch(`${ROUTE_PREFIX}/micro-motions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await readMicroMotionError(res);
    return normaliseMicroMotionView((await res.json()) as Partial<MicroMotionView>);
  }

  /** 一键重写：按当前模型重新认角色、重新算幅度（换模型之后面板上那个按钮）。 */
  async function generateMicroMotions(): Promise<MicroMotionView> {
    const res = await fetch(`${ROUTE_PREFIX}/micro-motions/generate`, { method: 'POST' });
    if (!res.ok) throw await readMicroMotionError(res);
    return normaliseMicroMotionView((await res.json()) as Partial<MicroMotionView>);
  }

  /**
   * 试演一条（§13.30）。
   *
   * 走 Host 而不是直接调 `PetModel.playMicroMotion()`：面板这一节也可能在**没有
   * 舞台**的时候被打开（面板与舞台是两块），那时本地没有模型实例。让指令绕一圈
   * 回到渲染端，两条入口（面板按钮 / AI 工具）就共用同一条路 —— 而且「她有没有
   * 真的演」只有一个答案来源。
   */
  async function playMicroMotion(id: string): Promise<{ ok: boolean; label: string; message: string }> {
    const res = await fetch(`${ROUTE_PREFIX}/micro-motions/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean; label?: string; message?: string; code?: string;
    };
    if (!res.ok || body?.ok !== true) {
      return {
        ok: false,
        label: '',
        message: `${body?.message ?? `HTTP ${res.status}`}${body?.code === undefined ? '' : `（${body.code}）`}`,
      };
    }
    return { ok: true, label: body?.label ?? id, message: '' };
  }

  /*
   * ── 本地语音包（面板「语音包」一节）────────────────────────────────────
   *
   * 形状照抄 Host 那边（`lib/host/voice-library.js` 的 `scanVoiceLibrary()`），
   * 字段名**一个字都不要自己改**：这一节的唯一用途是「让用户看见磁盘上有什么」，
   * 名字一旦客户端自己发明，面板上写的和 settings.json / voices.json 里写的
   * 就对不上了，而用户恰恰是照着面板去改文件的。
   */
  interface VoiceClipView {
    id: string;
    file: string;
    text: string;
    emotion: string;
    tags: string[];
    durationSeconds: number | null;
    bytes: number | null;
  }

  interface VoicePackView {
    ok: boolean;
    dirName: string;
    name: string;
    hasManifest: boolean;
    isDefault: boolean;
    clipCount: number;
    emotions: string[];
    clips: VoiceClipView[];
    problems: { code: string; message: string; path?: string }[];
  }

  interface VoiceListView {
    root: string;
    rootExists: boolean;
    rootSource: string;
    packs: VoicePackView[];
    summary: { packs: number; clips: number; okPacks: number; badPacks: number; problems: number } | null;
    truncated: boolean;
    defaultPack: string | null;
    defaultIsExplicit: boolean;
    error: string | null;
  }

  /** 把 `/voices` 的 JSON 收成 `VoiceListView`（Host 版本旧、字段缺失时也不崩）。 */
  function normaliseVoiceList(data: Partial<VoiceListView>): VoiceListView {
    return {
      root: typeof data.root === 'string' ? data.root : '',
      rootExists: data.rootExists === true,
      rootSource: typeof data.rootSource === 'string' ? data.rootSource : '',
      packs: Array.isArray(data.packs) ? data.packs : [],
      summary: data.summary ?? null,
      truncated: data.truncated === true,
      defaultPack: typeof data.defaultPack === 'string' ? data.defaultPack : null,
      defaultIsExplicit: data.defaultIsExplicit === true,
      error: typeof data.error === 'string' ? data.error : null,
    };
  }

  /**
   * 列语音包。**每次现扫**（Host 那条路由每次重读一遍目录），所以「刷新」
   * 不需要 `?force` 之类的参数 —— 再打一次就够了。
   */
  async function fetchVoices(): Promise<VoiceListView> {
    const res = await fetch(`${ROUTE_PREFIX}/voices`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normaliseVoiceList((await res.json()) as Partial<VoiceListView>);
  }

  /** `/voice` 的返回：与 `/speak` 同一个形状，所以播放走同一条 `playBase64()`。 */
  interface VoiceClipReply {
    pack: string;
    clip: { id: string; text: string; emotion: string; file: string };
    fallback: boolean;
    mimeType: string;
    bytes: number;
    audioBase64: string;
  }

  async function fetchVoiceClip(pack: string, clipId: string): Promise<VoiceClipReply> {
    const query = `pack=${encodeURIComponent(pack)}&clip=${encodeURIComponent(clipId)}`;
    const res = await fetch(`${ROUTE_PREFIX}/voice?${query}`, { cache: 'no-store' });
    const data = (await res.json()) as Partial<VoiceClipReply> & { code?: string; message?: string; detail?: string };
    if (!res.ok || typeof data.audioBase64 !== 'string') {
      const code = typeof data.code === 'string' ? data.code : `HTTP ${res.status}`;
      throw new Error(`${code}: ${data.detail ?? data.message ?? '语音取不出来'}`);
    }
    const clip = data.clip ?? { id: clipId, text: '', emotion: '', file: '' };
    return {
      pack: typeof data.pack === 'string' ? data.pack : pack,
      clip: {
        id: typeof clip.id === 'string' ? clip.id : clipId,
        text: typeof clip.text === 'string' ? clip.text : '',
        emotion: typeof clip.emotion === 'string' ? clip.emotion : '',
        file: typeof clip.file === 'string' ? clip.file : '',
      },
      fallback: data.fallback === true,
      mimeType: typeof data.mimeType === 'string' ? data.mimeType : '',
      bytes: typeof data.bytes === 'number' ? data.bytes : 0,
      audioBase64: data.audioBase64,
    };
  }

  /** 一次导入请求的结果（`sendJson` 的返回或错误体）。 */
  interface UploadReply {
    status: number;
    body: Record<string, unknown> | null;
    text: string;
  }

  /**
   * 把 zip 传上去。
   *
   * **为什么是 `XMLHttpRequest` 而不是 `fetch`**：`fetch` 没有上传进度事件。
   * 一个 90MB 的模型包在局域网上也要几秒、在网络盘上可能几十秒，期间
   * 界面上只有一句不变的「正在导入…」—— 用户会以为卡死了，然后去点第二次。
   * `xhr.upload.onprogress` 是标准 API，几十行就能换来一根真的进度条。
   *
   * 文件名走**查询串**而不是请求头：头部值一旦含非 ASCII 就要自己编码，
   * 而查询串有现成的 `encodeURIComponent`（Host 侧用 `URL` 解出来）。
   */
  function uploadZip(file: File, onProgress: (sent: number) => void): Promise<UploadReply> {
    return new Promise<UploadReply>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${ROUTE_PREFIX}/import?name=${encodeURIComponent(file.name)}`, true);
      xhr.responseType = 'text';
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded);
      };
      xhr.onload = () => {
        let body: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(xhr.responseText);
          if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>;
        } catch {
          /*
           * 不是 JSON。真实会发生的两种情况：Host 半区还是旧版（那条路由不存在，
           * 返回 404 的 HTML），或者中间有代理插了一页错误页。
           * 保留原文给上层，好让用户看见「404」而不是一句「导入失败」。
           */
        }
        resolve({ status: xhr.status, body, text: xhr.responseText.slice(0, 400) });
      };
      // `onerror` 在连接被拒、断线、以及**上传中途 Host 进程退出**时触发。
      xhr.onerror = () => reject(new Error('上传失败：Host 没有响应。'));
      xhr.onabort = () => reject(new Error('上传被中断。'));
      xhr.send(file);
    });
  }

  function readModelPref(): string | null {
    try {
      return localStorage.getItem(MODEL_PREF_KEY);
    } catch {
      return null;
    }
  }

  function writeModelPref(id: string): void {
    try {
      localStorage.setItem(MODEL_PREF_KEY, id);
    } catch {
      /* 隐私模式下 localStorage 会抛，忽略即可 */
    }
    /*
     * 广播放在 try 之外：存储写失败不该顺带把「同一页的另一棵树」也蒙在鼓里 ——
     * 这一轮里它照样能切过去，只是下次刷新会回到旧的。
     */
    try {
      window.dispatchEvent(new CustomEvent(MODEL_PREF_EVENT));
    } catch {
      /* 没有 CustomEvent（极老的渲染器）就算了，退化成「刷新后生效」 */
    }
  }

  /**
   * 把 `localStorage` 包成 `settings.ts` 要的那两个方法。
   *
   * 包一层而不是直接把 `localStorage` 传进去：`localStorage` 在隐私模式下**取属性**
   * 就会抛（不是调方法时才抛），所以连「拿到它」这一步都得在 try 里。
   * 读写的兜底逻辑在 `settings.ts`（纯函数，能断言），这里只负责把异常挡在门外。
   */
  function settingsStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void } | null {
    try {
      const storage = localStorage;
      if (storage === null || storage === undefined) return null;
      return {
        getItem: (key) => storage.getItem(key),
        setItem: (key, value) => storage.setItem(key, value),
      };
    } catch {
      return null;
    }
  }

  /** 口型增益与字幕开关。两者都在方案文档 §2 的配置表里（`lipSync.gain` / `subtitle.enabled`）。 */
  function usePetSettings(): [PetSettings, (patch: Partial<PetSettings>) => void] {
    const [settings, setSettings] = useState<PetSettings>(() => readSettings(settingsStorage()));
    const update = useCallback(
      (patch: Partial<PetSettings>) => setSettings(writeSettings(settingsStorage(), patch)),
      [],
    );
    return [settings, update];
  }

  /** 渲染循环的宿主：一个 <canvas> 加它的整个生命周期。 */
  /**
   * 说一句话：向 Host 要音频，然后播出来。
   *
   * 为什么不在 Host 侧合成好再塞进队列：那样 `/pending` 每次要传几十 KB 的 base64，
   * 而它是 1.2 秒一次的轮询。队列里只放文本（十几个字节），要播的时候再换音频 ——
   * 多一次往返，换轮询流量小两个数量级。
   *
   * 定义成普通函数而不是 `useCallback`：它会被组件和定时器共用，
   * 而这里是 `createClientPlugin` 的函数体、不是组件渲染，调 hook 会违反 Hooks 规则。
   *
   * `isCancelled` 由朗读通道（`speech-lane.ts`）传进来，回答「这句还算数吗」。
   * 为什么需要它：一次 `/speak` 往返要几百毫秒，用户完全可能在这段时间里喊停。
   * 喊停时 `stop()` 会把播放器静音，但**合成还在路上**，回来之后照样会
   * `playBase64()` —— 于是「已经停了」的话又冒出来半句。这是 §6.1 #6
   * 「100ms 内静音」在**合成延迟比 100ms 长**时的漏网情形。
   *
   * `voice` / `rate` 来自 §4.1 `live2d_speak` 的可选参数。Host 的 `/speak` 路由
   * 一直收这两个字段（交给 `tts.synthesize()`，Edge-TTS 的缓存键
   * `voice|rate|pitch|text` 也算进去了），**只有这一层以前没把它们发出去** ——
   * 和 `interrupt` 是同一种缺陷，只是断在更早的一步。
   */
  async function speakNow(
    text: string,
    options?: { voice?: string; rate?: string; isCancelled?: () => boolean },
  ): Promise<void> {
    const isCancelled = options?.isCancelled;
    const cancelledNow = (): boolean => isCancelled?.() === true;
    const speech = getSpeechPlayer();
    /*
     * 这个标志区分「该不该降级」这件事**已经有人回答过了**。
     *
     * Host 明确说「不值得降级」（`degrade: null`，例如文本是空的 —— 换系统语音
     * 也只会把一串空格念出来）时，这里就不该再自作主张降级一次，否则那个策略
     * 等于白写了。它只对「根本没够到 Host」和「Host 自己崩了」两种情况开放。
     */
    let degradeDecided = false;
    try {
      const res = await fetch(`${ROUTE_PREFIX}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: options?.voice, rate: options?.rate }),
      });
      const data = (await res.json()) as {
        audioBase64?: string;
        detail?: string;
        code?: string;
        degrade?: string | null;
        degradeReason?: string;
        /**
         * 这次是谁合成的：`edge`（内置在线音色）或 `custom`（用户本地服务）。
         * 只用来把面板上那行音源名字说准 —— `engineLabel()` 认 `custom`。
         */
        engine?: string;
        /** Edge-TTS 的词边界，**只用于字幕**（§4.2.1：口型走解码后的包络）。 */
        words?: SpeechWord[];
      };
      if (!res.ok || typeof data.audioBase64 !== 'string') {
        degradeDecided = true;
        /*
         * ★ 降级（方案文档 §6.1 #8）。
         *
         * Host 说「这次失败是够不到服务，而不是你说错了话」时，它会在响应里带
         * `degrade: 'system'`。那种情况下换浏览器自带的语音再说一遍，而不是
         * 让用户面对一句「语音失败」然后什么都没有。
         *
         * 判断规则（哪些错误码值得降级）在 `lib/host/tts-adapters.js`，与 Host
         * **共用同一份实现**。客户端这里**不复用 `chooseAdapter`** —— Host 已经
         * 判断过了，客户端照做即可，自己再判断一次只会多一处可能不一致的地方。
         */
        if (data.degrade === 'system') {
          if (cancelledNow()) return;
          await speech.speakWithSystemVoice(text, describeDegradation({
            adapterId: 'system',
            degraded: true,
            reason: data.degradeReason,
          }));
          return;
        }
        throw new Error(`${data.code ?? `HTTP ${res.status}`}: ${data.detail ?? '语音合成失败'}`);
      }
      // 合成期间被叫停了：这一句不再出声（否则「已经停了」的话会冒出来半句）。
      if (cancelledNow()) return;
      await speech.playBase64(
        data.audioBase64,
        text,
        data.words ?? [],
        data.engine === 'custom' ? { adapterId: 'custom' } : undefined,
      );
    } catch (err) {
      /*
       * 「根本没够到 Host」这条分支**必须**存在：断网时 `fetch` 直接抛，
       * 流程根本走不到读 `degrade` 那一步 —— 而断网正是最需要降级的情形。
       */
      if (!degradeDecided && !cancelledNow()) {
        try {
          await speech.speakWithSystemVoice(text, describeDegradation({
            adapterId: 'system',
            degraded: true,
            reason: '连不上语音服务，',
          }));
          return;
        } catch {
          /* 降级这条路也走不通，落到下面统一上报 */
        }
      }
      reportFailure('speech-play', err);
    }
  }

  /**
   * 朗读通道的模块级单例（§4.2.4）。
   *
   * 为什么必须是单例而不是每次用的时候建一个：通道的全部价值就是「同一时刻
   * 只有一句话在播」。两个通道 = 两份队列 = 互相掐。
   *
   * 为什么懒建而不是在文件顶层建：它要 `speakNow` 与 `reportFailure`，
   * 那两个都在 `createClientPlugin` 的函数体里（见 `speakNow` 上方的说明）。
   */
  let sharedLane: SpeechLane | null = null;

  function getSpeechLane(): SpeechLane {
    if (sharedLane === null) {
      sharedLane = createSpeechLane({
        /*
         * 通道把「这一句要念什么」整个交过来（`SpeechRequest`），这里拆成
         * `speakNow()` 认的形状。`voice` / `rate` 必须**逐句**传下去，不能
         * 存在通道上 —— 存了的话队列里所有句子会共用最后一次设置。
         */
        speak: (request, isCancelled) => speakNow(request.text, {
          voice: request.voice,
          rate: request.rate,
          isCancelled,
        }),
        /*
         * 「这一句播完了」的唯一诚实信号是 `state.speaking` 翻回 false
         * （`speech.ts` 的 `playBase64()` resolve 在**开始播**，不是播完）。
         * 看门狗在 `waitForPlayer()` 里面 —— 没有它，一次丢失的 `onended`
         * 会让通道永久卡死，之后 AI 说的每一句都排在后面永远轮不到。
         */
        waitUntilDone: () => waitForPlayer(getSpeechPlayer()),
        stop: () => getSpeechPlayer().stop(),
        onError: (err) => reportFailure('speech-lane', err),
        /*
         * ★ 反向通道的两个过渡点（D-2）。
         *
         * 为什么记在这里而不是记在轮询回调里：轮询知道的是「我排了一句」，
         * 而 AI 需要知道的是「她**正在**念」与「她**念完了**」。前者是意图，
         * 后者是事实，两者之间隔着一次合成（几百毫秒）和一次播放（几秒）。
         * 通道是唯一同时看得见两端的角色 —— `speak()` resolve 在出声那一刻，
         * `waitUntilDone()` resolve 在声音停下那一刻。
         *
         * 时刻由 `Date.now()` 给（这个模块层的规矩：账本自己不读钟）。
         */
        onStart: () => noteSpeechStart(Date.now()),
        onSettled: () => noteSpeechSettled(Date.now()),
      });
    }
    return sharedLane;
  }

  /**
   * 面板「试听」：取一条语音包里的录音，直接播出来。
   *
   * ★ 与「说一句话」的区别**只在出声之前**：这里是用户点了某一条具体录音，
   * 他要听的就是这一条，所以先 `stopAll()` 把通道里排队的 AI 台词清掉。
   * 不这样做的话，症状是「点了试听没反应，几秒后突然念起 AI 刚才那句话」——
   * 比不播更让人困惑。
   *
   * 出声之后走的是**同一条** `playBase64()`：口型来自解码后的 PCM 包络，
   * 与音源无关（`speech.ts` 里 `createEnvelope` 那一层），所以本地录音也一样张嘴；
   * `adapterId: 'voice'` 只影响面板上那行音源名字。
   */
  async function auditionVoice(pack: string, clipId: string): Promise<void> {
    const reply = await fetchVoiceClip(pack, clipId);
    getSpeechLane().stopAll();
    await getSpeechPlayer().playBase64(reply.audioBase64, reply.clip.text, [], { adapterId: 'voice' });
  }

  /*
   * ── 音色偏好（面板「音色」一节）────────────────────────────────────────
   *
   * 这一节回答的是用户那句「让 TTS 用另外一种音色说话」：**有哪些音色**、
   * **现在用哪一个**、**改了就立刻能听见**。
   *
   * 音色清单**由 Host 给**（`/tts` 的 `voices` 字段），客户端一个字都不写死：
   * 清单里那些 ShortName 是与 `edge-tts.js` 联通的东西，写死在 bundle 里的话，
   * 以后换合成器或加引擎就得同时改两个地方，而其中一个要用户刷新才更新。
   */
  interface TtsVoiceOptionView {
    id: string;
    label: string;
    locale: string;
    note: string;
    custom: boolean;
  }

  interface TtsEngineOptionView {
    id: string;
    label: string;
    note: string;
  }

  interface TtsSettingsView {
    voice: string;
    voiceLabel: string;
    voiceSource: string;
    rate: string;
    engine: string;
    engineLabel: string;
    engines: TtsEngineOptionView[];
    endpoint: string;
    endpointValid: boolean;
    customReady: boolean;
    defaultEngine: string;
    notes: string[];
    voices: TtsVoiceOptionView[];
    defaultVoice: string;
    settingsPath: string;
    source: string;
    /** 当前启用的音色包 id（空串 = 不用，走适配层自己的默认音色）。 */
    voicePack: string;
    voicePackRoot: string;
    voicePacks: TtsVoicePackListing;
  }

  /**
   * 音色包（参考音 + 逐字文本 + 许可）。
   *
   * `promptText` 一定要显示出来：零样本克隆里「这段参考音说的是哪几个字」决定
   * 合成质量，而用户拿到一个包时唯一能核对的线索就是这一行。
   */
  /**
   * 包里带的训练权重（可选）。
   *
   * `version` 是**按文件头判出来的**，不是清单自称的那个：清单可以写错，
   * 而服务端在认不出来时会按文件大小猜版本 —— 猜错的后果是「不报错但声音不对」。
   */
  interface TtsVoicePackWeights {
    version: string;
    declared: string;
    sovits: string;
    gpt: string;
    bytes: number;
    /**
     * 能不能在正在跑的服务上热换。
     *
     * PK 容器（新版 torch.save）文件头认不出版本，服务端会按大小猜 —— 猜错的后果是
     * 「200 success 但采样率变了」。这种包只能换 yaml 重启引擎，列表里就说清楚。
     */
    hotSwap: boolean;
  }

  interface TtsVoicePackView {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    license: string;
    source: string;
    promptText: string;
    promptLang: string;
    textLang: string;
    refBytes: number;
    refMime: string;
    active: boolean;
    weights: TtsVoicePackWeights | null;
  }

  interface TtsVoicePackListing {
    root: string;
    packs: TtsVoicePackView[];
    broken: Array<{ dir: string; reason: string }>;
  }

  function normalisePackWeights(data: unknown): TtsVoicePackWeights | null {
    if (data === null || typeof data !== 'object') return null;
    const source = data as Record<string, unknown>;
    return {
      version: typeof source.version === 'string' ? source.version : '',
      declared: typeof source.declared === 'string' ? source.declared : '',
      sovits: typeof source.sovits === 'string' ? source.sovits : '',
      gpt: typeof source.gpt === 'string' ? source.gpt : '',
      bytes: typeof source.bytes === 'number' ? source.bytes : 0,
      hotSwap: source.hotSwap === true,
    };
  }

  function normaliseVoicePacks(data: unknown): TtsVoicePackListing {
    const source = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const packs = Array.isArray(source.packs) ? source.packs : [];
    const broken = Array.isArray(source.broken) ? source.broken : [];
    return {
      root: typeof source.root === 'string' ? source.root : '',
      packs: packs
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
        .filter((entry) => typeof entry.id === 'string')
        .map((entry) => ({
          id: String(entry.id),
          name: typeof entry.name === 'string' ? entry.name : String(entry.id),
          version: typeof entry.version === 'string' ? entry.version : '',
          description: typeof entry.description === 'string' ? entry.description : '',
          author: typeof entry.author === 'string' ? entry.author : '',
          license: typeof entry.license === 'string' ? entry.license : '',
          source: typeof entry.source === 'string' ? entry.source : '',
          promptText: typeof entry.promptText === 'string' ? entry.promptText : '',
          promptLang: typeof entry.promptLang === 'string' ? entry.promptLang : 'zh',
          textLang: typeof entry.textLang === 'string' ? entry.textLang : 'zh',
          refBytes: typeof entry.refBytes === 'number' ? entry.refBytes : 0,
          refMime: typeof entry.refMime === 'string' ? entry.refMime : '',
          active: entry.active === true,
          weights: normalisePackWeights(entry.weights),
        })),
      broken: broken
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
        .map((entry) => ({
          dir: typeof entry.dir === 'string' ? entry.dir : '',
          reason: typeof entry.reason === 'string' ? entry.reason : '',
        })),
    };
  }

  function normaliseTts(data: Partial<TtsSettingsView>): TtsSettingsView {
    const voices = Array.isArray(data.voices) ? data.voices : [];
    const engines = Array.isArray(data.engines) ? data.engines : [];
    const engine = typeof data.engine === 'string' ? data.engine : 'edge';
    return {
      voice: typeof data.voice === 'string' ? data.voice : '',
      voiceLabel: typeof data.voiceLabel === 'string' && data.voiceLabel !== ''
        ? data.voiceLabel
        : (typeof data.voice === 'string' ? data.voice : ''),
      voiceSource: typeof data.voiceSource === 'string' ? data.voiceSource : 'default',
      rate: typeof data.rate === 'string' ? data.rate : '+0%',
      engine,
      engineLabel: typeof data.engineLabel === 'string' && data.engineLabel !== '' ? data.engineLabel : engine,
      engines: engines.filter((option) => option !== null && typeof option === 'object' && typeof option.id === 'string'),
      endpoint: typeof data.endpoint === 'string' ? data.endpoint : '',
      endpointValid: data.endpointValid === true,
      customReady: data.customReady === true,
      defaultEngine: typeof data.defaultEngine === 'string' ? data.defaultEngine : 'edge',
      notes: Array.isArray(data.notes) ? data.notes.filter((note) => typeof note === 'string') : [],
      voices: voices.filter((option) => option !== null && typeof option === 'object' && typeof option.id === 'string'),
      defaultVoice: typeof data.defaultVoice === 'string' ? data.defaultVoice : '',
      settingsPath: typeof data.settingsPath === 'string' ? data.settingsPath : '',
      source: typeof data.source === 'string' ? data.source : '',
      voicePack: typeof data.voicePack === 'string' ? data.voicePack : '',
      voicePackRoot: typeof data.voicePackRoot === 'string' ? data.voicePackRoot : '',
      voicePacks: normaliseVoicePacks((data as Partial<TtsSettingsView>).voicePacks),
    };
  }

  async function fetchTts(): Promise<TtsSettingsView> {
    const res = await fetch(`${ROUTE_PREFIX}/tts`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normaliseTts((await res.json()) as Partial<TtsSettingsView>);
  }

  /**
   * 存偏好。**失败要说出 Host 的那句人话**：`E_TTS_BAD_VOICE` 的 `detail` 正是
   * 「要写成 ShortName，例如 'zh-CN-XiaoxiaoNeural'」—— 用户抄的就是那一行。
   */
  async function saveTts(patch: {
    voice?: string;
    rate?: string;
    engine?: string;
    endpoint?: string;
    voicePack?: string;
  }): Promise<TtsSettingsView> {
    const res = await fetch(`${ROUTE_PREFIX}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as Partial<TtsSettingsView> & { code?: string; message?: string; detail?: string };
    if (!res.ok) {
      const code = typeof data.code === 'string' ? data.code : `HTTP ${res.status}`;
      throw new Error(`${code}：${data.detail ?? data.message ?? '保存失败'}`);
    }
    return normaliseTts(data);
  }

  /**
   * 音色包的三件事：导入、启用、删除。
   *
   * 为什么「启用」不走 `saveTts({voicePack})`：面板上的「保存」按钮管的是
   * 引擎/地址/语速那一组；音色包点一下就生效才是它该有的手感（试完不满意再点
   * 另一个）。两条路由写的是同一个设置键，但**时机不同**：保存是决定，
   * 启用是切换。
   */
  async function controlVoicePack(
    action: 'import' | 'activate' | 'remove',
    payload: { id?: string; path?: string; overwrite?: boolean },
  ): Promise<{
    listing: TtsVoicePackListing;
    voicePack: string;
    /** 本次导入/操作涉及的那个包（Host 在 import 时回；activate/remove 没有）。 */
    pack: TtsVoicePackView | null;
    switched: { version: string; bytes: number; elapsedMs: number } | null;
    restartRequired: boolean;
  }> {
    const res = await fetch(`${ROUTE_PREFIX}/tts/packs/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { ok?: boolean; code?: string; message?: string; detail?: string } & Record<string, unknown>;
    if (!res.ok || data.ok === false) {
      const code = typeof data.code === 'string' ? data.code : `HTTP ${res.status}`;
      throw new Error(`${code}：${(typeof data.detail === 'string' && data.detail) || (typeof data.message === 'string' && data.message) || '操作失败'}`);
    }
    const rawSwitched = data.switched !== null && typeof data.switched === 'object'
      ? (data.switched as Record<string, unknown>)
      : null;
    const rawPack = data.pack !== null && typeof data.pack === 'object'
      ? (data.pack as Record<string, unknown>)
      : null;
    /*
     * `pack` 字段只是「这次动的是哪一个」的一封信，字段本身在清单里已经规范化过了 ——
     * 从清单里按 id 取，避免把同一套兜底再写第二遍（两份写法迟早会不一致）。
     */
    const listing = normaliseVoicePacks(data);
    const packId = rawPack === null || typeof rawPack.id !== 'string' ? '' : rawPack.id;
    return {
      listing,
      voicePack: typeof data.voicePack === 'string' ? data.voicePack : '',
      pack: packId === '' ? null : listing.packs.find((entry) => entry.id === packId) ?? null,
      switched: rawSwitched === null
        ? null
        : {
          version: typeof rawSwitched.version === 'string' ? rawSwitched.version : '',
          bytes: typeof rawSwitched.bytes === 'number' ? rawSwitched.bytes : 0,
          elapsedMs: typeof rawSwitched.elapsedMs === 'number' ? rawSwitched.elapsedMs : 0,
        },
      restartRequired: data.restartRequired === true,
    };
  }

  /**
   * 听一下这个包的参考音。
   *
   * 走 Host 的 `/tts/packs/audio` 而不是让面板直接读文件：渲染进程读不到磁盘，
   * 而这条路由同时服务「试听」与「适配层取参考音」，两者必须是同一份字节。
   */
  async function auditionVoicePack(id: string): Promise<void> {
    const res = await fetch(`${ROUTE_PREFIX}/tts/packs/audio?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^;]+;base64,/, ''));
      reader.onerror = () => reject(reader.error ?? new Error('读不出来'));
      reader.readAsDataURL(blob);
    });
    await getSpeechPlayer().playBase64(base64);
  }

  /**
   * 试听：用**待保存**的音色念一句，**不落盘**。
   *
   * 为什么不让试听顺手保存：用户是在「挑」声音，挑的过程中每一次点击都改掉默认
   * 音色，等于把「试听」变成了「连续误保存」。挑完点保存，那才是他的决定。
   *
   * 走的还是 `/speak`（不是另一条路由）：音色能不能用只有合成器知道，
   * 换一条路由去「查」音色，查到的只是另一份名单。
   */
  async function auditionTtsVoice(
    voice: string,
    rate: string,
    label: string,
    override?: { engine: string; endpoint: string },
  ): Promise<void> {
    const text = `试听：现在的声音是${label}。`;
    const res = await fetch(`${ROUTE_PREFIX}/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        voice,
        rate,
        /*
         * 试听**用面板上还没保存的选择**，而不是已保存的引擎。
         *
         * 用户在挑引擎/地址，此刻 `/speak` 若只认 `settings.json`，那「先点保存
         * 再试听」就成了唯一路径 —— 而保存一个连不通的地址会让他以为配置坏了。
         * 这两个字段只是**这一次**的覆盖，不落盘。
         */
        engine: override?.engine,
        endpoint: override?.endpoint,
      }),
    });
    const data = (await res.json()) as {
      audioBase64?: string;
      words?: unknown[];
      engine?: string;
      code?: string;
      message?: string;
      detail?: string;
    };
    if (!res.ok || typeof data.audioBase64 !== 'string') {
      const code = typeof data.code === 'string' ? data.code : `HTTP ${res.status}`;
      throw new Error(`${code}：${data.detail ?? data.message ?? '合成失败'}`);
    }
    getSpeechLane().stopAll();
    await getSpeechPlayer().playBase64(
      data.audioBase64,
      text,
      Array.isArray(data.words) ? (data.words as never[]) : [],
      { adapterId: data.engine === 'custom' ? 'custom' : 'edge' },
    );
  }

  /** 「测试连接」的结果。字段由 Host 的 `probeCustomTts()` 直接给，客户端不重新解释。 */
  interface TtsProbeView {
    ok: boolean;
    endpoint: string;
    reachable: boolean;
    status: number;
    elapsedMs: number;
    code?: string;
    message?: string;
  }

  /**
   * 让 **Host** 去探自定义 TTS 服务在不在（面板自己 fetch 会被 CORS 挡住）。
   *
   * 允许带未保存的地址：用户要先试通再保存。
   */
  async function probeTtsEndpoint(endpoint: string): Promise<TtsProbeView> {
    const res = await fetch(`${ROUTE_PREFIX}/tts/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    const data = (await res.json()) as Partial<TtsProbeView> & { code?: string; message?: string; detail?: string };
    if (!res.ok) {
      const code = typeof data.code === 'string' ? data.code : `HTTP ${res.status}`;
      throw new Error(`${code}：${data.detail ?? data.message ?? '探测失败'}`);
    }
    return {
      ok: data.ok === true,
      endpoint: typeof data.endpoint === 'string' ? data.endpoint : endpoint,
      reachable: data.reachable === true,
      status: typeof data.status === 'number' ? data.status : 0,
      elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : 0,
      code: typeof data.code === 'string' ? data.code : undefined,
      message: typeof data.message === 'string' ? data.message : undefined,
    };
  }

  /** 本地 TTS 一键面板要显示的三样东西：端口、安装、适配层脚本。 */
  interface LocalTtsPortView {
    port: number;
    listening: boolean;
  }

  interface LocalTtsInstallView {
    root: string;
    python: string;
    api: string;
    configs: string[];
    config: string;
  }

  interface LocalTtsStatusView {
    ports: { engine: LocalTtsPortView; adapter: LocalTtsPortView };
    installs: LocalTtsInstallView[];
    adapter: { script: string; exists: boolean };
    suggestedEndpoint: string;
    selected: { root: string; config: string } | null;
    /** 面板点了不存在的安装目录时，Host 会退回第一处并在这里说一声。 */
    requestedRoot?: string;
    /** 「用哪份」的来路：query（面板正选着）→ settings（上次存的）→ default（探测的第一处）。 */
    selection?: {
      root: string;
      config: string;
      preferredRoot: string;
      preferredConfig: string;
      source: 'query' | 'settings' | 'default';
    };
    managed: { engine: number | null; adapter: number | null };
    /** 「这是我起的」是哪一层认的：本轮 / 上次 DSH 之前（账本）/ 无。 */
    managedSource?: { engine: string | null; adapter: string | null };
  }

  /** 面板上「用哪一份」的那一条：安装目录 + yaml 名。 */
  interface LocalTtsPick {
    root: string;
    config: string;
  }

  /** 停掉的那一条：`source` 说明「凭什么叫它我起的」（§13.24 的三层）。 */
  interface LocalTtsStoppedEntry {
    name: string;
    pid: number;
    port?: number;
    source?: 'managed' | 'ledger' | 'adopted';
    command?: string;
  }

  /** 没动的那一条：`reason` 是 `pid-gone` 或 `not-managed`，其余字段是证据。 */
  interface LocalTtsSkippedEntry {
    name: string;
    reason: string;
    pid?: number | null;
    port?: number;
    portListening?: boolean;
    command?: string;
  }

  interface LocalTtsResult {
    ok: boolean;
    started?: Array<{ name: string; pid: number; port: number; config?: string }>;
    stopped?: LocalTtsStoppedEntry[];
    skipped?: LocalTtsSkippedEntry[];
    status?: LocalTtsStatusView;
    code?: string;
    message?: string;
  }

  /**
   * 「停了谁」写成一句话。
   *
   * `adopted` 与 `ledger` 必须说出来：用户点的是「停止」，如果面板只回
   * 「已停止 本地引擎」，他没法知道刚才那个 pid 是不是自己十分钟前手动开的
   * —— §13.24 的原始抱怨正是「这个功能到底停了什么，我看不出来」。
   */
  function describeStoppedEntry(entry: LocalTtsStoppedEntry): string {
    const who = entry.name === 'engine' ? '本地引擎' : '适配层';
    const where = typeof entry.port === 'number' ? `${entry.port} ` : '';
    if (entry.source === 'adopted') {
      return `${where}${who}（pid ${entry.pid}，按命令行认出来的 —— 不是这一轮起的）`;
    }
    if (entry.source === 'ledger') {
      return `${where}${who}（pid ${entry.pid}，上次关闭 DSH 前起的）`;
    }
    return `${where}${who}（pid ${entry.pid}）`;
  }

  /** 「为什么没动」写成一句话：三种情况三种说法，别用同一句糊过去。 */
  function describeSkippedEntry(entry: LocalTtsSkippedEntry): string {
    const where = typeof entry.port === 'number' ? `${entry.port} ` : '';
    if (entry.reason === 'pid-gone') {
      return `${where}记录里的进程（pid ${entry.pid ?? '?'}）已经不在了，记录已清掉`;
    }
    if (entry.portListening === false) return `${where}没有服务在跑`;
    const pid = typeof entry.pid === 'number' ? `pid ${entry.pid}` : '一个不知道 pid 的进程';
    return `${where}上是 ${pid}，命令行里没有插件用的那一串，不是我起的，没有动`;
  }

  function normaliseLocalTts(data: Partial<LocalTtsStatusView>): LocalTtsStatusView {
    const ports = data.ports ?? ({} as LocalTtsStatusView['ports']);
    const readPort = (value: Partial<LocalTtsPortView> | undefined, fallback: number) => ({
      port: typeof value?.port === 'number' ? value.port : fallback,
      listening: value?.listening === true,
    });
    const installs = Array.isArray(data.installs)
      ? data.installs.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.root === 'string')
      : [];
    return {
      ports: {
        engine: readPort(ports.engine, 9880),
        adapter: readPort(ports.adapter, 9881),
      },
      installs,
      adapter: {
        script: typeof data.adapter?.script === 'string' ? data.adapter.script : '',
        exists: data.adapter?.exists === true,
      },
      suggestedEndpoint: typeof data.suggestedEndpoint === 'string' && data.suggestedEndpoint !== ''
        ? data.suggestedEndpoint
        : 'http://127.0.0.1:9881/tts',
      selected: data.selected ?? null,
      requestedRoot: typeof data.requestedRoot === 'string' ? data.requestedRoot : '',
      managed: {
        engine: typeof data.managed?.engine === 'number' ? data.managed.engine : null,
        adapter: typeof data.managed?.adapter === 'number' ? data.managed.adapter : null,
      },
      managedSource: {
        engine: typeof data.managedSource?.engine === 'string' ? data.managedSource.engine : null,
        adapter: typeof data.managedSource?.adapter === 'string' ? data.managedSource.adapter : null,
      },
    };
  }

  /**
   * 「本地 TTS 一键」。
   *
   * 这四条路由存在的理由只有一个：**把安装知识从用户脑子里搬进代码里**。
   * 面板原来只说「填个地址」，而地址只是最后一格 —— 前面还有「装在哪、用哪个
   * yaml、要起两个进程」。这些都由 Host 探测，客户端只负责把结论变成一句话。
   *
   * 失败照例要把 Host 的人话带出来（`E_LOCAL_TTS_NO_INSTALL` 之类），
   * 那样用户知道下一步是「设 DSH_GSV_ROOT」而不是「再点一次试试」。
   */
  async function fetchLocalTts(root = '', config = ''): Promise<LocalTtsStatusView> {
    /*
     * 把面板上正选着的两份带上（§13.28）。不带的话 Host 只能回答「默认那处」，
     * 面板再拿这个答案覆盖自己的下拉框 —— 用户刚挑的 v5 就这么被抹掉了。
     */
    const query = new URLSearchParams();
    if (root !== '') query.set('root', root);
    if (config !== '') query.set('config', config);
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    const res = await fetch(`${ROUTE_PREFIX}/tts/local${suffix}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normaliseLocalTts((await res.json()) as Partial<LocalTtsStatusView>);
  }

  /**
   * 把「用哪份」存进 settings.json（§13.28）。
   *
   * 为什么不是只在启动时存：选择发生在点启动**之前**，换一份 yaml 然后刷新页面
   * 是很正常的动作，那时还没启动过。失败不抛（选择这件事不该挡住启动），
   * 只把 Host 的原话带回去让面板说一句。
   */
  async function selectLocalTts(root: string, config: string): Promise<{ ok: boolean; message: string }> {
    const res = await fetch(`${ROUTE_PREFIX}/tts/local/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, config }),
    });
    const data = (await res.json()) as { ok?: boolean; code?: string; message?: string; detail?: string };
    if (!res.ok || data.ok === false) {
      return { ok: false, message: `${data.code ?? `HTTP ${res.status}`}：${data.detail ?? data.message ?? '没存上'}` };
    }
    return { ok: true, message: '' };
  }

  async function controlLocalTts(
    action: 'start' | 'stop',
    target: 'all' | 'engine' | 'adapter' = 'all',
    pick?: LocalTtsPick,
  ): Promise<LocalTtsResult> {
    const body: Record<string, string> = { target };
    /*
     * 「用哪一份」只在**探测结果的清单里**挑：`root` 是绝对路径、`config` 是 yaml 文件名，
     * Host 会再校验一遍（不在清单里就 400）. 这里不做字符串清洗，因为真正的把关在 Host。
     */
    if (action === 'start' && pick !== undefined) {
      if (pick.root !== '') body.root = pick.root;
      if (pick.config !== '') body.config = pick.config;
    }
    const res = await fetch(`${ROUTE_PREFIX}/tts/local/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as LocalTtsResult & { detail?: string };
    if (!res.ok) {
      const code = typeof data.code === 'string' ? data.code : `HTTP ${res.status}`;
      throw new Error(`${code}：${data.detail ?? data.message ?? '操作失败'}`);
    }
    return data;
  }

  /**
   * 把 Host 的待办队列变成真的动作与声音。
   *
   * 队列是**取走即清空**的（Host 侧 `splice`），所以这里不能重试重放：一次拉取失败
   * 就等于那几条没执行过。这个取舍是刻意的 —— 重复播一个动作比少播一个更让人困惑。
   *
   * 每一条该做什么由 `action-runner.ts` 分派（说话 / 动作 / 表情 / 视线 / 参数 / 停下）。
   * 这里只管三件与 React 有关的事：轮询、过期检查、把失败上报。
   */
  function useSpeechQueue(): SpeechPlayerState {
    const speech = getSpeechPlayer();
    const [snapshot, setSnapshot] = useState<SpeechPlayerState>(() => ({ ...speech.state }));

    useEffect(() => speech.subscribe(() => setSnapshot({ ...speech.state })), []);

    useEffect(() => {
      let cancelled = false;
      let busy = false;
      /*
       * ★ 命令通道的自救三件套（`tickGen` / `busySince` / `busyStep`）。
       *
       * `busy` 是防重入的，这没问题；问题是它**只有 `finally` 一条解除路径**。
       * 只要里面任何一个 `await` 永不 settle，`busy` 就永远是 `true`，而外面
       * 看不出来：心跳是另一个 effect 写的（`useHostStatus`），所以
       * `lastClientSeenAt` 照样新鲜；fps 照样 60；面板照样显示一切正常 ——
       * 只有桌宠再也不接受任何指令、也不再自动待机。
       *
       * 这三样东西把那种状态变成**能看见、能恢复**的：
       *   · `busySince` + `busyStep` 记住「卡在哪一步、卡了多久」；
       *   · `tickGen` 是世代号：看门狗强行解锁时自增，让卡住的那一轮醒来之后
       *     在下一个检查点发现自己已经作废，不会把同一批指令再执行一遍。
       */
      let tickGen = 0;
      let busySince = 0;
      let busyStep = '';
      /** 已经为**这一次**卡住报过警了没有（不清掉就会每 5 秒报一条）。 */
      let busyReported = false;
      /*
       * 空闲行为的两个时钟。
       *
       * `lastActivityAt` 初值取**当前时间**而不是 0：0 代表「很久没动」，
       * 面板一打开就会立刻触发一次待机动作 —— 那时模型可能还在加载，
       * 结果是开局一条 E_ACTION_NO_MODEL 刷进日志。
       */
      let lastActivityAt = Date.now();
      let lastAutoIdleAt = Date.now();
      /*
       * 待机换片的两个记忆（§13.31）。
       *
       * `lastIdleIndex`：上一次演的是组内第几号 —— 下一次随机挑时避开它。
       *   初值 `-1` 表示「还没有过」，此时不该避开任何一条。
       * `idleHoldMs`：这一条该在她身上停多久 —— 由**上一条的片段时长**算出来
       *   （`idleHoldMsFor`）。跑第一条之前还不知道，先用 20 秒；播成之后
       *   立刻换成 6–12 秒，之后每换一次都重算。
       */
      let lastIdleIndex = -1;
      let idleHoldMs = IDLE_AFTER_MS;
      /*
       * 上一轮朗读通道忙不忙 —— 用来抓「**刚念完**」那一瞬间（`busy → 不 busy`）。
       * 见待机那一段里的第五个条件。
       */
      let speechWasBusy = false;

      const tick = async () => {
        if (cancelled || busy) return;
        busy = true;
        const myGen = ++tickGen;
        busySince = Date.now();
        busyReported = false;
        busyStep = '取指令';
        /*
         * 卡住的那一轮醒来之后靠这个判断自己还算不算数。
         *
         * 只在 `await` 之后检查，不在同步段里检查：同步段不可能被看门狗插进来。
         */
        const stale = (): boolean => cancelled || myGen !== tickGen;
        try {
          const res = await fetchWithTimeout(
            `${ROUTE_PREFIX}/pending`,
            { cache: 'no-store' },
            POLL_FETCH_TIMEOUT_MS,
          );
          if (stale()) return;
          if (!res.ok) return;
          const data = (await res.json()) as {
            items?: PendingItem[];
            /**
             * Host 的状态机顺带报的「她在干什么」（`lib/host/mood.js`）。
             *
             * 只有 `thinking` 这一个值有渲染端消费者，其余（`idle` / `reacting` /
             * `settling`）都只是让人看懂状态。**旧 Host 没有这个字段** —— 那时
             * `state` 是 `undefined`，收幅不生效，行为与改动前完全一致。
             */
            mood?: { state?: string };
          };
          if (stale()) return;
          /*
           * ★ 思考时把动作的幅度收小（细节在 `motion-calm.ts`）。
           *
           * 为什么搭在 `/pending` 上而不是另开一条推送：这条轮询本来就 1.2 秒
           * 一次、每次都要读一遍 Host 状态，而「她在想事情」的时效性正好是这个量级
           * （思考态自己也是几百毫秒的淡入）。新开一条通道要多一套重连/去重，
           * 收益只是把延迟从 1.2 秒降到 0.2 秒 —— 用户看不出这个差别。
           *
           * 注意这里**不 await**：`setMotionCalm` 只记一个布尔，包络在渲染帧里
           * 推进（`pet-model.ts` 的 `_applyMotionCalm()`），所以「指令还在排队」
           * 与「动作已经开始收」互不阻塞。
           */
          const calmTarget = getActionTarget();
          if (calmTarget !== null) {
            calmTarget.setMotionCalm?.(data.mood?.state === 'thinking');
          }
          busyStep = `执行 ${String(data.items?.length ?? 0)} 条指令`;
          for (const item of data.items ?? []) {
            if (stale()) return;
            /*
             * 新 Host 把指令放在 `item.command` 里；旧的兼容垫片把 `speak` 直接摊在
             * 条目顶层（见 `lib/index.js` 的 `pushCommand`）。两种都认 —— 页面上的
             * bundle 与 Host 的版本随时可能差一次刷新。
             */
            const command = item?.command ?? item;
            /*
             * 过期检查**必须在这里再做一次**：Host 的 `pruneQueue()` 只在入队时裁剪，
             * 面板折叠一分钟期间 AI 连发八句，这次轮询拿到的八条里七条早过期了。
             */
            if (isExpired(command, item?.at, Date.now())) {
              // 过期不是错误，但要留痕 —— 否则「她为什么只说了一句」无从查起。
              console.info('[dsh-live2d-pet] 丢弃过期指令', command);
              continue;
            }
            busyStep = `执行指令 ${command.kind}`;
            const result = await runCurrentAction(command, {
              /*
               * ★ 排进朗读通道就立刻返回，**不在这里等这句话播完**。
               *
               * 两个理由：
               *   ① 等下去会让同一个批次里的第二条 `say` 把第一条掐断 ——
               *      `playBase64()` resolve 在「开始播」而不是播完（见
               *      `speech-lane.ts` 的文件头，这是 P3 交付后反查 §6.1 #6
               *      时抓到的真缺陷）。
               *   ② 不等才让动作与语音**并行**：§6.1 场景 4 要求「AI 主动做
               *      非语音动作时不打断当前语音」，而串行 await 会把动作推迟到
               *      语音之后 —— 那不是「不打断」，是「不让做」。
               */
              speak: (text, options) => {
                /*
                 * `interrupt` 的判断住在 `speakWithInterrupt()` 里，不写在这儿 ——
                 * 这一段以前就是「一行没人守的 glue」，`interrupt` 正是在这里被丢掉的
                 * （详见那个函数的注释）。搬到 `speech-lane.ts` 之后，
                 * `tools/test-speech-lane.mjs` 能直接调它。
                 */
                speakWithInterrupt(getSpeechLane(), text, options);
                return Promise.resolve();
              },
              stopSpeech: () => getSpeechLane().stopAll(),
            });
            /*
             * 「有指令来过」就算活动，**哪怕它失败了**：失败也要占用待机的冷却，
             * 否则一条坏的 `motion` 指令会立刻被一次自动待机动作接上，
             * 日志里看起来像是待机动作把模型搞坏了。
             */
            lastActivityAt = Date.now();
            if (stale()) return;
            if (!result.ok) {
              reportFailure(`action-${result.code === '' ? 'unknown' : result.code}`, new Error(result.detail));
            }
          }

          /*
           * ★ 空闲行为：没人搭理的时候自己动一下。
           *
           * 决策本身是纯函数（`shouldAutoIdle` / `pickIdleGroup`），门禁
           * `tools/test-action-runner.mjs` 把它们钉住了；这里只负责读时钟与调用。
           *
           * `target.currentMotionPriority()` 必须一起传进去：框架**不拦**任何新动作
           * （`startMotionPriority()` 无条件开播，见方案 §4.2.12），所以
           * 「待机盖不掉正经动作」这件事只能由待机自己先问一句来实现。
           *
           * ★ 还有一件它必须知道的事：**嘴还在不在动**。前四条数的都是「距上次
           * 指令多久」，而一句长文本能念四十秒 —— 念到第 20 秒计时器就到位了，
           * 于是她会在说话的同时把姿势换掉（§9.7 第 6 条那个已知边界）。
           * 所以这里把「朗读通道还忙不忙」也传进去（`shouldAutoIdle` 的第五个条件）。
           */
          const now = Date.now();
          const target = getActionTarget();
          const motionPriority = target === null ? 0 : target.currentMotionPriority();
          const speechBusy = getSpeechLane().busy() || getSpeechPlayer().state.speaking;
          /*
           * 刚念完最后一句也算「有活动」。
           *
           * 不补这一下的话：那句念了 40 秒的长文本一结束，「距上次指令」早就
           * 超过 20 秒 ⇒ 她**立刻**换个姿势，看起来像是「一说完就急着摆造型」。
           * 补上之后，待机的 20 秒从「嘴停下来」重新起算。
           */
          if (speechWasBusy && !speechBusy) {
            lastActivityAt = Date.now();
          }
          speechWasBusy = speechBusy;
          if (
            shouldAutoIdle(
              lastActivityAt,
              lastAutoIdleAt,
              now,
              motionPriority,
              IDLE_AFTER_MS,
              speechBusy,
              idleHoldMs,
            )
          ) {
            if (target !== null) {
              const group = pickIdleGroup(target.motionGroupNames());
              if (group !== '') {
                /*
                 * ★ 换待机之前先收尸 —— 见 `isOwnIdleMotion()` 的注释。
                 *
                 * 【2026-02 更正】这段注释以前写着「队列每 20 秒长一条、只进不出，
                 * 这是无界增长」。**那句话是错的，已经实测证伪**：`startMotion()`
                 * 会把队列里每一条都标上淡出（`cubismmotionqueuemanager.ts:68-75`），
                 * `doUpdateMotion()` 把淡出变成真正的结束时刻（`:280-284`），
                 * `updateParameters()` 过了那个时刻就置 `_finished`（`acubismmotion.ts:83-88`），
                 * 而 `doUpdateMotion()` 会 splice 掉已结束的条目（`:274-277`）。
                 * 所以上一条循环动作最多多活一个淡出时长（默认 0.3 秒），不是永远。
                 * 按 5 Hz 模拟 10 / 30 / **240** 分钟，队列深度始终是 1（峰值 2）。
                 *
                 * 也就是说：**这条路径不是「跑一段时间突然卡住」的原因，别再顺着它查。**
                 * 真正该在这儿防的是另一件事 —— `stopAllMotions()` 只删得掉隔一条
                 * （`:152-170` 的 `splice(i, 1); continue;`），留下一条活的循环动作
                 * 会让 `currentMotionPriority()` 永远回不到 `IDLE`，待机就再也不换了。
                 * 那个缺陷修在 `pet-model.ts` 的 `stopMotion()` 里（循环抽干队列）。
                 *
                 * 只在优先级是自己那一档时才动手：`2` / `3` 是 AI 要的动作，
                 * 停它就是「待机盖掉正经动作」，那是 §4.2.12 明令禁止的。
                 */
                if (isOwnIdleMotion(motionPriority)) {
                  target.stopMotion();
                }
                /*
                 * `priority: IDLE`(1) 这个数字**不是**用来「压住谁」的（它压不住任何
                 * 东西，框架不比较优先级）—— 它是写给**下一轮待机自己**看的记号：
                 * `currentMotionPriority()` 读回来的 `1` 表示「现在播的是我的待机动作，
                 * 可以换一个了」，而 `2` / `3` 表示「这是 AI 要的动作，别动它」。
                 * `loop: true` 让它一直循环到被打断为止。
                 */
                busyStep = `播待机动作 ${group}`;
                const idleResult = await target.playMotion(group, undefined, {
                  loop: true,
                  priority: FRAMEWORK_PRIORITY.IDLE,
                  avoidIndex: lastIdleIndex,
                });
                if (stale()) return;
                if (!idleResult.ok) {
                  reportFailure(`idle-${idleResult.code}`, new Error(idleResult.detail));
                } else {
                  /*
                   * ★ 记住「这次演的是第几号」与「它有多长」（§13.31）。
                   *
                   * 两个数都来自渲染端（`MotionTargetResult`）。老 bundle 不带
                   * 它们时：`lastIdleIndex` 保持原值（不避开任何一条，等价于旧
                   * 行为），`idleHoldMs` 退回 12 秒（`idleHoldMsFor(undefined)`），
                   * 也就是「不知道多长就别频繁换」。
                   */
                  if (typeof idleResult.motionIndex === 'number') {
                    lastIdleIndex = idleResult.motionIndex;
                  }
                  idleHoldMs = idleHoldMsFor(idleResult.motionDurationMs);
                }
              }
            }
            // 无论有没有播成，都要推进这个时钟 —— 否则模型没有动作组时会每 1.2 秒试一次。
            lastAutoIdleAt = now;
          }
        } catch (err) {
          reportFailure('speech-poll', err);
        } finally {
          busy = false;
        }
      };

      /*
       * ★ 自适应轮询间隔：说话时问得勤，闲着时问得懒。
       *
       * 固定 1.2 秒的代价落在「打断」上：AI 说 `live2d_stop_speaking` 时，
       * 指令最多要等一整轮才被取走，而 §4.1 要求「立即生效」、§6.1 #6 要求
       * 「100ms 内口型归零、音频静音」。说话期间改成 200ms，把这条延迟压到
       * 人耳听不出来的量级；闲着时仍然是 1.2 秒 —— 本地 GET 的流量可以忽略，
       * 但没必要时时刻刻问。
       *
       * 用自重排的 `setTimeout` 而不是 `setInterval`：间隔要每次重新算。
       */
      let timer = 0;
      const scheduleNext = (): void => {
        if (cancelled) return;
        const speech = getSpeechPlayer();
        const busyNow = getSpeechLane().busy() || speech.state.speaking;
        timer = setTimeout(() => {
          void tick().then(scheduleNext, scheduleNext);
        }, busyNow ? SPEECH_POLL_BUSY_MS : SPEECH_POLL_MS);
      };
      void tick().then(scheduleNext, scheduleNext);

      /*
       * ★ 命令通道的看门狗：抓「`busy` 卡在 true 上回不来了」。
       *
       * 为什么它必须存在，而不是靠 `busy` 上的超时 —— 因为那种卡死**每一条
       * 外部信号都是正常的**：`/status` 心跳由另一个 effect 写、fps 由渲染循环
       * 写、模型照旧呼吸（`update()` 与指令无关），只有指令通道死了。用户看到
       * 的是「她不动了」，而所有仪表都指着「一切正常」。
       *
       * 阈值 20 秒的依据：一轮 tick 正常在几十毫秒内结束，最慢的一步是
       * `playMotion()` 首次下载动作文件（本地、毫秒级），而它自己的 `fetch`
       * 已经有 `ASSET_FETCH_TIMEOUT_MS = 15` 秒的硬上限。所以「20 秒还在忙」
       * 只可能意味着某个 `await` 绕过了那道上限 —— 那正是要抓的东西。
       *
       * 抓到之后**强行解锁**（`busy = false` + 自增世代号）而不是只报个警：
       * 只报警的话，用户还得刷新页面才能用，而这一整轮的教训恰恰是「她不动了
       * 却没人能说清为什么」。解锁不会让同一批指令被执行两遍 —— 卡住的那一轮
       * 醒来后在下一个检查点就会发现自己的世代号过期了。
       */
      const TICK_STALL_MS = 20000;
      const tickWatchdog = setInterval(() => {
        if (cancelled || !busy || busyReported) return;
        const stuckFor = Date.now() - busySince;
        if (stuckFor < TICK_STALL_MS) return;
        busyReported = true;
        reportFailure(
          'tick-stall',
          new Error(
            `指令通道已 ${Math.round(stuckFor / 1000)} 秒没有完成一轮（卡在：${busyStep}）。`
            + ` 心跳与 fps 都是别的代码写的，所以它们正常**不代表**通道活着。`
            + ` 已强行解锁，下一步会自动重试。`,
          ),
        );
        tickGen += 1;
        busy = false;
      }, TICK_STALL_MS);

      return () => {
        cancelled = true;
        clearTimeout(timer);
        clearInterval(tickWatchdog);
      };
    }, []);

    return snapshot;
  }

  function describeSpeech(speech: SpeechPlayerState): string {
    return describeSpeechState(speech);
  }

  /**
   * 渲染宿主：**一个 canvas 一个**，跨模型切换而存在。
   *
   * 为什么要有这个东西 —— 它修的是「切换无白屏」这条验收背后的真 bug。
   * 原来的写法把「取 WebGL、加载 Core、编译 shader、加载模型、跑 RAF」全部塞进
   * 一个依赖 `modelPath` 的 effect 里，于是**换一个模型 = 把整套东西拆掉重建**：
   * 旧模型立刻 `release()`（画布空了），然后重新 `loadCubismCore()`、
   * 重新 `ensureFramework()`、重新下载 moc3 与全部纹理。用户看到的是
   * 舞台空白几百毫秒到几秒，模型越复杂越久 —— 而这正是方案 §6.1 #3
   * 「热切换 ≤ 800ms、无白屏、无旧模型残留像素」要防的那件事。
   *
   * 新结构对应 §4.3 的 `prepare` / `activate` 契约：
   * - `prepare`：把新模型**完整加载好**（moc3 + 纹理 + 物理），全程不碰当前模型；
   * - `activate`：一帧之内换掉引用，旧模型此时才 `release()`。
   * 加载期间旧模型照常渲染并照常对口型，所以「切换中」不是空白，而是
   * 「上一只还在，角标写着正在换」。
   */
  interface RenderHost {
    canvas: HTMLCanvasElement;
    gl: WebGL2RenderingContext | WebGLRenderingContext;
    coreVersion: string;
    /** 当前正在渲染的模型。`null` = 还没有任何模型加载成功。 */
    current: PetModel | null;
    /** 这一个 canvas 上跑着的那个 RAF 句柄。 */
    raf: number;
    /**
     * 上一次**真的画了**的帧时间戳（`0` = 还一帧都没画过）。
     *
     * 它有两个身份，而这两个身份必须是同一个：`dt` 的来源，与帧率上限的判据。
     * 被 `shouldDrawFrame()` 判掉的帧**不更新它** —— 否则降帧之后
     * `dt` 只覆盖一个 rAF 间隔，动作会以一半速度播放（「上限生效了，
     * 但她变成了慢动作」，比不生效更难查）。
     */
    last: number;
    /**
     * **这半秒窗口内**画了几帧。每 500ms 被清一次（见 `frame()` 里那个窗口）。
     *
     * ★ 它**不能**回答「渲染循环还活着吗」：健康的时候它也会是 0 ——
     * 每 500ms 归零，而读它的人（心跳、`/status`、AI）落在窗口的哪个相位
     * 完全看运气。实测：一个**正常**的桌宠被每 5 秒采样一次，读出来的是
     * 25 → 20 → 16 → 8 → 0 → 25 这样的锯齿 —— 那个 0 与「冻住」一模一样。
     * 要判断存活，用 `drawnTotal`（单调）或 `liveAttempts`（采样块跑过几次），
     * 不要用这个。它只该用来算 fps。
     */
    frames: number;
    /**
     * 从挂载到现在**一共**画了多少帧。只增不减（`frames` 会周期性清）。
     *
     * ★ 这是给「冻住了吗」用的那一个。`frames` 那个 0 是有歧义的：
     * 读一次得到 0，既可能是「一帧都没画」，也可能只是**恰好落在窗口开头**。
     * 实测的健康桌宠被每 5 秒采样时，读到的锯齿里就有 0、而且连续两次是 0
     * （2026-02，`work/watch-cadence.mjs`）—— 所以单次读数拿它当存活判据会误判。
     * 单调计数没有这个歧义：0 只可能是「从挂载到现在一帧都没画」，而这正是
     * `frame-nostart` 那条护栏要抓的状态。真正冻住时我们连读到 40 个 0
     * （200 秒），那是靠「持续」而不是「单次」得出的结论 —— 有了这个数就不必了。
     */
    drawnTotal: number;
    windowStart: number;
    disposed: boolean;
    /**
     * 画面上**确实**是这条路径的模型。
     *
     * 不能用 `current !== null` 代替：加载失败时 `current` 停在**旧**模型上
     * （那是 §6.1 #2「切到坏包不影响当前模型」的实现方式），此时照一张相
     * 会把旧模型的图存成新模型的缩略图 —— 一张**错的**图比没有图更糟。
     * 只在 `activate` 成功那一行赋值，失败路径一个字节都不动。
     */
    renderedPath: string | null;
    /**
     * 已经为哪个指纹拍过了。
     *
     * 用指纹而不是布尔量：模型文件被换掉之后指纹会变，那时要能重拍一张。
     * 用布尔量的话得在「想拍的指纹变了」时手动清零，而那个清零点散在
     * 组件外，迟早会漏。
     */
    thumbDoneFor: string | null;
    /** 下一次允许尝试抓图的时间戳。抓不到（模型还没画上去）时不能每帧都 `getImageData()`。 */
    thumbRetryAt: number;
    /** 抓图用的两块离屏画布，第一次抓时创建，之后复用。 */
    thumbProbe: HTMLCanvasElement | null;
    thumbOut: HTMLCanvasElement | null;
    /**
     * 已经为哪个**模型路径**量过自动居中了。
     *
     * 键用模型路径而不是缩略图指纹：指纹是「文件内容变了没有」，而这里关心的是
     * 「画面上现在是哪一只」。两者都要能各自独立地决定「要不要重来一次」。
     *
     * ★ 量过就不再量，这一条是**正确性必需**而不是省事：居中会改变画出来的
     * 位置，位置一变墨迹包围盒就变，于是「量 → 挪 → 再量」会互相追着跑。
     */
    inkDoneFor: string | null;
    /** 下一次允许尝试量居中的时间戳。量不到（模型还没画上去）时不能每帧 `getImageData()`。 */
    inkRetryAt: number;
    /** 量居中用的离屏画布，第一次量时创建。与缩略图那块**分开**：两者时机不同。 */
    inkProbe: HTMLCanvasElement | null;
    /**
     * ★ 「画面到底还在不在变」的探针（见 `frame-frozen` 那段注释）。
     *
     * 这是本项目里**唯一**一个不依赖任何假设的存活判据：不看 fps、不看
     * `clientErrors`、不看命令通道，直接比较**画布像素**。- 前两条护栏
     * （帧循环 try/catch、停摆看门狗）守的都是「有没有走到 `draw()`」，
     * 而 2026-06 那次「卡了」的现场是：**每一帧都走到了 `draw()`，命令通道
     * 活着、语音听得到、`clientErrors` 一条都没有，而画布是一张静止的照片**
     * （不眨眼、表情不生效）。也就是说「在画」与「画出来了」是两件事，
     * 只有比像素能分辨。
     */
    liveProbe: HTMLCanvasElement | null;
    /** 上一次采样得到的画面哈希。`-1` = 还没采过。 */
    liveHash: number;
    /** 画面连续多少次采样与上一次**逐字节相同**。任何一次不同就归零。 */
    liveSameStreak: number;
    /** 上一次采样的时间戳（墙上时钟）。 */
    liveSampledAt: number;
    /** 上一次上报「画面冻住了」的时间戳，用来限流。 */
    liveReportedAt: number;
    /** 累计采样了多少次。用来做一次开机自证（见 `LIVE_SELF_TEST_SAMPLES`）。 */
    liveSamples: number;
    /** 连续多少次采样「读不到像素」（`frameHashOf()` 返回 `-1`）。见 `liveBlindReported`。 */
    liveBlindStreak: number;
    /** 探针瞎掉这条最多报一次。瞎着的探针报多少次都是同一句话。 */
    liveBlindReported: boolean;
    /**
     * 采样块**被执行**过多少次（不管读没读到像素）。
     *
     * 与 `liveSamples` 的区别是关键的：模型还在加载、画布全透明时，
     * `frameHashOf()` 返回 `-1`，`liveSamples` **不涨**，但这里涨。
     * 所以 `liveAttempts === 0` 是一条毫不含糊的结论：采样块一次都没跑到 ——
     * 不是「加载慢」，不是「读不到像素」，是**根本没有帧**。
     */
    liveAttempts: number;
    /** 「采样块一次都没跑到」这条最多报一次。 */
    liveStartReported: boolean;
    /** `document.hidden` 从哪一刻起为真。`0` = 此刻可见。 */
    liveHiddenSince: number;
    /** 「窗口被判成隐藏」这条最多报一次。 */
    liveHiddenReported: boolean;
    /**
     * ★ 正在跑的参数实测任务（§13.34）。`null` = 没在跑。
     *
     * 放这里而不是 `PetModel` 里，是因为它要在 `draw()` 之后读画布 —— 那一段
     * 只有帧循环有。`doneFor` 记「哪个模型路径已经量过」，与缩略图/居中那两套
     * 同一个做法：用路径当键，换模型自然重来。
     */
    bindProbe: BindingProbeJob | null;
    bindDoneFor: string | null;
    /** 采样用的离屏画布，第一次用时创建。与缩略图、居中两块**分开**。 */
    bindProbeCanvas: HTMLCanvasElement | null;
  }

  /** 客户端想让舞台为哪个指纹拍一张缩略图。`fingerprint` 就是 `thumbnail.ts` 的那套。 */
  interface ThumbWant {
    id: string;
    fingerprint: string;
  }

  /**
   * 抓图失败后隔多久再试。
   *
   * 模型刚 `activate` 时可能还没画上去（淡入的第一帧 alpha 还是 0），
   * 那时 `bboxOfAlpha()` 返回 `null`。不像这样限一下，就会变成「每帧一次
   * `getImageData` 直到模型出现」—— 一次 192px 的读取不贵，但每帧一次是白烧电。
   */
  const THUMB_RETRY_MS = 250;

  /**
   * 从主画布抓一帧，裁到模型本体，缩成一张小图。
   *
   * ⚠️ 必须在**同一个 rAF 回调内、紧跟 `draw()` 之后**调用。GL 上下文是
   * `preserveDrawingBuffer: false`（默认值），一旦离开这一帧，绘制缓冲就被清空了，
   * `drawImage()` 拿到的是一片透明 —— 症状是「缩略图永远存不下来」，
   * 而它看起来像「模型没渲染」，很容易往错的方向查。
   *
   * 返回 `null` 表示「这一次拍不成」：还没画上去、画布尺寸不对、拿不到 2D 上下文。
   * 调用方据此决定要不要过一会儿再试。**本函数绝不抛** —— 缩略图是装饰品，
   * 为一个装饰品让整个面板白屏是不可接受的（§9.2）。
   */
  function captureThumbnail(source: HTMLCanvasElement, probe: HTMLCanvasElement, out: HTMLCanvasElement): string | null {
    try {
      const sw = source.width;
      const sh = source.height;
      if (sw <= 0 || sh <= 0) return null;

      // ① 先缩到 192 再找包围盒：直接缩到 96 会让包围盒边缘的精度掉到几个像素，
      //    裁出来缺手缺脚。这一步要读像素，所以不能更大。
      const probeSize = fitInto(sw, sh, PROBE_MAX_SIDE);
      if (probe.width !== probeSize.width || probe.height !== probeSize.height) {
        probe.width = probeSize.width;
        probe.height = probeSize.height;
      }
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      if (pctx === null) return null;
      pctx.clearRect(0, 0, probe.width, probe.height);
      pctx.drawImage(source, 0, 0, sw, sh, 0, 0, probe.width, probe.height);

      // ② 全透明 → 这一帧模型还没画上去。返回 null，过 250ms 再试。
      const box = bboxOfAlpha(pctx.getImageData(0, 0, probe.width, probe.height).data, probe.width, probe.height);
      if (box === null) return null;

      // ③ 按包围盒裁出来，缩到长边 ≤96。
      const size = fitInto(box.width, box.height, MAX_THUMB_SIDE);
      if (out.width !== size.width || out.height !== size.height) {
        out.width = size.width;
        out.height = size.height;
      }
      const octx = out.getContext('2d');
      if (octx === null) return null;
      octx.clearRect(0, 0, out.width, out.height);
      octx.drawImage(probe, box.x, box.y, box.width, box.height, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    } catch (err) {
      // 拿不到上下文、画布被别处改成 0 尺寸、`toDataURL` 抛 IndexSizeError ——
      // 都只意味着「这次没拍成」。
      reportFailure('thumb-capture', err);
      return null;
    }
  }

  /**
   * 量一次「本体实际画在了视口的哪儿」，返回它中心的 NDC 横坐标。
   *
   * 返回 `null` = 这一次量不成（还没画上去 / 画布尺寸不对 / 拿不到 2D 上下文），
   * 调用方过一会儿再试。**本函数绝不抛** —— 和 `captureThumbnail()` 同一条
   * 理由：量不到就只是「这一帧没居中」，不该让面板白屏（§9.2）。
   *
   * ── 为什么量像素而不是顶点包围盒 ────────────────────────────────────────
   * 顶点里混着大量 `opacity <= 0` 的绘制对象（miku 440 个里 166 个是 0），
   * 而且顶点包围盒包含画布外的几何。用户眼睛看到的是**画出来的那一块**，
   * 所以量像素才是量到点子上，而且它对任何模型都自动成立、不需要参数表。
   *
   * ⚠️ 必须紧跟 `draw()`、在同一个 rAF 回调里调。GL 上下文是
   * `preserveDrawingBuffer: false`，出了这一帧绘制缓冲就被清空，
   * `drawImage()` 拿到的是一片透明 → `bboxOfAlpha()` 返回 `null`，
   * 症状是「自动居中永远不生效」，看起来却像「这个模型不需要居中」。
   *
   * `pad` 传 `0`（默认的 `BBOX_PAD` 会把边界往外扩，中心反而被推歪）。
   */
  function measureInkCenterX(source: HTMLCanvasElement, probe: HTMLCanvasElement): number | null {
    try {
      const sw = source.width;
      const sh = source.height;
      if (sw <= 0 || sh <= 0) return null;

      const probeSize = fitInto(sw, sh, PROBE_MAX_SIDE);
      if (probe.width !== probeSize.width || probe.height !== probeSize.height) {
        probe.width = probeSize.width;
        probe.height = probeSize.height;
      }
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      if (pctx === null) return null;
      pctx.clearRect(0, 0, probe.width, probe.height);
      pctx.drawImage(source, 0, 0, sw, sh, 0, 0, probe.width, probe.height);

      const box = bboxOfAlpha(
        pctx.getImageData(0, 0, probe.width, probe.height).data,
        probe.width,
        probe.height,
        undefined,
        0,
      );
      /*
       * `pad` 传 `0`：默认的 `BBOX_PAD` 会把边界往外扩，中心反而被推歪。
       * 换算本身住在 `thumbnail.ts` 的 `inkCenterNdc()` 里 —— 它要跨两个坐标系
       * （采样画布 192px / 真实画布），是一个只会「看着还差一点」而不会报错的
       * 计算，所以它必须能被门禁直接喂数字。
       */
      return inkCenterNdc(box, probe.width, sw);
    } catch (err) {
      reportFailure('ink-center', err);
      return null;
    }
  }

  /**
   * 画面活性探针的采样边长（正方形）。
   *
   * 24 足够分辨「同一张静态图」与「有人物在呼吸」：桌宠本体在这个尺寸下仍占
   * 十几个像素，而任何一次眨眼、呼吸、口型都会改动其中若干像素。再大只是白烧 CPU。
   */
  const LIVE_PROBE_SIDE = 24;

  /** 两次采样之间至少隔多久（毫秒）。 */
  const LIVE_SAMPLE_MS = 3000;

  /** 连续多少次采样「逐字节相同」才开始上报。5 次 ≈ 15 秒。 */
  const LIVE_STUCK_SAMPLES = 5;

  /** 连续多少次相同就认为救不回来、直接重建渲染宿主。10 次 ≈ 30 秒。 */
  const LIVE_REBUILD_SAMPLES = 10;

  /** 同一条「画面冻住了」最多多久报一次。5 分钟。 */
  const LIVE_REPORT_MS = 300000;

  /**
   * 开机自证：采到第几次时，主动报一条「探针在跑、而且画面确实在变」。
   *
   * 为什么需要它：探针**只在故障时说话**，所以 `clientErrors` 为空有两种含义 ——
   * 「没冻住」与「探针压根没接上线」，而这两者在 `/status` 上长得一模一样。
   * 2026-06 用户问「有记录吗」时我就卡在这里：只能靠人去翻 `lib/client.js` 里
   * 有没有那几个字符串，那不算证据，因为**包里有不等于跑起来了**。
   *
   * 所以采满 5 次（≈12 秒，此时模型已经渲染、`liveSameStreak` 已经能反映
   * 「画面是不是在动」）就报一条 `frame-live`。它不是故障 —— 消息里第一句就写明
   * 了这一点。代价是 `clientErrors` 里多一条，用 sessionStorage 保证**一个标签页
   * 只报一次**（`clientErrors` 只留最后 20 条，不能让自证把真故障挤掉）。
   */
  const LIVE_SELF_TEST_SAMPLES = 5;

  /**
   * 连续多少次「读不到像素」就上报一次 —— 那时探针是瞎的，它的沉默毫无意义。
   */
  const LIVE_BLIND_SAMPLES = 5;

  /** 窗口被判定为隐藏多久之后上报一次（毫秒）。见 `frame-hidden` 那段注释。 */
  const LIVE_HIDDEN_REPORT_MS = 20000;

  /**
   * 从渲染宿主建好算起，多久之后检查「采样块到底跑过没有」（毫秒）。
   *
   * ★ 这条护栏守的是**四条已有护栏一个都够不着**的那个状态。
   *
   * 已有四条（帧 try/catch、停摆看门狗、`frame-blind`、`frame-frozen`）全都
   * 住在 `drawFrame` 里面，或者以「已经画过帧」为前提。于是「帧循环不再被调度」
   * —— rAF 被暂停、effect 已经 disposed、采样块因为某个早退分支永远到不了 ——
   * 这个状态下它们**没有发言的机会**：没有任何一帧，也就没有任何一次采样，
   * 于是 `clientErrors` 干干净净，而 `fps` 标签停在最后一次算出来的数上（看起来
   * 完全正常）。2026-06 用户报的那次卡死就是这个形状：**画面冻住 + fps 还显示 60 +
   * 一条记录都没有**。三条护栏里最贵的一课由此而来：一条只在出事时才说话的护栏，
   * 无法把自己的「沉默」与「正常」区分开。
   *
   * 所以这里放一条**不依赖任何一帧**的护栏：25 秒之后 `host.liveAttempts` 还是 0，
   * 就报 `frame-nostart`。25 秒这个数是这么定的 —— 采样块每 `LIVE_SAMPLE_MS`(3秒)
   * 就会跑一次，只要有一帧，`liveAttempts` 立刻从 0 变 1；留 8 倍的余量是为了
   * 绝不冤枉「模型正在加载」。
   */
  const LIVE_START_MS = 25000;

  /**
   * `frameHashOf()` 的失败原因。
   *
   * ★ 为什么要把「-1」拆成一个原因字符串：探针**只在冻住时说话**，所以它自己瞎掉
   * 与「一切正常」在 `/status` 上长得一模一样。2026-06 现场就是如此 ——
   * 桌宠冻着，而 `clientErrors` 一条都没有。事后排查只能靠猜：
   * 是采样没跑到（`model === null`）？窗口被判成隐藏？还是 `drawImage` 读出来全透明？
   * 这三种「探针沉默」的成因，后果完全不同，却都表现为「没有记录」。
   * 所以每一个 `return -1` 的分支都要留下它是哪一支。
   */
  interface ProbeDiag {
    why: string;
    sw: number;
    sh: number;
    opaque: number;
  }

  /**
   * 把当前这一帧缩成一张小图，返回它的哈希；拿不到像素时返回 `-1`。
   *
   * ⚠️ 与 `captureThumbnail()` / `measureInkCenterX()` 同一条规矩：必须在
   * **同一个 rAF 回调内、紧跟 `draw()` 之后**调。GL 上下文是
   * `preserveDrawingBuffer: false`，出了这一帧绘制缓冲就被清空，
   * `drawImage()` 只会拿到一片透明 —— 那时哈希恒定不变，**看起来就像画面冻住了**，
   * 于是这个探针会把自己没接对线误报成故障。
   *
   * 失败**不上报**：它每 3 秒跑一次，任何一次失败都会变成 20 条一模一样的记录
   * 把 `clientErrors` 淹掉。返回 `-1`，调用点把 `-1` 当「这次不知道」处理，
   * 既不算「变了」也不算「没变」。
   *
   * 用 32 位 FNV-1a 而不是逐字节比较：探针图只有 24×24×4 = 2304 字节，
   * 但每 3 秒留一份副本等于给渲染循环挂上一块常驻内存，而哈希只是一个数。
   * 碰撞概率（2304 字节里恰好哈希相同）在「她本来就在动」这个前提下可以忽略；
   * 即使真撞上，代价也只是把一次「还在动」记成「没动」，而它要**连续 5 次**
   * 才会上报。
   */
  function frameHashOf(source: HTMLCanvasElement, probe: HTMLCanvasElement, diag: ProbeDiag): number {
    diag.why = '';
    diag.opaque = -1;
    diag.sw = source.width;
    diag.sh = source.height;
    try {
      const sw = source.width;
      const sh = source.height;
      if (sw <= 0 || sh <= 0) {
        diag.why = '画布尺寸为 0';
        return -1;
      }
      if (probe.width !== LIVE_PROBE_SIDE || probe.height !== LIVE_PROBE_SIDE) {
        probe.width = LIVE_PROBE_SIDE;
        probe.height = LIVE_PROBE_SIDE;
      }
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      if (pctx === null) {
        diag.why = '取不到 2D 上下文';
        return -1;
      }
      pctx.clearRect(0, 0, LIVE_PROBE_SIDE, LIVE_PROBE_SIDE);
      pctx.drawImage(source, 0, 0, sw, sh, 0, 0, LIVE_PROBE_SIDE, LIVE_PROBE_SIDE);
      const data = pctx.getImageData(0, 0, LIVE_PROBE_SIDE, LIVE_PROBE_SIDE).data;
      /*
       * 全透明一律当「这次不知道」。
       *
       * 不加这一条会造出一个自我实现的死循环：模型正在加载时画布是空的，空画面
       * 的哈希恒定不变 → 连续相同 → 判成「冻住」→ 重建 → 又回到加载 → 又判「冻住」。
       * 也就是说这个探针会把「正常加载」误判成故障，并且永远出不来了。
       */
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) opaque += data[i];
      diag.opaque = opaque;
      if (opaque === 0) {
        diag.why = '采到的 24×24 全透明（alpha 总和为 0）—— 画布上这一帧没有画出任何东西';
        return -1;
      }
      let hash = 2166136261;
      for (let i = 0; i < data.length; i += 1) {
        hash ^= data[i];
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    } catch (err) {
      diag.why = `读像素时抛了异常：${err instanceof Error ? err.message : String(err)}`;
      return -1;
    }
  }

  /** 读一张存着的缩略图。localStorage 在隐私模式下会抛，所以整段包起来。 */
  function readStoredThumb(id: string): StoredThumb | null {
    try {
      return parseStored(localStorage.getItem(thumbnailKey(id)));
    } catch {
      return null;
    }
  }

  /**
   * 把新拍的这张写进去，顺手清掉坏数据与超出上限的旧图。
   *
   * 清坏数据：`parseStored()` 返回 `null` 的那些键永远读不出来，留着只是占配额。
   * 清超限：一张 96px PNG 的 data URL 约 3–8KB，localStorage 一般只有 5MB；
   * 不设上限的话模型多的用户会先撞上 `QuotaExceededError`，而那时的表现是
   * 「缩略图突然不存了」，很难往「存太多了」上想。
   */
  function writeStoredThumb(thumb: StoredThumb): void {
    try {
      localStorage.setItem(thumbnailKey(thumb.id), serializeThumb(thumb));
    } catch {
      // 配额爆了 / 隐私模式。缩略图是装饰品，存不下就算了，**绝不往上抛**。
      return;
    }
    try {
      const alive: StoredThumb[] = [];
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key === null || !key.startsWith(THUMB_PREFIX)) continue;
        const parsed = parseStored(localStorage.getItem(key));
        if (parsed === null) doomed.push(key);
        else alive.push(parsed);
      }
      for (const old of pickEvictions(alive)) doomed.push(thumbnailKey(old.id));
      for (const key of doomed) localStorage.removeItem(key);
    } catch {
      /* 清扫失败不影响这次写入已经成功这件事。 */
    }
  }

  /**
   * 把字幕画到三个 span 上（前段 / 当前词 / 后段）。
   *
   * 刻意不走 React state：当前词每几十毫秒换一个，走 state 等于每十几帧重渲染整张
   * 卡片（含模型下拉框和输入框）。这里只改文字，而且**记住上次画的是什么**，
   * 同一个词重复画几十帧不会产生任何 DOM 写入。
   *
   * 三个 span 由 React 建出来、之后不再管；React 的 props 里没有它们的 children，
   * 所以重渲染不会把我们写进去的文字冲掉。
   */
  function paintSubtitle(node: HTMLDivElement | null, view: SubtitleView): void {
    if (node === null) return;
    if (!view.visible) {
      if (node.style.display !== 'none') node.style.display = 'none';
      return;
    }
    if (node.style.display === 'none') node.style.display = '';

    const pre = node.children[0];
    const word = node.children[1];
    const post = node.children[2];
    if (pre === undefined || word === undefined || post === undefined) return;

    const head = view.highlightFrom >= 0 ? view.text.slice(0, view.highlightFrom) : view.text;
    const mid = view.highlightFrom >= 0 ? view.text.slice(view.highlightFrom, view.highlightTo) : '';
    const tail = view.highlightFrom >= 0 ? view.text.slice(view.highlightTo) : '';

    if (pre.textContent !== head) pre.textContent = head;
    if (word.textContent !== mid) word.textContent = mid;
    if (post.textContent !== tail) post.textContent = tail;
  }

  /**
   * 读舞台视图（缩放 / 平移）。
   *
   * 包一层 try 是因为 `localStorage` 在某些上下文里会**取属性就抛**
   * （隐私模式、被禁用的存储）；那条路径不该让模型消失 —— 丢掉一个缩放倍数
   * 不配让桌宠不出现。
   */
  function readStageView(): StageView {
    try {
      return parseStageView(localStorage.getItem(STAGE_VIEW_STORAGE_KEY));
    } catch {
      return defaultStageView();
    }
  }

  /** 写舞台视图。写不进就算了，不影响这一次的拖动/缩放。 */
  function writeStageView(view: StageView): void {
    try {
      localStorage.setItem(STAGE_VIEW_STORAGE_KEY, serializeStageView(view));
    } catch {
      /* 隐私模式：这次调好的视图刷新后不保留，仅此而已。 */
    }
  }

  function Live2DStage(props: {
    modelPath: string | null;
    lipGain: number;
    subtitles: boolean;
    /** 帧率上限（已由 `normalizeFps()` 夹过）。见 `frame-budget.ts`。 */
    maxFps: number;
    /** 要不要给当前这个模型拍一张缩略图；`null` = 已经有新鲜的了，不用拍。 */
    thumbWant: ThumbWant | null;
    /** 拍好了。存储由外面负责 —— 这里只管像素。 */
    onThumb: (want: ThumbWant, dataUrl: string) => void;
  }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const subtitleRef = useRef<HTMLDivElement | null>(null);
    const hostRef = useRef<{ host: RenderHost | null; ready: Promise<RenderHost> | null }>({ host: null, ready: null });
    const switchToken = useRef(0);
    /*
     * ★ 舞台视图（用户第 4、5 条要求：鼠标调模型的大小与位置，而模型照常在动）。
     *
     * 走 ref 而不是 state：拖动时这个值每帧都变，走 state 等于每帧重渲染整张卡片。
     * 更要紧的是它**不能**进启动 effect 的依赖数组 —— 那会把模型、纹理、动作状态
     * 全部推倒重来，正好违反「调大小位置时动作不许重置」。帧循环每帧现读它，
     * 套到最终投影上（`PetModel.setStageView()`），`update()` 完全不知道这回事。
     */
    const stageBoxRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<StageView>(readStageView());
    const panRef = useRef<{ pointerId: number; startX: number; startY: number; base: StageView; moved: boolean } | null>(null);
    const viewSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastTapAt = useRef(0);

    /** 拖动/滚轮停下之后才落盘：过程中每帧写 `localStorage` 是纯浪费。 */
    const saveViewSoon = (): void => {
      if (viewSaveTimer.current !== null) {
        clearTimeout(viewSaveTimer.current);
      }
      viewSaveTimer.current = setTimeout(() => {
        viewSaveTimer.current = null;
        writeStageView(viewRef.current);
      }, 300);
    };

    /*
     * 「视图偏离默认了没有」—— 舞台角上那个「重置」按钮的可用状态。
     *
     * **只在这一条翻转时才 setState**（默认 ↔ 非默认），不是拖动中每帧都推：
     * `onPanMove` 每帧都会改 `viewRef`，每帧 setState 等于拖动时每帧重渲染整张卡片 ——
     * 那正是这一段一开始把视图放进 ref 的原因。
     *
     * 状态住在这里而不是父组件：按钮画在舞台的右上角，属于舞台自己的角标。
     */
    const [viewMoved, setViewMoved] = useState<boolean>(() => !isDefaultStageView(viewRef.current));
    const lastDirty = useRef<boolean>(!isDefaultStageView(viewRef.current));
    const syncDirty = (): void => {
      const next = !isDefaultStageView(viewRef.current);
      if (next === lastDirty.current) return;
      lastDirty.current = next;
      setViewMoved(next);
    };
    /*
     * 挂载时再对齐一次：面板收起再打开时舞台会重新挂载，而视图是**持久化**的
     * （上次调到 2 倍、拖到边上）。不补推的话按钮会显示成「已经默认」，
     * 于是一个被推丢的模型看起来没有退路。
     */
    useEffect(() => {
      setViewMoved(!isDefaultStageView(viewRef.current));
    }, []);

    /** 恢复默认视图（缩放 1、正中）。双击舞台、舞台角上的「重置」按钮都走这里 ——
     *  这是「模型被推丢了」的退路，只留一个出口才不会两处行为不一致。 */
    const resetStageView = (): void => {
      viewRef.current = defaultStageView();
      saveViewSoon();
      syncDirty();
    };

    const beginPan = (event: PointerEventLike): void => {
      const box = stageBoxRef.current;
      if (box === null) return;
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        base: viewRef.current,
        moved: false,
      };
      // 捕获指针：手滑出舞台边缘时仍然收得到 pointermove，拖动才跟手。
      event.currentTarget?.setPointerCapture?.(event.pointerId);
      event.preventDefault?.();
    };

    const onPanMove = (event: PointerEventLike): void => {
      const pan = panRef.current;
      const box = stageBoxRef.current;
      if (pan === null || box === null || event.pointerId !== pan.pointerId) return;
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      // 3px 容差：手一抖就跳一格，会让「点一下模型」变成「不小心挪了一下」。
      if (!pan.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      pan.moved = true;
      const rect = box.getBoundingClientRect();
      // 位移换算成「舞台宽/高的小数」再交给纯逻辑 —— 像素值在窗口变形后就不对了。
      viewRef.current = panStageView(pan.base, dx / Math.max(1, rect.width), dy / Math.max(1, rect.height));
      syncDirty();
    };

    const endPan = (event: PointerEventLike): void => {
      const pan = panRef.current;
      if (pan === null) return;
      panRef.current = null;
      event.currentTarget?.releasePointerCapture?.(pan.pointerId);
      if (pan.moved) {
        saveViewSoon();
        return;
      }
      /*
       * 没挪动 = 一次点击。两次挨得够近就算双击 → 恢复默认视图。
       *
       * 不用 `onDoubleClick`：这里已经握着完整的指针序列，判定一次时间差就够了，
       * 也顺带对触屏的双击生效（React 的 dblclick 在触屏上不总是可靠）。
       */
      const now = Date.now();
      if (now - lastTapAt.current <= 320) {
        lastTapAt.current = 0;
        resetStageView();
      } else {
        lastTapAt.current = now;
      }
    };

    /*
     * 滚轮缩放。必须用**原生监听器**（`{ passive: false }`）：React 把 `onWheel`
     * 挂在根节点上且是 passive 的，`preventDefault()` 会被忽略 —— 于是滚轮既缩放
     * 又把整页滚走，看起来像「缩放时页面乱跳」。
     */
    useEffect(() => {
      const box = stageBoxRef.current;
      if (box === null) return undefined;
      const onWheel = (event: WheelEvent): void => {
        event.preventDefault();
        viewRef.current = zoomStageView(viewRef.current, wheelZoomFactor(event.deltaY));
        syncDirty();
        saveViewSoon();
      };
      box.addEventListener('wheel', onWheel, { passive: false });
      return () => {
        box.removeEventListener('wheel', onWheel);
        if (viewSaveTimer.current !== null) {
          clearTimeout(viewSaveTimer.current);
          viewSaveTimer.current = null;
        }
      };
    }, []);
    /*
     * 增益要能被**下一帧**读到，所以走 ref 而不是闭包。
     *
     * 启动 effect 的依赖数组是空的（一个 canvas 一辈子只跑一次），`frame()` 因此
     * 捕获不到后续的 props。用户拖滑块时不该重启渲染循环 —— 那会把模型、纹理、
     * 动作状态全部推倒重来；他想要的只是「嘴巴张得大一点」。
     */
    const gainRef = useRef(props.lipGain);
    gainRef.current = props.lipGain;
    const subtitlesRef = useRef(props.subtitles);
    subtitlesRef.current = props.subtitles;
    /*
     * 帧率上限同样走 ref，理由与增益一模一样：它是每 5 秒一次的 `/status`
     * 心跳带回来的，值变了不该重启渲染循环（那会把模型、纹理、动作状态
     * 全部推倒重来），只该让**下一帧**开始按新上限走。
     */
    const fpsRef = useRef(props.maxFps);
    fpsRef.current = props.maxFps;
    /*
     * 缩略图的「拍不拍」与「拍好了交给谁」也走 ref，理由同上：这两个值会随
     * 选中模型、`/models` 刷新而变，而 `frame()` 看不到后续的 props。
     * 重启渲染循环去读它们的代价是模型、纹理、动作状态全部推倒重来 ——
     * 为了一张 96px 的小图，不值。
     */
    const thumbWantRef = useRef(props.thumbWant);
    thumbWantRef.current = props.thumbWant;
    const onThumbRef = useRef(props.onThumb);
    onThumbRef.current = props.onThumb;
    const [phase, setPhase] = useState<string>('正在取 WebGL 上下文…');
    /*
     * 渲染宿主的「第几次启动」。平时恒为 0；只有 WebGL 上下文丢失时自增，
     * 让下面那个启动 effect 重跑（见 `onContextLost`）。
     */
    const [boot, setBoot] = useState(0);
    const [message, setMessage] = useState<string | null>(null);
    const [busy, setBusy] = useState<string>('');
    const [hasModel, setHasModel] = useState(false);
    const [stats, setStats] = useState<{
      fps: number;
      paused: boolean;
      size: string;
      params: number;
      core: string;
      /**
       * 当前情绪名（`''` = 没有情绪层）。
       *
       * 它必须在**面板上看得见**：情绪是 AI 打的标签，而标签的意义全在于可检查。
       * 一个只在她脸上、对话里和面板上都读不到的情绪层，和一个 bug 无法区分。
       */
      emotion: string;
      /**
       * 同一时刻的**数值**读数（§13.33 之后加）：`情绪 开心 0.37 · 余 开心 0.07 · 游移 ±1.44（7 根）`。
       *
       * 为什么不能只有 `emotion` 那一句：它只在两层同时在场时才带权重，于是
       * 「一层从 1.00 衰减到 0.37」在面板上一个字都不变 —— 用户据此无法判断
       * 指数尾有没有生效。数字必须出现在面板上，否则「改没改」只能靠感觉。
       */
      readout: string;
    } | null>(null);
    const modelPath = props.modelPath;

    /*
     * ★ fps 读数不许在「她其实停了」的时候替我们说一切正常。
     *
     * 页面被浏览器判成不可见（`document.hidden === true`：窗口被隐藏、最小化，
     * 或者被完全遮挡 —— Chromium 的原生遮挡判定把这两件事算成同一件）时，
     * rAF 会暂停：画面永久停在同一帧，而面板上那个 fps 数字**停在最后一次
     * 算出来的值上**（60）。于是「她冻住了」的现场里，唯一还在动的指示器
     * 正指着「一切正常」—— 2026-06 用户报的就是这个形状。
     *
     * 所以暂停时把它换成一句实话。判据用 `visibilitychange`：切换那一刻必然
     * 送达，不受「隐藏页定时器被降频到每分钟一次」的影响。另外在 fps 窗口
     * 结算处会再写一次 `paused: false` —— 能走到那里就证明页面正在被画，
     * 事件万一漏了也能自愈。
     */
    useEffect(() => {
      if (typeof document === 'undefined') return;
      const sync = (): void => {
        const hidden = document.hidden === true;
        setStats((prev) => (prev === null || prev.paused === hidden ? prev : { ...prev, paused: hidden }));
      };
      sync();
      document.addEventListener('visibilitychange', sync);
      return () => {
        document.removeEventListener('visibilitychange', sync);
      };
    }, []);

    // ① 启动 effect —— 依赖数组是空的，**一个 canvas 一辈子只跑一次**。
    useEffect(() => {
      const canvas = canvasRef.current;
      if (canvas === null) return;

      let cancelled = false;
      // 播放器是插件级单例，不是这个组件的一部分 —— 组件会随折叠/换模型重建，
      // 而正在说的那句话不应该被重建掐断。
      const speech = getSpeechPlayer();

      const gl = (canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true })
        ?? canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true })) as
        | WebGL2RenderingContext
        | WebGLRenderingContext
        | null;

      if (gl === null) {
        setPhase('');
        setMessage('E_WEBGL_UNAVAILABLE: 拿不到 WebGL 上下文');
        return;
      }

      /*
       * ★ WebGL 上下文丢失 —— 「她冻住了，但什么错都没有」最干净的一种解释。
       *
       * 上下文一丢，`gl.drawElements()` 等调用**静默变成空操作**：不抛异常、
       * 不返回错误、不影响 rAF，于是 fps 照算 60、`model.update()` 照跑、
       * 两条护栏（帧循环 try/catch 与停摆看门狗）**一条都不会响**，而画布
       * 永远停在被丢掉的最后一帧上。这恰好就是用户看到的全部症状。
       *
       * 之前客户端对这两个事件**零处理**（`grep webglcontext` 在全目录下没有
       * 命中）—— 丢了之后连一条记录都不留，这也是为什么上一轮的排查里
       * `clientErrors` 是空的。
       *
       * 恢复方式是**重建整个渲染宿主**：`preventDefault()` 之后浏览器有可能
       * 把上下文还回来，但 Cubism 那边的 GPU 资源（program / buffer / texture）
       * 已经被销毁了，框架没有「全部重建」的入口。把 `boot` 置回一个不同的值
       * 让启动 effect 重跑，是唯一能保证一致的做法 —— 代价是重下一遍纹理，
       * 而相比「永久冻住、还得用户手动刷新」，这个代价必须付。
       */
      const onContextLost = (event: Event): void => {
        event.preventDefault();
        reportFailure(
          'webgl-context-lost',
          new Error(
            'WebGL 上下文丢失，画面会停在最后一帧且不会有任何其他症状。'
            + ` 已尝试重建渲染宿主（maxFps=${String(fpsRef.current)}）。`,
          ),
        );
        setPhase('WebGL 上下文丢失，正在重建…');
        setBoot((n) => n + 1);
      };
      /*
       * 「上下文回来了」**不是**错误，所以走 `console.info` 而不是 `reportFailure` ——
       * `clientErrors` 是给「出事了」用的清单，往里面塞成功记录会让它变成一本
       * 谁都不看的流水账，真出事时那一条反而被淹掉。
       */
      const onContextRestored = (): void => {
        console.info('[dsh-live2d-pet] WebGL 上下文回来了（重建流程已在进行）');
      };
      canvas.addEventListener('webglcontextlost', onContextLost);
      canvas.addEventListener('webglcontextrestored', onContextRestored);

      const host: RenderHost = {
        canvas,
        gl,
        coreVersion: '',
        current: null,
        raf: 0,
        last: 0,
        frames: 0,
        drawnTotal: 0,
        windowStart: 0,
        disposed: false,
        renderedPath: null,
        thumbDoneFor: null,
        thumbRetryAt: 0,
        thumbProbe: null,
        thumbOut: null,
        inkDoneFor: null,
        inkRetryAt: 0,
        inkProbe: null,
        liveProbe: null,
        liveHash: -1,
        liveSameStreak: 0,
        liveSampledAt: 0,
        liveReportedAt: 0,
        liveSamples: 0,
        liveBlindStreak: 0,
        liveBlindReported: false,
        liveAttempts: 0,
        liveStartReported: false,
        liveHiddenSince: 0,
        liveHiddenReported: false,
        bindProbe: null,
        bindDoneFor: null,
        bindProbeCanvas: null,
      };

      /*
       * 开机自证只发一次，**每次加载页面算一次**。
       *
       * ★ 这里原来用的是 `sessionStorage`（「一个标签页只报一次」），那个设计造成了
       * 一次真实且昂贵的误判：Host 的 `clientErrors` 是**内存里**的，DSH 一重启
       * 就清空；而标签页里的 `sessionStorage` 不会。于是「自证发过了 → 重启把记录
       * 抹了 → 标签页没刷新 → 自证再也不会发」这条路上，我看到的 `clientErrors`
       * 是空的，而它与「探针压根没接线」在 `/status` 上**一模一样** ——
       * 我只能靠猜，并且猜错了两次。
       *
       * 结论：一个「可以被我看不见的陈旧标记永久压住」的诊断，比每次加载多一条
       * 日志坏得多。改成只认本进程内的这一个变量：刷新一次就自证一次，多出来的
       * 一条记录换来「沉默必定可解释」。
       */
      let liveSelfTestSent = false;

      /*
       * ★ 帧循环的三道护栏。它们不修任何东西，只负责让「她不动了」这件事
       * **留下证据**。
       *
       * 起因是一个真实故障（`miku` 跑一段时间后整体冻住，`空` 不会）：出问题时
       * 面板上的 fps 数字停在最后一帧、没有弹窗、一处日志都没有。
       * 上报落在 `GET /.dsh-live2d-pet/status` 的 `clientErrors` 里（最后 20 条）——
       * 那**不是**一条叫 `/errors` 的路由，本文件之前有两处注释把它写成了 `/errors`，
       * 那种「看着像真的」的注释比没有注释更坏（§8.11 的教训）。
       * 原因写在下面 `frame` 的注释里 —— rAF 回调里抛出的异常会被浏览器吞掉，
       * 而 `requestAnimationFrame` 已经在函数第一行重排了下一帧，于是循环
       * 「活着但每帧都炸」，画面永久停在最后一帧。看起来完全像卡死。
       */
      let frameErrors = 0;
      let lastFrameErrorAt = 0;
      let lastDrawnAt = 0;

      /**
       * 画一帧。返回 `true` 表示**这一帧真的落到画布上了**。
       *
       * ★ 返回值是给停摆看门狗用的，不是装饰：看门狗问的是「画面有多久没更新」，
       * 而这个函数有好几条不画就返回的路（帧率上限判掉、还没有模型）。
       * 一开始把时间戳记在调用处，于是**判掉的帧也算「画过了」** ——
       * 那正好把看门狗为它而建的那一种故障（帧率上限被算成 `Infinity`，
       * 每一帧都被判掉）盖住了：画面冻着，看门狗一声不吭。
       * 守门的人自己漏掉的那一格，比没守更坏。
       */
      const drawFrame = (now: number): boolean => {
        /*
         * ★ 帧率上限。`maxFps` 这个配置键修好之前，这一行不存在 ——
         * 循环无条件跟着显示器刷新率跑，配置里的数字谁都不读（第十个缺陷）。
         *
         * 判掉的帧**连字幕都不画、canvas 尺寸都不查**，直接返回：省下来的
         * 就是这次限流想要的那部分 CPU。反过来，只跳过 `draw()` 而照旧走完
         * 整个循环，对「降风扇」几乎没有帮助。
         *
         * `dt` 的起点 `host.last` 只在真的画了之后才更新，所以跳帧不会让
         * 动作变慢 —— 时间轴仍然是「距上一次画面更新过了多久」。
         */
        if (!shouldDrawFrame(host.last, now, fpsRef.current)) return false;

        const dt = host.last === 0 ? 0 : Math.min((now - host.last) / 1000, MAX_DELTA_SECONDS);
        host.last = now;

        // 画布尺寸跟随 CSS 尺寸与设备像素比；只在真的变了才改（改 width 会清空画布）。
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const hgt = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== hgt) {
          canvas.width = w;
          canvas.height = hgt;
        }

        /*
         * 字幕由**渲染循环**直接写 DOM，而不是走 React state。
         *
         * 当前词每几十毫秒就换一个，走 state 等于每十几帧重渲染一次整张卡片
         * （含模型下拉框和输入框）。这里只改三个 span 的文字，React 完全不知情 ——
         * 它也不需要知情：字幕是渲染产物，不是界面状态。
         *
         * 放在「没有模型」那个提前返回**之前**：模型加载失败时人还是可能正在说话，
         * 那时字幕更该显示出来（用户至少知道她在说什么）。
         */
        paintSubtitle(subtitleRef.current, subtitleView(
          {
            speaking: speech.state.speaking,
            text: speech.state.text,
            activeWordIndex: speech.activeWordIndex(),
            words: speech.state.words,
          },
          { lipGain: gainRef.current, subtitles: subtitlesRef.current },
        ));

        // 每帧现读 `host.current`，而不是把它闭包进来 —— 这正是「换装是一帧内的事」
        // 得以成立的原因：切换只改这一个引用，下一帧画的就是新模型。
        const model = host.current;

        if (model === null) {
          // 还没有任何模型：仍然清一次。改 canvas.width 会清空画布，但 CSS 尺寸变化
          // 之外的路径（例如从坏模型切回来）不会，留着上一帧的像素就是「残影」。
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          // 清屏也是一次真实的画面更新：画面上确实没有残留了。
          return true;
        }

        // 口型必须在 `update()` **之前**写进去：`update()` 开头的 `loadParameters()`
        // 会把外部写进参数表的值冲掉，而 Cubism Core 是「先烘焙顶点再画」，
        // 所以晚一帧写等于一直慢一帧。走 `setMouthOverride` 由模型在正确位置应用。
        model.setMouthOverride(applyLipGain(speech.openness(), gainRef.current));
        // 微动作要知道「在不在说话」（§13.26）：说话档比待机档密，且只挑说话向的那几条。
        // 由插件灌进去而不是让 PetModel 自己去听 —— 语音通道归插件，模型只该知道状态。
        model.setTalking(speech.state.speaking === true);
        model.update(dt);
        // 用户调出来的视图才套在最终投影上 —— 只改「画在哪儿、画多大」，
        // 上面那一步 `update()` 已经把所有动作/表情/口型都推进过了。
        model.setStageView(viewRef.current);
        model.draw(w, hgt);

        /*
         * ★ 参数实测（§13.34）：节奏与缩略图那一段相同 —— 必须在 `draw()` 之后、
         * 同一个 rAF 里，否则 `drawImage()` 拿到一片透明（`preserveDrawingBuffer: false`）。
         *
         * 它自己管「量过没有」（`host.bindDoneFor` 用模型路径当键），这里每帧叫一次
         * 就行；没在跑的时候是一次空调用。
         */
        stepBindingProbe(host, model, canvas);

        /*
         * ★ 探测期间把画面藏起来（§13.37）。
         *
         * 探测必须先真的把参数推上去再采样，所以「不渲染」不可行；能做的是
         * **不让人看见**：给舞台打一个 `data-probing`，CSS 把画布 `visibility: hidden`
         * 并盖一行「正在校准关节…」。采样依旧从画布取像素 —— `visibility` 只影响合成。
         * 每帧写一次、值没变就跳过，避免无谓的 DOM 写入。
         */
        {
          const stage = canvas.parentElement;
          if (stage !== null) {
            const probing = host.bindProbe === null ? '0' : '1';
            if (stage.getAttribute('data-probing') !== probing) stage.setAttribute('data-probing', probing);
          }
        }

        /*
         * ★ 缩略图：**必须**紧跟 `draw()`、在同一个 rAF 回调里。
         *
         * GL 上下文是 `preserveDrawingBuffer: false`，出了这一帧绘制缓冲就被清空了，
         * 那时 `drawImage()` 拿到的是一片透明 —— 症状是「缩略图永远存不下来」，
         * 看起来却像「模型没渲染」。
         *
         * 三个前置条件缺一不可：
         *   ① `host.renderedPath === modelPath` —— 画面上真的是**要拍的那一个**。
         *      加载失败时 `current` 停在旧模型上，少了这一条就会把旧模型的图
         *      存成新模型的缩略图，而一张**错的**图比没有图更糟；
         *   ② 指纹没拍过 —— 拍过就不再拍，否则变成每帧一次 `toDataURL`；
         *   ③ 距上次尝试过了 `THUMB_RETRY_MS` —— 模型还没淡入时
         *      `bboxOfAlpha()` 返回 `null`，不限速就成了每帧一次 `getImageData`。
         */
        const want = thumbWantRef.current;
        if (
          want !== null
          && host.renderedPath === modelPath
          && host.thumbDoneFor !== want.fingerprint
          && now >= host.thumbRetryAt
        ) {
          host.thumbRetryAt = now + THUMB_RETRY_MS;
          if (host.thumbProbe === null) host.thumbProbe = document.createElement('canvas');
          if (host.thumbOut === null) host.thumbOut = document.createElement('canvas');
          const dataUrl = captureThumbnail(canvas, host.thumbProbe, host.thumbOut);
          if (dataUrl !== null && isStorableThumb(dataUrl)) {
            host.thumbDoneFor = want.fingerprint;
            onThumbRef.current(want, dataUrl);
          }
        }

        /*
         * ★ 自动居中：量一次「本体画在视口的哪儿」，把它的中心挪到正中。
         *
         * 三个前置条件与缩略图那一段逐条对应、理由也逐条一样（① 画面上真的是
         * 这一只、② 这个模型没量过、③ 距上次尝试过了 `THUMB_RETRY_MS`），
         * 不重复解释。差别只有两处：
         *   · 键是**模型路径**而不是缩略图指纹 —— 量过就不再量是**正确性必需**：
         *     挪完位置墨迹包围盒就变了，「量 → 挪 → 再量」会互相追着跑；
         *   · 它不带任何「要不要」的开关，每一个模型都量 —— 偏心的成因是模型
         *     作者把角色画在了画布的一侧，那不是某个模型的特殊情况，是通例，
         *     只是偏心量大到看得见的只有 miku（见 `PetModel.draw()` 的注释）。
         *
         * 必须在 `draw()` 之后、同一个 rAF 回调里（理由见 `measureInkCenterX()`）。
         */
        /*
         * ⚠️ 探测**只在默认视图下做**（第 2 步新加的约束）。
         *
         * 它量的是「画布上墨迹的横向重心」，而用户拖动/缩放之后，墨迹被挪开过，
         * 量出来的重心里混进了用户自己的平移量 —— 把它当成模型的偏心量去补偿，
         * 就会在用户松手后自己再窜一下。所以「视图不是默认值」时这一帧跳过探测，
         * 也**不**推进 `inkRetryAt`（跳过不算一次失败，否则用户玩十秒就再没机会量）；
         * 用户双击复位（回到默认视图）之后，下一次窗口到了自然补上量。
         */
        const view = viewRef.current;
        if (isDefaultStageView(view) && host.renderedPath !== null && host.inkDoneFor !== host.renderedPath && now >= host.inkRetryAt) {
          host.inkRetryAt = now + THUMB_RETRY_MS;
          if (host.inkProbe === null) host.inkProbe = document.createElement('canvas');
          const inkCenterX = measureInkCenterX(canvas, host.inkProbe);
          if (inkCenterX !== null) {
            host.inkDoneFor = host.renderedPath;
            model.setInkCenterX(inkCenterX);
          }
        }

        /*
         * ★ 画面活性采样 —— 本项目里唯一不问假设、只看像素的存活判据。
         *
         * 现场（2026-06 用户报「卡了」）：命令通道活着（`/pending` 每次都被取空）、
         * 语音听得到（Host 那边 `tts.lastDurationSeconds` 有值）、帧循环一直在画、
         * `clientErrors` 一条都没有 —— 而画布是一张**静止的照片**：表情不生效、
         * 眼睛不眨。也就是说「走到了 `draw()`」与「画面真的变了」是两件事，
         * 上面两条护栏（try/catch、停摆看门狗）守的都只是前一件。
         *
         * 这里比像素：每 `LIVE_SAMPLE_MS` 采一张 24×24 的小图，连续
         * `LIVE_STUCK_SAMPLES` 次逐字节相同就上报（带 `gl.isContextLost()`、
         * fps、模型路径），再连续到 `LIVE_REBUILD_SAMPLES` 次就直接重建渲染宿主 ——
         * 「永久冻住、要用户手动刷新」与「自己 30 秒内好」的区别就在这一步。
         *
         * 三个防误报：
         *   · 全透明的采样返回 `-1`，不计入（否则模型加载期间会被判成冻住，
         *     然后重建 → 又加载 → 又判冻住，永远出不来）；
         *   · `document.hidden` 时不判 —— 窗口藏起来时画面本来就不该变；
         *   · 上报限流 `LIVE_REPORT_MS`，因为 `clientErrors` 只留最后 20 条。
         */
        if (Date.now() - host.liveSampledAt >= LIVE_SAMPLE_MS) {
          host.liveSampledAt = Date.now();
          host.liveAttempts += 1;
          if (host.liveProbe === null) host.liveProbe = document.createElement('canvas');
          const diag: ProbeDiag = { why: '', sw: 0, sh: 0, opaque: -1 };
          const hash = frameHashOf(canvas, host.liveProbe, diag);
          if (hash >= 0) {
            host.liveSameStreak = hash === host.liveHash ? host.liveSameStreak + 1 : 0;
            host.liveHash = hash;
            host.liveSamples += 1;
            host.liveBlindStreak = 0;
            /*
             * ★ 眼睛好了就把「已经报过瞎」这个闩拔掉。
             *
             * 不拔的话，这一条一辈子只能报一次：第一次瞎（比如加载期间画布全透明）
             * 报过之后，哪怕后来好了、再后来又瞎了，都再也不出声 —— 那正是
             * 「沉默无法解释」的老毛病，只不过这次是闩造成的。
             * `clientErrors` 只留最后 20 条，所以多报几次的代价有限，
             * 而「第二次瞎掉没人说」的代价是一次查不出来的卡死。
             */
            host.liveBlindReported = false;
          } else {
            host.liveBlindStreak += 1;
          }
          const visible = typeof document === 'undefined' || document.hidden !== true;

          /*
           * ★ 探针瞎了，必须自己说出来。
           *
           * 这是 2026-06 那次排查最贵的一课：探针**只在冻住时说话**，于是
           * `clientErrors` 为空同时对应三种完全不同的处境 —— 真的没冻、探针没跑到、
           * 探针跑到了但读不到像素。前两种要改代码，第三种要改探针，而它们在
           * `/status` 上一模一样，只能靠人猜。所以「连续 5 次读不到像素」（≈15 秒）
           * 就报一条，把 `why` 与画布尺寸一起带上 —— 那是唯一能区分这三者的东西。
           */
          if (host.liveBlindStreak >= LIVE_BLIND_SAMPLES && !host.liveBlindReported) {
            host.liveBlindReported = true;
            reportFailure(
              'frame-blind',
              new Error(
                `画面活性探针连续 ${host.liveBlindStreak} 次读不到像素，`
                + `所以它现在是瞎的、它的沉默不构成「一切正常」。`
                + ` 最后一次失败原因：${diag.why === '' ? '（未记录）' : diag.why}；`
                + `源画布=${diag.sw}×${diag.sh}，采到的 alpha 总和=${diag.opaque}，`
                + `模型=${host.renderedPath ?? '（无）'}，已画帧数=${host.drawnTotal}（累计，单调）。`
                + ' 注意：若是「全透明」，说明这一帧画布上确实什么都没有 ——'
                + ' 那要么是模型没加载好，要么是 GL 上下文有问题。',
              ),
            );
          }

          /*
           * ★ 开机自证：采满 `LIVE_SELF_TEST_SAMPLES` 次就报一条 `frame-live`。
           *
           * 两个前置条件：拿到了像素（`hash >= 0`，即模型真的画出来了）、
           * 这个标签页还没报过。
           *
           * 【2026-02 更正】这里以前还有第三个前置条件 `visible`（窗口可见才报），
           * 理由是「藏起来时画面本来就不该变，那时报自证是谎话」。那个理由把
           * **自证**当成了**健康声明**，方向错了：自证的唯一职责是证明「探针活着」，
           * 好让它之后的沉默可解释。加了 `visible` 之后，恰好在「窗口被判成隐藏」
           * 这个最需要证据的处境里，自证**拒绝出声** —— 于是又一次得到「零记录」。
           * 现在改成：不管可见与否都报，把 `document.hidden` 与
           * `document.visibilityState` 写进消息里，让读的人自己判断。
           *
           * 报的是**观测到的事实**，不是「我还在跑」这句自称：采了几次、
           * 连续相同的最大次数（0 = 每一次采样都和上一次不同 = 画面确实在动）、
           * 以及此刻 `gl.isContextLost()`。所以这一条既是探针的自证，
           * 也顺带把「她当时是不是活着」变成了可查的记录。
           */
          if (hash >= 0 && !liveSelfTestSent && host.liveSamples >= LIVE_SELF_TEST_SAMPLES) {
            liveSelfTestSent = true;
            let selfTestContextLost = false;
            try {
              selfTestContextLost = host.gl.isContextLost() === true;
            } catch {
              selfTestContextLost = false;
            }
            reportFailure(
              'frame-live',
              new Error(
                `画面活性探针自证（本条不是故障）：已采样 ${host.liveSamples} 次`
                + `（每 ${LIVE_SAMPLE_MS / 1000} 秒一张 ${LIVE_PROBE_SIDE}×${LIVE_PROBE_SIDE} 小图），`
                + `连续逐字节相同的最大次数=${host.liveSameStreak}`
                + `${host.liveSameStreak === 0 ? '（0 = 每次采样都和上一次不同 = 画面确实在动）' : '（>0 = 有采样点两两相同，尚不足以判定冻住）'}，`
                + ` gl.isContextLost()=${String(selfTestContextLost)}，`
                + ` document.hidden=${String(typeof document !== 'undefined' && document.hidden === true)}`
                + `（visibilityState=${typeof document === 'undefined' ? '（无 document）' : String(document.visibilityState)}），`
                + `模型=${host.renderedPath ?? '（无）'}，画布=${w}×${hgt}。`
                + ' 看到这一条就说明探针是活的 —— 那之后再没有 `frame-frozen`，才是「真的没冻住」。',
              ),
            );
          }
          if (visible && host.liveSameStreak >= LIVE_STUCK_SAMPLES) {
            const at = Date.now();
            if (at - host.liveReportedAt >= LIVE_REPORT_MS) {
              host.liveReportedAt = at;
              let contextLost = false;
              try {
                contextLost = host.gl.isContextLost() === true;
              } catch {
                contextLost = false;
              }
              let priority = '未知';
              try {
                priority = String(model.currentMotionPriority());
              } catch {
                priority = '读不到';
              }
              reportFailure(
                'frame-frozen',
                new Error(
                  `画面连续 ${host.liveSameStreak} 次采样逐字节相同`
                  + `（每 ${LIVE_SAMPLE_MS / 1000} 秒一次，约 ${Math.round((host.liveSameStreak * LIVE_SAMPLE_MS) / 1000)} 秒），`
                  + `而帧循环一直在跑（maxFps=${String(fpsRef.current)}）。`
                  + ` gl.isContextLost()=${String(contextLost)}，动作优先级=${priority}，`
                  + `模型=${host.renderedPath ?? '（无）'}，画布=${w}×${hgt}。`
                  + ' 这就是「她冻住了却一行日志都没有」的那种状态：`draw()` 每帧都跑，画面却不再更新。',
                ),
              );
            }
            if (host.liveSameStreak >= LIVE_REBUILD_SAMPLES) {
              setPhase('画面停住了，正在重建渲染宿主…');
              setBoot((n) => n + 1);
              return true;
            }
          }
        }

        host.frames += 1;
        // 单调的那个：只在这里加，谁都不许清（`frames` 上面那个窗口会清它）。
        host.drawnTotal += 1;
        if (host.windowStart === 0) host.windowStart = now;
        if (now - host.windowStart >= 500) {
          const fps = (host.frames * 1000) / (now - host.windowStart);
          host.frames = 0;
          host.windowStart = now;
          const current = host.current ?? null;
          setStats((prev) => ({
            fps: Math.round(fps),
            // 能结算这个窗口，就证明页面此刻正在被画 ⇒ 无论事件有没有送达，都不是暂停态。
            paused: false,
            size: `${w}×${hgt}`,
            params: prev?.params ?? 0,
            core: prev?.core ?? '',
            // 情绪从模型上现取：它是模型的状态，不是面板的状态。没有模型时留空。
            emotion: current === null ? '' : current.emotionName(),
            readout: current === null
              ? ''
              : describeReadout(current.emotionLayers(), current.ambientDriftSummary()),
          }));
        }

        return true;
      };

      /*
       * ★ 为什么要把 `drawFrame` 包起来 —— 这是「miku 冻住」最可能的藏身处。
       *
       * `requestAnimationFrame` 的回调**没有异常出口**：里面抛出的异常只会进
       * `window.onerror`（我们没装）和浏览器 console，然后被丢掉。而这个回调的
       * 第一行就是重排下一帧，所以一次抛错的后果不是「循环停掉」，而是
       * 「循环照跑、每一帧都在同一个地方炸、画面永远停在最后一帧」——
       * 从外面看和「卡死」一模一样，而且**一行日志都不会有**。
       *
       * 包起来之后这条路径就不再沉默了。节流是因为它每帧都炸：不节流的话
       * 16 毫秒一条上报，日志会被自己淹掉，真正的原因反而找不到。
       *
       * 捕获之后**不试图恢复**：能在帧循环里稳定复现的异常，猜着修只会把
       * 症状挪个地方。这里的目标是让下一次复现时
       * `GET /.dsh-live2d-pet/status` 的 `clientErrors` 里有确切的那一行。
       */
      const FRAME_ERROR_REPORT_MS = 5000;

      const frame = (now: number) => {
        if (host.disposed) return;
        host.raf = requestAnimationFrame(frame);
        try {
          const drew = drawFrame(now);
          /*
           * 记的是 `Date.now()` 而不是 rAF 传进来的 `now`：看门狗是 `setInterval`
           * 里的，只有墙上时钟可比。两个时间戳的起点完全不同（一个是 1970 年，
           * 一个是页面加载），混用会让看门狗在第一次检查时就误报。
           *
           * ★ 只在**真画了**的时候记 —— 见 `drawFrame` 的返回值说明。
           */
          if (drew) lastDrawnAt = Date.now();
        } catch (err) {
          frameErrors += 1;
          if (now - lastFrameErrorAt >= FRAME_ERROR_REPORT_MS) {
            lastFrameErrorAt = now;
            const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
            reportFailure(
              'frame',
              new Error(`帧循环抛错（累计 ${frameErrors} 次，每 ${FRAME_ERROR_REPORT_MS / 1000} 秒最多上报一次）：${detail}`),
            );
          }
        }
      };

      /*
       * ★ 停摆看门狗：抓「循环还在跑，但一帧都没画成」。
       *
       * 上面那个 try/catch 抓不到这一类 —— 异常是「炸在帧里」，这里守的是
       * 「帧根本没走到绘制」。已知的两条路都能落到这儿：
       *   · `shouldDrawFrame()` 因为 `maxFps` 读成了 `0` / 负数而**永远**返回 false
       *     （间隔 `1000/0 = Infinity`，每一帧都被判掉）；
       *   · 窗口被隐藏过之后 rAF 没被唤醒。
       *
       * `document.hidden` 那一问是必须的：窗口藏起来时浏览器**本来**就会停掉
       * rAF，那不是故障。只有「页面可见却 5 秒没有一帧」才算。
       */
      const STALL_REPORT_MS = 5000;
      let stallReported = false;

      const stallTimer = setInterval(() => {
        if (host.disposed || stallReported) return;
        if (typeof document !== 'undefined' && document.hidden === true) return;
        if (lastDrawnAt === 0) return;
        const stuckFor = Date.now() - lastDrawnAt;
        if (stuckFor < STALL_REPORT_MS) return;
        stallReported = true;
        reportFailure(
          'frame-stall',
          new Error(
            `渲染循环已 ${Math.round(stuckFor / 1000)} 秒没有画出一帧（maxFps=${String(fpsRef.current)}）。`
            + ' 若窗口当时是可见的，说明帧循环停摆了。',
          ),
        );
      }, STALL_REPORT_MS);

      /*
       * ★ 「窗口被判成隐藏」必须单独报一条 —— 这是我们自己造出来的盲区。
       *
       * 上面那个停摆看门狗**故意**在 `document.hidden === true` 时直接 return
       * （理由是对的：窗口藏起来时画面本来就不该变，那不是故障）；画面活性探针
       * 也在 `visible` 上做了同样的豁免。于是当窗口被浏览器/Electron 判成隐藏时：
       *
       *   · rAF 被暂停 → 画面永久停在同一帧，用户看到的就是「她冻住了」；
       *   · fps 标签停在最后一次算出来的值（比如 60）—— 它由 `drawFrame()` 内部
       *     更新，帧不跑它就不刷新，所以这个数字**看起来完全正常**；
       *   · 所有护栏按设计全部保持沉默 → `clientErrors` 一条都没有。
       *
       * 三个症状叠起来，与用户报的「画面卡住、fps 显示 60、一条记录都没有」
       * 逐字吻合。而之所以要从**定时器**里报（不能放在 `drawFrame()` 里）：
       * rAF 停了帧循环就不跑了，藏在帧里的检查永远不会执行 —— 这正是它之前
       * 一直没被发现的原因。
       *
       * 注意：隐藏页面的定时器会被浏览器降频到约每分钟一次，所以这里的 20 秒
       * 只是下限，实际可能一分钟才报出来。这不影响结论。
       */
      const hiddenTimer = setInterval(() => {
        if (host.disposed || host.liveHiddenReported) return;
        const hidden = typeof document !== 'undefined' && document.hidden === true;
        if (!hidden) {
          host.liveHiddenSince = 0;
          return;
        }
        if (host.liveHiddenSince === 0) {
          host.liveHiddenSince = Date.now();
          return;
        }
        const hiddenFor = Date.now() - host.liveHiddenSince;
        if (hiddenFor < LIVE_HIDDEN_REPORT_MS) return;
        host.liveHiddenReported = true;
        reportFailure(
          'frame-hidden',
          new Error(
            `页面被浏览器判成隐藏（document.hidden=true）已 ${Math.round(hiddenFor / 1000)} 秒。`
            + ' 这会让 rAF 暂停：画面会永久停在同一帧，fps 标签会显示「—（已暂停）」，'
            + '而停摆看门狗与画面活性探针都会按设计保持沉默 ——'
            + ' 也就是说这一条是那种「冻住且零记录」的唯一解释。'
            + ` 当前模型=${host.renderedPath ?? '（无）'}，已画帧数=${host.drawnTotal}（累计，单调），`
            + `visibilityState=${typeof document === 'undefined' ? '（无 document）' : document.visibilityState}。`
            + ' 若你此刻正看着桌宠，那说明这个判定本身是错的（窗口被遮挡而非隐藏），'
            + ' 那就该改成按「遮挡」而不是「隐藏」来判断。',
          ),
        );
      }, LIVE_HIDDEN_REPORT_MS);

      /*
       * ★ 「一帧都没跑到」必须自己说出来 —— 这是第五条护栏，也是唯一一条
       * 不依赖任何一帧的护栏。
       *
       * 上面四条（帧 try/catch、停摆看门狗、`frame-blind`、`frame-frozen`）全都
       * 住在 `drawFrame` 里面，或者以「已经画过帧」为前提：停摆看门狗与下面的兜底
       * 驱动都写着 `if (lastDrawnAt === 0) return;`，而那个早退分支覆盖的恰恰就是
       * 「一帧都没有」这个状态本身。
       *
       * 于是存在一个**没有任何护栏能说话**的状态：帧循环根本没跑起来（rAF 被永久
       * 暂停、effect 半路 disposed、采样块因为某个早退分支永远到不了）。它的外在
       * 表现与「她冻住了」一模一样，而 `clientErrors` 会是空的、fps 标签还停在最后
       * 一次算出来的数上 —— 这正是用户 2026-06 报的形状。
       *
       * 判据用 `host.liveAttempts`（采样块被执行过几次），不用 `host.frames`
       * （成功画完几帧）也不用 `host.liveSamples`（成功读到几次像素）：后两者在
       * 「模型还在加载、画布全透明」时都可能是 0，会冤枉加载慢的模型；
       * 而 `liveAttempts` 只要有一帧就立刻从 0 变 1。
       */
      const startTimer = setInterval(() => {
        if (host.disposed || host.liveStartReported) return;
        host.liveStartReported = true;
        if (host.liveAttempts > 0) return;
        reportFailure(
          'frame-nostart',
          new Error(
            `渲染宿主已经存在 ${Math.round(LIVE_START_MS / 1000)} 秒，`
            + `但画面活性探针的采样块一次都没有被执行过（liveAttempts=0，`
            + `已画帧数=${host.drawnTotal}（累计，单调），模型=${host.renderedPath ?? '（无）'}）。`
            + ' 这一条不等于「模型加载慢」—— 加载慢会让采样块照常跑起来、只是读到全透明，'
            + '那种情况报的是 frame-blind。这一条的含义是**根本没有帧**：'
            + ' rAF 没有被调度，或者这个渲染宿主已经被弃用了。'
            + ' 它的外在表现与「她冻住了」完全一样，而且 fps 标签会停在最后一次算出来的'
            + ' 值上、看起来很正常（所以用户会说「fps 还是 60」）。'
            + ` 此刻 document.hidden=${String(typeof document !== 'undefined' && document.hidden === true)}，`
            + `visibilityState=${typeof document === 'undefined' ? '（无 document）' : String(document.visibilityState)}。`,
          ),
        );
      }, LIVE_START_MS);

      /*
       * ★ rAF 停摆时的兜底驱动：让画面靠定时器继续走。
       *
       * 背景：`requestAnimationFrame` 只在页面「可见」时被调度。窗口被浏览器或
       * Electron 判成隐藏（最小化、被遮挡且开了 backgroundThrottling、宿主把页面
       * 挂进了不渲染的容器……）时，rAF **整体暂停**：画面永久停在同一帧，fps 标签
       * 停在最后一次算出的值上，所有护栏按设计沉默 —— 用户看到的正是「她冻住了」。
       *
       * 而 `document.hidden` 这个判定**不是我们能控制的**，也不总是对的（用户明明
       * 看着桌宠）。所以不能只把它记下来就完事：既然定时器在被判隐藏时仍然会跑
       *（浏览器会把它降频到约每分钟一次，但不会停），那就用定时器把帧补上。
       *
       * 判据用 `Date.now() - lastDrawnAt`（墙上时钟）而不是 rAF 的 `now`：
       * 后者在 rAF 停摆时根本不会更新，拿它比较等于拿一个不动的数去比。
       * 1 秒的阈值足够宽 —— `maxFps=60` 时正常每 16 毫秒就该有一帧，
       * 连 1 秒都没有帧只可能是 rAF 停了（`maxFps` 再低也不会低到 1fps）。
       *
       * 效果：被判隐藏时桌宠会以「定时器允许的频率」继续动（可见时是全速）。
       * 它不修「为什么被判隐藏」，但它把「冻成一张照片」变成「动得慢一点」——
       * 而后者不是故障。
       */
      const WAKE_STALL_MS = 1000;
      const wakeTimer = setInterval(() => {
        if (host.disposed) return;
        if (lastDrawnAt === 0) return;
        if (Date.now() - lastDrawnAt < WAKE_STALL_MS) return;
        try {
          const drew = drawFrame(performance.now());
          if (drew) lastDrawnAt = Date.now();
        } catch (err) {
          reportFailure('frame-wake', err);
        }
      }, WAKE_STALL_MS);

      /*
       * ★ 轮询 `gl.isContextLost()` —— 不能只靠 `webglcontextlost` 事件。
       *
       * 上一轮我加了事件监听就以为这块封住了，但现场说明了它的漏洞：用户那次
       * 冻住时 `clientErrors` 里**没有** `webgl-context-lost`。可能的原因是
       * 事件根本没派发、或者在监听器装上之前就已经丢了（`getContext()` 拿到的是
       * 一个已经被丢弃的上下文，这时不会有任何事件再补给你）。
       *
       * `isContextLost()` 是同步的布尔取值，不碰 GPU、不抛、不打日志，每 2 秒问一次
       * 的代价可以忽略；而它给出的答案**没有歧义** —— 为真就是上下文没了，
       * 「画布停在最后一帧、其他一切正常」的全部症状都由它一个人解释。
       *
       * 判定为真之后走与事件完全相同的恢复路径（`setBoot`），并在文案里注明
       * 这次是轮询发现的 —— 两种途径都记成 `webgl-context-lost`，因为对读日志的
       * 人来说它们是同一件事。
       */
      const GL_WATCH_MS = 2000;
      let glLostReported = false;

      const glWatchTimer = setInterval(() => {
        if (host.disposed || glLostReported) return;
        let lost = false;
        try {
          lost = gl.isContextLost() === true;
        } catch {
          return;
        }
        if (!lost) return;
        glLostReported = true;
        reportFailure(
          'webgl-context-lost',
          new Error(
            'gl.isContextLost() 为 true —— WebGL 上下文已经丢失，'
            + '画布会停在最后一帧、不眨眼、表情不生效，而 fps 与命令通道全都正常。'
            + ` 这次是 2 秒一次的轮询发现的（webglcontextlost 事件没有到我们手里）。`
            + ` 已重建渲染宿主（maxFps=${String(fpsRef.current)}）。`,
          ),
        );
        setPhase('WebGL 上下文丢失，正在重建…');
        setBoot((n) => n + 1);
      }, GL_WATCH_MS);

      /*
       * ★ 挂载即声明「舞台在重建中」，先让 Host 把旧清单丢掉（§13.25）。
       *
       * 这一句解的是「开局一条 `E_ACTION_NO_MODEL`」：页面刷新后面板重新挂载，
       * 而 Host 那边还留着刷新**前**那份清单 —— 它以为脸还在，于是照发不误，
       * 渲染端却在 `action-runner.ts` 里回「没有模型」（`target === null`）。
       *
       * 发在 `ready` 之前而不是 `activate` 之后：从挂载到模型真正换上有几百毫秒，
       * 这段窗口里本来就**没有脸**，清单却还在，正是那条错最容易被撞上的时候。
       * 等模型换上，切换 effect 会重新上报一份，那时清单自然恢复。
       *
       * 不 await、不抛（`reportCapabilitiesGone` 自己吞掉失败）：这里的职责只是
       * 「尽力告诉 Host」，失败也不该拖住建舞台。
       */
      void reportCapabilitiesGone('stage-booting');

      const ready = (async () => {
        setPhase('加载 Cubism Core…');
        const core = await loadCubismCore();
        if (cancelled) throw new Error('E_STAGE_UNMOUNTED');
        host.coreVersion = formatCoreVersion(core.Version.csmGetVersion());

        setPhase('编译 Framework shader…');
        await PetModel.ensureFramework(gl, SHADER_URL);
        if (cancelled) throw new Error('E_STAGE_UNMOUNTED');

        hostRef.current.host = host;
        /*
         * ★ 登记「舞台活着」。
         *
         * 这个 effect 的挂载是有条件的 —— 面板一收起，`Live2DStage` 整个不渲染，
         * 于是这里登记的每一道护栏连同这个 effect 一起消失。所以「零条 frame-*
         * 记录」有两种完全相反的成因：*没事* ，或者 *一个守卫都不在*。
         * 登记这一个事实，就是为了让那两种在 `/status` 上不再长得一样。
         *
         * 登记点选在这里而不是 effect 顶上：只有 Core 与 shader 都就绪、rAF 真
         * 排上了，这个舞台才算「在」；半途失败会让 `ready` 抛，
         * 走 `stage-boot` 那条路（见下面 `void ready.catch`）。
         */
        setStagePresence({
          since: Date.now(),
          modelPath: () => host.renderedPath ?? '',
          // ★ 报**单调**的那个，不是 `host.frames`（那个每 500ms 归零）。
          // `/status` 上这个字段的读法是「已画 N 帧」，语义就该是累计帧数 ——
          // 拿窗口计数器充当它，会让一个完全健康的桌宠读出一个 0，
          // 而 0 正是「一帧都没画」的样子。见 `drawnTotal` 的注释。
          frames: () => host.drawnTotal,
        });
        setPhase('');
        host.raf = requestAnimationFrame(frame);
        /*
         * ★ 第二条存活自证（`client-stage-mounted`）—— 只在这个 effect 走到
         * 「Core 与 shader 都就绪、rAF 排上了」这一刻发一次。
         *
         * 它与 `client-alive` 是一对，合起来把「零条 frame-*」拆成三段：
         *   · 两条都没有       → 上报通道或页面本身的问题，与桌宠无关；
         *   · 只有 client-alive → 舞台根本没挂载（面板收起 / 模型坏掉 / 还没轮到）；
         *   · 两条都有          → 舞台在，那零条 frame-* 只能是护栏自己的事，
         *                        此时 `frame-nostart` 会替它说话（25 秒内必到）。
         *
         * 没有这一条的话，「舞台没挂载」与「舞台挂了但护栏没跑」在 `/status`
         * 上仍然是一个样子 —— 那正是这次查了三轮的那个盲点。
         *
         * 位置在 `host.raf = …` **之后**：这一刻才真的排上了第一帧。
         */
        reportFailure(
          'client-stage-mounted',
          new Error(
            `渲染舞台已挂载并开始排帧（本条不是故障）：模型=${host.renderedPath ?? '（还没换上）'}，`
            + `画布=${canvas.width}×${canvas.height}，`
            + ` document.hidden=${String(typeof document !== 'undefined' && document.hidden === true)}`
            + `（visibilityState=${typeof document === 'undefined' ? '（无 document）' : String(document.visibilityState)}）。`
            + ' 之后 15 秒内应当出现 `frame-live`（探针自证）；'
            + '若 25 秒内既没有 frame-live 也没有 frame-blind，那会出现 `frame-nostart`。',
          ),
        );
        return host;
      })();

      hostRef.current.ready = ready;
      void ready.catch((err) => {
        // 启动失败只影响「有没有东西可画」，不影响组件本身 —— 所以这里只写 message。
        // 注意：绝不能把异常抛回 React，客户端半区抛错会拖着整个外壳一起死（§9.2）。
        if (cancelled) return;
        setPhase('');
        setMessage(err instanceof Error ? err.message : String(err));
        reportFailure('stage-boot', err);
      });

      return () => {
        cancelled = true;
        /*
         * 先摘监听再拆别的：重建时这个 effect 会先 cleanup 再重跑，而重跑拿到的是
         * **同一个 canvas**（React 不会换 DOM 节点），不摘就是每丢一次上下文多一个
         * 监听器，第二个之后每次丢失会 `setBoot` 好几次。
         */
        canvas.removeEventListener('webglcontextlost', onContextLost);
        canvas.removeEventListener('webglcontextrestored', onContextRestored);
        host.disposed = true;
        /*
         * ★ 注销「舞台活着」。放在 `disposed = true` 之后一行，理由就是这一整条
         * 链的起点：面板收起 → `Live2DStage` 不渲染 → 这个 cleanup 跑 →
         * 五道护栏全没了。此刻若还挂着 `stage=1`，Host 会以为有人在守着。
         */
        setStagePresence(null);
        if (host.raf !== 0) cancelAnimationFrame(host.raf);
        host.raf = 0;
        /*
         * 看门狗必须一起停：它是个真定时器，留着会在面板收起之后继续跑，
         * 并且对着一个已经 `disposed` 的 host 报「停摆」。
         *
         * ★ 顺带记一笔：上面那句「面板收起之后」原本只是推测，现在已确认 ——
         * `plugin.ts` 的 JSX 里写着 `collapsed ? null : h('div', …, Live2DStage…)`，
         * 收起面板就是卸载这个 effect。所以「面板收着」期间这五道护栏
         * **一条都不存在**，而 `/status` 上那与「一切正常」不可区分。
         */
        clearInterval(stallTimer);
        clearInterval(hiddenTimer);
        clearInterval(startTimer);
        clearInterval(wakeTimer);
        clearInterval(glWatchTimer);
        /*
         * 先注销执行目标再释放模型：晚一步的话，轮询那边可能正好取到一只
         * 正在被 `release()` 拆掉的模型，然后往里写参数 —— 那种错误只在
         * 「卸载面板」与「AI 刚好在说话」同时发生时才出现，极难复现。
         */
        setActionTarget(null);
        /*
         * ★ 摘目标之后**还要告诉 Host 清单没了**（§13.25）。
         *
         * 以前只摘了本地那张目标表，Host 手里的清单只增不减：面板收起、页面刷新、
         * 上下文丢失后重建 —— 这三种情况下 `host.current` 已经释放，可 Host 仍然
         * 认为「脸还在」，于是继续往 `/pending` 里推表情 / 动作，渲染端只能回
         * `E_ACTION_NO_MODEL`。真机 `clientErrors` 里那一条就是这么来的。
         *
         * 顺序：先 `setActionTarget(null)`（本地立刻不再执行），再上报（远端随后
         * 也开始拒绝）。反过来的话，存在一个两边都以为对方还在的窗口。
         */
        void reportCapabilitiesGone('stage-unmounted');
        try {
          host.current?.release();
        } catch (err) {
          reportFailure('release', err);
        }
        host.current = null;
        hostRef.current.host = null;
        hostRef.current.ready = null;
      };
      /*
       * ★ WebGL 上下文丢失时会 `setBoot(n => n + 1)`，让这个 effect 重跑一遍。
       *
       * 这是本 effect 唯一**故意**非空的依赖项，也是唯一一个能让「一个 canvas
       * 一辈子只跑一次」这句话不成立的东西 —— 理由见上面 `onContextLost` 的
       * 注释：上下文丢了之后框架侧的 GPU 资源已经没有一致的重建入口，
       * 推倒重来是唯一保证正确的做法。
       */
    }, [boot]);

    // ② 切换 effect —— 只做 prepare / activate，不碰上下文、Core、shader、RAF。
    useEffect(() => {
      if (modelPath === null) return;

      let cancelled = false;
      // 令牌防的是「快速连点两个模型」：先发的请求可能后完成，那时它必须自己放弃，
      // 否则用户最后看到的是第一个点的那个。
      const mine = (switchToken.current += 1);

      void (async () => {
        const pending = hostRef.current.ready;
        if (pending === null) return;

        let host: RenderHost;
        try {
          host = await pending;
        } catch {
          return; // 启动阶段已经失败并报过了，这里不重复报。
        }
        if (cancelled || mine !== switchToken.current) return;

        const first = host.current === null;
        setBusy(first ? '加载模型…' : '切换模型…');
        setMessage(null);

        let prepared: PetModel | null = null;
        try {
          const slash = modelPath.lastIndexOf('/');
          const baseUrl = `${MODEL_BASE}${slash < 0 ? '' : modelPath.slice(0, slash + 1)}`;
          const fileName = slash < 0 ? modelPath : modelPath.slice(slash + 1);

          // ★ prepare：新模型完整加载好（moc3 + 纹理 + 物理），全程不碰 host.current。
          // 这一步有多慢都无所谓 —— 期间用户看到的还是上一只，而不是空白。
          prepared = new PetModel(host.gl);
          await prepared.load({ baseUrl, shaderUrl: SHADER_URL }, fileName);

          if (cancelled || mine !== switchToken.current) {
            prepared.release();
            return;
          }

          // ★ activate：换引用是一帧内的事，旧模型到这里才 release。
          const previous = host.current;
          host.current = prepared;
          prepared = null;
          /*
           * 标记「画面上现在是它」。
           *
           * 只在**这一行**赋值 —— 上面那个 catch 里一个字节都不动，于是
           * 「切到坏包」之后 `renderedPath` 仍然是上一只，缩略图那一段
           * 因此拍不到任何东西（`renderedPath !== modelPath`），
           * 而不是把上一只的图存成坏包的名字。
           */
          host.renderedPath = modelPath;
          // 换装后第一帧的 dt 必须是 0：否则「上一只的帧间隔」会被当成新模型的 delta，
          // 物理与呼吸会瞬移一下。
          host.last = 0;
          host.frames = 0;
          host.windowStart = 0;
          // 新模型要重拍一张。指纹比对在 `frame()` 里做，这里只要把节流放开。
          host.thumbRetryAt = 0;
          /*
           * 同一件模型被**重新加载**（换包 / 重新导入）时要重新量居中：模型对象
           * 可能被复用或者干脆换了，而旧的 `_inkCenterX` 是按旧模型算的。
           * 只靠 `inkDoneFor !== renderedPath` 挡不住这种情况 —— 路径没变。
           */
          host.inkDoneFor = null;
          host.inkRetryAt = 0;
          setStats((prev) => ({
            fps: 0,
            // 换模型不走「画了一帧」那条路，所以暂停态只能继承，不能拍成 false。
            paused: prev?.paused ?? false,
            size: `${host.canvas.width}×${host.canvas.height}`,
            params: host.current.describeParameters().length,
            core: host.coreVersion,
            // 新模型还没有情绪层 —— 旧的随 `previous.release()` 一起没了（`release()` 里清的）。
            // 漂移要等第一帧才解析，所以读数也先空着，下一拍自己会出现。
            emotion: '',
            readout: '',
          }));
          setHasModel(true);
          setBusy('');
          /*
           * 把新模型登记成 AI 指令的执行目标（`action-runner.ts` 的模块级单例）。
           *
           * 放在 activate **之后**、`previous.release()` **之前**：轮询那边是
           * 「现取现用」，登记晚一帧就会有一条指令落到上一只已经被释放的模型上。
           * 登记本身不会抛（赋值而已），所以不必包 try。
           */
          setActionTarget(host.current);
          if (previous !== null) {
            try {
              previous.release();
            } catch (err) {
              reportFailure('release', err);
            }
          }

          /*
           * ★ 上报能力清单（`model:capabilities`，方案文档 §4.3）。
           *
           * 方向是**客户端 → Host**，与 `/speak` 相反。理由是清单只有这里能产出：
           * 参数要用 Cubism Core 枚举，而 Core 只在浏览器里跑；Host 自己解析 moc3
           * 等于把那套私有格式再实现一遍，Core 一升级就得跟着改。
           *
           * 放在 `activate` 之后而不是 `load` 之后：清单要描述的是**当前正在显示的**
           * 那只模型。若在 prepare 阶段就上报，用户快速连点两个模型时，Host 那边
           * 会先收到一只从没显示过的模型的能力。
           *
           * 不 await（`void`）：上报失败不该让切模型这件事显得失败 —— 桌宠已经换好了。
           * 而 `reportFailure` 只上报、不抛，所以这里不会把异常带回 React（§9.2：
           * 客户端求值期/渲染期抛错会拖着整个外壳一起死）。
           */
          /*
           * 先上报清单、**等它落地**再取微动作包。
           *
           * Host 是在收到清单的那一次请求里生成包的，抢在前面只会拿到
           * `E_MICRO_NO_CAPABILITIES`（画面表现是「这一轮没有微动作」，
           * 要等下次换模型才回来 —— 很安静）。`reportCapabilities` 自己吞掉
           * 失败，所以这里 `.then` 一定跑；包取不到时 `syncMicroMotions` 会退回
           * 手写那七条，不会让桌宠变成不动的。
           */
          const model = host.current;
          const reported = reportCapabilities(model, modelPath);
          void reported
            .then((probeFresh) => {
              /*
               * Host 说「这份清单已经量过了」（§13.37）⇒ 跳过这一轮参数实测。
               * 跳过之后画面上没有「校准关节」那一下抽搐，刷新页面也不会有；
               * 换模型 / 换清单 / Host 重启之后指纹对不上，自会重新测。
               */
              if (probeFresh) host.bindDoneFor = modelPath;
              return syncMicroMotions(model);
            })
            .catch(() => {});
        } catch (err) {
          if (prepared !== null) {
            try {
              prepared.release();
            } catch (releaseErr) {
              reportFailure('release', releaseErr);
            }
          }
          if (cancelled || mine !== switchToken.current) return;
          setBusy('');
          // 加载失败**不释放** host.current —— 于是「切到坏包」的结果从
          // 「桌宠彻底消失」变成「还是上一只，加上一行错误」。这是 §6.1 #2
          // 「当前模型不受影响」的直接实现。
          setMessage(err instanceof Error ? err.message : String(err));
          reportFailure('model-load', err);
        }
      })();

      return () => {
        cancelled = true;
      };
      /*
       * ★ `boot` 必须在依赖里，否则「重建渲染宿主」这条路是**断的**。
       *
       * 上面那个 effect 的 cleanup 会 `host.current?.release()` 并把引用置空，
       * 而重新跑起来时它**只重建 gl / host / 帧循环，不加载模型**（加载是这里的事）。
       * 于是只依赖 `modelPath` 的话，`setBoot(n => n + 1)` 的结果是：
       * 旧模型被释放、新模型没人装 → 画布永远空着，比原来的「冻住」还糟 ——
       * 而且看起来像「重建把桌宠弄没了」，与「重建」这个动作本身背道而驰。
       *
       * 这是本 effect 唯一**故意**非空的第二个依赖项，理由与上一个 effect 的
       * `[boot]` 完全相同。
       */
    }, [modelPath, boot]);

    // 渲染分三层，区别在于「谁是全屏遮罩、谁是角标」：
    // - `phase` 只在启动阶段非空，那时画布上本来就什么都没有 → 全屏遮罩；
    // - `message` 在没有模型时是全屏遮罩（同以前），**有模型时退化成底部一条**，
    //   因为此时桌宠还在正常渲染，用全屏遮罩把它盖住等于「切坏了」的观感又回来了；
    // - `busy` 永远只是角标 —— 「正在切换」不是错误，不该盖住任何东西。
    return h(
      'div',
      {
        className: 'dsh-l2d-stage',
        ref: stageBoxRef,
        /*
         * 舞台上的指针事件只做一件事：平移模型。这里**不拦点击**（没有 tap 动作），
         * 所以拖一下之外的行为与以前一致。`data-view` 只给 CSS 用（光标形状）。
         */
        onPointerDown: beginPan,
        onPointerMove: onPanMove,
        onPointerUp: endPan,
        onPointerCancel: endPan,
      },
      h('canvas', { ref: canvasRef, className: 'dsh-l2d-canvas' }),
      /*
       * 字幕节点。三个 span 的**子节点由 `paintSubtitle()` 直接写**，所以这里
       * 不传 children（传了的话 React 会在每次重渲染时把它们冲掉）。
       * 初始 `display: none`：没在说话就不该占着那一条。
       */
      h(
        'div',
        { className: 'dsh-l2d-subtitle', ref: subtitleRef, style: { display: 'none' } },
        h('span', null),
        h('span', { className: 'dsh-l2d-subword' }),
        h('span', null),
      ),
      phase !== '' ? h('div', { className: 'dsh-l2d-hint' }, phase) : null,
      message !== null
        ? h(
            'div',
            { className: hasModel ? 'dsh-l2d-loaderr dsh-l2d-err' : 'dsh-l2d-hint dsh-l2d-err' },
            message,
          )
        : null,
      busy !== '' && message === null ? h('div', { className: 'dsh-l2d-switching' }, busy) : null,
      /*
       * 舞台右上角：手势说明 + 「重置模型」。
       *
       * 用户 2026-06 明确要求把它放在**模型边框的右上角**（原来在设置区里，要展开、
       * 还要往下滚才看得到 —— 一件「救急」的东西藏在两层折叠下面等于没有）。
       *
       * 三个细节都是**必须**的，少一个就变成新的坑：
       *   · 外层 `pointer-events: none`，只有按钮自己 `auto` —— 否则这条角标会挖掉
       *     舞台右上角一块可拖动区域，用户在那儿按下去拖不动模型，还以为卡了；
       *   · 按钮按下时 `stopPropagation` —— 舞台的 pointerdown 会开一次平移，
       *     从按钮开始拖就会「点一下按钮、模型跟着跑」；
       *   · 说明文字 `pointer-events: none` 且半透明 —— 它是提示，不是控件。
       *
       * 按钮在视图默认时**禁用**：一条永远可按、按下去什么都不发生的按钮
       * 比没有按钮更容易被当成坏了。灰显就是它的第二种语义（「现在没什么可复位」）。
       */
      h(
        'div',
        { className: 'dsh-l2d-stagehud' },
        h('span', { className: 'dsh-l2d-hudtip' }, '滚轮缩放 · 拖动平移 · 双击复位'),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-l2d-hudbtn',
            disabled: !viewMoved,
            title: viewMoved
              ? '把模型放回默认的大小与位置（也可以双击模型）'
              : '模型现在就在默认的大小与位置',
            onPointerDown: (event: PointerEventLike) => event.stopPropagation?.(),
            onDoubleClick: (event: { stopPropagation?: () => void }) => event.stopPropagation?.(),
            onClick: () => resetStageView(),
          },
          '重置模型',
        ),
      ),
      stats !== null && phase === ''
        ? h(
            'div',
            {
              className: 'dsh-l2d-hint',
              style: { alignItems: 'flex-end', justifyContent: 'flex-end', fontSize: '10px', opacity: .45 },
            },
            `${stats.paused ? '—（已暂停）' : `${stats.fps} fps`} · ${stats.params} 参数 · Core ${stats.core}`
              // 数值读数（§13.33）：情绪权重、余波、漂移幅度。空就不占地方。
              + (stats.readout === '' ? '' : ` · ${stats.readout}`),
          )
        : null,
    );
  }

  function Row(props: { label: string; children: unknown }) {
    return h('div', { className: 'dsh-l2d-row' }, h('span', null, props.label), h('span', null, props.children));
  }

  function StatusRows(props: { status: Record<string, unknown> | null; error: string | null }) {
    if (props.error !== null) {
      return h(Row, { label: 'Host' }, h('span', { className: 'dsh-l2d-err' }, `不可达：${props.error}`));
    }
    if (props.status === null) return h(Row, { label: 'Host' }, '连接中…');
    const s = props.status;
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      h(Row, { label: '版本' }, String(s.version ?? '?')),
      h(Row, { label: '模型库' }, s.modelsRootExists === true ? '已就绪' : '不存在'),
      h(Row, { label: '路径' }, String(s.modelsRoot ?? '?')),
      h(Row, { label: '前端' }, String(s.clientBuild ?? '?')),
    );
  }

  /** 右下角浮层：模型的舞台 + 一个模型选择器。 */
  function Live2DOverlay() {
    /*
     * ★ 一律以「收起」开场（用户要求：每次刷新或重启 DSH 之后，插件的形态都是
     * 收起的固定窗口）。
     *
     * 所以这里**不读** localStorage 里上一次的展开状态。一张 42vh 高的卡片每次
     * 刷新都自己弹开来，等于每次打开页面都要先把它按回去 —— 而收起的那一条
     * 标题栏才是它「平时不打扰人」的形态。想展开的话点一下标题栏就是了，
     * 那是一个明确的动作，不是每次都要付的代价。
     */
    const [collapsed, setCollapsed] = useState<boolean>(true);
    const { status, error } = useHostStatus(5000);
    const speech = useSpeechQueue();

    /*
     * ★ 窗口形态 + 浮动窗口的矩形（用户第 1 条要求）。
     *
     * 位置与大小存进 `localStorage`：切到浮动、拖到某处之后，再切回浮动还在那儿。
     * 但 **`mode` 不还原** —— 解析出来之后一律改回 `'fixed'`。用户的原话是
     * 「每次刷新或重启 DSH 后，插件的形态为收起的固定窗口」：一个浮在任意位置的
     * 面板重新打开时可能正盖着用户要读的内容，而它是持久化的、又只露一角（
     * `KEEP_VISIBLE_X`），比收起的那条标题栏难对付得多。
     *
     * 初始化走 `parseWindowState()`，它对坏数据容错；这里再包一层 try 是因为
     * `localStorage` 本身在某些上下文里会**抛异常**（隐私模式、被禁用的存储）——
     * 那不该让整张卡片白屏。
     */
    const [win, setWin] = useState<WindowState>(() => {
      try {
        return { ...parseWindowState(localStorage.getItem(WINDOW_STORAGE_KEY), viewportOf()), mode: 'fixed' };
      } catch {
        return { mode: 'fixed', ...defaultFloatRect(viewportOf()) };
      }
    });
    /*
     * 落盘。存的是「浮动窗口在哪儿、多大」；`mode` 与 `collapsed` 虽然也在 JSON 里，
     * 但下一次加载**不会被当成本次会话的形态**（见上面两处初始化）——
     * 它们只是为了让存储格式保持一份完整的 `WindowState`，读写两边可以对打。
     */
    useEffect(() => {
      try {
        localStorage.setItem(WINDOW_STORAGE_KEY, serializeWindowState(win));
      } catch {
        // 写不进就算了：下次刷新回到默认形态，但不影响这一次的拖动。
      }
    }, [win]);
    /*
     * 视口变小之后把浮动窗口夹回可见范围。
     *
     * 不夹的话，一个「在 1920 宽的屏幕上拖到右边」的窗口换到 1366 宽的屏幕上就整个
     * 不见了 —— 而它偏偏是持久化的，刷新回来还在看不见的地方。
     */
    useEffect(() => {
      const onResize = () => {
        setWin((prev) => ({ ...prev, ...clampFloatRect(prev, viewportOf()) }));
      };
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    /**
     * 收起之后的横条矩形（只在「浮动形态 + 已收起」时存在）。
     *
     * 它是**算出来的**，不写回 `win`：写回去就把「展开之后该回到多大、在哪儿」
     * 这件事弄丢了 —— 一条 268px 的横条和一个 820×480 的窗口不可能共用一组坐标。
     * 所以 `win` 始终保存着用户真正调过的那份矩形，收起只是换一种方式把它画出来。
     */
    const collapsedBar = win.mode === 'float' && collapsed ? fitCollapsedBar(win, viewportOf()) : null;

    /** 拖动 / 拉角期间记下的起点。`null` = 现在没在拖。 */
    const dragRef = useRef<{ pointerId: number; kind: 'move' | 'resize'; start: WindowState; px: number; py: number } | null>(null);
    /**
     * 拖动标题栏 / 拉右下角。
     *
     * 两个手势共用一个状态机，只用 `kind` 区分 —— 它们的事件序列完全一样
     * （pointerdown → 捕获 → pointermove* → pointerup），拆成两套只会让
     * 「松手没清掉」这类 bug 有两份机会。
     */
    const beginDrag = (kind: 'move' | 'resize') => (event: PointerEventLike) => {
      if (win.mode !== 'float') return;
      // 标题栏上的按钮（收起 / 切形态）不该触发拖动。
      if (kind === 'move' && event.target?.closest?.('button') != null) return;
      /*
       * 收起的横条与展开的窗口共用 `win`，但**画在屏幕上的位置不同**（横条被
       * 夹成整条可见）。起点必须取屏幕上那个位置，否则第一次按下就会跳一下 ——
       * 跳的距离正好是被夹掉的那一段。
       */
      const start = kind === 'move' && collapsedBar !== null ? { ...win, x: collapsedBar.x, y: collapsedBar.y } : win;
      dragRef.current = { pointerId: event.pointerId, kind, start, px: event.clientX, py: event.clientY };
      event.currentTarget?.setPointerCapture?.(event.pointerId);
      event.preventDefault?.();
    };
    const onDragMove = (event: PointerEventLike) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.px;
      const dy = event.clientY - drag.py;
      const next = drag.kind === 'move'
        ? moveFloatRect(drag.start, dx, dy, viewportOf())
        : resizeFloatRect(drag.start, dx, dy, viewportOf());
      /*
       * 拖一条收起的横条时，只让它用横条的规矩（整条可见），且**只写回位置**：
       * 把 `w`/`h` 也写回去的话，横条那 268×38 会盖掉用户真正调的窗口尺寸，
       * 展开时窗口会变成一条横杠的大小。
       */
      if (drag.kind === 'move' && collapsedBar !== null) {
        const bar = fitCollapsedBar(next, viewportOf());
        setWin((prev) => ({ ...prev, x: bar.x, y: bar.y }));
        return;
      }
      setWin((prev) => ({ ...prev, ...next }));
    };
    const endDrag = (event: PointerEventLike) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      event.currentTarget?.releasePointerCapture?.(event.pointerId);
    };
    /**
     * 切形态。
     *
     * 只改 `mode` 这一个字段：DOM 树、组件实例、画布、模型全部原地不动，
     * 所以动作与表情**不会**被重置（用户第 2 条要求）。
     */
    const toggleMode = () => {
      setWin((prev) => (prev.mode === 'float'
        ? { ...prev, mode: 'fixed' }
        : { ...clampFloatRect(prev, viewportOf()), mode: 'float' }));
    };

    const [models, setModels] = useState<ModelEntry[] | null>(null);
    const [modelsError, setModelsError] = useState<string | null>(null);
    const [summary, setSummary] = useState<LibrarySummary | null>(null);
    const [scanning, setScanning] = useState(false);
    /** 拒绝切换时给出的原因（比静默什么都不发生有用得多）。 */
    const [pickNote, setPickNote] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(() => readModelPref());
    /*
     * 只读：设定值仍然从同一个存储来（舞台拿它算口型增益、字幕开关），
     * 但**改**它的滑杆已经搬去设置页了（§13.35）。留 `settings` 是因为
     * 舞台那两件事还得跟着它变 —— 在设置页改完，这里下一次渲染就生效。
     */
    const [settings] = usePetSettings();
    /**
     * 选中模型的那张小图（方案 P1 的交付物「缩略图」）。
     *
     * `null` 有两种意思 ——「还没拍」和「这个模型拍不出来」—— 而这两种在界面上
     * 本来就该长得一样（都是「暂时没有图」），所以不必分开。要分开的是
     * 「有图但已经过期」，而那个由 `thumbWant` 负责：过期时它非空，于是舞台会重拍。
     */
    const [thumb, setThumb] = useState<StoredThumb | null>(null);
    /** 要舞台为哪个指纹拍一张。`null` = 缓存里那张是新鲜的，不用拍。 */
    const [thumbWant, setThumbWant] = useState<ThumbWant | null>(null);
    /** 给 `onThumb` 用的当前选中项 —— 它在 `useCallback([])` 里，读不到 state。 */
    const selectionRef = useRef<string | null>(null);
    selectionRef.current = selected;

    useEffect(() => {
      mountedOnce = true;
    }, []);

    /**
     * 拉一次模型库清单。
     *
     * `stillWanted` 是给 effect 用的取消钩子：请求还在飞的时候组件可能已经卸载
     * （或模型库根目录又变了），此时把结果写回 state 是「卸载后 setState」，
     * React 会警告，而更糟的是**它会覆盖掉新一轮扫描的结果**。
     * 刷新按钮不传它 —— 那是用户主动点的，没有「过期」这个概念。
     */
    const reload = useCallback(async (force: boolean, stillWanted?: () => boolean) => {
      setScanning(true);
      try {
        const { models: list, summary: sum } = await fetchModels(force);
        if (stillWanted !== undefined && !stillWanted()) return;
        setModels(list);
        setSummary(sum);
        setModelsError(null);
        setSelected((prev) => pickDefault(list, prev));
      } catch (err) {
        if (stillWanted !== undefined && !stillWanted()) return;
        setModelsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (stillWanted === undefined || stillWanted()) setScanning(false);
      }
    }, []);

    useEffect(() => {
      let cancelled = false;
      void reload(false, () => !cancelled);
      return () => {
        cancelled = true;
      };
    }, [reload, status?.modelsRoot as string | undefined]);

    const active = useMemo(() => {
      const found = (models ?? []).find((m) => m.id === selected);
      if (found !== undefined) return found;
      // Host 的 `/models` 路由是新加的，而 Host 半区的改动要重启 DSH 才生效。
      // `/model/<rel>` 这条更早就有了 —— 所以列表拿不到时，只要还记得上次的路径，
      // 就照样能把它加载出来，不必为了看见效果先重启一次应用。
      if (modelsError !== null && selected !== null && selected.endsWith('.model3.json')) {
        return { id: selected, path: selected, name: selected };
      }
      return null;
    }, [models, selected, modelsError]);

    /**
     * 选中模型变了：先看缓存里那张还新不新鲜，不新鲜就请舞台重拍一张。
     *
     * 依赖数组里放的是**原始值**（`id` / `mtimeMs` / `bytes` / 版本号），不是
     * `active` 对象本身 —— 每次 `/models` 扫描都会造一批新对象，用对象当依赖
     * 会让这个 effect 每轮都跑一遍，刚存好的缩略图立刻被当成「需要重拍」。
     * 这四个值合起来就是 `fingerprintOf()` 用的那套身份。
     */
    useEffect(() => {
      if (active === null) {
        setThumb(null);
        setThumbWant(null);
        return;
      }
      const fingerprint = fingerprintOf(active);
      const stored = readStoredThumb(active.id);
      if (isFresh(stored, fingerprint)) {
        setThumb(stored);
        setThumbWant(null);
        return;
      }
      // 缓存里没有或已过期。先把旧的图撤下来 —— 留着一个属于**上一个版本**
      // 的模型的图，比暂时空着更糟（用户会以为那就是现在的样子）。
      setThumb(null);
      // 指纹算不出来（Host 没给 `mtimeMs`，也没给 `bytes`）就不请它拍：
      // 没有指纹就永远判不出新鲜度，拍一张存一张会变成每轮扫描重拍一次。
      setThumbWant(fingerprint === '' ? null : { id: active.id, fingerprint });
    }, [
      active?.id as string | undefined,
      active?.mtimeMs as number | undefined,
      active?.bytes as number | undefined,
      active?.moc3?.version as number | undefined,
    ]);

    /**
     * 舞台拍好了一张。
     *
     * 只有「拍的是现在选中的那个」才换上界面 —— 用户可能在抓图的那几帧里
     * 换走了模型，那时这张图属于上一个模型，换上就是串台（界面上写着 B 的名字、
     * 显示着 A 的脸）。存还是照存：它对这个 id 来说仍然是对的。
     */
    const onThumb = useCallback((want: ThumbWant, dataUrl: string) => {
      if (!isStorableThumb(dataUrl)) return;
      const record: StoredThumb = {
        id: want.id,
        dataUrl,
        fingerprint: want.fingerprint,
        at: Date.now(),
      };
      writeStoredThumb(record);
      if (selectionRef.current === want.id) setThumb(record);
    }, []);

    const toggle = useCallback(() => {
      const next = !collapsed;
      /*
       * 不落盘：收起状态**故意**不跨刷新保持（每次打开都是收起的固定形态，见初始化）。
       * 早先这里写过 `localStorage['dsh-live2d-pet.collapsed']`，现在读它的人已经没了，
       * 再写就是一条没人读的脏数据 —— 留着只会让后来的人以为它是生效的。
       */
      setCollapsed(next);
      /*
       * 展开时把窗口夹回视口。
       *
       * 收起的那条横条可以被拖到屏幕右边缘（它只要整条可见就行），而同一个
       * `x` 放一个 820 宽的窗口就会有半截在屏幕外。夹一次保证至少露出
       * `KEEP_VISIBLE_X`，也就是标题栏还在手里。
       */
      if (!next) {
        setWin((prev) => (prev.mode === 'float' ? { ...prev, ...clampFloatRect(prev, viewportOf()) } : prev));
      }
    }, [collapsed]);

    /**
     * 切换模型 —— 坏包会被拒绝。决策本身在 `./model-list` 的 `evaluatePick`，
     * 那里有单测；这里只负责把它接到 state 上。
     */
    const onPick = useCallback((event: { target: { value: string } }) => {
      const decision = evaluatePick(models, event.target.value);
      if (!decision.accept) {
        setPickNote(decision.reason);
        return;
      }
      setPickNote(null);
      setSelected(decision.id);
      writeModelPref(decision.id);
    }, [models]);

    const hostAlive = error === null && status !== null;


    /**
     * 拦住「文件被拖到页面空白处」时浏览器的默认行为。
     *
     * 不拦的话浏览器会**离开当前页面去打开那个文件** —— 整个 DSH 界面连同
     * 没保存的东西一起消失，而用户只是想拖个模型进来。只处理带 `Files` 的拖动：
     * 别的插件可能在用拖拽做排序之类的事，那些不能被我们吞掉。
     */
    useEffect(() => {
      const guard = (event: { dataTransfer: { types?: { includes?: (t: string) => boolean } } | null; preventDefault: () => void }) => {
        const types = event.dataTransfer?.types;
        if (types?.includes?.('Files') === true) event.preventDefault();
      };
      document.addEventListener('dragover', guard);
      document.addEventListener('drop', guard);
      return () => {
        document.removeEventListener('dragover', guard);
        document.removeEventListener('drop', guard);
      };
    }, []);


    /**
     * 选中的模型是不是坏的。
     *
     * 坏模型**不挂载舞台** —— 让它去加载只会得到一次必然失败的尝试，
     * 而失败路径会 `release()` 掉旧模型。宁可什么都不做，也不要「加载失败，
     * 顺便把上一只桌宠弄没了」。
     */
    const activeBroken = active !== null && active.ok === false;
    const activeProblems = active?.problems ?? [];

    return h(
      'div',
      {
        className: 'dsh-l2d-root',
        /*
         * 浮动形态用内联 `left/top/width/height`，固定形态什么都不写 ——
         * 让 CSS 里那套 `right/bottom: 16px` 继续说话。两种定位方式共用同一个元素，
         * 切形态时没有任何 DOM 变动。
         */
        'data-mode': win.mode,
        /*
         * 收起的形态要让 CSS 知道（用户报的那个 bug：浮动形态下按下「收起」，
         * 内容没了但窗口还在原地空着）。样式那一半在 `.dsh-l2d-card` 上：
         * 收起时高度交给内容撑，宽度取固定形态的 268px。
         */
        'data-collapsed': collapsed ? '1' : '0',
        style: win.mode === 'float'
          ? collapsedBar !== null
            /*
             * 收起的横条：**不写 height**，让它由标题栏撑出来（与固定形态收起时同高）；
             * 宽度取 `COLLAPSED_BAR_W`（与固定形态的卡片同宽）。
             */
            ? { left: `${collapsedBar.x}px`, top: `${collapsedBar.y}px`, width: `${COLLAPSED_BAR_W}px` }
            : { left: `${win.x}px`, top: `${win.y}px`, width: `${win.w}px`, height: `${win.h}px` }
          : null,
      },
      h(
        'div',
        {
          className: 'dsh-l2d-card',
        },
        h(
          'div',
          {
            className: 'dsh-l2d-head',
            /*
             * 浮动形态下标题栏就是拖动把手。`data-drag` 而不是 `onPointerDown: null`
             * 是为了让「能不能拖」这件事在 CSS 里也看得见（cursor: move）。
             */
            'data-drag': win.mode === 'float' ? '1' : '0',
            onPointerDown: beginDrag('move'),
            onPointerMove: onDragMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
          },
          h('span', { className: 'dsh-l2d-dot', 'data-on': hostAlive ? '1' : '0' }),
          h('span', { className: 'dsh-l2d-title' }, DISPLAY_NAME),
          /*
           * 形态切换（用户第 1 条要求）。
           *
           * 两个箭头而不是「固定 / 浮动」两个字：这张卡片在固定形态下只有 268px 宽，
           * 标题栏里塞四个汉字会把模型名挤掉；`title` 里写全，鼠标悬停就能读到。
           */
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-l2d-btn',
              onClick: toggleMode,
              title: win.mode === 'float' ? '固定到右下角' : '浮动窗口（可拖动、可拉角改大小）',
            },
            win.mode === 'float' ? '⤡' : '⤢',
          ),
          h(
            'button',
            { type: 'button', className: 'dsh-l2d-btn', onClick: toggle, title: collapsed ? '展开' : '收起' },
            collapsed ? '▴' : '▾',
          ),
        ),
        collapsed
          ? null
          : h(
              'div',
              { className: 'dsh-l2d-body' },
              /*
               * 舞台单独一层：浮动形态下它占据左边 8 份（CSS 里 flex: 8），
               * 固定形态下 `display: contents` 让这一层不存在（观感与旧版一致）。
               * 它必须包裹**画布** —— 那一层在两种形态之间只换 CSS，不换 DOM。
               */
              h(
                'div',
                { className: 'dsh-l2d-main' },
              active !== null && !activeBroken
                ? h(Live2DStage, {
                    modelPath: active.path,
                    lipGain: settings.lipGain,
                    subtitles: settings.subtitles,
                    /*
                     * 帧率上限来自 `/status`（插件配置的 `maxFps`），不来自面板。
                     *
                     * `normalizeFps()` 在这里再夹一次是**刻意**的纵深，不是重复定义：
                     * 这个值可能在 `/status` 还没回来时是 `undefined`（→ 默认 60），
                     * 也可能被一个改了 Host 半区的旧版本报成 `0`。渲染端是唯一
                     * 真正用它改行为的地方，它不能信任任何一个外来数字 ——
                     * 猜错的方向是桌宠永久静止。数字与规则仍然只有
                     * `lib/host/render-config.js` 那一份。
                     */
                    maxFps: normalizeFps((status as { maxFps?: unknown } | null)?.maxFps),
                    /*
                     * 缩略图：要拍哪一张（`null` = 缓存里那张还新鲜），以及拍好了交给谁。
                     *
                     * 这两个值都走 props 而不是让舞台自己去读 `localStorage`：
                     * 舞台只知道像素，不知道「哪个模型被选中了」，也不知道
                     * 模型清单什么时候刷新过。存储与新鲜度的判断留在上面
                     * （`thumbnail.ts` 那套），舞台只负责「给我一张图」。
                     */
                    thumbWant,
                    onThumb,
                  })
                : null,
              /*
               * 模型是坏的、所以舞台是空的 —— 必须**明说**。
               * 否则用户看到的只是「桌宠不见了」外加一串错误码，第一反应会是
               * 「插件坏了」而不是「我下载的模型包缺了张图」。
               */
              activeBroken
                ? h(
                    'div',
                    { className: 'dsh-l2d-err' },
                    `「${active?.name}」加载不起来，所以没有渲染。原因：`,
                  )
                : null,
              ),
              /*
               * 设置面板单独一层：浮动形态下它是右边 2 份的边栏（用户第 3 条要求
               * 里「参数绑定等设置为边栏」），固定形态下同样是 `display: contents`。
               */
              h(
                'div',
                { className: 'dsh-l2d-side' },
              modelsError !== null
                ? h('div', { className: 'dsh-l2d-err' }, modelsError)
                : models === null
                  ? h('div', { style: { opacity: .6 } }, '正在扫描模型库…')
                  : models.length === 0
                    ? h('div', { style: { opacity: .6 } }, '模型库是空的：把 .model3.json 所在文件夹放进模型库里。')
                    : h(
                        'div',
                        { className: 'dsh-l2d-modelrow' },
                        h(
                          'select',
                          { className: 'dsh-l2d-select', value: selected ?? '', onChange: onPick },
                          /*
                           * 坏包**不禁用**（不加 `disabled`），而是让 `onPick` 拦下来
                           * 并把原因说出来。禁用的选项是「点不动且不知道为什么不」——
                           * 而用户此刻最需要的恰恰是知道自己的包哪里坏了。
                           */
                          models.map((m) => h('option', { key: m.id, value: m.id }, modelLabel(m))),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-l2d-btn dsh-l2d-refresh',
                            onClick: () => void reload(true),
                            disabled: scanning,
                            title: '重新扫描模型库（忽略体检缓存）',
                          },
                          scanning ? '…' : '↻',
                        ),
                      ),
              /*
               * 模型库规模 + 选中模型的构成。原来这一行什么都没有，
               * 于是「3 个模型里有 1 个是坏的」和「3 个都好」在界面上无法区分。
               */
              summary !== null
                ? h('div', { className: 'dsh-l2d-modelmeta' }, describeLibrary(summary))
                : null,
              active !== null
                ? h(
                    'div',
                    { className: thumb !== null ? 'dsh-l2d-modelmeta dsh-l2d-modelmeta-thumb' : 'dsh-l2d-modelmeta' },
                    /*
                     * 缩略图（方案 P1 的交付物，也是 §6.1 #1 的验收项）。
                     *
                     * 没有图时**什么都不放**（而不是放一个占位方块）：这一行的
                     * 排版原本就是纯文字，凭空多一个灰框会让「还没拍」看起来
                     * 像「加载失败」。图是加分项，不是这一行存在的理由。
                     *
                     * `alt` 走 `thumbAlt()`，它把模型名和尺寸一起写进去 ——
                     * 这个面板是给用户看的，不是给读屏软件念一串 id 的。
                     */
                    thumb !== null
                      ? h('img', {
                          className: 'dsh-l2d-thumb',
                          src: thumb.dataUrl,
                          alt: thumbAlt(active),
                          width: 48,
                          height: 48,
                          draggable: false,
                        })
                      : null,
                    `${active.name}${describeModel(active) !== '' ? ` · ${describeModel(active)}` : ''}`,
                  )
                : null,
              pickNote !== null
                ? h('div', { className: 'dsh-l2d-saymeta', 'data-err': '1' }, pickNote)
                : null,
              /*
               * 导入、音色、参数绑定、口型字幕都搬去了「设置 → Live2D 桌宠」
               * （§13.35）。这里只留一句指路：卡片是「看她」的地方，配置不该在
               * 268px 宽的窗口里滚三屏。
               */
              h(
                'div',
                { className: 'dsh-l2d-saymeta' },
                '导入模型包、音色、参数绑定、口型字幕在「设置 → Live2D 桌宠」里。',
              ),
              /*
               * 问题清单。`error` 让模型整个不可用，`warn` 只是不完整 ——
               * 两者必须长得不一样，否则「红色」会很快失去意义。
               */
              activeProblems.length > 0
                ? h(
                    'div',
                    { className: 'dsh-l2d-problems' },
                    activeProblems.slice(0, 6).map((p, i) => h(
                      'div',
                      { key: `${p.code}-${i}`, className: 'dsh-l2d-problem', 'data-level': p.level },
                      `${p.level === 'error' ? '✕' : '!'} ${p.message}`,
                      p.detail ? h('span', { className: 'dsh-l2d-problemdetail' }, ` — ${p.detail}`) : null,
                    )),
                    activeProblems.length > 6
                      ? h('div', { className: 'dsh-l2d-problem', 'data-level': 'warn' }, `…还有 ${activeProblems.length - 6} 条`)
                      : null,
                  )
                : null,
              /*
               * 「和桌宠对话」（§13.36）。替换了原来那个「让桌宠说一句」的输入框 ——
               * 同一个位置、同一块宽度，但它不再是「念这段字」，而是「跟她说一句话」：
               * 那句话进会话，她那边想一句，再从她嘴里说出来。
               */
              h(PetChatSection, {}),
              h(
                'div',
                {
                  className: 'dsh-l2d-saymeta',
                  'data-err': speech.lastError === null ? '0' : '1',
                  // 降级不是错误，但也不是正常状态 —— 单独一种颜色，用户才能一眼看出
                  // 「她的声音变了」是有人替她做了决定，而不是她坏了。
                  'data-warn': speech.degraded && speech.lastError === null ? '1' : '0',
                },
                describeSpeech(speech),
              ),
              /*
               * 口型幅度与字幕搬去了「设置 → Live2D 桌宠」。这里只留音量形态相关
               * 的说话入口 —— 卡片是「看她」的地方，滑杆不该和舞台抢宽度。
               */
              /*
               * 微动作留在这里（用户 2026-10-20 的选择）：它是「看效果」的东西 ——
               * 点一下就让这一条演一遍，改完立刻能看见，搬到设置页反而要多跳一层。
               */
              h(MicroMotionSection, {}),
              ),
            ),
        /*
         * 右下角的拉角：只在**展开的**浮动形态出现。
         * 收起时它是错误的手势 —— 一条横条没有「变大」这件事，而拉角画在
         * 横条的右下角还会盖住「展开」按钮。
         */
        win.mode === 'float' && !collapsed
          ? h('div', {
              className: 'dsh-l2d-grip',
              title: '拖动改变窗口大小',
              onPointerDown: beginDrag('resize'),
              onPointerMove: onDragMove,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
            })
          : null,
      ),
    );
  }

  /**
   * 面板里的「参数绑定」一节。
   *
   * 为什么用 `<details>` 而不是自己造折叠：原生元素自带键盘可达性和展开状态，
   * 而且**默认折叠** —— 这一段有 17 行选择框，用户不点它就一点高度都不占。
   *
   * 三件事必须在这一节里看得见，否则用户改了也不知道有没有用：
   *   - 每个角色**不绑定时会被选中**的自动候选（写成「自动（ParamX）」）；
   *   - 绑了但本模型没有那个参数（`bindingMissing`，红字 + ✕）—— 这是最危险的
   *     一种，因为它的症状是「点了开心、她的眼睛没笑」，而日志里一切正常；
   *   - Host 拒绝了哪几条（`ignored`）—— 「我明明存了却没生效」的答案在这里。
   */
  function BindingsSection() {
    const [view, setView] = useState<BindingsView | null>(null);
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);

    const adopt = useCallback((next: BindingsView) => {
      setView(next);
      const saved: Record<string, string> = {};
      for (const item of next.roles) if (item.bound !== '') saved[item.role] = item.bound;
      setDraft(saved);
    }, []);

    const load = useCallback(async () => {
      try {
        adopt(await fetchBindings());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, [adopt]);

    useEffect(() => {
      void load();
    }, [load]);

    const save = useCallback(async (payload: Record<string, string>) => {
      setBusy(true);
      setNotice('');
      try {
        adopt(await saveBindings(payload));
        const count = Object.keys(payload).length;
        setNotice(count === 0 ? '已全部恢复自动' : `已保存 ${count} 条`);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }, [adopt]);

    // Host 还没重启时这条路由不存在 —— 不要把整个面板拖垮，说清楚就好。
    if (error !== null) {
      return h('div', { className: 'dsh-l2d-saymeta', 'data-err': '1' }, `参数绑定不可用：${error}`);
    }
    if (view === null) return h('div', { className: 'dsh-l2d-saymeta' }, '参数绑定：读取中…');

    /*
     * 这个数字容易被误读成「还差 18 条没做完」。它其实数的是**手动**绑定：
     * 18 行里绝大多数靠 `ROLE_PARAMETER_IDS` 的候选表自动生效，不需要人管。
     * 所以摘要行报的是三件事：
     *   手动 = 有人在设置里点名绑了；
     *   自动 = 没点名、但候选表里有这个参数（正常状态，通常是 18）；
     *   本模型没有 = 候选表里的参数这个模型一个都没有（这时候才需要人管）。
     */
    const boundCount = view.roles.filter((item) => item.bound !== '').length;
    const autoCount = view.roles.filter((item) => item.bound === '' && item.resolved !== '').length;
    const noneCount = view.roles.filter((item) => item.resolved === '').length;
    const missing = view.roles.filter((item) => item.bindingMissing);
    const collect = () => {
      const payload: Record<string, string> = {};
      for (const item of view.roles) {
        const value = draft[item.role] ?? '';
        if (value !== '') payload[item.role] = value;
      }
      return payload;
    };

    return h(
      'details',
      { className: 'dsh-l2d-bindings' },
      h('summary', { className: 'dsh-l2d-bindsummary' },
        `参数绑定（手动 ${boundCount} · 自动 ${autoCount}${noneCount > 0 ? ` · 本模型没有 ${noneCount}` : ''}）`),
      h(
        'div',
        { className: 'dsh-l2d-saymeta' },
        view.parameters.length === 0
          ? '模型还没上报参数清单 —— 先等它加载完。'
          : `本模型有 ${view.parameters.length} 个可绑参数；留空 = 自动挑一个候选。`,
      ),
      missing.length > 0
        ? h(
            'div',
            { className: 'dsh-l2d-saymeta', 'data-err': '1' },
            `有 ${missing.length} 条绑定在本模型上不存在：${missing.map((item) => `${item.label}→${item.bound}`).join('，')}`,
          )
        : null,
      view.ignored.length > 0
        ? h(
            'div',
            { className: 'dsh-l2d-saymeta', 'data-warn': '1' },
            `Host 忽略了 ${view.ignored.length} 条：${view.ignored.map((item) => `${item.role}=${item.reason}`).join('，')}`,
          )
        : null,
      view.roles.map((item) => h(
        'div',
        { key: item.role, className: 'dsh-l2d-row' },
        h('label', { htmlFor: `dsh-l2d-bind-${item.role}` }, item.label),
        h(
          'select',
          {
            id: `dsh-l2d-bind-${item.role}`,
            className: 'dsh-l2d-select',
            value: draft[item.role] ?? '',
            onChange: (event: { target: { value: string } }) => {
              const value = event.target.value;
              setDraft((prev) => ({ ...prev, [item.role]: value }));
            },
          },
          /*
           * `auto` 是空串时**不要**写成 `自动（）` —— Host 那边特意把 null 统一成空串
           * （面板拿它直接当 <option value> 用），所以这里的判空也必须是空串。
           */
          h('option', { key: '__auto', value: '' }, item.auto === '' ? '自动（本模型没有候选）' : `自动（${item.auto}）`),
          view.parameters.map((id) => h('option', { key: id, value: id }, id)),
        ),
        h(
          'span',
          { className: 'dsh-l2d-gainval', 'data-err': item.bindingMissing ? '1' : '0' },
          item.bindingMissing
            ? '✕ 本模型没有'
            : item.resolved === ''
              ? '本模型没有'
              : (item.source === 'binding' ? '绑定生效' : '按候选表'),
        ),
      )),
      h(
        'div',
        { className: 'dsh-l2d-row' },
        h(
          'button',
          { type: 'button', className: 'dsh-l2d-btn', disabled: busy, onClick: () => void save(collect()) },
          busy ? '保存中…' : '保存',
        ),
        h(
          'button',
          { type: 'button', className: 'dsh-l2d-btn', disabled: busy, onClick: () => void save({}) },
          '全部恢复自动',
        ),
        h('span', { className: 'dsh-l2d-saymeta' }, notice),
      ),
      h(
        'div',
        { className: 'dsh-l2d-saymeta' },
        `写在 ${view.settingsPath === '' ? 'settings.json' : view.settingsPath}（${view.source}）`,
      ),
    );
  }

  /**
   * 面板里的「微动作」一节（§13.26）。
   *
   * 这一段要回答的问题只有一个：**她自己会动吗，动得像不像真的**。
   * 所以除了开关与强度，必须把「为什么是这个幅度」也写出来 —— 每一条动作
   * 后面跟着它实际要写的参数与增量（`ParamAngleZ +5.9`）。用户看一眼就知道
   * 这套参数是不是被认错了，而不是靠「感觉她最近有点僵」去猜。
   *
   * 三件不能藏的事：
   *   · **这个模型认出了哪些部位**（`roles`）与**缺了哪些**（`missing`）——
   *     「她的头不会歪」的答案在这里，不是 bug；
   *   · **包是什么时候生成的**：换过模型之后还显示旧时间戳，说明该点「重新生成」；
   *   · Host 拒绝时的原话（`message` / `detail`）—— 「只有三条能用」的原因在这里。
   */
  interface MicroMotionFailure {
    message: string;
    code: string;
    retryable: boolean;
  }

  function asMicroMotionFailure(err: unknown): MicroMotionFailure {
    if (err instanceof MicroMotionError) {
      return { message: err.message, code: err.code, retryable: err.retryable };
    }
    return { message: err instanceof Error ? err.message : String(err), code: '', retryable: false };
  }

  type EmotionLayerReadout = { name: string; weight: number; residue: boolean };
  type AmbientDriftReadout = { enabled: boolean; roles: number; maxAmp: number; damped: boolean };

  /**
   * 状态行上的数值读数（§13.33）。
   *
   * 为什么单独写一个函数而不是塞进模板串：这三项各自「什么时候该显示」都不一样 ——
   * 情绪没了就整段消失（不许留一个「情绪：无」），余波单独一段（它不是主情绪），
   * 游移没有情绪时也照样可以显示（它正是「没有情绪时的那点活动」）。
   */
  function describeReadout(layers: EmotionLayerReadout[], drift: AmbientDriftReadout | null): string {
    const parts: string[] = [];
    const main = layers.filter((layer) => layer.residue !== true);
    const residue = layers.filter((layer) => layer.residue === true);
    if (main.length > 0) {
      parts.push(`情绪 ${main.map((layer) => `${layer.name} ${layer.weight.toFixed(2)}`).join(' + ')}`);
    }
    if (residue.length > 0) {
      parts.push(`余 ${residue.map((layer) => `${layer.name} ${layer.weight.toFixed(2)}`).join(' + ')}`);
    }
    if (drift !== null && drift.enabled && drift.roles > 0) {
      parts.push(`游移 ±${drift.maxAmp.toFixed(2)}${drift.damped ? '（40%）' : ''}`);
    }
    return parts.join(' · ');
  }

  /** 等模型上报清单时的自动重试：20 次 × 1.2 秒（覆盖刷新后模型加载那段窗口）。 */
  const MICRO_MOTION_RETRY_LIMIT = 20;

  /**
   * 「和桌宠对话」那一节（§13.36）。
   *
   * 与「说一句」的区别：那句话**不是直接念的**，而是先送进会话里，由她那边
   * 想一句再念出来 —— 所以这里要显示三样东西：说过什么、她正在想、这句到底
   * 有没有送到（`transport`）。
   *
   * 轮询节奏分两档：她正在想时 1.5 秒看一眼（等待感），安静时 6 秒（不白烧 CPU）。
   * 句子少，两秒一次的差别只体现在「她突然开口」与「她晚两秒开口」之间。
   */
  function PetChatSection() {
    const [view, setView] = useState<PetChatView | null>(null);
    const [draft, setDraft] = useState('');
    const [notice, setNotice] = useState('');
    const [sending, setSending] = useState(false);

    const load = useCallback(async () => {
      try {
        setView(await fetchChat());
      } catch (err) {
        setNotice(`对话读不到：${err instanceof Error ? err.message : String(err)}`);
      }
    }, []);

    useEffect(() => {
      void load();
    }, [load]);

    useEffect(() => {
      const period = view?.waiting === true ? 1500 : 6000;
      const timer = setInterval(() => {
        void load();
      }, period);
      return () => clearInterval(timer);
    }, [load, view?.waiting]);

    const onSend = useCallback(async () => {
      const text = draft.trim();
      if (text === '' || sending) return;
      setDraft('');
      setSending(true);
      setNotice('');
      // 解挂 AudioContext 必须在**用户手势的同步上下文里**：等 fetch 回来再 resume
      // 已经不是手势上下文了，Chromium 会拒绝，症状是「点了没反应、也没报错」。
      void getSpeechPlayer().warmUp();
      const result = await sendChat(text);
      setSending(false);
      if (!result.ok) setNotice(`这句没送到她那边：${result.message}`);
      void load();
    }, [draft, sending, load]);

    const items = (view?.items ?? []).slice(-8);
    const waiting = view?.waiting === true;

    return h(
      'div',
      { className: 'dsh-l2d-chat' },
      items.length === 0
        ? h('div', { className: 'dsh-l2d-saymeta' }, '还没说过话。打一句，她会用自己的声音回你。')
        : h(
            'div',
            { className: 'dsh-l2d-chatlist' },
            items.map((item) => h(
              'div',
              { key: `${item.seq}`, className: 'dsh-l2d-chatline', 'data-role': item.role },
              h('span', { className: 'dsh-l2d-chatrole' }, item.role === 'pet' ? '她' : '你'),
              h('span', { className: 'dsh-l2d-chattext' }, item.text),
            )),
          ),
      h(
        'div',
        { className: 'dsh-l2d-say' },
        h('input', {
          className: 'dsh-l2d-input',
          value: draft,
          placeholder: waiting ? '她正在想…' : '跟她说点什么…',
          onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
          onKeyDown: (event: { key?: string }) => {
            if (event.key === 'Enter') void onSend();
          },
        }),
        h(
          'button',
          { type: 'button', className: 'dsh-l2d-btn', onClick: () => void onSend(), disabled: sending || draft.trim() === '' },
          sending ? '送出中' : '说',
        ),
      ),
      h(
        'div',
        {
          className: 'dsh-l2d-saymeta',
          'data-err': notice !== '' ? '1' : '0',
          'data-warn': waiting ? '1' : '0',
        },
        notice !== ''
          ? notice
          : (waiting
            ? `她正在想（${view?.waitingText ?? ''}）…`
            : (view?.canInject === false
              ? '这个 Host 没有会话服务，她收不到话。'
              : (view?.summary ?? '对话：读取中…'))),
      ),
    );
  }

  function MicroMotionSection() {
    const [view, setView] = useState<MicroMotionView | null>(null);
    const [error, setError] = useState<MicroMotionFailure | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [notice, setNotice] = useState('');
    const [strength, setStrength] = useState(0.75);
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);

    const adopt = useCallback((next: MicroMotionView) => {
      setView(next);
      setStrength(next.strength);
      setDirty(false);
      setError(null);
      setAttempt(0);
    }, []);

    const load = useCallback(async () => {
      try {
        adopt(await fetchMicroMotions());
      } catch (err) {
        setError(asMicroMotionFailure(err));
      }
    }, [adopt]);

    useEffect(() => {
      void load();
    }, [load]);

    /*
     * 只对「等一会儿就好」的那一类自动重试。
     *
     * 为什么需要：页面一刷新，这一节往往比模型的加载先跑（挂载时 Host 还会因为
     * `stage-booting` 主动把清单清空一次），第一把必然是 `E_MICRO_NO_CAPABILITIES`。
     * 第一版把它当成终态写成「不可用」，于是一个纯粹的时间差被说成了一个错误。
     */
    useEffect(() => {
      if (error === null || !error.retryable || attempt >= MICRO_MOTION_RETRY_LIMIT) return undefined;
      const timer = setTimeout(() => {
        setAttempt((value) => value + 1);
        void load();
      }, 1200);
      return () => clearTimeout(timer);
    }, [error, attempt, load]);

    const commit = useCallback(async (payload: { strength?: number; enabled?: Record<string, boolean> }) => {
      setBusy(true);
      setNotice('');
      try {
        adopt(await saveMicroMotions(payload));
        setNotice('已保存');
      } catch (err) {
        setError(asMicroMotionFailure(err));
      } finally {
        setBusy(false);
      }
    }, [adopt]);

    const regenerate = useCallback(async () => {
      setBusy(true);
      setNotice('');
      try {
        adopt(await generateMicroMotions());
        setNotice('已按当前模型重新生成');
      } catch (err) {
        setError(asMicroMotionFailure(err));
      } finally {
        setBusy(false);
      }
    }, [adopt]);

    if (error !== null && error.retryable && attempt < MICRO_MOTION_RETRY_LIMIT) {
      return h(
        'div',
        { className: 'dsh-l2d-saymeta' },
        `微动作：还在等模型上报能力清单（第 ${attempt + 1} 次询问，模型一挂上就自动出现）。`,
      );
    }
    if (error !== null) {
      return h(
        'div',
        { className: 'dsh-l2d-saymeta', 'data-err': '1' },
        error.retryable
          ? `微动作还取不到：${error.message}`
          : `微动作不可用：${error.message}`,
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-l2d-btn',
            onClick: () => {
              setAttempt(0);
              void load();
            },
          },
          '重试',
        ),
      );
    }
    if (view === null) return h('div', { className: 'dsh-l2d-saymeta' }, '微动作：读取中…');

    const idleCount = view.gestures.filter((item) => item.modes.includes('idle')).length;
    const talkCount = view.gestures.filter((item) => item.modes.includes('talk')).length;
    const enabledCount = view.gestures.filter((item) => item.enabled).length;

    return h(
      'details',
      { className: 'dsh-l2d-bindings' },
      h('summary', { className: 'dsh-l2d-bindsummary' },
        `微动作（${view.gestures.length} 条 · 启用 ${enabledCount} · 待机 ${idleCount} · 说话 ${talkCount}）`),
      h('div', { className: 'dsh-l2d-saymeta' }, view.summary === '' ? '还没有摘要。' : view.summary),
      h(
        'div',
        { className: 'dsh-l2d-saymeta' },
        view.roles.length === 0
          ? '这个模型一个可动部位都没认出来 —— 微动作不会生效。'
          : `认出 ${view.roles.length} 个部位；模型多了/换了之后点「重新生成」。生成于 ${view.generatedAtText === '' ? '未知' : view.generatedAtText}（来源 ${view.source === '' ? '未知' : view.source}）。`,
      ),
      view.missing.length > 0
        ? h(
          'div',
          { className: 'dsh-l2d-saymeta', 'data-warn': '1' },
          `本模型没有这些部位${view.substitutions.length > 0 ? '（已按下面的借力补上）' : '（对应动作已跳过）'}：${view.missing.join('，')}`,
        )
        : null,
      view.substitutions.length > 0
        ? h(
          'div',
          { className: 'dsh-l2d-saymeta' },
          `缺的部位按这几条借力：${view.substitutions
            .map((item) => `${item.from}→${item.to} ×${item.ratio}`)
            .join('，')}（幅度按借力比例折算）`,
        )
        : null,
      h(
        'div',
        { className: 'dsh-l2d-row' },
        h('label', { htmlFor: 'dsh-l2d-micro-strength' }, '整体强度'),
        h('input', {
          id: 'dsh-l2d-micro-strength',
          className: 'dsh-l2d-range',
          type: 'range',
          min: '0.2',
          max: '1.4',
          step: '0.05',
          value: String(strength),
          onChange: (event: { target: { value: string } }) => {
            const next = Number(event.target.value);
            if (isFinite(next)) {
              setStrength(next);
              setDirty(true);
            }
          },
        }),
        h('span', { className: 'dsh-l2d-gainval' }, `${strength.toFixed(2)}`),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-l2d-btn',
            disabled: busy || !dirty,
            onClick: () => void commit({ strength }),
          },
          busy ? '保存中…' : '应用强度',
        ),
      ),
      h(
        'div',
        { className: 'dsh-l2d-row' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-l2d-btn',
            disabled: busy,
            // 重生成得到的是全新包（全部启用）；这一句必须说出来，否则「我关掉的怎么又开了」。
            title: '按当前模型重新生成一整套；已经关掉的条目会恢复启用',
            onClick: () => void regenerate(),
          },
          busy ? '生成中…' : '重新生成',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-l2d-btn',
            disabled: busy,
            onClick: () => {
              const enabled: Record<string, boolean> = {};
              for (const item of view.gestures) enabled[item.id] = true;
              void commit({ enabled });
            },
          },
          '全部启用',
        ),
        h('span', { className: 'dsh-l2d-saymeta' }, notice),
      ),
      view.gestures.map((item) => h(
        'div',
        { key: item.id, className: 'dsh-l2d-row' },
        h(
          'label',
          { className: 'dsh-l2d-check' },
          h('input', {
            type: 'checkbox',
            checked: item.enabled,
            onChange: (event: { target: { checked: boolean } }) => {
              const enabled: Record<string, boolean> = {};
              for (const other of view.gestures) enabled[other.id] = other.id === item.id ? event.target.checked === true : other.enabled;
              void commit({ enabled });
            },
          }),
          item.label,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-l2d-btn',
            // 与开关无关：关掉的是「自动播放挑不挑它」，不是这一下。
            title: '现在就让这一条演一遍（不影响开关）',
            onClick: () => {
              setNotice('');
              void playMicroMotion(item.id).then((result) => {
                setNotice(result.ok ? `让她演了一次「${result.label}」` : `没演成：${result.message}`);
              });
            },
          },
          '试演',
        ),
        h(
          'span',
          { className: 'dsh-l2d-saymeta' },
          `${item.modes.join('/')}${item.tags.length > 0 ? ` · ${item.tags.join('/')}` : ''} · ${describeMicroMotionParts(item)}`,
        ),
      )),
    );
  }

  /**
   * 一条微动作在面板上的「动了什么」摘要。
   *
   * 第一版这一行列的是**全部参数**，长到会换三行，而用户真正想知道的是「这条动作
   * 是不是只有头在动」—— 所以现在先说段数（§13.32：每条 3–4 段）、再说总处数，
   * 最后只列主段的头三根参数。
   */
  function describeMicroMotionParts(item: MicroMotionGestureView): string {
    const parts = Array.isArray(item.parts) ? item.parts : [];
    if (parts.length === 0) return '没有可动的部位';
    const total = parts.reduce((sum, part) => sum + Object.keys(part.params ?? {}).length, 0);
    const primary = parts[0]?.params ?? {};
    const first = Object.keys(primary).slice(0, 3)
      .map((id) => `${id} ${primary[id] >= 0 ? '+' : ''}${primary[id].toFixed(1)}`)
      .join('，');
    return `${parts.length} 段 / ${total} 处${first === '' ? '' : `（主段 ${first}）`}`;
  }



  /** 下拉框里「自定义」那一项的 value（不是合法音色 id，所以不会与清单撞）。 */
  const CUSTOM_VOICE_OPTION = '::custom::';

  /** 语速下拉的档位。太密没意义（人耳分不出 ±2%），太宽会选到听不懂的速度。 */
  const RATE_OPTIONS = ['-30%', '-20%', '-10%', '+0%', '+10%', '+20%', '+30%'];

  /**
   * 面板里的「音色」一节 —— 「让 TTS 换一种音色说话」的唯一入口。
   *
   * 三个设计点，每个都在防一种具体的「看起来好了其实没生效」：
   *   · **试听用的是待保存的值**：用户正在挑声音，此刻每一次点击都不该改掉默认；
   *   · **来源必须写出来**（`默认` / `settings.json`）——「我明明选了云希，
   *     念出来还是晓晓」的第一嫌疑就是设置没落到 Host 真正在看的那个文件里，
   *     而这句话正好指出去哪儿看；
   *   · **notes 必须显示**：Host 读到坏字段时会说「ttsVoice 不合法，已忽略」，
   *     藏起来的话用户永远不知道自己的配置被跳过了（这也是他刚才那个问题的答案：
   *     「我改的为什么没生效」）。
   */
  function VoiceToneSection() {
    const [view, setView] = useState<TtsSettingsView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [voice, setVoice] = useState('');
    const [rate, setRate] = useState('+0%');
    const [custom, setCustom] = useState('');
    const [engine, setEngine] = useState('edge');
    const [endpoint, setEndpoint] = useState('');
    const [probeText, setProbeText] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState('');
    /*
     * 「本地 TTS 一键」的三块状态，与引擎选择分开存：
     * `local` 是 Host 探测到的**事实**（端口、目录），`localText` 是给用户看的
     * **一句话结论**，`localBusy` 只在按钮上转圈。分开的理由是它们刷新频率不同 ——
     * 用户每点一次按钮，事实要重探，结论要重写，而输入框里的地址不该被顺手覆盖。
     */
    const [local, setLocal] = useState<LocalTtsStatusView | null>(null);
    const [localText, setLocalText] = useState('');
    const [localBusy, setLocalBusy] = useState(false);
    /*
     * 「用哪一份」：装了多个整合包时（v5 / 旧包 / 两份不同权重），选错就等于用错权重。
     * 所以这里不替用户猜死，而是把探测到的目录与 yaml 摆成两个下拉，默认落在
     * Host 的 `selected` 上（它优先朴素名 `tts_infer.yaml`）。
     */
    const [localRoot, setLocalRoot] = useState('');
    const [localConfig, setLocalConfig] = useState('');
    /*
     * 音色包的三块状态。
     *
     * `packPath` 是导入时填的路径 —— 必须留在输入框里，不能导入完就清空：
     * 用户常常要连导两三个包（同一个文件夹下的），清空等于逼他每次重打。
     */
    const [packPath, setPackPath] = useState('');
    const [packText, setPackText] = useState('');
    const [packBusy, setPackBusy] = useState(false);

    const load = useCallback(async () => {
      setBusy(true);
      try {
        const next = await fetchTts();
        setView(next);
        setVoice(next.voice);
        setRate(next.rate);
        setEngine(next.engine);
        setEndpoint(next.endpoint);
        setProbeText('');
        setCustom(next.voices[0]?.custom === true ? next.voice : '');
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }, []);

    useEffect(() => {
      void load();
    }, [load]);

    const targetVoice = voice === CUSTOM_VOICE_OPTION ? custom.trim() : voice;
    const picked = view === null ? undefined : view.voices.find((option) => option.id === targetVoice);
    const targetLabel = picked === undefined ? targetVoice : picked.label;
    const isCustom = engine === 'custom';

    /**
     * 「测试连接」：请 **Host** 去探那个地址。
     *
     * 为什么不在面板里 `fetch` 它：跨源 + 本地服务不带 CORS 头，浏览器会拦；
     * 而 Host 探通了，`/speak` 就真的能合成 —— 同一个网络栈，结论可信。
     */
    const probe = useCallback(async () => {
      setProbeText('正在探测…');
      try {
        const result = await probeTtsEndpoint(endpoint.trim());
        setProbeText(result.reachable
          ? `连通了：HTTP ${result.status} · ${result.elapsedMs}ms（GET 有响应即算通，405 也算）`
          : `连不上：${result.code ?? '探不通'} ${result.message ?? ''}`.trim());
      } catch (err) {
        setProbeText(err instanceof Error ? err.message : String(err));
      }
    }, [endpoint]);

    /** 把探测结果写成一句人话：端口状态 + 安装位置 + 「下一步点哪个」。 */
    const describeLocal = useCallback((status: LocalTtsStatusView): string => {
      const engine = status.ports.engine.listening ? '在跑' : '没跑';
      const adapter = status.ports.adapter.listening ? '在跑' : '没跑';
      const first = status.installs[0];
      /*
       * 「当前选」说的是 `selected`（Host 按 query → settings → 默认解出来的那一份），
       * 不是 `installs[0]`。§13.28 之前这里写的是第一处安装，于是用户把下拉框拨到
       * v5 之后，这一行仍在说 v2 —— 面板自己给了两个互相矛盾的答案。
       */
      const chosen = status.selected;
      const chosenRoot = chosen === null ? first?.root ?? '' : chosen.root;
      const chosenConfig = chosen === null ? first?.config ?? '' : chosen.config;
      const where = first === undefined
        ? '没找到 GPT-SoVITS 安装目录'
        : `${status.installs.length > 1 ? `${status.installs.length} 处安装，当前选 ` : ''}${chosenRoot}（yaml：${chosenConfig === '' ? '没找到' : chosenConfig}）`;
      /* 刚才选的目录不在探测结果里：Host 退回了第一处，必须说出来，否则像「选择没生效」。 */
      const fellBack = typeof status.requestedRoot === 'string' && status.requestedRoot !== ''
        ? `（刚才选的 ${status.requestedRoot} 不在探测结果里，已退回）`
        : '';
      /*
       * 结论必须带「下一步」。只报状态的话，用户看到「9880 没跑」仍然不知道
       * 该去装模型、还是该点启动、还是地址填错了 —— 那正是他来找这个开关的原因。
       */
      const next = status.ports.adapter.listening
        ? '下一步：点「填入地址并测试」'
        : (first === undefined
          ? '下一步：装好 GPT-SoVITS，或用环境变量 DSH_GSV_ROOT 指过去'
          : '下一步：点「启动本地服务」（首次加载模型约 10 秒）');
      return `9880 ${engine} · 9881 ${adapter} · ${where}${fellBack}。${next}`;
    }, []);

    /** 探测结束后把两个下拉对齐到「实际会被用到的那一份」。 */
    const applyLocalPick = useCallback((status: LocalTtsStatusView) => {
      const selected = status.selected;
      const root = selected?.root ?? status.installs[0]?.root ?? '';
      setLocalRoot(root);
      const install = status.installs.find((entry) => entry.root === root);
      setLocalConfig(selected?.config ?? install?.config ?? install?.configs[0] ?? '');
    }, []);

    /**
     * 用户一拨下拉框就把选择存进 settings.json（§13.28）。
     *
     * 保存失败不打断操作：面板上的选择仍然生效（启动时会带着它去），
     * 只是下次刷新会忘 —— 所以要说一句，而不是静默。
     */
    const rememberPick = useCallback(async (root: string, config: string) => {
      const saved = await selectLocalTts(root, config);
      if (!saved.ok) setLocalText(`选择没存进设置：${saved.message}（这一次启动仍会用它）`);
    }, []);

    const scanLocal = useCallback(async () => {
      setLocalBusy(true);
      try {
        /* 带上当前的两份：Host 会照这个校验并回声，不再用「默认那处」覆盖面板（§13.28）。 */
        const status = await fetchLocalTts(localRoot, localConfig);
        setLocal(status);
        setLocalText(describeLocal(status));
        applyLocalPick(status);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLocalText(`检测失败：${message}${message.includes('404') ? '（Host 还是旧代码？重启 DSH 再看）' : ''}`);
      } finally {
        setLocalBusy(false);
      }
    }, [applyLocalPick, describeLocal, localConfig, localRoot]);

    const startLocal = useCallback(async () => {
      setLocalBusy(true);
      setLocalText(`正在启动…（${localRoot === '' ? '默认安装' : localRoot}${localConfig === '' ? '' : ` › ${localConfig}`}；首次加载模型约 10 秒，之后端口才会起来）`);
      try {
        const result = await controlLocalTts('start', 'all', { root: localRoot, config: localConfig });
        const names = (result.started ?? []).map((entry) => `${entry.name}（pid ${entry.pid}）`).join(' / ');
        setLocal(result.status ?? null);
        if (result.status !== undefined) applyLocalPick(result.status);
        setLocalText(`已拉起 ${names === '' ? '服务' : names}。等 10 秒左右再点「检测本机」看端口。`);
      } catch (err) {
        setLocalText(`启动失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLocalBusy(false);
      }
    }, [applyLocalPick, localConfig, localRoot]);

    const stopLocal = useCallback(async () => {
      setLocalBusy(true);
      try {
        const result = await controlLocalTts('stop', 'all');
        const stopped = result.stopped ?? [];
        const skipped = result.skipped ?? [];
        setLocal(result.status ?? null);
        if (stopped.length === 0) {
          /*
           * 一句「没有需要停的」在这里是反话：用户刚看到 9880 上有个进程在跑
           * （上一轮扫描会显示它），现在又说没有 —— §13.24 的真机反馈。
           * 所以不写结论，只写证据：谁在听、pid 多少、为什么不算我的。
           */
          const listened = skipped.filter((entry) => entry.portListening !== false);
          setLocalText(listened.length === 0
            ? '9880 / 9881 上都没有服务在跑，不需要停。'
            : `${listened.map(describeSkippedEntry).join('；')}。要停它请去它自己的窗口。`);
        } else {
          const note = skipped.length === 0 ? '' : `；${skipped.map(describeSkippedEntry).join('；')}`;
          setLocalText(`已停止 ${stopped.map(describeStoppedEntry).join(' / ')}${note}`);
        }
      } catch (err) {
        setLocalText(`停止失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLocalBusy(false);
      }
    }, []);

    /**
     * 「填入地址并测试」：一次点击同时做两件事。
     *
     * 分开做成两个按钮的话，新手的顺序几乎总是错的（先试听、再发现地址是空的）。
     * 这里把「地址该是什么」由 Host 探测结果给出，用户不需要知道 9881 这个数字。
     */
    const fillLocal = useCallback(async () => {
      const target = local?.suggestedEndpoint ?? 'http://127.0.0.1:9881/tts';
      setEndpoint(target);
      setNotice('');
      setProbeText(`正在探测 ${target}…`);
      try {
        const result = await probeTtsEndpoint(target);
        setProbeText(result.reachable
          ? `连通了：HTTP ${result.status} · ${result.elapsedMs}ms（已填入 ${target}，接着点「试听」）`
          : `连不上：${result.code ?? '探不通'} ${result.message ?? ''}（已填入 ${target}）`.trim());
      } catch (err) {
        setProbeText(err instanceof Error ? err.message : String(err));
      }
    }, [local]);

    /**
     * 音色包：启用 / 导入 / 删除 / 听参考音。
     *
     * 这些操作**不重新拉 `/tts`**，只把返回的清单贴回面板 —— 重新拉会把地址、
     * 探测结论一起重置，用户在「填了地址还没保存」的状态下点一下音色包，
     * 就等于把自己的输入清掉。这是同一类错误：**一次操作不该改掉别的输入**。
     */
    const applyPacks = useCallback((listing: TtsVoicePackListing, active: string) => {
      setView((prev) => (prev === null ? prev : { ...prev, voicePacks: listing, voicePack: active }));
    }, []);

    const activatePack = useCallback(async (id: string) => {
      setPackBusy(true);
      setPackText('');
      try {
        const result = await controlVoicePack('activate', { id });
        applyPacks(result.listing, result.voicePack);
        const name = result.listing.packs.find((entry) => entry.id === result.voicePack)?.name ?? result.voicePack;
        if (id === '') {
          setPackText(result.restartRequired
            ? '已取消音色包。但上一个包换过模型，引擎里跑的还是它 —— 要真的回到默认声音，去上面的「本地服务」点「停止」再「启动」。'
            : '已取消音色包：回到适配层自己配的默认音色。');
          return;
        }
        const switched = result.switched === null
          ? ''
          : `（换入 ${result.switched.version} 模型，${Math.round(result.switched.bytes / 1024 / 1024)}MB，${result.switched.elapsedMs}ms）`;
        setPackText(`已启用「${name}」${switched} —— 下一句就用这个嗓子（不用重启服务）。`);
      } catch (err) {
        setPackText(`启用失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPackBusy(false);
      }
    }, [applyPacks]);

    const importPack = useCallback(async () => {
      const source = packPath.trim();
      if (source === '') {
        setPackText('先填一个文件夹或 .zip 的路径（文件夹里要有 voice.json + 参考音）');
        return;
      }
      setPackBusy(true);
      setPackText('正在导入…');
      try {
        const result = await controlVoicePack('import', { path: source });
        applyPacks(result.listing, result.voicePack);
        const just = result.pack;
        if (just === null) {
          setPackText('导入完成。');
          return;
        }
        /*
         * 这个版本只显示带训练模型的包（`voice-scope.ts`）。导入一个只有参考音的包
         * 不会失败 —— Host 照收，只是它不出现在列表里，所以必须在这里说出来，
         * 否则用户会以为导入没生效、反复点。
         */
        setPackText(just.weights === null
          ? `已导入「${just.name}」，但它没有训练好的模型（没有 weights 段）—— `
            + '这个版本只显示带模型的包，它已被隐藏（代码还在，开关打开就会回来）。'
          : `已导入「${just.name}」（${just.weights.version === '' ? '版本待服务端识别' : just.weights.version} · `
            + `${Math.max(1, Math.round(just.weights.bytes / 1024 / 1024))} MB）。点「启用」就把模型换进服务。`);
      } catch (err) {
        setPackText(`导入失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPackBusy(false);
      }
    }, [applyPacks, packPath]);

    const removePack = useCallback(async (id: string) => {
      setPackBusy(true);
      setPackText('');
      try {
        const result = await controlVoicePack('remove', { id });
        applyPacks(result.listing, result.voicePack);
        setPackText(`已删除 ${id}。`);
      } catch (err) {
        setPackText(`删除失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPackBusy(false);
      }
    }, [applyPacks]);

    const auditionPack = useCallback(async (id: string, name: string) => {
      setPackBusy(true);
      setPackText(`正在播「${name}」的参考音…`);
      try {
        await auditionVoicePack(id);
        setPackText(`这是「${name}」的参考音（她以后说话会像这一段）。`);
      } catch (err) {
        setPackText(`播放失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPackBusy(false);
      }
    }, []);

    /*
     * 切到「自定义 TTS 服务」时自动探一次：用户点开这一节就该看到现实，
     * 而不是先面对一个空状态、再自己找按钮。
     */
    useEffect(() => {
      if (!isCustom || local !== null || localBusy) return;
      void scanLocal();
    }, [isCustom, local, localBusy, scanLocal]);

    const audition = useCallback(async () => {
      setNotice('');
      if (isCustom) {
        if (endpoint.trim() === '') {
          setNotice('自定义服务要先填地址');
          return;
        }
      } else if (targetVoice === '') {
        setNotice('先选一个音色（或手写一个 ShortName）');
        return;
      }
      setBusy(true);
      try {
        await auditionTtsVoice(
          isCustom ? '' : targetVoice,
          rate,
          isCustom ? '本地 TTS' : (targetLabel === '' ? targetVoice : targetLabel),
          isCustom ? { engine: 'custom', endpoint: endpoint.trim() } : undefined,
        );
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }, [targetVoice, rate, targetLabel, isCustom, endpoint]);

    const save = useCallback(async () => {
      setNotice('');
      if (isCustom) {
        if (endpoint.trim() === '') {
          setNotice('自定义服务要先填地址');
          return;
        }
        if (!/^https?:\/\//i.test(endpoint.trim())) {
          setNotice('地址要以 http:// 或 https:// 开头');
          return;
        }
      } else if (targetVoice === '') {
        setNotice('先选一个音色（或手写一个 ShortName）');
        return;
      }
      setBusy(true);
      try {
        /*
         * 切回 Edge 时**不清掉地址**：下次想用本地服务时它还在。
         * `voice` 只在 Edge 下才送 —— 本地服务那边音色由服务自己决定，
         * 送一个 `zh-CN-*ShortName` 过去只会让用户以为「面板的音色对本地服务也生效」。
         */
        const next = await saveTts({
          rate,
          engine,
          endpoint: endpoint.trim(),
          voice: isCustom ? undefined : targetVoice,
        });
        setView(next);
        setVoice(next.voice);
        setRate(next.rate);
        setEngine(next.engine);
        setEndpoint(next.endpoint);
        setNotice(next.engine === 'custom'
          ? `已保存：本地 TTS · ${next.endpoint}`
          : `已保存：${next.voiceLabel} · ${next.rate}`);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }, [targetVoice, rate, isCustom, endpoint, engine]);

    /*
     * Host 还没重启时这条路由不存在（404）。与「语音包」那一节同样的措辞：
     * 说清楚是「没加载新代码」而不是「你的音色选错了」。
     */
    if (error !== null) {
      return h(
        'div',
        { className: 'dsh-l2d-saymeta', 'data-err': '1' },
        `音色设置不可用：${error}${error.includes('404') ? '（Host 还是旧代码？重启 DSH 再看）' : ''}`,
      );
    }
    if (view === null) return h('div', { className: 'dsh-l2d-saymeta' }, '音色：读取中…');

    const rates = RATE_OPTIONS.includes(rate) ? RATE_OPTIONS : [rate, ...RATE_OPTIONS];
    const sourceText = view.voiceSource === 'settings'
      ? `settings.json${view.settingsPath === '' ? '' : `：${view.settingsPath}`}`
      : '默认（还没在面板上改过）';
    const engineOptions = view.engines.length > 0
      ? view.engines
      : [{ id: 'edge', label: 'Edge-TTS', note: '' }, { id: 'custom', label: '自定义 TTS 服务', note: '' }];
    /*
     * 只显示「带训练权重」的包（`voice-scope.ts`）。正在生效的零样本包**照样显示**：
     * 隐藏它就等于让用户没法从面板上取消，只能去改 settings.json —— 看见的和
     * 机器里跑的不一致，比多一行字糟得多。
     */
    const scopedPacks = scopePacks(view.voicePacks.packs);

    return h(
      'details',
      { className: 'dsh-l2d-voices dsh-l2d-tone' },
      h(
        'summary',
        { className: 'dsh-l2d-bindsummary' },
        `音色（${isCustom ? '本地 TTS' : view.voiceLabel} · ${view.rate}）`,
      ),
      /*
       * 引擎在最上面：它决定了下面哪些行有意义。
       * 一个「选本地服务」的开关要是排在音色下拉之后，用户会先把音色挑好，
       * 再切引擎，然后发现刚挑的音色白挑了。
       */
      h(
        'div',
        { className: 'dsh-l2d-row' },
        h('span', { className: 'dsh-l2d-gainval' }, '引擎'),
        h(
          'select',
          {
            className: 'dsh-l2d-select',
            'data-role': 'tts-engine',
            value: engine,
            onChange: (event: { target: { value: string } }) => {
              setEngine(typeof event?.target?.value === 'string' ? event.target.value : 'edge');
              setNotice('');
              setProbeText('');
            },
          },
          engineOptions.map((option) => h('option', { key: option.id, value: option.id, title: option.note }, option.label)),
        ),
      ),
      isCustom
        ? h(
            'div',
            { className: 'dsh-l2d-row' },
            h('span', { className: 'dsh-l2d-gainval' }, '地址'),
            h('input', {
              className: 'dsh-l2d-input',
              'data-role': 'tts-endpoint',
              placeholder: 'http://127.0.0.1:9880/tts',
              value: endpoint,
              onChange: (event: { target: { value: string } }) => {
                setEndpoint(typeof event?.target?.value === 'string' ? event.target.value : '');
                setNotice('');
                setProbeText('');
              },
            }),
            h('button', {
              type: 'button',
              className: 'dsh-l2d-btn',
              'data-role': 'tts-probe',
              disabled: busy || endpoint.trim() === '',
              onClick: () => void probe(),
            }, '测试连接'),
          )
        : null,
      isCustom
        ? h(
          'div',
          { className: 'dsh-l2d-localtts' },
          /*
           * 文字引导放在按键**上面**：先告诉他要做几步，再给按钮。反过来（按钮在上）
           * 新手会先点「启动」，然后在一个还没装模型的机器上得到一句看不懂的报错。
           */
          h('div', { className: 'dsh-l2d-saymeta' },
            '本地 TTS 三步：装好模型 → 点「启动本地服务」→ 点「填入地址并测试」，然后「试听」「保存」。'
            + '服务收 POST JSON {text, voice, rate}，回 wav/mp3 字节或 {audioBase64}。'),
          /*
           * 装了多个整合包时，用哪一份不能替用户猜（v5 与旧包、或两份不同权重的微调）。
           * 两个下拉的来源只有「检测本机」的探测结果；没探测到就整段不出现 ——
           * 空下拉比没有更糟（用户会以为点了没反应）。
           */
          local === null || local.installs.length === 0
            ? null
            : h(
              'div',
              { className: 'dsh-l2d-row' },
              h('span', { className: 'dsh-l2d-gainval' }, '用哪份'),
              h(
                'select',
                {
                  className: 'dsh-l2d-select',
                  'data-role': 'tts-local-root',
                  value: localRoot,
                  onChange: (event: { target: { value: string } }) => {
                    const next = typeof event?.target?.value === 'string' ? event.target.value : '';
                    setLocalRoot(next);
                    const install = (local?.installs ?? []).find((entry) => entry.root === next);
                    const nextConfig = install?.config ?? install?.configs[0] ?? '';
                    setLocalConfig(nextConfig);
                    void rememberPick(next, nextConfig);
                  },
                },
                local.installs.map((install) => h(
                  'option',
                  { key: install.root, value: install.root, title: install.python },
                  install.root,
                )),
              ),
              h(
                'select',
                {
                  className: 'dsh-l2d-select',
                  'data-role': 'tts-local-config',
                  value: localConfig,
                  onChange: (event: { target: { value: string } }) => {
                    const nextConfig = typeof event?.target?.value === 'string' ? event.target.value : '';
                    setLocalConfig(nextConfig);
                    void rememberPick(localRoot, nextConfig);
                  },
                },
                (local?.installs.find((entry) => entry.root === localRoot)?.configs ?? []).map((name) => h(
                  'option',
                  { key: name, value: name },
                  name,
                )),
              ),
            ),
          h(
            'div',
            { className: 'dsh-l2d-row' },
            h('button', {
              type: 'button',
              className: 'dsh-l2d-btn',
              'data-role': 'tts-local-scan',
              disabled: localBusy,
              onClick: () => void scanLocal(),
            }, localBusy ? '…' : '检测本机'),
            h('button', {
              type: 'button',
              className: 'dsh-l2d-btn',
              'data-role': 'tts-local-start',
              disabled: localBusy,
              onClick: () => void startLocal(),
            }, '启动本地服务'),
            h('button', {
              type: 'button',
              className: 'dsh-l2d-btn',
              'data-role': 'tts-local-stop',
              disabled: localBusy,
              onClick: () => void stopLocal(),
            }, '停止'),
            h('button', {
              type: 'button',
              className: 'dsh-l2d-btn',
              'data-role': 'tts-local-fill',
              disabled: localBusy,
              onClick: () => void fillLocal(),
            }, '填入地址并测试'),
          ),
          localText === ''
            ? null
            : h(
              'div',
              { className: 'dsh-l2d-saymeta', 'data-err': /失败|连不上|没找到|没有/.test(localText) ? '1' : '0' },
              localText,
            ),
          h('div', { className: 'dsh-l2d-saymeta' },
            '装在哪：默认看 D:\\GPT-SoVITS 与 D:\\GPT-SoVITSv5；装到别处就设环境变量 DSH_GSV_ROOT。'
            + '「停止」只停插件自己起的服务 —— 包括上次关闭 DSH 之前起的（靠磁盘账本与命令行认回来）；'
            + '别处手动开、命令行对不上的，它会告诉你是谁在占端口。'),
        )
        : null,
      /*
       * 音色包：换嗓子不该需要「改四行 JSON、重启服务、再猜自己是不是改对了」。
       *
       * 一个包里必须有**参考音**和**它的逐字文本** —— 零样本克隆靠的就是这两样，
       * 文本错一个字，念出来就带口音。所以这里把 `promptText` 直接印在卡片上：
       * 用户拿到别人的包时，唯一能自查的线索就是这一行。
       *
       * 卡片上三个动作的分工：启用（换嗓子，立刻生效）/ 听参考音（先确认像不像）/
       * 删除（不想要了）。删除**不做二次确认**，但删的只是这个包目录，
       * 而且删完如果它正被启用，Host 会顺手把偏好清掉 —— 不会留下一个指向空气的 id。
       */
      isCustom
        ? h(
          'div',
          { className: 'dsh-l2d-voicepacks', 'data-role': 'tts-pack-list' },
          h('div', { className: 'dsh-l2d-saymeta' },
            '音色包 = 一段参考音 + 它的逐字文本 + 训练好的模型（SoVITS + GPT）。启用会把模型换进正在跑的服务，下一句就变。'),
          scopedPacks.shown.length === 0 && scopedPacks.hiddenCount === 0
            ? h('div', { className: 'dsh-l2d-saymeta' },
              '还没有包。把一个文件夹（里面有 voice.json、一条 3~10 秒的录音，以及 weights/ 里的两份权重）的路径填在下面导入。')
            : scopedPacks.shown.map((pack) => h(
              'div',
              {
                key: pack.id,
                className: 'dsh-l2d-voiceclip',
                'data-role': 'tts-pack-item',
                'data-active': pack.active ? '1' : '0',
                'data-pack': pack.id,
              },
              h(
                'div',
                { className: 'dsh-l2d-row' },
                h('strong', {}, pack.name),
                h('span', { className: 'dsh-l2d-gainval' }, pack.active ? '✓ 正在用' : `${Math.max(1, Math.round(pack.refBytes / 1024))} KB`),
              ),
              h('div', { className: 'dsh-l2d-saymeta' },
                [pack.author === '' ? '' : `作者 ${pack.author}`, pack.license === '' ? '' : `${pack.license}`, pack.source === '' ? '' : pack.source]
                  .filter((part) => part !== '').join(' · ') || '（这个包没写作者与许可）'),
              h('div', { className: 'dsh-l2d-saymeta' }, `这段录音说的是：${pack.promptText}`),
              pack.weights === null
                ? null
                : h(
                  'div',
                  { className: 'dsh-l2d-saymeta', 'data-role': 'tts-pack-weights' },
                  `包里带了训练好的模型：${pack.weights.version === '' ? '版本待服务端识别' : pack.weights.version}`
                    + ` · ${Math.max(1, Math.round(pack.weights.bytes / 1024 / 1024))} MB`
                    + '（启用会把模型换进服务，不是只换参考音）'
                    + (pack.weights.hotSwap
                      ? ''
                      : '。这套权重是新版 PK 容器，不能热换 —— 要用下面「本地 TTS 一键」停止服务、选包里的 yaml 再启动'),
                ),
              h(
                'div',
                { className: 'dsh-l2d-row' },
                h('button', {
                  type: 'button',
                  className: 'dsh-l2d-btn',
                  'data-role': 'tts-pack-activate',
                  'data-pack': pack.id,
                  disabled: packBusy,
                  onClick: () => void activatePack(pack.active ? '' : pack.id),
                }, pack.active ? '取消启用' : '启用'),
                h('button', {
                  type: 'button',
                  className: 'dsh-l2d-btn',
                  'data-role': 'tts-pack-audition',
                  'data-pack': pack.id,
                  disabled: packBusy,
                  onClick: () => void auditionPack(pack.id, pack.name),
                }, '听参考音'),
                h('button', {
                  type: 'button',
                  className: 'dsh-l2d-btn',
                  'data-role': 'tts-pack-remove',
                  'data-pack': pack.id,
                  disabled: packBusy,
                  onClick: () => void removePack(pack.id),
                }, '删除'),
              ),
            )),
          h(
            'div',
            { className: 'dsh-l2d-row' },
            h('input', {
              className: 'dsh-l2d-input',
              'data-role': 'tts-pack-path',
              placeholder: 'D:\\voices\\my-voice 或 D:\\voices\\my-voice.zip',
              value: packPath,
              onChange: (event: { target: { value: string } }) => {
                setPackPath(typeof event?.target?.value === 'string' ? event.target.value : '');
                setPackText('');
              },
            }),
            h('button', {
              type: 'button',
              className: 'dsh-l2d-btn',
              'data-role': 'tts-pack-import',
              disabled: packBusy,
              onClick: () => void importPack(),
            }, packBusy ? '…' : '导入'),
          ),
          view.voicePacks.broken.length === 0
            ? null
            : h(
              'div',
              { className: 'dsh-l2d-saymeta', 'data-err': '1' },
              `有 ${view.voicePacks.broken.length} 个目录读不出来：${view.voicePacks.broken
                .map((entry) => `${entry.dir}（${entry.reason}）`).join('，')}`,
            ),
          scopedPacks.hiddenCount === 0 && scopedPacks.activeWhileHidden.length === 0
            ? null
            : h(
              'div',
              { className: 'dsh-l2d-saymeta', 'data-role': 'tts-pack-scope-note' },
              [
                scopedPacks.activeWhileHidden.length === 0
                  ? ''
                  : `正在生效的「${scopedPacks.activeWhileHidden.map((pack) => pack.name).join('、')}」是旧式参考音包（不带模型），`
                    + '为了让你能取消它才留在这里 —— 取消后引擎里可能还跑着换过的模型。',
                scopedPacks.hiddenCount === 0
                  ? ''
                  : `另有 ${scopedPacks.hiddenCount} 个只有参考音的音色包已隐藏（这个版本只显示带训练模型的包）。`,
              ].filter((line) => line !== '').join(' '),
            ),
          packText === ''
            ? null
            : h(
              'div',
              { className: 'dsh-l2d-saymeta', 'data-err': /失败/.test(packText) ? '1' : '0' },
              packText,
            ),
          h('div', { className: 'dsh-l2d-saymeta' },
            `包放在 ${view.voicePackRoot === '' ? 'settings.json 旁边的 voice-packs/' : view.voicePackRoot}；`
            + '一个都不启用时，她用适配层自己配的那段参考音。'),
        )
        : null,
      probeText === '' ? null : h('div', { className: 'dsh-l2d-saymeta', 'data-err': probeText.startsWith('连通了') ? '0' : '1' }, probeText),
      isCustom
        ? null
        : h(
          'div',
          { className: 'dsh-l2d-row' },
          h('span', { className: 'dsh-l2d-gainval' }, '音色'),
          h(
            'select',
            {
              className: 'dsh-l2d-select',
              'data-role': 'tts-voice',
              value: voice,
              onChange: (event: { target: { value: string } }) => {
                const next = typeof event?.target?.value === 'string' ? event.target.value : '';
                setVoice(next);
                setNotice('');
              },
            },
            view.voices.map((option) => h('option', { key: option.id, value: option.id, title: option.note }, option.label)),
            h('option', { key: CUSTOM_VOICE_OPTION, value: CUSTOM_VOICE_OPTION }, '自定义 ShortName…'),
          ),
        ),
      !isCustom && voice === CUSTOM_VOICE_OPTION
        ? h(
            'div',
            { className: 'dsh-l2d-row' },
            h('span', { className: 'dsh-l2d-gainval' }, '手写'),
            h('input', {
              className: 'dsh-l2d-input',
              'data-role': 'tts-voice-custom',
              placeholder: 'zh-CN-YunxiNeural',
              value: custom,
              onChange: (event: { target: { value: string } }) => {
                setCustom(typeof event?.target?.value === 'string' ? event.target.value : '');
                setNotice('');
              },
            }),
          )
        : null,
      h(
        'div',
        { className: 'dsh-l2d-row' },
        h('span', { className: 'dsh-l2d-gainval' }, '语速'),
        h(
          'select',
          {
            className: 'dsh-l2d-select',
            'data-role': 'tts-rate',
            value: rate,
            onChange: (event: { target: { value: string } }) => {
              setRate(typeof event?.target?.value === 'string' ? event.target.value : '+0%');
              setNotice('');
            },
          },
          rates.map((option) => h('option', { key: option, value: option }, option)),
        ),
      ),
      h(
        'div',
        { className: 'dsh-l2d-row' },
        h('button', { type: 'button', className: 'dsh-l2d-btn', disabled: busy, onClick: () => void audition() },
          busy ? '…' : '试听'),
        h('button', { type: 'button', className: 'dsh-l2d-btn', disabled: busy, onClick: () => void save() },
          '保存'),
        h('span', { className: 'dsh-l2d-saymeta', 'data-err': notice === '' ? '0' : '1' }, notice),
      ),
      view.notes.length > 0
        ? h('div', { className: 'dsh-l2d-saymeta', 'data-err': '1' }, view.notes.join('；'))
        : null,
      h('div', { className: 'dsh-l2d-saymeta' }, `当前来源：${sourceText}`),
      h('div', { className: 'dsh-l2d-saymeta' },
        isCustom
          ? '试听会用这个地址合成一句（不落盘）；点保存后，AI 说话都走这个服务。'
          : '试听用你选的声音说一句，不会改默认；点保存才写进设置。AI 自己点名的音色优先于这里。'),
    );
  }

  /**
   * 面板里的「语音包」一节。
   *
   * 它要回答的三个问题，一个都不能少：
   *   - **找的是哪里**：`voicesRoot` 有四级解析链（插件配置 / 环境变量 /
   *     settings.json / 默认目录），用户改错了文件时面板必须告诉他 Host 实际在看哪；
   *   - **有什么**：包名、目录名（AI 点播要用它）、几条、哪几条有问题；
   *   - **对不对**：点一下就能听。改完 voices.json 立刻试听，是这一节的**主要用法**。
   *
   * 坏包也照样列出来（与 `/models` 同一个道理）：只列好包会让用户以为「我建的包不见了」。
   */
  function VoiceSection() {
    const [view, setView] = useState<VoiceListView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** 正在取/播的那一条，`包目录/id`。空串 = 没有。 */
    const [playing, setPlaying] = useState('');
    const [notice, setNotice] = useState('');

    const load = useCallback(async () => {
      setBusy(true);
      try {
        setView(await fetchVoices());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }, []);

    useEffect(() => {
      void load();
    }, [load]);

    const audition = useCallback(async (pack: string, clipId: string) => {
      setPlaying(`${pack}/${clipId}`);
      setNotice('');
      try {
        await auditionVoice(pack, clipId);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setPlaying('');
      }
    }, []);

    /*
     * Host 还没重启时这条路由不存在（404）。这句话必须说清楚是「没加载新代码」
     * 而不是「你的语音包坏了」—— 两种 404 长得一模一样，而处理方式完全不同。
     */
    if (error !== null) {
      return h(
        'div',
        { className: 'dsh-l2d-saymeta', 'data-err': '1' },
        `语音包不可用：${error}${error.includes('404') ? '（Host 还是旧代码？重启 DSH 再看）' : ''}`,
      );
    }
    if (view === null) return h('div', { className: 'dsh-l2d-saymeta' }, '语音包：读取中…');

    const summary = view.summary;
    const packCount = summary?.packs ?? view.packs.length;
    const clipCount = summary?.clips ?? 0;
    const badCount = summary?.badPacks ?? 0;

    return h(
      'details',
      { className: 'dsh-l2d-voices' },
      h('summary', { className: 'dsh-l2d-bindsummary' },
        `语音包（${packCount} 包 · ${clipCount} 条${badCount > 0 ? ` · 坏包 ${badCount}` : ''}）`),
      h(
        'div',
        { className: 'dsh-l2d-saymeta' },
        view.rootExists
          ? `${view.root}`
          : `${view.root === '' ? '（默认目录）' : view.root} —— 目录不存在`,
        view.rootSource === '' ? null : h('span', { className: 'dsh-l2d-gainval' }, `（${view.rootSource}）`),
      ),
      view.error !== null ? h('div', { className: 'dsh-l2d-saymeta', 'data-err': '1' }, view.error) : null,
      packCount === 0
        ? h('div', { className: 'dsh-l2d-saymeta' }, '还没有语音包：在那个目录里建一个子目录，放音频和可选的 voices.json。')
        : null,
      view.packs.map((pack) => h(
        'div',
        { key: pack.dirName, className: 'dsh-l2d-voicepack' },
        h(
          'div',
          { className: 'dsh-l2d-row' },
          h('span', { className: 'dsh-l2d-voicepackname' }, pack.name === '' ? pack.dirName : pack.name),
          h('span', { className: 'dsh-l2d-gainval', 'data-err': pack.ok ? '0' : '1' },
            `${pack.clipCount} 条${pack.ok ? '' : ' · 有错误'}${pack.isDefault ? ' · 默认' : ''}`),
        ),
        pack.problems.length > 0
          ? h(
              'div',
              { className: 'dsh-l2d-saymeta', 'data-err': pack.ok ? '0' : '1' },
              pack.problems.slice(0, 3).map((problem) => `${problem.path ?? ''}${problem.path ? ' ' : ''}${problem.message}`).join('；'),
            )
          : null,
        pack.clips.slice(0, 12).map((clip) => h(
          'div',
          { key: clip.id, className: 'dsh-l2d-voiceclip' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-l2d-btn',
              title: clip.text === '' ? clip.id : clip.text,
              disabled: playing !== '',
              onClick: () => void audition(pack.dirName, clip.id),
            },
            playing === `${pack.dirName}/${clip.id}` ? '…' : '▶',
          ),
          h(
            'span',
            { className: 'dsh-l2d-cliptext' },
            clip.emotion === '' ? '' : `［${clip.emotion}］`,
            clip.text === '' ? clip.id : clip.text,
          ),
        )),
        pack.clips.length > 12
          ? h('div', { className: 'dsh-l2d-saymeta' }, `…还有 ${pack.clips.length - 12} 条`)
          : null,
      )),
      h(
        'div',
        { className: 'dsh-l2d-row' },
        h('button', { type: 'button', className: 'dsh-l2d-btn', disabled: busy, onClick: () => void load() },
          busy ? '刷新中…' : '刷新'),
        h('span', { className: 'dsh-l2d-saymeta', 'data-err': notice === '' ? '0' : '1' }, notice),
      ),
      h(
        'div',
        { className: 'dsh-l2d-saymeta' },
        '一个包 = 一个子目录；voices.json 可省，省了就按文件名/子目录名当情绪。',
      ),
    );
  }

  /** 设置页的骨架：一节 = 标题 +（可选）说明 + 内容。 */
  function SettingsSection(props: { title: string; hint?: string; children?: unknown[] }) {
    return h(
      'div',
      { className: 'dsh-l2d-section' },
      h('h3', null, props.title),
      props.hint === undefined ? null : h('div', { className: 'dsh-l2d-saymeta' }, props.hint),
      ...(props.children ?? []),
    );
  }

  /**
   * 设置页 → 「Live2D 桌宠」→ 模型库：清单、导入、体检结果。
   *
   * 这一整块原来在 268px 宽的桌宠卡片里（展开之后要滚三屏），而它只在「装 /
   * 换模型」的时候用一次。搬到设置页之后，卡片上只留一个下拉框（换着看），
   * 导入与体检留给这里 —— 导入失败时那一串「缺哪张图」本来就该有地方摊开说。
   */
  function SettingsModelLibrary() {
    const [models, setModels] = useState<ModelEntry[] | null>(null);
    const [summary, setSummary] = useState<LibrarySummary | null>(null);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [importing, setImporting] = useState<ImportState>(IDLE_IMPORT);
    const [progress, setProgress] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [current, setCurrent] = useState<string | null>(() => readModelPref());
    const fileRef = useRef<HTMLInputElement | null>(null);

    const reload = useCallback(async (force: boolean) => {
      setScanning(true);
      try {
        const { models: list, summary: sum } = await fetchModels(force);
        setModels(list);
        setSummary(sum);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setScanning(false);
      }
    }, []);

    useEffect(() => {
      void reload(false);
    }, [reload]);

    /*
     * 卡片那边换了模型（下拉框）之后，这里的「当前」标记要跟上。
     * 两棵树互不相识，靠 `writeModelPref()` 广播的那个事件同步。
     */
    useEffect(() => {
      const sync = () => setCurrent(readModelPref());
      window.addEventListener(MODEL_PREF_EVENT, sync);
      return () => window.removeEventListener(MODEL_PREF_EVENT, sync);
    }, []);

    /*
     * 导入。成功之后**自动切过去** —— 用户刚亲手导入了它，切过去是执行他的意图；
     * 但体检不通过（`ok === false`）就只报告、不切换：切到加载不起来的模型会
     * `release()` 掉旧模型，桌宠直接消失。
     */
    const runImport = useCallback(async (file: File) => {
      setImporting({ ...IDLE_IMPORT, phase: 'uploading', label: file.name, bytes: file.size });
      setProgress(0);
      try {
        const reply = await uploadZip(file, (sent) => {
          if (file.size > 0) setProgress(Math.min(1, sent / file.size));
        });
        const body = reply.body;
        const imported = body?.imported as Record<string, unknown> | undefined;

        if (reply.status !== 200 || body?.ok !== true || imported === undefined) {
          setImporting({
            ...IDLE_IMPORT,
            phase: 'failed',
            label: file.name,
            code: typeof body?.code === 'string' ? body.code : `HTTP_${reply.status}`,
            detail: typeof body?.detail === 'string'
              ? body.detail
              : (typeof body?.message === 'string' ? body.message : reply.text),
          });
          return;
        }

        // Host 顺手把重扫后的清单带了回来，直接用，不再多打一次 `/models`。
        const listed = Array.isArray(body?.models) ? (body.models as ModelEntry[]) : null;
        if (listed !== null) {
          setModels(listed);
          setSummary((body?.summary as LibrarySummary | undefined) ?? null);
          setError(null);
        }

        const ok = imported.ok !== false;
        const id = typeof imported.id === 'string' ? imported.id : '';
        setImporting({
          ...IDLE_IMPORT,
          phase: 'done',
          label: file.name,
          dir: typeof imported.dir === 'string' ? imported.dir : '',
          degraded: !ok,
          problems: Array.isArray(imported.problems) ? (imported.problems as ImportState['problems']) : [],
        });

        if (ok && id !== '') {
          writeModelPref(id);
          setCurrent(id);
        }
      } catch (err) {
        setImporting({
          ...IDLE_IMPORT,
          phase: 'failed',
          label: file.name,
          code: 'E_UPLOAD',
          detail: err instanceof Error ? err.message : String(err),
        });
        reportFailure('import', err);
      } finally {
        setProgress(0);
      }
    }, []);

    /** 拖进来的东西先过一遍纯函数 `acceptDrop`，它给出「收不收 / 为什么」。 */
    const onDrop = useCallback((event: { preventDefault: () => void; dataTransfer: { files: unknown } }) => {
      event.preventDefault();
      setDragging(false);
      const list = event.dataTransfer?.files as { length: number; [index: number]: File } | undefined;
      const files = list !== undefined && list !== null
        ? Array.from({ length: list.length }, (_, i) => list[i])
        : [];
      const decision = acceptDrop(files.map((f) => ({ name: f.name, size: f.size })));
      if (!decision.accept) {
        setImporting({ ...IDLE_IMPORT, phase: 'failed', label: decision.name, code: 'E_DROP_REJECTED', detail: decision.reason });
        return;
      }
      void runImport(files[0]);
    }, [runImport]);

    const onPickFile = useCallback((event: { target: { files?: { length: number; [index: number]: File } | null; value?: string } }) => {
      const list = event.target.files;
      const first = list !== null && list !== undefined && list.length > 0 ? list[0] : null;
      // 清空 value：选同一个文件两次时 change 不会触发，而「上次失败了再选一遍」是最常见的重试。
      if (event.target.value !== undefined) event.target.value = '';
      if (first !== null) void runImport(first);
    }, [runImport]);

    const rows = (models ?? []).map((model) => {
      const broken = model.ok === false;
      const isCurrent = current === model.id;
      const detail = describeModel(model);
      return h(
        'div',
        { key: model.id, className: 'dsh-l2d-modelline', 'data-broken': broken ? '1' : '0' },
        h(
          'div',
          { className: 'dsh-l2d-modelline-main' },
          h('div', { className: 'dsh-l2d-modelline-name' }, model.name),
          h(
            'div',
            { className: 'dsh-l2d-modelmeta' },
            `${isCurrent ? '当前 · ' : ''}${detail !== '' ? detail : model.id}${broken ? ' · 加载不起来' : ''}`,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-l2d-btn',
            disabled: isCurrent || broken,
            title: isCurrent ? '这只已经在舞台上了' : (broken ? '它体检不通过，切过去会让桌宠消失' : '把这一只放到舞台上'),
            onClick: () => {
              writeModelPref(model.id);
              setCurrent(model.id);
            },
          },
          isCurrent ? '当前' : '用这个',
        ),
      );
    });

    return h(
      SettingsSection,
      {
        title: '模型库',
        hint: '导入 zip / rar 模型包；导入成功后会自动切到新模型。下拉框（换着看）在桌宠卡片上。',
        children: [
          h(
            'div',
            { className: 'dsh-l2d-sectionrow' },
            summary !== null ? h('span', { className: 'dsh-l2d-modelmeta' }, describeLibrary(summary)) : null,
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-l2d-btn',
                onClick: () => void reload(true),
                disabled: scanning,
                title: '重新扫描模型库（忽略体检缓存）',
              },
              scanning ? '扫描中…' : '重新扫描',
            ),
          ),
          error !== null
            ? h('div', { className: 'dsh-l2d-err' }, error)
            : models === null
              ? h('div', { style: { opacity: .6 } }, '正在扫描模型库…')
              : models.length === 0
                ? h('div', { style: { opacity: .6 } }, '模型库是空的：把 .model3.json 所在的文件夹导入进来。')
                : h('div', { className: 'dsh-l2d-modellist' }, rows),
          h(
            'div',
            {
              className: 'dsh-l2d-drop',
              'data-drag': dragging ? '1' : '0',
              onDragOver: (event: { preventDefault: () => void; dataTransfer?: unknown }) => {
                event.preventDefault();
                if (dragging !== true) setDragging(true);
              },
              onDragLeave: () => setDragging(false),
              onDrop,
            },
            h('input', {
              key: 'file',
              ref: fileRef,
              type: 'file',
              /*
               * zip 与 rar 都收：rar 那条要 Host 那边有解包器（7-Zip / WinRAR /
               * 系统自带 tar.exe），没有时 Host 会回「这台机器上没有能解 RAR 的程序」——
               * 比在文件选择框里灰掉更能让用户知道该装什么。
               */
              accept: '.zip,.rar,application/zip,application/vnd.rar,application/x-rar-compressed',
              className: 'dsh-l2d-file',
              onChange: onPickFile,
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-l2d-btn',
                onClick: () => fileRef.current?.click(),
                disabled: isImporting(importing),
              },
              '导入模型包',
            ),
            h('span', { className: 'dsh-l2d-importhint' }, '或把 zip / rar 拖到这里'),
          ),
          isImporting(importing)
            ? h(
                'div',
                { className: 'dsh-l2d-progress' },
                h('div', { className: 'dsh-l2d-progressbar', style: { width: `${Math.round(progress * 100)}%` } }),
              )
            : null,
          importLevel(importing) !== 'none'
            ? h(
                'div',
                { className: 'dsh-l2d-saymeta', 'data-err': importLevel(importing) === 'error' ? '1' : '0' },
                describeImport(importing),
              )
            : null,
          /* 导入的包体检不通过时，把问题清单也摆出来 —— 用户需要知道缺哪张图。 */
          importing.phase === 'done' && importing.problems.length > 0
            ? h(
                'div',
                { className: 'dsh-l2d-problems' },
                importing.problems.slice(0, 6).map((p, i) => h(
                  'div',
                  { key: `imp-${p.code}-${i}`, className: 'dsh-l2d-problem', 'data-level': p.level },
                  `${p.level === 'error' ? '✕' : '!'} ${p.message}`,
                )),
              )
            : null,
        ],
      },
    );
  }

  /**
   * 设置页 → 「Live2D 桌宠」。
   *
   * 分工（用户 2026-10-20 的要求）：**桌宠卡片只负责「看她」**——舞台、说话、
   * 模型下拉、微动作（那是「看效果」的东西）；**所有「装 / 调」都在这里**：
   * 模型库与导入、口型字幕、音色、参数绑定。
   */
  function Live2DSettings() {
    const { status, error } = useHostStatus(10000);
    const [settings, updateSettings] = usePetSettings();
    return h(
      'div',
      { className: 'dsh-l2d-settings' },
      h('div', { className: 'dsh-l2d-settingstitle' }, DISPLAY_NAME),
      h(SettingsSection, {
        title: '模型库',
        hint: '导入 zip / rar，或者点一下换模型；坏掉的包会在这里说清缺什么。',
        children: [h(SettingsModelLibrary, {})],
      }),
      h(
        SettingsSection,
        { title: '口型与字幕', children: [
          /*
           * 口型增益。拖的时候不重启渲染循环 —— 增益走 ref，下一帧生效；
           * 松开鼠标才写存储（拖动时 onChange 每次都触发，同步写 localStorage 太贵）。
           */
          h(
            'div',
            { className: 'dsh-l2d-row' },
            h('label', { htmlFor: 'dsh-l2d-gain' }, '口型幅度'),
            h('input', {
              id: 'dsh-l2d-gain',
              className: 'dsh-l2d-range',
              type: 'range',
              min: String(MIN_LIP_GAIN),
              max: String(MAX_LIP_GAIN),
              step: String(LIP_GAIN_STEP),
              value: String(settings.lipGain),
              onChange: (event: { target: { value: string } }) => {
                const next = Number(event.target.value);
                if (isFinite(next)) updateSettings({ lipGain: next });
              },
            }),
            h('span', { className: 'dsh-l2d-gainval' }, describeLipGain(settings.lipGain)),
          ),
          h(
            'label',
            { className: 'dsh-l2d-check' },
            h('input', {
              type: 'checkbox',
              checked: settings.subtitles,
              onChange: (event: { target: { checked: boolean } }) => updateSettings({ subtitles: event.target.checked === true }),
            }),
            '说话时在气泡里显示台词',
          ),
        ] },
      ),
      h(VoiceToneSection, {}),
      h(BindingsSection, {}),
      /*
       * 预录台词包（「语音包」那一节）暂时隐藏 —— 见 `voice-scope.ts`。
       * 代码不删：Host 的 `/voices`、`/voice`、`/import` 三条路由与 `VoiceSection()`
       * 全都还在，把开关拨回来就原样出现。
       */
      VOICE_SCOPE.presetClips ? h(VoiceSection, {}) : null,
      h(SettingsSection, {
        title: '运行状态',
        hint: '只是「她现在怎么样」，改不了任何东西。',
        children: [h(StatusRows, { status, error })],
      }),
      h('div', { className: 'dsh-l2d-saymeta' }, '微动作（开关 / 强度 / 试演）在桌宠那张卡片上 —— 它是「看效果」的东西，不是配置。'),
    );
  }

  function installStyles(): () => void {
    const existing = document.getElementById(STYLE_ID);
    if (existing !== null) return () => {};
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
    return () => {
      style.remove?.();
    };
  }

  /**
   * 看门狗：bundle 加载成功、slot 注册成功，却因为 key 写错之类的原因一个字都没
   * 渲染出来——这种失败在别处不留任何痕迹，只能自己报。
   */
  function armWatchdog(): void {
    try {
      setTimeout(() => {
        if (!mountedOnce) {
          reportFailure('watchdog', new Error('插件已加载但浮层 8 秒内未渲染，可能是 slot 注册未生效'));
        }
      }, 8000);
    } catch {
      /* 定时器都排不上就算了 */
    }
  }

  /**
   * Cordis 插件名。loader 的 patch id 必须与它一致。
   *
   * `slots` 是必需的：不声明它，插件会**先于** slot 注册表激活，`ctx.slots` 是
   * undefined，`ctx.slots.inject(...)` 抛错，外壳的启动审计会拒绝启动整个应用。
   */
  const name = PLUGIN_NAME;
  const inject = ['slots'];

  function apply(ctx: ClientContext): void {
    armWatchdog();

    ctx.effect(() => {
      const disposers: Array<() => void> = [];

      try {
        disposers.push(installStyles());
      } catch (err) {
        reportFailure('installStyles', err);
      }

      const slots = ctx.slots;
      if (slots === undefined || slots === null) {
        reportFailure('slots-missing', new Error('ctx.slots 不存在——inject 里的 slots 没生效'));
        return () => {};
      }

      // shell.overlay：框架级浮层，默认点击穿透，条目自己开 pointer-events。
      // order 60，落在 whale-pet(90) 下面。
      try {
        disposers.push(
          slots.inject('shell.overlay', () =>
            slots.register(
              { name: 'shell.overlay', id: PLUGIN_NAME, order: 60, label: () => DISPLAY_NAME },
              () => h(Live2DOverlay, null),
            ),
          ),
        );
      } catch (err) {
        reportFailure('slots.inject(shell.overlay)', err);
      }

      try {
        disposers.push(
          slots.inject('settings.section', () =>
            slots.register(
              { name: 'settings.section', id: PLUGIN_NAME, order: 45, label: () => DISPLAY_NAME },
              () => h(Live2DSettings, null),
            ),
          ),
        );
      } catch (err) {
        reportFailure('slots.inject(settings.section)', err);
      }

      return () => {
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose();
          } catch (err) {
            reportFailure('dispose', err);
          }
        }
      };
    }, 'dsh-live2d-pet.client.lifecycle');
  }

  return { name, inject, apply };
}
