/**
 * dsh-live2d-pet — 微动作：模型一导进来，就能自己长出的一小套「小动作」。
 *
 * ## 这一层为什么存在
 *
 * 上一轮做的待机小动作（`src/client/idle-garnish.ts`）是**手写给 hiyori 的**：
 * 参数名、幅度、时长全是按那一套模型调出来的。换一个模型就全不对 —— 参数名不同
 * （Wanko 用全大写 `PARAM_ANGLE_X`）、量程不同（有的头 ±10 度，有的 ±30），
 * 而用户想要的是「导入之后它自己就会」。这一层负责的就是那个「自己」：
 *
 *   1. **认参数**：用 `emotions.js` 那张角色表（头部倾斜 / 身体左右 / 眼球 / 眉毛 /
 *      肩膀 / 呆毛…），先在模型的声明里找同义 id，再退回用户绑定表；
 *   2. **按量程给幅度**：动作表里写的是「占该参数全量程的百分之几」，不是绝对值。
 *      这样同一个「歪头」在 ±10 度的头和 ±30 度的头上看起来是同一个幅度；
 *   3. **按情绪贴标签**：每条动作带几个情绪名（`开心` / `思考`…），渲染端拿到
 *      当前情绪后加权挑 —— 想事情的时候更容易出现「抬眼」，不会在难过时耸肩。
 *
 * ## 为什么是纯函数、零依赖
 *
 * 生成与挑选都发生在 Host（面板一点就生成、渲染端每几秒挑一条），而「幅度有没有
 * 超量程」「难过时会不会挑到开心那条」这类事最该被门禁逐条断言。放在这里，
 * 门禁可以直接喂一份假 capabilities 进去，**不需要 Cubism、不需要浏览器**。
 * 同理，生成器不认识磁盘、不认识 HTTP —— 落盘在 `micro-motion-library.js`。
 *
 * ## 一条动作的形状（v2：多部位、分段错峰）
 *
 * ```
 * { id, label,
 *   parts: [
 *     { delayMs: 0,   params: { '<参数 id>': 增量 } },   // 主部位：头 / 身体
 *     { delayMs: 140, params: { ... } },                // 第二段：眼睛跟过去
 *     { delayMs: 260, params: { ... } },                // 第三段：眉毛 / 肩膀 / 呆毛
 *   ],
 *   attackMs, holdMs, releaseMs, gaze, tags, modes, weight }
 * ```
 *
 * ### 为什么是「多段」而不是「一个参数」
 *
 * 第一版每条动作只写一到两根参数（`angleZ: 0.12` 那一条就是「只有头在歪」）。
 * 真机上看，那不是「动作小」，而是**假**：真人歪头时头、眼、肩、呆毛是一串
 * 先后跟上的，单根参数动得再大也像贴图被掰了一下。
 *
 * v2 的每条动作都有 3–4 段、每段写 2–5 根参数，段与段之间错开 90–460 ms；
 * 幅度也整体放大到「一眼看得出」——歪头在 ±30 度的头上是 16.8 度（第一版是
 * 7.2 度，用户反馈「效果不明显」）。**幅度与真实感是一起调的**：只加幅度会变成
 * 抽筋，只加段数会变成抖动。
 *
 * ### 段与段之间为什么必须错开
 *
 * `delayMs` 不是「第二个动作」，是**同一次动作里后到的部位**。它们共用一条
 * attack/hold/release 包络，只是起点各晚一点 —— 所以看起来是一个连续的姿态变化，
 * 不是两下。两段同时起步则是「机械」的来源：所有关节在同一毫秒启动。
 */

import { MOUTH_PARAMETER_IDS } from './capabilities.js';
import { ROLE_LABELS, ROLE_PARAMETER_IDS, pickRoleParameter } from './emotions.js';

/**
 * 包格式版本。形状一变就 +1。
 *
 * v1 → v2：单段 `params` + 可选 `trailing`，换成 `parts[]`（多段错峰）。
 * 读到 v1 的包一律当「没有包」——旧包的幅度只有现在的一半，继续用会让用户
 * 以为「改了没生效」。Host 的 `ensureMicroMotions()` 会因此自动重新生成。
 */
export const MICRO_MOTION_VERSION = 2;

/** 一个包最多这么多条：再多面板就成了一面墙，而且挑中的概率被摊薄。 */
export const MICRO_MOTION_MAX_GESTURES = 24;

/** 一条动作最多分几段（再多就成了一段动画，不再是「小动作」）。 */
export const MICRO_MOTION_MAX_PARTS = 4;

/** 单段最多晚多久起步（毫秒）。再晚就不像同一次动作了。 */
export const MICRO_MOTION_MAX_PART_DELAY_MS = 600;

/**
 * 两档节奏。
 *
 * 待机档沿用待机小动作的 6.5–15 秒 —— 用户上一轮验收过那个密度；说话档更密
 * （4.2–9 秒），因为人在说话时头部与视线的小幅移动本来就比沉默时频繁，
 * 但不能密到每句话都在摇头：说话时**口型是主角**，微动作只是伴随。
 */
export const MICRO_MOTION_MIN_DELAY_MS = 6500;
export const MICRO_MOTION_MAX_DELAY_MS = 15000;
export const MICRO_MOTION_TALK_MIN_DELAY_MS = 4200;
export const MICRO_MOTION_TALK_MAX_DELAY_MS = 9000;

/** 有真动作（`Idle` / AI 点的 motion）时，微动作要让路这么久。 */
export const MICRO_MOTION_ABORT_DELAY_MS = 3000;

/**
 * 强度默认值与可调范围（面板上的滑杆）。
 *
 * 默认值从 0.75 提到 0.9：v2 的幅度本身已经放大，0.75 会把它们乘回第一版的观感。
 * 用户要更明显就往上拉（上限 1.4），觉得太夸张就往下拉 —— 不用重新生成。
 */
export const MICRO_MOTION_DEFAULT_STRENGTH = 0.9;
export const MICRO_MOTION_MIN_STRENGTH = 0.2;
export const MICRO_MOTION_MAX_STRENGTH = 1.4;

/** 一条动作最长多久必须结束 —— 没人想看一个歪着头不动十秒的模型。 */
export const MICRO_MOTION_MAX_TOTAL_MS = 12000;

/**
 * 单根参数增量的绝对值上限（**参数自己的单位**，不是百分比）。
 *
 * 早先这里写的是 2，那是把「单位量程参数」（眼睛、眉毛 ±1）当成了全部 ——
 * 于是 ±30 度的头上那个 7.2 度的歪头，归一化时被夹成 2 度，画面里几乎看不见，
 * 而所有断言都还是绿的。90 能盖住 Cubism 标准的全部角度参数（最大 ±30），
 * 又远低于那些「被人手动改成 ±1000」的异常量程。
 */
export const MICRO_MOTION_MAX_DELTA = 90;

/**
 * 这一层用到的角色（按「动起来最好看」的顺序）。
 *
 * 不含 `eyeOpen*` / `eyeSmile*` / `cheek`：那三组是情绪层与眨眼的地盘，
 * 微动作去碰会和情绪打架（笑眼刚起、微动作又把它加了一截）。
 * 不含嘴（`MOUTH_PARAMETER_IDS`）—— 口型通道独占，这一条在生成器里还有一道硬过滤。
 */
export const MICRO_MOTION_ROLE_ORDER = [
  'angleZ',
  'angleX',
  'angleY',
  'bodyAngleX',
  'bodyAngleZ',
  'eyeBallX',
  'eyeBallY',
  'browLY',
  'browRY',
  'browLForm',
  'browRForm',
  'shoulder',
  'hairAhoge',
];

/**
 * 缺部位时，把这一份「力」借给谁（§13.34）。
 *
 * 为什么需要它：有些模型的骨架只接了标准参数的一部分。博丽灵梦那套（`Param305…319`
 * 驱动待机）就**没有** `shoulder` 与 `hairAhoge`，而「耸肩 / 挑眉 / 呆毛抖 / 叹气」
 * 这几条把这两个当主发力点 —— 生成时整段被丢掉，于是她在灵梦身上只剩眼睛动。
 * 用户 2026-10-19 的原话是「只有眼睛上的动作看得比较明显」。
 *
 * 替代不是「随便找根参数补上」，而是按**动作的意义**借：
 *  - `shoulder`（耸肩 / 含肩）本质是上半身的纵向压缩，借 `bodyAngleZ`（身体侧倾）
 *    与 `angleY`（点头）各一部分，视觉上仍是「整个人往上提一下」；
 *  - `hairAhoge`（呆毛）是头部动作的惯性尾巴，借 `angleZ`（头歪）与 `angleY`，
 *    让「抖一下」变成头部的余震；
 *  - `bodyAngleX` / `bodyAngleZ` 互为替代（侧身与斜身对同一副骨架是一件事）；
 *  - 两根眉的 `Form`（形状）缺了就借同名 `LY/RY`（位置）—— 眉的形状多数模型没有独立参数。
 *
 * `ratio` 是「原比值的几折」。取 0.35–0.6 是刻意的：替代品只补**量**，不该让
 * 一根参数承担两个角色的全部，否则「眨眼的余震」会变成「突然歪头」。
 */
export const MICRO_MOTION_ROLE_SUBSTITUTES = {
  shoulder: [
    { role: 'bodyAngleZ', ratio: 0.55 },
    { role: 'angleY', ratio: 0.4 },
  ],
  hairAhoge: [
    { role: 'angleZ', ratio: 0.35 },
    { role: 'angleY', ratio: 0.2 },
  ],
  bodyAngleX: [{ role: 'bodyAngleZ', ratio: 0.4 }],
  bodyAngleZ: [{ role: 'bodyAngleX', ratio: 0.4 }],
  browLForm: [{ role: 'browLY', ratio: 0.6 }],
  browRForm: [{ role: 'browRY', ratio: 0.6 }],
  /*
   * 眉毛本身也动不了时，借一点头部俯仰：人「挑眉」时下巴会跟着抬一点点，
   * 而一条完全不动的时间轴比一条方向略有偏差的更糟（用户看到的是「没反应」）。
   * 这一条也让借力可以串（`browLForm → browLY → angleY`），见 `resolveTargets`。
   */
  browLY: [{ role: 'angleY', ratio: 0.3 }],
  browRY: [{ role: 'angleY', ratio: 0.3 }],
};

/**
 * 动作表。
 *
 * `roles` 里的数是**占该参数全量程的比例**（带符号）：`angleZ: 0.28` 在 ±30 度的
 * 头上是 16.8 度，在 ±10 度的头上是 5.6 度 —— 同一个「歪头」的手感。
 *
 * 每条的段序基本都遵循同一个生理顺序：**主部位（头 / 身体）→ 视线 → 重心
 * （身体侧倾 / 肩）→ 表情末端（眉 / 呆毛）**。这是真的：人先动的是意图（头转），
 * 眼睛比头早或同时一点点，重心最后让过去，眉毛与头发是惯性的尾巴。
 */
export const MICRO_MOTION_CATALOG = [
  {
    id: 'glance-left',
    label: '往左瞥一眼',
    parts: [
      { delayMs: 0, roles: { eyeBallX: -0.38, eyeBallY: 0.06 } },
      { delayMs: 110, roles: { angleX: -0.08, angleZ: 0.04 } },
      { delayMs: 200, roles: { browLY: 0.08, browRY: 0.04, hairAhoge: -0.05 } },
    ],
    attackMs: 260,
    holdMs: 900,
    releaseMs: 760,
    gaze: true,
    tags: ['好奇', '思考'],
    modes: ['idle', 'talk'],
    weight: 1,
  },
  {
    id: 'glance-right',
    label: '往右瞥一眼',
    parts: [
      { delayMs: 0, roles: { eyeBallX: 0.38, eyeBallY: 0.06 } },
      { delayMs: 110, roles: { angleX: 0.08, angleZ: -0.04 } },
      { delayMs: 200, roles: { browRY: 0.08, browLY: 0.04, hairAhoge: 0.05 } },
    ],
    attackMs: 260,
    holdMs: 900,
    releaseMs: 760,
    gaze: true,
    tags: ['好奇', '思考'],
    modes: ['idle', 'talk'],
    weight: 1,
  },
  {
    id: 'glance-up',
    label: '抬眼想事',
    parts: [
      { delayMs: 0, roles: { eyeBallY: 0.38, eyeBallX: -0.1 } },
      { delayMs: 140, roles: { angleY: 0.14, angleX: -0.05 } },
      { delayMs: 240, roles: { browLY: 0.16, browRY: 0.12, browLForm: -0.08 } },
    ],
    attackMs: 300,
    holdMs: 950,
    releaseMs: 780,
    gaze: true,
    tags: ['思考', '好奇'],
    modes: ['idle', 'talk'],
    weight: 1.1,
  },
  {
    id: 'glance-down',
    label: '垂眼',
    parts: [
      { delayMs: 0, roles: { eyeBallY: -0.34 } },
      { delayMs: 130, roles: { angleY: -0.12, angleZ: -0.05, angleX: -0.03 } },
      { delayMs: 230, roles: { browLY: -0.24, browRY: -0.24, browLForm: 0.14, browRForm: 0.14 } },
      { delayMs: 320, roles: { shoulder: -0.06 } },
    ],
    attackMs: 300,
    holdMs: 900,
    releaseMs: 900,
    gaze: true,
    tags: ['抱歉', '难过', '思考'],
    modes: ['idle'],
    weight: 0.9,
  },
  {
    id: 'brow-raise',
    label: '挑一下眉',
    parts: [
      { delayMs: 0, roles: { browLY: 0.34, browLForm: -0.16 } },
      { delayMs: 90, roles: { browRY: 0.3, browRForm: -0.14 } },
      { delayMs: 180, roles: { angleY: 0.06, shoulder: 0.05, hairAhoge: 0.08 } },
    ],
    attackMs: 220,
    holdMs: 650,
    releaseMs: 600,
    gaze: false,
    tags: ['好奇', '惊讶'],
    modes: ['idle', 'talk'],
    weight: 1,
  },
  {
    id: 'head-tilt',
    label: '歪头看你',
    parts: [
      { delayMs: 0, roles: { angleZ: 0.28, angleX: 0.09 } },
      { delayMs: 140, roles: { eyeBallX: 0.16, eyeBallY: 0.05 } },
      { delayMs: 230, roles: { bodyAngleZ: 0.12, bodyAngleX: 0.06 } },
      { delayMs: 300, roles: { browLY: 0.12, browRY: 0.04, hairAhoge: 0.1 } },
    ],
    attackMs: 560,
    holdMs: 1150,
    releaseMs: 900,
    gaze: false,
    tags: ['好奇', '思考', '开心'],
    modes: ['idle', 'talk'],
    weight: 1.2,
  },
  {
    id: 'body-turn',
    label: '侧一下身',
    parts: [
      { delayMs: 0, roles: { bodyAngleX: 0.4, bodyAngleZ: 0.2 } },
      { delayMs: 160, roles: { angleZ: -0.12, angleX: 0.06 } },
      { delayMs: 260, roles: { eyeBallX: -0.18 } },
      { delayMs: 340, roles: { shoulder: 0.1, hairAhoge: -0.12, angleY: -0.04 } },
    ],
    attackMs: 720,
    holdMs: 1300,
    releaseMs: 1000,
    gaze: false,
    tags: ['好奇', '得意'],
    modes: ['idle'],
    weight: 0.9,
  },
  {
    id: 'shoulder-shrug',
    label: '耸一下肩',
    parts: [
      { delayMs: 0, roles: { shoulder: 0.32, angleY: 0.07 } },
      { delayMs: 130, roles: { browLY: 0.2, browRY: 0.14 } },
      { delayMs: 220, roles: { angleZ: 0.06, hairAhoge: 0.08 } },
    ],
    attackMs: 340,
    holdMs: 650,
    releaseMs: 820,
    gaze: false,
    tags: ['抱歉', '开心'],
    modes: ['idle'],
    weight: 0.8,
  },
  {
    id: 'sigh',
    label: '轻轻叹气',
    parts: [
      { delayMs: 0, roles: { angleY: -0.16, angleX: -0.05 } },
      { delayMs: 160, roles: { browLY: -0.26, browRY: -0.26, browLForm: 0.16, browRForm: 0.16 } },
      { delayMs: 280, roles: { shoulder: -0.12, bodyAngleZ: -0.1 } },
      { delayMs: 380, roles: { eyeBallY: -0.14, hairAhoge: -0.08 } },
    ],
    attackMs: 750,
    holdMs: 700,
    releaseMs: 1300,
    gaze: false,
    tags: ['难过', '抱歉', '思考'],
    modes: ['idle'],
    weight: 0.8,
  },
  {
    id: 'sway',
    label: '晃一下',
    parts: [
      { delayMs: 0, roles: { bodyAngleZ: 0.34 } },
      { delayMs: 200, roles: { angleZ: -0.16, angleX: 0.06 } },
      { delayMs: 360, roles: { eyeBallX: 0.14, hairAhoge: -0.14 } },
      { delayMs: 460, roles: { shoulder: 0.06 } },
    ],
    attackMs: 1100,
    holdMs: 1700,
    releaseMs: 1300,
    gaze: false,
    tags: ['平静', '开心'],
    modes: ['idle'],
    weight: 0.8,
  },
  {
    id: 'hair-flick',
    label: '呆毛抖一下',
    parts: [
      { delayMs: 0, roles: { hairAhoge: 0.4 } },
      { delayMs: 110, roles: { angleZ: 0.1, angleX: 0.04 } },
      { delayMs: 200, roles: { browLY: 0.12, browRY: 0.08 } },
    ],
    attackMs: 240,
    holdMs: 500,
    releaseMs: 700,
    gaze: false,
    tags: ['开心', '得意'],
    modes: ['idle'],
    weight: 0.7,
  },
  {
    id: 'nod',
    label: '点一下头',
    parts: [
      { delayMs: 0, roles: { angleY: -0.18 } },
      { delayMs: 90, roles: { angleX: 0.04, browLY: 0.08, browRY: 0.08 } },
      { delayMs: 170, roles: { eyeBallY: -0.08 } },
    ],
    attackMs: 200,
    holdMs: 300,
    releaseMs: 380,
    gaze: false,
    tags: ['认真', '开心'],
    modes: ['talk'],
    weight: 1.3,
  },
  {
    id: 'talk-tilt',
    label: '说话时歪头',
    parts: [
      { delayMs: 0, roles: { angleZ: 0.2, angleX: 0.07 } },
      { delayMs: 150, roles: { eyeBallX: 0.12, eyeBallY: 0.03 } },
      { delayMs: 240, roles: { browLY: 0.12, browRY: 0.06 } },
      { delayMs: 320, roles: { bodyAngleZ: 0.08 } },
    ],
    attackMs: 460,
    holdMs: 820,
    releaseMs: 760,
    gaze: false,
    tags: ['好奇', '思考', '认真'],
    modes: ['talk'],
    weight: 1.1,
  },
  {
    id: 'listen-turn',
    label: '说话时侧一点',
    parts: [
      { delayMs: 0, roles: { bodyAngleX: 0.34, bodyAngleZ: 0.14 } },
      { delayMs: 180, roles: { angleZ: -0.1, angleX: 0.04 } },
      { delayMs: 280, roles: { eyeBallX: 0.22, eyeBallY: 0.03 } },
      { delayMs: 360, roles: { browLY: 0.1, hairAhoge: -0.06 } },
    ],
    attackMs: 600,
    holdMs: 900,
    releaseMs: 850,
    gaze: false,
    tags: ['认真', '好奇'],
    modes: ['talk'],
    weight: 0.9,
  },
  {
    id: 'look-away',
    label: '不好意思地瞥开',
    parts: [
      { delayMs: 0, roles: { eyeBallX: -0.36, eyeBallY: -0.1 } },
      { delayMs: 130, roles: { angleZ: -0.16, angleX: -0.06 } },
      { delayMs: 230, roles: { browLY: -0.16, browLForm: 0.12 } },
      { delayMs: 310, roles: { bodyAngleX: -0.16, shoulder: -0.05 } },
    ],
    attackMs: 380,
    holdMs: 820,
    releaseMs: 900,
    gaze: true,
    tags: ['抱歉', '难过'],
    modes: ['idle'],
    weight: 0.8,
  },
  {
    id: 'stretch-up',
    label: '伸个懒腰',
    parts: [
      { delayMs: 0, roles: { angleY: 0.2, angleX: -0.06 } },
      { delayMs: 180, roles: { shoulder: 0.18, bodyAngleX: -0.12 } },
      { delayMs: 300, roles: { eyeBallY: 0.16, browLY: 0.18, browRY: 0.16 } },
      { delayMs: 400, roles: { hairAhoge: 0.16 } },
    ],
    attackMs: 700,
    holdMs: 900,
    releaseMs: 900,
    gaze: false,
    tags: ['开心', '平静'],
    modes: ['idle'],
    weight: 0.7,
  },
];

/** 情绪标签白名单：只允许 `emotions.js` 认得的那九个名字，避免写错一个字就静默失效。 */
const EMOTION_TAGS = ['平静', '开心', '好奇', '思考', '认真', '惊讶', '抱歉', '难过', '得意'];

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 把一个「占全量程的比例」换成一个**安全的增量**。
 *
 * 留 10% 余量：很多模型在量程两端会露出破绽（脖子穿模、眼白露出），
 * 而且情绪层同时也在写同一根参数 —— 两边加起来正好顶到端点时最容易穿。
 * 返回 0 表示「这个幅度不值得写」（量程太小 / 比例太小）。
 */
export function deltaForRatio(parameter, ratio) {
  if (parameter === null || typeof parameter !== 'object') return 0;
  const min = finiteOr(parameter.min, -1);
  const max = finiteOr(parameter.max, 1);
  const span = max - min;
  if (!(span > 0)) return 0;
  const want = finiteOr(ratio, 0) * span;
  const margin = span * 0.1;
  const low = min + margin;
  const high = max - margin;
  if (!(high > low)) return 0;
  const def = clamp(finiteOr(parameter.def, (min + max) / 2), low, high);
  const target = clamp(def + want, low, high);
  const delta = target - def;
  if (Math.abs(delta) < span * 0.015) return 0;
  return round3(delta);
}

/**
 * 生成一份包。
 *
 * `bindings` 是面板里那张「角色 → 参数 id」表（`settings.json` 的 `emotionBindings`）；
 * 传空对象也能work —— 那就全靠同义名自动认。
 *
 * 返回的包**只含模型真的有的参数**：认不出来的角色记在 `missing` 里，面板照实报
 * （「这个模型没有呆毛」比「呆毛动了」更诚实）。某一段里所有角色都认不出时，
 * 那一段整段丢掉 —— 剩下的段照样是一个完整动作，只是少了一个「后到的部位」。
 */
export function buildMicroMotionPack(options = {}) {
  const capabilities = options.capabilities ?? null;
  const parameters = Array.isArray(capabilities?.parameters) ? capabilities.parameters : [];
  const declared = new Map();
  for (const item of parameters) {
    if (item === null || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || item.id === '') continue;
    if (MOUTH_PARAMETER_IDS.includes(item.id)) continue;
    declared.set(item.id, item);
  }
  const bindings = options.bindings ?? {};
  const modelId = typeof options.model === 'string' ? options.model : '';
  const modelName = typeof options.name === 'string' ? options.name : modelId;

  /*
   * 大小写与下划线都不敏感的第二轮。
   *
   * `pickRoleParameter()` 是**精确**匹配，这对情绪层是对的（绑的 id 写错一个字母
   * 就该报 `bindingMissing`）。但微动作这一层的场景不同：它要面对的是用户刚导进来
   * 的陌生模型，而 Cubism 参数名的大小写与分隔并不统一 —— Wanko 那一套是
   * `PARAM_ANGLE_X`，候选表里写的是 `ParamAngleX`。只做小写不够：`PARAM_ANGLE_X`
   * 小写之后是 `param_angle_x`，与 `paramanglex` 仍差两个下划线。所以两边都先
   * 去掉分隔符再比。
   *
   * **只在没有绑定时做**：用户明确绑过的 id 若不存在，那是要让他看见的
   * （`bindingMissing`），不该被悄悄换成另一个。
   */
  const fold = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const lowered = new Map();
  for (const [id] of declared) lowered.set(fold(id), id);
  /*
   * 实测判定「写了没反应」的参数（§13.34）。
   *
   * 参数表里有、名字也对，但骨架没接 —— 灵梦那套的 `ParamAngle*` 就是这种。
   * 如实测说它不动，就当这个部位不存在：走替代表借力，比写一个没反应的值诚实。
   */
  const dead = options.deadParameters instanceof Set
    ? options.deadParameters
    : new Set(Array.isArray(options.deadParameters) ? options.deadParameters : []);
  const deadRoles = [];
  function pickRole(role) {
    const picked = pickRoleParameter(role, declared, bindings);
    // `boundId` 可能不存在（无绑定）—— 用 `!= null` 而不是 `!== null`。
    if (picked.id !== null || picked.boundId != null) {
      if (picked.id !== null && dead.has(picked.id)) {
        deadRoles.push({ role, id: picked.id });
        return { id: null, source: 'none', boundId: picked.boundId ?? null, bindingMissing: false };
      }
      return picked;
    }
    for (const candidate of ROLE_PARAMETER_IDS[role] ?? []) {
      const hit = lowered.get(fold(candidate));
      if (hit !== undefined) {
        if (dead.has(hit)) {
          deadRoles.push({ role, id: hit });
          return { id: null, source: 'none', boundId: null, bindingMissing: false };
        }
        return { id: hit, source: 'auto', boundId: null, bindingMissing: false };
      }
    }
    return picked;
  }

  /** 角色 → 真实参数（含来源，面板上要显示「自动认出 / 你绑的」）。 */
  const roles = [];
  const resolved = new Map();
  const missing = [];
  for (const role of MICRO_MOTION_ROLE_ORDER) {
    const picked = pickRole(role);
    if (picked === null || picked.id === null) {
      missing.push(role);
      continue;
    }
    const parameter = declared.get(picked.id) ?? null;
    if (parameter === null) {
      missing.push(role);
      continue;
    }
    resolved.set(role, parameter);
    roles.push({
      role,
      label: ROLE_LABELS[role] ?? role,
      id: picked.id,
      source: picked.source === 'binding' ? 'binding' : 'auto',
      min: finiteOr(parameter.min, -1),
      max: finiteOr(parameter.max, 1),
      def: finiteOr(parameter.def, 0),
    });
  }

  /*
   * 角色 → 真正要写的那根（或那几根）参数。
   *
   * 认出来的角色直接用；没认出来的走 `MICRO_MOTION_ROLE_SUBSTITUTES` 借力。
   * `used` 只记「真的被用上过的替代关系」，面板与门禁都按它说话 ——
   * 记「表里写了什么」没有意义（那张表对每个模型都一样）。
   */
  const usedSubs = new Map();
  /*
   * 借力可以**串**：`browLForm → browLY → angleY`。深度限 2 层是刻意的 ——
   * 再深就变成「任何部位都能借到任何部位」，一块动不了的模型会让所有动作
   * 塌到同一根参数上，那是另一种「看着不对」。`visited` 防环（两张表互为替代）。
   */
  function resolveTargets(role, scale = 1, depth = 0, visited = new Set()) {
    const direct = resolved.get(role);
    if (direct !== undefined) return [{ parameter: direct, scale }];
    if (depth >= 2 || visited.has(role)) return [];
    visited.add(role);
    const targets = [];
    for (const item of Object.prototype.hasOwnProperty.call(MICRO_MOTION_ROLE_SUBSTITUTES, role)
      ? MICRO_MOTION_ROLE_SUBSTITUTES[role]
      : []) {
      const inner = resolveTargets(item.role, scale * item.ratio, depth + 1, visited);
      if (inner.length === 0) continue;
      targets.push(...inner);
      usedSubs.set(`${role}>${item.role}`, { from: role, to: item.role, ratio: item.ratio * scale });
    }
    return targets;
  }

  const gestures = [];
  for (const spec of MICRO_MOTION_CATALOG) {
    const parts = buildParts(spec.parts, resolveTargets);
    if (parts.length === 0) continue;
    const tags = Array.isArray(spec.tags) ? spec.tags.filter((tag) => EMOTION_TAGS.includes(tag)) : [];
    const modes = Array.isArray(spec.modes) ? spec.modes.filter((mode) => mode === 'idle' || mode === 'talk') : [];
    gestures.push({
      id: spec.id,
      label: spec.label,
      parts,
      attackMs: clamp(finiteOr(spec.attackMs, 300), 60, 3000),
      holdMs: clamp(finiteOr(spec.holdMs, 500), 40, 6000),
      releaseMs: clamp(finiteOr(spec.releaseMs, 500), 80, 4000),
      gaze: spec.gaze === true,
      tags,
      modes: modes.length === 0 ? ['idle'] : modes,
      weight: clamp(finiteOr(spec.weight, 1), 0.1, 4),
      enabled: true,
      hidden: false,
    });
  }

  return {
    version: MICRO_MOTION_VERSION,
    model: modelId,
    name: modelName,
    generatedAt: Number.isFinite(options.now) ? options.now : 0,
    strength: MICRO_MOTION_DEFAULT_STRENGTH,
    roles,
    missing,
    substitutions: [...usedSubs.values()],
    dead: deadRoles,
    gestures,
  };
}

/**
 * 动作表里的 `parts` → 包里的 `parts`（角色换成真实参数 id、比例换成增量）。
 *
 * 两件事必须在这里做对：
 *  - **段序按 delay 排好**（动作表里已经是有序的，但归一化不依赖作者记性）；
 *  - **空段丢掉**，而不是留一个 `{delayMs, params:{}}` —— 空段会让「这条动作有
 *    四段」变成一句谎话，门禁与面板都按段数说话。
 */
function buildParts(specParts, resolveTargets) {
  const parts = [];
  const list = Array.isArray(specParts) ? specParts : [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const params = buildParams(raw.roles, resolveTargets);
    if (Object.keys(params).length === 0) continue;
    parts.push({
      delayMs: clamp(finiteOr(raw.delayMs, 0), 0, MICRO_MOTION_MAX_PART_DELAY_MS),
      params,
    });
    if (parts.length >= MICRO_MOTION_MAX_PARTS) break;
  }
  parts.sort((left, right) => left.delayMs - right.delayMs);
  return parts;
}

/**
 * 一段里的「角色: 比例」→「参数 id: 增量」。
 *
 * 同一个参数可能被两条路写中（主角色 + 别人的替代品），所以这里是**累加**而不是覆盖；
 * 累加完再夹一次 `±MICRO_MOTION_MAX_DELTA`，否则「耸肩借身体侧倾」叠上「侧身本身」
 * 会写出一个超过量程的值。
 */
function buildParams(roleRatios, resolveTargets) {
  const params = {};
  if (roleRatios === null || typeof roleRatios !== 'object') return params;
  for (const [role, ratio] of Object.entries(roleRatios)) {
    for (const target of resolveTargets(role)) {
      const parameter = target.parameter;
      if (parameter === null || typeof parameter !== 'object') continue;
      const delta = deltaForRatio(parameter, ratio * target.scale);
      if (delta === 0) continue;
      // 双保险：嘴永远不进来（角色表本来就没有嘴，但生成器自己也要守住这条）。
      if (MOUTH_PARAMETER_IDS.includes(parameter.id)) continue;
      const id = parameter.id;
      const sum = round3((params[id] ?? 0) + delta);
      params[id] = clamp(sum, -MICRO_MOTION_MAX_DELTA, MICRO_MOTION_MAX_DELTA);
    }
  }
  return params;
}

/**
 * 把磁盘 / 网络上来的一份包收拾成可用的形状。
 *
 * 这份包会跨三个进程边界（Host 落盘 → HTTP → 渲染端），而**每一道边界都是 JSON**：
 * 类型在运行时才出现。不能信的字段一律丢回默认值，参数只留有限数 —— 一个
 * `null` 混进 `params` 会让 Cubism 那一侧静默 NaN，表现成「模型整张脸不动了」。
 */
export function normalizeMicroMotionPack(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  if (finiteOr(raw.version, 0) !== MICRO_MOTION_VERSION) return null;
  const gestures = [];
  for (const item of Array.isArray(raw.gestures) ? raw.gestures : []) {
    if (item === null || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || item.id === '') continue;
    const parts = normalizeParts(item.parts);
    if (parts.length === 0) continue;
    gestures.push({
      id: item.id.slice(0, 64),
      label: typeof item.label === 'string' ? item.label.slice(0, 64) : item.id,
      parts,
      attackMs: clamp(finiteOr(item.attackMs, 300), 60, 3000),
      holdMs: clamp(finiteOr(item.holdMs, 500), 40, 6000),
      releaseMs: clamp(finiteOr(item.releaseMs, 500), 80, 4000),
      gaze: item.gaze === true,
      tags: Array.isArray(item.tags)
        ? item.tags.filter((tag) => typeof tag === 'string' && EMOTION_TAGS.includes(tag)).slice(0, 4)
        : [],
      modes: Array.isArray(item.modes) && item.modes.some((mode) => mode === 'idle' || mode === 'talk')
        ? item.modes.filter((mode) => mode === 'idle' || mode === 'talk')
        : ['idle'],
      weight: clamp(finiteOr(item.weight, 1), 0.1, 4),
      enabled: item.enabled !== false,
      hidden: item.hidden === true,
    });
    if (gestures.length >= MICRO_MOTION_MAX_GESTURES) break;
  }
  if (gestures.length === 0) return null;
  return {
    version: MICRO_MOTION_VERSION,
    model: typeof raw.model === 'string' ? raw.model : '',
    name: typeof raw.name === 'string' ? raw.name.slice(0, 96) : '',
    generatedAt: finiteOr(raw.generatedAt, 0),
    probeAt: finiteOr(raw.probeAt, 0),
    strength: clamp(finiteOr(raw.strength, MICRO_MOTION_DEFAULT_STRENGTH),
      MICRO_MOTION_MIN_STRENGTH, MICRO_MOTION_MAX_STRENGTH),
    roles: Array.isArray(raw.roles)
      ? raw.roles.filter((role) => role !== null && typeof role === 'object' && typeof role.role === 'string')
        .map((role) => ({
          role: role.role.slice(0, 48),
          label: typeof role.label === 'string' ? role.label.slice(0, 48) : role.role,
          id: typeof role.id === 'string' ? role.id.slice(0, 128) : '',
          source: role.source === 'binding' ? 'binding' : 'auto',
        }))
        .slice(0, 32)
      : [],
    missing: Array.isArray(raw.missing)
      ? raw.missing.filter((role) => typeof role === 'string').slice(0, 32)
      : [],
    substitutions: Array.isArray(raw.substitutions)
      ? raw.substitutions
        .filter((item) => item !== null && typeof item === 'object'
          && typeof item.from === 'string' && typeof item.to === 'string')
        .map((item) => ({
          from: item.from.slice(0, 48),
          to: item.to.slice(0, 48),
          ratio: clamp(finiteOr(item.ratio, 0.5), 0.05, 1),
        }))
        .slice(0, 16)
      : [],
    dead: Array.isArray(raw.dead)
      ? raw.dead
        .filter((item) => item !== null && typeof item === 'object' && typeof item.role === 'string')
        .map((item) => ({ role: item.role.slice(0, 48), id: typeof item.id === 'string' ? item.id.slice(0, 128) : '' }))
        .slice(0, 32)
      : [],
    gestures,
  };
}

function normalizeParts(raw) {
  const parts = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const params = normalizeParams(item.params);
    if (Object.keys(params).length === 0) continue;
    parts.push({
      delayMs: clamp(finiteOr(item.delayMs, 0), 0, MICRO_MOTION_MAX_PART_DELAY_MS),
      params,
    });
    if (parts.length >= MICRO_MOTION_MAX_PARTS) break;
  }
  parts.sort((left, right) => left.delayMs - right.delayMs);
  return parts;
}

function normalizeParams(raw) {
  const params = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return params;
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== 'string' || id === '' || id.length > 128) continue;
    if (MOUTH_PARAMETER_IDS.includes(id)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    // 增量按**参数自己的单位**夹（±90 能盖住 Cubism 标准的全部角度参数）。
    params[id] = round3(clamp(value, -MICRO_MOTION_MAX_DELTA, MICRO_MOTION_MAX_DELTA));
  }
  return params;
}

/** 最后一段晚多久起步（毫秒）。 */
export function microMotionLeadInMs(gesture) {
  const parts = Array.isArray(gesture?.parts) ? gesture.parts : [];
  let lead = 0;
  for (const part of parts) {
    const delay = finiteOr(part?.delayMs, 0);
    if (delay > lead) lead = delay;
  }
  return Math.max(0, lead);
}

/** 这一条动作总共演多久（毫秒）= 最后一段的延迟 + 包络三段。 */
export function microMotionTotalMs(gesture) {
  const attack = finiteOr(gesture?.attackMs, 300);
  const hold = finiteOr(gesture?.holdMs, 500);
  const release = finiteOr(gesture?.releaseMs, 500);
  return Math.min(MICRO_MOTION_MAX_TOTAL_MS, attack + hold + release + microMotionLeadInMs(gesture));
}

/**
 * 挑一条。
 *
 * 权重 = 基础权重 × 情绪匹配（1.8）× 「刚演过」降权（0.25）。情绪匹配用 `max`
 * 而不是累乘：一条动作同时挂 `好奇` / `思考` 时，不该因为两个都在场就变成
 * 3.24 倍——那会让「思考时只看得到抬眼」。
 */
export function pickMicroMotion(pack, options = {}) {
  const gestures = Array.isArray(pack?.gestures) ? pack.gestures : [];
  if (gestures.length === 0) return null;
  const mode = options.mode === 'talk' ? 'talk' : 'idle';
  const emotions = Array.isArray(options.emotions) ? options.emotions : [];
  const allowGaze = options.allowGaze !== false;
  const avoidId = typeof options.avoidId === 'string' ? options.avoidId : '';
  const minWeight = 1e-6;
  let total = 0;
  const weighted = [];
  for (const gesture of gestures) {
    if (gesture === null || typeof gesture !== 'object') continue;
    if (gesture.enabled === false) continue;
    if (!Array.isArray(gesture.modes) || !gesture.modes.includes(mode)) continue;
    if (gesture.gaze === true && !allowGaze) continue;
    let weight = finiteOr(gesture.weight, 1);
    const tags = Array.isArray(gesture.tags) ? gesture.tags : [];
    if (emotions.some((name) => tags.includes(name))) weight *= 1.8;
    if (gesture.id === avoidId) weight *= 0.25;
    if (!(weight > minWeight)) continue;
    weighted.push({ gesture, weight });
    total += weight;
  }
  if (total <= minWeight) return null;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  let target = random() * total;
  for (const item of weighted) {
    target -= item.weight;
    if (target <= 0) return item.gesture;
  }
  return weighted[weighted.length - 1].gesture;
}

/** 下一次该等多久（毫秒）。说话时更密，但不会密到每句话都在摇。 */
export function microMotionDelayMs(mode, random = Math.random) {
  const lo = mode === 'talk' ? MICRO_MOTION_TALK_MIN_DELAY_MS : MICRO_MOTION_MIN_DELAY_MS;
  const hi = mode === 'talk' ? MICRO_MOTION_TALK_MAX_DELAY_MS : MICRO_MOTION_MAX_DELAY_MS;
  return Math.round(lo + (hi - lo) * clamp(typeof random === 'function' ? random() : 0, 0, 1));
}

/** 强度滑杆的夹取（面板 POST 与 Host 都要走这一道）。 */
export function normalizeMicroMotionStrength(value) {
  return clamp(finiteOr(value, MICRO_MOTION_DEFAULT_STRENGTH),
    MICRO_MOTION_MIN_STRENGTH, MICRO_MOTION_MAX_STRENGTH);
}

/**
 * 面板与 `live2d_status` 用的一句人话。
 *
 * 说清楚四件事：有多少条、这些条挂了哪些情绪、每条动几个部位、哪些部位这个模型
 * 没有。第一版如果一条都生成不出来（模型没有骨骼参数，只有贴图），这里必须能
 * 说出来 —— 否则用户看到的是一个空的微动作面板与一段静默。
 */
export function describeMicroMotionPack(pack) {
  const gestures = Array.isArray(pack?.gestures) ? pack.gestures : [];
  if (gestures.length === 0) {
    return '微动作：这个模型没有可用的骨骼参数（只有贴图或参数被隐藏），生成不出微动作。';
  }
  const enabled = gestures.filter((gesture) => gesture.enabled !== false).length;
  const idle = gestures.filter((gesture) => gesture.modes.includes('idle')).length;
  const talk = gestures.filter((gesture) => gesture.modes.includes('talk')).length;
  const partsTotal = gestures.reduce((sum, gesture) => sum + gesture.parts.length, 0);
  const partsAvg = Math.round((partsTotal / gestures.length) * 10) / 10;
  const tagCount = new Map();
  for (const gesture of gestures) {
    for (const tag of gesture.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }
  const tagText = [...tagCount.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([tag, count]) => `${tag} ${count}`)
    .join(' / ');
  const missing = Array.isArray(pack?.missing) ? pack.missing : [];
  const missingText = missing.length === 0
    ? '全部部位都认出来了'
    : `这个模型没有 ${missing.map((role) => ROLE_LABELS[role] ?? role).join(' / ')}`;
  const subs = Array.isArray(pack?.substitutions) ? pack.substitutions : [];
  const subText = subs.length === 0
    ? ''
    : `；缺的部位按 ${subs.map((item) => `${ROLE_LABELS[item.from] ?? item.from}→${ROLE_LABELS[item.to] ?? item.to}`).join(' / ')} 借力`;
  const dead = Array.isArray(pack?.dead) ? pack.dead : [];
  const deadText = dead.length === 0 ? '' : `；实测有 ${dead.length} 根参数写了不动（已避开）`;
  return `微动作 ${gestures.length} 条（启用 ${enabled}：待机 ${idle} / 说话 ${talk}，`
    + `每条平均 ${partsAvg} 段），情绪适配 ${tagText}；${missingText}${subText}${deadText}。`;
}

/**
 * 把内部包转成**跨边界视图**（`/micro-motions` 的响应、`live2d_micro_motion` 的清单）。
 *
 * 为什么单独拎成一个纯函数（§13.32 的教训）：上一版这个视图是在 `lib/index.js`
 * 里手拼的，漏掉了 `version`；渲染端 `normalizeMicroMotionPack()` 严格要它，
 * 于是整份包被判成不认识 —— 自动微动作与「试演」一起安静地停掉，而 Host 侧
 * 一切正常。手拼的投影**每加一个字段都要两端同时记得**，而这种「记得」正是
 * 门禁该钉住的东西：现在门禁喂的是这个函数真出产的视图，不是手写夹具。
 */
export function buildMicroMotionView(pack, options = {}) {
  const source = typeof options.source === 'string' && options.source !== '' ? options.source : 'none';
  const { source: _ignoredSource, ...extra } = options;
  return {
    ok: pack !== null && pack !== undefined,
    version: pack?.version ?? 0,
    model: pack?.model ?? '',
    name: pack?.name ?? '',
    source,
    generatedAt: pack?.generatedAt ?? 0,
    probeAt: pack?.probeAt ?? 0,
    generatedAtText: typeof extra.generatedAtText === 'string' ? extra.generatedAtText : '',
    strength: pack?.strength ?? MICRO_MOTION_DEFAULT_STRENGTH,
    summary: pack ? describeMicroMotionPack(pack) : '',
    roles: Array.isArray(pack?.roles) ? pack.roles : [],
    missing: Array.isArray(pack?.missing) ? pack.missing : [],
    substitutions: Array.isArray(pack?.substitutions) ? pack.substitutions : [],
    dead: Array.isArray(pack?.dead) ? pack.dead : [],
    gestures: Array.isArray(pack?.gestures) ? pack.gestures : [],
    ...extra,
  };
}

/** 一条动作的时长是否在合理区间（门禁与面板都读这个判断）。 */
export function microMotionTimingSane(gesture) {
  const total = microMotionTotalMs(gesture);
  return total >= 220 && total <= MICRO_MOTION_MAX_TOTAL_MS
    && finiteOr(gesture?.attackMs, 0) >= 60
    && finiteOr(gesture?.releaseMs, 0) >= 80;
}
