#!/usr/bin/env node
/**
 * 一把梭门禁：把项目里所有「可以自己验证自己」的检查串起来跑一遍。
 *
 *   node tools/verify-all.mjs          只跑离线检查（不联网、几秒钟）
 *   node tools/verify-all.mjs --live   额外跑 Edge-TTS 真实连通（需要联网，约 3–10 秒）
 *
 * 每条门禁都是独立进程、独立退出码；这里只汇总结果，不吞任何输出 ——
 * 子进程用 `stdio: 'inherit'` 直接接管终端，你看到的报错就是原始报错。
 *
 * 之所以要有这个脚本：这个项目的关键前提（模型能被官方 Core 解析、Edge-TTS 的令牌
 * 算法没算错、口型包络的形状对）全都是**容易悄悄坏掉**的东西 —— 上游 CDN 换版本、
 * 微软改协议、平滑参数被改坏，都不会有编译错误。一条命令跑完是最省事的回归手段。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS_DIR, '..');
const LIVE = process.argv.includes('--live');

const CORE = join(ROOT, 'vendor', 'cubism', 'live2dcubismcore.min.js');

/**
 * 找一只 `.moc3` 给「Cubism Core 能不能加载」那条门禁当样本。
 *
 * 为什么不再写死一个路径：这里原来写的是 `models-inbox/空_vts/空 - 免费版.moc3`，
 * 而 `models-inbox` 是**用户的目录** —— 用户换一批模型，那条门禁就静悄悄地红了
 * （`[FAILED] core (exit 1)`），看起来像 Cubism Core 坏了。
 * 我修别的东西时撞上它，第一反应就是「我是不是把 Core 弄坏了」。
 *
 * 门禁依赖的样本必须放在**用户不会动的地方**。优先级：
 *   1. 官方 SDK 样本（`work/sdk5/...`，只读，跟仓库一起进来）；
 *   2. 用户库里任何一个 `.moc3`（用户加了模型就能跑，没有也不影响前一条）。
 *
 * @returns {string} 找不到时返回空串，调用方据此把那条门禁标成 skipped。
 */
function findMoc3Sample() {
  const samples = join(ROOT, 'work', 'sdk5', 'CubismSdkForWeb-5-r.5', 'Samples', 'Resources');
  if (existsSync(samples)) {
    for (const name of readdirSync(samples)) {
      const candidate = join(samples, name, `${name}.moc3`);
      if (existsSync(candidate)) return candidate;
    }
  }
  const inbox = join(ROOT, 'models-inbox');
  if (existsSync(inbox)) {
    for (const dir of readdirSync(inbox)) {
      const full = join(inbox, dir);
      let names = [];
      try {
        if (!statSync(full).isDirectory()) continue;
        names = readdirSync(full);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.toLowerCase().endsWith('.moc3')) return join(full, name);
      }
    }
  }
  return '';
}

const MODEL = findMoc3Sample();

/**
 * @type {{
 *   id:string, title:string, script:string,
 *   args:string[]|((live:boolean)=>string[]),
 *   nodeArgs:string[], cwd?:string, live?:boolean, optional?:string,
 *   soft?:boolean, requires?:'dsh'
 * }[]}
 */
const GATES = [
  {
    id: 'types',
    title: 'TypeScript 类型检查（esbuild 只剥类型，方法名写错它不管）',
    script: 'node_modules/typescript/bin/tsc',
    args: ['--noEmit'],
    nodeArgs: [],
    cwd: join(ROOT, 'dsh-live2d-pet'),
    // 只有装过 devDependencies 才有 tsc；没装就跳过而不是报失败。
    optional: join(ROOT, 'dsh-live2d-pet', 'node_modules', 'typescript', 'bin', 'tsc'),
  },
  {
    id: 'boot',
    title: '★ 客户端加载自检（工厂不抛 → 外壳才不会白屏）',
    script: 'simulate-client-boot.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'hostboot',
    title: '★ Host 加载自检（假 Cordis 上下文 + 真 http 服务器跑完整路由断言）',
    script: 'simulate-host-boot.mjs',
    args: (live) => (live ? [] : ['--no-live']),
    nodeArgs: [],
  },
  {
    id: 'models',
    title: '模型库体检器（SDK 样本 + 合成坏包 + 缓存指纹失效）',
    script: 'test-model-library.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'modellist',
    title: '模型清单纯逻辑（坏包标注 / 拦截切换 / 导入预检）',
    script: 'test-model-list.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'import',
    title: 'zip 导入（损坏检测 / 路径穿越 / 压缩炸弹 / 落库策略）',
    script: 'test-model-import.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'batch',
    title: '批量导入（16 个模型 / moc3 v1·v3·v5·v6）',
    script: 'test-batch-import.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'caps',
    title: '能力清单（与 Core 真实参数 / 动作组逐项一致）',
    script: 'test-capabilities.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'actions',
    title: 'AI 指令校验（越界 / 口型独占 / TTL 与打断）',
    script: 'test-actions.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'runner',
    title: '指令执行层（分派 / 过期 / 没有模型 / 不认得的 kind）',
    script: 'test-action-runner.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /*
     * ★ 这一道是 P3 验收标准「AI 连续 20 条指令不越界、不卡死」的**全链路**版本：
     * 真启动 Host、真发 20 条、把 /pending 取出来喂给真的渲染端执行层。
     * 上面两道各守一半，中间那一段（Host 放的、客户端做不做得到）只有这道守。
     */
    id: 'chain',
    title: '★ AI 指令全链路（20 条连续指令：Host 放的渲染端真的做得到）',
    script: 'test-action-chain.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'core',
    title: 'Cubism Core + 测试模型可加载',
    script: 'gate-model.mjs',
    // `MODEL` 找不到时把这条标成 skipped 而不是让它红：样本缺失是**环境**问题，
    // 不是「Cubism Core 坏了」。原来写死路径时两者分不开，红的含义被稀释了。
    args: MODEL === '' ? [] : [CORE, MODEL],
    nodeArgs: [],
    optional: MODEL === '' ? '找不到任何 .moc3 样本（SDK 未下载、模型库为空）' : undefined,
  },
  {
    id: 'drm',
    title: 'Edge-TTS v2 令牌算法（对照上游 Python 固定向量）',
    script: 'test-edge-tts-drm.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'envelope',
    title: '口型包络算法 + 单测',
    script: 'test-envelope.mjs',
    args: [],
    nodeArgs: ['--test'],
  },
  {
    id: 'speech',
    title: '口型驱动（假 AudioContext 跑真播放器：包络 / 时间轴 / 打断 / 错误路径）',
    script: 'test-speech-player.mjs',
    args: (live) => (live ? ['--live'] : []),
    nodeArgs: [],
  },
  {
    id: 'lane',
    title: '★ 朗读通道（两句不互相掐断 / 叫停清队列 / 合成途中叫停不出声 / 看门狗不卡死）',
    script: 'test-speech-lane.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /*
     * 视线那条时间线：框架给的 `CubismTargetPoint` 转头速度写死、没有时长旋钮，
     * 所以 §4.1 契约里的 `durationMs` 原来无处落地 ——「慢慢转过去」根本表达不出来。
     * 真正的适配层 `TimedLookTarget` 要 WebGL 才能构造，算术全在 `look-tween.ts`，
     * 这一道守的就是那份算术（含四条真跑一遍的退化实现）。
     */
    id: 'look',
    title: '★ 视线时间线（durationMs 真的决定用多久 / 中途改目标不跳 / 0 是合法的「立刻」）',
    script: 'test-look-tween.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /*
     * 第十个缺陷守在这里：插件配置里的 `maxFps`（默认 60）**谁都没有读**。
     * 配置 → `/status` → 客户端字段全程都通，链尾那一扣没接 ——
     * 渲染循环一个节流都没有，用户在配置里写 30 想降风扇，帧率一点没变、不报错。
     *
     * 这一道用一条**假时间轴**把一秒推一遍、直接数画了几帧：帧率这件事
     * 在画面上分不清是「没生效」「砍过头」还是「发超了」，三种都只是
     * 「帧率不太对」。另有三条真会发生的坏实现，证明它分得清。
     */
    id: 'frame',
    title: '★ 渲染帧预算（maxFps 真的限流 / 跳帧不让动作变慢 / 配 0 不冻住）',
    script: 'test-frame-budget.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 这一道守的不是「信号对不对」，而是**沉默可不可信** —— 一件推理的前提。
     *
     * 她冻住、而 `/status` 一条 `frame-*` 记录都没有，这件事我被它骗了整整五轮：
     * 前四轮我一直在加护栏（`frame-live` / `frame-blind` / `frame-frozen` /
     * `frame-hidden` / `frame-nostart`），五道全装好了，而用户报上来的仍然是
     * 「零条记录」。真原因是结构性的：五道护栏**全都住在渲染舞台那个 effect 里**，
     * 而面板一收起 `Live2DStage` 整个不渲染 → effect 卸载 → cleanup 把五个定时器
     * 全部 `clearInterval` 掉。于是「面板收着」与「一切正常」在 `/status` 上
     * 长得一模一样，而我拿着那片空白当证据去推断画面状态。
     *
     * 判据分三处：客户端挂载时登记（`stage-presence.ts` + `plugin.ts` 的接线）、
     * 卸载时注销、轮询把 `stage=1|0` 拼进 `/status` 的查询串；Host 侧解析它、
     * 并把「舞台不在」时**明说 `frame-*` 的沉默不算证据**这件事写进 detail。
     * 最后那半句是判据本身而不是文案：少了它，这个字段救不了任何人。
     *
     * 离线可判，因为它全是接线与措辞；[4] 段把八条真实会犯的忘记逐条做出来，
     * 断言每条判据都抓得住 —— 一条恒真的断言在报告里与一条有效的断言长得一样。
     */
    id: 'stage',
    title: '★ 渲染舞台存在性（面板收起时 frame-* 的沉默不算证据）',
    script: 'test-stage-presence.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 两种窗口形态的纯逻辑（用户第 1 条要求）。
     *
     * 这一层错的代价不对称：夹边少一条，窗口被拖出视口之后就**再也拖不回来**
     * （位置是持久化的，刷新回来还在屏幕外，唯一的出路是清 localStorage）；
     * 持久化少一个兜底，一条手改坏的存储就能让整张卡片白屏。两种症状都
     * 不像 bug，像「这插件抽风了」—— 所以它们必须被真的执行一遍。
     */
    id: 'window',
    title: '★ 窗口形态纯逻辑（固定/浮动、夹边、拖动拉角、持久化容错）',
    script: 'test-window-mode.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 舞台视图（模型在舞台里的缩放与平移，用户第 4、5 条要求）。
     *
     * 这一层错起来全都指向同一个症状：**模型不见了** —— 而它既可能是渲染坏了，
     * 也可能是用户自己把它推出去了。夹取、上限、持久化容错三条各挡一种，
     * 所以必须被执行，不能只读源码。
     */
    id: 'stageview',
    title: '★ 舞台视图纯逻辑（滚轮缩放 / 拖动平移 / 夹取 / 双击复位）',
    script: 'test-stage-view.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 第二十一个缺陷守在这里：**上报通道从来没有成功送回过任何一条消息。**
     *
     * 「她冻住了，而且一条记录都没有」查到第六轮才找到真正的原因 —— 我一直在给
     * 被观测的东西加护栏（五道 `frame-*`），却从没验过**观测这件事本身**。
     * 现场三条事实把它钉死了：同一个正在冻结的实例里，
     * `clientStage` 抵达了（走 `/status` 查询串）、`/capabilities` 抵达了（走 fetch）、
     * 而 `clientErrors` 里从来没有过任何一条浏览器发来的记录（走 `sendBeacon`）。
     * 也就是说：**五轮里那些护栏的沉默一文不值，因为它们在对着一条坏掉的线喊。**
     *
     * 这道门禁钉三件事：① 主路必须是 `fetch(..., { keepalive: true })`，
     * `sendBeacon` 只能是退路（它的失败没有任何回调，返回值还被旧实现丢掉了）；
     * ② 两条路的结果都要记账；③ ★ 账本必须跟着 `/status` 的心跳回去 ——
     * 这是个循环：通道坏掉的时候恰是它自己的账本最需要送到的时候。
     *
     * [1]–[6] 段把假 `fetch` / 假 `navigator` 装上去，逐条验账本怎么变；
     * [7]/[8] 段是源码级判据与八条真实会犯的忘记（删 keepalive、内联退路、
     * 把非 2xx 当成功、不记正文……），断言每条谓词都抓得住。
     */
    id: 'report',
    title: '★ 上报通道账本（通道坏掉时，它自己的账本由心跳带回来）',
    script: 'test-report.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 部件透明度（动作文件里的 `Target: "PartOpacity"`）：用户报「hiyori 四只手」
     * 时查出来的又一个静默失效 —— 框架拿**部件** id 去查参数下标，查不到就写进
     * `_notExistParameterValues` 再丢掉，全程不报错；而全框架唯一认真写部件不透明度
     * 的是需要 `Pose.json` 的 `CubismPose`，本库四个模型一个都没声明。
     *
     * [4] 段是这道门禁的重心：拿**真动作文件**验「两套手臂严格互补」。
     * 两条都是 1 就是四只手，两条都是 0 就是没有手 —— 两种形态都是它的可见后果。
     */
    id: 'parts',
    title: '★ 部件透明度（框架静默丢弃 PartOpacity 曲线，渲染端自己接上）',
    script: 'test-part-curves.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 「AI 当操控者」的第一期：`live2d_emote` —— 情绪层。
     *
     * 它守的是**两条不许静默的线**：
     *   ① 预设是按「角色 → 候选参数 id」写的，而 `resolveEmotion()` 对匹配不到的
     *      角色是**刻意静默跳过**的（不同模型参数不同）。于是一个写错的 id 表现成
     *      「这个情绪少了一半表情」，不报错。⇒ [1] 静态自检覆盖每个 id，
     *      [2] 拿官方 Core 枚举 hiyori 的**真实 min/max/def**，逐条情绪、逐参数核对。
     *   ② 情绪层必须是**加法**写入（`addParameterValue`）而不是硬写覆盖 ——
     *      硬写会盖掉眨眼，而 hiyori 的 10 段动作每一段都在驱动脸。⇒ [5] 用
     *      「落笔位置在 `onLateUpdate()` 之后、`model.update()` 之前，且排在口型与
     *      `param` 覆盖之前」把优先级钉死。
     *
     * [2] 还有一条断言专门守「不许静默降级」本身：只要被夹取过，正文里就必须写出来。
     */
    id: 'emotions',
    title: '★ 情绪层（词汇表 × Core 真实范围 × 加法写入 × 落笔顺序）',
    script: 'test-emotions.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 情绪的第二条通路：**她自己说话时**的表情（零 token、不占工具调用）。
     *
     * 这一道门禁的价值全在 [8]：它用 `tools/lib/host-harness.mjs` 起一个真的
     * Host，真的对一个假会话 **emit `agent/assistant-stream`**，再从真的
     * `/pending` 里把指令读出来。装门禁时它抓出了两个只有整条链才看得见的缺陷：
     *
     *   ① `feedStream` 把**挖掉代码之后**的文本存进缓冲，于是「围栏在这一块
     *      开着」这个状态跨 chunk 丢失 —— 第二个 chunk 的闭合符被当成新开一个
     *      围栏，把后面真正的正文整段吞掉（贴一段代码之后，她再也不会有表情）。
     *   ② `start` frame 把 `lastPushAt` 重置成 `-Infinity`，于是 700ms 的节流
     *      **永远不可能生效**：每一轮的第一个句子都能立刻推一次，而她的脸还在
     *      走上一层的保持时间。
     *
     * 两个都不是「写错了常量」，而是「两块拼起来才看得见」—— 正是这一道存在的理由。
     */
    id: 'emotionstream',
    title: '★ 流式情绪（事件 → 分句 → 判定 → 与工具同一条队列）',
    script: 'test-emotion-stream.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * D 期：她的**状态** —— 与「情绪」是两件事。
     *
     * 情绪回答「此刻脸上叠着什么」，由**话的内容**驱动（B/C 期已做完）。状态回答
     * 「她现在在干什么」：在想 → 我在说 → 说完了，由回合的开始/结束驱动。
     * C 期做完之后，如果我不说带情绪词的话，她一整个回合是完全静止的 —— 和掉线
     * 长得一样。这一期补的就是那段空白。
     *
     * 两道关各自守什么：
     *   · [1] **多层叠加的数学**。B 期换情绪是一帧换脸，现在旧的层化进新的层，
     *     任意时刻可能有 0..n 层同时往同一个参数上写 —— 而这段代码跑在浏览器里
     *     （要 Cubism Core 与 WebGL）。所以数学留在 Host 半区的纯函数里，这里逐帧
     *     对账：`values` 必须等于「Σ 层增量 × 层权重」，两个人同时写一个参数时也一样。
     *   · [2][3] **状态机与跨模块接缝**。`mood.js` 里 `THINKING_EMOTION_NAME = '思考'`
     *     是硬编码字符串，而词汇表住在 `emotions.js` —— 有人改名字时两个模块各自
     *     自洽，只有她的脸会开始收到 `E_EMOTION_UNKNOWN`。所以名字、强度、三段时长
     *     都在这里拿真词汇表和 hiyori 的真实范围核一遍。
     *
     * [5] 的五条反证是这个文件里最像「故意搞破坏」的一段：把 `end` 帧的收尾删掉、
     * 把思考态改成词汇表里没有的名字、把「回正」调得比「换情绪」还快 —— 每一条都
     * 必须让对应的判据变红，否则那些判据只是描述实现，不是守它。
     */
    id: 'mood',
    title: '★ 她的状态（多层叠加逐帧对账 × 思考态 × 回合三个转移点）',
    script: 'test-mood.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 思考时「收着点」：把**待机动作**的幅度往模型的默认姿态收（保留 35%）。
     *
     * 为什么值得单独一道：这条改动的全部效果是「看起来安静了一些」，**没有可看的
     * 产物** —— 没有报错、没有返回值、没有一眼能对的数字。于是四种错都能悄悄活下来：
     * Host 那条 `mood` 字段没接上（什么都没变）、480 ms 写成 48 或 4800（只是有点
     * 突兀）、`calm = 0` 时系数不是**恰好** 1（不思考时动作也小了一点点，没人查得
     * 出来）、收幅收错对象（AI 点名的挥手点头也被打折，用户会以为她「没劲了」）。
     *
     * 算术在 `src/client/motion-calm.ts`（`PetModel` 要 WebGL，Node 里构造不出来），
     * 所以第一段逐帧对账包络（29 / 66 帧）、第二段把「calm=0 必须恰好是 1」钉成
     * 一条严格相等的断言，第五段读源码证明五处接线都在（`saveParameters()` 之前、
     * 跳过口型、只收待机档、`/pending` 带 `mood`、两层名字一致）。
     */
    id: 'calm',
    title: '思考时收着点（待机动作幅度包络逐帧对账 × 只收待机档 × 五处接线）',
    script: 'test-motion-calm.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 待机小动作：让「没事干」的时候不只剩模型自带的几段 `Idle`。
     *
     * 和 `calm` 同一类毛病 —— 效果只是「看起来活泼了一点」，没有可看的产物。
     * 于是五种错都静默：手势表少了某个部位（写了模型没有的参数名）、包络起不来
     * 或收不回去（抽搐）、幅度离谱（转头 80 度）、`look_at` 生效期间还自己乱瞥
     * （用户点名向右看，她十秒后自己转回来）、思考时小动作照旧满幅（刚做的
     * 「收着点」被这一层绕过去）。
     *
     * 前三种在纯逻辑里逐帧对账；后两种读 `pet-model.ts` 的源码对账
     * （`isBusyWithRealMotion` / `_lookAllowsGaze` / `calmFactorFor(this._calm)`）。
     */
    id: 'garnish',
    title: '待机小动作（手势表 × 包络逐帧 × look_at 让路 × 思考打折）',
    script: 'test-idle-garnish.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 微动作：导入模型后自动认部位、一键生成一套（歪头 / 侧身 / 瞥一眼 …），
     * 待机与说话两档节奏、按情绪加权挑选。
     *
     * 与 `garnish` 是同一层的升级，所以同一类死法都静默：
     *
     *  1. 认错参数（把 `ParamAngleY` 当歪头）—— 画面只是「方向不对」；
     *  2. 幅度按绝对值写死 —— ±10 度的模型上抽搐，±30 度的模型上看不见；
     *  3. 说话时还挑待机向的动作 —— 口型是主角，旁边在耸肩膀；
     *  4. 正经动作在播时叠上去 —— 两根手指同写一根参数，幅度翻倍；
     *  5. 包落盘写到一半被杀 —— 下次读到半截 JSON，整层静默失效。
     *
     * 1–2 在生成器里逐条对账（量程比例、大小写兜底、缺失部位），3–4 在挑选器与
     * 播放器里逐帧抽样对账，5 在磁盘层用临时目录对账；接线（`pet-model` /
     * `plugin` / 面板 / `build.mjs`）只能读源码对账。
     */
    id: 'micro',
    title: '微动作（生成器 × 情绪加权挑选 × 待机/说话两档 × 原子写 × 接线对账）',
    script: 'test-micro-motions.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 设置页与桌宠卡片的分工（§13.35）。
     *
     * 这件事没有会报错的失败方式：组件从卡片删掉、设置页又没接上，
     * 页面照样渲染，只是功能消失了；反过来两棵树各放一份，改一边另一边不动。
     * 所以门禁断言的是**分工**（谁必须有、谁必须没有）与那条唯一的跨树同步通道。
     */
    id: 'settingsui',
    title: '设置页分工（模型库/音色/绑定在设置页 × 卡片只剩看她 × 跨树同步）',
    script: 'test-settings-section.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 面板上的「和桌宠对话」（§13.36）。
     *
     * 这条链有三段会**静默失败**：话没送进会话（面板看起来发出去了）、
     * 我那一轮没按指令只调用 `live2d_speak`（回了正文，面板一片空白）、
     * 她那句话没落进账本（她明明说了，面板没记）。三段里只有第一段有状态码，
     * 所以这里既真跑纯逻辑，也逐行对账 Host 与渲染端的接线。
     */
    id: 'petchat',
    title: '和桌宠对话（账本纯逻辑 × 注入会话 × 入队落账 × 面板两档轮询）',
    script: 'test-pet-chat.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * D-2 的反向通道：她「开始说 / 说完了」回到 Host，再写进运行时上下文。
     *
     * 这条链四段分居四个文件（朗读通道 → `speech-presence.ts` → `/status`
     * 心跳的查询串 → `host/speech.js` + `systemPrompt.context`），而**每一段
     * 单独失效时都是静默的**：参数名一侧改了另一侧没改，表现只是「AI 偶尔
     * 抢话」；顺序写反了，表现只是「念完了那一句偶尔迟到一整句」。
     *
     * 所以 [5] 起一个真的 Host、用真的 HTTP 把报告送进去、再读回 `/status`、
     * `live2d_status` 与注册进 `systemPrompt` 的那条 context —— 跨端契约写错
     * 时只有这一段会红。[7] 的反证比字符串判据强一档：`speech.js` 零 import，
     * 于是可以把**改过的源码**从 `data:` URL 重新 import 回来跑，证明那些判据
     * 是被执行出来的而不是被正则猜出来的（文件系统一个字节都没动）。
     *
     * 「没事可说时那一行必须是空串」单独钉住：它的存在成本是每一步的 token。
     */
    id: 'reverse',
    title: '★ 反向通道（她在说 / 说完了 → 心跳 → 运行时上下文）',
    script: 'test-reverse-channel.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 第十一个缺陷守在这里：`moc3.endianness` Host 发**裸字节**（`0`/`1`），
     * 客户端声明 `endianness?: string` 并拿 `=== 'big'` 比 —— 恒假，
     * 那句专门为大端写的「大端」标签永远不会出现。
     *
     * 它躲过了当时全部 22 道门禁，因为落在每道门禁的缝里：`tsc` 看不见
     * （跨边界走 JSON，编译期两边不见面）；Host 的测试只看自己那一半
     * （`endianness === 0` 自洽）；客户端的测试**按客户端以为的类型造夹具**
     * （`moc3: { version: 5, endianness: 'little' }`），把「我以为的契约」
     * 当成了契约 —— 这是最要命的一种测试。
     *
     * 所以这一道只做一件事：跑真的 Host 生产函数，把真实产出喂给真的客户端
     * 函数，断言用户能看见的结果。另加一张跨边界字段登记表，客户端每新声明
     * 一个字段就必须登记，否则红 —— 拦的是**下一个** endianness。
     */
    id: 'wire',
    title: '★ 跨边界字段类型（Host 真实产出喂给真实客户端 / 新字段不登记就红）',
    script: 'test-wire-types.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /**
     * 方案 P1 的交付物「缩略图」守在这里（§6.1 #1 的验收第 1 条就是它）。
     *
     * 这条链上会出错的地方全是**算术与防御**，而没有门禁时它们全都够不着：
     * 包围盒算错只表现为「图裁歪了一点」（说不清是裁歪还是模型本来就那样）；
     * `parseStored()` 少一个判空表现为「面板偶尔白屏一下」（§9.2 事故的形状，
     * 而且复现不了）；指纹比对写错表现为「换了模型还显示旧图」——
     * 而**一张错的图比没有图更糟**，用户会拿它当依据。
     *
     * `thumbnail.ts` 被刻意写成零 DOM、零 canvas、零 localStorage、零 `Date.now()`，
     * 所以上面这些都能离线逐条钉死。抓帧那一段（真的碰 canvas 与 GL）留在
     * `plugin.ts`，那部分由 `[7]` 段的**源码顺序断言**守：抓图必须排在
     * `model.draw()` 之后（GL 是 `preserveDrawingBuffer: false`，出了这一帧
     * 缓冲就空了 —— 症状是「缩略图永远存不下来」，看起来却像「模型没渲染」）。
     */
    id: 'thumb',
    title: '★ 模型缩略图（包围盒裁到本体 / 换过文件必须重拍 / 坏数据不抛）',
    script: 'test-thumbnail.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'adapters',
    title: 'TTS 降级策略（哪些错误该换系统语音 / 给用户的提示语）',
    script: 'test-tts-adapters.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    /*
     * 第七个交付后发现的缺陷守在这里：`text` 和它的三个邻居
     * （`voice` / `rate` / `pitch`）写在同一行 SSML 里，**只有 `text` 被转义了**。
     * 实测四个带单引号的取值全部 502 —— 用户听到「她没说话」，
     * 日志写着「语音服务出错了」，与真正的原因无关。
     *
     * 这一道不联网：合成一次要打真实 Edge-TTS，而要问的问题
     * （拼出来的字符串长什么样、坏值有没有在开 socket 之前被挡住、
     * 自产错误有没有带 `.code`）都能离线回答。
     */
    id: 'ssml',
    title: '★ SSML 拼装与 TTS 入参（四个插值都转义 / 坏值在开 socket 前挡住 / 失败带错误码）',
    script: 'test-edge-tts-ssml.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'settings',
    title: '口型增益与字幕（脏设置 / 夹取 / 高亮定位 / 字幕可见性）',
    script: 'test-pet-settings.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'voicepack',
    title: '本地语音包清单（格式校验 / 路径穿越 / 中文文件名折 id / 按情绪选片）',
    script: 'test-voice-pack.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'voicelib',
    title: '★ 语音库磁盘层（目录名当 URL 参数 / 坏 json 不毁整张清单 / 点播落盘路径）',
    script: 'test-voice-library.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'voicepanel',
    title: '★ 面板「语音包」一节（列包 / 试听先掐通道 / 音源名字不撒谎）',
    script: 'test-voice-panel.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    // 这一道漏登记过一轮：`test-tts-voices.mjs` 写完了、单独跑也全绿，
    // 但不在 GATES 里 —— 于是「换音色」整条链路**没有任何门禁在守**。
    // 全绿的数字当时看着没问题，因为它压根没被算进去。
    id: 'ttsvoices',
    title: '★ 音色清单与偏好归一化（换音色的设置层 / 坏值退回并说明 / 面板接线）',
    script: 'test-tts-voices.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'ttscustom',
    title: '★ 自定义 TTS 服务（真起 HTTP 服务演服务端 / client 不甩锅 / 探测判据）',
    script: 'test-tts-custom.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    // 为什么值得单独一道：这一层会**启动进程**，而它最危险的失败是安静的 ——
    // 端口已在听时再 spawn 一份（Windows 允许两个进程绑同一端口）、停止时按端口
    // 误杀用户自己开的窗口、`config` 被当命令行片段拼进去。门禁的反证比正例多。
    id: 'localtts',
    title: '本地 TTS 一键（探测/启动/停止 × 端口占用不重复起 × 只杀自己的 × 参数不当命令）',
    script: 'test-local-tts.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    // 为什么值得单独一道：这一层把**外部文件**变成她会用的嗓子。危险的是四件安静的
    // 事故 —— 清单里的 `refAudio` 变成任意文件读取、同 id 导入悄悄盖掉用户手调的那份、
    // 坏包让她每一句都失败、参考音还在但逐字文本丢了（音色带口音而界面一切正常）。
    id: 'voicepacks',
    title: '音色包（清单校验 × 路径穿越 × 同名不覆盖 × 坏包进 broken × 接线对账）',
    script: 'test-voice-packs.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    id: 'tts',
    title: 'Edge-TTS 生产适配器真实连通（联网合成一句中文）',
    script: 'test-edge-tts-adapter.mjs',
    args: [],
    nodeArgs: [],
    live: true,
  },
  {
    // 为什么值得单独一道：`tools\*.bat` 是我用编辑器的写文件工具生成的，那个工具默认 **LF 换行**，
    // 而 cmd.exe 只认 CRLF —— 于是双击时整行被切碎，症状是「乱码 + 找不到命令」，
    // 看起来像编码问题，其实是换行问题（反证见 test-bat-scripts.mjs 第 [5] 段）。
    id: 'bats',
    title: '启动脚本（.bat 必须 CRLF + UTF-8 无 BOM + 第 2 条 chcp 65001）',
    script: 'test-bat-scripts.mjs',
    args: [],
    nodeArgs: [],
  },
  {
    // 这道验的不是「模块对不对」，而是「DSH 里跑着的那个进程加载的到底是不是刚改的代码」。
    // 必要性是实测撞出来的：开关插件会重跑 apply，但 ESM 模块缓存不会失效。
    // 所以它必须打真实端口，且 DSH 没开着时**跳过而不是失败**（soft）——
    // 它不是「代码有毛病」的信号，是「现在没法验」的信号。
    id: 'hostroutes',
    title: '真机路由（正在运行的 DSH 是否加载了新 Host 代码）',
    script: 'test-host-routes.mjs',
    args: (live) => (live ? [] : ['--no-live']),
    nodeArgs: [],
    soft: true,
    requires: 'dsh',
  },
];

const DSH_BASE = `http://127.0.0.1:${process.env.DSH_PORT ?? 19387}`;

/** DSH 是否正在这个端口上服务（用 /status 这个不需要鉴权的路由探）。 */
async function dshReachable() {
  try {
    const response = await fetch(`${DSH_BASE}/.dsh-live2d-pet/status`, {
      signal: AbortSignal.timeout(1500),
    });
    // 401 也算「服务活着」—— 鉴权是外层的事，插件路由在不在是另一回事。
    return response.status > 0;
  } catch {
    return false;
  }
}

function header(text) {
  console.log(`\n${'='.repeat(64)}\n${text}\n${'='.repeat(64)}`);
}

const results = [];
const startedAll = Date.now();

for (const gate of GATES) {
  if (gate.live && !LIVE) {
    results.push({ ...gate, status: 'skipped', note: '未加 --live' });
    continue;
  }

  // `optional` 指向一个「有就跑、没有就跳过」的可执行文件（例如没装 devDependencies 时的 tsc）。
  const scriptPath = gate.optional ?? join(TOOLS_DIR, gate.script);
  if (!existsSync(scriptPath)) {
    header(`[${gate.id}] ${gate.title}`);
    console.log(gate.optional ? '[skip] 未安装（先跑一次 npm install）' : `[skip] 找不到脚本 ${scriptPath}`);
    results.push({ ...gate, status: gate.optional ? 'skipped' : 'missing' });
    continue;
  }

  // 需要 DSH 在跑的项：不在跑就跳过（soft），因为那是「现在没法验」而不是「代码坏了」。
  if (gate.requires === 'dsh' && !(await dshReachable())) {
    header(`[${gate.id}] ${gate.title}`);
    console.log(`[skip] ${DSH_BASE} 上没有在跑的 DSH —— 这道门禁没验，不代表通过`);
    results.push({ ...gate, status: 'skipped', note: 'DSH 未运行' });
    continue;
  }

  const args = typeof gate.args === 'function' ? gate.args(LIVE) : gate.args;

  header(`[${gate.id}] ${gate.title}`);
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [...gate.nodeArgs, scriptPath, ...args],
    { stdio: 'inherit', cwd: gate.cwd ?? ROOT },
  );
  const elapsedMs = Date.now() - started;

  if (result.error) {
    console.log(`[x] 无法启动：${result.error.message}`);
    results.push({ ...gate, status: 'error', elapsedMs });
    continue;
  }

  // soft 项失败也不拖垮整轮：它验的是环境（服务器在不在、是不是旧模块），
  // 把它算成「代码失败」会让人开始忽略汇总表。
  if (result.status !== 0 && gate.soft) {
    console.log(`[soft] 这项没过（exit ${result.status}）—— 不参与总体裁决，但要当心：它说的是真机上的情况`);
    results.push({ ...gate, status: 'softfail', exitCode: result.status, elapsedMs });
    continue;
  }

  results.push({
    ...gate,
    status: result.status === 0 ? 'ok' : 'failed',
    exitCode: result.status,
    elapsedMs,
  });
}

header('汇总');
for (const item of results) {
  const label = {
    ok: '[ok]      ',
    failed: '[FAILED]  ',
    softfail: '[soft-!]  ',
    skipped: '[skipped] ',
    missing: '[missing] ',
    error: '[error]   ',
  }[item.status] ?? '[?]       ';
  const time = item.elapsedMs !== undefined ? `${String(item.elapsedMs).padStart(5)}ms` : '     -';
  const note = item.status === 'failed' ? `  (exit ${item.exitCode})` : item.note ? `  (${item.note})` : '';
  // id 列宽 9 而不是 10：`hostroutes` 正好 10 个字符，用 10 的话它会和标题黏在一起。
  console.log(`${label}${time}  ${item.id.padEnd(9)} ${item.title}${note}`);
}

const failed = results.filter((item) => item.status === 'failed' || item.status === 'error' || item.status === 'missing');
const skipped = results.filter((item) => item.status === 'skipped');
const softFailed = results.filter((item) => item.status === 'softfail');
const passed = results.filter((item) => item.status === 'ok');

console.log(
  `\n通过 ${passed.length} 项，失败 ${failed.length} 项` +
  (softFailed.length > 0 ? `，软失败 ${softFailed.length} 项（${softFailed.map((i) => i.id).join(', ')}）` : '') +
  (skipped.length > 0 ? `，跳过 ${skipped.length} 项（${skipped.map((i) => i.id).join(', ')}）` : '') +
  `，总耗时 ${((Date.now() - startedAll) / 1000).toFixed(1)}s`,
);

if (failed.length > 0) {
  console.log(`\n[x] VERIFY FAILED：${failed.map((item) => item.id).join(', ')}`);
  process.exit(1);
}
console.log(softFailed.length > 0 ? '\n[!] VERIFY PASSED（有软失败，注意上面标 [soft-!] 的两行）' : '\n[v] VERIFY PASSED');
