/**
 * 引用路径的归一化与安全判定 —— 三处合并逻辑共用的最小底座。
 *
 * ## 为什么单独一个文件
 *
 * 这两件事本来住在 `vts-profile.js` 里。加「自动认领散落的动作 / 表情文件」时，
 * `loose-files.js` 也需要它们，于是形成 `vts-profile.js → loose-files.js →
 * vts-profile.js` 的**循环导入**。ESM 能容忍它（用到时才求值），但那是靠时序侥幸：
 * 哪天有人在模块顶层拿这两个函数算一个常量，就会拿到 `undefined`，
 * 而症状是「某个模型的表情数量莫名其妙变成 0」—— 离原因十万八千里。
 *
 * 抽出来之后依赖是一个方向：`ref-path.js` ← `loose-files.js` ← `vts-profile.js`。
 * `vts-profile.js` 仍然**转出**这两个函数，所以既有的 import 一行都不用改。
 *
 * ## 两份「表」都要用同一套归一化
 *
 * `model-library.js`（体检）与合并逻辑必须按**同一个**规则判断「这个文件登记过了没有」。
 * 各写一份，就会出现「去重没去干净、同一个表情加两遍」—— 第八个缺陷的形状
 * （同一个数字有两处定义，而两处会漂移）。
 *
 * @module dsh-live2d-pet/host/ref-path
 */

/** 表情 / 动作的文件名后缀。 */
export const EXPRESSION_SUFFIX = '.exp3.json';
export const MOTION_SUFFIX = '.motion3.json';

/**
 * 引用路径的长度上限。
 *
 * 纯粹是防御：真实模型里没有这么长的名字，但 `*.vtube.json` 是**用户可以随手编辑的
 * 外部文件**，我们不能假定它规整。超长路径进到合成结果里，症状是
 * 客户端请求一个必然 404 的地址。
 */
export const MAX_REF_CHARS = 260;

/**
 * 把 `FileReferences` 里写的路径与磁盘上走出来的相对路径归一成可比较的形式。
 *
 * 三处差异都要抹掉，否则「明明登记了却还报未登记」：
 *   - 分隔符（写 `motions\a.motion3.json` 与走出来的 `motions/a.motion3.json`）；
 *   - 开头多余的 `./`（两种写法官方样本里都出现过）；
 *   - 大小写 —— 模型库在 Windows 上，`Motions/A.Motion3.JSON` 与磁盘上的
 *     小写名字是同一个文件，逐字节比会把它判成两个。
 *
 * 这个函数**从 `model-library.js` 搬过来**（原来在那边是私有的）：合并逻辑
 * 也必须用同一套归一化。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeRefPath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * 这个引用路径能不能安全地交给客户端去取。
 *
 * 客户端拿到合成后的 `model3.json`，会按里面的 `File` 去请求
 * `/.dsh-live2d-pet/model/<rel>`。`lib/index.js` 那条路由自己有一道
 * `E_PATH_ESCAPE` 守卫，这里是**纵深**：一份能被越界的合成结果根本不该被生成出来。
 *
 * @param {unknown} value
 * @param {string} suffix 要求的后缀（`.exp3.json` / `.motion3.json`）
 * @returns {boolean}
 */
export function isSafeRefPath(value, suffix) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (raw === '' || raw.length > MAX_REF_CHARS) return false;
  if (!raw.toLowerCase().endsWith(suffix)) return false;
  // 绝对路径（`/x`、`\x`、`C:/x`）与任何 `..` 段都不接受。
  if (/^[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw)) return false;
  if (raw.replace(/\\/g, '/').split('/').includes('..')) return false;
  return true;
}
