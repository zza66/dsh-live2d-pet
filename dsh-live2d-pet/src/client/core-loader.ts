/**
 * Cubism Core 的就绪探测。
 *
 * **Core 本身不由这里加载** —— 它被 `build.mjs` 以前置 banner 的形式注入，在本文件
 * 所在的 bundle 被求值**之前**就已经执行了。这里只做两件事：确认它挂上来了，
 * 然后等它的异步初始化跑完。
 *
 * 为什么不在这里懒加载（这是踩过的坑，改动前务必读完）：
 *   Framework 的 `model/cubismmodel.ts` 里有
 *     `export enum CubismColorBlend { ColorBlend_Normal = Live2DCubismCore.ColorBlendType_Normal, … }`
 *   枚举成员在**模块求值那一刻**就要读 `Live2DCubismCore.*`。所以「Framework 被求值」
 *   本身就要求 Core 已经在全局。之前把 Core 放进 React 副作用里用 blob `<script>` 懒加载，
 *   结果 bundle 一求值就抛 `Live2DCubismCore is not defined`；脚本抛错 → 没走到
 *   `__ModuleLoader__.load()` → DSH 外壳判定这个 client entry 加载失败 → **应用白屏起不来**。
 *   把 Core 提到 banner 就一次性解决了「求值顺序」和「脚本抛错」两个问题。
 *
 * 另外两条来自官方 Core 行为的约束（实测）：
 *   - 它是 emscripten 的 **wasm→JS 构建**（228 KB 里没有一个 ≥0x80 的字节，SDK 里也
 *     没有任何 .wasm），初始化异步，约 20–30 ms 后才可用。
 *   - 在就绪之前调用 `csmGetVersion()` 会**抛异常**（`Cannot read properties of
 *     undefined (reading 'apply')`），不是返回 0。所以探测循环必须把「抛错」当成
 *     「还没好」，而不是当成失败。
 */

/** Core 就绪探测的上限。实测 20–30 ms 就绪，10 s 是「明显出了别的问题」。 */
const CORE_READY_TIMEOUT_MS = 10000;

/** 形状只写到我们真正会用的部分，避免把 Core 的 d.ts 抄一遍。 */
export interface CubismCoreLike {
  Version: {
    csmGetVersion(): number;
    csmGetLatestMocVersion(): number;
    csmGetMocVersion(buffer: ArrayBuffer): number;
  };
  Moc: { fromArrayBuffer(buffer: ArrayBuffer): unknown };
  Model: { fromMoc(moc: unknown): unknown };
}

/**
 * 从全局读 Core。
 *
 * 刻意**不写 `declare global { var Live2DCubismCore }`**：官方的
 * `live2dcubismcore.d.ts` 已经声明了同名 namespace（见 `src/types/`），再声明一个
 * `var` 会撞成 `Duplicate identifier`。而 namespace 是不能当值读的，所以这里用一次
 * 窄化 cast —— 我们本来就只需要知道「它是不是个可用的对象」。
 */
function readGlobal(): unknown {
  try {
    return (globalThis as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore;
  } catch {
    return undefined;
  }
}

/** 去重：同一个页面里多个组件同时要 Core 时只探测一次。 */
let pending: Promise<CubismCoreLike> | null = null;

function isUsable(core: unknown): core is CubismCoreLike {
  const candidate = core as CubismCoreLike | undefined;
  return (
    candidate !== undefined &&
    candidate !== null &&
    typeof candidate.Version?.csmGetVersion === 'function' &&
    typeof candidate.Moc?.fromArrayBuffer === 'function'
  );
}

export function loadCubismCore(): Promise<CubismCoreLike> {
  if (pending !== null) return pending;

  pending = new Promise<CubismCoreLike>((resolve, reject) => {
    const core = readGlobal();
    if (!isUsable(core)) {
      // 走到这里说明 banner 没生效或产物被改坏了 —— 属于构建问题，不是运行环境问题。
      reject(
        new Error(
          'E_CORE_MISSING: 全局没有 Live2DCubismCore。build.mjs 应该把它作为 banner '
            + '前置注入；产物若被重新打包而丢掉了 banner，就会看到这条。',
        ),
      );
      return;
    }
    waitUntilReady(core, resolve, reject);
  });

  // 失败不该被永久缓存：下次重挂组件时可以再试一次。
  pending.catch(() => {
    pending = null;
  });

  return pending;
}

/**
 * 轮询到 Core 真的可用。
 *
 * 这是本文件存在的主要理由：banner 只保证**脚本已执行**，不保证 emscripten 那部分
 * 初始化结束。中间这段时间里 `csmGetVersion()` 会抛异常。
 */
function waitUntilReady(
  core: CubismCoreLike,
  resolve: (core: CubismCoreLike) => void,
  reject: (error: Error) => void,
): void {
  const started = Date.now();

  const tick = () => {
    try {
      const version = core.Version.csmGetVersion();
      if (typeof version === 'number' && version > 0) {
        resolve(core);
        return;
      }
    } catch {
      // 还没就绪——见文件头注释，这是**预期**行为。
    }

    if (Date.now() - started > CORE_READY_TIMEOUT_MS) {
      reject(new Error(`E_CORE_NOT_READY: Cubism Core ${CORE_READY_TIMEOUT_MS}ms 内未就绪`));
      return;
    }
    setTimeout(tick, 16);
  };

  tick();
}

/** 人类可读的版本号（Core 的 raw 版本是按字节打包的，直接显示不好读）。 */
export function formatCoreVersion(raw: number): string {
  // 官方打包方式：0x06000001 → 6.0.0.1
  const major = (raw >> 24) & 0xff;
  const minor = (raw >> 16) & 0xff;
  const patch = (raw >> 8) & 0xff;
  const build = raw & 0xff;
  return `${major}.${minor}.${patch}.${build}`;
}
