/**
 * esbuild 虚拟模块的类型声明（见 `build.mjs` 里的 `live2d-virtual-assets` 插件）。
 *
 * `virtual:live2d-shaders` 在磁盘上不存在 —— 它的内容由构建时读 `shaders/` 生成，
 * 把 13 个 GLSL 源码内联进 bundle，运行时不发 HTTP。
 *
 * 没有这份声明，编辑器和 `tsc` 都会把这条 import 报成「找不到模块」，
 * 而构建其实完全正常 —— 属于假警报，必须在源头消掉。
 *
 * 注意 Cubism Core **不是**虚拟模块：Framework 的顶层 enum 在模块求值时就要求
 * `Live2DCubismCore` 已存在，所以它必须走 `build.mjs` 的 banner 前置执行，
 * 不能靠 `import`（import 的求值顺序与 Framework 的 import 顺序耦合，太脆）。
 */

declare module 'virtual:live2d-shaders' {
  /** shader 文件名列表，例如 `vertshadersrc.vert`。 */
  export const SHADER_NAMES: readonly string[];
  /** 文件名 → GLSL 源码。 */
  export const SHADER_SOURCES: Readonly<Record<string, string>>;
}
