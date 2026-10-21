// lib/host/capabilities.js
var EMPTY_CAPABILITIES = Object.freeze({
  parameters: [],
  expressions: [],
  motionGroups: [],
  hitAreas: []
});

// lib/host/emotions.js
var ROLE_PARAMETER_IDS = Object.freeze({
  eyeSmileL: Object.freeze(["ParamEyeLSmile", "ParamEyeSmile"]),
  eyeSmileR: Object.freeze(["ParamEyeRSmile", "ParamEyeSmileR"]),
  eyeOpenL: Object.freeze(["ParamEyeLOpen"]),
  eyeOpenR: Object.freeze(["ParamEyeROpen"]),
  eyeBallX: Object.freeze(["ParamEyeBallX"]),
  eyeBallY: Object.freeze(["ParamEyeBallY"]),
  browLY: Object.freeze(["ParamBrowLY", "ParamBrowLY7"]),
  browRY: Object.freeze(["ParamBrowRY", "ParamBrowRY7"]),
  browLForm: Object.freeze(["ParamBrowLForm", "ParamBrowLForm2"]),
  browRForm: Object.freeze(["ParamBrowRForm", "ParamBrowRForm2"]),
  cheek: Object.freeze(["ParamCheek"]),
  angleX: Object.freeze(["ParamAngleX"]),
  angleY: Object.freeze(["ParamAngleY"]),
  angleZ: Object.freeze(["ParamAngleZ"]),
  bodyAngleX: Object.freeze(["ParamBodyAngleX"]),
  bodyAngleZ: Object.freeze(["ParamBodyAngleZ"]),
  shoulder: Object.freeze(["ParamShoulder"]),
  hairAhoge: Object.freeze(["ParamHairAhoge"])
});
var ROLE_LABELS = Object.freeze({
  eyeSmileL: "左眼笑眼",
  eyeSmileR: "右眼笑眼",
  eyeOpenL: "左眼开合",
  eyeOpenR: "右眼开合",
  eyeBallX: "视线左右",
  eyeBallY: "视线上下",
  browLY: "左眉高度",
  browRY: "右眉高度",
  browLForm: "左眉形状",
  browRForm: "右眉形状",
  cheek: "脸红",
  angleX: "头部左右",
  angleY: "头部上下",
  angleZ: "头部倾斜",
  bodyAngleX: "身体左右",
  bodyAngleZ: "身体倾斜",
  shoulder: "肩膀",
  hairAhoge: "呆毛"
});
var EMOTION_TABLE = Object.freeze({
  平静: Object.freeze({
    summary: "回到中性 —— 清空情绪层，不是「摆一张平静的脸」",
    roles: Object.freeze({})
  }),
  开心: Object.freeze({
    summary: "笑眼 + 脸红 + 眉毛微抬 + 头微倾",
    roles: Object.freeze({
      eyeSmileL: 0.7,
      eyeSmileR: 0.7,
      cheek: 0.5,
      browLY: 0.15,
      browRY: 0.15,
      angleZ: 2,
      hairAhoge: 1.5
    })
  }),
  好奇: Object.freeze({
    summary: "歪头 + 一边眉毛挑起来 + 眼睛睁大一点 + 视线偏向一侧",
    roles: Object.freeze({
      angleZ: 10,
      angleY: 3,
      browRY: 0.35,
      browLY: -0.1,
      eyeOpenL: 0.1,
      eyeOpenR: 0.1,
      eyeBallX: 0.35,
      hairAhoge: -1
    })
  }),
  思考: Object.freeze({
    summary: "眉心和眉毛往里收 + 眼睛半闭 + 视线往上飘 + 头微低",
    roles: Object.freeze({
      browLY: -0.25,
      browRY: -0.25,
      browLForm: 0.35,
      browRForm: 0.35,
      eyeOpenL: -0.25,
      eyeOpenR: -0.25,
      eyeBallY: 0.45,
      eyeBallX: -0.35,
      angleY: -3,
      angleZ: 4
    })
  }),
  认真: Object.freeze({
    summary: "眉毛压低 + 眼睛略微收窄 + 头微低 —— 没有笑意的那张脸",
    roles: Object.freeze({
      browLY: -0.35,
      browRY: -0.35,
      eyeOpenL: -0.12,
      eyeOpenR: -0.12,
      angleY: -4,
      bodyAngleX: -1.5
    })
  }),
  惊讶: Object.freeze({
    summary: "眼睛睁大 + 眉毛抬高 + 头微仰 + 肩膀一耸",
    roles: Object.freeze({
      eyeOpenL: 0.2,
      eyeOpenR: 0.2,
      browLY: 0.55,
      browRY: 0.55,
      angleY: 4,
      eyeBallY: 0.1,
      shoulder: 0.25
    })
  }),
  抱歉: Object.freeze({
    summary: "八字眉 + 低头 + 视线向下 + 肩膀塌下来",
    roles: Object.freeze({
      browLForm: 0.5,
      browRForm: 0.5,
      browLY: -0.1,
      browRY: -0.1,
      angleY: -9,
      eyeBallY: -0.45,
      shoulder: -0.25,
      eyeOpenL: -0.15,
      eyeOpenR: -0.15,
      cheek: 0.15
    })
  }),
  难过: Object.freeze({
    summary: "八字眉 + 更深的低头 + 视线向下 + 肩膀塌下来",
    roles: Object.freeze({
      browLForm: 0.45,
      browRForm: 0.45,
      browLY: -0.2,
      browRY: -0.2,
      angleY: -11,
      eyeBallY: -0.55,
      shoulder: -0.3,
      eyeOpenL: -0.2,
      eyeOpenR: -0.2
    })
  }),
  得意: Object.freeze({
    summary: "下巴微抬 + 笑眼 + 肩膀一挺 + 呆毛翘起来",
    roles: Object.freeze({
      angleY: 6,
      eyeSmileL: 0.4,
      eyeSmileR: 0.4,
      shoulder: 0.2,
      bodyAngleX: 1.5,
      hairAhoge: 2
    })
  })
});
var EMOTION_ALIASES = Object.freeze({
  neutral: "平静",
  calm: "平静",
  reset: "平静",
  clear: "平静",
  happy: "开心",
  joy: "开心",
  smile: "开心",
  glad: "开心",
  高兴: "开心",
  curious: "好奇",
  interest: "好奇",
  wonder: "好奇",
  thinking: "思考",
  think: "思考",
  ponder: "思考",
  思索: "思考",
  serious: "认真",
  focused: "认真",
  严肃: "认真",
  专注: "认真",
  surprised: "惊讶",
  surprise: "惊讶",
  shock: "惊讶",
  amazed: "惊讶",
  吃惊: "惊讶",
  sorry: "抱歉",
  apologetic: "抱歉",
  apologize: "抱歉",
  对不起: "抱歉",
  歉意: "抱歉",
  sad: "难过",
  sorrow: "难过",
  upset: "难过",
  伤心: "难过",
  沮丧: "难过",
  proud: "得意",
  smug: "得意",
  confident: "得意",
  自豪: "得意"
});
var EMOTION_FAMILY = Object.freeze({
  开心: "warm",
  得意: "warm",
  好奇: "warm",
  惊讶: "alert",
  思考: "focus",
  认真: "focus",
  抱歉: "down",
  难过: "down",
  平静: "calm"
});
var AMBIENT_DRIFT_WAVES = Object.freeze({
  angleZ: Object.freeze({ ratio: 0.024, f1: 0.047, f2: 0.113, phase: 0.9 }),
  angleX: Object.freeze({ ratio: 0.016, f1: 0.037, f2: 0.089, phase: 2.1 }),
  angleY: Object.freeze({ ratio: 0.014, f1: 0.031, f2: 0.071, phase: 4.2 }),
  eyeBallX: Object.freeze({ ratio: 0.01, f1: 0.071, f2: 0.163, phase: 1.3 }),
  eyeBallY: Object.freeze({ ratio: 8e-3, f1: 0.061, f2: 0.137, phase: 3.4 }),
  browLY: Object.freeze({ ratio: 6e-3, f1: 0.043, f2: 0.097, phase: 0.2 }),
  browRY: Object.freeze({ ratio: 6e-3, f1: 0.039, f2: 0.091, phase: 1.7 })
});

// lib/host/micro-motions.js
var MICRO_MOTION_VERSION = 2;
var MICRO_MOTION_MAX_GESTURES = 24;
var MICRO_MOTION_MAX_PARTS = 4;
var MICRO_MOTION_MAX_PART_DELAY_MS = 600;
var MICRO_MOTION_MIN_DELAY_MS = 6500;
var MICRO_MOTION_MAX_DELAY_MS = 15e3;
var MICRO_MOTION_TALK_MIN_DELAY_MS = 4200;
var MICRO_MOTION_TALK_MAX_DELAY_MS = 9e3;
var MICRO_MOTION_ABORT_DELAY_MS = 3e3;
var MICRO_MOTION_MAX_DELTA = 90;
function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
function pickMicroMotion(pack, options = {}) {
  const gestures = Array.isArray(pack?.gestures) ? pack.gestures : [];
  if (gestures.length === 0) return null;
  const mode = options.mode === "talk" ? "talk" : "idle";
  const emotions = Array.isArray(options.emotions) ? options.emotions : [];
  const allowGaze = options.allowGaze !== false;
  const avoidId = typeof options.avoidId === "string" ? options.avoidId : "";
  const minWeight = 1e-6;
  let total = 0;
  const weighted = [];
  for (const gesture of gestures) {
    if (gesture === null || typeof gesture !== "object") continue;
    if (gesture.enabled === false) continue;
    if (!Array.isArray(gesture.modes) || !gesture.modes.includes(mode)) continue;
    if (gesture.gaze === true && !allowGaze) continue;
    let weight = finiteOr(gesture.weight, 1);
    const tags = Array.isArray(gesture.tags) ? gesture.tags : [];
    if (emotions.some((name) => tags.includes(name))) weight *= 1.8;
    if (gesture.id === avoidId) weight *= 0.25;
    if (!(weight > minWeight)) continue;
    weighted.push({ gesture, weight });
    total += weight;
  }
  if (total <= minWeight) return null;
  const random = typeof options.random === "function" ? options.random : Math.random;
  let target = random() * total;
  for (const item of weighted) {
    target -= item.weight;
    if (target <= 0) return item.gesture;
  }
  return weighted[weighted.length - 1].gesture;
}
function microMotionDelayMs(mode, random = Math.random) {
  const lo = mode === "talk" ? MICRO_MOTION_TALK_MIN_DELAY_MS : MICRO_MOTION_MIN_DELAY_MS;
  const hi = mode === "talk" ? MICRO_MOTION_TALK_MAX_DELAY_MS : MICRO_MOTION_MAX_DELAY_MS;
  return Math.round(lo + (hi - lo) * clamp(typeof random === "function" ? random() : 0, 0, 1));
}

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
var GARNISH_MAX_STEP_MS = 200;
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

// src/client/micro-motion.ts
function createMicroMotionState() {
  return { gesture: null, elapsedMs: 0, nextAtMs: 0, clockMs: 0, lastId: "", count: 0 };
}
function finite2(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clamp01(value) {
  const v = finite2(value, 0);
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}
function normalizeMicroMotionPack(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const source = raw;
  const list = Array.isArray(source.gestures) ? source.gestures : [];
  const declaredVersion = source.version === void 0 || source.version === null ? null : finite2(Number(source.version), 0);
  const looksLikeV2 = list.length > 0 && list.every((item) => item !== null && typeof item === "object" && Array.isArray(item.parts));
  if (declaredVersion === null ? !looksLikeV2 : declaredVersion !== MICRO_MOTION_VERSION) return null;
  const gestures = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const entry = item;
    if (typeof entry.id !== "string" || entry.id === "") continue;
    const parts = sanitizeParts(entry.parts);
    if (parts.length === 0) continue;
    gestures.push({
      id: entry.id,
      label: typeof entry.label === "string" ? entry.label : entry.id,
      parts,
      attackMs: Math.max(0, finite2(Number(entry.attackMs), 300)),
      holdMs: Math.max(0, finite2(Number(entry.holdMs), 500)),
      releaseMs: Math.max(0, finite2(Number(entry.releaseMs), 500)),
      gaze: entry.gaze === true,
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === "string") : [],
      modes: Array.isArray(entry.modes) ? entry.modes.filter((mode) => mode === "idle" || mode === "talk") : ["idle"],
      weight: Math.max(0.1, finite2(Number(entry.weight), 1)),
      enabled: entry.enabled !== false
    });
    if (gestures.length >= MICRO_MOTION_MAX_GESTURES) break;
  }
  if (gestures.length === 0) return null;
  return {
    version: MICRO_MOTION_VERSION,
    model: typeof source.model === "string" ? source.model : "",
    name: typeof source.name === "string" ? source.name : "",
    generatedAt: finite2(Number(source.generatedAt), 0),
    strength: Math.max(0.2, Math.min(1.4, finite2(Number(source.strength), 0.9))),
    gestures,
    roles: Array.isArray(source.roles) ? source.roles : [],
    missing: Array.isArray(source.missing) ? source.missing.filter((role) => typeof role === "string") : [],
    substitutions: Array.isArray(source.substitutions) ? source.substitutions.filter((item) => item !== null && typeof item === "object" && typeof item.from === "string" && typeof item.to === "string").map((item) => ({ from: item.from, to: item.to, ratio: finite2(Number(item.ratio), 0.5) })) : []
  };
}
function sanitizeParts(raw) {
  const parts = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const entry = item;
    const params = sanitizeParams(entry.params);
    if (Object.keys(params).length === 0) continue;
    parts.push({
      delayMs: Math.max(0, Math.min(MICRO_MOTION_MAX_PART_DELAY_MS, finite2(Number(entry.delayMs), 0))),
      params
    });
    if (parts.length >= MICRO_MOTION_MAX_PARTS) break;
  }
  parts.sort((left, right) => left.delayMs - right.delayMs);
  return parts;
}
function sanitizeParams(raw) {
  const params = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return params;
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== "string" || id === "") continue;
    if (id === "ParamMouthOpenY" || id === "ParamMouthForm") continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    params[id] = Math.max(-MICRO_MOTION_MAX_DELTA, Math.min(MICRO_MOTION_MAX_DELTA, value));
  }
  return params;
}
function microMotionValues(state, options) {
  const frame = { values: {}, started: "", done: "" };
  const pack = options.pack;
  if (pack === null || pack.gestures.length === 0) {
    if (state.gesture !== null) {
      state.gesture = null;
      state.elapsedMs = 0;
    }
    return frame;
  }
  const rawMs = finite2(options.deltaMs, 0);
  const step = rawMs > GARNISH_MAX_STEP_MS ? GARNISH_MAX_STEP_MS : Math.max(0, rawMs);
  state.clockMs += step;
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
  const random = typeof options.random === "function" ? options.random : Math.random;
  const strength = Math.max(0.2, Math.min(1.4, finite2(pack.strength, 0.9)));
  if (state.gesture !== null) {
    const gesture = state.gesture;
    const totalMs = microMotionTotalMs(gesture);
    state.elapsedMs = Math.min(state.elapsedMs + step, totalMs);
    const scaleBase = clamp01(options.factor) * clamp01(strength);
    if (scaleBase > 0) {
      const values = {};
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
    random
  });
  if (chosen === null) {
    state.nextAtMs = state.clockMs + microMotionDelayMs(options.mode, random);
    return frame;
  }
  state.gesture = chosen;
  state.elapsedMs = 0;
  state.lastId = chosen.id;
  state.count += 1;
  frame.started = chosen.id;
  return frame;
}
function microMotionName(state) {
  return state.gesture === null ? "" : state.gesture.id;
}
function startMicroMotion(state, pack, id) {
  if (pack === null) return null;
  const wanted = typeof id === "string" ? id.trim() : "";
  if (wanted === "") return null;
  const gesture = pack.gestures.find((entry) => entry.id === wanted);
  if (gesture === void 0) return null;
  state.gesture = gesture;
  state.elapsedMs = 0;
  state.lastId = gesture.id;
  state.count += 1;
  return gesture;
}
function microMotionTotalMs(gesture) {
  let lead = 0;
  for (const part of gesture.parts) {
    const delay = Math.max(0, finite2(part.delayMs, 0));
    if (delay > lead) lead = delay;
  }
  return envelopeTotal(gesture) + lead;
}
function envelopeTotal(gesture) {
  return Math.max(0, finite2(gesture.attackMs, 0)) + Math.max(0, finite2(gesture.holdMs, 0)) + Math.max(0, finite2(gesture.releaseMs, 0));
}
export {
  createMicroMotionState,
  envelopeAt,
  microMotionName,
  microMotionTotalMs,
  microMotionValues,
  normalizeMicroMotionPack,
  startMicroMotion
};
