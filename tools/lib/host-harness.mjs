/**
 * 在 Node 里把 Host 半区**真跑起来**的共用件。
 *
 * 抽出来的理由：`simulate-host-boot.mjs` 与 `test-action-chain.mjs` 都要做同一件事
 * ——「造一个假的 Cordis 上下文 → 执行 `apply` → 拿到注册进来的路由并挂到真的 http
 * 服务器上 → 通过 `env.tools` 调 Agent 工具」。
 *
 * 这一段如果各写一份，两份的**假上下文宽容度**迟早会分叉，而那份宽容度正是这套门禁
 * 唯一的防线：宽容版的上下文会让「插件用了宿主没提供的 API」这种错误在门禁里静默通过，
 * 到了真机才 `not a function`。见方案 §9.3。
 *
 * 于是这里**故意不做宽容版**：只实现 Host 半区真正用到的成员，缺什么就抛什么。
 */

import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // …/tools/lib
const TOOLS_DIR = resolve(here, '..'); // …/tools
/** 工作区根目录（`tools/` 的上一级）。 */
export const PROJECT_ROOT = resolve(TOOLS_DIR, '..');

/** 路由前缀。Host 半区把全部路由都挂在它下面，门禁里的 URL 拼接也只用它。 */
export const ROUTE_PREFIX = '/.dsh-live2d-pet';

/** Host 半区入口的**绝对路径**。用绝对路径而不是相对 URL，免得跟着调用方文件位置漂。 */
export const PLUGIN_ENTRY_PATH = join(PROJECT_ROOT, 'dsh-live2d-pet', 'lib', 'index.js');

/**
 * 造一个最小的 Cordis 上下文。
 *
 * 只实现 Host 半区真正用到的成员。**故意不做「宽容版」**：如果插件以后用了这里
 * 没实现的 API，这里会抛 `not a function` 而不是静默通过 —— 那种静默正是让
 * 「本地全绿、重启就崩」得以发生的原因。
 *
 * @param {{ services?: Record<string, unknown> }} [options]
 *   `services` 用来注入**宿主服务**（`ctx.get(name)` 会拿到的那些）。
 *   默认什么都不给：真实的 Host 在没有渲染端、没有 Agent 树时就是这个样子，
 *   而插件必须在那样的环境里也能活着 —— 这本身就是要验的一条。
 */
export function createMockContext(options = {}) {
  const logs = [];
  const registrations = [];
  const effects = [];
  const provided = new Map();
  const tools = [];
  const listeners = new Map();
  const services = options.services ?? {};

  const ctx = {
    logger: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
      error: (message) => logs.push(`error: ${message}`),
    },
    effect(callback, label) {
      const dispose = callback();
      effects.push({ label, dispose });
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    get(name) {
      if (name === 'tools') {
        return {
          register(spec) {
            tools.push(spec);
          },
        };
      }
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name];
      return undefined;
    },
    /**
     * 事件订阅。
     *
     * 真 Host 的 `ctx.on` 返回**退订函数**，插件把它交给 `ctx.effect` 的清理函数
     * （见 `lib/index.js` 的 `live2d-pet.host.emotion-stream`）—— 所以这里必须
     * 返回一个**真的能退订**的函数，否则「卸载后还在推情绪」这种泄漏在门禁里
     * 看不见。`listeners` 对外可见，就是为了让门禁能断言退订真的发生了。
     */
    on(event, handler) {
      if (typeof handler !== 'function') {
        throw new TypeError(`ctx.on(${JSON.stringify(event)}) 需要一个函数`);
      }
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== handler));
      };
    },
    provide(name, api) {
      provided.set(name, api);
    },
    webServer: {
      register(options) {
        const entry = { ...options, disposed: false };
        registrations.push(entry);
        return () => {
          entry.disposed = true;
        };
      },
    },
  };

  /** 门禁用它驱动事件：`env.emit('agent/assistant-stream', { agent, frame })`。 */
  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  };

  return { ctx, logs, registrations, effects, provided, tools, listeners, emit };
}

/** 把注册进来的 handler 挂到一个真的 http 服务器上。 */
export function mountHandler(handler) {
  const server = createServer((req, res) => {
    if (!(req.url ?? '').startsWith(ROUTE_PREFIX)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not mounted');
      return;
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ code: 'E_GATE_HANDLER_THREW', message: String(error?.message ?? error) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * 导入 Host 半区、`apply`、挂路由 —— 一步到位。
 *
 * **调用方必须自己传 `modelsRoot`**，而且必须是临时目录。这里不提供默认值：
 * 插件的 `resolveModelsRoot()` 有四条显式来源 + 一条「仓库自带模型」兜底，最后一级
 * 是用户 `settings.json` 里的**真实模型库**。给它一个默认值就等于给「门禁弄脏用户
 * 数据」留了一条默认路径 —— 那件事已经真实发生过一次（方案 §9.4）。少一个默认值，
 * 多一次强迫思考。
 *
 * @returns {Promise<{ mod, env, api, server, port, base, close }>}
 */
export async function bootHost({ modelsRoot, maxFps = 60, config, services } = {}) {
  if (typeof modelsRoot !== 'string' || modelsRoot === '') {
    throw new Error('bootHost() 必须显式传一个临时 modelsRoot —— 见方案 §9.4');
  }

  const mod = await import(pathToFileURL(PLUGIN_ENTRY_PATH).href);
  const env = createMockContext({ services });
  const api = mod.apply(env.ctx, config ?? { maxFps, modelsRoot });

  const registration = env.registrations[0];
  if (registration === undefined) {
    throw new Error('apply() 没有注册任何路由 —— 后面什么都验不了');
  }

  const { server, port } = await mountHandler(registration.handler);
  const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`;

  return {
    mod,
    env,
    api,
    server,
    port,
    base,
    /** 卸载：关服务器 + 跑 dispose effect。调用方仍要自己删临时目录。 */
    async close() {
      await new Promise((resolve) => server.close(resolve));
      for (const effect of env.effects) {
        if (typeof effect.dispose === 'function') effect.dispose();
      }
    },
  };
}

/** 便捷：从 `env.tools` 里按名字取工具，取不到直接抛（名字写错应该当场红，不是静默 null）。 */
export function toolByName(env, name) {
  const spec = env.tools.find((t) => t.name === name);
  if (spec === undefined) {
    throw new Error(`没有注册名为 ${name} 的工具（已注册：${env.tools.map((t) => t.name).join(', ')}）`);
  }
  return spec;
}

/** 便捷：POST 一段 JSON 到 Host 路由，返回 `{ status, json }`。 */
export async function postJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 便捷：GET 一段 JSON，返回 `{ status, json }`。 */
export async function getJson(base, path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) };
}
