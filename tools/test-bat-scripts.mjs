#!/usr/bin/env node
/**
 * 门禁：**`tools\*.bat` 能不能被 cmd.exe 正确解析与显示**。
 *
 * ## 为什么需要这个文件
 *
 * 用户双击 `start-tts-all.bat` 报「乱码 + 运行失败」。查下去发现根因不是编码，
 * 是**换行**：这些 .bat 是编辑器的写文件工具生成的，那个工具默认写 **LF**，
 * 而 cmd.exe 的批处理解析器只把 **CRLF** 当行尾。LF-only 的文件会被切在
 * 奇怪的位置 —— 实测（第 [5] 段的反证就是这么复现出来的）：
 *
 *     '��' is not recognized as an internal or external command
 *     'gpt-sovits-api.bat"' is not recognized as an internal or external command
 *
 * 注意第二行：`start "标题" "路径"` 被从中间切断，路径尾巴自己成了一条命令。
 * 这正是「看起来像乱码，其实是行被切碎」的样子 —— 光盯编码永远修不好。
 *
 * ## 为什么这道门禁要存在，而不是修完就算
 *
 * 这三个 .bat 是**给人双击**的，跑不到任何自动化里；它们坏掉时不会让
 * `verify-all` 变红，只会在用户桌面上弹出一个满是报错的窗口。所以它必须由
 * 门禁替人盯着：CRLF、无 BOM、`chcp 65001` 在第 2 行、以及**cmd 真的能解析**。
 *
 * ## 用法
 *
 *     node tools/test-bat-scripts.mjs     （离线；会在临时目录跑一个 echo 版副本）
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BATS = [
  'start-gpt-sovits-api.bat',
  'start-gptsovits-adapter.bat',
  'start-tts-all.bat',
];

let passed = 0;
let failed = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${label}${detail ? `   ← ${detail}` : ''}`);
  }
};

/**
 * 判据集中在这里，第 [5] 段的反证复用的就是它 ——
 * 反证不重写一遍规则，否则「反证通过」可能只证明两份实现一样错。
 */
const inspect = (bytes) => {
  const text = Buffer.from(bytes).toString('utf8');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const loneCr = (text.match(/\r(?!\n)/g) ?? []).length;
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const lines = text.split('\r\n');
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    text,
    lines,
    crlf,
    loneLf,
    loneCr,
    bom,
    longestLine,
    endsWithCrlf: text.endsWith('\r\n'),
    /** 没有 BOM、没有裸 LF/CR、以 CRLF 收尾、且每行都在 cmd 的 8191 上限内 */
    ok: !bom && loneLf === 0 && loneCr === 0 && crlf > 0 && text.endsWith('\r\n') && longestLine <= 8191,
  };
};

const readBat = (name) => readFileSync(join(HERE, name));

/* ══════════════════════════════════════════════════════════════════════════════
 * [1] 三个脚本都在
 * ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n[1] 脚本存在');

for (const name of BATS) {
  let size = 0;
  try {
    size = readBat(name).length;
  } catch {
    size = -1;
  }
  check(`${name} 存在且非空`, size > 0, `size=${size}`);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * [2] 换行：必须是 CRLF、无 BOM、以 CRLF 结尾
 * ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n[2] 换行与编码（用户报的那个 bug 就住在这一段）');

for (const name of BATS) {
  const info = inspect(readBat(name));
  check(`${name}：没有裸 LF（cmd 只认 CRLF）`, info.loneLf === 0, `loneLf=${info.loneLf}`);
  check(`${name}：没有裸 CR`, info.loneCr === 0, `loneCr=${info.loneCr}`);
  check(`${name}：以 CRLF 结尾`, info.endsWithCrlf === true);
  check(`${name}：没有 UTF-8 BOM（有 BOM 时第一行会变成「锘?@echo off」）`, info.bom === false);
  check(`${name}：没有超长行（cmd 单行上限 8191）`, info.longestLine <= 8191, `longest=${info.longestLine}`);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * [3] UTF-8 中文要在 `chcp 65001` **之后**出现
 * ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n[3] chcp 65001 的位置');

for (const name of BATS) {
  const { lines } = inspect(readBat(name));
  check(`${name}：第 1 行是 @echo off`, (lines[0] ?? '').trim().toLowerCase() === '@echo off', lines[0]);
  check(`${name}：第 2 行是 chcp 65001 >nul`, (lines[1] ?? '').trim() === 'chcp 65001 >nul', lines[1]);
  // 第 3 行起才有中文 —— 否则「先出现中文、后切码页」，那几行一定乱码
  const firstChinese = lines.findIndex((line) => /[\u4e00-\u9fff]/.test(line));
  check(`${name}：第一处中文在第 3 行或之后`, firstChinese >= 2, `firstChineseLine=${firstChinese + 1}`);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * [4] 结构：一键脚本拉两个窗口，API 脚本的菜单指向真实存在的三份配置
 * ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n[4] 结构接线');

{
  const all = inspect(readBat('start-tts-all.bat'));
  check('一键脚本用 %~dp0 定位同目录的另两个脚本（不写死盘符）',
    (all.text.match(/%~dp0start-gpt-sovits-api\.bat/g) ?? []).length === 1
    && (all.text.match(/%~dp0start-gptsovits-adapter\.bat/g) ?? []).length === 1);
  check('一键脚本先起 API、等一会儿、再起适配层（API 加载权重实测 10~14 秒，20 秒是留了余量的）',
    all.text.indexOf('start-gpt-sovits-api.bat') < all.text.indexOf('timeout /t 20')
    && all.text.indexOf('timeout /t 20') < all.text.indexOf('start-gptsovits-adapter.bat'));

  const api = inspect(readBat('start-gpt-sovits-api.bat'));
  for (const cfg of [
    'tts_infer_v5turbo.yaml', 'tts_infer_v5dev.yaml',
    'tts_infer_dafeiyu.yaml', 'tts_infer_v2pro.yaml', 'tts_infer.yaml',
  ]) {
    check(`API 脚本的菜单里有 ${cfg}`, api.text.includes(cfg));
  }
  check('API 脚本默认（回车）走 v5turbo 那份配置',
    /set "CFG=GPT_SoVITS\/configs\/tts_infer_v5turbo\.yaml"/.test(api.text));
  // v5 与旧版装在不同目录，选错版本会去错的目录里找 yaml —— 这一步错了只会看到「找不到文件」
  check('API 脚本认得两个安装目录（v5 与旧版各一处）',
    api.text.includes('D:\\GPT-SoVITSv5\\GPT-SoVITS-v2pro-20261006nvidia50x0')
    && api.text.includes('D:\\GPT-SoVITS\\GPT-SoVITS-v2pro-20250604-nvidia50'));
  check('API 脚本用 cd /d 切到选中的目录（不写死在一个目录里）',
    /cd \/d "%REPO%"/.test(api.text));
  check('API 脚本每次运行先清空 CFG（否则同一窗口里残留上一次的选择）',
    /set "CFG="/.test(api.text));
  check('API 脚本把配置传给 -c', /-c %CFG%/.test(api.text));
  check('API 脚本支持用 DSH_GSV_PICK 跳过菜单（一键启动靠这个把 15 秒留给「等它起来」而不是「等人按键」）',
    /if not defined DSH_GSV_PICK set \/p PICK=/.test(api.text));
  check('API 脚本每次都先清空 PICK', /set "PICK="/.test(api.text));
  check('一键脚本在 start 之前就设好 DSH_GSV_PICK=1（子窗口继承环境变量，不用往 start 里塞参数）',
    all.text.indexOf('set "DSH_GSV_PICK=1"') < all.text.indexOf('start "GPT-SoVITS API'),
    `setAt=${all.text.indexOf('set "DSH_GSV_PICK=1"')} startAt=${all.text.indexOf('start "GPT-SoVITS API')}`);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * [5] 反证：把真文件的 CR 抽掉，同一个判据必须变假
 * ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n[5] 反证（不动真文件，只喂给同一个 inspect）');

{
  const real = readBat('start-tts-all.bat');
  check('对照：真文件判为 ok', inspect(real).ok === true);

  const lfOnly = Buffer.from(real.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  const lfInfo = inspect(lfOnly);
  check('反证 1：换成 LF 换行后判为坏', lfInfo.ok === false, `loneLf=${lfInfo.loneLf}`);
  check('反证 1 对照：裸 LF 计数从 0 变成行数', lfInfo.loneLf > 0 && inspect(real).loneLf === 0);

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), real]);
  check('反证 2：加一个 BOM 后判为坏', inspect(withBom).ok === false);

  const noTail = Buffer.from(real.toString('utf8').replace(/\r\n$/, ''), 'utf8');
  check('反证 3：删掉结尾的 CRLF 后判为坏', inspect(noTail).ok === false);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * [6] 真跑：让 cmd 解析一个 echo 版副本（换掉 start / timeout / python）
 *
 * 有两个坑，第一版门禁自己踩满了：
 *
 *  1. **别用 `echo. | "路径"` 喂回车**。Node 会把整个参数当一句话加引号，
 *     cmd 收到的 `"echo. | "C:\...\x.bat""` 里层引号被吃掉，于是它报
 *     「不是内部或外部命令」并返回 255 —— 门禁红的是它自己的写法，
 *     不是被它检查的 .bat。喂回车请用 spawnSync 的 `input`。
 *  2. **别靠中文报错串判断**。bat 里 `chcp 65001` 之后输出是 UTF-8，
 *     但 cmd *自己* 的报错在 chcp 之前就发生了，用的是控制台默认码页（GBK），
 *     按 UTF-8 解出来是乱码，`includes('不是内部或外部命令')` 永远不命中。
 *     所以这里改成**正向断言**：副本一定会 echo 出 ASCII 记号
 *     `[would-start]` / `[would-wait]` / `[would-run]`，记号缺席即解析失败。
 *
 * 每份副本都**不碰真文件**：start → echo、timeout → echo、python → echo、
 * pause → exit /b 0，写进临时目录再跑，跑完连目录一起删。
 * ══════════════════════════════════════════════════════════════════════════════ */

console.log('\n[6] cmd 真的能解析（临时目录里的 echo 版副本）');

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-bat-gate-'));

/** 把要真跑的命令换掉，只留 cmd 的解析路径；返回副本文本与期望出现的记号 */
const makeProbe = (name) => {
  const original = readBat(name).toString('utf8');
  const probeText = original
    .replace(/^start /gm, 'echo [would-start] ')
    .replace(/^timeout .*$/gm, 'echo [would-wait]')
    .replace(/^runtime\\python\.exe /gm, 'echo [would-run] ')
    .replace(/^pause >nul$/gm, 'exit /b 0')
    .replace(/^pause$/gm, 'exit /b 0');
  const probePath = join(sandbox, name);
  writeFileSync(probePath, probeText, 'utf8');
  return probePath;
};

const runProbe = (probePath, env = {}, input = '\r\n\r\n') =>
  spawnSync('cmd.exe', ['/c', probePath], {
    // `set /p` 会一直等输入，喂回车；`timeout` 已被换成 echo，不会真等
    input,
    // 一键启动靠环境变量跳过菜单，这里既用来验「跳过」，也用来验「不问的时候选了哪份」
    env: { ...process.env, ...env },
    // 不给 encoding：默认就拿 Buffer，自己决定用哪种编码解（见上面坑 2）
    timeout: 20_000,
    windowsHide: true,
  });

const countOf = (text, token) => (text.match(new RegExp(token.replace(/[[\]]/g, '\\$&'), 'g')) ?? []).length;

{
  const out = runProbe(makeProbe('start-tts-all.bat'));
  const text = out.stdout?.toString('utf8') ?? '';
  check('start-tts-all.bat：cmd 解析通过（exit=0）', out.status === 0, `status=${out.status}`);
  check('start-tts-all.bat：两个 start 都是独立命令行（没有被下一行吞掉）',
    countOf(text, '[would-start]') === 2, `count=${countOf(text, '[would-start]')}`);
  check('start-tts-all.bat：两次 timeout 都解析出来了',
    countOf(text, '[would-wait]') === 2, `count=${countOf(text, '[would-wait]')}`);
  // 这一行是 ASCII，UTF-8 / GBK 解出来都一样，所以判据不受码页影响
  check('start-tts-all.bat：echo 出来的中文没把后面的行顶掉（127.0.0.1:9880 在）',
    text.includes('127.0.0.1:9880'));
}

/**
 * 菜单五条路都要真跑一遍 —— 只跑「空回车」会漏掉「选 2 / 选 3 到底映射到哪份 yaml」，
 * 而那才是用户换版本时唯一会碰的地方。v5 与旧版还分属两个安装目录，所以顺带断言目录。
 */
const V5_ROOT = 'D:\\GPT-SoVITSv5\\GPT-SoVITS-v2pro-20261006nvidia50x0';
const V2_ROOT = 'D:\\GPT-SoVITS\\GPT-SoVITS-v2pro-20250604-nvidia50';

const API_CASES = [
  { label: '空回车（菜单默认）', env: {}, input: '\r\n\r\n', must: 'tts_infer_v5turbo.yaml', root: V5_ROOT },
  { label: '菜单选 2', env: {}, input: '2\r\n', must: 'tts_infer_v5dev.yaml', root: V5_ROOT },
  { label: '菜单选 3', env: {}, input: '3\r\n', must: 'tts_infer_dafeiyu.yaml', root: V2_ROOT },
  { label: '菜单选 4', env: {}, input: '4\r\n', must: 'tts_infer_v2pro.yaml', root: V2_ROOT },
  { label: '菜单选 5', env: {}, input: '5\r\n', must: 'tts_infer.yaml', root: V2_ROOT },
  { label: '一键启动：DSH_GSV_PICK=1 不问菜单', env: { DSH_GSV_PICK: '1' }, input: '\r\n', must: 'tts_infer_v5turbo.yaml', root: V5_ROOT },
  { label: '一键启动：DSH_GSV_PICK=3', env: { DSH_GSV_PICK: '3' }, input: '\r\n', must: 'tts_infer_dafeiyu.yaml', root: V2_ROOT },
];

{
  const probePath = makeProbe('start-gpt-sovits-api.bat');
  for (const testCase of API_CASES) {
    const out = runProbe(probePath, testCase.env, testCase.input);
    const text = out.stdout?.toString('utf8') ?? '';
    const expected = `api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/${testCase.must}`;
    check(`start-gpt-sovits-api.bat〔${testCase.label}〕：cmd 解析通过（exit=0）`,
      out.status === 0, `status=${out.status}`);
    check(`start-gpt-sovits-api.bat〔${testCase.label}〕：python 那行解析出来了`,
      countOf(text, '[would-run]') === 1, `count=${countOf(text, '[would-run]')}`);
    check(`start-gpt-sovits-api.bat〔${testCase.label}〕：走到 ${testCase.must}`,
      text.includes(expected));
    check(`start-gpt-sovits-api.bat〔${testCase.label}〕：目录切对了（${testCase.root === V5_ROOT ? 'v5' : '旧版'}）`,
      text.includes(testCase.root));
  }

  // 有环境变量时必须**根本不问** —— 否则一键启动会卡在别人的窗口里等按键
  const quiet = runProbe(probePath, { DSH_GSV_PICK: '1' }, '');
  check('start-gpt-sovits-api.bat：给了 DSH_GSV_PICK 就不再弹菜单（不读 stdin）',
    !(quiet.stdout?.toString('utf8') ?? '').includes('请输入'));
}

rmSync(sandbox, { recursive: true, force: true });

/* ══════════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✔' : '✘'} BAT SCRIPTS GATE — ${passed} 项通过、${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
