#!/usr/bin/env node
/**
 * 门禁：本地 TTS 的「一键」——探测 / 启动 / 停止（`lib/host/local-tts.js`）。
 *
 * ## 为什么需要这个文件
 *
 * 这一层是**会启动进程**的代码，而它最危险的失败不是「报错」，是三种安静的事故：
 *
 *   1. **拉起两份服务**：端口已经在听时再 spawn 一次，Windows 允许两个进程绑同一端口
 *      （§13.13 那次 9881 被悄悄抢走就是它），于是「谁在回答」变成随机的；
 *   2. **杀掉别人的进程**：停止如果按端口找进程，用户自己开的窗口会被一起关掉；
 *   3. **参数变成命令**：`config` 若被当成命令行片段拼进去，面板就成了本机任意命令
 *      执行的入口（同源页面就能 POST）。
 *
 * 所以下面的断言里，**反证比正例多**：端口占用时 spawn 次数必须为 0、没托管过的 pid
 * 必须一次都不 kill、`config` 只能落在 `-c` 的下一个位置、源码里不许出现 `shell: true`。
 *
 * ## 用法
 *
 *     node tools/test-local-tts.mjs      （离线：无网络、无真实进程、无 GPU）
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(PACKAGE, 'lib/host/local-tts.js');

let failed = 0;
let passed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

if (!existsSync(modulePath)) {
  console.error(`模块不存在：${modulePath}`);
  process.exit(2);
}

const mod = await import(pathToFileURL(modulePath).href);
const {
  LOCAL_ENGINE_PORT,
  LOCAL_ADAPTER_PORT,
  LOCAL_ADAPTER_ENDPOINT,
  candidateRoots,
  findInstalls,
  pickConfig,
  pickInstall,
  probePort,
  defaultAdapterScript,
  createLocalTtsManager,
} = mod;

console.log('\n[1] 常量与默认值');
check('合成端口 9880', LOCAL_ENGINE_PORT === 9880, String(LOCAL_ENGINE_PORT));
check('适配层端口 9881', LOCAL_ADAPTER_PORT === 9881, String(LOCAL_ADAPTER_PORT));
check('建议地址指向适配层', LOCAL_ADAPTER_ENDPOINT === 'http://127.0.0.1:9881/tts', LOCAL_ADAPTER_ENDPOINT);
check('适配层脚本默认在插件包上一级的 tools/', defaultAdapterScript(PACKAGE) === resolve(PACKAGE, '..', 'tools', 'gptsovits-adapter.py'), defaultAdapterScript(PACKAGE));
check('环境变量可以覆盖适配层脚本', defaultAdapterScript(PACKAGE, { DSH_GSV_ADAPTER: 'D:\\x\\a.py' }) === 'D:\\x\\a.py');

console.log('\n[2] 候选目录');
{
  const roots = candidateRoots({ env: { DSH_GSV_ROOT: 'D:\\A;D:\\B' }, home: 'C:\\Users\\u' });
  check('环境变量排在最前（分号分隔）', roots[0] === 'D:\\A' && roots[1] === 'D:\\B', roots.slice(0, 3).join(' | '));
  check('家目录兜底在列表里', roots.includes(join('C:\\Users\\u', 'GPT-SoVITS')));
  const dup = candidateRoots({ env: { DSH_GSV_ROOT: 'D:\\A' }, home: 'C:\\Users\\u' });
  const lower = dup.map((root) => root.toLowerCase());
  check('去重（大小写不敏感）', lower.length === new Set(lower).size);
  const multi = candidateRoots({ env: { DSH_GSV_ROOT: 'D:\\A', GPT_SOVITS_ROOT: 'E:\\C' }, home: '' });
  check('两个环境变量都认', multi.includes('D:\\A') && multi.includes('E:\\C'));
}

console.log('\n[3] 找安装（真实临时目录）');
const workRoot = mkdtempSync(join(tmpdir(), 'dsh-local-tts-gate-'));
const installRoot = join(workRoot, 'GPT-SoVITS', 'GPT-SoVITS-v2pro-test');
mkdirSync(join(installRoot, 'runtime'), { recursive: true });
mkdirSync(join(installRoot, 'GPT_SoVITS', 'configs'), { recursive: true });
writeFileSync(join(installRoot, 'api_v2.py'), '# api\n');
writeFileSync(join(installRoot, 'webui.py'), '# webui\n');
writeFileSync(join(installRoot, 'runtime', 'python.exe'), '');
writeFileSync(join(installRoot, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'), 'v2: {}\n');
writeFileSync(join(installRoot, 'GPT_SoVITS', 'configs', 'tts_infer_dafeiyu.yaml'), 'custom: {}\n');
const adapterDir = join(workRoot, 'tools');
mkdirSync(adapterDir, { recursive: true });
const adapterScript = join(adapterDir, 'gptsovits-adapter.py');
writeFileSync(adapterScript, '# adapter\n');
/*
 * 第二处安装：专门用来测「装了多个包时用哪一份」。这台开发机就是这种情形
 * （v5 包与旧包并存），而选错等于用错权重——所以不许静默退回第一处。
 */
const secondRoot = join(workRoot, 'GPT-SoVITS2', 'GPT-SoVITS-v5-test');
mkdirSync(join(secondRoot, 'runtime'), { recursive: true });
mkdirSync(join(secondRoot, 'GPT_SoVITS', 'configs'), { recursive: true });
writeFileSync(join(secondRoot, 'api_v2.py'), '# api v5\n');
writeFileSync(join(secondRoot, 'runtime', 'python.exe'), '');
writeFileSync(join(secondRoot, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'), 'v2: {}\n');
writeFileSync(join(secondRoot, 'GPT_SoVITS', 'configs', 'tts_infer_v5turbo.yaml'), 'custom: {}\n');
const secondRoots = [join(workRoot, 'GPT-SoVITS'), join(workRoot, 'GPT-SoVITS2')];

try {
  const installs = findInstalls({ roots: [join(workRoot, 'GPT-SoVITS')] });
  check('一层子目录里的整合包被找到', installs.length === 1 && installs[0].root === installRoot, `找到 ${installs.length} 处`);
  check('认出了 runtime\\python.exe', installs[0]?.python === join(installRoot, 'runtime', 'python.exe'));
  check('列到了 configs 下的 yaml', installs[0]?.configs.includes('tts_infer.yaml') && installs[0]?.configs.includes('tts_infer_dafeiyu.yaml'), installs[0]?.configs.join(','));
  check('不存在的根目录不报错', findInstalls({ roots: [join(workRoot, 'nope')] }).length === 0);
  check('直接指到包目录也认', findInstalls({ roots: [installRoot] }).length === 1);
  check('没有 api_v2.py 的目录不算安装', findInstalls({ roots: [join(workRoot, 'tools')] }).length === 0);

  console.log('\n[4] 选 yaml');
  const install = findInstalls({ roots: [installRoot] })[0];
  check('默认选朴素的 tts_infer.yaml', pickConfig(install, '') === 'tts_infer.yaml');
  check('点名要哪份就给哪份', pickConfig(install, 'tts_infer_dafeiyu.yaml') === 'tts_infer_dafeiyu.yaml');
  check('点错了名字退回默认（不当命令行片段用）', pickConfig(install, 'x.yaml && calc.exe') === 'tts_infer.yaml');
  check('没有 yaml 时返回空串', pickConfig({ configs: [] }, '') === '');

  console.log('\n[4b] 装了两个包时用哪一份');
  const twoInstalls = findInstalls({ roots: secondRoots });
  check('两处都找到了', twoInstalls.length === 2, String(twoInstalls.length));
  check('不点名就用第一处', pickInstall(twoInstalls, '').install?.root === installRoot);
  check('点名第二处就用第二处', pickInstall(twoInstalls, secondRoot).install?.root === secondRoot);
  check('路径大小写不影响匹配', pickInstall(twoInstalls, secondRoot.toUpperCase()).install?.root === secondRoot);
  {
    const miss = pickInstall(twoInstalls, join(workRoot, 'nope'));
    check('点错了目录要报出来（不静默换一份）', miss.install?.root === installRoot && miss.requested !== '', miss.requested);
  }
  check('一处都没有时返回 null', pickInstall([], secondRoot).install === null);

  console.log('\n[5] 端口探测');
  const server = createServer(() => {});
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const livePort = server.address().port;
  check('开着的端口探得到', (await probePort(livePort)) === true, String(livePort));
  await new Promise((done) => server.close(done));
  check('关掉的端口探不到', (await probePort(livePort, { timeoutMs: 200 })) === false, String(livePort));

  console.log('\n[6] scan 的形状');
  {
    const spawns = [];
    const manager = createLocalTtsManager({
      packageRoot: PACKAGE,
      env: { DSH_GSV_ROOT: join(workRoot, 'GPT-SoVITS'), DSH_GSV_ADAPTER: adapterScript },
      home: '',
      roots: [join(workRoot, 'GPT-SoVITS')],
      logDir: workRoot,
      tcpProbe: async () => false,
      spawnDetached: (spec) => { spawns.push(spec); return 111; },
      killProcess: () => true,
    });
    const status = await manager.scan();
    check('ports 两个都在', status.ports.engine.port === 9880 && status.ports.adapter.port === 9881);
    check('installs 找到了临时包', status.installs.length === 1 && status.installs[0].root === installRoot, String(status.installs.length));
    check('每处安装都给出选中的 yaml', status.installs[0].config === 'tts_infer.yaml');
    check('适配层脚本被认到', status.adapter.exists === true, status.adapter.script);
    check('建议地址是 9881', status.suggestedEndpoint === LOCAL_ADAPTER_ENDPOINT);
    check('managed 初始为空', status.managed.engine === null && status.managed.adapter === null);
    check('scan 不 spawn', spawns.length === 0);

    console.log('\n[7] start 的正常路径');
    const started = await manager.start({ target: 'all' });
    check('start ok', started.ok === true, JSON.stringify(started).slice(0, 120));
    check('起了两个进程', spawnedCount(spawns) === 2, String(spawnedCount(spawns)));
    const engineSpawn = spawns[0];
    check('引擎用整合包里的 python', engineSpawn.command === join(installRoot, 'runtime', 'python.exe'), engineSpawn.command);
    check('参数固定 7 段（config 不是拼进去的）', engineSpawn.args.length === 7, String(engineSpawn.args.length));
    check('参数形状：api_v2.py -a 127.0.0.1 -p 9880 -c <yaml>', engineSpawn.args[0] === 'api_v2.py'
      && engineSpawn.args[1] === '-a' && engineSpawn.args[2] === '127.0.0.1'
      && engineSpawn.args[3] === '-p' && engineSpawn.args[4] === '9880'
      && engineSpawn.args[5] === '-c'
      && engineSpawn.args[6] === join('GPT_SoVITS', 'configs', 'tts_infer.yaml'), engineSpawn.args.join(' '));
    check('引擎 cwd 是整合包根', engineSpawn.cwd === installRoot);
    check('适配层用同一份 python 且只带脚本一个参数', spawns[1].command === join(installRoot, 'runtime', 'python.exe')
      && spawns[1].args.length === 1 && spawns[1].args[0] === adapterScript, spawns[1].args.join(' '));
    const managed = manager.managed();
    check('两个 pid 都被记住', managed.get('engine')?.pid === 111 && managed.get('adapter')?.pid === 111);
    check('start 之后 scan 会报 managed', (await manager.scan()).managed.engine === 111);

    console.log('\n[7b] start 用「选中的那一份」');
    {
      const spawns2 = [];
      const picker = createLocalTtsManager({
        packageRoot: PACKAGE,
        env: { DSH_GSV_ADAPTER: adapterScript },
        home: '',
        roots: secondRoots,
        logDir: workRoot,
        tcpProbe: async () => false,
        spawnDetached: (spec) => { spawns2.push(spec); return 777; },
        killProcess: () => true,
      });
      const second = await picker.start({ target: 'engine', root: secondRoot });
      check('点名第二处 → ok', second.ok === true, JSON.stringify(second).slice(0, 120));
      check('用的是第二处的 python', spawns2[0]?.command === join(secondRoot, 'runtime', 'python.exe'), spawns2[0]?.command);
      check('cwd 也是第二处', spawns2[0]?.cwd === secondRoot);
      const withoutConfig = spawns2[0]?.args[6] ?? '';
      check('不点名 yaml 时用那一处自己的 tts_infer.yaml', withoutConfig === join('GPT_SoVITS', 'configs', 'tts_infer.yaml'), withoutConfig);

      const spawns3 = [];
      const picker2 = createLocalTtsManager({
        packageRoot: PACKAGE,
        env: { DSH_GSV_ADAPTER: adapterScript },
        home: '',
        roots: secondRoots,
        logDir: workRoot,
        tcpProbe: async () => false,
        spawnDetached: (spec) => { spawns3.push(spec); return 778; },
        killProcess: () => true,
      });
      const withConfig = await picker2.start({ target: 'engine', root: secondRoot, config: 'tts_infer_v5turbo.yaml' });
      check('点名 yaml 就用它', withConfig.ok === true && (spawns3[0]?.args[6] ?? '').endsWith('tts_infer_v5turbo.yaml'), spawns3[0]?.args[6]);
      check('scan 会记住选中的那一份', (await picker2.scan({ root: secondRoot, config: 'tts_infer_v5turbo.yaml' })).selected?.root === secondRoot);

      const spawns4 = [];
      const picker3 = createLocalTtsManager({
        packageRoot: PACKAGE,
        env: { DSH_GSV_ADAPTER: adapterScript },
        home: '',
        roots: secondRoots,
        logDir: workRoot,
        tcpProbe: async () => false,
        spawnDetached: (spec) => { spawns4.push(spec); return 779; },
        killProcess: () => true,
      });
      const bad = await picker3.start({ target: 'engine', root: join(workRoot, 'nope') });
      check('点了不存在的目录 → E_LOCAL_TTS_BAD_ROOT', bad.ok === false && bad.code === 'E_LOCAL_TTS_BAD_ROOT', bad.code);
      check('点错目录时一次都不 spawn', spawns4.length === 0);
      check('点错目录时把收到的路径带回去', typeof bad.detail === 'string' && bad.detail.includes('nope'), bad.detail);
    }

    console.log('\n[8] stop 只杀自己的');
    const killed = [];
    const manager2 = createLocalTtsManager({
      packageRoot: PACKAGE,
      env: { DSH_GSV_ROOT: join(workRoot, 'GPT-SoVITS'), DSH_GSV_ADAPTER: adapterScript },
      home: '',
      roots: [join(workRoot, 'GPT-SoVITS')],
      logDir: workRoot,
      tcpProbe: async () => false,
      isAlive: () => true,
      queryPortOwner: () => null,
      spawnDetached: () => 222,
      killProcess: (pid) => { killed.push(pid); return true; },
    });
    await manager2.start({ target: 'all' });
    const stopped = await manager2.stop({ target: 'all' });
    check('两个都被杀', killed.length === 2 && stopped.stopped.length === 2, JSON.stringify(stopped.stopped));
    check('停止回报里带 source（这一轮起的 = managed）', stopped.stopped.every((entry) => entry.source === 'managed'));
    check('停了之后 managed 清空', manager2.managed().size === 0);
    const twice = await manager2.stop({ target: 'all' });
    check('重复停止不再杀（不误伤别的进程）', twice.stopped.length === 0 && twice.skipped.length === 2 && killed.length === 2);
    check('重复停止的理由是 not-managed', twice.skipped.every((entry) => entry.reason === 'not-managed'));
    check('没托管也没人在听时，回报里明说「端口没在听」', twice.skipped.every((entry) => entry.portListening === false && entry.pid === null));
    const unmanaged = createLocalTtsManager({
      packageRoot: PACKAGE, env: { DSH_GSV_ADAPTER: adapterScript }, home: '', logDir: workRoot,
      tcpProbe: async () => false, isAlive: () => true, queryPortOwner: () => null,
      killProcess: (pid) => { killed.push(pid); return true; },
    });
    const nothing = await unmanaged.stop({ target: 'all' });
    check('没托管过就一个都不杀', killed.length === 2 && nothing.stopped.length === 0 && nothing.skipped.length === 2);

    console.log('\n[8b] 重启之后还认得自己起过什么（磁盘账本）');
    {
      const ledgerDir = join(workRoot, 'state');
      const ledgerPath = join(ledgerDir, 'local-tts-processes.json');
      const makeManager = (spawnPid, killedList) => createLocalTtsManager({
        packageRoot: PACKAGE,
        env: { DSH_GSV_ROOT: join(workRoot, 'GPT-SoVITS'), DSH_GSV_ADAPTER: adapterScript },
        home: '',
        roots: [join(workRoot, 'GPT-SoVITS')],
        logDir: workRoot,
        statePath: ledgerPath,
        tcpProbe: async () => false,
        isAlive: (pid) => pid === spawnPid,
        queryPortOwner: () => null,
        spawnDetached: () => spawnPid,
        killProcess: (pid) => { killedList.push(pid); return true; },
      });

      const firstKills = [];
      const before = makeManager(901, firstKills);
      const started = await before.start({ target: 'all' });
      check('第一次 start 正常', started.ok === true && firstKills.length === 0);
      check('账本文件写出来了', existsSync(ledgerPath), ledgerPath);
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      check('账本记了两个 pid', ledger.entries?.engine?.pid === 901 && ledger.entries?.adapter?.pid === 901, JSON.stringify(Object.keys(ledger.entries ?? {})));
      check('账本记了整串命令行', String(ledger.entries?.engine?.command ?? '').includes('api_v2.py')
        && String(ledger.entries?.engine?.command ?? '').includes('-p 9880'), String(ledger.entries?.engine?.command ?? '').slice(0, 80));

      // 模拟 DSH 重启：新管理器、空内存，只有同一个账本
      const secondKills = [];
      const afterRestart = makeManager(901, secondKills);
      const status = await afterRestart.scan();
      check('重启后 scan 直接认得出归属（pid 与来源）', status.managed.engine === 901 && status.managedSource.engine === 'ledger', JSON.stringify(status.managedSource));
      const stoppedAfterRestart = await afterRestart.stop({ target: 'all' });
      check('重启后 stop 真的停了（这就是 §13.24 那个 bug）',
        secondKills.length === 2 && stoppedAfterRestart.stopped.every((entry) => entry.source === 'ledger'),
        JSON.stringify(stoppedAfterRestart.stopped));
      check('停完账本被清空', JSON.parse(readFileSync(ledgerPath, 'utf8')).entries.engine === undefined
        && JSON.parse(readFileSync(ledgerPath, 'utf8')).entries.adapter === undefined);

      // pid 已经没了：不能杀，而且要把记录清掉
      const staleKills = [];
      const stalePath = join(ledgerDir, 'stale.json');
      writeFileSync(stalePath, JSON.stringify({ version: 1, entries: { engine: { pid: 424242, port: 9880, startedAt: 1 } } }));
      const stale = createLocalTtsManager({
        packageRoot: PACKAGE, env: { DSH_GSV_ADAPTER: adapterScript }, home: '', logDir: workRoot,
        statePath: stalePath,
        tcpProbe: async () => false,
        isAlive: () => false,
        queryPortOwner: () => null,
        killProcess: (pid) => { staleKills.push(pid); return true; },
      });
      const staleStop = await stale.stop({ target: 'engine' });
      check('pid 已经没了 → 一次都不杀', staleKills.length === 0);
      check('pid 已经没了 → 回报 pid-gone', staleStop.skipped[0]?.reason === 'pid-gone' && staleStop.skipped[0]?.pid === 424242,
        JSON.stringify(staleStop.skipped));
      check('pid 已经没了 → 账本里那条被清掉', JSON.parse(readFileSync(stalePath, 'utf8')).entries.engine === undefined);
    }

    console.log('\n[8c] 账本也没写成功时：按命令行认领（adopted）');
    {
      const engineCmd = 'D:\\GPT-SoVITS\\GPT-SoVITS-v2pro-20250604-nvidia50\\runtime\\python.exe '
        + 'api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\\configs\\tts_infer.yaml';
      const adoptCase = async (commandLine, listening) => {
        const killedAdopt = [];
        const manager = createLocalTtsManager({
          packageRoot: PACKAGE, env: { DSH_GSV_ADAPTER: adapterScript }, home: '', logDir: workRoot,
          tcpProbe: async () => listening,
          isAlive: () => true,
          queryPortOwner: (port) => (port === 9880 ? { pid: 172468, commandLine } : null),
          killProcess: (pid) => { killedAdopt.push(pid); return true; },
        });
        const result = await manager.stop({ target: 'engine' });
        return { killed: killedAdopt, result };
      };

      const ours = await adoptCase(engineCmd, true);
      check('命令行逐段吻合 → 认领并停掉', ours.killed.length === 1 && ours.killed[0] === 172468, JSON.stringify(ours.result.stopped));
      check('认领的 source 是 adopted', ours.result.stopped[0]?.source === 'adopted');
      check('adopted 的回报带命令行（面板要能引用它）', String(ours.result.stopped[0]?.command ?? '').includes('api_v2.py'));

      const foreign = await adoptCase('node.exe D:\\x\\server.js', true);
      check('别人的进程 → 一个都不杀', foreign.killed.length === 0);
      check('别人的进程 → 回报 not-managed 且带 pid 与命令行',
        foreign.result.skipped[0]?.pid === 172468 && String(foreign.result.skipped[0]?.command ?? '').includes('server.js'),
        JSON.stringify(foreign.result.skipped));

      const wrongPort = await adoptCase(engineCmd.replace('-p 9880', '-p 9886'), true);
      check('端口对不上（-p 9886）→ 不认领', wrongPort.killed.length === 0);

      const noConfig = await adoptCase('runtime\\python.exe api_v2.py -a 127.0.0.1 -p 9880', true);
      check('少了 -c …configs\\*.yaml → 不认领（判据不许放宽）', noConfig.killed.length === 0);

      const silentPort = await adoptCase('', false);
      check('端口没在听 → 不查端口所有者、不杀', silentPort.killed.length === 0 && silentPort.result.skipped[0]?.portListening === false);
    }

    console.log('\n[9] 拒绝路径');
    {
      const busyManager = createLocalTtsManager({
        packageRoot: PACKAGE,
        env: { DSH_GSV_ROOT: join(workRoot, 'GPT-SoVITS'), DSH_GSV_ADAPTER: adapterScript },
        home: '',
        roots: [join(workRoot, 'GPT-SoVITS')],
        logDir: workRoot,
        tcpProbe: async () => true,
        spawnDetached: () => 333,
        killProcess: () => true,
      });
      const busy = await busyManager.start({ target: 'all' });
      check('端口已在听 → 409 语义的错', busy.ok === false && busy.code === 'E_LOCAL_TTS_ALREADY_RUNNING', busy.code);
      check('端口已在听 → 一次都不 spawn', busyManager.managed().size === 0);
      const badTarget = await busyManager.start({ target: 'shell' });
      check('target 只认三选一', badTarget.ok === false && badTarget.code === 'E_LOCAL_TTS_BAD_TARGET');
      const badStop = await busyManager.stop({ target: 'rm -rf' });
      check('stop 的 target 同样只认三选一', badStop.ok === false && badStop.code === 'E_LOCAL_TTS_BAD_TARGET');
    }
    {
      const emptyRoot = join(workRoot, 'empty');
      mkdirSync(emptyRoot, { recursive: true });
      const noInstall = createLocalTtsManager({
        packageRoot: PACKAGE,
        env: { DSH_GSV_ROOT: emptyRoot, DSH_GSV_ADAPTER: adapterScript },
        home: '',
        roots: [emptyRoot],
        logDir: workRoot,
        tcpProbe: async () => false,
        spawnDetached: () => 444,
        killProcess: () => true,
      });
      const result = await noInstall.start({ target: 'all' });
      check('没装 → E_LOCAL_TTS_NO_INSTALL', result.ok === false && result.code === 'E_LOCAL_TTS_NO_INSTALL', result.code);
      check('没装 → 不 spawn', noInstall.managed().size === 0);
    }
    {
      const noAdapter = createLocalTtsManager({
        packageRoot: PACKAGE,
        env: { DSH_GSV_ROOT: join(workRoot, 'GPT-SoVITS'), DSH_GSV_ADAPTER: join(workRoot, 'nope.py') },
        home: '',
        roots: [join(workRoot, 'GPT-SoVITS')],
        logDir: workRoot,
        tcpProbe: async () => false,
        spawnDetached: () => 555,
        killProcess: () => true,
      });
      const result = await noAdapter.start({ target: 'adapter' });
      check('缺适配层脚本 → E_LOCAL_TTS_NO_ADAPTER', result.ok === false && result.code === 'E_LOCAL_TTS_NO_ADAPTER', result.code);
    }

    console.log('\n[10] 源码对账（接线与安全）');
    {
      const host = stripComments(readFileSync(resolve(PACKAGE, 'lib/index.js'), 'utf8'));
      check('Host 注册了 GET /tts/local', /rest === '\/tts\/local'/.test(host));
      check('Host 注册了 start/stop', /'\/tts\/local\/start'/.test(host) && /'\/tts\/local\/stop'/.test(host));
      check('Host 侧有 config 长度闸门', /config\.length > 64/.test(host));
      check('Host 侧有 root 长度闸门', /root\.length > 512/.test(host));
      check('Host 把 target 与 config、root 原样交给管理器（不拼命令行）', /localTts\.start\(\{ target, config, root \}\)/.test(host));
      check('scan 也接受 root（否则选中项立刻被覆盖）', /localTts\.scan\(\{ config, root \}\)/.test(host));
      /*
       * §13.28：选择要能存住、探测要能回声。
       * 这三条是那个真机现象（挑 v5 + dafei.yaml，点「检测本机」变回 v2 + tts_infer.yaml）
       * 的直接对账 —— 少任何一条，现象就会回来。
       */
      check('Host 注册了 /tts/local/select（面板一拨下拉就存）', /rest === '\/tts\/local\/select'/.test(host));
      check('GET /tts/local 把面板的选择转成 scan 的 root/config（探测回声，不是覆盖）',
        /localTts\.scan\(\{ root: preferredRoot, config: preferredConfig \}\)/.test(host));
      check('GET /tts/local 的优先级是 query → settings → 默认', /queryRoot !== '' \? queryRoot : settings\.localRoot/.test(host));
      check('select 只写 ttsLocalRoot / ttsLocalConfig 两个键',
        /applySettingsPatch\(state\.settingsPath, \{\s*ttsLocalRoot: chosen\.root,\s*ttsLocalConfig: chosen\.config,/.test(host));
      check('启动成功后也把「用哪份」记下来（下次刷新不用重挑）',
        /rest === '\/tts\/local\/start' && status\.selected !== null/.test(host));
      check('Host 把账本路径交给管理器（重启后还认得出自己起过什么）',
        /statePath: join\(dirname\(String\(resolved\.settingsPath\)\), 'local-tts-processes\.json'\)/.test(host));
      check('Host 的路由 await stop（stop 要问端口所有者，已是异步）', /await localTts\.stop\(\{ target \}\)/.test(host));
      const moduleSource = stripComments(readFileSync(modulePath, 'utf8'));
      check('管理器不用 shell: true', moduleSource.includes('shell: true') === false);
      check('spawn 的 stdio 里 stdin 是 ignore', /stdio: \['ignore', fd, fd\]/.test(moduleSource));
      check('判据函数是可测的具名导出', ['defaultIsAlive', 'defaultQueryPortOwner', 'matchesEngineCommand', 'matchesAdapterCommand']
        .every((name) => moduleSource.includes(`export function ${name}(`)));
      check('账本写着版本号（形状变了才能拒读）', moduleSource.includes('const LEDGER_VERSION = 1'));
      const client = stripComments(readFileSync(resolve(PACKAGE, 'src/client/plugin.ts'), 'utf8'));
      check('面板有四个按钮', ['tts-local-scan', 'tts-local-start', 'tts-local-stop', 'tts-local-fill']
        .every((role) => client.includes(`'${role}'`)));
      check('面板有「用哪一份」的两个下拉', client.includes("'tts-local-root'") && client.includes("'tts-local-config'"));
      check('启动时把选中的 root/config 一起发出去', /controlLocalTts\('start', 'all', \{ root: localRoot, config: localConfig \}\)/.test(client));
      check('「检测本机」把当前两份一起发过去（否则 Host 只能回答默认那处）',
        /fetchLocalTts\(localRoot, localConfig\)/.test(client));
      check('面板一拨下拉就保存选择（rememberPick → /tts/local/select）',
        /selectLocalTts\(root, config\)/.test(client) && /void rememberPick\(next, nextConfig\)/.test(client));
      check('「当前选」说的是 Host 解出来的那一份（status.selected），不是 installs[0]',
        /const chosenRoot = chosen === null \? first\?\.root \?\? '' : chosen\.root;/.test(client));
      check('退回时说出来（requestedRoot 有值 → 面板加一句「已退回」）',
        /status\.requestedRoot !== ''/.test(client));
      check('面板有文字引导', client.includes('本地 TTS 三步'));
      check('面板调的是两条控制路由', client.includes("controlLocalTts('start'") && client.includes("controlLocalTts('stop'"));
      check('面板不再说那句「没有需要停的」反话（§13.24）', client.includes('没有需要停的') === false);
      check('面板按归属分别说话：adopted / ledger 有各自的句子',
        client.includes("'adopted'") && client.includes("'ledger'"));
      const built = readFileSync(resolve(PACKAGE, 'lib/client.js'), 'utf8');
      check('构建产物里带着按钮', built.includes('tts-local-scan') && built.includes('tts-local-fill'));
      check('构建产物里带着「用哪一份」的下拉', built.includes('tts-local-root') && built.includes('tts-local-config'));
      check('构建产物里带着引导文案', built.includes('本地 TTS 三步'));
    }
  }
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}

function spawnedCount(spawns) {
  return spawns.length;
}

console.log(`\n${failed === 0 ? '[21] LOCAL TTS GATE PASSED' : '[21] LOCAL TTS GATE FAILED'}  ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
