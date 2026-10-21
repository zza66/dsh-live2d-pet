#!/usr/bin/env node
/**
 * 门禁：**跨边界字段类型** —— Host 真实产出 ↔ 客户端 TS 声明。
 *
 * 为什么需要这个文件：第十一个真缺陷是 `moc3.endianness` 一边发数字、一边声明
 * 字符串。Host 写 `out.endianness = head[5]`（裸字节 `0`/`1`），客户端的
 * `ModelEntry` 声明 `endianness?: string`，`describeModel()` 拿 `=== 'big'` 比 ——
 * `1 === 'big'` 恒假，于是那句专门为大端写的「大端」标签**永远不会出现**。
 *
 * 这个缺陷能躲过**全部 22 道门禁**，因为它落在每一道门禁的缝里：
 *   · `npx tsc --noEmit` 看不见 —— 跨边界走的是 JSON，编译期两边根本不见面；
 *   · Host 的测试看不见 —— 它们只看 Host 自己那一半，`endianness === 0` 完全自洽；
 *   · 客户端的测试看不见 —— `test-model-list.mjs` 里那条夹具写的是
 *     `moc3: { version: 5, endianness: 'little' }`，**它按客户端以为的类型造数据**，
 *     于是永远验不出真实 Host 发的其实是数字。这是最要命的一种测试：
 *     它把「我以为的契约」当成了「契约」。
 *
 * 所以这道门禁的做法只有一条：**跑真的 Host 生产函数，把真实产出喂给真的客户端
 * 函数**，然后断言用户能看见的那个结果。不是复述声明，不是文本比对 —— 是执行。
 *
 * 用法：`node tools/test-wire-types.mjs`（离线；只在自己建的临时目录里写夹具）
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..', 'dsh-live2d-pet');
const clientModulePath = resolve(pkg, 'lib/test/model-list.mjs');
const clientSourcePath = resolve(pkg, 'src/client/model-list.ts');

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

function section(title) {
  console.log(`\n${title}`);
}

if (!existsSync(clientModulePath)) {
  console.error(`客户端测试产物不存在：${clientModulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const url = (p) => new URL(`file://${p.replace(/\\/g, '/')}`).href;
const client = await import(url(clientModulePath));
const host = await import(url(resolve(pkg, 'lib/host/model-library.js')));

const { describeModel, modelLabel, hasWarning } = client;
const { inspectModel, scanLibrary, summarizeLibrary, MOC3_ENDIANNESS: HOST_ENDIANNESS } = host;

// ── 类型判定小工具 ────────────────────────────────────────────────────
// 把 `null` 单列一类：`typeof null === 'object'` 会让「没读到」和「读到了对象」
// 看起来一样，而这两件事在这一层的意思完全不同。
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function fmtType(expected) {
  return Array.isArray(expected) ? expected.join('|') : expected;
}

function typeMatches(actual, expected) {
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

// ── 跨边界字段登记表 ──────────────────────────────────────────────────
// 每个字段右边是**客户端 TS 里声明的类型**，左边是**Host 真实发出来的类型**。
// 下面 [4] 段会真的调 Host 生产函数，逐字段比。新增字段不登记 → [3] 段变红。
const ENTRY_FIELDS = {
  id: 'string',
  path: 'string',
  name: 'string',
  ok: 'boolean',
  problems: 'array',
  moc3: ['object', 'null'],
  textures: 'object',
  motions: 'object',
  expressions: 'number',
  bytes: 'number',
  mtimeMs: 'number',
};

const MOC3_FIELDS = {
  file: 'string',
  magic: ['string', 'null'],
  version: ['number', 'null'],
  endianness: 'string',
  bytes: 'number',
};

const TEXTURE_FIELDS = { count: 'number', bytes: 'number', largestSide: ['number', 'null'] };
const MOTION_FIELDS = { groups: 'array', count: 'number' };
const PROBLEM_FIELDS = { code: 'string', message: 'string', detail: 'string', level: 'string' };

const SUMMARY_FIELDS = {
  total: 'number',
  ok: 'number',
  broken: 'number',
  truncated: 'boolean',
  durationMs: 'number',
  scannedDirs: 'number',
};

// ── 夹具 ──────────────────────────────────────────────────────────────
// 真的 PNG 头（IHDR 在偏移 16/20），这样 `imageLongSide()` 能读出边长、
// `textures.largestSide` 才会是数字而不是 null —— 否则下面那条断言等于没验。
const PNG_HEAD = (() => {
  const b = Buffer.alloc(24);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(512, 16);
  b.writeUInt32BE(1024, 20);
  return b;
})();

function makeModel(root, dir, options = {}) {
  const { version = 5, endianness = 0, moc = true, textures = ['t.png'], raw = null } = options;
  const abs = join(root, dir);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'm.model3.json'), raw ?? JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'm.moc3', Textures: textures },
  }));
  if (moc) {
    writeFileSync(join(abs, 'm.moc3'), Buffer.concat([
      Buffer.from('MOC3', 'latin1'),
      Buffer.from([version, endianness, 0, 0]),
    ]));
  }
  for (const t of textures) writeFileSync(join(abs, t), PNG_HEAD);
  return `${dir}/m.model3.json`;
}

function checkShape(prefix, obj, registry) {
  for (const [key, expected] of Object.entries(registry)) {
    const present = Object.prototype.hasOwnProperty.call(obj, key);
    const actual = present ? typeOf(obj[key]) : '（缺字段）';
    check(`${prefix}.${key} 是 ${fmtType(expected)}`, present && typeMatches(actual, expected), `实测 ${actual}`);
  }
}

/**
 * 从客户端 TS 源码里把接口的**顶层**字段名抠出来。
 *
 * 只认两空格缩进的行 —— 嵌套对象（`moc3?: { … }`）写在类型里而不是展开成多行，
 * 所以这条规则在本文件里是准的；真要展开成多行，这里会漏，而 [4] 段那条
 * 「两个方向都不许多」的断言会把漏掉的那次变成红。
 */
function interfaceKeys(source, name) {
  const marker = `export interface ${name} {`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const body = source.slice(start + marker.length);
  const end = body.indexOf('\n}');
  if (end < 0) return null;
  const keys = [];
  for (const line of body.slice(0, end).split('\n')) {
    const m = /^ {2}([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
    if (m !== null) keys.push(m[1]);
  }
  return keys;
}

const clientSource = readFileSync(clientSourcePath, 'utf8');
const hostSource = readFileSync(resolve(pkg, 'lib/host/model-library.js'), 'utf8');

console.log(`[1] 两份端序定义必须逐字一致  ${clientSourcePath.replace(here, 'tools')}`);

check(
  'Host 导出了 MOC3_ENDIANNESS',
  HOST_ENDIANNESS !== undefined && typeof HOST_ENDIANNESS === 'object',
  JSON.stringify(HOST_ENDIANNESS),
);
check(
  '客户端导出了 MOC3_ENDIANNESS（镜像）',
  client.MOC3_ENDIANNESS !== undefined && typeof client.MOC3_ENDIANNESS === 'object',
  JSON.stringify(client.MOC3_ENDIANNESS),
);
check(
  '★ 两份取值逐字一致（跨边界常量只能靠门禁对齐，不能靠共享模块）',
  JSON.stringify(HOST_ENDIANNESS) === JSON.stringify(client.MOC3_ENDIANNESS),
  `${JSON.stringify(HOST_ENDIANNESS)} vs ${JSON.stringify(client.MOC3_ENDIANNESS)}`,
);
check(
  '三个取值互不相同且都是非空字符串',
  new Set(Object.values(HOST_ENDIANNESS)).size === 3
    && Object.values(HOST_ENDIANNESS).every((v) => typeof v === 'string' && v !== ''),
);
check(
  '★ Host 在边界上把它翻成字符串（不是原样散出裸字节）',
  /entry\.moc3\s*=\s*\{[^}]*endianness:\s*endiannessName\(/.test(hostSource),
);
check(
  '★ 客户端比的是具名常量，不是裸字面量',
  /MOC3_ENDIANNESS\.BIG/.test(clientSource),
  /endianness === 'big'/.test(clientSource) ? '源码里还留着裸字面量' : '',
);
check(
  'Host 的 warn 文案仍然报原始字节（翻成字符串不等于把诊断信息弄丢）',
  /moc3 声明端序字节为 \$\{info\.endianness\}/.test(hostSource),
);

// ── [2] / [3] 真的跑一遍 ──────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'wire-types-'));
try {
  const littleRel = makeModel(root, 'little_model', { endianness: 0 });
  const bigRel = makeModel(root, 'big_model', { endianness: 1 });
  const brokenRel = makeModel(root, 'broken_model', { moc: false });
  const badJsonRel = makeModel(root, 'bad_json_model', { raw: '{ not json' });

  const little = inspectModel(root, littleRel, { force: true });
  const big = inspectModel(root, bigRel, { force: true });
  const broken = inspectModel(root, brokenRel, { force: true });
  const badJson = inspectModel(root, badJsonRel, { force: true });

  section('[2] 真实产出：端序字段在线缆上是字符串');
  check('小端模型 endianness === "little"', little.moc3?.endianness === 'little', JSON.stringify(little.moc3));
  check('★ 大端模型 endianness === "big"（改前这里是数字 1）', big.moc3?.endianness === 'big', JSON.stringify(big.moc3));
  check('★ typeof 是 string，不是 number', typeof big.moc3?.endianness === 'string', typeOf(big.moc3?.endianness));
  check('moc3 文件缺失时 moc3 是 null（不是半个对象）', broken.moc3 === null, JSON.stringify(broken.moc3));
  check('模型定义不是 JSON 时 moc3 也是 null', badJson.moc3 === null, JSON.stringify(badJson.moc3));

  section('[3] 症状级：客户端拿到真实产出后，用户能看见什么');
  const bigText = describeModel(big);
  check('★ 大端模型简介里真的出现「大端」（这就是那个恒假分支）', bigText.includes('大端'), JSON.stringify(bigText));
  check('小端模型的简介里没有「大端」', !describeModel(little).includes('大端'), JSON.stringify(describeModel(little)));
  check(
    'unknown 不冒充大端（宁可不说，也不说错）',
    !describeModel({ ...big, moc3: { ...big.moc3, endianness: 'unknown' } }).includes('大端'),
  );
  check('大端仍然只是 warn：模型可用，只是提示', big.ok === true && hasWarning(big) === true);
  check('大端模型的标签带「!」而不是「✕」', modelLabel(big).startsWith('!'), JSON.stringify(modelLabel(big)));
  check(
    'warn 文案里仍然带着原始字节 1',
    (big.problems ?? []).some((p) => p.code === 'E_MOC3_INVALID' && p.message.includes('1')),
    JSON.stringify((big.problems ?? []).map((p) => p.message)),
  );

  section('[4] 跨边界字段类型：客户端声明的每一个，Host 真的这么发吗');
  for (const [label, entry] of [['小端', little], ['大端', big], ['缺 moc3', broken], ['坏 JSON', badJson]]) {
    checkShape(`[${label}] entry`, entry, ENTRY_FIELDS);
  }
  checkShape('[小端] entry.moc3', little.moc3, MOC3_FIELDS);
  checkShape('[小端] entry.textures', little.textures, TEXTURE_FIELDS);
  checkShape('[小端] entry.motions', little.motions, MOTION_FIELDS);
  checkShape('[坏 JSON] entry.problems[0]', badJson.problems[0], PROBLEM_FIELDS);
  check(
    'textures.largestSide 真的是数字（夹具 PNG 头合法，否则上面那条等于没验）',
    typeof little.textures.largestSide === 'number' && little.textures.largestSide === 1024,
    String(little.textures.largestSide),
  );

  section('[5] 摘要：Host 的 summarizeLibrary 产出');
  const scan = scanLibrary(root);
  const summary = summarizeLibrary(scan);
  checkShape('summary', summary, SUMMARY_FIELDS);
  check('summary.total 与 models 长度自洽', summary.total === scan.models.length, `${summary.total} vs ${scan.models.length}`);
  const littleCount = scan.models.filter((m) => m.moc3?.endianness === 'little').length;
  const bigCount = scan.models.filter((m) => m.moc3?.endianness === 'big').length;
  const nullCount = scan.models.filter((m) => m.moc3 === null).length;
  check(
    '★ scan 这条路上端序也是字符串：4 个夹具 = 1 小端 + 1 大端 + 2 个读不到 moc3',
    scan.models.length === 4 && littleCount === 1 && bigCount === 1 && nullCount === 2,
    `小端 ${littleCount} / 大端 ${bigCount} / null ${nullCount}`,
  );
  check(
    'summary 的计数与夹具相符（2 个可用、2 个有 error）',
    summary.total === 4 && summary.ok === 2 && summary.broken === 2,
    `total=${summary.total} ok=${summary.ok} broken=${summary.broken}`,
  );

  section('[6] 登记表 vs 客户端声明：两个方向都不许多');
  const declaredEntry = interfaceKeys(clientSource, 'ModelEntry');
  const declaredSummary = interfaceKeys(clientSource, 'LibrarySummary');
  check('读到了 ModelEntry 的字段表', Array.isArray(declaredEntry) && declaredEntry.length > 0, JSON.stringify(declaredEntry));
  check('读到了 LibrarySummary 的字段表', Array.isArray(declaredSummary) && declaredSummary.length > 0, JSON.stringify(declaredSummary));

  for (const [name, declared, registry] of [
    ['ModelEntry', declaredEntry ?? [], ENTRY_FIELDS],
    ['LibrarySummary', declaredSummary ?? [], SUMMARY_FIELDS],
  ]) {
    const unregistered = declared.filter((k) => !Object.prototype.hasOwnProperty.call(registry, k));
    const stale = Object.keys(registry).filter((k) => !declared.includes(k));
    check(
      `★ ${name} 新声明的字段都登记在册（不登记就红 —— 这才能拦住下一个 endianness）`,
      unregistered.length === 0,
      unregistered.join(', '),
    );
    check(`${name} 登记表里没有客户端已删掉的字段`, stale.length === 0, stale.join(', '));
  }

  section('[7] 反证：把改前的形状放回来，症状必须消失');
  const legacyEntry = { ...big, moc3: { ...big.moc3, endianness: 1 } };
  check(
    '★ 退化：Host 发裸字节 1 → 「大端」标签不出现（这正是改前的 bug）',
    !describeModel(legacyEntry).includes('大端'),
    JSON.stringify(describeModel(legacyEntry)),
  );
  check(
    '退化：两份常量值只要差一个字，[1] 段就会红',
    JSON.stringify({ ...HOST_ENDIANNESS, BIG: 'big-endian' }) !== JSON.stringify(client.MOC3_ENDIANNESS),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('');
if (failed > 0) {
  console.error(`[16] WIRE TYPES GATE FAILED —— ${failed} 项红 / ${passed} 项绿`);
  process.exit(1);
}
console.log(`[16] WIRE TYPES GATE PASSED —— ${passed} 项断言全绿`);
