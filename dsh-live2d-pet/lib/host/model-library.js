/**
 * 模型库扫描与体检（Host 半区，纯 IO，不需要 WebGL）
 *
 * 存在的理由：`/models` 原先只返回 `{ id, path, name }` 三个字段，于是
 * **一个缺纹理的模型和一个健康的模型在下拉框里长得一模一样** —— 用户只能
 * 「点进去看看会不会炸」来发现坏包，而点进去的代价是当前模型已经被释放了（白屏）
 *
 * 所以这里做的事是：在用户点之前就把每个模型**体检**一遍，把「能不能加载」和
 * 「为什么不能加载」变成列表里的字段。错误码沿用方案文档 §4.4 的稳定枚举
 *
 * 三条设计约束
 *   1. **只读，绝不写入模型库**：体检失败不改文件、不生成副本
 *   2. **有预算上限**：这个函数可能被每次心跳触发，一个把 node_modules 卷进来的
 *      递归扫描会让界面卡住。深度、模型数、单文件读取量都有硬上限
 *   3. **失败必须是数据，不是异常**：单个模型坏掉不能让整次扫描失败 ——
 *      返回 `problems[]`，扫描本身永远成功
 *
 * @module dsh-live2d-pet/host/model-library
 */

import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  describeVtsMerge,
  mergeModelSetting,
} from './vts-profile.js';
import { describeLooseMerge, describeLooseRejected, collectLooseModelFiles } from './loose-files.js';

/**
 * 本仓库的 Cubism Core 支持的最高 moc3 格式版本
 *
 * 实测值来自 `node tools/gate-model.mjs`（Core 6.0.1 → 最高 moc3 = 6）
 * 这个数字**必须与 `vendor/cubism/` 里那份 Core 一致**，而手工同步的数字一定会
 * 漂移 —— 所以 `tools/test-model-library.mjs` 里有一条断言会把两边的值对起来
 * 让漂移在门禁里变红，而不是在用户加载模型时才暴露
 */
export const MAX_MOC3_VERSION = 6;

/** moc3 魔数，文件头前 4 字节 */
const MOC3_MAGIC = 'MOC3';

/**
 * `moc3.endianness` 在**线缆上**的取值
 *
 * 字段发的是字符串，不是 moc3 头里的那个裸字节 —— 字节是**实现细节**，
 * 线上契约不该暴露它。踩过的坑：这里原先发的是 `head[5]`（一个数字 `0`/`1`），
 * 而客户端 `ModelEntry` 声明的是 `endianness?: string`，`describeModel()`
 * 用 `=== 'big'` 比 —— `1 === 'big'` 恒假，于是那句专门为大端写的「大端」标签
 * **永远不会出现**。两边各自的类型都没错，TypeScript 也查不出来（跨边界走的是
 * JSON，编译期两边根本不见面），只有把真实产出喂给真实的客户端函数才会露馅
 * 这就是 `tools/test-wire-types.mjs` 存在的理由。
 *
 * 客户端**不能** import 这个常量（`model-library.js` 带着 `node:fs`/`node:path`，
 * 拖进浏览器 bundle 就完了），所以它在 `src/client/model-list.ts` 里有一份镜像，
 * 由那道门禁逐字对起来
 */
export const MOC3_ENDIANNESS = Object.freeze({
  LITTLE: 'little',
  BIG: 'big',
  /** 头读不到（文件太短 / 打不开）。宁可说「不知道」，也不猜一个。 */
  UNKNOWN: 'unknown',
});

/** 扫描默认预算。刻意保守，见文件头第 2 条。 */
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_MODELS = 200;

/** 体检时单个引用的读取上限：只读文件头够判断格式，不必把 25MB 纹理读进来。 */
const HEADER_BYTES = 64 * 1024;

/** 超过这个边长的纹理，在部分 GPU 上会拿不到 MAX_TEXTURE_SIZE。 */
const TEXTURE_WARN_SIDE = 8192;

/**
 * 单模型体检结果缓存，键是 `.model3.json` 的绝对路径
 *
 * **失效判定靠「指纹」：把体检中碰过的每一个文件（模型定义、moc3、每张纹理
 * 每个物理/表情/动作/音频）的 `mtime + size` 记下来，下次逐个 stat 比对。
 *
 * 为什么不省这点 stat：最初的实现图快，只比对「模型定义文件的 mtime」和
 * 「它所在目录的 mtime」，理由写的是「不做全量 stat 能让 200 个模型的扫描保持毫秒级」
 * 门禁当场证伪 —— **就地改一个文件不会改目录的 mtime**，于是「用户换了一张修好的纹理
 * 或者重新导出了一次模型」这种情况会永远读到旧结论，而且不报任何错
 * 这正是最难查的一类 bug：界面言之凿凿地说模型是坏的，而它早就修好了
 *
 * 代价实测可接受：stat 是微秒级的系统调用，一个模型通常引用十几个文件，
 * 真正贵的是**读文件内容**（7MB 的 moc3、5MB 的纹理），而那部分才是一分钱没省的
 */
const inspectionCache = new Map();
const CACHE_LIMIT = 512;

/** 缓存命中/未命中计数，给 `/status` 用 —— 这个缓存一旦失灵会直接变成界面卡顿。 */
const cacheStats = { hits: 0, misses: 0 };

export function libraryCacheStats() {
  return { ...cacheStats, entries: inspectionCache.size, limit: CACHE_LIMIT };
}

export function clearLibraryCache() {
  inspectionCache.clear();
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

/**
 * 扫描模型库并给每个模型体检
 *
 * @param {string} root 模型库根目录（绝对路径）
 * @param {{ force?: boolean, maxDepth?: number, maxModels?: number }} [options]
 *   `force` 为真时绕过缓存（`/models/refresh` 用）
 * @returns {{
 *   models: Array<object>, rootExists: boolean, truncated: boolean,
 *   scannedDirs: number, durationMs: number, cache: object
 * }}
 */
export function scanLibrary(root, options = {}) {
  const started = Date.now();
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxModels = options.maxModels ?? DEFAULT_MAX_MODELS;
  const force = options.force === true;

  const result = {
    models: [],
    rootExists: existsSync(root),
    truncated: false,
    scannedDirs: 0,
    durationMs: 0,
    cache: null,
  };
  if (!result.rootExists) {
    result.durationMs = Date.now() - started;
    result.cache = libraryCacheStats();
    return result;
  }

  /** @type {string[]} 相对路径（`/` 分隔），先收集再体检，让遍历与 IO 分开。 */
  const found = [];

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    if (found.length >= maxModels) {
      result.truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无权限的子目录跳过，不该让整次扫描失
    }
    result.scannedDirs += 1;
    for (const entry of entries) {
      if (found.length >= maxModels) {
        result.truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        // 隐藏目录与 node_modules 跳过：用户的模型库里不该有它们，
        // 而一旦有（比如把整个项目文件夹丢进来），扫进去的代价是灾难性的
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.model3.json')) continue;
      found.push(join(dir, entry.name).slice(root.length + 1).split(sep).join('/'));
    }
  };

  walk(root, 0);

  for (const rel of found) {
    // 逐个模型兜底：`inspectModel` 被写成永不抛异常，但 `statSync` 
    // EACCES / EBUSY 这类情况**仍会**抛（`throwIfNoEntry: false` 只对
    // 「文件不存在」生效）。一个权限异常不该让整张清单消失 —— 那正是
    // 「模型明明在里面却不在列表里」这类最难查的 bug
    try {
      result.models.push(inspectModel(root, rel, { force }));
    } catch (error) {
      result.models.push({
        id: rel,
        path: rel,
        name: rel.split('/').pop().replace(/\.model3\.json$/i, ''),
        dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
        ok: false,
        problems: [problem('E_MODEL_INSPECT_FAILED', '体检这个模型时出错了', String(error?.message ?? error))],
        moc3: null,
        textures: { count: 0, bytes: 0, largestSide: null },
        expressions: 0,
        motions: { groups: [], count: 0 },
        hasPhysics: false,
        hasPose: false,
        hasDisplayInfo: false,
        groups: 0,
        hitAreas: 0,
        bytes: 0,
        mtimeMs: 0,
      });
    }
  }

  // 按展示名排序，而不是按路径：用户在下拉框里看到的是名字
  // 按路径排会出现「同一个模型的两个变体被别的模型隔开」这种反直觉结果
  result.models.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  result.durationMs = Date.now() - started;
  result.cache = libraryCacheStats();
  return result;
}

/**
 * 给一个模型做体检
 *
 * **永远返回一个对象**，不抛异常：坏包的全部信息都在 `problems[]` 里
 * 这一点是刻意的 —— 调用方（`/models`）要的是一张「哪些模型不能用」的清单
 * 而不是第一个坏包就把整张清单毁掉
 *
 * @param {string} root 模型库根目录（绝对路径）
 * @param {string} relPath `.model3.json` 相对模型库根目录的路径（`/` 分隔
 * @param {{ force?: boolean }} [options]
 */
export function inspectModel(root, relPath, options = {}) {
  const absolute = resolve(root, relPath);
  const fallbackName = relPath.split('/').pop().replace(/\.model3\.json$/i, '');
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';

  /** 兜底条目：任何一步出意外都退回它，保证返回值形状恒定。 */
  const base = {
    id: relPath,
    path: relPath,
    name: fallbackName,
    dir,
    ok: false,
    problems: [],
    moc3: null,
    textures: { count: 0, bytes: 0, largestSide: null },
    expressions: 0,
    motions: { groups: [], count: 0 },
    hasPhysics: false,
    hasPose: false,
    hasDisplayInfo: false,
    groups: 0,
    hitAreas: 0,
    bytes: 0,
    mtimeMs: 0,
    // 只有真的从 `*.vtube.json` 合并到东西时才会被填上（见第 8 步）
    // 先在这里声明成 `null`，是为了**每一个** entry 都有这个键 ——
    // 时有时无的字段会让下游的 `entry.vtsProfile?.x` 看起来像在防一
    // 不会发生的空值，于是真出问题时没人知道该不该信它
    vtsProfile: null,
    // 同上，但记的是「目录里散着、被自动认领」的那些（也见第 8 步）
    looseFiles: null,
  };

  let jsonStat;
  try {
    jsonStat = statSync(absolute, { throwIfNoEntry: false });
  } catch {
    jsonStat = undefined;
  }
  if (!jsonStat) {
    return withProblem(base, 'E_MODEL_FILE_MISSING', '模型定义文件不存在', relPath);
  }

  /**
   * 本次体检碰过的所有文件，用来给缓存做指纹。见 `inspectionCache` 的注释
   * 模型定义文件自己先记上，这样「JSON 被改好了」能立刻让缓存失效
   */
  const touched = [{ abs: absolute, mtimeMs: jsonStat.mtimeMs, size: jsonStat.size }];

  /*
   * ★ 散文件的走查必须排在**查缓存之前**。
   *
   * 自动认领（第 1b 步）会把目录里散着的 `.motion3.json` / `.exp3.json` 并进
   * 合成结果，于是它们**也成了这次体检的输入** —— 而缓存的指纹只认 `touched`
   * 里记过的文件。走查要是留在缓存后面，用户刚补进一个动作文件时会直接命中
   * 旧缓存，认领数停在 2 不动（门禁 [5b] ③ 抓到过一次，症状就是
   * 「界面言之凿凿地说旧结论」）。
   *
   * 记两样东西，缺一不可：
   *   · **每个访问过的目录**的 mtime —— 新增 / 删除文件改的是它；
   *   · **每个散文件自己**的 mtime + size —— 改内容不改目录 mtime。
   */
  let loose = { motions: [], expressions: [] };
  try {
    loose = collectLooseModelFiles(root, dir, (abs) => statTracked(abs, touched));
    for (const rel of loose.motions) statTracked(resolve(root, dir, rel), touched);
    for (const rel of loose.expressions) statTracked(resolve(root, dir, rel), touched);
  } catch {
    // 走查出错就当没有散文件：第 1b 步那一侧还有一层兜底，体检不该因此失败
    loose = { motions: [], expressions: [] };
  }

  const cacheKey = absolute;
  if (options.force !== true) {
    const cached = inspectionCache.get(cacheKey);
    if (cached && fingerprintMatches(cached.files)) {
      cacheStats.hits += 1;
      // 重新插入以维持 LRU 顺序（Map 保持插入序，命中时 delete+set 即「最近使用」）
      inspectionCache.delete(cacheKey);
      inspectionCache.set(cacheKey, cached);
      return cached.entry;
    }
  }
  cacheStats.misses += 1;

  const entry = { ...base, problems: [], mtimeMs: jsonStat.mtimeMs };

  // ── 1. 模型定义本身 ────────────────────────────────────────────────
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    return remember(cacheKey, touched, withProblem(
      entry, 'E_MODEL_READ_FAILED', '模型定义文件读不出来', String(error?.message ?? error),
    ));
  }

  let json;
  try {
    json = JSON.parse(stripBom(text));
  } catch (error) {
    // 把 JSON.parse 的原始报错带上：它带字符偏移，是定位「少了逗号还是多了逗号」的
    // 的唯一线索，重新包装成「解析失败」会把这条线索丢掉
    return remember(cacheKey, touched, withProblem(
      entry, 'E_MODEL_JSON_INVALID', '模型定义不是合法 JSON', String(error?.message ?? error),
    ));
  }
  if (!isPlainObject(json)) {
    return remember(cacheKey, touched, withProblem(
      entry, 'E_MODEL_JSON_INVALID', '模型定义顶层不是对象', typeof json,
    ));
  }

  if (!isPlainObject(json.FileReferences)) {
    return remember(cacheKey, touched, withProblem(
      entry, 'E_MODEL_JSON_INVALID', '缺少 FileReferences 段', 'model3.json 必须有 FileReferences',
    ));
  }

  // ── 1b. 合成：VTS 登记表 + 目录里散着没登记的文件（内存里，不写盘）────
  //
  // 两件事合并成**一次**调用（`mergeModelSetting`），而且与 `/model/<rel>` 那条
  // 路由用的是**同一个函数** —— 这是硬约束，不是风格问题：
  //
  //   · 大量从模型站下载的包是**给 VTS 做的**：`model3.json` 里既没有 `Motions`
  //     也没有 `Expressions`，登记表在同目录的 `*.vtube.json` 里；
  //   · 还有一批包连 VTS 登记表都没有，动作 / 表情就那么散在 `motions/`、
  //     `expressions/` 目录里，`model3.json` 一个字没提。
  //
  // 体检器与路由各合一次，就会出现「列表说有 8 个表情、实际一个都点不出来」
  // —— 所以这里调 `mergeModelSetting()`，不自己拼
  //
  // `loose` 是上面为了算缓存指纹已经走过一遍的结果，直接传进来复用 ——
  // 再走一遍不只是白费，两次遍历之间目录还可能变，于是出现
  // 「指纹按 A 算、结果按 B 报」。合并在内存里，绝不写盘。
  const merged = mergeModelSetting(json, absolute, { root, dir, loose });
  if (merged.changed) json = merged.setting;
  const refs = json.FileReferences;

  // ── 2. moc3：存在性 + 格式版本 ─────────────────────────────────────
  const mocRel = typeof refs.Moc === 'string' ? refs.Moc : '';
  if (mocRel === '') {
    entry.problems.push(problem('E_MODEL_JSON_INVALID', 'FileReferences 里没有 Moc', '这是模型的必填项'));
  } else {
    const mocAbs = safeJoin(root, dir, mocRel);
    if (mocAbs === null) {
      entry.problems.push(problem('E_MODEL_PATH_ESCAPE', 'Moc 路径越出模型库', mocRel));
    } else {
      const mocStat = statTracked(mocAbs, touched);
      if (mocStat === null) {
        entry.problems.push(problem('E_MODEL_FILE_MISSING', '缺少 moc3 文件', mocRel));
      } else {
        const info = readMoc3Header(mocAbs, mocStat.size);
        // 端序在**边界上**就翻成契约字符串，裸字节不外发（理由见 MOC3_ENDIANNESS）
        // 下面几段判定读的仍是 `info.endianness` 这个原始字节，所以不受影响
        entry.moc3 = { file: mocRel, ...info, endianness: endiannessName(info.endianness) };
        if (info.magic !== MOC3_MAGIC) {
          entry.problems.push(problem(
            'E_MOC3_INVALID',
            'moc3 文件头不是 MOC3 魔数',
            `实际读到 ${JSON.stringify(info.magic)}`,
          ));
        } else if (info.version !== null && info.version > MAX_MOC3_VERSION) {
          // 这条必须在渲染之前拦下：Core 解析高版本 moc3 会直接抛，
          // 而那时渲染进程已经释放了上一个模型 —— 就是「切一下就白屏」
          entry.problems.push(problem(
            'E_MOC3_VERSION_UNSUPPORTED',
            `moc3 格式版本 v${info.version} 高于本 Core 支持的上限 v${MAX_MOC3_VERSION}`,
            '需要升级 vendor/cubism 里的 Cubism Core',
          ));
        } else if (info.endianness !== 0) {
          // 不断言 Core 不支持它 —— 只是我们没有验证过，所以不敢说「没问题」
          // 用 warn 而不是 error：把没验证过的事说成错误，会让用户去修一个可能不存在的问题
          entry.problems.push(problem(
            'E_MOC3_INVALID',
            `moc3 声明端序字节为 ${info.endianness}（非小端）`,
            '本仓库只在小端样本上验证过，加载行为未确认',
            'warn',
          ));
        }
      }
    }
  }

  // ── 3. 纹理 ───────────────────────────────────────────────────────
  const textures = Array.isArray(refs.Textures) ? refs.Textures : [];
  entry.textures.count = textures.length;
  if (textures.length === 0) {
    entry.problems.push(problem('E_MODEL_JSON_INVALID', 'FileReferences.Textures 是空的', '模型至少要有一张纹理'));
  }
  for (const tex of textures) {
    if (typeof tex !== 'string' || tex === '') continue;
    const texAbs = safeJoin(root, dir, tex);
    if (texAbs === null) {
      entry.problems.push(problem('E_MODEL_PATH_ESCAPE', '纹理路径越出模型库', tex));
      continue;
    }
    const st = statTracked(texAbs, touched);
    if (st === null) {
      entry.problems.push(problem('E_MODEL_FILE_MISSING', '缺少纹理', tex));
      continue;
    }
    entry.textures.bytes += st.size;
    // 只给最大的那张读尺寸：目的是回答「这张纹理会不会撞上 GPU 上限」，
    // 而不是把每张图都解析一遍
    const side = imageLongSide(texAbs);
    if (side !== null && (entry.textures.largestSide === null || side > entry.textures.largestSide)) {
      entry.textures.largestSide = side;
      if (side > TEXTURE_WARN_SIDE) {
        entry.problems.push(problem(
          'E_TEXTURE_TOO_LARGE',
          `纹理边长 ${side} 超过 ${TEXTURE_WARN_SIDE}`,
          `${tex} —— 渲染端会降到 2048 再用，但原图过大会明显拖慢首次加载`,
          'warn',
        ));
      }
    }
  }

  // ── 4. 可选引用 ───────────────────────────────────────────────────
  for (const [key, flag] of [['Physics', 'hasPhysics'], ['Pose', 'hasPose'], ['DisplayInfo', 'hasDisplayInfo']]) {
    const value = refs[key];
    if (typeof value !== 'string' || value === '') continue;
    entry[flag] = true;
    checkRef(root, dir, value, key, entry, touched);
  }
  if (typeof refs.UserData === 'string' && refs.UserData !== '') {
    checkRef(root, dir, refs.UserData, 'UserData', entry, touched);
  }

  // ── 5. 表情 ───────────────────────────────────────────────────────
  const expressions = Array.isArray(refs.Expressions) ? refs.Expressions : [];
  entry.expressions = expressions.length;
  for (const exp of expressions) {
    if (!isPlainObject(exp) || typeof exp.File !== 'string' || exp.File === '') continue;
    checkRef(root, dir, exp.File, `表情 ${exp.Name ?? exp.File}`, entry, touched);
  }

  // ── 6. 动作（含音频）─────────────────────────────────────────────
  const motions = isPlainObject(refs.Motions) ? refs.Motions : {};
  const groups = Object.keys(motions).filter((key) => Array.isArray(motions[key]));
  entry.motions.groups = groups;
  for (const group of groups) {
    for (const motion of motions[group]) {
      if (!isPlainObject(motion)) continue;
      if (typeof motion.File === 'string' && motion.File !== '') {
        entry.motions.count += 1;
        checkRef(root, dir, motion.File, `动作 ${group}`, entry, touched);
      }
      if (typeof motion.Sound === 'string' && motion.Sound !== '') {
        // 音频缺失单独给一个码：它只影响这一个动作的观感
        // 不至于让整个模型不可用 —— 严重级别是 warn
        checkRef(root, dir, motion.Sound, `动作 ${group} 的音频`, entry, touched, 'E_MOTION_AUDIO_MISSING', 'warn');
      }
    }
  }

  // ── 7. 汇总 ──────────────────────────────────────────────────────
  entry.groups = Array.isArray(json.Groups) ? json.Groups.length : 0;
  entry.hitAreas = Array.isArray(json.HitAreas) ? json.HitAreas.length : 0;
  entry.bytes = jsonStat.size + entry.textures.bytes + (entry.moc3?.bytes ?? 0);
  entry.ok = !entry.problems.some((p) => p.level === 'error');

  // ── 8. 把「散着但没登记的动作 / 表情」这件事说出来 ────────────────────
  //
  // ★ 第 1b 步已经把它们**接进合成结果**了 —— 那才是「导入模型之后表情和动作
  // 自动就位」的实现。所以走到这里 `entry.motions` / `entry.expressions`
  // 已经把它们算进去了（下面第 5、6 步读的就是合并后那份 `refs`）。
  //
  // 因此这一步**不再扫一遍目录**：一是白扫（结果一样），二是两次遍历会漂移 ——
  // 而「体检说 8 个、实际 3 个」正是这一整轮要根除的病。它只负责把已经发生的事
  // 讲清楚：认领了几个、哪几个没认领上、为什么。
  //
  // 只在模型本身没毛病时才提：一个连 moc3 都找不到的包已经够多问题了，
  // 再告诉用户「我还顺手接了 10 个动作」只是往噪音上再加一条（而那些动作
  // 在模型打不开的前提下根本没机会被用到）。
  if (entry.ok) {
    if (merged.looseChanged) {
      entry.looseFiles = {
        addedExpressions: merged.looseExpressions,
        addedMotions: merged.looseMotions,
        addedGroups: merged.looseGroups,
      };
      entry.problems.push(problem(
        'E_LOOSE_FILES_MERGED',
        `${describeLooseMerge(merged.looseExpressions, merged.looseMotions)}（model3.json 里没有登记）`,
        '已自动接上，可以正常使用；换成别的播放器就看不到了。'
          + '想让它们通用，把这几项抄进 model3.json 的 FileReferences 里',
        'warn',
      ));
    }

    /*
     * 扫到了却没接上的那些 —— 这条路**只在真有东西漏掉时**才出现。
     *
     * 它是「为什么我明明放了这个表情、插件里却没有」的**唯一**线索：
     * 合并是静默的，一个被跳过的文件不会有任何别的症状。
     * 所以 detail 里必须给出具体文件名**和**各自的原因 ——
     * 只报「3 个没接上」等于没说（是路径不安全？名字撞了？还是超了条数上限？
     * 三种情况用户要做的事完全不同）。
     */
    const rejected = merged.looseRejected;
    if (rejected.length > 0) {
      entry.problems.push(problem(
        'E_LOOSE_FILES_REJECTED',
        `目录里有 ${rejected.length} 个动作 / 表情文件没能自动接上`,
        describeLooseRejected(rejected),
        'warn',
      ));
    }

    /*
     * ★ 判据是 `vtsChanged` 而**不是** `merged.changed`。
     *
     * `merged.changed` 现在是「VTS 或散文件，任意一半接上了」—— 用它当判据，
     * 一个只有散文件被认领的模型会走进来报「接上了 0 个表情、0 个动作」
     * （因为 `addedExpressions` / `addedMotions` 只记 VTS 那一半）。
     * 这正是「两个不同的东西共用一个名字」的老病，所以两个标志位各记各的。
     */
    if (merged.vtsChanged) {
      /*
       * 合并成功时也要说一声，但**说的是另一件事**：这些能力现在能用，
       * 只是「能用」靠的是我们多读了一份 VTS 配置，换成别的播放器就没了
       *
       * 为什么值得占一行：用户装完模型第一件事往往是「怎么没有表情」，
       * 而这一行正好回答它 —— 而且顺带告诉他，想让它们在别处也能用该做什么
       * 级别仍是 `warn`（面板上显示成 `!`）而不是 `error`：模型完全可用
       *
       * `vtsProfile` 只带**摘要**，不要把 `merged.setting` 也挂上去
       * 那是整份合并后的 `model3.json`（真模型有 1–2KB），而 `/models` 每次
       * 扫描都会把它发给客户端 —— 客户端一个字段都用不到。路径按 `/` 归一，
       * 与 `entry.dir` / `entry.path` 的约定保持一致（`relative()` 在 Windows
       * 上给的是 `\`）
       *
       * 字段数被门禁钉死成 3 个（`tools/test-model-library.mjs`），
       * 因为「每次扫描都要发的东西」漏一个字段出去就是所有模型一起变胖
       */
      entry.vtsProfile = {
        path: relative(root, merged.vtsPath).replace(/\\/g, '/'),
        addedExpressions: merged.addedExpressions,
        addedMotions: merged.addedMotions,
      };
      entry.problems.push(problem(
        'E_VTS_PROFILE_USED',
        `${describeVtsMerge(merged.addedExpressions, merged.addedMotions)}（model3.json 里没有登记）`,
        '已自动读入，可以正常使用；换成别的播放器就看不到了。'
          + '想让它们通用，把这几项抄进 model3.json 的 FileReferences 里',
        'warn',
      ));
    }
    /*
     * 但这一条**不是** `else if` —— 「接上了 2 项」与「还有 2 项没接上」是两件
     * 独立的事实，同一次体检里可以同时成立，用户两件都需要知道
     * 写成 `else if` 的样子是我第一版的错，门禁 [5c] 当场抓住了：
     * 那个夹具里 1 个表情接上了、2 个表情和 1 个动作没接上，
     * 结果报告只说了「接上 1 个」，另外两项去向不明
     */
    if (merged.vtsFound && merged.vtsSkipped > 0) {
      // 配置里有东西，但一项都没接上（全是不支持的 Action 或文件不存在）
      entry.problems.push(problem(
        'E_VTS_PROFILE_UNUSED',
        `VTS 配置里有 ${merged.vtsSkipped} 项没有接上`,
        `${relative(root, merged.vtsPath)} —— 多半是「切换道具 / 播动画」这类本插件没有的能力，`
          + '或是配置里写的文件已经不在目录里了',
        'warn',
      ));
    }
  }

  return remember(cacheKey, touched, entry);
}

/**
 * stat 一个被引用的文件，成功时把它的指纹记进 `touched`
 *
 * 所有「判断某个引用文件在不在」的地方都必须走这里，而不是直接 `existsSync`
 * 漏记一个文件，那个文件的改动就永远不会让缓存失效，
 * 而症状是「模型明明修好了，界面还一直说它是坏的」
 *
 * @returns {import('node:fs').Stats|null}
 */
function statTracked(absolute, touched) {
  const st = statSync(absolute, { throwIfNoEntry: false });
  if (st) touched.push({ abs: absolute, mtimeMs: st.mtimeMs, size: st.size });
  return st ?? null;
}

/**
 * 指纹是否全部未变
 *
 * 任何一项「文件不见了」或「mtime/size 变了」都算失效 —— **宁可多体检一次，
 * 也不要把旧结论当成新结论**。反过来（该失效却没失效）是静默错误
 * 多体检一次只是多花几毫秒
 */
function fingerprintMatches(files) {
  for (const file of files) {
    const st = statSync(file.abs, { throwIfNoEntry: false });
    if (!st) return false;
    if (st.mtimeMs !== file.mtimeMs || st.size !== file.size) return false;
  }
  return true;
}

/** 给条目补一条问题并返回它（用于「立刻返回」的分支，保持链式写法）。 */
function withProblem(entry, code, message, detail, level = 'error') {
  entry.problems.push(problem(code, message, detail, level));
  entry.ok = false;
  return entry;
}

function problem(code, message, detail, level = 'error') {
  return { code, message, detail: detail ?? '', level };
}

/**
 * 检查一个被引用的文件是否存在，不存在就往 `problems` 里加一条
 *
 * 刻意**不检查存在文件的格式/尺寸**：那是体检，这是存在性
 * 把两者混在一起会让「缺文件」和「文件坏了」在报告里长得一样
 */
function checkRef(root, dir, rel, label, entry, touched, code = 'E_MODEL_FILE_MISSING', level = 'error') {
  const abs = safeJoin(root, dir, rel);
  if (abs === null) {
    entry.problems.push(problem('E_MODEL_PATH_ESCAPE', `${label} 的路径越出模型库`, rel));
    return;
  }
  if (statTracked(abs, touched) === null) {
    entry.problems.push(problem(code, `缺少${label}引用的文件`, rel, level));
  }
}

/**
 * 把模型内引用的相对路径拼成绝对路径，**并强制它仍在模型库之内**
 *
 * 这不是洁癖：`.model3.json` 是用户从网上下载的文件，里面
 * `"Moc": "../../../../Windows/System32/config/SAM"` 是完全合法的 JSON
 * 体检只做存在性判断、不读内容，但「这个路径存在吗」本身就已经是一
 * 文件系统探测原语，足以让人远程判断任意路径的存在性。所以在这里掐掉
 *
 * @returns {string|null} 越界时返回 null
 */
function safeJoin(root, dir, rel) {
  const target = resolve(root, dir, rel);
  const normalizedRoot = resolve(root);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) return null;
  return target;
}

/**
 * 「找出模型目录里散着但没有被 model3.json 登记的动作 / 表情文件」**搬去了**
 * `loose-files.js`（`collectLooseModelFiles`）。
 *
 * 搬家的理由不是它变了，而是**它的结果现在要被用来改数据**：以前它只喂给一条
 * `warn` 级的「这文件没人引用」告警，现在它喂给合成逻辑，于是 `/model/<rel>`
 * 那条路由也要用 —— 而路由在 `lib/index.js`，不该反向依赖体检器。
 *
 * 这个文件仍然 import 它，因为体检报告要能说出「哪些能力是猜出来的」。
 */
/**
 * 只读文件开头的 N 个字节
 *
 * **不要用 `readFileSync` 加 `subarray`** —— 那是先把整个文件读进内存再扔掉 99%
 * 模型库里有 7MB 的 moc3 和 25MB 的纹理，而这里每次都只为了 8 到 24 个字节
 * 用 `open` + `read` 让内核只搬需要的那点数据
 *
 * @returns {Buffer|null} 读不到（不存在 / 没权限）时返回 null
 */
function readHead(absolute, bytes) {
  let fd;
  try {
    fd = openSync(absolute, 'r');
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return read === bytes ? buf : buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 关不掉就算了，不该因为收尾失败影响体检结果 */
      }
    }
  }
}

/**
 * 读 moc3 文件头
 *
 * 格式（实测确认，三个官方样本字节 4–7 分别是 `[5,0,0,0]` / `[1,0,0,0]` / `[6,0,0,0]`）：
 *   0x00–0x03  `"MOC3"` 魔数
 *   0x04       **1 字节**版本
 *   0x05       **1 字节**端序：0 = 小端
 *   0x06–0x07  保留
 *
 * 版本号一定要**单字节**读。仓库里原先有处代码写的是 `readUInt32LE(4)`，
 * 它只是碰巧对：后面三个字节恰好是 0，于是按 32 位整数读出来正好等于版本号。
 * 一旦有模型声明大端序（字节 5 是 0），那个读法会报出一个荒谬的版本
 *
 * 只读前 8 个字节 —— 一个 moc3 可以有 7MB，为了 5 个字节把它整个读进来是不必要的
 */
function readMoc3Header(absolute, size) {
  const out = { magic: null, version: null, endianness: null, bytes: size ?? 0 };
  const head = readHead(absolute, 8);
  if (head === null || head.length < 6) return out;
  out.magic = head.subarray(0, 4).toString('latin1');
  out.version = head[4];
  out.endianness = head[5];
  return out;
}

/**
 * 把端序的**原始字节**翻成线缆上的字符串（见 `MOC3_ENDIANNESS`）
 *
 * 头读不到时 `readMoc3Header` 给的是 `null` → `'unknown'`
 * 非 0 的有限数一律算大端：这个字段的定义就是「0 = 小端，其余 = 非小端」，
 * 而上游已经在 `info.endianness !== 0` 那条 warn 里把原始字节报给了用户，
 * 所以这里不需要再区分「1」和「2」
 */
function endiannessName(byte) {
  if (byte === 0) return MOC3_ENDIANNESS.LITTLE;
  if (typeof byte === 'number' && Number.isFinite(byte)) return MOC3_ENDIANNESS.BIG;
  return MOC3_ENDIANNESS.UNKNOWN;
}

/**
 * 从图片文件头读出长边
 *
 * 只支持 PNG 和 JPEG，这两种 Live2D 模型里实际会用到的。WebP 等返回 `null` ——
 * **宁可返回「不知道」，也不要返回一个猜的数字**：这个值会出现在用户面前，
 * 一个错的尺寸比没有尺寸更糟
 */
function imageLongSide(absolute) {
  // 24 字节足够 PNG（IHDR 在偏移 16/20）；JPEG 要逐段跳，给 64KB 留余量
  const head = readHead(absolute, HEADER_BYTES);
  if (head === null) return null;

  // PNG：8 字节签名 + 4 字节块长度 + 'IHDR' + 宽(4) + 高(4)
  if (
    head.length >= 24
    && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  ) {
    return Math.max(head.readUInt32BE(16), head.readUInt32BE(20));
  }

  // JPEG：逐段跳到 SOFn，段长在偏移 2 处（大端，含自身 2 字节
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = head[offset + 1];
      // SOF0–SOF3 / SOF5–SOF7 / SOF9–SOF11 / SOF13–SOF15 才带尺寸
      // 0xC4(DHT) / 0xC8(JPG) / 0xCC(DAC) 落在这个区间里但不是 SOF，要排除
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return Math.max(head.readUInt16BE(offset + 7), head.readUInt16BE(offset + 5));
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      offset += 2 + head.readUInt16BE(offset + 2);
    }
  }

  return null;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 写入体检缓存，并维持 LRU 上限。 */
function remember(cacheKey, touched, entry) {
  inspectionCache.delete(cacheKey);
  inspectionCache.set(cacheKey, { files: touched, entry });
  while (inspectionCache.size > CACHE_LIMIT) {
    const oldest = inspectionCache.keys().next().value;
    if (oldest === undefined) break;
    inspectionCache.delete(oldest);
  }
  return entry;
}

/** 相对路径工具：给体检报告用的简短显示（诊断面板会用到）。 */
export function relativeToRoot(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

/** 给 `/status` 显示用：把体检结果压成一行摘要。 */
export function summarizeLibrary(scan) {
  const ok = scan.models.filter((m) => m.ok).length;
  return {
    total: scan.models.length,
    ok,
    broken: scan.models.length - ok,
    truncated: scan.truncated,
    durationMs: scan.durationMs,
    scannedDirs: scan.scannedDirs,
  };
}
