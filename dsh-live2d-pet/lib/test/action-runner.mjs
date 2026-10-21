// src/client/action-runner.ts
var HANDLED_KINDS = Object.freeze([
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
var currentTarget = null;
function setActionTarget(target) {
  currentTarget = target;
}
function getActionTarget() {
  return currentTarget;
}
function fail(code, detail) {
  return { handled: true, ok: false, code, detail };
}
function done(detail) {
  return { handled: true, ok: true, code: "", detail };
}
function normalizedKind(command) {
  const kind = command === null || command === void 0 ? void 0 : command.kind;
  if (kind === "speak") {
    return "say";
  }
  return typeof kind === "string" ? kind : "";
}
function textOf(command) {
  const payload = command.payload;
  if (payload !== null && payload !== void 0 && typeof payload.text === "string") {
    return payload.text;
  }
  return typeof command.text === "string" ? command.text : "";
}
function interruptOf(command) {
  const payload = command.payload;
  if (payload === null || payload === void 0) {
    return true;
  }
  return payload.interrupt !== false;
}
function textOption(value) {
  return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
function voiceOf(command) {
  return textOption(command.payload?.voice);
}
function rateOf(command) {
  return textOption(command.payload?.rate);
}
function finiteOr(value, fallback) {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}
function optionalNumber(value) {
  return typeof value === "number" && isFinite(value) ? value : void 0;
}
var FRAMEWORK_PRIORITY = Object.freeze({ IDLE: 1, NORMAL: 2, FORCE: 3 });
function motionPriorityFor(commandPriority) {
  return typeof commandPriority === "number" && isFinite(commandPriority) && commandPriority >= 100 ? FRAMEWORK_PRIORITY.FORCE : FRAMEWORK_PRIORITY.NORMAL;
}
function isExpired(command, at, nowMs) {
  const cmd = command;
  if (normalizedKind(cmd) === "stop") {
    return false;
  }
  const ttl = cmd === null || cmd === void 0 ? void 0 : cmd.ttlMs;
  if (typeof ttl !== "number" || !isFinite(ttl) || ttl <= 0) {
    return false;
  }
  if (typeof at !== "number" || !isFinite(at)) {
    return false;
  }
  return nowMs - at > ttl;
}
function collectParameters(raw) {
  const out = {};
  if (raw === null || raw === void 0 || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === "number" && isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}
async function runAction(target, command, hooks) {
  const kind = normalizedKind(command);
  if (kind === "") {
    return { handled: false, ok: false, code: "E_ACTION_UNKNOWN_KIND", detail: "这条指令没有 kind。" };
  }
  const cmd = command;
  try {
    switch (kind) {
      case "say": {
        const text = textOf(cmd);
        if (text.trim() === "") {
          return fail("E_ACTION_EMPTY_TEXT", "这条说话的指令是空的。");
        }
        const interrupt = interruptOf(cmd);
        const voice = voiceOf(cmd);
        const rate = rateOf(cmd);
        await hooks.speak(text, { interrupt, voice, rate });
        return done(
          interrupt ? `说了 ${text.length} 个字（打断上一句）。` : `说了 ${text.length} 个字（排在后面）。`
        );
      }
      case "stop": {
        hooks.stopSpeech();
        if (target !== null) {
          target.stopMotion();
          target.clearExpression();
          target.clearParameterOverrides();
        }
        return done("停下了。");
      }
      case "idle": {
        if (target === null) {
          return done("现在没有模型，待机不需要做什么。");
        }
        target.stopMotion();
        target.clearExpression();
        target.clearParameterOverrides();
        target.lookAt(0, 0);
        return done("回到待机。");
      }
      case "motion": {
        if (target === null) {
          return fail("E_ACTION_NO_MODEL", "现在没有模型，动作没法播。");
        }
        const motion = cmd.payload === null || cmd.payload === void 0 ? void 0 : cmd.payload.motion;
        const group = motion === null || motion === void 0 ? void 0 : motion.group;
        if (typeof group !== "string" || group === "") {
          return fail("E_ACTION_BAD_VALUE", "这条动作指令没说要播哪一组。");
        }
        const index = motion === void 0 ? void 0 : optionalNumber(motion.index);
        const fadeMs = motion === void 0 ? void 0 : optionalNumber(motion.fadeMs);
        const loop = motion === void 0 ? void 0 : motion.loop === true;
        const priority = motionPriorityFor(cmd.priority);
        const result = await target.playMotion(group, index, { fadeMs, loop, priority });
        return { handled: true, ok: result.ok, code: result.code, detail: result.detail };
      }
      case "expression": {
        if (target === null) {
          return fail("E_ACTION_NO_MODEL", "现在没有模型，表情换不了。");
        }
        const expression = cmd.payload === null || cmd.payload === void 0 ? void 0 : cmd.payload.expression;
        const name = expression === null || expression === void 0 ? void 0 : expression.name;
        if (typeof name !== "string" || name === "") {
          return fail("E_ACTION_BAD_VALUE", "这条表情指令没说要换哪一个。");
        }
        const holdMs = expression === void 0 ? void 0 : optionalNumber(expression.holdMs);
        const result = await target.setExpression(name, { holdMs });
        return { handled: true, ok: result.ok, code: result.code, detail: result.detail };
      }
      case "look": {
        if (target === null) {
          return fail("E_ACTION_NO_MODEL", "现在没有模型，视线转不了。");
        }
        const look = cmd.payload === null || cmd.payload === void 0 ? void 0 : cmd.payload.look;
        const x = look === null || look === void 0 ? 0 : finiteOr(look.x, 0);
        const y = look === null || look === void 0 ? 0 : finiteOr(look.y, 0);
        const durationMs = look === null || look === void 0 ? void 0 : optionalNumber(look.durationMs);
        const result = target.lookAt(x, y, { durationMs });
        return { handled: true, ok: result.ok, code: result.code, detail: result.detail };
      }
      case "microMotion": {
        const micro = cmd.payload === null || cmd.payload === void 0 ? void 0 : cmd.payload.microMotion;
        const id = micro === null || micro === void 0 || typeof micro.id !== "string" ? "" : micro.id.trim();
        if (id === "") return fail("E_ACTION_BAD_VALUE", "这条微动作指令没说要演哪一条。");
        if (target === null) return fail("E_ACTION_NO_MODEL", "现在没有模型，微动作没处安。");
        if (typeof target.playMicroMotion !== "function") {
          return fail("E_ACTION_UNSUPPORTED", "这个版本的渲染端还不会演单条微动作（刷新一次页面）。");
        }
        const result = target.playMicroMotion(id);
        return { handled: true, ok: result.ok, code: result.code, detail: result.detail };
      }
      case "emotion": {
        if (target === null) {
          return fail("E_ACTION_NO_MODEL", "现在没有模型，情绪没处安。");
        }
        const emotion = cmd.payload === null || cmd.payload === void 0 ? void 0 : cmd.payload.emotion;
        const name = emotion === null || emotion === void 0 ? "" : textOption(emotion.name);
        const release = emotion === null || emotion === void 0 || !Array.isArray(emotion.release) ? [] : emotion.release.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
        if (release.length > 0) {
          const outcome2 = target.releaseEmotion(release);
          const parts = [];
          if (outcome2.released.length > 0) parts.push(`收掉 ${outcome2.released.join("、")}`);
          if (outcome2.unknown.length > 0) parts.push(`${outcome2.unknown.join("、")} 当时不在场`);
          return done(`情绪层：${parts.length > 0 ? parts.join("；") : "没有可收的层"}。`);
        }
        const params = collectParameters(
          emotion === null || emotion === void 0 ? void 0 : emotion.params
        );
        const ids = Object.keys(params);
        if (ids.length === 0) {
          if (name === void 0 || name === "") {
            return fail("E_ACTION_BAD_VALUE", "这条情绪指令既没有名字也没有参数。");
          }
          target.clearEmotion();
          return done(`情绪层已清空（${name}）。`);
        }
        const outcome = target.setEmotion(params, {
          name,
          holdMs: optionalNumber(emotion?.holdMs),
          attackMs: optionalNumber(emotion?.attackMs),
          releaseMs: optionalNumber(emotion?.releaseMs),
          /*
           * ★ 退场形状（§13.33）：新 Host 会带 `decayMs`（不传 `releaseMs`）；
           * 旧 Host 只带 `releaseMs` —— 那时 `undefined` 落到 `setEmotion()` 的
           * 默认值，而默认值又会因为「有 releaseMs」自动走线性。两端都不用改协议。
           */
          decayMs: optionalNumber(emotion?.decayMs)
        });
        if (outcome.applied.length === 0) {
          return fail(
            "E_ACTION_PARAMETER_IGNORED",
            `模型里没有这个情绪需要的参数：${outcome.ignored.join("、")}`
          );
        }
        return done(
          `情绪「${name ?? "未命名"}」：叠上 ${outcome.applied.join("、")}` + (outcome.ignored.length > 0 ? `；模型没有 ${outcome.ignored.join("、")}` : "")
        );
      }
      case "param": {
        if (target === null) {
          return fail("E_ACTION_NO_MODEL", "现在没有模型，参数没法写。");
        }
        const params = collectParameters(
          cmd.payload === null || cmd.payload === void 0 ? void 0 : cmd.payload.params
        );
        const ids = Object.keys(params);
        if (ids.length === 0) {
          return fail("E_ACTION_BAD_VALUE", "这条参数指令里没有可用的数值。");
        }
        const holdMs = finiteOr(cmd.ttlMs, 0);
        const outcome = target.setParameterOverride(params, holdMs);
        if (outcome.applied.length === 0) {
          const why = outcome.dropped.length > 0 ? `这些是口型参数，由语音通道独占：${outcome.dropped.join("、")}` : `模型里没有这些参数：${outcome.ignored.join("、")}`;
          return fail("E_ACTION_PARAMETER_IGNORED", why);
        }
        return done(
          `写了 ${outcome.applied.join("、")}` + (outcome.dropped.length > 0 ? `；丢掉了口型参数 ${outcome.dropped.join("、")}` : "")
        );
      }
      default:
        return {
          handled: false,
          ok: false,
          code: "E_ACTION_UNSUPPORTED_KIND",
          detail: `渲染端还不认识「${kind}」这类指令（已认识的：${HANDLED_KINDS.join("、")}）。`
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("E_ACTION_FAILED", `执行「${kind}」时出错：${message}`);
  }
}
async function runCurrentAction(command, hooks) {
  return runAction(currentTarget, command, hooks);
}
var IDLE_AFTER_MS = 2e4;
var IDLE_LOOP_REPEATS = 2;
var IDLE_HOLD_MIN_MS = 6e3;
var IDLE_HOLD_MAX_MS = 12e3;
function idleHoldMsFor(durationMs) {
  const ms = typeof durationMs === "number" && isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  if (ms <= 0) {
    return IDLE_HOLD_MAX_MS;
  }
  const wanted = Math.round(ms * IDLE_LOOP_REPEATS);
  return Math.max(IDLE_HOLD_MIN_MS, Math.min(IDLE_HOLD_MAX_MS, wanted));
}
function pickIdleIndex(count, avoidIndex, random = Math.random) {
  const total = typeof count === "number" && isFinite(count) ? Math.trunc(count) : 0;
  if (total <= 0) {
    return -1;
  }
  const raw = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * total);
  if (total === 1) {
    return 0;
  }
  const avoid = typeof avoidIndex === "number" && isFinite(avoidIndex) ? Math.trunc(avoidIndex) : -1;
  if (avoid < 0 || avoid >= total || raw !== avoid) {
    return raw;
  }
  const offset = 1 + Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * (total - 1));
  return (avoid + offset) % total;
}
function shouldAutoIdle(lastActivityAt, lastAutoIdleAt, nowMs, currentMotionPriority, idleAfterMs = IDLE_AFTER_MS, speechBusy = false, holdMs = idleAfterMs) {
  if (!isFinite(lastActivityAt) || !isFinite(lastAutoIdleAt) || !isFinite(nowMs)) {
    return false;
  }
  if (lastActivityAt <= 0) {
    return false;
  }
  if (speechBusy === true) {
    return false;
  }
  if (isBusyWithRealMotion(currentMotionPriority)) {
    return false;
  }
  const hold = isFinite(holdMs) && holdMs > 0 ? holdMs : idleAfterMs;
  return nowMs - lastActivityAt >= idleAfterMs && nowMs - lastAutoIdleAt >= hold;
}
function isBusyWithRealMotion(currentMotionPriority) {
  if (typeof currentMotionPriority !== "number" || !isFinite(currentMotionPriority)) {
    return false;
  }
  return currentMotionPriority > FRAMEWORK_PRIORITY.IDLE;
}
function isOwnIdleMotion(currentMotionPriority) {
  return currentMotionPriority === FRAMEWORK_PRIORITY.IDLE;
}
function pickIdleGroup(groups) {
  if (!Array.isArray(groups)) {
    return "";
  }
  const names = groups.filter((name) => typeof name === "string" && name !== "");
  const idle = names.find((name) => name.toLowerCase().includes("idle"));
  if (typeof idle === "string") {
    return idle;
  }
  return names.length > 0 ? names[0] : "";
}
export {
  FRAMEWORK_PRIORITY,
  HANDLED_KINDS,
  IDLE_AFTER_MS,
  IDLE_HOLD_MAX_MS,
  IDLE_HOLD_MIN_MS,
  IDLE_LOOP_REPEATS,
  collectParameters,
  getActionTarget,
  idleHoldMsFor,
  isBusyWithRealMotion,
  isExpired,
  isOwnIdleMotion,
  motionPriorityFor,
  pickIdleGroup,
  pickIdleIndex,
  runAction,
  runCurrentAction,
  setActionTarget,
  shouldAutoIdle
};
