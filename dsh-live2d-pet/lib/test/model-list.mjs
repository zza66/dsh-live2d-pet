// src/client/model-list.ts
var MOC3_ENDIANNESS = Object.freeze({
  LITTLE: "little",
  BIG: "big",
  /** 头读不到。宁可说「不知道」，也不猜一个。 */
  UNKNOWN: "unknown"
});
function isLoadable(model) {
  return model.ok !== false;
}
function hasError(model) {
  return (model.problems ?? []).some((p) => p.level === "error");
}
function hasWarning(model) {
  return (model.problems ?? []).some((p) => p.level === "warn");
}
function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function describeModel(model) {
  if (model === null) return "";
  const bits = [];
  if (typeof model.moc3?.version === "number") bits.push(`moc3 v${model.moc3.version}`);
  if (model.moc3?.endianness === MOC3_ENDIANNESS.BIG) bits.push("大端");
  if (typeof model.textures?.count === "number" && model.textures.count > 0) {
    const side = model.textures.largestSide;
    bits.push(`${model.textures.count} 张纹理${typeof side === "number" ? `（最大 ${side}px）` : ""}`);
  }
  if (typeof model.motions?.count === "number" && model.motions.count > 0) {
    bits.push(`${model.motions.count} 个动作`);
  }
  if (typeof model.expressions === "number" && model.expressions > 0) {
    bits.push(`${model.expressions} 个表情`);
  }
  bits.push(formatBytes(model.bytes));
  return bits.join(" · ");
}
function modelLabel(model) {
  if (!isLoadable(model)) return `✕ ${model.name}`;
  if (hasWarning(model)) return `! ${model.name}`;
  return model.name;
}
function describeLibrary(summary) {
  if (summary === null) return "";
  return `模型库 ${summary.total} 个` + (summary.broken > 0 ? ` · ${summary.broken} 个有问题` : " · 全部可用") + (summary.truncated === true ? " · 已达扫描上限" : "");
}
function evaluatePick(models, id) {
  const model = (models ?? []).find((m) => m.id === id) ?? null;
  if (model === null) return { accept: true, id, model: null, reason: null };
  if (isLoadable(model)) return { accept: true, id, model, reason: null };
  const first = (model.problems ?? []).find((p) => p.level === "error");
  return {
    accept: false,
    id,
    model,
    reason: `没有切换：「${model.name}」加载不起来` + (first !== void 0 ? ` —— ${first.message}（${first.code}）` : "")
  };
}
function pickDefault(models, previous) {
  if (previous !== null && models.some((m) => m.id === previous)) return previous;
  const firstOk = models.find(isLoadable);
  return (firstOk ?? models[0])?.id ?? null;
}
var MAX_IMPORT_BYTES = 192 * 1024 * 1024;
function acceptDrop(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) {
    return { accept: false, name: "", reason: "没有读到文件。" };
  }
  if (list.length > 1) {
    return { accept: false, name: "", reason: `一次只能导入一个包，你拖进来了 ${list.length} 个。` };
  }
  const file = list[0];
  if (!/\.zip$/i.test(file.name)) {
    return { accept: false, name: file.name, reason: `「${file.name}」不是 zip 文件。模型包要压成 .zip 再导入。` };
  }
  if (file.size === 0) {
    return { accept: false, name: file.name, reason: `「${file.name}」是空文件。` };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return {
      accept: false,
      name: file.name,
      reason: `「${file.name}」有 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_IMPORT_BYTES)} 上限。`
    };
  }
  return { accept: true, name: file.name, reason: "" };
}
var IDLE_IMPORT = {
  phase: "idle",
  label: "",
  bytes: 0,
  dir: "",
  degraded: false,
  problems: [],
  code: "",
  detail: ""
};
function isImporting(state) {
  return state.phase === "uploading";
}
function describeImport(state) {
  switch (state.phase) {
    case "uploading":
      return state.bytes > 0 ? `正在导入 ${state.label}（${formatBytes(state.bytes)}）…` : `正在导入 ${state.label}…`;
    case "done":
      return state.degraded ? `已导入「${state.dir}」，但它加载不起来：${state.problems[0]?.message ?? "见下方说明"}` : `已导入「${state.dir}」，可以用。`;
    case "failed":
      if (state.code === "E_IMPORT_NO_MODEL") {
        return `「${state.label}」里没有 .model3.json，不像是模型包。`;
      }
      if (state.code === "E_ZIP_BOMB_SUSPECT" || state.code === "E_ZIP_TOO_LARGE_UNCOMPRESSED") {
        return `「${state.label}」解压后异常地大，为了保护磁盘没有导入。`;
      }
      if (state.code === "E_ZIP_UNSAFE_PATH") {
        return `「${state.label}」里有指向压缩包外面的路径，已拒绝。`;
      }
      if (state.code === "E_BODY_TOO_LARGE") {
        return `「${state.label}」超过 ${formatBytes(MAX_IMPORT_BYTES)} 上限，没有上传。`;
      }
      if (state.code === "HTTP_404") {
        return "导入功能还没生效：Host 半区需要重启 DSH 才会加载新代码。";
      }
      return `导入「${state.label}」失败：${state.detail !== "" ? state.detail : state.code}`;
    default:
      return "";
  }
}
function importLevel(state) {
  if (state.phase === "uploading") return "info";
  if (state.phase === "done") return state.degraded ? "warn" : "none";
  if (state.phase === "failed") return "error";
  return "none";
}
export {
  IDLE_IMPORT,
  MAX_IMPORT_BYTES,
  MOC3_ENDIANNESS,
  acceptDrop,
  describeImport,
  describeLibrary,
  describeModel,
  evaluatePick,
  formatBytes,
  hasError,
  hasWarning,
  importLevel,
  isImporting,
  isLoadable,
  modelLabel,
  pickDefault
};
