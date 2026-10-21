/**
 * 本地 TTS 的「一键」：探测 → 启动 → 停止。
 *
 * 为什么要有这个模块
 * ------------------
 * 面板上原本只有「引擎 / 地址 / 测试连接」三件东西，那是**给已经装好服务的人**用的：
 * 使用者得先自己知道 GPT-SoVITS 装在哪、该用哪个 yaml、适配层要跑哪个脚本、
 * 9880 与 9881 是两个进程。对「刚装好插件的人」来说，这一串是他放弃的地方。
 *
 * 所以这里把那段知识变成三个动作：
 *   - **探测**：常见安装目录 + 两个端口，告诉他「我看到了什么」；
 *   - **启动**：按探测结果拉起 API 与适配层（命令是写死的，不接受任意参数）；
 *   - **停止**：只杀**我们自己起的**进程（pid 记在内存里），不去碰别人的窗口。
 *
 * 三条硬约束
 * ----------
 * 1. **不接受用户传入的命令行。**可执行文件、脚本、cwd 全部来自探测结果与本文件
 *    的常量；路由只接受 `target`（`all` / `engine` / `adapter`）与 `config` 名，
 *    而 `config` 还会被校验成「探测到的 yaml 之一」。否则这条路由就是本机任意
 *    命令执行（面板在浏览器里，任何同源页面都能 POST）。
 * 2. **不接管已经在跑的进程。**端口已经在监听时不重复启动 —— Windows 允许两个
 *    进程绑同一端口（见 §13.13 那次 9881 被悄悄抢走的事故），这里必须自己挡住。
 * 3. **停止只杀自己的。**用户在别的窗口里手动起的服务，pid 不在账本里，
 *    这时「停止」要如实回「这个不是我起的」，而不是去按端口杀进程。
 *
 * 「自己的」怎么才算数（§13.24 加的三层，见 `stop`）
 * --------------------------------------------------
 * 最初「自己的」= 本进程内存里的 `managed`。可 DSH 改一次 Host 就重启一次，
 * 重启后 `managed` 是空的，于是面板对着**自己十分钟前拉起的、还在 9880 上听着的**
 * 引擎说「没有需要停的：这两个端口上没有我拉起的进程」—— 用户的原话是
 * 「停止的时候显示这个」，那不是解释，是反话。现在三层依次判：
 *
 *   1. 内存（本轮起的）；
 *   2. 磁盘账本（`statePath`，重启前起的 —— pid 一样，`source: 'ledger'`）；
 *   3. 端口指纹（账本也没写成功时才走到这：命令行必须与我们 spawn 的那一串
 *      逐段吻合，`source: 'adopted'`）。
 *
 * 第 3 层仍然**不按端口杀进程**：`netstat` 给不出「这是谁起的」，所以它只提供
 * pid，判据是命令行（`api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\configs\*.yaml`）。
 * 别的窗口手起的服务不会长成那样（`tools/*.bat` 里的那几条恰好会，这仍然是对的：
 * 那几条本来就是「按插件的方式起服务」，用户点「停止」要的就是停它）。
 *
 * 诊断字段比布尔多：面板要分别说清「没装」「装了但没跑」「跑着但连不上」。
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** GPT-SoVITS 的 API 端口（`api_v2.py -p`）。 */
export const LOCAL_ENGINE_PORT = 9880;

/** 适配层端口（`tools/gptsovits-adapter.py` 的 `listen_port` 默认值）。 */
export const LOCAL_ADAPTER_PORT = 9881;

/** 面板「填入地址」用的建议地址：指向适配层，不是 GPT-SoVITS 本体。 */
export const LOCAL_ADAPTER_ENDPOINT = `http://127.0.0.1:${LOCAL_ADAPTER_PORT}/tts`;

/** 磁盘账本的格式版本：形状变了就 +1，读到不认识的版本按空账处理。 */
const LEDGER_VERSION = 1;

/** 探测用的常见根目录（Windows 上是用户实际放这个包的地方）。 */
const WELL_KNOWN_ROOTS = [
  'D:\\GPT-SoVITS',
  'D:\\GPT-SoVITSv5',
  'C:\\GPT-SoVITS',
  'D:\\AI\\GPT-SoVITS',
  'C:\\AI\\GPT-SoVITS',
];

/** 一个目录里认得出的「这是一个 GPT-SoVITS 整合包」的标志。 */
const INSTALL_MARKERS = {
  api: 'api_v2.py',
  python: join('runtime', 'python.exe'),
  configs: join('GPT_SoVITS', 'configs'),
  webui: 'webui.py',
};

/** 探测时最多看多少个候选子目录（防止把整个盘扫一遍）。 */
const MAX_SCAN_DIRS = 40;

/**
 * TCP 连一下，判断端口有没有人在听。
 *
 * 用 TCP 而不是 HTTP：适配层与 API 的 GET 语义不一样（`api_v2.py` 的 GET `/tts`
 * 无参数会 500，见 §13.9），而「端口开着」才是启动脚本要问的问题。
 */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 400 } = {}) {
  return new Promise((done) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(value);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 环境变量里给的根目录（`;` 分隔），支持一次给多个。 */
function rootsFromEnv(env) {
  const raw = [env?.DSH_GSV_ROOT, env?.GPT_SOVITS_ROOT].filter((value) => typeof value === 'string' && value.trim() !== '');
  const roots = [];
  for (const entry of raw) {
    for (const part of entry.split(';')) {
      const trimmed = part.trim();
      if (trimmed !== '') roots.push(trimmed);
    }
  }
  return roots;
}

/**
 * 候选根目录：环境变量优先，其次是几个常见位置，最后是家目录。
 *
 * 顺序有意义：越靠前越可能是用户真正在用的那一份，`installs[0]` 会被当成默认。
 */
export function candidateRoots({ env = process.env, home = homedir() } = {}) {
  const roots = [...rootsFromEnv(env), ...WELL_KNOWN_ROOTS];
  if (typeof home === 'string' && home !== '') roots.push(join(home, 'GPT-SoVITS'));
  // 去重但保留顺序
  const seen = new Set();
  return roots.filter((root) => {
    const key = root.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 这个目录本身是不是一个整合包（有 api_v2.py 与 configs）。 */
function describeRoot(root, existsSyncImpl) {
  const api = join(root, INSTALL_MARKERS.api);
  if (!existsSyncImpl(api)) return null;
  const python = join(root, INSTALL_MARKERS.python);
  const configsDir = join(root, INSTALL_MARKERS.configs);
  const configs = [];
  if (existsSyncImpl(configsDir)) {
    try {
      for (const name of readdirSync(configsDir)) {
        if (/\.ya?ml$/i.test(name)) configs.push(name);
      }
    } catch {
      // 读不到目录就当没有配置：`configs: []` 会被面板说成「没找到 yaml」
    }
  }
  return {
    root,
    api: existsSyncImpl(api) ? api : '',
    webui: existsSyncImpl(join(root, INSTALL_MARKERS.webui)) ? join(root, INSTALL_MARKERS.webui) : '',
    python: existsSyncImpl(python) ? python : '',
    configs,
  };
}

/**
 * 在候选目录里找整合包。
 *
 * 两层：候选目录自己就是整合包（用户直接把 `DSH_GSV_ROOT` 指到包里），
 * 或者它的下一层是（`D:\GPT-SoVITS\GPT-SoVITS-v2pro-2025...`，这是解压后的常见形状）。
 */
export function findInstalls({ roots, existsSync: existsSyncImpl = existsSync } = {}) {
  const installs = [];
  const seen = new Set();
  const push = (install) => {
    if (install === null) return;
    const key = resolve(install.root).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    installs.push(install);
  };
  for (const root of roots) {
    if (!existsSyncImpl(root)) continue;
    push(describeRoot(root, existsSyncImpl));
    if (installs.length > 0 && seen.has(resolve(root).toLowerCase())) continue;
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    let looked = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (looked >= MAX_SCAN_DIRS) break;
      looked += 1;
      push(describeRoot(join(root, entry.name), existsSyncImpl));
    }
  }
  return installs;
}

/** 默认的适配层脚本：插件包的上一级 `tools/`。 */
export function defaultAdapterScript(packageRoot, env = process.env) {
  const fromEnv = typeof env?.DSH_GSV_ADAPTER === 'string' && env.DSH_GSV_ADAPTER.trim() !== ''
    ? env.DSH_GSV_ADAPTER.trim()
    : '';
  if (fromEnv !== '') return fromEnv;
  if (typeof packageRoot !== 'string' || packageRoot === '') return '';
  return join(packageRoot, '..', 'tools', 'gptsovits-adapter.py');
}

/** 训练/推理用的默认 yaml：优先朴素名，其次是探测到的第一份。 */
export function pickConfig(install, wanted) {
  if (!install || !Array.isArray(install.configs) || install.configs.length === 0) return '';
  if (typeof wanted === 'string' && wanted !== '') {
    const hit = install.configs.find((name) => name.toLowerCase() === wanted.toLowerCase());
    if (hit) return hit;
  }
  const plain = install.configs.find((name) => name.toLowerCase() === 'tts_infer.yaml');
  return plain ?? install.configs[0];
}

/**
 * 在探测到的安装里挑一处。
 *
 * 这台机器上可能同时装着两个包（v5 与旧包、或两份不同权重的整合包），**用哪一份
 * 不能替用户猜**：`root` 是面板下拉传回来的绝对路径，只做「必须等于探测结果之一」
 * 的匹配，绝不拼接命令行；点了不存在的路径就退回第一处（并在 `requested` 里说明）。
 */
export function pickInstall(installs, wantedRoot) {
  if (!Array.isArray(installs) || installs.length === 0) {
    return { install: null, requested: '' };
  }
  const wanted = typeof wantedRoot === 'string' ? wantedRoot.trim() : '';
  if (wanted === '') return { install: installs[0], requested: '' };
  const key = resolve(wanted).toLowerCase();
  const hit = installs.find((install) => resolve(install.root).toLowerCase() === key);
  return hit ? { install: hit, requested: '' } : { install: installs[0], requested: wanted };
}

/** 带日志文件的分离进程：父进程退出后它继续跑。 */
function defaultSpawnDetached({ command, args, cwd, logPath, env }) {
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env },
    });
    child.on('error', () => {
      // 启动失败在扫描里体现为「端口没起来」；日志文件里有真实原因
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(fd);
  }
}

/** Windows 上按进程树杀：`process.kill` 只杀一层，而 python 可能带子进程。 */
function defaultKill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    return result.status === 0;
  }
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/**
 * 这个 pid 还在吗。`process.kill(pid, 0)` 只做存在性检查、不发信号。
 *
 * `EPERM` 也算在：那说明进程在、只是不归我们这个用户 —— 对「账本里这条还有效吗」
 * 这个问题，答案是「还在」。
 */
export function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 端口上是谁：`netstat -ano` 拿 pid，再问一次命令行。
 *
 * 只读，`spawnSync` 直接给 argv（不过 shell）。拿不到就返回 `null` —— 调用方必须
 * 能接受「不知道是谁」，那时它只会多说一句「不是我起的」。
 */
export function defaultQueryPortOwner(port) {
  if (process.platform !== 'win32') return null;
  const net = spawnSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, encoding: 'utf8' });
  if (net.status !== 0 || typeof net.stdout !== 'string') return null;
  const needle = `:${port}`;
  let pid = 0;
  for (const line of net.stdout.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    const fields = line.trim().split(/\s+/);
    // 形如：TCP  127.0.0.1:9880  0.0.0.0:0  LISTENING  172468
    if (fields.length < 5) continue;
    if (!fields[1].endsWith(needle)) continue;
    const candidate = Number(fields[fields.length - 1]);
    if (Number.isInteger(candidate) && candidate > 0) {
      pid = candidate;
      break;
    }
  }
  if (pid === 0) return null;
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    { windowsHide: true, encoding: 'utf8' },
  );
  const commandLine = ps.status === 0 && typeof ps.stdout === 'string' ? ps.stdout.trim() : '';
  return { pid, commandLine };
}

/**
 * 这一串命令行是不是「本模块 spawn 的引擎」。
 *
 * 逐段对：`api_v2.py`、`-a 127.0.0.1`、`-p <端口>`、`-c GPT_SoVITS\configs\x.yaml`。
 * 只认「像」没用 —— 判据越松，误杀别的 python 的概率越大。
 */
export function matchesEngineCommand(commandLine, port = LOCAL_ENGINE_PORT) {
  if (typeof commandLine !== 'string' || commandLine === '') return false;
  if (!/api_v2\.py/i.test(commandLine)) return false;
  if (!new RegExp(`-a\\s+127\\.0\\.0\\.1\\b`).test(commandLine)) return false;
  if (!new RegExp(`-p\\s+${port}\\b`).test(commandLine)) return false;
  return /gpt_sovits[\\/]+configs[\\/]+[^\\/\s]+\.ya?ml/i.test(commandLine);
}

/** 适配层更简单：命令行里出现「我们那个脚本」即可（脚本名是绝对路径的最后一段）。 */
export function matchesAdapterCommand(commandLine, scriptPath = 'gptsovits-adapter.py') {
  if (typeof commandLine !== 'string' || commandLine === '') return false;
  const base = scriptPath === '' ? 'gptsovits-adapter.py' : scriptPath.split(/[\\/]/).pop();
  return base !== '' && commandLine.toLowerCase().includes(base.toLowerCase());
}


/**
 * 造一个管理器。注入点是 spawn / kill / probe / 存活 / 端口所有者 —— 门禁靠它们
 * 跑假进程，也正是「不要真起一个 GPT-SoVITS 才能测」的前提。
 */
export function createLocalTtsManager(options = {}) {
  const {
    packageRoot = '',
    env = process.env,
    home = homedir(),
    logDir = '',
    /*
     * 适配层的 cwd。它要 `../tools/` 与工作区的 `work/` 都解析得到，所以由调用方
     * 指定（Host 给的是插件包的上一级），而不是这里猜。
     */
    adapterCwd = '',
    /*
     * 候选根目录的覆盖。生产路径永远不传（走 `candidateRoots` 的「环境变量 → 常见
     * 位置 → 家目录」），门禁传它才能在一台**真的装着两个 GPT-SoVITS** 的机器上
     * 断言「没装是什么样」——否则那些常见位置会把测试借来的临时目录淹掉。
     */
    roots: rootsOverride = null,
    /*
     * 「我起过什么」的落盘位置。生产路径给 `<DSH_HOME>/live2d-pet/local-tts-processes.json`，
     * 空串 = 不落盘（门禁里的纯内存用例）。写失败只影响「重启后还认不认」，不影响停止。
     */
    statePath = '',
    spawnDetached = defaultSpawnDetached,
    killProcess = defaultKill,
    tcpProbe = probePort,
    isAlive = defaultIsAlive,
    queryPortOwner = defaultQueryPortOwner,
    existsSync: existsSyncImpl = existsSync,
    now = Date.now,
  } = options;

  /** 我们起过的进程：name → { pid, port, startedAt, source, command }。 */
  const managed = new Map();
  const adapterScript = defaultAdapterScript(packageRoot, env);
  let ledgerLoaded = false;

  /**
   * 落盘的「我起过什么」。
   *
   * 为什么需要它：这份状态原本只在内存里，而 DSH 每改一次 Host 就重启一次 ——
   * 重启后 `stop` 会对着**还在跑的自己拉起的服务**说「没有需要停的」，用户看到的
   * 是「面板在骗我」（§13.24 的真机反馈）。pid 落到磁盘上，「重启」就只是重启，
   * 不再是「所有权丢失」。
   *
   * 读失败一律当空账：这是旁路状态，坏掉不该让面板打不开。
   */
  function loadLedger() {
    if (ledgerLoaded) return;
    ledgerLoaded = true;
    if (statePath === '' || !existsSyncImpl(statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      const entries = parsed?.entries ?? {};
      for (const [name, entry] of Object.entries(entries)) {
        if (name !== 'engine' && name !== 'adapter') continue;
        if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0) continue;
        if (managed.has(name)) continue;
        managed.set(name, {
          pid: entry.pid,
          port: Number.isInteger(entry.port) ? entry.port : (name === 'engine' ? LOCAL_ENGINE_PORT : LOCAL_ADAPTER_PORT),
          startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : 0,
          command: typeof entry.command === 'string' ? entry.command : '',
          source: 'ledger',
        });
      }
    } catch {
      // 坏文件不阻塞：下一次 start 会把它整个覆盖掉
    }
  }

  /** 原子写：先写 `.tmp` 再 rename，断电也只会留下旧账本。 */
  function saveLedger() {
    if (statePath === '') return;
    const entries = {};
    for (const [name, entry] of managed) {
      entries[name] = {
        pid: entry.pid,
        port: entry.port,
        startedAt: entry.startedAt,
        command: entry.command ?? '',
      };
    }
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: LEDGER_VERSION, entries }, null, 2)}\n`, 'utf8');
      renameSync(tmp, statePath);
    } catch {
      // 写不进去就退回内存：停止仍然可用，只是重启后会丢
    }
  }

  /** 内存 + 磁盘的合一视图（谁先有算谁）。 */
  function entryOf(name) {
    loadLedger();
    return managed.get(name);
  }

  async function scan({ config, root: wantedRoot } = {}) {
    const roots = Array.isArray(rootsOverride) && rootsOverride.length > 0
      ? rootsOverride
      : candidateRoots({ env, home });
    const installs = findInstalls({ roots, existsSync: existsSyncImpl });
    const [engineListening, adapterListening] = await Promise.all([
      tcpProbe(LOCAL_ENGINE_PORT),
      tcpProbe(LOCAL_ADAPTER_PORT),
    ]);
    const picked = pickInstall(installs, wantedRoot);
    const chosen = picked.install;
    const engineEntry = entryOf('engine');
    const adapterEntry = entryOf('adapter');
    return {
      ports: {
        engine: { port: LOCAL_ENGINE_PORT, listening: engineListening },
        adapter: { port: LOCAL_ADAPTER_PORT, listening: adapterListening },
      },
      installs: installs.map((install) => ({
        root: install.root,
        python: install.python,
        api: install.api,
        configs: install.configs,
        config: pickConfig(install, config),
      })),
      adapter: {
        script: adapterScript,
        exists: adapterScript !== '' && existsSyncImpl(adapterScript),
      },
      suggestedEndpoint: LOCAL_ADAPTER_ENDPOINT,
      selected: chosen === null ? null : {
        root: chosen.root,
        config: pickConfig(chosen, config),
      },
      /* 面板传了一个不在探测结果里的 root：说清楚退回了哪一处，别静默。 */
      requestedRoot: picked.requested,
      managed: {
        engine: engineEntry?.pid ?? null,
        adapter: adapterEntry?.pid ?? null,
      },
      /* 「这是我起的」是哪一层认的：managed / ledger / null（面板据此说明白）。 */
      managedSource: {
        engine: engineEntry?.source ?? null,
        adapter: adapterEntry?.source ?? null,
      },
      scannedAt: now(),
    };
  }

  function startEngine(install, configName) {
    if (install === null) {
      return { ok: false, code: 'E_LOCAL_TTS_NO_INSTALL', message: '没有找到 GPT-SoVITS 的安装目录（可以用环境变量 DSH_GSV_ROOT 指过去）' };
    }
    if (install.python === '') {
      return { ok: false, code: 'E_LOCAL_TTS_NO_PYTHON', message: `这个目录里没有 runtime\\python.exe：${install.root}` };
    }
    const config = pickConfig(install, configName);
    if (config === '') {
      return { ok: false, code: 'E_LOCAL_TTS_NO_CONFIG', message: `这个目录里没有 GPT_SoVITS\\configs 下的 yaml：${install.root}` };
    }
    const args = ['api_v2.py', '-a', '127.0.0.1', '-p', String(LOCAL_ENGINE_PORT), '-c', join('GPT_SoVITS', 'configs', config)];
    const pid = spawnDetached({
      command: install.python,
      args,
      cwd: install.root,
      logPath: join(logDir === '' ? install.root : logDir, 'local-tts-engine.log'),
    });
    if (pid === null) {
      return { ok: false, code: 'E_LOCAL_TTS_SPAWN_FAILED', message: '启动 GPT-SoVITS 失败（看日志）' };
    }
    managed.set('engine', {
      pid,
      port: LOCAL_ENGINE_PORT,
      startedAt: now(),
      source: 'managed',
      /* 记整串命令行：重启后认领（`adopted`）与自查都用得上 */
      command: `${install.python} ${args.join(' ')}`,
    });
    saveLedger();
    return { ok: true, name: 'engine', pid, port: LOCAL_ENGINE_PORT, config, root: install.root };
  }

  function startAdapter(pythonCommand, cwd) {
    if (adapterScript === '' || !existsSyncImpl(adapterScript)) {
      return { ok: false, code: 'E_LOCAL_TTS_NO_ADAPTER', message: `没有找到适配层脚本：${adapterScript === '' ? '(未解析出路径)' : adapterScript}` };
    }
    const command = pythonCommand !== '' && existsSyncImpl(pythonCommand) ? pythonCommand : 'python';
    const pid = spawnDetached({
      command,
      args: [adapterScript],
      cwd,
      logPath: join(logDir === '' ? cwd : logDir, 'local-tts-adapter.log'),
    });
    if (pid === null) {
      return { ok: false, code: 'E_LOCAL_TTS_SPAWN_FAILED', message: '启动适配层失败（看日志）' };
    }
    managed.set('adapter', {
      pid,
      port: LOCAL_ADAPTER_PORT,
      startedAt: now(),
      source: 'managed',
      command: `${command} ${adapterScript}`,
    });
    saveLedger();
    return { ok: true, name: 'adapter', pid, port: LOCAL_ADAPTER_PORT };
  }

  /**
   * 启动。`target` 只认三选一；`config` 是 yaml 文件名，`root` 是探测到的安装路径之一
   * ——两个都只用来**在已知清单里挑**，绝不是命令行片段。
   */
  async function start({ target = 'all', config = '', root: wantedRoot = '', adapterCwd: adapterCwdArg = '' } = {}) {
    if (target !== 'all' && target !== 'engine' && target !== 'adapter') {
      return { ok: false, code: 'E_LOCAL_TTS_BAD_TARGET', message: 'target 只能是 all / engine / adapter' };
    }
    const before = await scan({ config, root: wantedRoot });
    if (target !== 'adapter' && before.ports.engine.listening) {
      const mine = before.managed.engine;
      return {
        ok: false,
        code: 'E_LOCAL_TTS_ALREADY_RUNNING',
        message: `${LOCAL_ENGINE_PORT} 端口已经有服务在跑${
          mine === null ? '' : `（pid ${mine}：就是我自己起的那一个${before.managedSource.engine === 'ledger' ? '，上次 DSH 关闭前起的' : ''}）`
        }，没有重复启动`,
      };
    }
    if (target !== 'engine' && before.ports.adapter.listening) {
      const mine = before.managed.adapter;
      return {
        ok: false,
        code: 'E_LOCAL_TTS_ALREADY_RUNNING',
        message: `${LOCAL_ADAPTER_PORT} 端口已经有服务在跑${
          mine === null ? '' : `（pid ${mine}：就是我自己起的那一个${before.managedSource.adapter === 'ledger' ? '，上次 DSH 关闭前起的' : ''}）`
        }，没有重复启动`,
      };
    }
    const pickedInstall = pickInstall(before.installs, wantedRoot);
    if (pickedInstall.requested !== '') {
      /* 传了不认识的 root：拒绝比静默换成另一处更好——用户会以为用的是他挑的那份权重。 */
      return {
        ok: false,
        code: 'E_LOCAL_TTS_BAD_ROOT',
        message: '指定的安装目录不在探测结果里（先点「检测本机」看看它认得哪些）',
        detail: pickedInstall.requested,
      };
    }
    const install = pickedInstall.install === null
      ? null
      : {
        root: pickedInstall.install.root,
        python: pickedInstall.install.python,
        api: pickedInstall.install.api,
        configs: pickedInstall.install.configs,
      };
    const started = [];
    if (target !== 'adapter') {
      const result = startEngine(install, config);
      if (!result.ok) return result;
      started.push(result);
    }
    if (target !== 'engine') {
      const python = install === null ? '' : install.python;
      const cwd = adapterCwdArg !== ''
        ? adapterCwdArg
        : (adapterCwd !== '' ? adapterCwd : (install === null ? process.cwd() : install.root));
      const result = startAdapter(python, cwd);
      if (!result.ok) {
        // 引擎已经起来了就把它停掉，避免留下一个孤儿进程（用户下一步会重试）
        if (started.length > 0) stop({ target: 'engine' });
        return result;
      }
      started.push(result);
    }
    return { ok: true, started };
  }

  /**
   * 停止。三层依次判「这是不是我们起的」，见模块头。
   *
   * 异步的原因只有一条：第 3 层要问一句「端口上那个 pid 的命令行是什么」，
   * 那是 `netstat` + 一次 PowerShell，几十到几百毫秒 —— 它只在**前两层都没有记录、
   * 而端口确实在听**时才发生，正常路径不会多花一毫秒。
   */
  async function stop({ target = 'all' } = {}) {
    if (target !== 'all' && target !== 'engine' && target !== 'adapter') {
      return { ok: false, code: 'E_LOCAL_TTS_BAD_TARGET', message: 'target 只能是 all / engine / adapter' };
    }
    const names = target === 'all' ? ['engine', 'adapter'] : [target];
    const stopped = [];
    const skipped = [];
    let changed = false;
    for (const name of names) {
      const port = name === 'engine' ? LOCAL_ENGINE_PORT : LOCAL_ADAPTER_PORT;
      const entry = entryOf(name);
      if (entry !== undefined) {
        /* 账本里的 pid 可能早就没了（用户自己在任务管理器里关过）：别杀一个复用了它的进程 */
        if (!isAlive(entry.pid)) {
          managed.delete(name);
          changed = true;
          skipped.push({ name, port, reason: 'pid-gone', pid: entry.pid });
          continue;
        }
        killProcess(entry.pid);
        managed.delete(name);
        changed = true;
        stopped.push({ name, port, pid: entry.pid, source: entry.source ?? 'managed' });
        continue;
      }
      const listening = await tcpProbe(port);
      const owner = listening ? queryPortOwner(port) : null;
      const ours = owner !== null
        && (name === 'engine'
          ? matchesEngineCommand(owner.commandLine, port)
          : matchesAdapterCommand(owner.commandLine, adapterScript));
      if (ours) {
        killProcess(owner.pid);
        stopped.push({ name, port, pid: owner.pid, source: 'adopted', command: owner.commandLine });
        continue;
      }
      /*
       * `pid` / `portListening` / `command` 一起回去：面板要能说「9880 上有个
       * pid 172468，命令行是 node xxx.js，不是我起的」——只说「没有需要停的」
       * 正是 §13.24 那次被当成反话的原句。
       */
      skipped.push({
        name,
        port,
        reason: 'not-managed',
        pid: owner?.pid ?? null,
        portListening: listening,
        command: owner?.commandLine ?? '',
      });
    }
    if (changed) saveLedger();
    return { ok: true, stopped, skipped };
  }

  return { scan, start, stop, adapterScript, managed: () => { loadLedger(); return new Map(managed); } };
}
