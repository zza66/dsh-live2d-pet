// src/client/part-curves.ts
var PART_OPACITY_SEGMENT = {
  linear: 0,
  bezier: 1,
  stepped: 2,
  inverseStepped: 3
};
function asNumber(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function parseMotionPartOpacity(json) {
  const root = asRecord(json);
  const meta = asRecord(root === null ? null : root["Meta"]);
  const duration = (meta === null ? null : asNumber(meta["Duration"])) ?? 0;
  const loop = meta !== null && meta["Loop"] === true;
  const beziersRestricted = meta !== null && meta["AreBeziersRestricted"] === true;
  const curves = [];
  const rawCurves = root === null ? null : root["Curves"];
  if (Array.isArray(rawCurves)) {
    for (const raw of rawCurves) {
      const curve = asRecord(raw);
      if (curve === null || curve["Target"] !== "PartOpacity") {
        continue;
      }
      const id = curve["Id"];
      const segments = curve["Segments"];
      if (typeof id !== "string" || !Array.isArray(segments)) {
        throw new Error("部件透明度曲线缺少 Id 或 Segments");
      }
      curves.push(parseCurve(id, segments));
    }
  }
  return { curves, duration, loop, beziersRestricted };
}
function parseCurve(id, segments) {
  if (segments.length < 2) {
    throw new Error(`部件透明度曲线「${id}」的段数据为空`);
  }
  const first = asNumber(segments[0]);
  const firstValue = asNumber(segments[1]);
  if (first === null || firstValue === null) {
    throw new Error(`部件透明度曲线「${id}」的起点不是数字`);
  }
  const points = [{ time: first, value: firstValue }];
  const out = [];
  let position = 2;
  while (position < segments.length) {
    const type = asNumber(segments[position]);
    const basePointIndex = points.length - 1;
    if (type === PART_OPACITY_SEGMENT.bezier) {
      const numbers = [0, 1, 2, 3, 4, 5, 6].map((offset) => asNumber(segments[position + offset]));
      const [kind2, c1t, c1v, c2t, c2v, t2, v2] = numbers;
      if (kind2 === null || c1t === null || c1v === null || c2t === null || c2v === null || t2 === null || v2 === null) {
        throw new Error(`部件透明度曲线「${id}」的贝塞尔段不完整`);
      }
      points.push({ time: c1t, value: c1v });
      points.push({ time: c2t, value: c2v });
      points.push({ time: t2, value: v2 });
      out.push({ kind: "bezier", basePointIndex });
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
function kindOf(type) {
  if (type === PART_OPACITY_SEGMENT.linear) {
    return "linear";
  }
  if (type === PART_OPACITY_SEGMENT.stepped) {
    return "stepped";
  }
  if (type === PART_OPACITY_SEGMENT.inverseStepped) {
    return "inverseStepped";
  }
  return null;
}
function lerp(a, b, t) {
  return {
    time: a.time + (b.time - a.time) * t,
    value: a.value + (b.value - a.value) * t
  };
}
function linearEvaluate(p0, p1, time) {
  let t = (time - p0.time) / (p1.time - p0.time);
  if (t < 0) {
    t = 0;
  }
  if (!isFinite(t)) {
    t = 0;
  }
  return p0.value + (p1.value - p0.value) * t;
}
function bezierEvaluate(p0, p1, p2, p3, time) {
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
function evaluatePartOpacity(curve, time) {
  const points = curve.points;
  if (points.length === 0) {
    return 1;
  }
  if (points.length === 1) {
    return points[0].value;
  }
  for (const segment of curve.segments) {
    const last = segment.basePointIndex + (segment.kind === "bezier" ? 3 : 1);
    if (last >= points.length) {
      break;
    }
    if (points[last].time > time) {
      return evaluateSegment(points, segment, time);
    }
  }
  return points[points.length - 1].value;
}
function evaluateSegment(points, segment, time) {
  const base = segment.basePointIndex;
  const p0 = points[base];
  switch (segment.kind) {
    case "linear":
      return linearEvaluate(p0, points[base + 1], time);
    case "bezier":
      return bezierEvaluate(p0, points[base + 1], points[base + 2], points[base + 3], time);
    case "stepped":
      return p0.value;
    case "inverseStepped":
      return points[base + 1].value;
    default:
      return p0.value;
  }
}
function motionTimeAt(motion, elapsedSeconds) {
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
function partOpacitiesAt(motion, time) {
  const out = [];
  for (const curve of motion.curves) {
    out.push({ id: curve.id, opacity: evaluatePartOpacity(curve, time) });
  }
  return out;
}
export {
  PART_OPACITY_SEGMENT,
  evaluatePartOpacity,
  motionTimeAt,
  parseMotionPartOpacity,
  partOpacitiesAt
};
