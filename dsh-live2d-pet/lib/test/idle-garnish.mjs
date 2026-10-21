// src/client/idle-garnish.ts
var GARNISH_GESTURES = Object.freeze([
  Object.freeze({
    id: "glance-left",
    params: Object.freeze({
      ParamEyeBallX: -0.5,
      ParamEyeBallY: 0.05
    }),
    attackMs: 150,
    holdMs: 620,
    releaseMs: 520,
    gaze: true,
    trailing: Object.freeze({
      delayMs: 120,
      params: Object.freeze({
        ParamAngleX: -12,
        ParamAngleZ: -2
      })
    })
  }),
  Object.freeze({
    id: "glance-right",
    params: Object.freeze({
      ParamEyeBallX: 0.5,
      ParamEyeBallY: 0.05
    }),
    attackMs: 150,
    holdMs: 620,
    releaseMs: 520,
    gaze: true,
    trailing: Object.freeze({
      delayMs: 120,
      params: Object.freeze({
        ParamAngleX: 12,
        ParamAngleZ: 2
      })
    })
  }),
  Object.freeze({
    id: "glance-up",
    params: Object.freeze({
      ParamEyeBallY: 0.45
    }),
    attackMs: 170,
    holdMs: 500,
    releaseMs: 620,
    gaze: true,
    trailing: Object.freeze({
      delayMs: 120,
      params: Object.freeze({
        ParamAngleY: 10,
        ParamAngleX: 3
      })
    })
  }),
  Object.freeze({
    id: "glance-down",
    params: Object.freeze({
      ParamEyeBallY: -0.4
    }),
    attackMs: 190,
    holdMs: 520,
    releaseMs: 600,
    gaze: true,
    trailing: Object.freeze({
      delayMs: 120,
      params: Object.freeze({
        ParamAngleY: -8,
        ParamAngleZ: -1.5
      })
    })
  }),
  Object.freeze({
    id: "brow-raise",
    /**
     * 两条眉毛**不同时**抬。
     *
     * 一起抬是「惊讶」（两条对称、幅度一样），错开 90 ms 才读成「挑了一下眉」——
     * 而且右边比左边低一点点（0.42 对 0.5），不对称是故意的：真人几乎不会两边
     * 完全一样，完全一样反而像贴图。
     */
    params: Object.freeze({
      ParamBrowLY: 0.5,
      ParamBrowLForm: -0.12
    }),
    attackMs: 150,
    holdMs: 260,
    releaseMs: 340,
    gaze: false,
    trailing: Object.freeze({
      delayMs: 90,
      params: Object.freeze({
        ParamBrowRY: 0.42,
        ParamBrowRForm: -0.1
      })
    })
  }),
  Object.freeze({
    id: "head-tilt",
    /**
     * 歪头的幅度调大过一次：初版是 `ParamAngleZ: 8`，用户看演示后说
     * 「不太清晰啊，要不要把歪头的角度加大一点」。8 度在 hiyori 这种头身比下
     * 只够看出「动了」，不够看出「歪着头在想事」，所以翻到 15 度并把保持段从
     * 900 ms 拉到 1000 ms —— 歪着的时间够长才像在打量，而不是一阵抖动。
     *
     * 上限由门禁钉住（`ParamAngleZ` ≤ 18）：再大就不是「歪头」，是颈椎病。
     */
    params: Object.freeze({
      ParamAngleZ: 15,
      ParamAngleX: 5,
      ParamEyeBallX: 0.2
    }),
    attackMs: 300,
    holdMs: 1e3,
    releaseMs: 700,
    gaze: true,
    /**
     * 头先歪，肩膀再把重心让过去 —— 晚 140 ms。
     *
     * 只加头角度的话，15 度和 8 度看起来差别没有想象中大；加上这一层「重心跟过去」，
     * 幅度不用再加，画面就已经是「她歪着头在打量你」而不是「她的头歪了」。
     * 身体幅度刻意小（侧倾 4 度、侧转 2 度）：跟着动是让动作落地，抢戏就成了扭秧歌。
     */
    trailing: Object.freeze({
      delayMs: 140,
      params: Object.freeze({
        ParamBodyAngleZ: 4,
        ParamBodyAngleX: 2
      })
    })
  }),
  Object.freeze({
    id: "body-turn",
    /**
     * 身子先转，头晚 150 ms 跟过去。
     *
     * 反过来（头先转、身子后跟）也行，但那是「回头看一眼」；这里要的是「换个坐姿」，
     * 所以重心先动、头顺着带过去。头只跟 3 度——跟着动是让动作有重量，不是让她扭头。
     */
    params: Object.freeze({
      ParamBodyAngleX: 10,
      ParamBodyAngleZ: 4
    }),
    attackMs: 520,
    holdMs: 1300,
    releaseMs: 900,
    gaze: false,
    trailing: Object.freeze({
      delayMs: 150,
      params: Object.freeze({
        ParamAngleZ: 3
      })
    })
  })
]);
var GARNISH_MIN_DELAY_MS = 6500;
var GARNISH_MAX_DELAY_MS = 15e3;
var GARNISH_ABORT_DELAY_MS = 3e3;
var GARNISH_MAX_STEP_MS = 200;
var GARNISH_GAZE_ALLOWED_OFFSET = 0.4;
function createGarnishState() {
  return { gesture: null, elapsedMs: 0 };
}
function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clampUnit(value) {
  const v = finite(value, 0);
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}
function smoothstep(t) {
  const v = clampUnit(t);
  return v * v * (3 - 2 * v);
}
function garnishDurationMs(gesture) {
  return Math.max(0, finite(gesture.attackMs, 0)) + Math.max(0, finite(gesture.holdMs, 0)) + Math.max(0, finite(gesture.releaseMs, 0));
}
function garnishTrailDelayMs(gesture) {
  return gesture.trailing === void 0 ? 0 : Math.max(0, finite(gesture.trailing.delayMs, 0));
}
function garnishTotalMs(gesture) {
  return garnishDurationMs(gesture) + garnishTrailDelayMs(gesture);
}
function envelopeAt(gesture, elapsedMs) {
  const t = Math.max(0, finite(elapsedMs, 0));
  const attack = Math.max(0, finite(gesture.attackMs, 0));
  const hold = Math.max(0, finite(gesture.holdMs, 0));
  const release = Math.max(0, finite(gesture.releaseMs, 0));
  if (t <= 0) return 0;
  if (attack > 0 && t < attack) {
    return smoothstep(t / attack);
  }
  if (t <= attack + hold) {
    return 1;
  }
  const into = t - attack - hold;
  if (release <= 0 || into >= release) {
    return 0;
  }
  return smoothstep(1 - into / release);
}
function garnishValues(state, deltaMs, factor) {
  const gesture = state.gesture;
  if (gesture === null) {
    return { state, values: {}, done: true };
  }
  const step = Math.min(Math.max(0, finite(deltaMs, 0)), GARNISH_MAX_STEP_MS);
  state.elapsedMs += step;
  const duration = garnishDurationMs(gesture);
  const trailDelay = garnishTrailDelayMs(gesture);
  const scale = clampUnit(factor) * envelopeAt(gesture, state.elapsedMs);
  const values = {};
  if (scale > 0) {
    for (const id of Object.keys(gesture.params)) {
      const amount = gesture.params[id] * scale;
      if (amount !== 0) {
        values[id] = amount;
      }
    }
  }
  if (gesture.trailing !== void 0 && trailDelay >= 0) {
    const trailScale = clampUnit(factor) * envelopeAt(gesture, state.elapsedMs - trailDelay);
    if (trailScale > 0) {
      for (const id of Object.keys(gesture.trailing.params)) {
        const amount = gesture.trailing.params[id] * trailScale;
        if (amount !== 0) {
          values[id] = (values[id] ?? 0) + amount;
        }
      }
    }
  }
  const done = duration <= 0 || state.elapsedMs >= duration + trailDelay;
  if (done) {
    state.gesture = null;
    state.elapsedMs = 0;
  }
  return { state, values, done };
}
function nextDelayMs(rng) {
  const raw = typeof rng === "function" ? finite(rng(), 0.5) : 0.5;
  const unit = raw <= 0 ? 0 : raw >= 1 ? 0.999999 : raw;
  const span = GARNISH_MAX_DELAY_MS - GARNISH_MIN_DELAY_MS;
  return GARNISH_MIN_DELAY_MS + Math.floor(unit * (span + 1));
}
function pickGesture(rng, options) {
  const allowGaze = options === null || options === void 0 ? true : options.allowGaze !== false;
  const avoidId = options === null || options === void 0 ? null : options.avoidId ?? null;
  let candidates = GARNISH_GESTURES.filter((gesture) => allowGaze || !gesture.gaze);
  if (avoidId !== null && candidates.length > 1) {
    candidates = candidates.filter((gesture) => gesture.id !== avoidId);
  }
  if (candidates.length === 0) {
    return null;
  }
  const raw = typeof rng === "function" ? finite(rng(), 0) : 0;
  const unit = raw <= 0 ? 0 : raw >= 1 ? 0.999999 : raw;
  const index = Math.floor(unit * candidates.length);
  return candidates[index < 0 ? 0 : index >= candidates.length ? candidates.length - 1 : index];
}
function createRandom(seed) {
  let a = Math.floor(finite(seed, 1)) >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export {
  GARNISH_ABORT_DELAY_MS,
  GARNISH_GAZE_ALLOWED_OFFSET,
  GARNISH_GESTURES,
  GARNISH_MAX_DELAY_MS,
  GARNISH_MAX_STEP_MS,
  GARNISH_MIN_DELAY_MS,
  createGarnishState,
  createRandom,
  envelopeAt,
  garnishDurationMs,
  garnishTotalMs,
  garnishTrailDelayMs,
  garnishValues,
  nextDelayMs,
  pickGesture,
  smoothstep
};
