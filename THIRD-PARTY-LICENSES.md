# 第三方许可

本仓库代码是 MIT（见 `LICENSE`），但下面这些**第三方材料**不属于 MIT，各有自己的条款。
把它们放进仓库是为了「克隆下来就能跑」，不代表它们可以按 MIT 再分发。

## 1. Live2D Cubism Core

- 文件：`dsh-live2d-pet/vendor/cubism/live2dcubismcore.min.js`、`live2dcubismcore.d.ts`
- 许可：**Live2D Proprietary Software License**
  - <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- 依据：同目录的 `RedistributableFiles.txt` 明确列出 `live2dcubismcore.min.js / .js / .d.ts`
  属于「可在本许可下再分发的文件」，所以仓库里带上了它们。
- 注意：Core 是闭源二进制 / WebAssembly，**不要修改它**；它不是 MIT。

## 2. Live2D Cubism Web Framework

- 文件：`dsh-live2d-pet/framework/src/**`（含本仓库为帧循环与动作优先级做的小改动）
- 许可：**Live2D Open Software License** + 部分文件适用 **Live2D Proprietary Software License**
  - <https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html>
  - <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- 依据：框架随 Cubism SDK 分发，`framework/LICENSE-Framework.md` 原文随附。

> **商业使用请自行确认。** Cubism SDK 的 Release License 要求：上一财年营业额超过
> 1000 万日元的事业者需要另行取得 Cubism SDK Release License。
> <https://www.live2d.com/en/download/cubism-sdk/release-license/>

## 3. 样例模型 Hiyori

- 文件：`models-inbox/hiyori_vts/**`（`hiyori.moc3`、贴图、动画、物理、`hiyori.vtube.json` 等）
- 版权：© Live2D Inc. —— Live2D 官方样例模型（Hiyori）
- 条款：**Live2D Sample Model Terms of Use / Free Material License**
  - <https://www.live2d.com/eula/live2d-sample-model-terms_en.html>
  - <https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html>
- 本仓库只把它当作「开箱就能看到一只会动的模型」的演示素材，模型本身**不适用 MIT**。
  如果你是 Live2D Inc. 并认为这里的再分发不妥，请开 issue，我会立刻移除
  `models-inbox/hiyori_vts/` 并改成「运行时下载」的方式。

## 4. 语音：Microsoft Edge 在线 TTS

- 代码：`dsh-live2d-pet/lib/host/edge-tts.js`（自己实现 WebSocket 客户端）
- 说明：调用的是 Edge 浏览器的在线朗读服务，**不需要密钥**，但它是微软的服务，
  使用前请自行确认你的使用场景符合其条款。合成出来的音频只在本机播放、不落盘。

## 5. 本地 TTS：GPT-SoVITS

- 代码：`tools/gptsovits-adapter.py`（适配层，作者原创，MIT）
- 说明：真正的推理引擎是 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（MIT），
  **不在本仓库内**，需要自己安装。本仓库**不包含任何训练好的语音包/音色权重**。
