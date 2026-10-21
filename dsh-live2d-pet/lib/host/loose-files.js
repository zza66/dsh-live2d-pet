/**
 * 散在模型目录里、两份登记表（`model3.json` 与 `*.vtube.json`）都没写到的
 * 动作 / 表情文件 —— 自动认领它们。
 *
 * ## 为什么需要这个模块
 *
 * 用户在模型库里放了三个 VTS 转换版的包，问「有没有表情和动作」。体检报告给的是
 * 一份**精确但没有用**的答案：
 *
 *   `akari_vts`   磁盘上 3 个 `.motion3.json` + 4 个 `.exp3.json`，一个都没登记
 *   `hiyori_vts`  磁盘上 10 个 `.motion3.json`，一个都没登记
 *   `miku`        VTS 配置里登记了，已经能用了
 *
 * 前面的 `E_MOTION_FILES_UNREFERENCED` / `E_EXPRESSION_FILES_UNREFERENCED` 把症状
 * 说得很清楚（「要在 FileReferences 里登记」），但**说清楚症状不等于能用**。
 * 用户要的是点一下就有反应，而不是学会改 `model3.json`。
 *
 * ## 和 `vts-profile.js` 的关系
 *
 * 两者是同一件事的两半，合起来才构成「一份登记表」：
 *
 *   1. `vts-profile.js`  登记表在**另一个文件**里（`*.vtube.json`）；
 *   2. 这里              登记表**根本不存在**，只能靠「目录里有什么」推出来。
 *
 * 所以两半必须走**同一条合并路径**（`mergeModelSetting()`）。分别合的话，
 * 会出现「列表说有 8 个表情、实际一个都点不出来」—— 那是第八个缺陷的形状。
 *
 * ## 三条边界
 *
 * 1. **只扫模型定义所在的那棵子树，遇到「里面还有 `.model3.json`」的子目录就停**
 *    —— 那是另一个模型自己的地盘，把它的动作算到我们头上会造出假警报。
 * 2. **认领是纯加法，绝不写盘**（与 VTS 合并同一条规矩：模型的版权声明里常常写着
 *    「不可二传二改」，我们连一个字节都不动）。合并只发生在交给客户端的内存副本里。
 * 3. **有上限**。目录树是用户可以随手丢东西进去的地方，`readdirSync` 撞上几千个
 *    `.motion3.json` 时我们要能停下来，并**说清楚自己停下来了**（`truncated`）——
 *    悄悄少加几个，症状是「面板数字比目录里的文件少」，没人查得出来。
 *
 * @module dsh-live2d-pet/host/loose-files
 */

import { readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

/*
 * ★ 从 `ref-path.js` 拿，**不是**从 `vts-profile.js` 拿。
 *
 * 写成 `from './vts-profile.js'` 会形成 `vts-profile.js → loose-files.js →
 * vts-profile.js` 的循环导入：ESM 能容忍它，但靠的是求值时序的侥幸 ——
 * 一旦谁调整了 import 顺序，症状是「某个模型的表情数莫名变 0」，
 * 而且只在部分模块加载顺序下复现。依赖方向必须是单向的：
 *
 *     ref-path.js  ←  loose-files.js  ←  vts-profile.js
 *
 * （`vts-profile.js` 仍然把这两个函数转出去，所以既有 import 不用改。）
 */
import { EXPRESSION_SUFFIX, MOTION_SUFFIX, isSafeRefPath, normalizeRefPath } from './ref-path.js';

/**
 * 「找散着没登记的动作 / 表情文件」那次目录遍历的预算。
 *
 * 见文件头第 3 条边界。真实模型不会有这么深的目录，这两个数是「卡住就停」的闸门，
 * 不是对目录结构的假设。
 */
export const LOOSE_SCAN_MAX_DEPTH = 6;
export const LOOSE_SCAN_MAX_DIRS = 64;

/**
 * 认领数量的上限。
 *
 * 与 `capabilities.js` 的 `MAX_EXPRESSIONS`(256) / `MAX_MOTION_GROUPS`(64) 同向但更紧：
 * 能力清单那边超了是**截断显示**，这里超了是**不认领**。松紧不同是故意的 ——
 * 一份登记表里塞进 200 个来路不明的表情，比少认领几个糟糕得多。
 */
export const MAX_LOOSE_EXPRESSIONS = 128;
export const MAX_LOOSE_MOTIONS = 256;
export const MAX_LOOSE_MOTION_GROUPS = 32;

/**
 * 文件名推不出组名时用的兜底组名。
 *
 * 例：`01.motion3.json` 去掉后缀再剥掉结尾序号之后是空串。
 * 不叫 `Idle` 是**故意**的：自动待机会优先挑名字里含 `idle` 的组，
 * 而这个组是不是待机动作我们并不知道，冒充它会让她动不动就自己摆一下。
 */
export const FALLBACK_MOTION_GROUP = 'Motion';

/** 认领结果的空值。 */
export const EMPTY_LOOSE_MERGE = Object.freeze({
  addedExpressions: Object.freeze([]),
  addedMotions: Object.freeze([]),
  addedGroups: Object.freeze([]),
  skipped: 0,
  truncated: false,
  rejected: Object.freeze([]),
  changed: false,
});

/** 遍历时要跳过的目录名。 */
const SKIP_DIR_NAMES = new Set(['node_modules']);

/**
 * 走一遍模型目录，列出所有 `.motion3.json` / `.exp3.json`（相对模型目录，`/` 分隔）。
 *
 * 返回的是**磁盘上有什么**，不是**登记了什么** —— 去重是调用方的事
 * （体检器要拿它和登记表做差集，合并要拿登记表去重）。
 *
 * @param {string} root 模型库根目录（用来把绝对路径算回相对路径）
 * @param {string} dir 模型定义所在目录，相对 `root`
 * @param {(absolute: string) => void} [onDir] 每访问一个目录回调一次。
 *   体检器用它把目录记进 `touched`：**新增或删除文件改的是目录的 mtime**，
 *   不记的话「用户刚把动作登记进去」不会让缓存失效，界面会言之凿凿地说旧结论。
 * @returns {{ motions: string[], expressions: string[] }}
 */
export function collectLooseModelFiles(root, dir, onDir) {
  const base = resolve(root, dir);
  const motions = [];
  const expressions = [];
  let visitedDirs = 0;

  const walk = (current, depth) => {
    if (depth > LOOSE_SCAN_MAX_DEPTH || visitedDirs >= LOOSE_SCAN_MAX_DIRS) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // 无权限的子目录跳过，不该让整次体检 / 合并失败
    }
    visitedDirs += 1;
    if (typeof onDir === 'function') {
      try {
        onDir(current);
      } catch {
        // 回调是记账用的，它自己的失败不该影响扫描结果
      }
    }

    // 子目录里有另一个模型 —— 那是它的地盘，整棵子树都不算在当前模型头上（边界 1）
    // `depth > 0` 排除掉走查起点自己那个目录：模型定义文件就在那里。
    if (depth > 0 && entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.model3.json'))) {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(join(current, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const isMotion = lower.endsWith(MOTION_SUFFIX);
      const isExpression = lower.endsWith(EXPRESSION_SUFFIX);
      if (!isMotion && !isExpression) continue;
      const rel = relative(base, join(current, entry.name)).split(sep).join('/');
      if (!isSafeRefPath(rel, isMotion ? MOTION_SUFFIX : EXPRESSION_SUFFIX)) continue;
      if (isMotion) motions.push(rel);
      else expressions.push(rel);
    }
  };

  walk(base, 0);
  // 排序：目录遍历的顺序由文件系统决定，而它决定了「组里第几个动作」——
  // 不排的话同一台机器两次扫描可能给出不同的序号，播放动作变成抽奖。
  motions.sort();
  expressions.sort();
  return { motions, expressions };
}

/**
 * 从表情文件名推出表情名。
 *
 * `expressions/EyesCry.exp3.json` → `EyesCry`
 *
 * 用文件名而不是「表情 1 / 表情 2」：用户在 VTS 里认识的就是这个名字，
 * 而 `live2d_set_expression` 要按名字点，名字得是能记住的。
 *
 * @param {string} rel
 * @returns {string} 推不出时返回空串（调用方跳过这一项）
 */
export function expressionNameOf(rel) {
  const name = basename(String(rel)).replace(/\.exp3\.json$/i, '').trim();
  return name;
}

/**
 * 从动作文件名推出动作组名。
 *
 *   `animations/Idle_2.motion3.json`   → `Idle`     （剥掉结尾的序号）
 *   `animations/Love.motion3.json`     → `Love`
 *   `animations/hiyori_m01.motion3.json` → `hiyori_m`
 *   `01.motion3.json`                  → `Motion`   （兜底，见 FALLBACK_MOTION_GROUP）
 *
 * 剥序号的理由是实测出来的：`akari_vts` 的三个动作叫 `Idle_2` / `Love` / `Shock`，
 * 不剥的话「Idle」这个组名根本不存在，而自动待机是靠名字里含 `idle` 找组的
 * —— 她会从此不再有规律地做待机动作。剥了之后三个组名恰好都是有意义的。
 *
 * @param {string} rel
 * @returns {string}
 */
export function motionGroupOf(rel) {
  const stem = basename(String(rel)).replace(/\.motion3\.json$/i, '');
  // 结尾的序号：`Idle_2` / `hiyori_m01` / `m1` 都剥；分隔符可有可无
  let group = stem.replace(/[\s_-]*\d+$/, '');
  group = group.replace(/[\s_-]+$/, '').trim();
  return group === '' ? FALLBACK_MOTION_GROUP : group;
}

/**
 * 把「目录里有、但谁都没登记」的动作 / 表情加进一份 `model3.json` 的内存副本。
 *
 * 纯函数：不改 `setting`，不改 `loose`。
 *
 * 三条规矩（与 `mergeVtsIntoSetting()` 逐条对应，因为它们最后要合成同一份登记表）：
 *   1. 已经登记过的文件按归一化路径去重，一个都不重复加；
 *   2. 表情名已被占用时**跳过**（不是改名）—— 名字是 AI 与用户点表情的唯一入口，
 *      加一个重名的会让「点脸红出来葱」变成随机事件；
 *   3. 路径不安全 / 后缀不对的项跳过（`collectLooseModelFiles` 已经滤过一遍，
 *      这里是纵深：合成一份指向不存在文件的登记表，症状是「模型加载到一半失败」，
 *      比「少一个表情」难查得多）。
 *
 * @param {object} setting 原始 `model3.json`（已合并过 VTS 的那一份）
 * @param {{ motions?: string[], expressions?: string[] }} loose
 * @returns {{
 *   setting: object,
 *   addedExpressions: string[],
 *   addedMotions: string[],
 *   addedGroups: string[],
 *   skipped: number,
 *   truncated: boolean,
 *   rejected: Array<{ rel: string, why: string }>,
 *   changed: boolean,
 * }}
 */
export function mergeLooseIntoSetting(setting, loose) {
  if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) {
    return { setting, ...EMPTY_LOOSE_MERGE };
  }
  const refs = setting.FileReferences;
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) {
    // 连 `FileReferences` 都没有的模型，`inspectModel` 已经报了 `E_MODEL_JSON_INVALID`；
    // 在这里补一个段只会掩盖那条真正的错（与 VTS 合取同一条判断）
    return { setting, ...EMPTY_LOOSE_MERGE };
  }

  const looseExpressions = Array.isArray(loose?.expressions) ? loose.expressions : [];
  const looseMotions = Array.isArray(loose?.motions) ? loose.motions : [];
  if (looseExpressions.length === 0 && looseMotions.length === 0) {
    return { setting, ...EMPTY_LOOSE_MERGE };
  }

  const existingExpressions = Array.isArray(refs.Expressions) ? refs.Expressions : [];
  const existingMotions = refs.Motions !== null && typeof refs.Motions === 'object' && !Array.isArray(refs.Motions)
    ? refs.Motions
    : {};

  // 已经登记过的文件路径 + 已经用掉的**表情名**（两件事，别合成一个集合）
  const referenced = new Set();
  const usedNames = new Set();
  for (const exp of existingExpressions) {
    if (exp === null || typeof exp !== 'object') continue;
    if (typeof exp.File === 'string') referenced.add(normalizeRefPath(exp.File));
    if (typeof exp.Name === 'string') usedNames.add(exp.Name);
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

  let skipped = 0;
  let truncated = false;
  /**
   * 扫到了却没接上的那些，**带原因**。
   *
   * 为什么不只给一个计数：`skipped: 1` 对用户等于没说 —— 是路径不安全？名字撞了？
   * 还是条数超了？三种情况的下一步动作完全不同（改文件名 / 改名字 / 删掉一些）。
   * 而这条信息只在「有东西漏掉」时出现，那正是用户最需要知道「为什么少了这个」的一刻。
   */
  const rejected = [];

  const addedExpressions = [];
  const nextExpressions = existingExpressions.slice();
  for (const rel of looseExpressions) {
    if (addedExpressions.length >= MAX_LOOSE_EXPRESSIONS) {
      truncated = true;
      rejected.push({ rel, why: `一次最多认领 ${MAX_LOOSE_EXPRESSIONS} 个表情` });
      break;
    }
    if (!isSafeRefPath(rel, EXPRESSION_SUFFIX)) {
      skipped += 1;
      rejected.push({ rel, why: '这个路径不能交给客户端去取（绝对路径或含 ..）' });
      continue;
    }
    /*
     * ★ 「已经登记过」这一判**必须排在名字检查之前**。
     *
     * 顺序反了会有个很隐蔽的后果：VTS 那一半已经用一个名字（比如「脸红」）
     * 把 `脸红.exp3.json` 加进去了，紧接着散文件这一半又扫到同一个文件 ——
     * 它本该被认成「本来就有」而**静默**跳过，却会在名字检查那里被当成
     * 「重名」而报出去。用户在面板上看到的是「8 个表情没能自动接上」，
     * 而实际上那 8 个表情早就接上了、点得出来 —— 一条纯属虚构的告警，
     * 且恰好出现在功能最该让人放心的时候（miku 那 8 个表情实测如此，门禁 [3] 抓到的）。
     */
    const key = normalizeRefPath(rel);
    if (referenced.has(key)) continue; // 已登记 —— 不是「跳过」，是「本来就有」
    const name = expressionNameOf(rel);
    if (name === '' || usedNames.has(name)) {
      skipped += 1;
      rejected.push({
        rel,
        why: name === '' ? '文件名里取不出表情名' : `名字「${name}」与已有表情重复`,
      });
      continue;
    }
    referenced.add(key);
    usedNames.add(name);
    nextExpressions.push({ Name: name, File: rel });
    addedExpressions.push(rel);
  }

  const addedMotions = [];
  const addedGroups = [];
  const nextMotions = { ...existingMotions };
  let motionCount = 0;
  for (const rel of looseMotions) {
    if (motionCount >= MAX_LOOSE_MOTIONS) {
      truncated = true;
      rejected.push({ rel, why: `一次最多认领 ${MAX_LOOSE_MOTIONS} 个动作` });
      break;
    }
    if (!isSafeRefPath(rel, MOTION_SUFFIX)) {
      skipped += 1;
      rejected.push({ rel, why: '这个路径不能交给客户端去取（绝对路径或含 ..）' });
      continue;
    }
    const key = normalizeRefPath(rel);
    if (referenced.has(key)) continue;
    const group = motionGroupOf(rel);
    const isNewGroup = !Array.isArray(nextMotions[group]);
    if (isNewGroup && addedGroups.length >= MAX_LOOSE_MOTION_GROUPS) {
      truncated = true;
      // 这一组放不下，继续看后面的（同组的还有机会）
      rejected.push({ rel, why: `一次最多建 ${MAX_LOOSE_MOTION_GROUPS} 个动作组，这一组没放下` });
      continue;
    }
    referenced.add(key);
    const list = Array.isArray(nextMotions[group]) ? nextMotions[group].slice() : [];
    list.push({ File: rel });
    nextMotions[group] = list;
    addedMotions.push(rel);
    motionCount += 1;
    if (isNewGroup) addedGroups.push(group);
  }

  if (addedExpressions.length === 0 && addedMotions.length === 0) {
    return { setting, ...EMPTY_LOOSE_MERGE, skipped, truncated, rejected };
  }

  const nextRefs = { ...refs };
  if (addedExpressions.length > 0) nextRefs.Expressions = nextExpressions;
  if (addedMotions.length > 0) nextRefs.Motions = nextMotions;

  return {
    setting: { ...setting, FileReferences: nextRefs },
    addedExpressions,
    addedMotions,
    addedGroups,
    skipped,
    truncated,
    rejected,
    changed: true,
  };
}

/**
 * 把认领结果说成一句人话，用于 `problems[].message`。
 *
 * 与 `describeVtsMerge()` 分开写而不是共用一个：**来源不同，用户要做的事也不同**
 * （VTS 那份是「配置里有、别处不认」，这份是「目录里有、谁都没写」）。
 * 合成一句会让面板上那句「已自动读入」看不出它靠的是哪一半。
 *
 * @param {string[]} addedExpressions
 * @param {string[]} addedMotions
 * @returns {string}
 */
export function describeLooseMerge(addedExpressions, addedMotions) {
  const parts = [];
  if (addedExpressions.length > 0) parts.push(`${addedExpressions.length} 个表情`);
  if (addedMotions.length > 0) parts.push(`${addedMotions.length} 个动作`);
  if (parts.length === 0) return '';
  /*
   * 「来自目录里的文件名」这几个字是**必须**的，不是修辞：
   *
   * 名字与分组是从文件名猜的（`e1.exp3.json` → 表情「e1」），而 VTS 那一半的名字
   * 是用户在 VTS 里亲手起的。这两件事在面板上都显示成「已自动读入」，
   * 不写出处的话用户会以为插件会读心 —— 然后奇怪为什么表情叫「e1」。
   *
   * 句式与 `describeVtsMerge()` 对齐（`X 个表情来自……`），因为这两句经常
   * 一前一后出现在同一个模型的报告里，错开句式会读成两件不相干的事。
   */
  return `${parts.join('、')}来自目录里的文件名`;
}

/**
 * 把「扫到了却没接上」的那些压成一句 `detail`。
 *
 * 为什么每条都要带原因，而不是只说「3 个没接上」：三种原因对应三种完全不同的
 * 下一步（改文件名 / 改成不重名的 / 少放几个），而用户此刻只有这一行线索。
 *
 * 只举前 3 条：面板那一行只有一行宽，而「有几个」这个数字才是要传的信息，
 * 名字只是佐证 —— 但**每条的原因**要跟着名字一起给，否则佐证也白给。
 *
 * @param {Array<{ rel: string, why: string }>} rejected
 * @param {number} [limit]
 * @returns {string}
 */
export function describeLooseRejected(rejected, limit = 3) {
  const listed = rejected.slice(0, limit).map((item) => `${item.rel}（${item.why}）`).join('；');
  return rejected.length > limit ? `${listed} 等 ${rejected.length} 个` : listed;
}
