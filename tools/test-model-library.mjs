/**
 * test-model-library.mjs — 门禁：模型库体检器能不能准确说出「这个包为什么不能用」。
 *
 * 用法:
 *   node tools/test-model-library.mjs
 *
 * 为什么需要它:
 *   `lib/host/model-library.js` 是整个 P1「坏包给出精确错误」的唯一实现。
 *   它最大的风险不是崩溃（它被写成永不抛异常），而是**报错报得不对**：
 *   把一个好包说成坏的、把坏包说成好的、或者给出的错误码指错方向。
 *   这三件事都不会让程序崩，只会让人白忙一天 —— 所以必须靠断言钉住。
 *
 * 样本从哪来:
 *   1. **官方 SDK 样本**（`work/sdk5/.../Samples/Resources`，8 个模型，moc3 v1/3/5/6）
 *      —— 只读，绝不复制进用户的模型库。它们提供「真实的好包」这一侧。
 *      这 8 个还是天然的版本边界样本：Ren 是 v6，正好卡在 Core 6.0.1 的上限。
 *   2. **合成坏包**（临时目录）—— 提供「真实的坏包」这一侧。坏包必须自己造，
 *      因为网上拿不到「缺一张纹理」的模型，而那正是用户最常见的事故。
 *
 * 一条重要的反向验证:
 *   [6] 段故意让好包指向一个不存在的位置，断言体检**会**报错。
 *   否则「所有包都 ok」这种恒真的门禁看起来永远全绿，实际什么也没验。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  MAX_MOC3_VERSION,
  clearLibraryCache,
  inspectModel,
  libraryCacheStats,
  scanLibrary,
} from '../dsh-live2d-pet/lib/host/model-library.js';
import {
  MAX_LOOSE_EXPRESSIONS,
  mergeLooseIntoSetting,
} from '../dsh-live2d-pet/lib/host/loose-files.js';
import {
  mergeSettingBytes,
  mergeVtsIntoSetting,
  parseVtsProfile,
  readVtsProfileFor,
} from '../dsh-live2d-pet/lib/host/vts-profile.js';
import { createCore, waitForCore } from './gate-model.mjs';

const WORKSPACE = resolve(import.meta.dirname, '..');
const SDK_SAMPLES = join(WORKSPACE, 'work', 'sdk5', 'CubismSdkForWeb-5-r.5', 'Samples', 'Resources');
const USER_LIBRARY = join(WORKSPACE, 'models-inbox');
const CORE_PATH = join(WORKSPACE, 'dsh-live2d-pet', 'vendor', 'cubism', 'live2dcubismcore.min.js');

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`);
  }
};

/*
 * 给一个目录拍指纹，用来回答一个问题：**这次运行碰过用户的东西没有？**
 *
 * 每个文件记 `size` + `mtimeMs`（任何一次写入都会让它们变），
 * 小文件再把内容一起算成 sha256（配置类文件都很小，这一步几乎免费，
 * 但把「改了内容却没改大小」也堵死了）。大纹理只靠 size+mtime ——
 * 用户库里的纹理加起来上百 MB，每次门禁都哈希一遍太慢，
 * 而「写坏一张 26MB 的 PNG 但大小和 mtime 都没变」不是现实里的失败形态。
 */
const LIBRARY_HASH_MAX_BYTES = 256 * 1024;
function snapshotLibrary() {
  const entries = [];
  const walk = (dir, rel) => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const childRel = rel === '' ? item.name : `${rel}/${item.name}`;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        walk(full, childRel);
        continue;
      }
      if (!item.isFile()) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      let hash = '';
      if (stat.size <= LIBRARY_HASH_MAX_BYTES) {
        try {
          hash = createHash('sha256').update(readFileSync(full)).digest('hex');
        } catch {
          hash = '';
        }
      }
      entries.push({ rel: childRel, size: stat.size, mtimeMs: stat.mtimeMs, hash });
    }
  };
  walk(USER_LIBRARY, '');
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}

/** 比两张指纹，返回人能读的差异列表（空数组 = 一个字节都没动）。 */
function diffLibrary(before, after) {
  const changes = [];
  const beforeMap = new Map(before.map((e) => [e.rel, e]));
  const afterMap = new Map(after.map((e) => [e.rel, e]));
  for (const [rel, e] of beforeMap) {
    const now = afterMap.get(rel);
    if (now === undefined) {
      changes.push(`被删除：${rel}`);
      continue;
    }
    if (now.size !== e.size) changes.push(`大小变了：${rel}  ${e.size} → ${now.size} B`);
    else if (now.hash !== '' && e.hash !== '' && now.hash !== e.hash) changes.push(`内容变了（大小相同）：${rel}`);
    else if (now.mtimeMs !== e.mtimeMs) changes.push(`被重新写入（内容相同）：${rel}`);
  }
  for (const rel of afterMap.keys()) {
    if (!beforeMap.has(rel)) changes.push(`被新增：${rel}`);
  }
  return changes;
}

console.log('[1] 体检器自身的基本契约');

// 体检器**永不抛异常**是它的核心承诺：调用方要的是一张清单，
// 不是一个「第一个坏包就炸掉整张清单」。所以先钉住这条。
{
  const nowhere = join(tmpdir(), 'dsh-live2d-does-not-exist-' + Date.now());
  let threw = null;
  let result = null;
  try {
    result = scanLibrary(nowhere);
  } catch (error) {
    threw = error;
  }
  check('扫描不存在的根目录不抛异常', threw === null, String(threw?.message ?? ''));
  check('不存在的根目录 → rootExists=false', result?.rootExists === false);
  check('不存在的根目录 → 空清单', Array.isArray(result?.models) && result.models.length === 0);
}

{
  let threw = null;
  let entry = null;
  try {
    entry = inspectModel(USER_LIBRARY, '根本没有这个文件.model3.json');
  } catch (error) {
    threw = error;
  }
  check('体检不存在的模型不抛异常', threw === null, String(threw?.message ?? ''));
  check('体检不存在的模型 → ok=false', entry?.ok === false);
  check(
    '体检不存在的模型 → E_MODEL_FILE_MISSING',
    entry?.problems?.[0]?.code === 'E_MODEL_FILE_MISSING',
    JSON.stringify(entry?.problems),
  );
  check(
    '返回值形状恒定（坏包也有全部字段）',
    entry !== null
      && typeof entry.name === 'string'
      && typeof entry.textures === 'object'
      && typeof entry.motions === 'object'
      && Array.isArray(entry.problems),
  );
}

console.log('\n[2] 真实样本：官方 SDK 的 8 个模型（只读，不复制）');
if (!existsSync(SDK_SAMPLES)) {
  console.log(`  [skip] 找不到 SDK 样本目录：${SDK_SAMPLES}`);
} else {
  clearLibraryCache();
  const scan = scanLibrary(SDK_SAMPLES);
  const names = scan.models.map((m) => m.name).sort();
  console.log(`  扫描到 ${scan.models.length} 个模型，耗时 ${scan.durationMs}ms，目录 ${scan.scannedDirs} 个`);
  console.log(`  名称：${names.join(', ')}`);

  check('扫到 8 个官方样本', scan.models.length === 8, `实际 ${scan.models.length}`);
  check('没有模型被截断', scan.truncated === false);

  // 这一条是「体检器会不会误判」的核心：官方样本必须全部判为好包。
  const broken = scan.models.filter((m) => !m.ok);
  check(
    '8 个官方样本全部判定为可加载',
    broken.length === 0,
    broken.map((m) => `${m.name}: ${m.problems.map((p) => p.code).join('/')}`).join('; '),
  );

  // 版本覆盖：这 8 个样本的价值就在于此 —— 它们是真实的跨版本样本。
  const versions = scan.models.map((m) => m.moc3?.version).filter((v) => typeof v === 'number');
  const unique = [...new Set(versions)].sort((a, b) => a - b);
  console.log(`  moc3 版本分布：${JSON.stringify(versions)} 去重后 ${JSON.stringify(unique)}`);
  check('版本覆盖 v1', unique.includes(1));
  check('版本覆盖 v3', unique.includes(3));
  check('版本覆盖 v5', unique.includes(5));
  check('版本覆盖 v6（Core 上限的边界样本）', unique.includes(6));
  check('所有样本都被识别出 MOC3 魔数', scan.models.every((m) => m.moc3?.magic === 'MOC3'));
  check('所有样本端序都是小端', scan.models.every((m) => m.moc3?.endianness === 'little'));

  // 元数据准确性：拿 Haru 一个人工核对，避免「字段填了但填错了」。
  const haru = scan.models.find((m) => m.name === 'Haru');
  console.log(`  Haru: 纹理=${haru?.textures.count} 表情=${haru?.expressions} 动作=${haru?.motions.count} 组=${JSON.stringify(haru?.motions.groups)}`);
  check('Haru 纹理数 = 2', haru?.textures.count === 2, String(haru?.textures.count));
  check('Haru 动作组含 Idle 与 TapBody', haru?.motions.groups.includes('Idle') && haru?.motions.groups.includes('TapBody'));
  check('Haru 读到了纹理边长', typeof haru?.textures.largestSide === 'number' && haru.textures.largestSide > 0, String(haru?.textures.largestSide));
  check('Haru 有物理文件', haru?.hasPhysics === true);
  check('Haru 统计了字节数', typeof haru?.bytes === 'number' && haru.bytes > 1000);
}

console.log('\n[3] 真实样本：用户自己的模型库');
/*
 * ★ 读之前先拍一张指纹，跑完在 [9] 段核对。
 *
 * 为什么需要这个：2026-10-16 我给这个文件加反证时，在 `model-library.js` 里
 * 插了一行 `if (merged.changed) writeFileSync(absolute, JSON.stringify(...))`
 * —— 本意是「把合并结果落盘，好让『合并只在内存里』那条断言变红」。
 * 结果它**忠实地写进了用户两个真实的 `model3.json`**（这一段扫的就是真库），
 * 恰好是这套功能专门承诺不会做的事。两个文件从 541/514 B 变成 840/479 B。
 *
 * 事后能逐字节还原是运气：坏掉之前的目录列表恰好记下了原始字节数，
 * 而合并只是「往 FileReferences 里添两个键」，删掉就回到原对象。
 * 下一次不一定有这种运气 —— 所以把「谁碰了用户的东西」变成一个**断言**，
 * 而不是依赖我记得去看。
 */
const libraryBefore = snapshotLibrary();
if (!existsSync(USER_LIBRARY)) {
  console.log(`  [skip] 找不到模型库：${USER_LIBRARY}`);
} else {
  clearLibraryCache();
  const scan = scanLibrary(USER_LIBRARY);
  console.log(`  扫描到 ${scan.models.length} 个模型`);
  for (const m of scan.models) {
    console.log(`    ${m.ok ? '✓' : '✗'} ${m.name}  moc3=v${m.moc3?.version}  纹理=${m.textures.count}  最大边=${m.textures.largestSide}  ${Math.round(m.bytes / 1024 / 1024)}MB`);
    for (const p of m.problems) console.log(`        [${p.level}] ${p.code}: ${p.message} — ${p.detail}`);
  }

  // 用户库里有几个模型是**用户自己决定**的，断言具体数量会在用户放模型时变红。
  // 所以这里只断言「扫描本身是正确的」，不断言内容 —— 门禁不该因为用户
  // 往自己的模型库里加了个模型就失败。
  check('扫描成功返回数组', Array.isArray(scan.models));
  check('每个条目都有 id/path/name', scan.models.every((m) => m.id && m.path && m.name));
  check('每个条目的 path 用正斜杠（URL 语义）', scan.models.every((m) => !m.path.includes('\\')));

  if (scan.models.length > 0) {
    const first = scan.models[0];
    check('至少有一个模型可加载', scan.models.some((m) => m.ok), '库里全是坏包');
    check('模型条目带 moc3 版本', typeof first.moc3?.version === 'number');
    check('moc3 版本不超过 Core 上限', first.moc3.version <= MAX_MOC3_VERSION);
  }
}

console.log('\n[4] 合成坏包：每一种都要报出**精确**的错误码');
{
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-live2d-badpkgs-'));
  try {
    /** 造一个最小可用模型包；`mutate` 用来把它改坏。返回模型相对路径。 */
    const makePackage = (folder, mutate) => {
      const dir = join(sandbox, folder);
      mkdirSync(join(dir, 'tex'), { recursive: true });

      // 一个最小的合法 PNG（1x1），只为让「文件存在」这条成立。
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001'
        + '0d0a2db40000000049454e44ae426082',
        'hex',
      );
      writeFileSync(join(dir, 'tex', 't0.png'), png);

      // 一个最小 moc3：8 字节头 + 一点填充，体检只读文件头。
      const moc = Buffer.alloc(32);
      moc.write('MOC3', 0, 'latin1');
      moc[4] = 5; // 版本
      moc[5] = 0; // 端序：小端
      writeFileSync(join(dir, 'm.moc3'), moc);

      const model = {
        Version: 3,
        FileReferences: {
          Moc: 'm.moc3',
          Textures: ['tex/t0.png'],
          Motions: { Idle: [{ File: 'idle.motion3.json' }] },
        },
      };
      writeFileSync(join(dir, 'idle.motion3.json'), JSON.stringify({ Version: 3, Curves: [] }));

      if (mutate) mutate({ dir, model, mocPath: join(dir, 'm.moc3') });

      writeFileSync(join(dir, 'a.model3.json'), JSON.stringify(model));
      return `${folder}/a.model3.json`;
    };

    /** 断言某个包体检出指定的错误码，并返回条目供进一步检查。 */
    const expectCode = (label, rel, code, level = 'error') => {
      const entry = inspectModel(sandbox, rel, { force: true });
      const hit = entry.problems.find((p) => p.code === code && p.level === level);
      check(label, hit !== undefined, `期望 ${code}/${level}，实际 ${JSON.stringify(entry.problems.map((p) => `${p.code}/${p.level}`))}`);
      if (hit) console.log(`      → ${hit.message} — ${hit.detail}`);
      return entry;
    };

    // 先证明「好的合成包会被判为好」—— 否则下面每一条都可能是因为合成包本身就不合法。
    const goodRel = makePackage('good', null);
    const good = inspectModel(sandbox, goodRel, { force: true });
    check('对照：合成的健康包判定为可加载', good.ok === true, JSON.stringify(good.problems));
    check('对照：正确读出 moc3 版本 = 5', good.moc3?.version === 5, String(good.moc3?.version));

    // ① 缺纹理 —— 用户最常遇到的事故（解压时漏了子文件夹）。
    expectCode('缺纹理 → E_MODEL_FILE_MISSING', makePackage('no-tex', ({ dir }) => {
      rmSync(join(dir, 'tex', 't0.png'));
    }), 'E_MODEL_FILE_MISSING');

    // ② JSON 语法错误 —— 必须带上 JSON.parse 的原始报错（它带字符偏移）。
    {
      const rel = makePackage('bad-json', null);
      const p = join(sandbox, rel);
      // 用「截断」而不是「替换某个子串」来造错：截断是真实世界里最常见的
      // 坏 JSON（下载中断、解压没完成），而且不依赖 JSON.stringify 的具体排版
      // —— 最初写成 replace('"Version": 3', …) 时，stringify 输出的其实是
      // `"Version":3`（没有空格），于是替换没有发生、文件仍然合法，
      // 测试静默地变成了「验证一个好包是好的」。
      const text = readFileSync(p, 'utf8');
      writeFileSync(p, text.slice(0, Math.max(1, text.length - 3)));
      const entry = expectCode('坏 JSON → E_MODEL_JSON_INVALID', rel, 'E_MODEL_JSON_INVALID');
      const detail = entry.problems[0]?.detail ?? '';
      check('坏 JSON 的 detail 带上了原始解析报错', /JSON|position|Unexpected/i.test(detail), detail);
    }

    // ③ moc3 版本过高 —— 这条如果漏了，症状就是「选一下就白屏」。
    expectCode('moc3 v99 → E_MOC3_VERSION_UNSUPPORTED', makePackage('moc-future', ({ mocPath }) => {
      const buf = readFileSync(mocPath);
      buf[4] = 99;
      writeFileSync(mocPath, buf);
    }), 'E_MOC3_VERSION_UNSUPPORTED');

    // ④ moc3 魔数不对 —— 下错文件（比如把纹理改名成 moc3）的典型症状。
    expectCode('魔数错误 → E_MOC3_INVALID', makePackage('moc-magic', ({ mocPath }) => {
      const buf = readFileSync(mocPath);
      buf.write('NOPE', 0, 'latin1');
      writeFileSync(mocPath, buf);
    }), 'E_MOC3_INVALID');

    // ⑤ 缺 moc3 —— 模型完全没法加载。
    expectCode('缺 moc3 → E_MODEL_FILE_MISSING', makePackage('no-moc', ({ dir }) => {
      rmSync(join(dir, 'm.moc3'));
    }), 'E_MODEL_FILE_MISSING');

    // ⑥ 缺 FileReferences —— 结构不对，不是「文件缺失」。
    expectCode('缺 FileReferences → E_MODEL_JSON_INVALID', makePackage('no-refs', ({ model }) => {
      delete model.FileReferences;
    }), 'E_MODEL_JSON_INVALID');

    // ⑦ 纹理数组为空。
    expectCode('纹理数组为空 → E_MODEL_JSON_INVALID', makePackage('no-textures', ({ model }) => {
      model.FileReferences.Textures = [];
    }), 'E_MODEL_JSON_INVALID');

    // ⑧ 缺动作文件 —— 这是 error 级（动作加载会失败）。
    expectCode('缺动作文件 → E_MODEL_FILE_MISSING', makePackage('no-motion', ({ dir }) => {
      rmSync(join(dir, 'idle.motion3.json'));
    }), 'E_MODEL_FILE_MISSING');

    // ⑨ 缺动作音频 —— 刻意是 **warn** 级：只影响这一个动作的观感，
    //    模型本身照常可用。把 warn 当 error 会让用户以为整个模型废了。
    {
      const rel = makePackage('no-audio', ({ model }) => {
        model.FileReferences.Motions.Idle[0].Sound = 'idle.wav';
      });
      const entry = expectCode('缺动作音频 → E_MOTION_AUDIO_MISSING（warn）', rel, 'E_MOTION_AUDIO_MISSING', 'warn');
      check('缺动作音频**不**让模型变成不可加载', entry.ok === true, JSON.stringify(entry.problems));
    }

    // ⑩ 路径穿越 —— 安全边界。`.model3.json` 是用户从网上下载的文件，
    //    里面的路径可以是任意字符串；体检只做存在性判断，但「这个路径存在吗」
    //    本身就是一个文件系统探测原语，必须掐掉。
    {
      const rel = makePackage('escape', ({ model }) => {
        model.FileReferences.Moc = '../../../Windows/win.ini';
      });
      const entry = expectCode('moc 路径穿越 → E_MODEL_PATH_ESCAPE', rel, 'E_MODEL_PATH_ESCAPE');
      check('路径穿越的模型判定为不可加载', entry.ok === false);
    }
    {
      const rel = makePackage('escape-tex', ({ model }) => {
        model.FileReferences.Textures = ['../../../../etc/hosts'];
      });
      expectCode('纹理路径穿越 → E_MODEL_PATH_ESCAPE', rel, 'E_MODEL_PATH_ESCAPE');
    }

    console.log('\n[5] 缓存：必须命中，且改了文件必须失效');
    {
      clearLibraryCache();
      const rel = makePackage('cached', null);
      inspectModel(sandbox, rel, { force: true });
      const before = libraryCacheStats();
      inspectModel(sandbox, rel);
      const afterHit = libraryCacheStats();
      check('第二次体检命中缓存', afterHit.hits === before.hits + 1, JSON.stringify({ before, afterHit }));

      // 改 moc3 的版本号：缓存必须失效，否则用户换了个包界面还报旧结论。
      // 注意等一小会儿 —— mtime 的分辨率有限，同一毫秒内的两次写入可能无法区分，
      // 那会让这条断言变成一个偶发失败的测试。
      const mocPath = join(sandbox, 'cached', 'm.moc3');
      await new Promise((r) => setTimeout(r, 20));
      const buf = readFileSync(mocPath);
      buf[4] = 99;
      writeFileSync(mocPath, buf);

      const after = inspectModel(sandbox, rel);
      check('改了 moc3 之后缓存失效（报出 v99）', after.moc3?.version === 99, String(after.moc3?.version));
      check('缓存失效后报出 E_MOC3_VERSION_UNSUPPORTED', after.problems.some((p) => p.code === 'E_MOC3_VERSION_UNSUPPORTED'));

      // `force` 的语义是「连查都不查」，不是「查了但不用」——所以正确的断言是
      // hits **不增**（没走缓存路径）而 misses **增**（确实重新体检了）。
      // 最初写成 `hits === afterHit.hits + 1` 是我把 force 当成了「强制未命中」，
      // 而实现里它直接跳过了 lookup，根本不会记一次 hit。
      const beforeForce = libraryCacheStats();
      inspectModel(sandbox, rel, { force: true });
      const afterForce = libraryCacheStats();
      check('force=true 不查缓存（hits 不增）', afterForce.hits === beforeForce.hits, JSON.stringify(afterForce));
      check('force=true 仍然重新体检（misses 增）', afterForce.misses === beforeForce.misses + 1, JSON.stringify(afterForce));
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log('\n[5b] 散着但没登记的动作 / 表情（自动认领，不只是告警）');
{
  /*
   * 这一段的由来：用户往模型库里放了一个 VTube Studio 转换版的模型，
   * 问「有没有表情和动作」。体检报告说「动作组 0 个、表情 0 个」—— 没错，
   * 但目录里明明躺着 10 个 `.motion3.json` 和 8 个 `.exp3.json`。
   * 转换器把**文件**留下了、把 `FileReferences` 里的**登记表**丢掉了，
   * 而任何标准 Cubism 运行时都只看登记表。两边都没说谎，用户却没有任何线索。
   *
   * ★ 规格改过一次，两段都要留着读：
   *   · 第一版只**告警**（「目录里有 8 个表情文件没能自动接上」），理由是「怕猜错」。
   *   · 现在是**认领**：把这些文件并进交给客户端的合成 `model3.json` 里。
   *
   *   改的理由是用户的原话 ——「有关表情和动作的功能，现在能否做到导入模型之后
   *   就自动加载好呢？」。他要的是**能点的表情和动作**，不是一份体检报告；
   *   告警只把症状说清楚了，一个都没解决。猜错的风险由三条护栏兜住：
   *   重名不覆盖、路径不安全不接、超出预算就截断（下面 ⑥～⑨ 逐条钉住）。
   *
   * 实测：官方 SDK 的 8 个样本一个都不认领（它们的登记是全的），
   * 用户库里 hiyori 认领到 10 个动作、akari 认领到 4 表情 + 3 动作 ——
   * 信号与噪声分得很开，这正是敢自动认领的依据。
   */
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-live2d-unref-'));
  try {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001'
      + '0d0a2db40000000049454e44ae426082',
      'hex',
    );
    const moc = Buffer.alloc(32);
    moc.write('MOC3', 0, 'latin1');
    moc[4] = 5;
    moc[5] = 0;
    const emptyMotion = JSON.stringify({ Version: 3, Curves: [] });
    const emptyExpression = JSON.stringify({ Version: 3, Type: 'Live2D Expression', Parameters: [] });

    /** 造一个包。`model` 为 null 时用一个「什么都不登记」的定义。 */
    const make = (folder, model) => {
      const dir = join(sandbox, folder);
      mkdirSync(join(dir, 'tex'), { recursive: true });
      mkdirSync(join(dir, 'animations'), { recursive: true });
      writeFileSync(join(dir, 'tex', 't0.png'), png);
      writeFileSync(join(dir, 'm.moc3'), moc);
      writeFileSync(join(dir, 'animations', 'a.motion3.json'), emptyMotion);
      writeFileSync(join(dir, 'animations', 'b.motion3.json'), emptyMotion);
      writeFileSync(join(dir, 'e1.exp3.json'), emptyExpression);
      writeFileSync(join(dir, 'a.model3.json'), JSON.stringify(model ?? {
        Version: 3,
        FileReferences: { Moc: 'm.moc3', Textures: ['tex/t0.png'] },
      }));
      return `${folder}/a.model3.json`;
    };

    const codes = (entry) => entry.problems.map((p) => `${p.code}/${p.level}`);

    // ① 一个都没登记：**不是告警，是认领**。能力数字必须真的涨上去，
    //    同时报告里要说清「这几个能力是从目录里的文件名认出来的」——
    //    因为用户拿着这份合成结果去别的播放器看会发现「怎么没有表情」。
    const bare = inspectModel(sandbox, make('bare', null), { force: true });
    const bareMerged = bare.problems.find((p) => p.code === 'E_LOOSE_FILES_MERGED');
    check('未登记的动作被认领（2 个）', bareMerged?.message.includes('2 个动作') === true, bareMerged?.message ?? JSON.stringify(codes(bare)));
    check('未登记的表情被认领（1 个）', bareMerged?.message.includes('1 个表情') === true, bareMerged?.message ?? JSON.stringify(codes(bare)));
    check('认领这条是 warn（模型能用，只是能力来路不同）', bareMerged?.level === 'warn', String(bareMerged?.level));
    check('warn 不影响 ok（模型仍然可加载）', bare.ok === true, JSON.stringify(codes(bare)));
    check('★ 认领是真生效：能力数字涨上去了（1 个表情、2 个动作）',
      bare.expressions === 1 && bare.motions.count === 2,
      `表情=${bare.expressions} 动作=${bare.motions.count}`);
    check('★ 动作组按文件名推出来了（不许全塞进一个 Motion 组）',
      Array.isArray(bare.looseFiles?.addedGroups) && bare.looseFiles.addedGroups.includes('a') && bare.looseFiles.addedGroups.includes('b'),
      JSON.stringify(bare.looseFiles));
    check('★ looseFiles 逐条记下了认领的路径（面板要能展开看是哪几个）',
      bare.looseFiles?.addedMotions?.includes('animations/a.motion3.json') === true
      && bare.looseFiles?.addedExpressions?.includes('e1.exp3.json') === true,
      JSON.stringify(bare.looseFiles));
    check('detail 里给出了出路（抄进 model3.json 就通用了）',
      bareMerged?.detail.includes('FileReferences') === true, bareMerged?.detail ?? '');
    check('★ detail 只说清来路，不倒文件清单（那是 looseFiles 的活）',
      bareMerged?.detail.includes('a.motion3.json') === false, bareMerged?.detail ?? '');

    // ② 登记了就消失 —— 而且要能容忍 `./` 前缀与反斜杠这两种写法，
    //    否则「明明登记了还报未登记」会变成一个更烦人的 bug。
    const bound = inspectModel(sandbox, make('bound', {
      Version: 3,
      FileReferences: {
        Moc: 'm.moc3',
        Textures: ['tex/t0.png'],
        Motions: {
          Idle: [
            { File: 'animations/a.motion3.json' },
            { File: './animations\\b.motion3.json' },
          ],
        },
        Expressions: [{ Name: 'E1', File: '.\\e1.exp3.json' }],
      },
    }), { force: true });
    check('登记后动作不再被认领（没有可认领的了）',
      bound.problems.every((p) => p.code !== 'E_LOOSE_FILES_MERGED' && p.code !== 'E_LOOSE_FILES_REJECTED'), JSON.stringify(codes(bound)));
    check('登记后表情不再被认领', bound.problems.every((p) => p.code !== 'E_LOOSE_FILES_REJECTED'), JSON.stringify(codes(bound)));
    check('登记后 motions.count 数的是登记表（2 个）', bound.motions.count === 2, String(bound.motions.count));
    check('登记后 expressions 数的是登记表（1 个）', bound.expressions === 1, String(bound.expressions));
    check('★ 没有可认领的东西时不报「认领了 0 个」（一句话都不说）',
      bound.looseFiles === null, JSON.stringify(bound.looseFiles));

    // ③ ★ 最关键的一条：**新增一个文件之后，不加 force 也必须看得见**。
    //    不加这条的话，「用户刚补了一个动作文件」会永远读到旧结论 ——
    //    这正是 `inspectionCache` 注释里那条「界面言之凿凿地说旧结论」。
    //    判据取认领数（2 → 3），不取告警文案：文案会改，数字不会。
    {
      const rel = make('grow', null);
      clearLibraryCache();
      const first = inspectModel(sandbox, rel); // 不加 force，先让它进缓存
      writeFileSync(join(sandbox, 'grow', 'animations', 'c.motion3.json'), emptyMotion);
      const second = inspectModel(sandbox, rel); // 仍然不加 force
      check('新增动作文件后缓存自己失效（不加 force 也要认领到第 3 个）',
        first.motions.count === 2 && second.motions.count === 3,
        `认领数 ${first.motions.count} → ${second.motions.count}`);
    }

    // ④ 子目录里装着另一个模型时，那个目录整个不算数 —— 否则会有假警报。
    {
      const dir = join(sandbox, 'nest');
      mkdirSync(join(dir, 'other'), { recursive: true });
      mkdirSync(join(dir, 'tex'), { recursive: true });
      writeFileSync(join(dir, 'tex', 't0.png'), png);
      writeFileSync(join(dir, 'm.moc3'), moc);
      writeFileSync(join(dir, 'a.model3.json'), JSON.stringify({
        Version: 3,
        FileReferences: { Moc: 'm.moc3', Textures: ['tex/t0.png'] },
      }));
      // 隔壁那个模型自己的动作 —— 不该算到 a 头上
      writeFileSync(join(dir, 'other', 'b.model3.json'), '{"Version":3}');
      writeFileSync(join(dir, 'other', 'x.motion3.json'), emptyMotion);
      const nested = inspectModel(sandbox, 'nest/a.model3.json', { force: true });
      check('装着另一个模型的子目录整个跳过（不报假警报）',
        nested.problems.every((p) => p.code !== 'E_LOOSE_FILES_MERGED' && p.code !== 'E_LOOSE_FILES_REJECTED'), JSON.stringify(codes(nested)));
      check('★ 隔壁那套动作也没被算到 a 头上（认领数仍是 0）',
        nested.motions.count === 0, String(nested.motions.count));
    }

    // ⑤ 包本身是坏的时候不再往上堆 warn：连 moc3 都缺，用户该看的是那一条。
    {
      const broken = inspectModel(sandbox, make('broken', {
        Version: 3,
        FileReferences: { Moc: 'missing.moc3', Textures: ['tex/t0.png'] },
      }), { force: true });
      check('坏包不再堆「认领」的 warn',
        broken.problems.every((p) => p.code !== 'E_LOOSE_FILES_MERGED' && p.code !== 'E_LOOSE_FILES_REJECTED'),
        JSON.stringify(codes(broken)));
      check('坏包仍然报出真正的原因', broken.problems.some((p) => p.code === 'E_MODEL_FILE_MISSING' && p.level === 'error'));
    }

    /*
     * ⑥⑦ 名字这一侧的两条护栏。
     *
     * 自动认领最大的风险是「猜错」，而猜错的后果**不是报错** ——
     * 是用户点了那个表情、出来的是另一张（重名），或者模型直接打不开（坏路径）。
     * 所以不能只有「认领成功」那一条断言，每一条护栏都要有。
     */
    {
      const dir = join(sandbox, 'naming');
      mkdirSync(join(dir, 'expressions', 'official'), { recursive: true });
      mkdirSync(join(dir, 'tex'), { recursive: true });
      writeFileSync(join(dir, 'tex', 't0.png'), png);
      writeFileSync(join(dir, 'm.moc3'), moc);
      // 与登记表里那个 E1 **同名但不同路径** —— 躲得过「已登记」那一判，
      // 只能靠名字检查拦下来（拦不住的话用户点 E1 出来的是这张）
      writeFileSync(join(dir, 'expressions', 'E1.exp3.json'), emptyExpression);
      writeFileSync(join(dir, 'expressions', 'official', 'E1.exp3.json'), emptyExpression);
      writeFileSync(join(dir, 'expressions', '微笑.exp3.json'), emptyExpression);
      writeFileSync(join(dir, 'a.model3.json'), JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: 'm.moc3',
          Textures: ['tex/t0.png'],
          Expressions: [{ Name: 'E1', File: 'expressions/official/E1.exp3.json' }],
        },
      }));
      const naming = inspectModel(sandbox, 'naming/a.model3.json', { force: true });
      const namingRej = naming.problems.find((p) => p.code === 'E_LOOSE_FILES_REJECTED');
      check('★ 表情名从文件名推得出来（「微笑」就是一个能点的名字）',
        naming.looseFiles?.addedExpressions?.includes('expressions/微笑.exp3.json') === true,
        JSON.stringify(naming.looseFiles));
      check('★ 与已有表情重名的**不认领**（认了就是「点了出来另一张」）',
        namingRej?.detail.includes('expressions/E1.exp3.json') === true && namingRej.detail.includes('重复'),
        namingRej?.detail ?? JSON.stringify(codes(naming)));
      check('★ 重名不是静默丢掉：说清是哪一条、为什么',
        namingRej?.message.includes('1 个') === true, namingRej?.message ?? '');
      check('★ 认领与拒绝同时发生时两边都要说话（别只报好消息）',
        naming.problems.some((p) => p.code === 'E_LOOSE_FILES_MERGED') && naming.expressions === 2,
        `表情=${naming.expressions} ${JSON.stringify(codes(naming))}`);
    }

    /*
     * ⑧⑨⑩ 三条**纯函数**层面的护栏，直接给 `mergeLooseIntoSetting` 造输入。
     *
     * 走 `inspectModel` 造不出「绝对路径」和「超过 128 个表情」这两个场景
     * （目录遍历产不出这种相对路径），而它们恰恰属于「猜错就出事」那一类 ——
     * 所以必须绕过体检器单独钉住。
     */
    {
      const base = { Version: 3, FileReferences: { Moc: 'm.moc3', Textures: ['tex/t0.png'] } };

      const unsafe = mergeLooseIntoSetting(base, {
        motions: [],
        expressions: ['C:/Windows/win.ini.exp3.json', '../../../etc/hosts.exp3.json', 'expressions/ok.exp3.json'],
      });
      check('★ 绝对路径 / 折返路径一个都不接（接了就是模型打不开，不是少个表情）',
        unsafe.addedExpressions.length === 1 && unsafe.addedExpressions[0] === 'expressions/ok.exp3.json',
        JSON.stringify(unsafe.addedExpressions));
      check('★ 不接的那些要逐条说出原因（不能静默丢）',
        unsafe.rejected.length === 2 && unsafe.rejected.every((r) => typeof r.why === 'string' && r.why.length > 0),
        JSON.stringify(unsafe.rejected));

      const many = mergeLooseIntoSetting(base, {
        motions: [],
        expressions: Array.from({ length: MAX_LOOSE_EXPRESSIONS + 5 }, (_, i) => `expressions/e${i}.exp3.json`),
      });
      check(`★ 表情认领有上限（${MAX_LOOSE_EXPRESSIONS} 个，防「一个目录被塞几千个文件」拖死客户端）`,
        many.addedExpressions.length === MAX_LOOSE_EXPRESSIONS && many.truncated === true,
        `${many.addedExpressions.length} 个 / truncated=${many.truncated}`);
      check('★ 截断也要说清（否则用户会问「怎么少了 5 个」）',
        many.rejected.length === 1 && many.rejected[0].why.includes(String(MAX_LOOSE_EXPRESSIONS)),
        JSON.stringify(many.rejected.slice(0, 2)));

      /*
       * ⑩ 这一条是**回归锁**，锁的是一个真实发生过的缺陷：
       *    VTS 那一半先把「脸红」加进去，散文件这一半紧接着又扫到同一个文件 ——
       *    它本该被认成「本来就有」而**静默**跳过，却因为在名字检查之后才判
       *    「已登记」，被当成重名报了出去（miku 那 8 个表情全部如此）。
       *    面板于是说「8 个表情没能自动接上」，而它们早就接上了、点得出来。
       */
      const withVts = mergeLooseIntoSetting({
        Version: 3,
        FileReferences: {
          Moc: 'm.moc3',
          Textures: ['tex/t0.png'],
          Expressions: [{ Name: '脸红', File: '脸红.exp3.json' }],
        },
      }, { motions: [], expressions: ['脸红.exp3.json'] });
      check('★ 已经登记过的表情不重复加（仍然 1 个）',
        withVts.addedExpressions.length === 0, JSON.stringify(withVts.addedExpressions));
      check('★ 而且不许报成「重名、没能接上」（那是纯属虚构的告警）',
        withVts.rejected.length === 0, JSON.stringify(withVts.rejected));
      check('★ 已登记时整体判定为「没变化」（别白重序列化一遍交给客户端）',
        withVts.changed === false, String(withVts.changed));
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log('\n[5c] ★ VTube Studio 配置合并（登记表在 *.vtube.json 里，要能被用上）');
{
  /*
   * 这一段的由来：[5b] 把症状说清楚了（「目录里有 8 个表情，但一个都没登记」），
   * 但**症状说清楚不等于能用**。用户的原话是「有没有表情和动作」—— 他要的是能点。
   *
   * 于是宿主在把 `model3.json` 交给客户端之前，把 `*.vtube.json` 里声明的表情
   * 与待机动画合并进内存副本。这里钉住四件事：
   *   ① 合并真的发生（数出来的能力要涨）；
   *   ② **绝不写盘**（版权声明写着「不可二传二改」）；
   *   ③ 指向空气的引用一个都不许进来（否则「少一个表情」变「模型加载失败」）；
   *   ④ 两处用**同一份**合并结果（`/models` 与 `/model/<rel>` 各算一次 =
   *      第八个缺陷的形状：「列表说有 8 个表情，实际一个都点不出来」）。
   */
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-live2d-vts-'));
  try {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001'
      + '0d0a2db40000000049454e44ae426082',
      'hex',
    );
    const moc = Buffer.alloc(32);
    moc.write('MOC3', 0, 'latin1');
    moc[4] = 5;
    moc[5] = 0;
    const emptyMotion = JSON.stringify({ Version: 3, Curves: [] });
    const emptyExpression = JSON.stringify({ Version: 3, Type: 'Live2D Expression', Parameters: [] });
    const codes = (entry) => entry.problems.map((p) => `${p.code}/${p.level}`);

    /**
     * 造一个「转换器丢了登记表」的包：文件都在，`model3.json` 什么都不登记。
     * `vts` 为 null 时不写配置；否则按传入的对象写。
     *
     * `writes` 控制**磁盘上**放哪几个动作 / 表情文件。自动认领上线之后，
     * 「磁盘上有什么」直接决定数出来的能力，于是它成了必须能单独控制的一维：
     * 想只验 VTS 那一半时就得把某个散文件拿掉，否则两半的效果混在一起，
     * 「1 个就是 1 个」这句话分不清是哪一半的功劳。
     */
    const ALL_LOOSE = ['animations/idle.motion3.json', 'e1.exp3.json', 'e2.exp3.json'];
    const make = (folder, vts, setting = null, writes = ALL_LOOSE) => {
      const dir = join(sandbox, folder);
      mkdirSync(join(dir, 'animations'), { recursive: true });
      mkdirSync(join(dir, 'tex'), { recursive: true });
      writeFileSync(join(dir, 'tex', 't0.png'), png);
      writeFileSync(join(dir, 'm.moc3'), moc);
      if (writes.includes('animations/idle.motion3.json')) writeFileSync(join(dir, 'animations', 'idle.motion3.json'), emptyMotion);
      if (writes.includes('e1.exp3.json')) writeFileSync(join(dir, 'e1.exp3.json'), emptyExpression);
      if (writes.includes('e2.exp3.json')) writeFileSync(join(dir, 'e2.exp3.json'), emptyExpression);
      writeFileSync(join(dir, 'a.model3.json'), JSON.stringify(setting ?? {
        Version: 3,
        FileReferences: { Moc: 'm.moc3', Textures: ['tex/t0.png'] },
      }));
      if (vts !== null) writeFileSync(join(dir, 'a.vtube.json'), JSON.stringify(vts));
      return `${folder}/a.model3.json`;
    };

    /** 一份「8 条热键里 6 条是表情、2 条是别的东西」的典型 VTS 配置。 */
    const typicalVts = {
      Version: 3,
      FileReferences: { Model: 'a.model3.json', IdleAnimation: 'animations/idle.motion3.json' },
      Hotkeys: [
        { Action: 'ToggleExpression', Name: '脸红', File: 'e1.exp3.json' },
        { Action: 'ToggleExpression', Name: '圈圈', File: './e2.exp3.json' },
        { Action: 'ToggleExpression', Name: '重复的', File: 'e1.exp3.json' },
        { Action: 'ToggleItem', Name: '葱', File: 'items_pinned_to_model.json' },
        { Action: 'RemoveAllExpressions' },
      ],
    };

    // ① 没有 VTS 配置 —— 合并这一半什么都不加。
    //    ★ 但**磁盘上的散文件照认**（[5b] 那套），所以能力数字不是 0 ——
    //      这两半是独立的两条来源，别把它们混成一句「没有配置就什么都没有」。
    {
      const bare = inspectModel(sandbox, make('noprof', null), { force: true });
      check('没有 *.vtube.json 时不报 E_VTS_PROFILE_USED',
        bare.problems.every((p) => p.code !== 'E_VTS_PROFILE_USED'), JSON.stringify(codes(bare)));
      check('没有 *.vtube.json 时 vtsProfile 保持 null（VTS 那一半没参与）',
        bare.vtsProfile === null, JSON.stringify(bare.vtsProfile));
      check('★ 没有 *.vtube.json 时散文件照认（2 个表情、1 个 idle 动作）',
        bare.expressions === 2 && bare.motions.count === 1 && bare.motions.groups.includes('idle'),
        JSON.stringify({ e: bare.expressions, m: bare.motions }));
    }

    // ② 有 VTS 配置 —— 能力数字必须真的涨上去。
    {
      const rel = make('prof', typicalVts);
      const entry = inspectModel(sandbox, rel, { force: true });
      check('★ 表情数按 VTS 热键算出来（2 个，重复的那个只算一次）',
        entry.expressions === 2, String(entry.expressions));
      check('★ 待机动作进了 Idle 组',
        entry.motions.groups.includes('Idle') && entry.motions.count === 1, JSON.stringify(entry.motions));
      const notice = entry.problems.find((p) => p.code === 'E_VTS_PROFILE_USED');
      check('★ 报告里说清「这几个能力是从 VTS 配置来的」',
        notice !== undefined && notice.message.includes('2 个表情') && notice.message.includes('1 个待机动作'),
        notice?.message ?? JSON.stringify(codes(entry)));
      check('这条是 warn 而不是 error（模型完全可用）', notice?.level === 'warn');
      check('合并之后模型仍然 ok', entry.ok === true, JSON.stringify(codes(entry)));
      check('② 合并过的文件不再报「散着没登记」（两半都已经接上了）',
        entry.problems.every((p) => p.code !== 'E_LOOSE_FILES_MERGED' && p.code !== 'E_LOOSE_FILES_REJECTED'),
        JSON.stringify(codes(entry)));
      check('detail 告诉用户「想让别处也能用该抄进 model3.json」',
        notice?.detail.includes('model3.json') === true, notice?.detail ?? '');
      check('vtsProfile 记下了是哪份配置、加了什么',
        entry.vtsProfile?.path === 'prof/a.vtube.json'
          && entry.vtsProfile.addedExpressions.length === 2
          && entry.vtsProfile.addedMotions.length === 1,
        JSON.stringify(entry.vtsProfile));
      check('★ vtsProfile.path 用 / 分隔（与 entry.path 的约定一致）',
        entry.vtsProfile.path.includes('\\') === false, entry.vtsProfile.path);
      check('★ vtsProfile 不夹带整份 model3.json（那是每次扫描都要发的东西）',
        entry.vtsProfile.setting === undefined && Object.keys(entry.vtsProfile).length === 3,
        JSON.stringify(Object.keys(entry.vtsProfile)));
    }

    // ③ ★ 绝不写盘 —— 这是版权约束，不是优化。逐字节比。
    {
      const rel = make('readonly', typicalVts);
      const abs = join(sandbox, 'readonly', 'a.model3.json');
      const before = readFileSync(abs);
      const entry = inspectModel(sandbox, rel, { force: true });
      const after = readFileSync(abs);
      check('★ 合并之后 model3.json 逐字节没变（不可二传二改）',
        before.equals(after), `${before.length}B → ${after.length}B`);
      check('★ 但体检报告里确实用上了合并结果（没写盘 ≠ 没生效）',
        entry.expressions === 2, String(entry.expressions));
      check('同目录也没有多出任何文件',
        readdirSync(join(sandbox, 'readonly')).sort().join(',')
          === 'a.model3.json,a.vtube.json,animations,e1.exp3.json,e2.exp3.json,m.moc3,tex',
        readdirSync(join(sandbox, 'readonly')).join(','));
    }

    // ④ 指向空气的引用一个都不许进来 —— 否则「少一个表情」变成「模型加载失败」。
    {
      const rel = make('ghost', {
        Version: 3,
        FileReferences: { Model: 'a.model3.json', IdleAnimation: 'animations/nope.motion3.json' },
        Hotkeys: [
          { Action: 'ToggleExpression', Name: '在的', File: 'e1.exp3.json' },
          { Action: 'ToggleExpression', Name: '不在的', File: 'missing.exp3.json' },
        ],
      });
      const entry = inspectModel(sandbox, rel, { force: true });
      /*
       * ★ 判据取 `vtsProfile.added*` 而不是 `entry.expressions` ——
       * 自动认领上线之后，磁盘上的 `e2` 与 `idle` 会**走另一条路**被接进来，
       * 于是总数里混着两半，单看总数分不出「指向空气的那个进来了没有」。
       */
      check('★ 磁盘上不存在的表情不合并（VTS 那一半只接进「在的」那一个）',
        entry.vtsProfile?.addedExpressions.length === 1
          && entry.vtsProfile.addedExpressions.includes('e1.exp3.json'),
        JSON.stringify(entry.vtsProfile));
      check('★ 磁盘上不存在的待机动作不合并（VTS 那一半一个动作都没接）',
        entry.vtsProfile?.addedMotions.length === 0, JSON.stringify(entry.vtsProfile));
      check('★ 总数是「VTS 1 个 + 散文件 1 个」= 2，没有第三个从空气里钻进来',
        entry.expressions === 2, String(entry.expressions));
      check('★ Idle 组那条来自磁盘上的散文件（配置里那个 nope 没进来）',
        entry.motions.count === 1 && entry.motions.groups.includes('idle'), JSON.stringify(entry.motions));
      check('被丢掉的那些没有变成「文件缺失」错误（是我们主动不接的）',
        entry.problems.every((p) => p.code !== 'E_MODEL_FILE_MISSING'), JSON.stringify(codes(entry)));
      check('丢掉了几项要说出来（E_VTS_PROFILE_UNUSED）',
        entry.problems.some((p) => p.code === 'E_VTS_PROFILE_UNUSED'), JSON.stringify(codes(entry)));
      const unused = entry.problems.find((p) => p.code === 'E_VTS_PROFILE_UNUSED');
      check('两处没接上的都算进去了（1 个不存在的表情 + 1 个不存在的动作）',
        unused?.message.includes('2 项') === true, unused?.message ?? '');
    }

    // ⑤ 别的东西（切换道具 / 播动画 / 清空表情）不该被当成表情接进来。
    {
      const rel = make('other', {
        Version: 3,
        FileReferences: { Model: 'a.model3.json' },
        Hotkeys: [
          { Action: 'ToggleItem', Name: '葱', File: 'e1.exp3.json' }, // 后缀对，但动作不对
          { Action: 'TriggerAnimation', Name: '动画', File: 'animations/idle.motion3.json' },
          { Action: 'RemoveAllExpressions' },
          { Action: '', File: 'e2.exp3.json' },
        ],
      });
      const entry = inspectModel(sandbox, rel, { force: true });
      check('★ 非 ToggleExpression 的热键一个都不接（后缀对也不接）',
        entry.vtsProfile === null, JSON.stringify(entry.vtsProfile));
      check('★ 数出来的 2 个表情全部来自磁盘上的散文件（没有一个是热键接进来的）',
        entry.expressions === 2, String(entry.expressions));
      check('一项都没接上时给的是 E_VTS_PROFILE_UNUSED 而不是 USED',
        entry.problems.some((p) => p.code === 'E_VTS_PROFILE_UNUSED')
          && entry.problems.every((p) => p.code !== 'E_VTS_PROFILE_USED'),
        JSON.stringify(codes(entry)));
    }

    // ⑥ `model3.json` 里已经登记的，不重复加。
    //    ★ 这个包**只往磁盘上放登记过的那两个文件**：散文件那一半要是也能加东西，
    //      「1 个就是 1 个」这句话就分不清是哪一半的功劳了。
    {
      const rel = make('dup', {
        Version: 3,
        FileReferences: { Model: 'a.model3.json', IdleAnimation: 'animations/idle.motion3.json' },
        Hotkeys: [{ Action: 'ToggleExpression', Name: '脸红', File: 'e1.exp3.json' }],
      }, {
        Version: 3,
        FileReferences: {
          Moc: 'm.moc3',
          Textures: ['tex/t0.png'],
          Expressions: [{ Name: '已有的', File: 'e1.exp3.json' }],
          Motions: { Idle: [{ File: 'animations/idle.motion3.json' }] },
        },
      }, ['animations/idle.motion3.json', 'e1.exp3.json']);
      const entry = inspectModel(sandbox, rel, { force: true });
      check('★ 已经登记过的表情不重复加（仍然 1 个）', entry.expressions === 1, String(entry.expressions));
      check('★ 已经登记过的动作不重复加（Idle 组仍然 1 条）',
        entry.motions.count === 1 && entry.motions.groups.length === 1, JSON.stringify(entry.motions));
      check('一个都没加时不报 E_VTS_PROFILE_USED（没什么可说的）',
        entry.problems.every((p) => p.code !== 'E_VTS_PROFILE_USED'), JSON.stringify(codes(entry)));
      check('不重复加但也不报「没接上」', entry.problems.every((p) => p.code !== 'E_VTS_PROFILE_UNUSED'),
        JSON.stringify(codes(entry)));
      check('★ 也不报「散着没登记」—— 两半都已经登记过了（虚构告警的回归锁）',
        entry.problems.every((p) => p.code !== 'E_LOOSE_FILES_MERGED' && p.code !== 'E_LOOSE_FILES_REJECTED'),
        JSON.stringify(codes(entry)));
    }

    // ⑦ 配置本身坏掉 / 是垃圾 —— 一律安静地不合并，绝不让整次体检失败。
    {
      const dir = join(sandbox, 'badprof');
      mkdirSync(join(dir, 'tex'), { recursive: true });
      writeFileSync(join(dir, 'tex', 't0.png'), png);
      writeFileSync(join(dir, 'm.moc3'), moc);
      writeFileSync(join(dir, 'a.model3.json'), JSON.stringify({
        Version: 3, FileReferences: { Moc: 'm.moc3', Textures: ['tex/t0.png'] },
      }));
      for (const [name, body] of [
        ['bad', '{ 这不是 JSON'],
        ['arr', '[1,2,3]'],
        ['null', 'null'],
        ['str', '"字符串"'],
      ]) {
        writeFileSync(join(dir, `a.${name}.vtube.json`), body);
      }
      const entry = inspectModel(sandbox, 'badprof/a.model3.json', { force: true });
      check('坏配置不抛异常、模型仍然 ok', entry.ok === true && entry.expressions === 0, JSON.stringify(codes(entry)));
      check('坏配置不产生 VTS 相关的问题条目',
        entry.problems.every((p) => !p.code.startsWith('E_VTS_')), JSON.stringify(codes(entry)));
    }

    // ⑧ 两份纯函数的分工：`readVtsProfileFor` 查磁盘，`mergeVtsIntoSetting` 只管路径安全。
    //    这个分工写错了会让「指向空气的引用」混进合成结果 —— 上面 ④ 已验证结果，
    //    这里直接钉住各自的契约，将来谁挪了职责会立刻红。
    {
      const profile = readVtsProfileFor(join(sandbox, 'ghost', 'a.model3.json'));
      check('readVtsProfileFor 已经过滤掉磁盘上不存在的引用',
        profile.expressions.length === 1 && profile.idle === '', JSON.stringify(profile));
      const merged = mergeVtsIntoSetting(
        { Version: 3, FileReferences: {} },
        { expressions: [{ name: 'x', file: '../../etc/passwd.exp3.json' }], idle: '/abs/idle.motion3.json' },
      );
      check('★ mergeVtsIntoSetting 拒绝越界的相对路径与绝对路径',
        merged.changed === false, JSON.stringify(merged));
      const evil = mergeVtsIntoSetting(
        { Version: 3, FileReferences: {} },
        { expressions: [{ name: 'x', file: 'a\\..\\..\\b.exp3.json' }], idle: '' },
      );
      check('★ 反过来：折返写法也不接受', evil.changed === false, JSON.stringify(evil));
      const pure = { Version: 3, FileReferences: {} };
      const frozen = JSON.stringify(pure);
      mergeVtsIntoSetting(pure, { expressions: [{ name: 'x', file: 'a.exp3.json' }], idle: '' });
      check('★ mergeVtsIntoSetting 不改入参（纯函数）', JSON.stringify(pure) === frozen, JSON.stringify(pure));
    }

    // ⑨ `parseVtsProfile` 的边界：缺字段、类型不对、超长路径。
    {
      check('坏 JSON 回 ok=false 而不是抛', parseVtsProfile('{').ok === false);
      check('缺 FileReferences 时 idle 为空串', parseVtsProfile('{"Hotkeys":[]}').idle === '');
      check('IdleAnimation 不是字符串时忽略',
        parseVtsProfile('{"FileReferences":{"IdleAnimation":42}}').idle === '');
      check('★ 超长路径的引用被丢掉（.vtube.json 是用户能随手编辑的文件）',
        parseVtsProfile(JSON.stringify({
          FileReferences: {},
          Hotkeys: [{ Action: 'ToggleExpression', File: `${'x'.repeat(300)}.exp3.json` }],
        })).expressions.length === 0);
      check('热键数组里混进 null / 数字不会崩',
        parseVtsProfile(JSON.stringify({
          FileReferences: {},
          Hotkeys: [null, 42, 'x', { Action: 'ToggleExpression', File: 'a.exp3.json' }],
        })).expressions.length === 1);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log('\n[5d] ★ 路由交出去的那份 JSON 必须真的带着合并结果');
{
  /*
   * [5c] 验的是「体检报告算得对」。但用户点开的是**客户端**，客户端加载模型时
   * 读的是 `/model/<rel>` 交出去的那份 JSON。两处各算一次 = 第八个缺陷的形状：
   * 面板写着「8 个表情」，点开一个都没有，而两边各自的日志都正常。
   *
   * ★ 这里**不**断言路由的源码里出现过某个字符串。第一版就是那么写的，
   * 然后我做反证时把 `body = Buffer.from(JSON.stringify(merged.setting))`
   * 改成 `body = buf`（合并了却交原始字节，正是要防的那个 bug），
   * **源码断言一条都没红** —— 字符串全都还在。
   * 所以合并逻辑被抽成了 `mergeSettingBytes(buf, absolute)`，这里喂它真夹具。
   */
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-live2d-serve-'));
  try {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001'
      + '0d0a2db40000000049454e44ae426082',
      'hex',
    );
    const moc = Buffer.alloc(32);
    moc.write('MOC3', 0, 'latin1');
    moc[4] = 5;
    writeFileSync(join(sandbox, 'tex.png'), png);
    writeFileSync(join(sandbox, 'm.moc3'), moc);
    writeFileSync(join(sandbox, 'e1.exp3.json'), '{"Version":3}');
    writeFileSync(join(sandbox, 'e2.exp3.json'), '{"Version":3}');
    writeFileSync(join(sandbox, 'idle.motion3.json'), '{"Version":3}');
    const abs = join(sandbox, 'a.model3.json');
    // 磁盘上的定义：一个表情都没登记（这正是转换器丢登记表的样子）
    writeFileSync(abs, JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'm.moc3', Textures: ['tex.png'] },
    }));
    writeFileSync(join(sandbox, 'a.vtube.json'), JSON.stringify({
      Version: 3,
      FileReferences: { Model: 'a.model3.json', IdleAnimation: 'idle.motion3.json' },
      Hotkeys: [
        { Action: 'ToggleExpression', Name: '脸红', File: 'e1.exp3.json' },
        { Action: 'ToggleExpression', Name: '圈圈', File: 'e2.exp3.json' },
      ],
    }));

    const served = mergeSettingBytes(readFileSync(abs), abs);
    const parsed = JSON.parse(served.toString('utf8'));
    check('★ 路由交出去的 JSON 里有 2 个表情（磁盘上写的是 0 个）',
      parsed.FileReferences.Expressions?.length === 2,
      JSON.stringify(parsed.FileReferences.Expressions));
    check('★ 路由交出去的 JSON 里有 Idle 动作',
      parsed.FileReferences.Motions?.Idle?.length === 1,
      JSON.stringify(parsed.FileReferences.Motions));
    check('交出去的仍然是合法 JSON 且保留了原有字段',
      parsed.FileReferences.Moc === 'm.moc3' && parsed.Version === 3, JSON.stringify(parsed));
    check('★ 磁盘上的原始文件一个字节都没变（合并只在内存里）',
      JSON.parse(readFileSync(abs, 'utf8')).FileReferences.Expressions === undefined);
    check('文件里没有多出任何东西',
      readdirSync(sandbox).sort().join(',') === 'a.model3.json,a.vtube.json,e1.exp3.json,e2.exp3.json,idle.motion3.json,m.moc3,tex.png',
      readdirSync(sandbox).join(','));

    // 兜底：坏 JSON / 没有配置 / 传进来的不是 Buffer —— 一律原样交回，绝不交半成品。
    const junk = Buffer.from('{ 这不是 JSON', 'utf8');
    check('★ 坏 JSON 原样交回（不抛、不返回空 buffer）',
      mergeSettingBytes(junk, abs).equals(junk));
    check('空 buffer 原样交回（空 buffer 会让客户端 JSON.parse 抛错）',
      mergeSettingBytes(Buffer.alloc(0), abs).byteLength === 0);
    check('传进来的不是 Buffer 时原样交回（路由出错也比抛异常好）',
      mergeSettingBytes('字符串', abs) === '字符串');
    /*
     * 「没有可合并的东西就别动它」—— 重新序列化一遍不只是浪费，还会把用户
     * 文件里的键序与缩进改掉（那份文件是用户能打开看的）。
     *
     * 判据从「没有 *.vtube.json」改成「**一个可合并的东西都没有**」：
     * 自动认领上线之后，散文件也是可合并的东西，只挡 VTS 那一半挡不住。
     * 所以这里换成一个空目录（没有配置、也没有散着的动作 / 表情）。
     */
    const plainDir = join(sandbox, 'plain');
    mkdirSync(plainDir, { recursive: true });
    const plain = join(plainDir, 'a.model3.json');
    const plainBody = Buffer.from(JSON.stringify({ Version: 3, FileReferences: { Moc: 'm.moc3' } }), 'utf8');
    writeFileSync(plain, plainBody);
    check('没有任何可合并的东西时**逐字节**原样交回（不做无谓的重新序列化）',
      mergeSettingBytes(plainBody, plain).equals(plainBody));
    // 反过来验一次：同一个包只要多出一个散文件，就必须重新序列化 ——
    // 否则「逐字节原样交回」会变成「认领根本不生效」的遮羞布。
    writeFileSync(join(plainDir, 'e1.exp3.json'), '{"Version":3}');
    check('★ 一旦目录里散着一个表情，交出去的 JSON 里就必须有它',
      JSON.parse(mergeSettingBytes(plainBody, plain).toString('utf8')).FileReferences.Expressions?.length === 1,
      mergeSettingBytes(plainBody, plain).toString('utf8').slice(0, 200));

    // 路由那一侧的接线（这一条只能看源码，但它只是 plumbing，不是判定逻辑）
    const routeSource = readFileSync(join(WORKSPACE, 'dsh-live2d-pet', 'lib', 'index.js'), 'utf8');
    check('★ 路由只在 .model3.json 上做合并（别把纹理也读一遍 JSON）',
      /endsWith\('\.model3\.json'\)[\s\S]{0,120}mergeSettingBytes\(buf, target\)/.test(routeSource));
    check('★ Content-Length 用的是合并后的长度（不是原始 buf 的）',
      /'Content-Length':\s*String\(body\.byteLength\)/.test(routeSource)
        && /res\.end\(body\)/.test(routeSource));
    /*
     * ★ 这一条只能看**发模型定义的那一段**，不能扫整个文件。
     *
     * 原先是 `routeSource.includes('writeFile') === false` —— 它当时成立，
     * 因为 index.js 一个字都不写盘。后来设置面板要能把参数绑定存回
     * `settings.json`，index.js 里就合法地出现了 `writeFileSync`，于是这条
     * 断言在一个和「合并结果有没有被写回去」毫无关系的改动上变红了。
     * 还是那个老毛病：钉字面形状，而不是钉语义。
     *
     * 现在切片取「读 buf → 合并 → res.end(body)」这一段（从发模型定义的那个
     * try 起、到 res.end 止）：真正的风险只可能发生在这一段里。切片取不到时
     * 判红 —— 否则切片一失效，这条断言就会变成恒真。
     */
    const mergeAt = routeSource.indexOf('? mergeSettingBytes(buf, target)');
    const tryAt = mergeAt > 0 ? routeSource.lastIndexOf('try {', mergeAt) : -1;
    const endAt = mergeAt > 0 ? routeSource.indexOf('res.end(body)', mergeAt) : -1;
    const sendSlice = tryAt >= 0 && endAt > mergeAt
      ? routeSource.slice(tryAt, endAt + 'res.end(body)'.length)
      : '';
    check('路由没有把合并结果写回磁盘（发模型定义那一段里不出现 writeFile）',
      sendSlice.length > 0 && sendSlice.includes('writeFile') === false);
    const hostDir = join(WORKSPACE, 'dsh-live2d-pet', 'lib', 'host');
    const libSource = readFileSync(join(hostDir, 'model-library.js'), 'utf8');
    /*
     * ★ 体检器与路由必须用**同一个**合并函数。
     *
     * 这不是风格问题：各写一份的话，两处对「哪些散文件算数、怎么去重」
     * 的判断迟早会分叉，而症状是第八个缺陷的形状 ——
     * 「列表说有 8 个表情，实际一个都点不出来」，两边都没报错。
     */
    check('体检器与路由共用同一个合并函数（不是各写一份）',
      /import\s*\{[\s\S]*?mergeModelSetting[\s\S]*?\}\s*from\s*'\.\/vts-profile\.js'/.test(libSource)
        && libSource.includes('mergeModelSetting(json, absolute'),
      '体检器必须 import 并调用 mergeModelSetting');
    check('★ 体检器没有自己扫一遍散文件（扫两遍会漂移：指纹按 A 算、结果按 B 报）',
      libSource.includes('function collectLooseModelFiles') === false
        && (libSource.match(/collectLooseModelFiles\(/g) ?? []).length === 1,
      String((libSource.match(/collectLooseModelFiles\(/g) ?? []).length));
    // 归一化只有一份 —— 各写一份的症状是「去重没去干净、同一个表情加两遍」，
    // 而那种包在别的播放器里会直接打不开。用「谁定义了这个函数」来钉，比钉 import 路径稳。
    const definers = readdirSync(hostDir).filter((f) => f.endsWith('.js')
      && /(?:export\s+)?function\s+normalizeRefPath\b/.test(readFileSync(join(hostDir, f), 'utf8')));
    check('★ 归一化函数全仓库只有一份（ref-path.js），别处都 import 它',
      definers.length === 1 && definers[0] === 'ref-path.js', JSON.stringify(definers));
    check('★ 两个调用方都从 ref-path.js 拿（不是各自留一份私有的）',
      readFileSync(join(hostDir, 'loose-files.js'), 'utf8').includes("from './ref-path.js'")
        && readFileSync(join(hostDir, 'vts-profile.js'), 'utf8').includes("from './ref-path.js'"),
      'loose-files.js 与 vts-profile.js 都必须 import ./ref-path.js');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log('\n[6] 反向验证：门禁本身会不会红');
{
  // 如果 [3] 的「至少有一个模型可加载」之类的断言永远不会失败，那它就没有价值。
  // 这里造一个**必然坏**的包，断言体检确实把它判成坏的。
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-live2d-negative-'));
  try {
    mkdirSync(join(sandbox, 'dead'), { recursive: true });
    writeFileSync(join(sandbox, 'dead', 'x.model3.json'), '{"Version":3}');
    const entry = inspectModel(sandbox, 'dead/x.model3.json', { force: true });
    check('必然坏的包被判定为不可加载', entry.ok === false);
    check('必然坏的包给出了错误码', entry.problems.length > 0);
    check('体检器没有把它误报成好包', entry.problems.some((p) => p.level === 'error'));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log('\n[7] MAX_MOC3_VERSION 必须与 vendor 里的 Core 一致');
if (!existsSync(CORE_PATH)) {
  console.log(`  [skip] 找不到 Core：${CORE_PATH}`);
} else {
  const Core = createCore(CORE_PATH);
  const { version } = await waitForCore(Core);
  const coreMax = Core.Version.csmGetLatestMocVersion();
  console.log(`  Core 版本 0x${version.toString(16)}  支持的最高 moc3 = ${coreMax}  代码里的常量 = ${MAX_MOC3_VERSION}`);
  // 这条断言存在的全部理由：手工同步的数字一定会漂移。漂移的后果是
  // 「体检说没问题、Core 加载时报错」，而且只在用户那边暴露。
  check('常量与 Core 实际支持的上限一致', MAX_MOC3_VERSION === coreMax, `常量 ${MAX_MOC3_VERSION} vs Core ${coreMax}`);
}

console.log('\n[7b] ★ 这一整轮跑下来，用户的模型库有没有被碰过');
/*
 * 这是**关于门禁自己**的断言，也是这个文件里唯一一条不在验代码、而在验「我们」的。
 *
 * `[3]` 段扫的是用户真实的模型库。只要 `model-library.js` 或 `vts-profile.js`
 * 里混进一行写盘代码，这一轮就会把它执行在用户的真文件上 ——
 * 而且门禁会**全绿**，因为所有断言问的都是「读出来的对不对」，
 * 没有一条问「写回去了没有」。2026-10-16 就这么坏过一次（详见 `[3]` 段上方注释）。
 */
{
  const libraryAfter = snapshotLibrary();
  const changes = diffLibrary(libraryBefore, libraryAfter);
  check(
    '★ 用户的模型库一个字节都没变（读模型库的门禁不许写模型库）',
    changes.length === 0,
    changes.join('；'),
  );
}

console.log('');
if (failures > 0) {
  console.log(`[x] MODEL LIBRARY GATE FAILED — ${failures} 项断言未通过`);
  process.exit(1);
}
console.log('[8] MODEL LIBRARY GATE PASSED');
