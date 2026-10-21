/**
 * capabilities.js — 模型能力清单：**「AI 能控制什么」的唯一事实来源**。
 *
 * 为什么单独一个模块:
 *   方案文档 §4.3 把 `model:capabilities` 定为 Host ↔ Client 的冻结契约，§5.2 说
 *   P2 与 P3 **都**只通过它耦合 —— 换句话说，这张清单的形状一旦两边理解不一致，
 *   P2 和 P3 会各自按自己的理解去调参数，而症状是「AI 说了个不存在的表情名」
 *   这种查起来很绕的问题。所以宿主侧（要把它喂给 LLM）和客户端（只有它能枚举
 *   真实参数）**必须用同一份代码**。见下面那条约束。
 *
 * ★ 硬约束：本文件必须保持**零 import、不碰任何 `node:` 内置模块**。
 *   客户端 bundle 也会 import 它（esbuild 直接内联），一旦有人在这里写
 *   `import fs from 'node:fs'`，客户端构建会当场失败 —— 这是刻意选的失败方式：
 *   在构建时炸掉，而不是在运行时让桌宠消失（方案文档 §9.2）。
 *
 * 数据从哪来:
 *   - `expressions` / `motionGroups` / `hitAreas` 只能从 `.model3.json` 读
 *     （`FileReferences.Expressions` / `FileReferences.Motions` / `HitAreas`）。
 *   - `parameters` 只能由 Cubism Core 枚举（客户端 `PetModel.describeParameters()`）。
 *     Host 没有 Core，所以它拿到的是客户端 POST 上来的清单。
 *
 * 两个入口，一个形状:
 *   - `buildCapabilities({ settings, parameters })` —— 客户端用，输入是可信的
 *     （自己的 `describeParameters()` 与刚下载的模型定义）。
 *   - `normalizeCapabilities(raw)` —— Host 用，输入是**网线上来的**，什么都可能是。
 *   两者共用同一批内部归一化函数，所以对合法输入它们不可能产生不同的形状。
 *   门禁里有一条断言钉着这个恒等式：
 *   `normalizeCapabilities(buildCapabilities(x))` 必须逐字段等于 `buildCapabilities(x)`。
 */

/**
 * 一个参数条目。`describeParameters()`（`src/client/pet-model.ts`）产出的就是它。
 *
 * @typedef {object} CapabilityParameter
 * @property {string} id   参数 id，**原样搬运**（见下面的大小写警告）。
 * @property {number} min
 * @property {number} max
 * @property {number} def
 */

/**
 * 一个动作组。`count` 是这个组里动作的条数。
 *
 * @typedef {object} CapabilityMotionGroup
 * @property {string} name
 * @property {number} count
 */

/**
 * 一个可点区域。
 *
 * @typedef {object} CapabilityHitArea
 * @property {string} id
 * @property {string} name
 */

/**
 * 模型能力清单 —— Host ↔ Client 的冻结契约（方案文档 §4.3）。
 *
 * ★ 四个数组的**顺序有意义**：参数顺序就是 moc3 里的顺序，动作组顺序就是
 *   `.model3.json` 里的书写顺序。`capabilitiesEqual()` 因此是顺序敏感的，
 *   客户端也是按这个顺序上报的。
 *
 * ★ 参数 id **大小写不统一**，必须原样搬运：官方样本 Wanko 用全大写
 *   `PARAM_ANGLE_X`，Haru 用驼峰 `ParamAngleX`。任何「顺手规范化成驼峰」的
 *   善意整理都会让 P3 的 AI 指令在这类模型上**静默失效** —— 参数名不匹配时
 *   `setParameterValue` 什么都不做，也不报错。门禁 `tools/test-capabilities.mjs`
 *   的 `[3b]` 段专门钉着这件事。
 *
 * @typedef {object} Capabilities
 * @property {CapabilityParameter[]} parameters
 * @property {{name: string, file: string}[]} expressions
 * @property {CapabilityMotionGroup[]} motionGroups
 * @property {CapabilityHitArea[]} hitAreas
 */

/**
 * 上限。存在的理由不是「防止恶意攻击」（Host 半区还有更外层的限额），
 * 而是 `describeCapabilities()` 的输出会**进 LLM 的 system prompt** ——
 * 一个坏掉的包里可以写 10 万个表情名，那会直接把 prompt 撑爆。
 */
export const MAX_PARAMETERS = 512;
export const MAX_EXPRESSIONS = 256;
export const MAX_MOTION_GROUPS = 64;
export const MAX_HIT_AREAS = 64;
export const MAX_STRING_LENGTH = 128;

/** `describeCapabilities()` 默认最多列几个参数（数据本身不截断，只有文本截断）。 */
export const DEFAULT_MAX_LISTED_PARAMETERS = 32;

/** 口型通道驱动的两个参数。它们必须**总是**出现在给 LLM 的文本里。 */
export const MOUTH_PARAMETER_IDS = ['ParamMouthOpenY', 'ParamMouthForm'];

/** 空清单。所有「不知道」都归一到它，而不是 `null`。 */
export const EMPTY_CAPABILITIES = Object.freeze({
  parameters: [],
  expressions: [],
  motionGroups: [],
  hitAreas: [],
});

/* ------------------------------------------------------------------ *
 * 内部归一化：每一个都「永不抛、永不返回 undefined」
 * ------------------------------------------------------------------ */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 只接受非空字符串，并夹断长度。不是字符串就是 `''`（由调用方决定丢不丢）。 */
function text(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > MAX_STRING_LENGTH ? trimmed.slice(0, MAX_STRING_LENGTH) : trimmed;
}

/** 只接受有限数字。`NaN` / `Infinity` / `"3"` 全部落到 `fallback`。 */
function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 资源路径：非空字符串，**原样返回**（不 trim、不夹断长度）。
 *
 * 刻意与 `text()` 不同，两个理由：
 *   - **夹断会指向另一个文件**。`text()` 的 128 字上限是给 LLM 的 prompt 用的，
 *     而路径是给 `fetch()` 用的；一个深层目录里的 `.exp3.json` 完全可能超过 128 字。
 *   - **两侧空格是内容的一部分**（虽然通常意味着笔误）。路径是不透明标识符，
 *     不是给人看的文本，解读权应该留给文件系统 —— 找不到文件会走到
 *     `E_MOTION_LOAD_FAILED`，那是一条能读的错误，比悄悄换一个路径好。
 */
function path(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function normalizeParameters(raw) {
  const out = [];
  for (const item of asArray(raw)) {
    if (out.length >= MAX_PARAMETERS) break;
    // 没有 id 的参数无法被任何指令引用，留着只会让清单变长。
    const id = text(item?.id);
    if (id === '') continue;
    out.push({
      id,
      min: finite(item?.min, 0),
      max: finite(item?.max, 0),
      def: finite(item?.def, 0),
    });
  }
  return out;
}

function normalizeExpressions(raw) {
  const out = [];
  for (const item of asArray(raw)) {
    if (out.length >= MAX_EXPRESSIONS) break;
    const name = text(item?.name);
    if (name === '') continue;
    out.push({ name, file: text(item?.file) });
  }
  return out;
}

function normalizeMotionGroups(raw) {
  const out = [];
  for (const item of asArray(raw)) {
    if (out.length >= MAX_MOTION_GROUPS) break;
    const name = text(item?.name);
    if (name === '') continue;
    const count = Math.max(0, Math.trunc(finite(item?.count, 0)));
    out.push({ name, count });
  }
  return out;
}

function normalizeHitAreas(raw) {
  const out = [];
  for (const item of asArray(raw)) {
    if (out.length >= MAX_HIT_AREAS) break;
    const id = text(item?.id);
    const name = text(item?.name);
    // HitArea 的 `Id` 是碰撞检测用的，`Name` 是给人看的。两者都缺就没有意义。
    if (id === '' && name === '') continue;
    out.push({ id, name });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 动作 / 表情的「文件表」—— 两半区唯一的一份解读
 * ------------------------------------------------------------------ */

/**
 * `Motions[].FadeInTime` / `FadeOutTime` 缺省时用的秒数（和 `actions.js` 的
 * `DEFAULT_FADE_MS` 是同一个 0.3 秒，只是单位不同：那个是给工具契约用的毫秒）。
 */
export const DEFAULT_MOTION_FADE_SECONDS = 0.3;

/**
 * model3.json 里的 `FadeInTime` / `FadeOutTime` 读成秒。
 *
 * 三种情况都退回默认值：字段不存在、不是数字（有导出工具写字符串）、负数。
 * **`0` 是合法值**，代表「不要淡入」—— 所以不能写 `value || DEFAULT`，
 * 那会把显式的 0 变成 0.3。
 */
function readFadeSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MOTION_FADE_SECONDS;
  }
  return value;
}

/**
 * `FileReferences.Motions` → `Map<组名, Array<{file, fadeIn, fadeOut}>>`。
 *
 * ★ **这个函数是 Host 与渲染端之间唯一的一份解读**，两个刻意的选择：
 *
 *   1. **`File` 为空的条目照样占一个位置**（`file` 记成 `''`）。能力清单里的
 *      `motionGroups[].count` 数的是这张表的长度，Host 校验 `index` 用的也是它。
 *      渲染端跳过一条，两边的序号就错位，症状是「AI 说播第 2 个，实际播的是
 *      第 3 个」—— 不报错，只会让人觉得「她今天有点怪」。
 *
 *   2. **一个动作都没有的组不进表**。空组谁也播不了，把它写进能力清单只会让
 *      AI 拿到一个「Host 自己列出来、自己又拒绝」的组名（`index` 无论传什么
 *      都是 `E_MOTION_INDEX_OUT_OF_RANGE`）。以前的实现两边不一致：Host 列它、
 *      渲染端根本没有它。
 *
 * 组名要能过 `text()`（非空、夹断到 `MAX_STRING_LENGTH`）；空名字的组丢掉，
 * 因为它没法被任何指令引用 —— 这一点与 `normalizeMotionGroups()` 一致。
 */
export function motionFileTable(fileReferences) {
  const out = new Map();
  const refs = fileReferences && typeof fileReferences === 'object' ? fileReferences : null;
  const motions = refs === null ? null : refs.Motions;
  if (motions === null || motions === undefined || typeof motions !== 'object' || Array.isArray(motions)) {
    return out;
  }
  for (const [rawName, list] of Object.entries(motions)) {
    const name = text(rawName);
    if (name === '') continue;
    if (!Array.isArray(list) || list.length === 0) continue;
    const entries = [];
    for (const item of list) {
      const source = item !== null && item !== undefined && typeof item === 'object' ? item : null;
      entries.push({
        file: source === null ? '' : path(source.File),
        fadeIn: readFadeSeconds(source === null ? undefined : source.FadeInTime),
        fadeOut: readFadeSeconds(source === null ? undefined : source.FadeOutTime),
      });
    }
    out.set(name, entries);
  }
  return out;
}

/**
 * `FileReferences.Expressions` → `Map<名字, 文件路径>`。
 *
 * 只保留 **名字与路径都非空** 的条目：缺一个就没法被任何指令引用，也没法加载。
 * 字段名同时认 `Name`/`File`（官方拼法）与 `name`/`file`（有些导出工具用小写）
 * —— 渲染端以前只认前者，于是这类模型上会出现「Host 说这个表情存在、渲染端
 * 说找不到」的分歧。
 *
 * 同名表情只留最后一个：渲染端本来就只有一个能生效，列两个同名项只会让 AI
 * 以为有两个可以选。
 */
export function expressionFileTable(fileReferences) {
  const out = new Map();
  const refs = fileReferences && typeof fileReferences === 'object' ? fileReferences : null;
  const expressions = refs === null ? null : refs.Expressions;
  if (!Array.isArray(expressions)) {
    return out;
  }
  for (const item of expressions) {
    const source = item !== null && item !== undefined && typeof item === 'object' ? item : null;
    if (source === null) continue;
    const name = text(source.Name ?? source.name);
    const file = path(source.File ?? source.file);
    if (name === '' || file === '') continue;
    out.set(name, file);
  }
  return out;
}

/**
 * 一次播放到底用几秒淡入淡出。
 *
 * ★ 存在的理由是一个**缓存复用**的坑：动作对象按 `组#序号` 缓存在渲染端，
 *   每次播放都在**同一个对象**上改淡入淡出。所以「这次没传 `fadeMs` 就什么都
 *   不写」等于「沿用上一次的值」：
 *
 *     · 工具调用**总是**带 `fadeMs`（Host 填默认 300），于是模型作者在
 *       `Motions[].FadeInTime` 里声明的值在第一次被 AI 播过之后就永久消失了；
 *     · 空闲行为那条路不带 `fadeMs`，复用到一个曾被设过 5000ms 的动作上，
 *       待机动作会一直用 5 秒淡入 —— 看起来像「她愣了一下才动」。
 *
 *   所以缺省时必须把**声明值写回去**，而不是什么都不做。
 *
 * @param {unknown} fadeMs        工具契约里的毫秒值，可能是任何东西
 * @param {{fadeIn: number, fadeOut: number}} declared  `motionFileTable()` 里的声明值（秒）
 * @param {number} maxSeconds     上限（由调用方给出，本文件不 import 任何东西）
 */
export function resolveMotionFades(fadeMs, declared, maxSeconds) {
  if (typeof fadeMs === 'number' && Number.isFinite(fadeMs) && fadeMs >= 0) {
    const cap = typeof maxSeconds === 'number' && Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : Infinity;
    const seconds = Math.min(fadeMs / 1000, cap);
    // 工具契约只有一个 `fadeMs`，所以淡入淡出取同一个值（契约本来就这么写的）。
    return { fadeIn: seconds, fadeOut: seconds };
  }
  const source = declared !== null && declared !== undefined && typeof declared === 'object' ? declared : null;
  return {
    fadeIn: readFadeSeconds(source === null ? undefined : source.fadeIn),
    fadeOut: readFadeSeconds(source === null ? undefined : source.fadeOut),
  };
}

/* ------------------------------------------------------------------ *
 * 从模型定义里抽取（Host 与 Client 都走这里）
 * ------------------------------------------------------------------ */

/**
 * 从解析好的 `.model3.json` 里抽三样东西。
 *
 * 设计要点：**只做搬运，不做判断**。字段缺失就返回空数组，而不是报错 ——
 * 模型定义里没有 `Expressions` 是完全合法的（官方样本 Mark 就只有 Idle 一个动作组）。
 * 一个「没有表情」的模型是一个正常模型，不是坏模型。
 *
 * ★ 表情与动作组**由上面那两张表推导**，不另写一遍解析：§6.1 #7 要求「能力清单
 *   与模型实际参数 / 动作组逐项一致」，而以前 Host 与渲染端各自数了一遍
 *   `FileReferences`，对「空动作组」「小写字段名」「同名表情」这些边缘形状给出
 *   了不同的答案。让两边共用一张表，分歧就不再是「要靠门禁发现」的事，而是
 *   压根表达不出来。
 */
export function capabilitiesFromSettings(settings) {
  const refs = settings && typeof settings === 'object' ? settings.FileReferences : null;
  const motions = motionFileTable(refs);
  const expressions = expressionFileTable(refs);

  const motionGroups = [];
  for (const [name, entries] of motions) {
    motionGroups.push({ name, count: entries.length });
  }

  return {
    expressions: [...expressions].map(([name, file]) => ({ name, file })),
    motionGroups,
    hitAreas: asArray(settings?.HitAreas).map((item) => ({
      id: text(item?.Id ?? item?.id),
      name: text(item?.Name ?? item?.name),
    })),
  };
}

/**
 * 客户端入口：模型定义 + Core 枚举出来的参数 → 完整清单。
 *
 * `parameters` 直接就是 `PetModel.describeParameters()` 的返回值形状
 * （`{ id, min, max, def }`），不做任何转换 —— 转换就意味着可能转错，
 * 而门禁的验收标准 #7 正是「清单与模型实际参数逐项一致」。
 */
export function buildCapabilities(input) {
  const source = input && typeof input === 'object' ? input : {};
  const fromSettings = capabilitiesFromSettings(source.settings);
  return normalizeCapabilities({
    parameters: source.parameters,
    expressions: fromSettings.expressions,
    motionGroups: fromSettings.motionGroups,
    hitAreas: fromSettings.hitAreas,
  });
}

/** Host 入口：网线上来的东西 → 保证可用的清单。永远不抛。 */
export function normalizeCapabilities(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    parameters: normalizeParameters(source.parameters),
    expressions: normalizeExpressions(source.expressions),
    motionGroups: normalizeMotionGroups(source.motionGroups),
    hitAreas: normalizeHitAreas(source.hitAreas),
  };
}

/* ------------------------------------------------------------------ *
 * 比较、摘要、给 LLM 的文本
 * ------------------------------------------------------------------ */

/**
 * 逐项深比。**顺序敏感** —— 参数顺序就是 moc3 里的顺序，表情/动作组顺序就是
 * 模型定义里的顺序。顺序变了说明换了一个模型，而「换了模型要重新注入能力清单」
 * 正是 `model:switched` 事件的全部意义。
 */
export function capabilitiesEqual(a, b) {
  const left = normalizeCapabilities(a);
  const right = normalizeCapabilities(b);
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 短指纹，用来打日志与判断「清单变了没有」。
 *
 * 为什么不直接比较：清单可能有 200 个参数，日志里糊一整坨没人看。
 * 为什么自己写 FNV-1a 而不是 `crypto`：这是个零依赖模块（见文件头那条硬约束），
 * 而且它只需要「不同就不同」，不需要抗碰撞。
 */
export function capabilitiesDigest(raw) {
  const caps = normalizeCapabilities(raw);
  const canonical = JSON.stringify(caps);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-p${caps.parameters.length}-e${caps.expressions.length}-m${caps.motionGroups.length}-h${caps.hitAreas.length}`;
}

/** 一行中文摘要，给面板与 `/status` 用。 */
export function summarizeCapabilities(raw) {
  const caps = normalizeCapabilities(raw);
  const total =
    caps.parameters.length + caps.expressions.length + caps.motionGroups.length + caps.hitAreas.length;
  if (total === 0) return '能力清单还是空的（模型还没加载完）';
  const parts = [];
  if (caps.expressions.length > 0) parts.push(`${caps.expressions.length} 个表情`);
  if (caps.motionGroups.length > 0) parts.push(`${caps.motionGroups.length} 个动作组`);
  if (caps.hitAreas.length > 0) parts.push(`${caps.hitAreas.length} 个可点区域`);
  if (caps.parameters.length > 0) parts.push(`${caps.parameters.length} 个参数`);
  return parts.join('、');
}

function joinNames(names, limit) {
  const shown = names.slice(0, limit);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join('、')}…（另有 ${rest} 个）` : shown.join('、');
}

/**
 * 生成要注入 LLM 的文本。
 *
 * 它进的是 system prompt，所以每一行都要有信息量：**列出来的必须是能被引用的名字**，
 * 而不是「有 8 个表情」这种 LLM 没法用的说法。
 *
 * 参数**必然会被截断**（真实模型动辄 130+ 个参数，全列出来会挤掉对话上下文），
 * 但截断必须说清楚，否则 LLM 会以为自己已经看到了全部、然后去猜没列出来的名字。
 * 口型那两个参数永远在列 —— 它们是这个插件自己驱动的通道。
 */
export function describeCapabilities(raw, options = {}) {
  const caps = normalizeCapabilities(raw);
  const limit = Math.max(1, Math.trunc(finite(options.maxParameters, DEFAULT_MAX_LISTED_PARAMETERS)));

  if (
    caps.parameters.length === 0 &&
    caps.expressions.length === 0 &&
    caps.motionGroups.length === 0 &&
    caps.hitAreas.length === 0
  ) {
    return '当前模型能力：还没有读到（模型未加载完成，或者模型里没有任何表情 / 动作 / 参数）。';
  }

  const lines = ['当前模型能力（只能用下面这些名字，不要编造）：'];

  if (caps.expressions.length > 0) {
    lines.push(`- 表情（${caps.expressions.length}）：${joinNames(caps.expressions.map((e) => e.name), 24)}`);
  } else {
    lines.push('- 表情：这个模型没有表情。');
  }

  if (caps.motionGroups.length > 0) {
    const described = caps.motionGroups.map((g) => `${g.name}（${g.count} 个动作）`);
    lines.push(`- 动作组（${caps.motionGroups.length}）：${joinNames(described, 12)}`);
  } else {
    lines.push('- 动作组：这个模型没有动作。');
  }

  if (caps.hitAreas.length > 0) {
    lines.push(
      `- 可点区域（${caps.hitAreas.length}）：${joinNames(caps.hitAreas.map((h) => h.name || h.id), 12)}`,
    );
  }

  if (caps.parameters.length > 0) {
    // 先按模型顺序取前 limit 个，再把口型参数补进去（去重、保持稳定顺序）。
    const picked = caps.parameters.slice(0, limit);
    const seen = new Set(picked.map((p) => p.id));
    for (const id of MOUTH_PARAMETER_IDS) {
      if (seen.has(id)) continue;
      const found = caps.parameters.find((p) => p.id === id);
      if (found) {
        picked.push(found);
        seen.add(id);
      }
    }
    const rendered = picked.map((p) => `${p.id}（${p.min}~${p.max}）`);
    const omitted = caps.parameters.length - picked.length;
    const head = `- 参数（共 ${caps.parameters.length} 个，下面列出 ${picked.length} 个`;
    lines.push(`${head}${omitted > 0 ? `，另有 ${omitted} 个没有列出` : ''}）：${rendered.join('、')}`);
  }

  return lines.join('\n');
}
