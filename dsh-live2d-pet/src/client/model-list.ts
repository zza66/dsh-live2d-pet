/**
 * 模型库清单的**纯逻辑**：把 Host 的 `/models` 返回翻译成界面要用的字符串与决策。
 *
 * 为什么单独一个文件、而不是留在 `plugin.ts` 里：
 * `simulate-client-boot.mjs` 用的是桩 React（`useState` 返回固定值、setter 是空
 * 函数、effect 从不执行），所以它能验证「渲染不抛」，但**永远走不到下拉框那一步**——
 * 状态不会变，`models` 始终是 `null`。也就是说「坏包会被标出来」「切到坏包会被拦」
 * 这两条在原来那种门禁下是**不可证伪**的，而它们恰好是这次改动的全部意义。
 *
 * 所以把决策逻辑挤成纯函数、单独打包成 `lib/test/model-list.mjs`，就能用真的断言
 * 覆盖它 —— 和 `src/client/speech.ts` → `lib/test/speech-player.mjs` 走同一条路。
 * 约束：这个文件**不许碰 DOM、不许碰 React、不许发请求**，否则上面那句话就不成立了。
 */

/**
 * 体检问题（Host 的 `lib/host/model-library.js` 产出）。
 *
 * `level` 决定它有多严重：`error` 意味着**这个模型加载不起来**（缺纹理、
 * moc3 版本超出 Core 支持范围……），`warn` 意味着能用但不完整
 * （缺一个动作的配音、纹理边长大到可能撑爆显存）。界面必须把两者分开 ——
 * 把 warn 也标成红色会训练用户忽略红色。
 */
export interface ModelProblem {
  code: string;
  message: string;
  detail?: string | null;
  level: 'error' | 'warn';
}

/**
 * `moc3.endianness` 在线缆上的取值。
 *
 * 这是 Host 那份 `MOC3_ENDIANNESS`（`lib/host/model-library.js`）的**镜像**：
 * 那个文件带着 `node:fs`/`node:path`，客户端 import 它会把 Node 内置模块拖进
 * 浏览器 bundle，所以共享代码这条路是堵死的，只能靠 `tools/test-wire-types.mjs`
 * 逐字对齐两份定义。
 *
 * 为什么会需要这条注释：这里原先声明的是 `endianness?: string`，而 Host 发的是
 * moc3 头里的**裸字节**（`1`），`describeModel()` 拿 `=== 'big'` 比 —— 恒假，
 * 「大端」标签永远不显示。两边各自的类型都没错，TypeScript 也查不出来。
 */
export const MOC3_ENDIANNESS = Object.freeze({
  LITTLE: 'little',
  BIG: 'big',
  /** 头读不到。宁可说「不知道」，也不猜一个。 */
  UNKNOWN: 'unknown',
});

/** 端序字段的取值类型。 */
export type Moc3Endianness = (typeof MOC3_ENDIANNESS)[keyof typeof MOC3_ENDIANNESS];

/**
 * 模型库里的一个条目（`/models` 的返回项）。
 *
 * 早期版本只有 `id`/`path`/`name` 三个字段，于是「缺一张纹理的模型」和健康
 * 模型在下拉框里长得一模一样，用户只能靠「点进去看会不会炸」来发现坏包 ——
 * 而点进去的代价是当前模型已经被释放了、桌宠消失。所以下面这些体检字段
 * 是**界面的一部分**，不是调试信息：坏包必须在点之前就显示出来。
 *
 * 全部体检字段都是可选的：Host 半区可能还是旧版本（它的改动要重启 DSH 才生效），
 * 那时 `/models` 只会给出三个字段。缺失一律按「不知道」处理，**不按「坏」处理** ——
 * 把「不知道」当成「坏」会让升级过程中的每一次都变成误报。
 *
 * 下面每个字段的名字与类型都由 `tools/test-wire-types.mjs` 拿**真实的 Host 产出**
 * 逐个核对：那道门禁跑的是真的 `inspectModel()`，不是这份声明自己的复述。
 */
export interface ModelEntry {
  id: string;
  /** 相对 modelsRoot 的路径，形如 `空_vts/空 - 免费版.model3.json`。 */
  path: string;
  name: string;
  /** 有没有 error 级问题。warn 不影响它。 */
  ok?: boolean;
  problems?: ModelProblem[];
  moc3?: { version: number; endianness?: Moc3Endianness } | null;
  textures?: { count: number; bytes: number; largestSide: number | null };
  motions?: { groups: string[]; count: number };
  expressions?: number;
  bytes?: number;
  /**
   * `.model3.json` 的修改时间。
   *
   * 缩略图缓存用它做指纹（见 `thumbnail.ts`）：换了模型文件，旧缩略图必须失效。
   * 单靠 `bytes` 不够 —— 换一个大小恰好相同的模型是可能的，而那时候用户看到的
   * 会是一张**别的模型的图**，比没有图更糟。
   */
  mtimeMs?: number;
}

/** 模型库摘要（Host 的 `summarizeLibrary`）。 */
export interface LibrarySummary {
  total: number;
  ok: number;
  broken: number;
  truncated?: boolean;
  durationMs?: number;
  scannedDirs?: number;
}

/** `/models` 的完整返回。 */
export interface ModelListResult {
  models: ModelEntry[];
  summary: LibrarySummary | null;
}

/**
 * 这个模型能不能加载。
 *
 * 判定只看 `ok === false` 这一条。**没有体检信息的模型（旧 Host）算能加载** ——
 * 理由见 `ModelEntry` 的注释：把「不知道」当「坏」会让每次升级都误报，
 * 而误报的代价是用户开始忽略这个标记本身。
 */
export function isLoadable(model: ModelEntry): boolean {
  return model.ok !== false;
}

/** 这个模型有没有 error 级问题（用于给下拉框加 `✕`）。 */
export function hasError(model: ModelEntry): boolean {
  return (model.problems ?? []).some((p) => p.level === 'error');
}

/** 这个模型有没有 warn 级问题（能用，但不完整）。 */
export function hasWarning(model: ModelEntry): boolean {
  return (model.problems ?? []).some((p) => p.level === 'warn');
}

/** 把字节数写成人能读的形式（93MB 比 97517568 有用得多）。 */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 一个模型的简介，用在详情行里（不含 problems —— 那些单独成行）。
 *
 * 没有任何体检信息时返回空串而不是「未知」：这一行是补充信息，
 * 与其写一行「未知 · 未知」，不如整行不显示。
 */
export function describeModel(model: ModelEntry | null): string {
  if (model === null) return '';
  const bits: string[] = [];
  if (typeof model.moc3?.version === 'number') bits.push(`moc3 v${model.moc3.version}`);
  if (model.moc3?.endianness === MOC3_ENDIANNESS.BIG) bits.push('大端');
  if (typeof model.textures?.count === 'number' && model.textures.count > 0) {
    const side = model.textures.largestSide;
    bits.push(`${model.textures.count} 张纹理${typeof side === 'number' ? `（最大 ${side}px）` : ''}`);
  }
  if (typeof model.motions?.count === 'number' && model.motions.count > 0) {
    bits.push(`${model.motions.count} 个动作`);
  }
  if (typeof model.expressions === 'number' && model.expressions > 0) {
    bits.push(`${model.expressions} 个表情`);
  }
  bits.push(formatBytes(model.bytes));
  return bits.join(' · ');
}

/**
 * 下拉框里的标签：坏包带 `✕`、能用但不完整的带 `!`。
 *
 * 刻意**不用**对齐用的补白 —— 模型名长短不一，补白要么靠字体等宽（做不到），
 * 要么在中文名里塞空格（很难看）。前缀本身已经足够扫读，而完整原因在详情行。
 */
export function modelLabel(model: ModelEntry): string {
  if (!isLoadable(model)) return `✕ ${model.name}`;
  if (hasWarning(model)) return `! ${model.name}`;
  return model.name;
}

/** 模型库规模那一行。 */
export function describeLibrary(summary: LibrarySummary | null): string {
  if (summary === null) return '';
  return `模型库 ${summary.total} 个`
    + (summary.broken > 0 ? ` · ${summary.broken} 个有问题` : ' · 全部可用')
    + (summary.truncated === true ? ' · 已达扫描上限' : '');
}

/**
 * `evaluatePick` 的结果。
 *
 * 刻意写成**一个扁平形状**而不是 `{accept:true,…} | {accept:false,reason}` 的
 * 判别联合：这个项目的 `tsconfig.json` 是 `strict: false`（`strictNullChecks` 关着），
 * 那种配置下 `true`/`false` 字面量类型会被放宽成 `boolean`，判别式失效 ——
 * 写出来就是 `if (!decision.accept)` 之后的 `decision.reason` 报 TS2339。
 * 与其和编译器较劲，不如让调用点不必做类型体操。
 * 约定：`accept === false` 时 `reason` 一定非空，这条有单测钉住。
 */
export interface PickDecision {
  accept: boolean;
  id: string;
  model: ModelEntry | null;
  reason: string | null;
}

/**
 * 用户在下拉框里选了一个 id —— 该不该接受？
 *
 * 这条不是「友善提示」，是修一个真 bug：`Live2DStage` 的 effect 依赖
 * `modelPath`，切换时它先 `model.release()` 释放旧模型、再加载新的。
 * 新模型加载失败的话，用户得到的不是「切换失败」，而是**桌宠彻底消失**，
 * 只剩一行报错，而且再选回原来那个也不一定救得回来。
 * 所以坏包必须在 `selected` **被改之前**拦住 —— 只要 `active.path` 不变，
 * 旧模型就不会被释放，桌宠一直在。
 *
 * 找不到这个 id 时**接受**：那说明清单在客户端这边过期了（用户刚删了文件），
 * 而 `path` 是否真的存在由 `/model/<rel>` 那次请求说了算。在这里拦下来
 * 只会让「刷新一下」变成唯一出路。
 */
export function evaluatePick(models: ModelEntry[] | null, id: string): PickDecision {
  const model = (models ?? []).find((m) => m.id === id) ?? null;
  if (model === null) return { accept: true, id, model: null, reason: null };
  if (isLoadable(model)) return { accept: true, id, model, reason: null };
  const first = (model.problems ?? []).find((p) => p.level === 'error');
  return {
    accept: false,
    id,
    model,
    reason: `没有切换：「${model.name}」加载不起来`
      + (first !== undefined ? ` —— ${first.message}（${first.code}）` : ''),
  };
}

/**
 * 该默认选中哪个模型。
 *
 * **只要上一个选择还在清单里就保留它，哪怕它现在是坏的。** 这条是刻意的：
 * 用户上次选的是 miku，后来 miku 的纹理被覆盖坏了 —— 此时悄悄把他换到
 * 「空 - 免费版」会让他看见一只**不是自己选的**桌宠，而真正的问题（miku 坏了）
 * 只体现在下拉框里一个不起眼的 `✕` 上，多半不会被注意到。
 * 保留原选择则相反：界面停在 miku 上、红字说明它坏在哪，注意力正好在问题上。
 *
 * 只有在**没有偏好**（第一次打开、或上次选的那个已经被删了）时才跳过坏包，
 * 让默认落在一个能加载的模型上；全坏时退回第一个，好让用户看到问题而不是空白。
 */
export function pickDefault(models: ModelEntry[], previous: string | null): string | null {
  if (previous !== null && models.some((m) => m.id === previous)) return previous;
  const firstOk = models.find(isLoadable);
  return (firstOk ?? models[0])?.id ?? null;
}

/* ────────────────────────── 导入（zip） ────────────────────────── */

/**
 * 单个模型包的大小上限，**必须与 Host 的 `MAX_ZIP_BYTES` 一致**。
 *
 * 客户端这里再存一份是有代价的（两边可能漂移），但收益是「不用等 190MB 传完
 * 才被告知太大」—— 上传前的拒绝和上传后的拒绝，用户体验差别是分钟级的。
 * 漂移由 `tools/test-model-list.mjs` 里一条断言钉住：它 import Host 的常量
 * 和这里的常量做比对。和 `MAX_MOC3_VERSION` 用的是同一个办法 ——
 * **靠门禁断言，不靠手工同步。**
 */
export const MAX_IMPORT_BYTES = 192 * 1024 * 1024;

/**
 * 拖进来的东西该不该收。
 *
 * 判 `size` 也判扩展名：这是**用户友好层面的预检**，不是安全边界 ——
 * 真正的校验全在 Host 侧（`lib/host/zip.js`）。所以这里宁可宽松（只认得出
 * 明显不对的），也不要因为一个 `.ZIP` 大写、或用户把文件重命名过就拦住他。
 */
export interface DropDecision {
  accept: boolean;
  /** 收下的话是哪个文件（多文件时只取第一个符合条件的）。 */
  name: string;
  /** 不收的话为什么 —— 必须非空，否则用户面对的是「拖了没反应」。 */
  reason: string;
}

export function acceptDrop(files: { name: string; size: number }[] | null | undefined): DropDecision {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) {
    return { accept: false, name: '', reason: '没有读到文件。' };
  }
  if (list.length > 1) {
    return { accept: false, name: '', reason: `一次只能导入一个包，你拖进来了 ${list.length} 个。` };
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
      reason: `「${file.name}」有 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_IMPORT_BYTES)} 上限。`,
    };
  }
  return { accept: true, name: file.name, reason: '' };
}

/** 导入的四个阶段。写成扁平形状的理由同 `PickDecision`。 */
export interface ImportState {
  phase: 'idle' | 'uploading' | 'done' | 'failed';
  /** 用户看到的包名（上传中是文件名，完成后是目录名）。 */
  label: string;
  /** 上传进度用的总字节数，只有 `uploading` 时有意义。 */
  bytes: number;
  /** 完成后：落库的目录名 —— 用户要拿它去资源管理器里找。 */
  dir: string;
  /** 完成后：入库了但体检不通过（`phase` 仍是 `done`）。 */
  degraded: boolean;
  /** 完成后的问题清单（最多显示几条由界面决定）。 */
  problems: ModelProblem[];
  /** 失败时的稳定错误码与细节。 */
  code: string;
  detail: string;
}

export const IDLE_IMPORT: ImportState = {
  phase: 'idle',
  label: '',
  bytes: 0,
  dir: '',
  degraded: false,
  problems: [],
  code: '',
  detail: '',
};

export function isImporting(state: ImportState): boolean {
  return state.phase === 'uploading';
}

/**
 * 导入状态 → 一行给用户看的文字。
 *
 * 「导入失败」这四个字没有信息量：用户需要知道**是包坏了还是我下错了东西**，
 * 因为前者要去修文件、后者要去重新下载。所以 Host 的错误码在这里被翻译成
 * 两种语气 —— `E_IMPORT_NO_MODEL` 是「这不是模型包」，其余是「这个包有问题」。
 */
export function describeImport(state: ImportState): string {
  switch (state.phase) {
    case 'uploading':
      return state.bytes > 0
        ? `正在导入 ${state.label}（${formatBytes(state.bytes)}）…`
        : `正在导入 ${state.label}…`;
    case 'done':
      /*
       * 入库了但体检不通过 —— 这**不是失败**，是 Host 刻意的策略：
       * 让用户能在列表里看见它、读到缺哪张图，而不是收到一句「导入失败」
       * 然后完全不知道自己的包哪里不对。
       */
      return state.degraded
        ? `已导入「${state.dir}」，但它加载不起来：${state.problems[0]?.message ?? '见下方说明'}`
        : `已导入「${state.dir}」，可以用。`;
    case 'failed':
      if (state.code === 'E_IMPORT_NO_MODEL') {
        return `「${state.label}」里没有 .model3.json，不像是模型包。`;
      }
      if (state.code === 'E_ZIP_BOMB_SUSPECT' || state.code === 'E_ZIP_TOO_LARGE_UNCOMPRESSED') {
        return `「${state.label}」解压后异常地大，为了保护磁盘没有导入。`;
      }
      if (state.code === 'E_ZIP_UNSAFE_PATH') {
        return `「${state.label}」里有指向压缩包外面的路径，已拒绝。`;
      }
      if (state.code === 'E_BODY_TOO_LARGE') {
        return `「${state.label}」超过 ${formatBytes(MAX_IMPORT_BYTES)} 上限，没有上传。`;
      }
      /*
       * 这条路由不存在时的 404，在本项目里只有一个原因：Host 半区还跑着
       * 改动前的模块（Node 的 ESM 模块缓存不失效，见方案 §9.3）。
       * 用户看到「导入失败：404」只会以为是自己包的问题，然后开始反复重压 ——
       * 所以这里直接说清要做什么。
       */
      if (state.code === 'HTTP_404') {
        return '导入功能还没生效：Host 半区需要重启 DSH 才会加载新代码。';
      }
      return `导入「${state.label}」失败：${state.detail !== '' ? state.detail : state.code}`;
    default:
      return '';
  }
}

/** `describeImport` 的结果该用什么颜色 —— 界面靠这个决定 `data-err`。 */
export function importLevel(state: ImportState): 'none' | 'info' | 'warn' | 'error' {
  if (state.phase === 'uploading') return 'info';
  if (state.phase === 'done') return state.degraded ? 'warn' : 'none';
  if (state.phase === 'failed') return 'error';
  return 'none';
}
