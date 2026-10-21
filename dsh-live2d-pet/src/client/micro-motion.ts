/**
 * dsh-live2d-pet — 渲染端的微动作播放器（§13.26）。
 *
 * ## 与 `idle-garnish.ts` 的关系
 *
 * `idle-garnish` 是**手写给 hiyori 的**那七条（参数名与幅度都写死）。这一层是
 * **模型自己长出来的**那十几条：动作表在 Host 生成、随包下来，这里只负责排期、
 * 挑一条、按包络叠上去。两者共用同一套包络（`envelopeAt` / `garnishValues`），
 * 所以「自然」这个手感不会因为换了来源就变一半。
 *
 * 同一时刻**只跑一层**：`pet-model.ts` 在有微动作包时走这一层，没有包时才退回
 * 手写那七条。两层各演一条会同时写 `ParamAngleZ`，加法叠加会翻倍 —— 那不是
 * 「更活泼」，那是抽搐。
 *
 * ## 两档节奏
 *
 * 待机与说话分开排期（6.5–15 秒 / 4.2–9 秒）：说话时口型是主角，微动作只能
 * 是伴随；而它比待机密，是因为真人说话时头部与视线的小幅移动本来就更多。
 */

import {
  MICRO_MOTION_ABORT_DELAY_MS,
  MICRO_MOTION_MAX_DELTA,
  MICRO_MOTION_MAX_GESTURES,
  MICRO_MOTION_MAX_PART_DELAY_MS,
  MICRO_MOTION_MAX_PARTS,
  MICRO_MOTION_VERSION,
  microMotionDelayMs,
  pickMicroMotion,
} from '../../lib/host/micro-motions.js';
import { GARNISH_MAX_STEP_MS, envelopeAt } from './idle-garnish';

/** 一条微动作里的一段：晚 `delayMs` 起步，写这几根参数的增量。 */
export interface MicroMotionPart {
  delayMs: number;
  params: Record<string, number>;
}

/** 一条微动作（与 Host 生成的包逐字段一致）。 */
export interface MicroMotionGesture {
  id: string;
  label: string;
  /**
   * 多段错峰（v2，§13.32）。
   *
   * 第一版是「一个主参数 + 一个可选的 trailing」，真机上看就是「只有头在动」。
   * 现在每条 3–4 段：主部位 → 视线 → 重心 → 眉 / 呆毛，段间错开 90–460 ms。
   * 段内 `params` 是增量，空段在 Host 与这里都会被丢掉。
   */
  parts: MicroMotionPart[];
  attackMs: number;
  holdMs: number;
  releaseMs: number;
  /** 会动视线的那几条在 `look_at` 生效期间要让路。 */
  gaze: boolean;
  /** 情绪标签（`开心` / `思考`…），挑的时候按它加权。 */
  tags: string[];
  /** `['idle']` / `['talk']` / 两者都有。 */
  modes: string[];
  weight: number;
  enabled: boolean;
}

/** 一个模型的微动作包（Host 的 `GET /micro-motions` 原样下来的那份）。 */
export interface MicroMotionPack {
  version: number;
  model: string;
  name: string;
  generatedAt: number;
  strength: number;
  gestures: MicroMotionGesture[];
  roles: { role: string; label: string; id: string; source: string }[];
  missing: string[];
  /** 缺部位借力表（§13.34）：面板照实说「没有肩，借身体侧倾」。 */
  substitutions: { from: string; to: string; ratio: number }[];
}

/** 播放器状态。就地改，不产生新对象（每帧都用）。 */
export interface MicroMotionState {
  gesture: MicroMotionGesture | null;
  elapsedMs: number;
  /** 下一次该在什么时候挑（毫秒，用的是本对象的 `clockMs`）。 */
  nextAtMs: number;
  /** 只在这里累加的时钟：页面隐藏、舞台卸载期间不会白走。 */
  clockMs: number;
  lastId: string;
  count: number;
}

export function createMicroMotionState(): MicroMotionState {
  return { gesture: null, elapsedMs: 0, nextAtMs: 0, clockMs: 0, lastId: '', count: 0 };
}

/** 这一帧算出来的东西。 */
export interface MicroMotionFrame {
  values: Record<string, number>;
  /** 这一帧刚挑了一条（`id`），否则空串。 */
  started: string;
  /** 这一帧刚演完（`id`），否则空串。 */
  done: string;
}

function finite(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  const v = finite(value, 0);
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

/**
 * 把网络上来的一份包收拾成能用的形状。
 *
 * 包在 Host 那侧已经归一化过一次，但这里是**跨进程边界的第二道**：JSON 里
 * 一个 `null` 混进 `params` 会让 `addParameterValue` 静默 NaN，表现成整张脸不动。
 * 守住的规则与 Host 侧一致（不要嘴、只留有限数、条目有上限）。
 */
export function normalizeMicroMotionPack(raw: unknown): MicroMotionPack | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const list = Array.isArray(source.gestures) ? source.gestures : [];
  /*
   * 版本必须相同（§13.32）。v1 的包只有「主参数 + trailing」，幅度是现在的一半；
   * 拿它当 v2 播，用户会看到「改了没生效」。读不懂就当没有包 —— 退回首写那七条。
   *
   * 但**缺 version** 与「版本不对」是两件事：Host 与页面各自更新，中间必然有
   * 一段时间窗（新 Host 先跑、页面还是旧 bundle，或反过来）。旧版视图恰好就没带
   * `version`，严格比较会让整份包作废 —— 那一刻自动微动作与「试演」一起安静地
   * 停掉，而两边日志都正常（§13.32 的「试演没效果」就是这么来的）。
   * 所以缺版本时按**形状**认：有条目且每条都有 `parts` 就当 v2，其余照旧拒绝。
   */
  const declaredVersion = source.version === undefined || source.version === null
    ? null
    : finite(Number(source.version), 0);
  const looksLikeV2 = list.length > 0
    && list.every((item) => item !== null && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).parts));
  if (declaredVersion === null ? !looksLikeV2 : declaredVersion !== MICRO_MOTION_VERSION) return null;
  const gestures: MicroMotionGesture[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id === '') continue;
    const parts = sanitizeParts(entry.parts);
    if (parts.length === 0) continue;
    gestures.push({
      id: entry.id,
      label: typeof entry.label === 'string' ? entry.label : entry.id,
      parts,
      attackMs: Math.max(0, finite(Number(entry.attackMs), 300)),
      holdMs: Math.max(0, finite(Number(entry.holdMs), 500)),
      releaseMs: Math.max(0, finite(Number(entry.releaseMs), 500)),
      gaze: entry.gaze === true,
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      modes: Array.isArray(entry.modes)
        ? entry.modes.filter((mode): mode is string => mode === 'idle' || mode === 'talk')
        : ['idle'],
      weight: Math.max(0.1, finite(Number(entry.weight), 1)),
      enabled: entry.enabled !== false,
    });
    if (gestures.length >= MICRO_MOTION_MAX_GESTURES) break;
  }
  if (gestures.length === 0) return null;
  return {
    version: MICRO_MOTION_VERSION,
    model: typeof source.model === 'string' ? source.model : '',
    name: typeof source.name === 'string' ? source.name : '',
    generatedAt: finite(Number(source.generatedAt), 0),
    strength: Math.max(0.2, Math.min(1.4, finite(Number(source.strength), 0.9))),
    gestures,
    roles: Array.isArray(source.roles) ? (source.roles as MicroMotionPack['roles']) : [],
    missing: Array.isArray(source.missing)
      ? source.missing.filter((role): role is string => typeof role === 'string')
      : [],
    substitutions: Array.isArray(source.substitutions)
      ? (source.substitutions as MicroMotionPack['substitutions'])
        .filter((item) => item !== null && typeof item === 'object'
          && typeof item.from === 'string' && typeof item.to === 'string')
        .map((item) => ({ from: item.from, to: item.to, ratio: finite(Number(item.ratio), 0.5) }))
      : [],
  };
}

/** 段数组的第二道防线：空段丢掉、延迟夹到 0–600、段数上限 4、按延迟排序。 */
function sanitizeParts(raw: unknown): MicroMotionPart[] {
  const parts: MicroMotionPart[] = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const params = sanitizeParams(entry.params);
    if (Object.keys(params).length === 0) continue;
    parts.push({
      delayMs: Math.max(0, Math.min(MICRO_MOTION_MAX_PART_DELAY_MS, finite(Number(entry.delayMs), 0))),
      params,
    });
    if (parts.length >= MICRO_MOTION_MAX_PARTS) break;
  }
  parts.sort((left, right) => left.delayMs - right.delayMs);
  return parts;
}

function sanitizeParams(raw: unknown): Record<string, number> {
  const params: Record<string, number> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return params;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== 'string' || id === '') continue;
    if (id === 'ParamMouthOpenY' || id === 'ParamMouthForm') continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    // 与 Host 侧同一个上限：**参数自己的单位**（±30 度的角度、±1 的眼睛都盖得住）。
    params[id] = Math.max(-MICRO_MOTION_MAX_DELTA, Math.min(MICRO_MOTION_MAX_DELTA, value));
  }
  return params;
}

export interface MicroMotionOptions {
  /** 这一帧过了多少毫秒（`delta` 秒 × 1000）。 */
  deltaMs: number;
  pack: MicroMotionPack | null;
  /** 说话中就按说话档挑。 */
  mode: 'idle' | 'talk';
  /** 此刻在脸上活着的情绪名（喂给 `pickMicroMotion` 加权）。 */
  emotions: string[];
  /** `look_at` 生效期间为 false —— 会动视线的那几条要让路。 */
  allowGaze: boolean;
  /** 外层的全局折扣（思考时「收着点」）。 */
  factor: number;
  /**
   * 现在不该叠这层（正在播正经动作）。
   *
   * 与 `idle-garnish` 一样：被打断就当场撤掉 —— 留着的话下一秒正经动作还在播，
   * 它俩会往同一批参数上做加法。撤掉之后退避 3 秒再重新排。
   */
  paused?: boolean;
  /** 随机源（门禁注入固定序列）。 */
  random?: () => number;
}

/**
 * 推一帧。
 *
 * 排期规则与待机小动作一致，只有三处不同：
 *   1. 间隔按 `mode` 取两档之一；
 *   2. 挑的时候把**当前情绪**与**上一条**一起传进去（情绪匹配加权、刚播过的降权）；
 *   3. 强度乘在包络上（`pack.strength`），面板一拉就整体变轻/变重。
 */
export function microMotionValues(state: MicroMotionState, options: MicroMotionOptions): MicroMotionFrame {
  const frame: MicroMotionFrame = { values: {}, started: '', done: '' };
  const pack = options.pack;
  if (pack === null || pack.gestures.length === 0) {
    if (state.gesture !== null) {
      state.gesture = null;
      state.elapsedMs = 0;
    }
    return frame;
  }
  const rawMs = finite(options.deltaMs, 0);
  const step = rawMs > GARNISH_MAX_STEP_MS ? GARNISH_MAX_STEP_MS : Math.max(0, rawMs);
  state.clockMs += step;

  // 忙（正经动作在播）就只走时钟，不叠参数。
  if (options.paused === true) {
    if (state.gesture !== null) {
      state.gesture = null;
      state.elapsedMs = 0;
    }
    if (state.nextAtMs <= 0 || state.nextAtMs < state.clockMs) {
      state.nextAtMs = state.clockMs + MICRO_MOTION_ABORT_DELAY_MS;
    }
    return frame;
  }

  const random = typeof options.random === 'function' ? options.random : Math.random;
  const strength = Math.max(0.2, Math.min(1.4, finite(pack.strength, 0.9)));

  if (state.gesture !== null) {
    const gesture = state.gesture;
    /*
     * 多段错峰（§13.32）：每一段都用同一条 attack/hold/release 包络，只是起点晚
     * `delayMs` —— 所以它读起来是「一次连续的动作里后到的部位」，不是两下动作。
     *
     * 时间轴按**整条动作**走（`state.elapsedMs`），而不是每段各持一个计时器：
     * 段只是 `elapsedMs - delayMs` 上的一个投影，这样「演完」只有一个判据
     * （`totalMs`），暂停/换模型时也只清一个状态。
     */
    const totalMs = microMotionTotalMs(gesture);
    state.elapsedMs = Math.min(state.elapsedMs + step, totalMs);
    const scaleBase = clamp01(options.factor) * clamp01(strength);
    if (scaleBase > 0) {
      const values: Record<string, number> = {};
      for (const part of gesture.parts) {
        const scale = scaleBase * envelopeAt(gesture, state.elapsedMs - part.delayMs);
        if (scale <= 0) continue;
        for (const id of Object.keys(part.params)) {
          const amount = part.params[id] * scale;
          if (amount !== 0) values[id] = (values[id] ?? 0) + amount;
        }
      }
      frame.values = values;
    }
    if (state.elapsedMs >= totalMs) {
      frame.done = gesture.id;
      state.gesture = null;
      state.elapsedMs = 0;
      state.nextAtMs = state.clockMs + microMotionDelayMs(options.mode, random);
    }
    return frame;
  }

  if (state.nextAtMs <= 0) {
    state.nextAtMs = state.clockMs + microMotionDelayMs(options.mode, random);
    return frame;
  }
  if (state.clockMs < state.nextAtMs) return frame;

  const chosen = pickMicroMotion(pack, {
    mode: options.mode,
    emotions: options.emotions,
    allowGaze: options.allowGaze,
    avoidId: state.lastId,
    random,
  });
  if (chosen === null) {
    state.nextAtMs = state.clockMs + microMotionDelayMs(options.mode, random);
    return frame;
  }
  state.gesture = chosen as MicroMotionGesture;
  state.elapsedMs = 0;
  state.lastId = chosen.id;
  state.count += 1;
  frame.started = chosen.id;
  return frame;
}

/** 正在演的这条叫什么（诊断用）。 */
export function microMotionName(state: MicroMotionState): string {
  return state.gesture === null ? '' : state.gesture.id;
}

/**
 * 立刻起演某一条（§13.30 的「试演」）。
 *
 * 三条刻意的决定：
 *  - **不看 `enabled`**：那是「自动播放挑不挑它」的开关，显式点名是另一回事。
 *    用户关掉「歪头」是因为不想它自己冒出来，不是因为按钮坏了。
 *  - **不写 `nextAtMs`**：演完由 `microMotionValues` 的 done 分支接管节奏。
 *    在这里提前排期会把「试演之后紧接着的那次自动播放」推后一整个间隔。
 *  - **找不到就返回 `null`**：调用方（`PetModel.playMicroMotion`）要能把
 *    「这个 id 不存在」变成 `E_MICRO_UNKNOWN_GESTURE` 回给 Host —— 假成功
 *    是这条链上最难查的一类错。
 */
export function startMicroMotion(
  state: MicroMotionState,
  pack: MicroMotionPack | null,
  id: string,
): MicroMotionGesture | null {
  if (pack === null) return null;
  const wanted = typeof id === 'string' ? id.trim() : '';
  if (wanted === '') return null;
  const gesture = pack.gestures.find((entry) => entry.id === wanted);
  if (gesture === undefined) return null;
  state.gesture = gesture;
  state.elapsedMs = 0;
  state.lastId = gesture.id;
  state.count += 1;
  return gesture;
}

/**
 * 一条动作的总时长（毫秒），与 Host 的 `microMotionTotalMs` 同一算法：
 * **最后一段的延迟** + 包络三段。不是「各段时长之和」—— 它们重叠在一起。
 */
export function microMotionTotalMs(gesture: MicroMotionGesture): number {
  let lead = 0;
  for (const part of gesture.parts) {
    const delay = Math.max(0, finite(part.delayMs, 0));
    if (delay > lead) lead = delay;
  }
  return envelopeTotal(gesture) + lead;
}

function envelopeTotal(gesture: MicroMotionGesture): number {
  return Math.max(0, finite(gesture.attackMs, 0))
    + Math.max(0, finite(gesture.holdMs, 0))
    + Math.max(0, finite(gesture.releaseMs, 0));
}

export { envelopeAt };
