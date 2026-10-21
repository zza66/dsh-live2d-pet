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

// lib/host/actions.js
var ACTION_KINDS = Object.freeze([
  "say",
  "motion",
  "expression",
  "look",
  "emotion",
  "param",
  "microMotion",
  "stop",
  "idle"
]);
var PRIORITY = Object.freeze({ EXPRESSIVE: 50, INTERRUPT: 100 });
var DEFAULT_LOOK_DURATION_MS = 400;
var MAX_LOOK_DURATION_MS = 5e3;
var EXCLUSIVE_PARAMETER_IDS = Object.freeze(["ParamMouthOpenY", "ParamMouthForm"]);
var TOOL_KINDS = Object.freeze({
  live2d_speak: "say",
  live2d_play_motion: "motion",
  live2d_set_expression: "expression",
  live2d_look_at: "look",
  live2d_emote: "emotion",
  live2d_param: "param",
  live2d_stop_speaking: "stop"
});

// src/client/look-tween.ts
function createLookTween() {
  return {
    fromX: 0,
    fromY: 0,
    toX: 0,
    toY: 0,
    elapsedMs: 0,
    durationMs: 0,
    x: 0,
    y: 0
  };
}
function unit(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}
function duration(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value > MAX_LOOK_DURATION_MS ? MAX_LOOK_DURATION_MS : value;
}
function easeInOut(t) {
  if (typeof t !== "number" || Number.isNaN(t)) return 0;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
function glideTo(state, x, y, durationMs) {
  const ms = durationMs === void 0 ? DEFAULT_LOOK_DURATION_MS : duration(durationMs);
  const fromX = state.x;
  const fromY = state.y;
  const toX = unit(x);
  const toY = unit(y);
  state.fromX = fromX;
  state.fromY = fromY;
  state.toX = toX;
  state.toY = toY;
  state.durationMs = ms;
  state.elapsedMs = 0;
  if (ms <= 0) {
    state.x = toX;
    state.y = toY;
  }
}
function jumpTo(state, x, y) {
  state.fromX = state.x;
  state.fromY = state.y;
  state.toX = unit(x);
  state.toY = unit(y);
  state.durationMs = 0;
  state.elapsedMs = 0;
  state.x = state.toX;
  state.y = state.toY;
}
function stepLookTween(state, deltaMs) {
  if (state.durationMs <= 0) {
    state.x = state.toX;
    state.y = state.toY;
    return { x: state.x, y: state.y };
  }
  const dt = typeof deltaMs === "number" && Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
  state.elapsedMs += dt;
  const t = state.elapsedMs >= state.durationMs ? 1 : state.elapsedMs / state.durationMs;
  if (t >= 1) {
    state.x = state.toX;
    state.y = state.toY;
    return { x: state.x, y: state.y };
  }
  const e = easeInOut(t);
  state.x = state.fromX + (state.toX - state.fromX) * e;
  state.y = state.fromY + (state.toY - state.fromY) * e;
  return { x: state.x, y: state.y };
}
function isSettled(state) {
  return state.durationMs <= 0 || state.elapsedMs >= state.durationMs;
}
export {
  createLookTween,
  easeInOut,
  glideTo,
  isSettled,
  jumpTo,
  stepLookTween
};
