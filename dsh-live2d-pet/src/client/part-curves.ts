/**
 * 动作文件（`.motion3.json`）里的「部件透明度」曲线 —— `Target: "PartOpacity"`。
 *
 * ## 为什么需要这个模块（2026-02，第四次「静默失效」）
 *
 * Framework 的 `CubismMotion` **确实读了**这些曲线，但它把它们当成**参数**去写
 * （`framework/src/motion/cubismmotion.ts:620-639`）：
 *
 * ```ts
 * parameterIndex = model.getParameterIndex(curves[c].id);
 * model.setParameterValueByIndex(parameterIndex, value);
 * ```
 *
 * 部件 id（例如 `PartArmA`）不是参数 id，于是：
 * 1. `framework/src/model/cubismmodel.ts:610-635` 的 `getParameterIndex()` 找不到它，
 *    就现发一个「不存在的参数下标」（≥ 参数个数）并记进 `_notExistParameterId`；
 * 2. 同文件 `:731-765` 的 `setParameterValueByIndex()` 一看这个下标在
 *    `_notExistParameterValues` 里，就把值**存进那张 Map 然后立刻返回** —— 值永远
 *    到不了 `_parameterValues`，永远到不了渲染器，**也永远不报错**。
 *
 * 读回来是对称的（`:702-703` 也从那张 Map 读），所以连「写进去又读出来」的自检都
 * 看不出问题。全框架里唯一会认真写部件透明度的是 `CubismPose`
 * （`framework/src/effect/cubismpose.ts`），而它需要 `Pose.json` —— 本库四个模型
 * 都没有。
 *
 * ⇒ **动作里的部件切换曲线，在这个框架里是一条死代码。**
 *
 * hiyori 的「四只手」就是这么来的：它 10 段动作里每段都带 `PartArmA` / `PartArmB`
 * 两条曲线，负责说明「这一段该露哪一双手臂」，而两个部件出厂不透明度都是 1。
 * 曲线被丢掉 ⇒ 两套手臂同时可见。
 *
 * ## 这个模块做什么
 *
 * 把曲线读出来，逐帧自己应用（`CubismModel.setPartOpacityById()` 是公开 API，
 * 不必改 `framework/`，而 `tools/sync-vendor.mjs --check` 也要求它逐字节未改动）。
 * 求值语义逐行对齐 Framework 自己的四个求值函数（`cubismmotion.ts:63-202`），
 * 包括段内取点的边界规则（`evaluateCurve()`，同文件 `:204-253`）。
 *
 * **已知偏差**：贝塞尔段这里只实现 `bezierEvaluate()`（de Casteljau，x 域不做反解），
 * 那是 `Meta.AreBeziersRestricted === true` 时 Framework 走的那条；若某个动作把它
 * 声明成 false，Framework 会改用 `bezierEvaluateCardanoInterpretation()`
 * （同文件 `:166-191`）。本库 14 个动作文件全部声明了 `true`，门禁会在
 * 样本库里出现非 restricted 的动作时变红，所以这条偏差不会悄悄生效。
 */

/** 曲线上的一个控制点。语义与 `framework/src/motion/cubismmotioninternal.ts:38-41` 一致。 */
export type PartOpacityPoint = {
  time: number;
  value: number;
};

/** 段类型。数字取自 `framework/src/motion/cubismmotioninternal.ts:26-31`。 */
export const PART_OPACITY_SEGMENT = {
  linear: 0,
  bezier: 1,
  stepped: 2,
  inverseStepped: 3,
} as const;

export type PartOpacitySegmentKind = keyof typeof PART_OPACITY_SEGMENT;

/**
 * 一个段。
 *
 * `basePointIndex` 是**段内第一个点在 `points` 里的下标**：线性/阶梯/反阶梯段各往
 * `points` 里追加 1 个点，贝塞尔段追加 3 个（两个控制点 + 终点）。
 * 这与 Framework 的 `CubismMotionSegment.basePointIndex` 是同一个约定
 * （`cubismmotion.ts:978-979` 与 `:995-1032`）。
 */
export type PartOpacitySegment = {
  kind: PartOpacitySegmentKind;
  basePointIndex: number;
};

/** 一条部件透明度曲线。 */
export type PartOpacityCurve = {
  /** 部件 id，例如 `PartArmA`。 */
  id: string;
  /** 全部控制点：第 0 个是起点，之后每个段追加自己的点。 */
  points: PartOpacityPoint[];
  segments: PartOpacitySegment[];
};

/** 一个动作里与部件透明度有关的全部内容。 */
export type MotionPartOpacity = {
  curves: PartOpacityCurve[];
  /** `Meta.Duration`，秒。拿不到就是 0（此时不按时间取模）。 */
  duration: number;
  /** `Meta.Loop`。 */
  loop: boolean;
  /** `Meta.AreBeziersRestricted`。false 表示贝塞尔求值有上面那条已知偏差。 */
  beziersRestricted: boolean;
};

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * 解析一个动作里所有的 `PartOpacity` 曲线。
 *
 * **会抛**（`Error`）：段数据不足以构成一个完整段、或段类型不是 0/1/2/3 时。
 * 调用方应当捕获并上报 —— 悄悄跳过一条读不懂的曲线，正是这个模块要终结的那种错误。
 */
export function parseMotionPartOpacity(json: unknown): MotionPartOpacity {
  const root = asRecord(json);
  const meta = asRecord(root === null ? null : root['Meta']);
  const duration = (meta === null ? null : asNumber(meta['Duration'])) ?? 0;
  const loop = meta !== null && meta['Loop'] === true;
  const beziersRestricted = meta !== null && meta['AreBeziersRestricted'] === true;

  const curves: PartOpacityCurve[] = [];
  const rawCurves = root === null ? null : root['Curves'];
  if (Array.isArray(rawCurves)) {
    for (const raw of rawCurves) {
      const curve = asRecord(raw);
      if (curve === null || curve['Target'] !== 'PartOpacity') {
        continue;
      }
      const id = curve['Id'];
      const segments = curve['Segments'];
      if (typeof id !== 'string' || !Array.isArray(segments)) {
        throw new Error('部件透明度曲线缺少 Id 或 Segments');
      }
      curves.push(parseCurve(id, segments));
    }
  }

  return { curves, duration, loop, beziersRestricted };
}

function parseCurve(id: string, segments: unknown[]): PartOpacityCurve {
  if (segments.length < 2) {
    throw new Error(`部件透明度曲线「${id}」的段数据为空`);
  }
  const first = asNumber(segments[0]);
  const firstValue = asNumber(segments[1]);
  if (first === null || firstValue === null) {
    throw new Error(`部件透明度曲线「${id}」的起点不是数字`);
  }
  const points: PartOpacityPoint[] = [{ time: first, value: firstValue }];
  const out: PartOpacitySegment[] = [];
  let position = 2;
  while (position < segments.length) {
    const type = asNumber(segments[position]);
    const basePointIndex = points.length - 1;
    if (type === PART_OPACITY_SEGMENT.bezier) {
      const numbers = [0, 1, 2, 3, 4, 5, 6].map((offset) => asNumber(segments[position + offset]));
      const [kind, c1t, c1v, c2t, c2v, t, v] = numbers;
      if (
        kind === null ||
        c1t === null ||
        c1v === null ||
        c2t === null ||
        c2v === null ||
        t === null ||
        v === null
      ) {
        throw new Error(`部件透明度曲线「${id}」的贝塞尔段不完整`);
      }
      points.push({ time: c1t, value: c1v });
      points.push({ time: c2t, value: c2v });
      points.push({ time: t, value: v });
      out.push({ kind: 'bezier', basePointIndex });
      position += 7;
      continue;
    }
    const kind = kindOf(type);
    if (kind === null) {
      throw new Error(`部件透明度曲线「${id}」出现未知段类型 ${String(segments[position])}`);
    }
    const t = asNumber(segments[position + 1]);
    const v = asNumber(segments[position + 2]);
    if (t === null || v === null) {
      throw new Error(`部件透明度曲线「${id}」的段数据不完整`);
    }
    points.push({ time: t, value: v });
    out.push({ kind, basePointIndex });
    position += 3;
  }

  return { id, points, segments: out };
}

function kindOf(type: number | null): PartOpacitySegmentKind | null {
  if (type === PART_OPACITY_SEGMENT.linear) {
    return 'linear';
  }
  if (type === PART_OPACITY_SEGMENT.stepped) {
    return 'stepped';
  }
  if (type === PART_OPACITY_SEGMENT.inverseStepped) {
    return 'inverseStepped';
  }
  return null;
}

function lerp(a: PartOpacityPoint, b: PartOpacityPoint, t: number): PartOpacityPoint {
  return {
    time: a.time + (b.time - a.time) * t,
    value: a.value + (b.value - a.value) * t,
  };
}

/** `framework/src/motion/cubismmotion.ts:63-71`。 */
function linearEvaluate(p0: PartOpacityPoint, p1: PartOpacityPoint, time: number): number {
  let t = (time - p0.time) / (p1.time - p0.time);
  if (t < 0) {
    t = 0;
  }
  if (!isFinite(t)) {
    t = 0;
  }
  return p0.value + (p1.value - p0.value) * t;
}

/** `framework/src/motion/cubismmotion.ts:73-88`（de Casteljau，x 域不做反解）。 */
function bezierEvaluate(
  p0: PartOpacityPoint,
  p1: PartOpacityPoint,
  p2: PartOpacityPoint,
  p3: PartOpacityPoint,
  time: number,
): number {
  let t = (time - p0.time) / (p3.time - p0.time);
  if (t < 0) {
    t = 0;
  }
  if (!isFinite(t)) {
    t = 0;
  }
  const p01 = lerp(p0, p1, t);
  const p12 = lerp(p1, p2, t);
  const p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  return lerp(p012, p123, t).value;
}

/**
 * 求一条曲线在 `time` 秒处的值。
 *
 * 段的选择规则照抄 `framework/src/motion/cubismmotion.ts:204-253`：逐段看**该段
 * 最后一个点**的时间，第一个「结束时间大于 time」的段就是目标段；一个都没命中
 * （时间在曲线之后）就取最后一个点的值。
 */
export function evaluatePartOpacity(curve: PartOpacityCurve, time: number): number {
  const points = curve.points;
  if (points.length === 0) {
    return 1;
  }
  if (points.length === 1) {
    return points[0].value;
  }
  for (const segment of curve.segments) {
    const last = segment.basePointIndex + (segment.kind === 'bezier' ? 3 : 1);
    if (last >= points.length) {
      break;
    }
    if (points[last].time > time) {
      return evaluateSegment(points, segment, time);
    }
  }
  return points[points.length - 1].value;
}

function evaluateSegment(
  points: PartOpacityPoint[],
  segment: PartOpacitySegment,
  time: number,
): number {
  const base = segment.basePointIndex;
  const p0 = points[base];
  switch (segment.kind) {
    case 'linear':
      return linearEvaluate(p0, points[base + 1], time);
    case 'bezier':
      return bezierEvaluate(p0, points[base + 1], points[base + 2], points[base + 3], time);
    case 'stepped':
      return p0.value;
    case 'inverseStepped':
      return points[base + 1].value;
    default:
      return p0.value;
  }
}

/**
 * 把「这个动作已经播了多久」换算成曲线时间。
 *
 * 循环动作取模、非循环动作在末尾夹住；`elapsedSeconds` 为负或 NaN 时按 0 处理。
 * `duration <= 0` 时原样返回（拿不到时长就不敢猜周期）。
 */
export function motionTimeAt(motion: MotionPartOpacity, elapsedSeconds: number): number {
  let t = elapsedSeconds;
  if (!(t > 0)) {
    t = 0;
  }
  if (motion.duration > 0) {
    if (motion.loop) {
      t = t % motion.duration;
    } else if (t > motion.duration) {
      t = motion.duration;
    }
  }
  return t;
}

/** 一个动作在某一时刻应该写进各部件的全部不透明度。 */
export function partOpacitiesAt(
  motion: MotionPartOpacity,
  time: number,
): Array<{ id: string; opacity: number }> {
  const out: Array<{ id: string; opacity: number }> = [];
  for (const curve of motion.curves) {
    out.push({ id: curve.id, opacity: evaluatePartOpacity(curve, time) });
  }
  return out;
}
