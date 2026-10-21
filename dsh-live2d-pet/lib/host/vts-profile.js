/**
 * VTube Studio 的模型配置（`*.vtube.json`）→ 标准 `model3.json` 的能力声明。
 *
 * 存在的理由：用户从模型站下载的包，很多是**为 VTube Studio 做的**。这类包的
 * 「登记表」不在 `model3.json` 里，而在同目录的 `<模型名>.vtube.json` 里 ——
 * 表情挂在 `Hotkeys[]`（`Action: "ToggleExpression"`），待机动作挂在
 * `FileReferences.IdleAnimation`。VTS 读这份配置，**其它任何 Cubism 运行时都不读**。
 * 于是同一套文件，在 VTS 里点一下就脸红，在我们的插件里却是「0 个表情」。
 *
 * 实测例子（用户库里的 `miku`，2026-10）：
 *   `miku.model3.json`    没有 `Motions` / `Expressions` 段
 *   磁盘上                1 个 `.motion3.json` + 8 个 `.exp3.json`
 *   `miku.vtube.json`     `LastSavedVTubeStudioVersion 1.32.67 / Steam`，
 *                         8 条 `ToggleExpression` 热键 +
 *                         `IdleAnimation = Scene1.motion3.json`
 * 两半都没说谎，用户夹在中间 —— 只会以为插件坏了。
 *
 * 这里做的事：把 `.vtube.json` 声明的东西**合并进** `model3.json` 的内存副本，
 * **绝不写盘**（模型的版权声明里常常写着「不可二传二改」，我们连一个字节都不动）。
 * 合并后的副本供两处使用，而且必须是**同一份**：
 *   1. `lib/index.js` 的 `/model/<rel>` 路由把它交给客户端 ——
 *      否则 Cubism SDK 按标准读 `model3.json`，那些表情它根本看不见；
 *   2. `model-library.js` 用它统计能力、并据此判断哪些文件「真的没人引用」。
 * 两边各算一次，就会出现「列表说有 8 个表情、实际一个都点不出来」——
 * 第八个缺陷（`MAX_TEXT_CHARS` 写了两遍）的形状。
 *
 * 合并是**纯加法**，三条规矩：
 *   1. `model3.json` 里已经登记的文件一个都不重复加（按归一化路径去重）。
 *   2. 只认 `ToggleExpression` 热键与 `IdleAnimation`。其余动作
 *      （`RemoveAllExpressions` / `ToggleItem` / `TriggerAnimation` …）需要本插件
 *      没有的能力，一律跳过，并在 `skipped` 里记个数。
 *   3. 路径不安全、后缀不对、或磁盘上根本不存在 —— **跳过这一项**。
 *      合成一份指向不存在文件的 `model3.json`，症状是「模型加载到一半失败」，
 *      比「少一个表情」难查得多。
 *
 * @module dsh-live2d-pet/host/vts-profile
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  EXPRESSION_SUFFIX,
  MOTION_SUFFIX,
  isSafeRefPath,
  normalizeRefPath,
} from './ref-path.js';
import {
  collectLooseModelFiles,
  EMPTY_LOOSE_MERGE,
  mergeLooseIntoSetting,
} from './loose-files.js';

/*
 * 这两个函数曾经就住在这个文件里，现在搬去了 `ref-path.js`（理由是那里有一段
 * 关于循环导入的说明）。**这里继续把它们转出去**，所以
 * `import { normalizeRefPath } from './vts-profile.js'` 这样的既有写法一律照旧能用
 * —— 搬家的改动不该让调用方跟着改一遍，否则漏掉一处就是运行时的 `undefined`。
 */
export { MAX_REF_CHARS, isSafeRefPath, normalizeRefPath } from './ref-path.js';

/** VTS 配置的文件名后缀。 */
export const VTS_PROFILE_SUFFIX = '.vtube.json';

/** 模型定义的文件名后缀。 */
export const MODEL3_SUFFIX = '.model3.json';

/** VTS 里「切换表情」的热键动作名。 */
const ACTION_TOGGLE_EXPRESSION = 'ToggleExpression';

/** 同目录里最多看几个 `*.vtube.json` 去对 `FileReferences.Model`。 */
const MAX_PROFILE_CANDIDATES = 16;

/** 合并结果的空值。调用方拿它当「什么都没加」的常量用，避免各写一份字面量。 */
export const EMPTY_MERGE = Object.freeze({
  addedExpressions: Object.freeze([]),
  addedMotions: Object.freeze([]),
  changed: false,
});


/**
 * 解析 `*.vtube.json` 的**内容**（不碰文件系统）。
 *
 * 坏 JSON、缺字段、字段类型不对 —— 一律回一份空结果，**不抛**。
 * 理由和 `model-library.js` 第 3 条设计约束一样：这是用户机器上的第三方文件，
 * 它坏了不该让整次体检失败，只该让合并什么都没加。
 *
 * @param {string} text
 * @returns {{ ok: boolean, model: string, idle: string, expressions: Array<{ name: string, file: string }>, skipped: number }}
 */
export function parseVtsProfile(text) {
  const empty = { ok: false, model: '', idle: '', expressions: [], skipped: 0 };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return empty;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return empty;

  const refs = json.FileReferences;
  const refsObject = refs !== null && typeof refs === 'object' && !Array.isArray(refs) ? refs : {};
  const model = typeof refsObject.Model === 'string' ? refsObject.Model : '';
  const idleRaw = typeof refsObject.IdleAnimation === 'string' ? refsObject.IdleAnimation : '';
  const idle = isSafeRefPath(idleRaw, MOTION_SUFFIX) ? idleRaw : '';

  const hotkeys = Array.isArray(json.Hotkeys) ? json.Hotkeys : [];
  const expressions = [];
  const seen = new Set();
  let skipped = 0;

  for (const hotkey of hotkeys) {
    if (hotkey === null || typeof hotkey !== 'object' || Array.isArray(hotkey)) continue;
    if (hotkey.Action !== ACTION_TOGGLE_EXPRESSION) {
      // `RemoveAllExpressions` / `ToggleItem` / … 都是**动作**而不是表情，
      // 而且需要本插件没有的能力。记个数，让上层能说清「还有几项没接」。
      if (typeof hotkey.Action === 'string' && hotkey.Action !== '') skipped += 1;
      continue;
    }
    const file = hotkey.File;
    if (!isSafeRefPath(file, EXPRESSION_SUFFIX)) {
      skipped += 1;
      continue;
    }
    const key = normalizeRefPath(file);
    if (seen.has(key)) continue; // 同一个文件挂两个热键是常见写法，只算一次
    seen.add(key);
    const name = typeof hotkey.Name === 'string' && hotkey.Name.trim() !== ''
      ? hotkey.Name.trim()
      : basename(String(file).replace(/\\/g, '/'), EXPRESSION_SUFFIX);
    expressions.push({ name, file });
  }

  return { ok: true, model, idle, expressions, skipped };
}

/**
 * 找出并读入某个 `model3.json` 对应的 `*.vtube.json`，**并过滤掉磁盘上不存在的引用**。
 *
 * 两条查找路径：
 *   1. 同名换后缀 —— `miku.model3.json` → `miku.vtube.json`（绝大多数情况）；
 *   2. 同目录里任何一个 `*.vtube.json`，只要它 `FileReferences.Model` 的**文件名**
 *      与我们这份相等。VTS 自己就是这么记的，所以包被改过名时靠它能找回来。
 *
 * 每条被保留下来的引用都必须 `existsSync`。这一条不是优化而是正确性：
 * 合成本来就是要喂给加载器的，指向空气的引用只会把「少一个表情」变成
 * 「模型加载失败」。
 *
 * @param {string} settingAbsolute `model3.json` 的绝对路径
 * @returns {{ found: boolean, path: string, idle: string, expressions: Array<{ name: string, file: string }>, skipped: number }}
 */
export function readVtsProfileFor(settingAbsolute) {
  const empty = { found: false, path: '', idle: '', expressions: [], skipped: 0 };
  if (typeof settingAbsolute !== 'string' || settingAbsolute === '') return empty;

  const name = basename(settingAbsolute);
  if (!name.toLowerCase().endsWith(MODEL3_SUFFIX)) return empty;
  const stem = name.slice(0, name.length - MODEL3_SUFFIX.length);
  const dir = dirname(settingAbsolute);

  const candidates = [];
  const sameStem = join(dir, `${stem}${VTS_PROFILE_SUFFIX}`);
  if (existsSync(sameStem)) candidates.push(sameStem);

  if (candidates.length === 0) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return empty; // 目录读不了：不是错误，只是没有可合并的东西
    }
    let looked = 0;
    for (const entry of entries) {
      if (looked >= MAX_PROFILE_CANDIDATES) break;
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(VTS_PROFILE_SUFFIX)) continue;
      looked += 1;
      const candidate = join(dir, entry.name);
      const parsed = parseVtsProfile(readText(candidate));
      // 只在**明确指向我们这份**时才采纳：没有 `Model` 字段的配置不乱认，
      // 否则同目录放两个模型时会拿错登记表。
      if (parsed.ok && parsed.model !== '' && basename(parsed.model.replace(/\\/g, '/')) === name) {
        candidates.push(candidate);
        break;
      }
    }
  }

  if (candidates.length === 0) return empty;

  const profilePath = candidates[0];
  const parsed = parseVtsProfile(readText(profilePath));
  if (!parsed.ok) return { ...empty, path: profilePath };

  const expressions = parsed.expressions.filter((exp) => existsSync(join(dir, exp.file)));
  const idle = parsed.idle !== '' && existsSync(join(dir, parsed.idle)) ? parsed.idle : '';
  // 声明了却在磁盘上找不到的，也算进 `skipped` —— 上层那句话要说得出
  // 「还有几项没接上」，而不是悄悄少报一个。
  const missed = (parsed.expressions.length - expressions.length) + (parsed.idle !== '' && idle === '' ? 1 : 0);

  return { found: true, path: profilePath, idle, expressions, skipped: parsed.skipped + missed };
}

/**
 * 把 VTS 声明合并进一份 `model3.json`。**纯函数，不改入参。**
 *
 * @param {object} setting 解析后的 `model3.json`
 * @param {{ expressions?: Array<{ name: string, file: string }>, idle?: string }} profile
 * @returns {{ setting: object, addedExpressions: string[], addedMotions: string[], changed: boolean }}
 */
export function mergeVtsIntoSetting(setting, profile) {
  if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) {
    return { setting, ...EMPTY_MERGE };
  }
  const declared = Array.isArray(profile?.expressions) ? profile.expressions : [];
  const idle = typeof profile?.idle === 'string' ? profile.idle : '';
  if (declared.length === 0 && idle === '') return { setting, ...EMPTY_MERGE };

  const refs = setting.FileReferences;
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) {
    // 连 `FileReferences` 都没有的模型，`inspectModel` 已经报了
    // `E_MODEL_JSON_INVALID`；在这里补一个段只会掩盖那条真正的错。
    return { setting, ...EMPTY_MERGE };
  }

  const existingExpressions = Array.isArray(refs.Expressions) ? refs.Expressions : [];
  const existingMotions = refs.Motions !== null && typeof refs.Motions === 'object' && !Array.isArray(refs.Motions)
    ? refs.Motions
    : {};

  // 先把「已经登记过的文件」收齐，后面所有加法都拿它去重。
  const referenced = new Set();
  for (const exp of existingExpressions) {
    if (exp !== null && typeof exp === 'object' && typeof exp.File === 'string') {
      referenced.add(normalizeRefPath(exp.File));
    }
  }
  for (const group of Object.keys(existingMotions)) {
    const list = existingMotions[group];
    if (!Array.isArray(list)) continue;
    for (const motion of list) {
      if (motion !== null && typeof motion === 'object' && typeof motion.File === 'string') {
        referenced.add(normalizeRefPath(motion.File));
      }
    }
  }

  const addedExpressions = [];
  const nextExpressions = existingExpressions.slice();
  for (const exp of declared) {
    if (exp === null || typeof exp !== 'object') continue;
    if (!isSafeRefPath(exp.file, EXPRESSION_SUFFIX)) continue;
    const key = normalizeRefPath(exp.file);
    if (referenced.has(key)) continue;
    referenced.add(key);
    nextExpressions.push({ Name: exp.name, File: exp.file });
    addedExpressions.push(exp.file);
  }

  const addedMotions = [];
  const nextMotions = { ...existingMotions };
  if (idle !== '' && isSafeRefPath(idle, MOTION_SUFFIX) && !referenced.has(normalizeRefPath(idle))) {
    const idleList = Array.isArray(nextMotions.Idle) ? nextMotions.Idle.slice() : [];
    idleList.push({ File: idle });
    nextMotions.Idle = idleList;
    addedMotions.push(idle);
  }

  if (addedExpressions.length === 0 && addedMotions.length === 0) {
    return { setting, ...EMPTY_MERGE };
  }

  const nextRefs = { ...refs };
  if (addedExpressions.length > 0) nextRefs.Expressions = nextExpressions;
  if (addedMotions.length > 0) nextRefs.Motions = nextMotions;

  return {
    setting: { ...setting, FileReferences: nextRefs },
    addedExpressions,
    addedMotions,
    changed: true,
  };
}

/**
 * ★ 唯一一条合并路径：`model3.json` + `*.vtube.json` + 目录里散着没登记的文件。
 *
 * ## 为什么必须只有一条
 *
 * 这份合成结果有两个消费者，而且它们**必须看到同一份**：
 *
 *   1. `/model/<rel>` 路由把它交给客户端（少一项 = 点表情没反应）；
 *   2. `model-library.js` 用它统计能力、并据此判断哪些文件「真的没人引用」
 *      （多一项 = 面板说有、实际点不出来）。
 *
 * 两边各合一次，就会出现「列表说有 8 个表情、实际一个都点不出来」——
 * 第八个缺陷（`MAX_TEXT_CHARS` 写了两遍）的形状。所以两处都调这一个函数，
 * 而不是各自拼一遍。
 *
 * ## 顺序是有意的：先 VTS，后散文件
 *
 * VTS 配置里写的是**用户在 VTS 里亲手点过**的那些（有名字、有意图），
 * 散文件是**从文件名猜**的。让前者先占名字，后者才不会把 `ToggleExpression`
 * 指的那个表情挤成按文件名猜的名字。
 *
 * @param {object} setting 磁盘上那份 `model3.json` 解析出来的对象
 * @param {string} absolute 该 `model3.json` 的绝对路径
 * @param {{ root?: string, dir?: string, onDir?: (absolute: string) => void, loose?: { motions: string[], expressions: string[] } }} [options]
 *   `root` / `dir` 用来找散文件（体检器知道模型库根目录，路由只知道绝对路径，
 *   后者由 `mergeSettingBytes()` 从 `absolute` 推出来）；`onDir` 是缓存记账回调。
 *   vtsChanged 由 `changed` 统一表示；`added*` 只记 VTS 那一半，
 *   `loose*` 记散文件那一半，`found*` 是散文件**扫到**的全部（含没接上的）。
 *   `changed === false` 时调用方必须继续用原来那份 `setting` 对象（同一个引用）。
 * @returns {{
 *   setting: object,
 *   changed: boolean,
 *   addedExpressions: string[],
 *   addedMotions: string[],
 *   vtsFound: boolean,
 *   vtsPath: string,
 *   vtsSkipped: number,
 *   vtsChanged: boolean,
 *   foundMotions: string[],
 *   foundExpressions: string[],
 *   looseChanged: boolean,
 *   looseExpressions: string[],
 *   looseMotions: string[],
 *   looseGroups: string[],
 *   looseSkipped: number,
 *   looseTruncated: boolean,
 *   looseRejected: Array<{ rel: string, why: string }>,
 * }}
 */
export function mergeModelSetting(setting, absolute, options = {}) {
  const empty = {
    setting,
    changed: false,
    addedExpressions: [],
    addedMotions: [],
    vtsFound: false,
    vtsPath: '',
    vtsSkipped: 0,
    vtsChanged: false,
    // 目录里**扫到**的散文件（不管有没有被认领）与**真的接上**的那些分开报：
    // 体检器要能说出「扫到 3 个、接上 2 个，剩下 1 个是因为路径不安全被拒的」
    // 两件事合成一个数字，用户就永远不知道少的那一个去哪了
    foundMotions: [],
    foundExpressions: [],
    looseChanged: false,
    looseExpressions: [],
    looseMotions: [],
    looseGroups: [],
    looseSkipped: 0,
    looseTruncated: false,
    looseRejected: [],
  };

  let current = setting;
  let vtsFound = false;
  let vtsPath = '';
  let vtsSkipped = 0;
  let vtsChanged = false;
  let addedExpressions = [];
  let addedMotions = [];

  try {
    const profile = readVtsProfileFor(absolute);
    vtsFound = profile.found === true;
    vtsPath = typeof profile.path === 'string' ? profile.path : '';
    vtsSkipped = Number.isFinite(profile.skipped) ? profile.skipped : 0;
    if (vtsFound) {
      const merged = mergeVtsIntoSetting(current, profile);
      vtsChanged = merged.changed === true;
      if (vtsChanged) current = merged.setting;
      addedExpressions = merged.addedExpressions;
      addedMotions = merged.addedMotions;
    }
  } catch {
    // VTS 那一半失败不该连累散文件那一半：两半是各自独立的加分项
    vtsFound = false;
    vtsPath = '';
    vtsSkipped = 0;
    vtsChanged = false;
    addedExpressions = [];
    addedMotions = [];
  }

  // 散文件那一半：扫的是**模型定义所在的那棵子树**。
  // 路由只给了绝对路径，所以 root 与 dir 都取它所在目录 —— 走查出来的相对路径
  // 于是天然是「相对模型目录」，正好是 `FileReferences` 要的形式。
  const modelDir = options.dir !== undefined && options.dir !== null
    ? options.dir
    : dirname(absolute);
  const root = typeof options.root === 'string' ? options.root : modelDir;

  /*
   * `options.loose` 是**已经走查过的结果**，调用方（体检器）为了算缓存指纹
   * 必须先走一遍 —— 直接复用，别在这里再走一遍：两次遍历之间目录可能变，
   * 于是「指纹按 A 算、结果按 B 报」。路由那条路径没有现成的结果，才自己走。
   */
  let loose = options.loose;
  if (loose === undefined || loose === null) {
    loose = { motions: [], expressions: [] };
    try {
      loose = collectLooseModelFiles(root, modelDir, options.onDir);
    } catch {
      loose = { motions: [], expressions: [] };
    }
  }

  let looseResult = { ...EMPTY_LOOSE_MERGE };
  try {
    looseResult = mergeLooseIntoSetting(current, loose);
    if (looseResult.changed) current = looseResult.setting;
  } catch {
    looseResult = { ...EMPTY_LOOSE_MERGE };
  }

  const changed = current !== setting;
  return {
    ...empty,
    setting: current,
    changed,
    addedExpressions,
    addedMotions,
    vtsFound,
    vtsPath,
    vtsSkipped,
    vtsChanged,
    foundMotions: [...loose.motions],
    foundExpressions: [...loose.expressions],
    looseChanged: looseResult.changed === true,
    looseExpressions: [...looseResult.addedExpressions],
    looseMotions: [...looseResult.addedMotions],
    looseGroups: [...looseResult.addedGroups],
    looseSkipped: looseResult.skipped,
    looseTruncated: looseResult.truncated === true,
    looseRejected: [...looseResult.rejected],
  };
}

/**
 * 把一份 `model3.json` 的**磁盘字节**变成应该交给客户端的**字节**。
 *
 * 为什么单独抽成函数，而不是在路由里写五行：这段逻辑的正确性对用户是隐形的。
 * 合并没生效时，客户端拿到的是原始 `model3.json` —— 它**依然是一个完全合法的
 * 模型定义**，只是少了 8 个表情。加载不报错、面板数字也对（因为 `/models`
 * 那一侧算对了），只有「点表情没反应」这一件事不对，而那件事用户不会去查日志。
 *
 * 三条兜底方向一致：**宁可交原始文件，也不交半成品**。
 * 这段代码在加载模型的必经之路上，它出错的症状是「模型打不开」。
 *
 * @param {Buffer} buf 磁盘上读到的原始字节
 * @param {string} absolute 该 `model3.json` 的绝对路径
 * @returns {Buffer} 合并后的字节；不需要合并 / 合并失败 / 结果为空时，原样返回 `buf`
 */
export function mergeSettingBytes(buf, absolute) {
  if (!Buffer.isBuffer(buf)) return buf;
  try {
    const json = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
    const merged = mergeModelSetting(json, absolute);
    if (!merged.changed) return buf;
    const out = Buffer.from(JSON.stringify(merged.setting), 'utf8');
    // 空 buffer 会让客户端 `JSON.parse('')` 抛错 —— 那时模型是真的打不开。
    return out.byteLength > 0 ? out : buf;
  } catch {
    return buf;
  }
}

/**
 * 把合并结果说成一句人话，用于 `problems[].message`。
 *
 * 单独抽出来是因为**两处**要用同一句话（`model-library.js` 的体检报告与将来可能的
 * 诊断输出）—— 各写一份就会出现「面板说 8 个表情、日志说 9 个」。
 *
 * @param {string[]} addedExpressions
 * @param {string[]} addedMotions
 * @returns {string}
 */
export function describeVtsMerge(addedExpressions, addedMotions) {
  const parts = [];
  if (addedExpressions.length > 0) parts.push(`${addedExpressions.length} 个表情`);
  if (addedMotions.length > 0) parts.push(`${addedMotions.length} 个待机动作`);
  if (parts.length === 0) return '';
  // `、` 而不是 `和`：中文里并列两项以上用顿号，且 `和` 前面不留空格会
  // 粘成「表情和1 个」这种读起来像错别字的样子（探针实测输出）。
  return `${parts.join('、')}来自 VTube Studio 配置`;
}

/**
 * 读文本，失败回空串（调用方只关心「有没有东西可解析」）。
 *
 * @param {string} path
 * @returns {string}
 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
