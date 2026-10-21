/**
 * 打**正在运行的 DSH** 的 Host 路由门禁。
 *
 * 与 `simulate-host-boot.mjs` 的区别：那道验「模块本身对不对」（本地起临时服务器），
 * 这道验「DSH 里跑着的那个进程加载的是不是我刚改的代码」。
 *
 * 后者的必要性是被实测逼出来的：Host 半区改了代码、把插件关掉再打开，`apply` 确实
 * 重跑了，但 **ESM 模块缓存不会失效** —— 路由还是旧的，而所有模块级测试全绿。
 * 所以「改完 Host 代码」到「真的生效」之间必须有一道断言，否则就会在浏览器里
 * 对着 404 反复猜。
 *
 * 用法：node tools/test-host-routes.mjs [--port 19387] [--no-live]
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { checkHostRoutes } from './lib/host-route-checks.mjs';

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 19387;
})();
const LIVE = !process.argv.includes('--no-live');
const BASE = `http://127.0.0.1:${PORT}/.dsh-live2d-pet`;

console.log(`[1] 目标 ${BASE}`);

let failures;
try {
  failures = await checkHostRoutes(BASE, { live: LIVE });
} catch (error) {
  /*
   * 走到这里**不等于连不上**：断言代码自己写崩（比如对旧 Host 缺字段的返回
   * 直接 `.every()`）也会抛。把两者混成一句话会让人去查网络，而真正要修的是
   * 别的东西 —— 这里把原始错误留在第一行，再给两种可能。
   */
  console.log(`  ✘ 门禁中断：${error?.stack ?? error?.message ?? error}`);
  console.log('\n[x] HOST ROUTES GATE FAILED：门禁自己出错了（见上面第一行原始错误）');
  console.log('    两种可能：① 断言代码对缺字段的返回不够宽容（先看栈顶是不是 host-route-checks.mjs）；');
  console.log('              ② 真的连不上 DSH（那会是 fetch failed / ECONNREFUSED）。');
  process.exit(1);
}

console.log('');
if (failures.length === 0) {
  console.log('[4] HOST ROUTES GATE PASSED');
} else {
  console.log(`[x] HOST ROUTES GATE FAILED：${failures.length} 项未通过`);
  for (const f of failures) console.log(`    - ${f}`);
  /*
   * 别让「断言没过」被读成「连不上」。这两种失败要修的是完全不同的东西：
   * 连不上是环境问题（DSH 没跑），断言没过是**正在运行的这个进程加载的是旧代码**
   * —— 那是本项目最贵的一条坑（§9.3：开关插件会重跑 apply，但 ESM 模块缓存
   * 不会失效）。照着「服务器不可达」去查，会白花很久。
   */
  console.log('');
  console.log('  提示：如果上面失败的是**新加的字段或路由**，那不是网络问题 ——');
  console.log('  是正在运行的 DSH 还加载着改动前的 Host 模块。关掉应用再打开即可。');
  process.exitCode = 1;
}
