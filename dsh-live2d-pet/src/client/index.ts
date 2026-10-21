/**
 * dsh-live2d-pet — Client（浏览器）半区的入口。
 *
 * 这个文件只做一件事：把 `createClientPlugin()` 挂到 DSH 的模块加载器上。
 * 之所以要包一层，是因为**产物形状是 DSH 的既有约定**（从已装插件实证，
 * 不是猜的）：
 *
 *   window.__ModuleLoader__.load({
 *     id: '包名',
 *     factory: (require) => ({ name, inject, apply }),
 *   })
 *
 * 三条约束写在下面，改动前请先读：
 *
 *  1. bundle 是**经典脚本**（esbuild `format: 'iife'`），不是 ESM。DSH 的模块表
 *     只为 react / react-dom/client 播种，没有 import map，ESM 产物必炸。
 *  2. `<script>` 语境下裸标识符 `require` 并不存在——它是 `factory` 的**参数**。
 *     所以任何要用 React 的代码都必须写成「拿到 require 之后再建」，不能在模块
 *     顶层 import React。
 *  3. `name` 必须与 `cordis.patch.yml` 的行 id、`package.json` 的 name 三处一致。
 *
 * 失败策略是刻意的：**任何在这里抛出的异常都会把整个应用拖下水**（client bundle
 * 在工厂里抛错 → entry 变 failed → 外壳的启动审计拒绝启动）。所以 require(react)
 * 失败时降级成一个「什么都不做的合法插件」，而不是让桌宠有能力弄坏用户的界面。
 */

import { createClientPlugin } from './plugin';
import type { ClientPlugin, ReactLike } from './plugin';
import { reportFailure } from './report';

interface ModuleLoaderSpec {
  id: string;
  factory: (require: (id: string) => unknown) => unknown;
}

declare global {
  interface Window {
    __ModuleLoader__?: { load(spec: ModuleLoaderSpec): void };
    __LIVE2D_BUILD_ID__?: string;
  }
}

/** 构建号，由 build.mjs 通过 esbuild 的 define 注入；开发期回落到 'dev'。 */
declare const __LIVE2D_BUILD_ID__: string | undefined;
const BUILD_ID: string = typeof __LIVE2D_BUILD_ID__ === 'string' ? __LIVE2D_BUILD_ID__ : 'dev';

const PLUGIN_NAME = 'dsh-live2d-pet';

/** 降级插件：合法、可加载、什么都不做。 */
function inertPlugin(): ClientPlugin {
  return { name: PLUGIN_NAME, inject: [], apply: () => {} };
}

function boot(): void {
  const loader = window.__ModuleLoader__;
  if (loader === undefined || typeof loader.load !== 'function') {
    // 没有加载器说明我们不在 DSH 的渲染进程里（例如被误当成普通脚本引入）。
    // 这里没有任何可用的上报通道，直接放弃。
    return;
  }

  loader.load({
    id: PLUGIN_NAME,
    factory: (require) => {
      let react: ReactLike;
      try {
        react = require('react') as ReactLike;
      } catch (error) {
        reportFailure('require(react)', error);
        return inertPlugin();
      }

      if (react === null || typeof react.createElement !== 'function') {
        reportFailure('require(react)', new Error('react 模块存在但没有 createElement'));
        return inertPlugin();
      }

      try {
        return createClientPlugin(react, BUILD_ID);
      } catch (error) {
        reportFailure('createClientPlugin', error);
        return inertPlugin();
      }
    },
  });
}

boot();
