# dsh-live2d-pet

**给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的 Live2D 桌宠插件。** 把一只会呼吸、
会眨眼、会说话（口型同步）、有情绪、会自己动一下的 Live2D 模型放进 DSH 的 Web 界面，
并把「说话 / 演表情 / 演动作 / 转头 / 写参数」做成 Agent 可以调用的工具。

> 这不是独立应用，是 DSH 的插件（Host 半区 + Client 半区），装进一个 DSH profile 之后才有界面。

## 功能

| 能力 | 说明 |
| --- | --- |
| 舞台渲染 | WebGL / Cubism Web Framework，透明叠加在 DSH 界面上；可全屏、可收起 |
| 模型库 | 导入 `.zip` / `.rar`、切换模型、坏包体检（缺贴图/缺 moc3/入口不对会说清） |
| 口型同步 | Edge 在线 TTS（免密钥）与本地 GPT-SoVITS 两条路；音量包络驱动 `ParamMouthOpenY` |
| 情绪 | 9 个具名情绪（开心/好奇/思考/认真/惊讶/抱歉/难过/得意/平静）+ 指数余温 + 同族余波 + 静息漂移 |
| 微动作 | 按模型自己的参数**自动生成** 16 条小动作（歪头、侧身、瞥一眼、耸肩、叹气…），多段错峰、待机/说话两档节奏、按情绪加权 |
| 参数实测 | 逐根参数推一下、读像素，判断「哪些参数写了也不会动」；缺部位自动借力（没有肩膀就用身体倾斜补） |
| 和桌宠对话 | 桌宠卡片上打字 → 进当前会话 → AI 想台词 → **只用她的声音说出来**，面板同步显示 |
| Agent 工具 | `live2d_status` / `live2d_speak` / `live2d_emote` / `live2d_play_motion` / `live2d_set_expression` / `live2d_look_at` / `live2d_param` / `live2d_micro_motion` / `live2d_list_capabilities` / `live2d_stop_speaking` |
| 设置页 | 「设置 → Live2D 桌宠」：模型库、音色、参数绑定、口型与字幕；桌宠卡片只留「看她」 |

## 环境要求

- [DeepSeek Harness](https://github.com/deepseek-ai) `>= 0.1.5-rc.1`（本插件用到的 `dsh.bundle` 与 Client slot 机制）
- Node.js `>= 22`（Host 半区用到 `node:zlib` 的 zstd、`node:test` 等）
- 浏览器端需要 WebGL2（DSH Web 界面所在的那台机器）

## 安装

四步。下面以 Windows + 默认 profile `desktop` 为例，路径按你的实际位置改。

```bash
git clone https://github.com/zza66/dsh-live2d-pet.git
cd dsh-live2d-pet/dsh-live2d-pet
npm install          # 只为装 ws（Edge-TTS 要发自定义请求头）；客户端 bundle 已在仓库里
```

1. 打开 profile 的 `package.json`（Windows：`C:\Users\<你>\.dsh\profiles\desktop\package.json`，
   macOS / Linux：`~/.dsh/profiles/desktop/package.json`）；
2. 在 `dependencies` 里加一行，**指向插件目录**（不是仓库根）：

   ```json
   "dsh-live2d-pet": "link:D:/path/to/dsh-live2d-pet/dsh-live2d-pet"
   ```

   > Windows 上路径用正斜杠（`D:/...`）最省事；反斜杠要写两遍（`D:\\...`）。
3. 在同一个文件的 `dsh.profile.bundles` 数组里加一个 `"dsh-live2d-pet"`；
4. 在**该 profile 目录**下安装依赖 —— DSH 的 profile 用 pnpm 管，就用 pnpm；你自己的环境是
   npm 管的就换 `npm install`：

   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm install
   ```

5. 重启 DSH（`dsh web`），刷新页面。

装对了的话：界面**右下角**出现桌宠卡片；`设置 → Live2D 桌宠` 里有模型库、音色、参数绑定。

### 装不上时按这个顺序查

| 现象 | 先看什么 |
| --- | --- |
| 完全没有卡片 | profile 的 `dsh.profile.bundles` 里有没有 `"dsh-live2d-pet"`；重启过没有 |
| 卡片在但一直是空的 / 报 `E_PLUGIN_ASSET` | 插件目录里的 `lib/client.js` 在不在（clone 后应自带） |
| 启动报 `Cannot find package 'ws'` | 忘了在 `dsh-live2d-pet/dsh-live2d-pet` 里 `npm install` |
| `link:` 装完 `node_modules/dsh-live2d-pet` 不存在 | profile 目录里没跑 `pnpm install`（或 `npm install`） |
| 有卡片、模型库为空 | 第一次启动应显示 `bundled`；若你之前建过 `<DSH_HOME>/live2d-pet/models`，它优先 |
| 说话没声音 | 默认走 Edge 在线 TTS，需要能访问 `speech.platform.bing.com`；离线环境请配本地 GPT-SoVITS |

## 第一次启动：自带一只 Hiyori

仓库里带了 Live2D 官方样例模型 **Hiyori**（`models-inbox/hiyori_vts/`），
第一次启动时模型库来源会显示 `bundled`，直接就能看到一只会动的模型。

- 想换成自己的模型：**设置 → Live2D 桌宠 → 模型库**，把 `.zip` / `.rar` 拖进去即可；
- 一旦你导入过模型（或自己建了 `<DSH_HOME>/live2d-pet/models`），插件就改用你自己的库，
  仓库里那只不会再挡路；
- 模型库路径的解析优先级：`config.modelsRoot` → 环境变量 `DSH_LIVE2D_MODELS_ROOT` →
  `<DSH_HOME>/live2d-pet/settings.json` 的 `modelsRoot` → `<DSH_HOME>/live2d-pet/models` →
  仓库自带 `models-inbox`。

> Hiyori 的版权与条款见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)。

## 语音

- **默认**：Edge 在线 TTS（`zh-CN-XiaoxiaoNeural` 等），免密钥，合成后只在本机播放、不落盘；
- **可选**：本地 GPT-SoVITS 引擎。仓库只带适配器 `tools/gptsovits-adapter.py` 与调用逻辑，
  **不含任何训练好的语音包**；音色包需自己训练后放到 `<DSH_HOME>/live2d-pet/voice-packs/`；
- 面板上可以点小喇叭让某一句只念不说，也可以让 AI 用 `live2d_speak` 说。

## 和桌宠对话

桌宠卡片底部有一个输入框：

1. 你打一句话 → 经 Host 注入**当前会话**（带 `[桌宠对话]` 前缀）；
2. Agent 被一条**动态运行时上下文**要求「这一轮用 `live2d_speak` 回答，1–2 句口语」，
   也可以先演一个动作/表情再说话；
3. Host 在指令入队那一刻把这句话记进对话账本（`<DSH_HOME>/live2d-pet/pet-chat.json`），
   卡片两秒级轮询显示出来。

诚实的边界：每句话 = 一次真实的模型回合，所以它和你在会话里说话一样慢；
面板拿不到会话服务（旧版 DSH）时会明确报错，而不是装作没发生。

## 目录结构

```
.
├─ dsh-live2d-pet/          # 插件本体（Host: lib/ · Client: src/ · 构建: build.mjs）
│  ├─ lib/host/             # 纯逻辑：能力清单、情绪、微动作、导入、TTS…
│  ├─ lib/client.js         # 构建产物（客户端 bundle）
│  ├─ framework/            # Cubism Web Framework（有少量本地改动）
│  └─ vendor/cubism/        # Cubism Core（闭源，可再分发文件）
├─ models-inbox/hiyori_vts/ # 自带的样例模型
├─ tools/                   # 门禁（纯逻辑 + 真机路由 + 模拟启动）
└─ THIRD-PARTY-LICENSES.md
```

## 开发与门禁

```bash
cd dsh-live2d-pet
node build.mjs                 # 构建客户端 bundle（含测试用产物 lib/test/*.mjs）
node node_modules/typescript/bin/tsc --noEmit
cd ..
node tools/verify-all.mjs --no-live   # 45 条门禁（两条需要真机运行中的 DSH，会跳过）
```

门禁分三类：纯逻辑断言、源码接线对账（防「改了一处忘了另一处」）、活体 HTTP 路由
（起一个临时 Host，打真接口）。仓库里只带了一只样例模型，个别需要其它模型素材的断言会自己跳过。

## 已知限制

- 只做了 Web（`platform: web`），没有 Electron 原生窗口版本；
- 参数实测需要能从画布读像素，因此「探测的那一两秒」会暂时不画她（显示「正在校准关节…」）；
- 不是所有模型都能动：如果某个模型的标准参数（`ParamAngle*` / `ParamBodyAngle*`）没接骨架，
  硬写参数也不会动 —— 这不是插件的问题，插件会把这些参数标成「死的」并试着借力；
- 语音包一律不带，避免把某个人声的训练权重顺手分发出去。

## 许可

- 本仓库作者的代码：**MIT**（见 [LICENSE](LICENSE)）
- Live2D Cubism Core / Cubism Web Framework / 样例模型 Hiyori：各自的条款，
  见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)

商业使用请先读一遍 Cubism SDK 的 Release License 条款（上一财年营业额超过 1000 万日元
的事业者需要另行取得授权）。
