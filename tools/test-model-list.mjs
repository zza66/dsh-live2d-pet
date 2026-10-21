#!/usr/bin/env node
/**
 * 门禁：模型库清单的**纯逻辑**（`lib/test/model-list.mjs` ＝ `src/client/model-list.ts`）。
 *
 * 为什么需要这个文件：`simulate-client-boot.mjs` 能证明「渲染不抛」，但它用的是
 * 桩 React —— `useState` 返回固定值、setter 是空函数、effect 从不执行。于是渲染
 * 永远停在「正在扫描模型库…」那一帧，下拉框根本没被建出来。**「坏包会被标出来」
 * 和「切到坏包会被拦下」这两条在那个门禁下是不可证伪的**，而它们恰好是这次改动的
 * 全部意义。把决策逻辑挪进纯函数再单独打包，就是为了让下面这些断言能存在。
 *
 * 用法：`node tools/test-model-list.mjs`（离线，无网络、无文件系统）
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, '..', 'dsh-live2d-pet', 'lib/test/model-list.mjs');

let failed = 0;
let passed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

if (!existsSync(modulePath)) {
  console.error(`模型清单测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const {
  acceptDrop,
  describeImport,
  describeLibrary,
  describeModel,
  evaluatePick,
  formatBytes,
  hasError,
  hasWarning,
  IDLE_IMPORT,
  importLevel,
  isImporting,
  isLoadable,
  MAX_IMPORT_BYTES,
  modelLabel,
  pickDefault,
} = mod;

console.log(`[1] 导出契约  ${modulePath.replace(here, 'tools')}`);
for (const name of [
  'isLoadable', 'hasError', 'hasWarning', 'formatBytes',
  'describeModel', 'modelLabel', 'describeLibrary', 'evaluatePick', 'pickDefault',
  'acceptDrop', 'describeImport', 'importLevel', 'isImporting',
]) {
  check(`导出 ${name}`, typeof mod[name] === 'function');
}
check('导出 IDLE_IMPORT', IDLE_IMPORT !== null && typeof IDLE_IMPORT === 'object' && IDLE_IMPORT.phase === 'idle');
check('导出 MAX_IMPORT_BYTES', typeof MAX_IMPORT_BYTES === 'number' && MAX_IMPORT_BYTES > 0);

/*
 * ★ 跨半区常量一致性。
 *
 * 客户端的 `MAX_IMPORT_BYTES` 和 Host 的 `MAX_ZIP_BYTES` 是同一个数字的两份拷贝
 * —— 客户端那份存在的意义是「别等 190MB 传完才说太大」，但两份拷贝就有可能漂移。
 * 漂移的后果不是崩溃，而是**客户端收下、Host 拒绝**：用户看着进度条走完，
 * 然后收到一句「文件太大」。所以这里直接把 Host 的常量 import 进来比对。
 *
 * 这个文件本来是纯离线的（不碰文件系统、不连网络），读一个同仓库的源文件
 * 不违背那个约束 —— 它读的是**代码**，不是用户数据。
 */
{
  const hostZip = await import(new URL(`file://${resolve(here, '..', 'dsh-live2d-pet', 'lib/host/zip.js').replace(/\\/g, '/')}`).href);
  check(
    `MAX_IMPORT_BYTES 与 Host 的 MAX_ZIP_BYTES 一致（${formatBytes(MAX_IMPORT_BYTES)}）`,
    hostZip.MAX_ZIP_BYTES === MAX_IMPORT_BYTES,
    `客户端 ${MAX_IMPORT_BYTES} / Host ${hostZip.MAX_ZIP_BYTES}`,
  );
}

/** 造一个健康模型。 */
const good = (id, name = id) => ({
  id, path: `${id}/${name}.model3.json`, name,
  ok: true, problems: [],
  moc3: { version: 5, endianness: 'little' },
  textures: { count: 3, bytes: 1024 * 1024, largestSide: 8192 },
  motions: { groups: ['Idle'], count: 4 },
  expressions: 8, bytes: 12 * 1024 * 1024,
});

/** 造一个坏模型（有 error 级问题）。 */
const broken = (id, code = 'E_TEXTURE_MISSING', message = '引用的纹理文件不存在') => ({
  ...good(id),
  ok: false,
  problems: [{ code, message, detail: 'textures/tex_00.png', level: 'error' }],
});

/** 造一个「能用但不完整」的模型（只有 warn）。 */
const warnOnly = (id) => ({
  ...good(id),
  ok: true,
  problems: [{ code: 'E_MOTION_AUDIO_MISSING', message: '动作的配音文件不存在', level: 'warn' }],
});

/** 旧版 Host 的返回：只有三个字段，没有任何体检信息。 */
const legacy = (id) => ({ id, path: `${id}/x.model3.json`, name: id });

/* ── [2] 能不能加载：只看 ok，缺信息算「能」 ────────────────────────── */
console.log('[2] isLoadable：判定只看 ok===false，"不知道" 不算 "坏"');
check('ok:true → 能加载', isLoadable(good('a')) === true);
check('ok:false → 不能加载', isLoadable(broken('b')) === false);
check(
  '★ 没有体检字段（旧 Host）→ 当作能加载',
  isLoadable(legacy('c')) === true,
  '把「不知道」当「坏」会让每次升级都误报，误报多了标记就没人看了',
);
check('只有 warn → 能加载', isLoadable(warnOnly('d')) === true);

console.log('[2b] hasError / hasWarning 各看各的级别');
check('error 级被 hasError 看见', hasError(broken('e')) === true);
check('error 级不被 hasWarning 误判', hasWarning(broken('e')) === false);
check('warn 级被 hasWarning 看见', hasWarning(warnOnly('f')) === true);
check('warn 级不被 hasError 误判', hasError(warnOnly('f')) === false);

/* ── [3] 下拉框标签 ─────────────────────────────────────────────────── */
console.log('[3] modelLabel：坏包 ✕、不完整 !、正常原样');
check('坏包带 ✕ 前缀', modelLabel(broken('g', 'E_TEXTURE_MISSING', 'x')).startsWith('✕ '), modelLabel(broken('g')));
check('不完整带 ! 前缀', modelLabel(warnOnly('h')).startsWith('! '), modelLabel(warnOnly('h')));
check('正常模型不加任何前缀', modelLabel(good('i', '空 - 免费版')) === '空 - 免费版', modelLabel(good('i', '空 - 免费版')));
check('旧 Host 的条目也原样显示', modelLabel(legacy('j')) === 'j', modelLabel(legacy('j')));

/* ── [4] 描述行 ─────────────────────────────────────────────────────── */
console.log('[4] describeModel / describeLibrary：给人看的字符串');
const desc = describeModel(good('k'));
check('含 moc3 版本', desc.includes('moc3 v5'), desc);
check('含纹理张数与最大边', desc.includes('3 张纹理') && desc.includes('8192px'), desc);
check('含动作数与表情数', desc.includes('4 个动作') && desc.includes('8 个表情'), desc);
check('含可读的体积', desc.includes('12.0 MB'), desc);
check('没有体检信息时不编造内容', describeModel(legacy('l')) === '?', describeModel(legacy('l')));
check('null 返回空串（那一行整行不显示）', describeModel(null) === '', JSON.stringify(describeModel(null)));

check('formatBytes 的四个量级', formatBytes(512) === '512 B'
  && formatBytes(2048) === '2.0 KB'
  && formatBytes(12 * 1024 * 1024) === '12.0 MB'
  && formatBytes(undefined) === '?',
  `${formatBytes(512)} / ${formatBytes(2048)} / ${formatBytes(12 * 1024 * 1024)} / ${formatBytes(undefined)}`);

check('摘要：全部可用', describeLibrary({ total: 3, ok: 3, broken: 0 }) === '模型库 3 个 · 全部可用',
  describeLibrary({ total: 3, ok: 3, broken: 0 }));
check('摘要：有坏包时点名数量', describeLibrary({ total: 3, ok: 2, broken: 1 }) === '模型库 3 个 · 1 个有问题',
  describeLibrary({ total: 3, ok: 2, broken: 1 }));
check('摘要：扫到上限时说清楚', describeLibrary({ total: 200, ok: 200, broken: 0, truncated: true }).includes('已达扫描上限'),
  describeLibrary({ total: 200, ok: 200, broken: 0, truncated: true }));
check('摘要：没有摘要时是空串', describeLibrary(null) === '');

/* ── [5] ★ 切换被拦（这次改动的核心） ───────────────────────────────── */
console.log('[5] evaluatePick：坏包必须在 selected 被改之前拦住');
const list = [good('ok1', '空 - 免费版'), broken('bad1', 'E_TEXTURE_MISSING', '引用的纹理文件不存在'), warnOnly('warn1'), legacy('old1')];

const dBad = evaluatePick(list, 'bad1');
check('★ 坏包被拒绝', dBad.accept === false);
check('拒绝时给出原因（不是静默什么都不发生）', typeof dBad.reason === 'string' && dBad.reason.length > 0, dBad.reason);
check('原因里带错误码，用户能拿去搜索', dBad.reason.includes('E_TEXTURE_MISSING'), dBad.reason);
check('原因里带模型名，多模型时知道是哪个', dBad.reason.includes('bad1'), dBad.reason);
check('拒绝时仍然把模型带回去（界面要显示它的问题清单）', dBad.model?.id === 'bad1');

const dGood = evaluatePick(list, 'ok1');
check('健康模型被接受', dGood.accept === true && dGood.id === 'ok1');
check('接受时 reason 是 null（约定：accept===true ⇒ reason===null）', dGood.reason === null);

const dWarn = evaluatePick(list, 'warn1');
check('★ 只有 warn 的模型**允许**切换（能用就不该拦）', dWarn.accept === true, String(dWarn.reason));

const dLegacyOld = evaluatePick(list, 'old1');
check('★ 旧 Host 的条目允许切换（缺信息 ≠ 坏）', dLegacyOld.accept === true);

const dMissing = evaluatePick(list, 'not-in-list');
check('清单里没有的 id 也接受（清单可能过期，真伪交给 /model 那次请求）', dMissing.accept === true);
check('清单为 null 时不抛', evaluatePick(null, 'anything').accept === true);

const dNoCode = evaluatePick([{ ...broken('bad2'), problems: [{ code: 'E_X', message: 'y', level: 'error' }] }], 'bad2');
check('问题是 error 但没写 detail 也能给出原因', dNoCode.accept === false && dNoCode.reason.includes('y'), dNoCode.reason);

/* ── [6] 默认选中 ───────────────────────────────────────────────────── */
console.log('[6] pickDefault：保留偏好、只为"没偏好"的情况跳过坏包');
check('★ 保留上次选择（用户的偏好不该被一次重扫抹掉）', pickDefault(list, 'warn1') === 'warn1');
check(
  '★ 上次选的模型后来坏了 → 仍然保留它',
  pickDefault(list, 'bad1') === 'bad1',
  String(pickDefault(list, 'bad1')),
);
check(
  '  （理由：悄悄换成别的模型，用户会看到一只不是自己选的桌宠，'
  + '而真正的问题只剩下拉框里一个 ✕ —— 保留则红字直接说明坏在哪）',
  true,
);
check('没有偏好时选第一个能加载的', pickDefault(list, null) === 'ok1');
check(
  '★ 没有偏好且第一个是坏包 → 跳过它，默认落在能加载的模型上',
  pickDefault([broken('z1'), good('z2')], null) === 'z2',
  String(pickDefault([broken('z1'), good('z2')], null)),
);
check(
  '★ 全是坏包时退回第一个（让用户看到问题，而不是一片空白）',
  pickDefault([broken('y1'), broken('y2')], null) === 'y1',
  String(pickDefault([broken('y1'), broken('y2')], null)),
);
check('空清单返回 null', pickDefault([], null) === null);
check('空清单且没有偏好时也是 null', pickDefault([], 'x') === null);
check('偏好指向已删除的模型时重新选', pickDefault([good('n1')], 'gone') === 'n1');
check(
  '偏好指向已删除的模型、且只剩坏包时，退到那个坏包（而不是空白）',
  pickDefault([broken('m1')], 'gone') === 'm1',
  String(pickDefault([broken('m1')], 'gone')),
);

/* ── [7] 反向验证：门禁本身会不会红 ─────────────────────────────────── */
console.log('[7] 反向验证：把三个退化实现塞进来，断言门禁确实会失败');
{
  /*
   * 三个「看起来能跑」的退化实现。如果上面的断言其实没在验东西，换成它们
   * 之后应该照样全绿 —— 那就说明门禁是摆设。这里断言它们**确实**让对应的
   * 断言变红。注意三条各自用**对应**的退化实现，否则验的是别的东西：
   * 第一版这里就写错了 —— pickDefault 那条仍然调真实现，于是它是 true，
   * 反向验证自己变成了假的。
   */
  const naive = {
    evaluatePick: () => ({ accept: true, id: '', model: null, reason: null }),
    modelLabel: (m) => m.name,
    pickDefault: (models) => models[0]?.id ?? null,
  };
  const wouldFail = [
    naive.evaluatePick(list, 'bad1').accept === false,
    naive.modelLabel(broken('g')).startsWith('✕ '),
    naive.pickDefault([broken('z1'), good('z2')], null) === 'z2',
  ];
  check('退化实现确实触发 3 条断言失败', wouldFail.every((v) => v === false), JSON.stringify(wouldFail));
}

/* ────────────────────── [7b] 导入预检 acceptDrop ────────────────────── */
console.log('');
console.log('[7b] 导入预检');
{
  const zip = (name, size) => ({ name, size });

  check('单个 zip → 收下', acceptDrop([zip('miku.zip', 1024)]).accept === true);
  check('收下时不编造理由', acceptDrop([zip('miku.zip', 1024)]).reason === '');
  check('.ZIP 大写也认（扩展名大小写不该拦人）', acceptDrop([zip('MIKU.ZIP', 1024)]).accept === true);

  // 每一条拒绝都**必须**带理由：拖上去没反应是最难自己诊断的失败。
  for (const [label, files] of [
    ['空输入', []],
    ['null', null],
    ['undefined', undefined],
    ['多个文件', [zip('a.zip', 1), zip('b.zip', 2)]],
    ['非 zip', [zip('miku.rar', 1)]],
    ['没有扩展名', [zip('miku', 1)]],
    ['空文件', [zip('miku.zip', 0)]],
    ['超过上限', [zip('miku.zip', MAX_IMPORT_BYTES + 1)]],
  ]) {
    const decision = acceptDrop(files);
    check(`拒绝：${label}`, decision.accept === false);
    check(`拒绝：${label} 说明了原因`, typeof decision.reason === 'string' && decision.reason.length > 0, decision.reason);
  }

  // 边界：正好等于上限要收下（> 而不是 >=），否则「最大就传不了」很反直觉。
  check('正好等于上限 → 收下', acceptDrop([zip('miku.zip', MAX_IMPORT_BYTES)]).accept === true);
  // 多文件被拒时说清数量，用户才知道自己拖多了。
  check('多文件被拒时报告数量', acceptDrop([zip('a.zip', 1), zip('b.zip', 2)]).reason.includes('2'));
}

/* ────────────────────── [7c] 导入状态文案 ────────────────────── */
console.log('');
console.log('[7c] 导入状态文案');
{
  const at = (patch) => ({ ...IDLE_IMPORT, ...patch });

  check('空闲不显示任何东西', describeImport(IDLE_IMPORT) === '');
  check('空闲的 importLevel 是 none', importLevel(IDLE_IMPORT) === 'none');
  check('空闲不算导入中', isImporting(IDLE_IMPORT) === false);

  const up = at({ phase: 'uploading', label: 'miku.zip', bytes: 12 * 1024 * 1024 });
  check('上传中说明包有多大', describeImport(up).includes('12.0 MB'), describeImport(up));
  check('上传中算导入中（按钮要禁用）', isImporting(up) === true);
  check('上传中是 info 级', importLevel(up) === 'info');

  const ok = at({ phase: 'done', label: 'miku.zip', dir: 'miku', degraded: false });
  check('成功时报出落库目录名', describeImport(ok).includes('miku'), describeImport(ok));
  check('成功是 none 级（不需要染色）', importLevel(ok) === 'none');

  /*
   * 入库但体检不通过**不是失败**：Host 刻意让它入库，好让用户在下拉框里
   * 看见它、读到缺哪张图。所以这里必须报「已导入」，同时把第一条问题说出来。
   */
  const degraded = at({
    phase: 'done', label: 'x.zip', dir: 'broken', degraded: true,
    problems: [{ code: 'E_MODEL_FILE_MISSING', message: '引用的纹理文件不存在', detail: 'textures/00.png', level: 'error' }],
  });
  check('体检不通过仍报「已导入」', describeImport(degraded).includes('已导入'), describeImport(degraded));
  check('并且说出第一条问题', describeImport(degraded).includes('引用的纹理文件不存在'), describeImport(degraded));
  check('体检不通过是 warn 级（不是 error）', importLevel(degraded) === 'warn');

  // 「不是模型包」和「模型包坏了」要给出**不同**的话：前者让用户重新下载，
  // 后者让他修文件。两者混成一句「导入失败」等于把线索扔了。
  const noModel = at({ phase: 'failed', label: 'photos.zip', code: 'E_IMPORT_NO_MODEL', detail: '没有 .model3.json' });
  const bomb = at({ phase: 'failed', label: 'evil.zip', code: 'E_ZIP_BOMB_SUSPECT', detail: '压缩比 900' });
  const escape = at({ phase: 'failed', label: 'evil2.zip', code: 'E_ZIP_UNSAFE_PATH', detail: '../x' });
  check('无模型定义 → 说是「不是模型包」', describeImport(noModel).includes('不像是模型包'), describeImport(noModel));
  check('炸弹 → 说是「解压后异常地大」', describeImport(bomb).includes('异常地大'), describeImport(bomb));
  check('路径穿越 → 说明已拒绝', describeImport(escape).includes('拒绝'), describeImport(escape));
  check('三种失败的话各不一样', new Set([describeImport(noModel), describeImport(bomb), describeImport(escape)]).size === 3);
  check('失败都是 error 级', [noModel, bomb, escape].every((s) => importLevel(s) === 'error'));

  // 未知错误码要退回 detail：那是用户修包唯一的线索，不能被一句通用文案吃掉。
  const unknown = at({ phase: 'failed', label: 'a.zip', code: 'E_SOMETHING_NEW', detail: 'CRC 校验失败于第 3 个条目' });
  check('未知错误码仍带出 detail', describeImport(unknown).includes('CRC 校验失败于第 3 个条目'), describeImport(unknown));
  const bare = at({ phase: 'failed', label: 'a.zip', code: 'E_SOMETHING_NEW', detail: '' });
  check('没有 detail 时退回错误码', describeImport(bare).includes('E_SOMETHING_NEW'), describeImport(bare));

  /*
   * 这条 404 在本项目里只有一个原因（Host 半区没重启），而用户看到
   * 「导入失败：404」只会以为是自己的包坏了 —— 所以它值得一条专属文案。
   */
  const stale = at({ phase: 'failed', label: 'a.zip', code: 'HTTP_404', detail: '<html>Not Found</html>' });
  check('404 → 指向「Host 需要重启」而不是让用户怀疑自己的包', describeImport(stale).includes('重启'), describeImport(stale));
  check('404 不把 HTML 原文糊到用户脸上', !describeImport(stale).includes('<html>'), describeImport(stale));
}

console.log('');
if (failed > 0) {
  console.error(`[x] MODEL LIST GATE FAILED —— ${failed} 项失败 / ${passed} 项通过`);
  process.exit(1);
}
console.log(`[8] MODEL LIST GATE PASSED —— ${passed} 项断言全绿`);
