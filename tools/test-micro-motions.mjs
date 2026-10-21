#!/usr/bin/env node
/**
 * 门禁：**微动作**（`lib/host/micro-motions.js` + `src/client/micro-motion.ts`）。
 *
 * ## 为什么需要这个文件
 *
 * 这一层的证据只有「她好像会自己动了」。听上去是加分项，坏起来却有五种安静的死法：
 *
 *   1. 认错参数（把 `ParamAngleY` 当成歪头）—— 画面只是「方向不对」，没人查得出来；
 *   2. 幅度按绝对值写死 —— 在 ±10 度的模型上像抽搐，在 ±30 度的模型上看不见；
 *   3. 说了话还挑待机向的动作 —— 口型是主角，旁边却在耸肩膀；
 *   4. 正经动作在播时还叠上去 —— 两条同写一根参数，幅度翻倍；
 *   5. 包落盘写到一半被杀 —— 下次读到半截 JSON，整层静默失效。
 *
 * 生成器、挑选规则、排期全在纯函数里（这样这里能逐条对账，不需要 Cubism、
 * 不需要浏览器）；接线（`pet-model.ts` / `plugin.ts` / 面板）只能读源码对账。
 *
 * ## 用法
 *
 *     node tools/test-micro-motions.mjs      （离线：无网络、无 DOM、无画布）
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const PACKAGE = resolve(ROOT, 'dsh-live2d-pet');
const HOST_MODULE = resolve(PACKAGE, 'lib/host/micro-motions.js');
const LIB_MODULE = resolve(PACKAGE, 'lib/host/micro-motion-library.js');
const CLIENT_MIRROR = resolve(PACKAGE, 'lib/test/micro-motion.mjs');

let failed = 0;
let passed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

if (!existsSync(HOST_MODULE) || !existsSync(LIB_MODULE)) {
  console.error('Host 侧微动作模块不存在：');
  console.error(`  ${HOST_MODULE}`);
  console.error(`  ${LIB_MODULE}`);
  process.exit(2);
}
if (!existsSync(CLIENT_MIRROR)) {
  console.error(`渲染端的纯逻辑产物不存在：${CLIENT_MIRROR}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const host = await import(pathToFileURL(HOST_MODULE).href);
const library = await import(pathToFileURL(LIB_MODULE).href);
const client = await import(pathToFileURL(CLIENT_MIRROR).href);

const {
  MICRO_MOTION_MAX_GESTURES,
  MICRO_MOTION_MIN_DELAY_MS,
  MICRO_MOTION_MAX_DELAY_MS,
  MICRO_MOTION_TALK_MIN_DELAY_MS,
  MICRO_MOTION_TALK_MAX_DELAY_MS,
  MICRO_MOTION_ABORT_DELAY_MS,
  MICRO_MOTION_DEFAULT_STRENGTH,
  MICRO_MOTION_MAX_TOTAL_MS,
  MICRO_MOTION_ROLE_ORDER,
  MICRO_MOTION_CATALOG,
  buildMicroMotionPack,
  buildMicroMotionView,
  normalizeMicroMotionPack,
  deltaForRatio,
  microMotionTotalMs,
  microMotionTimingSane,
  pickMicroMotion,
  microMotionDelayMs,
  normalizeMicroMotionStrength,
  describeMicroMotionPack,
} = host;

/** hiyori 那套形状（数值取自 Core 的默认区间）。 */
function hiyoriCapabilities() {
  const param = (id, min, max, def) => ({ id, min, max, def });
  return {
    parameters: [
      param('ParamAngleX', -30, 30, 0),
      param('ParamAngleY', -30, 30, 0),
      param('ParamAngleZ', -30, 30, 0),
      param('ParamBodyAngleX', -10, 10, 0),
      param('ParamBodyAngleZ', -10, 10, 0),
      param('ParamEyeBallX', -1, 1, 0),
      param('ParamEyeBallY', -1, 1, 0),
      param('ParamBrowLY', -1, 1, 0),
      param('ParamBrowRY', -1, 1, 0),
      param('ParamBrowLForm', -1, 1, 0),
      param('ParamBrowRForm', -1, 1, 0),
      param('ParamShoulder', -1, 1, 0),
      param('ParamHairAhoge', -10, 10, 0),
      param('ParamEyeLOpen', 0, 1.2, 1),
      param('ParamMouthOpenY', 0, 1, 0),
      param('ParamMouthForm', -1, 1, 0),
    ],
    expressions: [],
    motionGroups: [],
    hitAreas: [],
  };
}

/** 一个可复现的随机源（mulberry32）。 */
function seeded(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('[1] 常量与动作表');
check('包版本 2（多段错峰）', host.MICRO_MOTION_VERSION === 2, `= ${host.MICRO_MOTION_VERSION}`);
check('最多 24 条', MICRO_MOTION_MAX_GESTURES === 24, `= ${MICRO_MOTION_MAX_GESTURES}`);
check('一条最多 4 段、单段最多晚 600 ms', host.MICRO_MOTION_MAX_PARTS === 4 && host.MICRO_MOTION_MAX_PART_DELAY_MS === 600);
check('待机间隔 6500~15000', MICRO_MOTION_MIN_DELAY_MS === 6500 && MICRO_MOTION_MAX_DELAY_MS === 15000);
check('说话间隔 4200~9000（比待机密）', MICRO_MOTION_TALK_MIN_DELAY_MS === 4200 && MICRO_MOTION_TALK_MAX_DELAY_MS === 9000);
check('说话档确实比待机档密', MICRO_MOTION_TALK_MIN_DELAY_MS < MICRO_MOTION_MIN_DELAY_MS, `${MICRO_MOTION_TALK_MIN_DELAY_MS} < ${MICRO_MOTION_MIN_DELAY_MS}`);
check('打断后 3000 ms 再试', MICRO_MOTION_ABORT_DELAY_MS === 3000);
check('默认强度 0.9（§13.32 提高，旧版是 0.75）', MICRO_MOTION_DEFAULT_STRENGTH === 0.9);

const ids = MICRO_MOTION_CATALOG.map((item) => item.id);
check('动作 id 不重复', new Set(ids).size === ids.length, `${ids.length} 条`);
for (const need of ['head-tilt', 'body-turn', 'glance-left', 'glance-right', 'nod', 'talk-tilt', 'sway', 'sigh']) {
  check(`动作表里有「${need}」`, ids.includes(need));
}
check('「歪头」主段就写头部侧倾，且幅度够看（≥0.2 量程 = ±30 上的 12 度）', (() => {
  const spec = MICRO_MOTION_CATALOG.find((item) => item.id === 'head-tilt');
  return typeof spec.parts[0].roles.angleZ === 'number' && spec.parts[0].roles.angleZ >= 0.2;
})(), JSON.stringify(MICRO_MOTION_CATALOG.find((item) => item.id === 'head-tilt').parts[0].roles));
check('「侧身」主段动的是身体（bodyAngleX/Z），头只在后面的段里反向找平', (() => {
  const spec = MICRO_MOTION_CATALOG.find((item) => item.id === 'body-turn');
  return typeof spec.parts[0].roles.bodyAngleX === 'number'
    && spec.parts[0].roles.angleZ === undefined
    && spec.parts.slice(1).some((part) => typeof part.roles.angleZ === 'number');
})());
for (const spec of MICRO_MOTION_CATALOG) {
  check(`${spec.id}：带标签或明确不标（tags 是数组）`, Array.isArray(spec.tags));
  check(`${spec.id}：三段时长都是正数`, spec.attackMs > 0 && spec.holdMs > 0 && spec.releaseMs > 0, `${spec.attackMs}/${spec.holdMs}/${spec.releaseMs}`);
  /*
   * §13.32 的核心约束：**一条动作至少两段、否则就是「只动了一个部位」**。
   * 用户的原话是「每个动作都是只改了某一个参数，这样不够真实」—— 这一条把
   * 「多部位参与」钉在动作表上，而不是靠生成器碰运气。
   */
  check(`${spec.id}：至少两段（多部位参与）`, spec.parts.length >= 2 && spec.parts.length <= 4, `${spec.parts.length} 段`);
  check(`${spec.id}：第一段从 0 起、后面的段越来越晚（同一次动作里后到的部位）`, spec.parts[0].delayMs === 0
    && spec.parts.every((part, index) => index === 0 || part.delayMs > spec.parts[index - 1].delayMs)
    && spec.parts.every((part) => part.delayMs >= 0 && part.delayMs <= 600), spec.parts.map((part) => part.delayMs).join('/'));
  check(`${spec.id}：后到的段至少晚 60 ms（同时起步就没了先后感）`, spec.parts.slice(1).every((part) => part.delayMs >= 60));
}
check('动作表里不碰嘴（嘴归语音通道）', MICRO_MOTION_CATALOG.every((spec) => spec.parts.every((part) => Object.keys(part.roles).every((role) => role !== 'mouth'))));
check('每条动作至少动 3 处（单参数动作就是用户说的「不够真实」）', MICRO_MOTION_CATALOG.every((spec) => spec.parts.reduce((sum, part) => sum + Object.keys(part.roles).length, 0) >= 3), MICRO_MOTION_CATALOG.filter((spec) => spec.parts.reduce((sum, part) => sum + Object.keys(part.roles).length, 0) < 3).map((spec) => spec.id).join(',') || 'ok');

console.log('[2] 生成器：hiyori 形状');
const pack = buildMicroMotionPack({
  capabilities: hiyoriCapabilities(),
  bindings: {},
  model: 'hiyori',
  name: 'hiyori',
  now: 1700000000000,
});
check('生成出动作', pack.gestures.length >= 10, `${pack.gestures.length} 条`);
check('版本、模型、时间戳都对', pack.version === 2 && pack.model === 'hiyori' && pack.generatedAt === 1700000000000);
check('默认强度写进包里（0.9）', pack.strength === 0.9, `${pack.strength}`);
check('认出全部 13 个角色', pack.missing.length === 0, `缺 ${pack.missing.join(',') || '无'}`);
check('13 个角色都在包里', pack.roles.length === MICRO_MOTION_ROLE_ORDER.length, `${pack.roles.length}`);
check('每个角色的参数 id 都是模型真有的', pack.roles.every((role) => hiyoriCapabilities().parameters.some((item) => item.id === role.id)));
check('每个角色都标了来源（auto）', pack.roles.every((role) => role.source === 'auto'));

const declared = new Set(hiyoriCapabilities().parameters.map((item) => item.id));
const declaredSpec = new Map(hiyoriCapabilities().parameters.map((item) => [item.id, item]));
/** v2：参数摊在 `parts[].params` 里，这里摊平给通用断言用。 */
const allParams = (gesture) => {
  const merged = {};
  for (const part of gesture?.parts ?? []) Object.assign(merged, part.params);
  return merged;
};
for (const gesture of pack.gestures) {
  const params = allParams(gesture);
  const keys = Object.keys(params);
  check(`${gesture.id}：参数非空、全是有限数`, keys.length > 0 && Object.values(params).every((value) => Number.isFinite(value)), keys.join(','));
  check(`${gesture.id}：参数都在模型里`, keys.every((id) => declared.has(id)), keys.filter((id) => !declared.has(id)).join(',') || 'ok');
  check(`${gesture.id}：不碰嘴`, keys.every((id) => id !== 'ParamMouthOpenY' && id !== 'ParamMouthForm'));
  check(`${gesture.id}：不超出参数自己的量程`, keys.every((id) => {
    const spec = declaredSpec.get(id);
    return Math.abs(params[id]) <= Math.max(Math.abs(spec.min), Math.abs(spec.max));
  }), keys.map((id) => `${id}:${params[id]}`).join(' '));
  check(`${gesture.id}：是「微」动作（不到半量程）`, keys.every((id) => {
    const spec = declaredSpec.get(id);
    return Math.abs(params[id]) <= (spec.max - spec.min) * 0.4;
  }));
  check(`${gesture.id}：时长合理`, microMotionTimingSane(gesture), `${microMotionTotalMs(gesture)} ms`);
  check(`${gesture.id}：默认启用`, gesture.enabled === true);
  check(`${gesture.id}：modes 只含 idle/talk`, gesture.modes.every((mode) => mode === 'idle' || mode === 'talk'), gesture.modes.join('/'));
  check(`${gesture.id}：至少两段、段延迟递增`, gesture.parts.length >= 2
    && gesture.parts.every((part, index) => index === 0 || part.delayMs > gesture.parts[index - 1].delayMs), gesture.parts.map((part) => part.delayMs).join('/'));
}
check('「歪头」落在 ParamAngleZ 且一眼看得出（≥12 度 = 量程 30 的 40%）', (() => {
  const gesture = pack.gestures.find((item) => item.id === 'head-tilt');
  return gesture !== undefined && Math.abs(gesture.parts[0].params.ParamAngleZ ?? 0) >= 12;
})());
check('「歪头」没有歪到脖子断（≤18 度 = 量程 30 的 60%）', (() => {
  const gesture = pack.gestures.find((item) => item.id === 'head-tilt');
  return Math.abs(gesture.parts[0].params.ParamAngleZ ?? 0) <= 18;
})(), `${pack.gestures.find((item) => item.id === 'head-tilt')?.parts[0].params.ParamAngleZ}`);
check('「歪头」不是只有头在动（后面还有视线 / 重心 / 呆毛）', (() => {
  const gesture = pack.gestures.find((item) => item.id === 'head-tilt');
  if (gesture === undefined) return false;
  const later = gesture.parts.slice(1).flatMap((part) => Object.keys(part.params));
  return later.some((id) => id.startsWith('ParamEyeBall'))
    && later.some((id) => id.startsWith('ParamBody'))
    && later.some((id) => id === 'ParamHairAhoge');
})(), JSON.stringify(pack.gestures.find((item) => item.id === 'head-tilt')?.parts.map((part) => Object.keys(part.params))));
check('「侧身」动身体参数', (() => {
  const gesture = pack.gestures.find((item) => item.id === 'body-turn');
  return Object.keys(allParams(gesture ?? { parts: [] })).some((id) => id.startsWith('ParamBody'));
})());
check('「瞥一眼」先动眼、头后到（头在后面的段里）', (() => {
  const gesture = pack.gestures.find((item) => item.id === 'glance-left');
  return gesture !== undefined
    && Object.keys(gesture.parts[0].params).every((id) => id.startsWith('ParamEyeBall'))
    && gesture.parts.slice(1).some((part) => Object.keys(part.params).some((id) => id.startsWith('ParamAngle')));
})());
check('「点头」只在说话档', (() => {
  const gesture = pack.gestures.find((item) => item.id === 'nod');
  return gesture !== undefined && gesture.modes.includes('talk') && !gesture.modes.includes('idle');
})());
check('「侧身」只在待机档', (() => {
  const gesture = pack.gestures.find((item) => item.id === 'body-turn');
  return gesture !== undefined && gesture.modes.includes('idle') && !gesture.modes.includes('talk');
})());

console.log('[3] 生成器：量程不同、参数缺失、大小写');
const tiny = buildMicroMotionPack({
  capabilities: {
    parameters: [
      { id: 'ParamAngleZ', min: -10, max: 10, def: 0 },
      { id: 'ParamEyeBallX', min: -1, max: 1, def: 0 },
    ],
  },
  bindings: {},
  model: 'tiny',
});
const tinyTilt = tiny.gestures.find((item) => item.id === 'head-tilt');
check('量程 ±10 时歪头幅度也跟着小（≤9 度）', tinyTilt !== undefined && Math.abs(tinyTilt.parts[0].params.ParamAngleZ ?? 0) <= 9, `${tinyTilt?.parts[0].params.ParamAngleZ}`);
check('同一套动作表在 ±30 与 ±10 上给出不同绝对值', Math.abs(tinyTilt?.parts[0].params.ParamAngleZ ?? 0) < Math.abs(pack.gestures.find((item) => item.id === 'head-tilt').parts[0].params.ParamAngleZ));
check('缺的部位记进 missing', tiny.missing.length > 0, tiny.missing.join(','));
check('缺的部位不进 roles', tiny.roles.every((role) => role.id !== ''));
check('只动认得出的部位（动作都只用这两根参数）', tiny.gestures.every((gesture) => Object.keys(allParams(gesture)).every((id) => id === 'ParamAngleZ' || id === 'ParamEyeBallX')));

const uppercase = buildMicroMotionPack({
  capabilities: {
    parameters: [
      { id: 'PARAM_ANGLE_X', min: -30, max: 30, def: 0 },
      { id: 'PARAM_ANGLE_Z', min: -30, max: 30, def: 0 },
    ],
  },
  bindings: {},
  model: 'wanko',
});
check('全大写参数名也能认出来（Wanko）', uppercase.roles.some((role) => role.id === 'PARAM_ANGLE_Z'), uppercase.roles.map((role) => `${role.role}→${role.id}`).join(','));
check('认出来的个数比精确匹配多', uppercase.roles.length >= 2);

const nothing = buildMicroMotionPack({ capabilities: { parameters: [] }, bindings: {}, model: 'empty' });
check('没有骨骼参数时生成 0 条', nothing.gestures.length === 0);
check('这时说得出原因', describeMicroMotionPack(nothing).includes('骨骼参数'), describeMicroMotionPack(nothing).slice(0, 30));

const bound = buildMicroMotionPack({
  capabilities: {
    parameters: [
      { id: 'ParamAngleZa', min: -30, max: 30, def: 0 },
      { id: 'ParamAngleY', min: -30, max: 30, def: 0 },
    ],
  },
  bindings: { angleZ: 'ParamAngleZa' },
  model: 'odd',
});
check('绑定优先（绑了一个不常见的 id）', bound.roles.some((role) => role.role === 'angleZ' && role.id === 'ParamAngleZa' && role.source === 'binding'), JSON.stringify(bound.roles.filter((role) => role.role === 'angleZ')));

console.log('[4] 归一化（跨进程边界的那一道）');
check('版本不对 → null', normalizeMicroMotionPack({ ...pack, version: 99 }) === null);
check('v1 的包（单段 params + trailing）当没有包', normalizeMicroMotionPack({ ...pack, version: 1 }) === null);
check('不是对象 → null', normalizeMicroMotionPack(null) === null && normalizeMicroMotionPack('x') === null);
const dirty = {
  ...pack,
  gestures: [
    {
      id: 'dirty',
      parts: [
        { delayMs: 0, params: { ParamAngleZ: 999, ParamMouthOpenY: 0.8, ParamAngleX: Number.NaN } },
        { delayMs: 900, params: { ParamAngleY: 5 } },
        { delayMs: 120, params: { ParamEyeBallX: 0.2 } },
      ],
      attackMs: -5,
      holdMs: 3000,
      releaseMs: 99999,
      modes: ['talk', 'weird'],
      enabled: 'yes',
    },
    { id: 'hollow', parts: [{ delayMs: 0, params: {} }, { delayMs: 100, params: { ParamMouthForm: 0.5 } }] },
    {
      id: 'many-parts',
      parts: Array.from({ length: 7 }, (_, index) => ({ delayMs: index * 100, params: { ParamAngleZ: 1 } })),
      attackMs: 300,
      holdMs: 300,
      releaseMs: 300,
    },
  ],
};
const cleaned = normalizeMicroMotionPack(dirty);
check('脏包仍能归一化', cleaned !== null);
const dirtyGesture = cleaned?.gestures[0];
check('超量程的增量被夹到 ±90（角度参数自己的单位）', dirtyGesture?.parts[0].params.ParamAngleZ === 90, `${dirtyGesture?.parts[0].params.ParamAngleZ}`);
check('嘴参数被丢掉', dirtyGesture?.parts[0].params.ParamMouthOpenY === undefined);
check('NaN 被丢掉', dirtyGesture?.parts[0].params.ParamAngleX === undefined);
check('段按延迟排序，超过 600 ms 的延迟被夹回来', JSON.stringify((dirtyGesture?.parts ?? []).map((part) => part.delayMs)) === '[0,120,600]', JSON.stringify((dirtyGesture?.parts ?? []).map((part) => part.delayMs)));
check('负的淡入被抬到下限 60 ms', dirtyGesture?.attackMs === 60, `${dirtyGesture?.attackMs}`);
check('modes 只留 idle/talk（空则退回 idle）', JSON.stringify(dirtyGesture?.modes) === '["talk"]', JSON.stringify(dirtyGesture?.modes));
check('enabled 非布尔按「启用」处理', dirtyGesture?.enabled === true);
check('★ 一段都留不下的条目整条丢掉（不留空壳）', cleaned?.gestures.some((gesture) => gesture.id === 'hollow') === false);
check('★ 段数上限 4', (cleaned?.gestures.find((gesture) => gesture.id === 'many-parts')?.parts.length ?? 0) === 4);
check('条目上限 24', normalizeMicroMotionPack({ ...pack, gestures: Array.from({ length: 40 }, (_, index) => ({ ...pack.gestures[0], id: `g${index}` })) }).gestures.length === MICRO_MOTION_MAX_GESTURES);

console.log('[5] 挑选：情绪、视线、刚演过、说话档');
const random = seeded(20261019);
const drawn = new Map();
for (let index = 0; index < 800; index += 1) {
  const picked = pickMicroMotion(pack, { mode: 'idle', emotions: [], allowGaze: true, random });
  drawn.set(picked.id, (drawn.get(picked.id) ?? 0) + 1);
}
check('待机档不会挑到只在说话档的动作', !drawn.has('nod') && !drawn.has('talk-tilt'), [...drawn.keys()].join(','));
check('「侧身」在待机档里出现过', drawn.has('body-turn'));

const thinking = new Map();
for (let index = 0; index < 800; index += 1) {
  const picked = pickMicroMotion(pack, { mode: 'idle', emotions: ['思考'], allowGaze: true, random });
  thinking.set(picked.id, (thinking.get(picked.id) ?? 0) + 1);
}
check('「思考」时抬眼类的占比上升', (thinking.get('glance-up') ?? 0) > (drawn.get('glance-up') ?? 0), `${thinking.get('glance-up')} vs ${drawn.get('glance-up')}`);

const noGaze = new Set();
for (let index = 0; index < 400; index += 1) {
  noGaze.add(pickMicroMotion(pack, { mode: 'idle', emotions: [], allowGaze: false, random }).id);
}
check('不许动视线时不会挑到 gaze 动作', [...noGaze].every((id) => pack.gestures.find((item) => item.id === id)?.gaze !== true), [...noGaze].join(','));

const talkDrawn = new Set();
for (let index = 0; index < 400; index += 1) {
  talkDrawn.add(pickMicroMotion(pack, { mode: 'talk', emotions: [], allowGaze: true, random }).id);
}
check('说话档不会挑到只在待机档的动作', !talkDrawn.has('body-turn') && !talkDrawn.has('sway'), [...talkDrawn].join(','));
check('说话档挑得到说话向的动作', [...talkDrawn].some((id) => pack.gestures.find((item) => item.id === id)?.modes.includes('talk') && !pack.gestures.find((item) => item.id === id)?.modes.includes('idle')), [...talkDrawn].join(','));

const disabledPack = normalizeMicroMotionPack({
  ...pack,
  gestures: pack.gestures.map((item) => ({ ...item, enabled: item.id !== 'head-tilt' })),
});
check('关掉的那条永远不会被挑到', (() => {
  for (let index = 0; index < 500; index += 1) {
    if (pickMicroMotion(disabledPack, { mode: 'idle', emotions: [], random }).id === 'head-tilt') return false;
  }
  return true;
})());
check('全部关掉时挑不到（返回 null）', pickMicroMotion(normalizeMicroMotionPack({ ...pack, gestures: pack.gestures.map((item) => ({ ...item, enabled: false })) }), { mode: 'idle', random }) === null);
check('刚演过的降权（避免连演同一条）', (() => {
  let same = 0;
  for (let index = 0; index < 400; index += 1) {
    if (pickMicroMotion(pack, { mode: 'idle', emotions: [], avoidId: 'head-tilt', random }).id === 'head-tilt') same += 1;
  }
  const base = Math.round(400 * ((drawn.get('head-tilt') ?? 0) / 800));
  return same < base;
})());
const delays = new Set();
for (let index = 0; index < 200; index += 1) delays.add(microMotionDelayMs('idle', random));
check('待机间隔落在 6500~15000', [...delays].every((value) => value >= 6500 && value <= 15000), `${Math.min(...delays)}~${Math.max(...delays)}`);
const talkDelays = new Set();
for (let index = 0; index < 200; index += 1) talkDelays.add(microMotionDelayMs('talk', random));
check('说话间隔落在 4200~9000', [...talkDelays].every((value) => value >= 4200 && value <= 9000), `${Math.min(...talkDelays)}~${Math.max(...talkDelays)}`);
check('强度夹在 0.2~1.4（默认 0.9）', normalizeMicroMotionStrength(-3) === 0.2 && normalizeMicroMotionStrength(99) === 1.4 && normalizeMicroMotionStrength('x') === 0.9);
check('一句人话说清条数与缺失部位', describeMicroMotionPack(pack).includes('条') && describeMicroMotionPack(pack).includes('全部部位都认出来了'), describeMicroMotionPack(pack).slice(0, 40));
check('deltaForRatio 留了余量（跑到量程 90% 就停）', deltaForRatio({ min: -10, max: 10, def: 0 }, 0.95) === 8, `${deltaForRatio({ min: -10, max: 10, def: 0 }, 0.95)}`);
check('量程为 0 时返回 0', deltaForRatio({ min: 0, max: 0, def: 0 }, 0.3) === 0);

console.log('[6] 磁盘包（原子写、坏文件、缺失）');
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-micro-'));
try {
  const store = library.createMicroMotionStore({ root: tempRoot, now: () => 1700000000000 });
  const saved = store.save('hiyori', pack);
  check('存得下', saved.ok === true, saved.ok ? saved.path : saved.message);
  check('存完没有留下 .tmp', readdirSync(tempRoot).every((name) => !name.endsWith('.tmp')), readdirSync(tempRoot).join(','));
  const loaded = store.load('hiyori');
  check('读得回来', loaded.ok === true && loaded.pack.gestures.length === pack.gestures.length);
  check('读回来的强度一致', loaded.pack.strength === pack.strength);
  check('同一个模型名两次得到同一个 slug', library.slugForModel('hiyori') === library.slugForModel('hiyori'));
  check('不同模型名不同 slug', library.slugForModel('hiyori') !== library.slugForModel('hiyori-v5'));
  check('空模型名没有路径', library.slugForModel('') === '');

  const missing = store.load('nope');
  check('没有包时报 NOT_FOUND', missing.ok === false && missing.code === 'E_MICRO_NOT_FOUND', missing.code);

  const badPath = store.packPathFor('broken');
  writeFileSync(badPath, '{ not json', 'utf8');
  const broken = store.load('broken');
  check('坏 JSON 报 BAD_JSON（不是抛异常）', broken.ok === false && broken.code === 'E_MICRO_BAD_JSON', broken.code);

  writeFileSync(badPath, JSON.stringify({ version: 99, gestures: [] }), 'utf8');
  const badVersion = store.load('broken');
  check('版本不对报 BAD_PACK', badVersion.ok === false && badVersion.code === 'E_MICRO_BAD_PACK', badVersion.code);

  const listed = store.list();
  check('list 能列出已有的包', listed.ok === true && Array.isArray(listed.packs) && listed.packs.some((item) => item.model === 'hiyori'), `${listed.packs?.length ?? 0} 个`);
  check('remove 之后读不到', store.remove('hiyori').ok === true && store.load('hiyori').ok === false);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('[7] 渲染端播放器');
check('产物导出创建状态', typeof client.createMicroMotionState === 'function');
const state = client.createMicroMotionState();
check('初始没有在演、没有排期', state.gesture === null && state.nextAtMs === 0 && state.count === 0);
const clientPack = client.normalizeMicroMotionPack(JSON.parse(JSON.stringify(pack)));
check('包能过渲染端归一化', clientPack !== null && clientPack.gestures.length === pack.gestures.length);
/*
 * §13.32 的真 bug：渲染端拿到的是 Host 的**视图**（`/micro-motions` 的响应），
 * 不是裸包。视图少一个 `version`，严格校验的渲染端就把整份包判成不认识 ——
 * 上一版这条断言喂的是裸包，于是它绿着，而真机「试演没效果」。
 * 现在喂的是 `buildMicroMotionView()` **真出产**的视图（Host 与门禁同一个函数）。
 */
check('★ 渲染端认的是 Host 的视图（不是裸包）', (() => {
  const view = buildMicroMotionView(pack, { source: 'disk', generatedAtText: '2026-10-19 16:00:00' });
  const normalized = client.normalizeMicroMotionPack(view);
  return normalized !== null && normalized.gestures.length === pack.gestures.length;
})());
check('★ 视图里带 version（漏了就是「试演没效果」而且没有一行日志）', (() => {
  const view = buildMicroMotionView(pack, { source: 'disk' });
  return view.version === pack.version && view.version === 2;
})());
check('★ 视图漏掉 version 时按形状认（Host 与页面各自更新的那段窗口里不许整份作废）', (() => {
  const { version: _dropped, ...withoutVersion } = buildMicroMotionView(pack, { source: 'disk' });
  const normalized = client.normalizeMicroMotionPack(withoutVersion);
  return normalized !== null && normalized.gestures.length === pack.gestures.length;
})());
check('★ 没有 version 也不是 v2 形状（v1 的包）→ 仍然拒绝', (() => {
  const v1Shaped = {
    model: 'x',
    generatedAt: 0,
    strength: 0.75,
    gestures: [{ id: 'head-tilt', label: '歪头', params: { ParamAngleZ: 0.12 }, attackMs: 260, holdMs: 900, releaseMs: 700, modes: ['idle'] }],
  };
  return client.normalizeMicroMotionPack(v1Shaped) === null;
})());
check('渲染端也丢嘴参数', (() => {
  const dirty = client.normalizeMicroMotionPack({
    ...pack,
    gestures: [{
      id: 'x',
      label: 'x',
      parts: [{ delayMs: 0, params: { ParamAngleZ: 1, ParamMouthForm: 1 } }],
      attackMs: 300,
      holdMs: 300,
      releaseMs: 300,
      modes: ['idle'],
      tags: [],
      weight: 1,
    }],
  });
  return dirty?.gestures[0].parts[0].params.ParamMouthForm === undefined;
})());
check('渲染端不认 v1 的包（宁可不演，也不按半幅演）', client.normalizeMicroMotionPack({ ...pack, version: 1 }) === null);
check('渲染端也按段数上限与延迟上限收（防止旧包/脏包）', (() => {
  const many = client.normalizeMicroMotionPack({
    ...pack,
    gestures: [{
      id: 'many',
      parts: Array.from({ length: 6 }, (_, index) => ({ delayMs: index * 300, params: { ParamAngleZ: 1 } })),
      attackMs: 300,
      holdMs: 300,
      releaseMs: 300,
    }],
  });
  const parts = many?.gestures[0].parts ?? [];
  return parts.length === 4 && parts.every((part) => part.delayMs <= 600);
})());

const rng = seeded(7);
const first = client.microMotionValues(state, {
  deltaMs: 16,
  pack: clientPack,
  mode: 'idle',
  emotions: [],
  allowGaze: true,
  factor: 1,
  random: rng,
});
check('第一次推进只排期、不动手（模型刚出现时不该抽一下）', first.started === '' && Object.keys(first.values).length === 0 && state.nextAtMs > 0);

let started = '';
let sawValues = false;
let doneId = '';
for (let index = 0; index < 4000 && doneId === ''; index += 1) {
  const frame = client.microMotionValues(state, {
    deltaMs: 50,
    pack: clientPack,
    mode: 'idle',
    emotions: ['好奇'],
    allowGaze: true,
    factor: 1,
    random: rng,
  });
  if (frame.started !== '') started = frame.started;
  if (Object.keys(frame.values).length > 0) sawValues = true;
  if (frame.done !== '') doneId = frame.done;
}
check('过一段时间会挑一条并真的动参数', started !== '' && sawValues, `started=${started}`);
check('一条演完会报 done 并清空', doneId !== '' && state.gesture === null, `done=${doneId}`);
check('演完会重新排下一次', state.nextAtMs > state.clockMs);
check('参数值都是小数（不带 NaN）', (() => {
  const after = client.microMotionValues(state, { deltaMs: 16, pack: clientPack, mode: 'idle', emotions: [], allowGaze: true, factor: 1, random: rng });
  return Object.values(after.values).every((value) => Number.isFinite(value));
})());

const busyState = client.createMicroMotionState();
for (let index = 0; index < 4000 && busyState.gesture === null; index += 1) {
  client.microMotionValues(busyState, { deltaMs: 50, pack: clientPack, mode: 'idle', emotions: [], allowGaze: true, factor: 1, random: rng });
}
const beforePaused = busyState.gesture === null ? '' : busyState.gesture.id;
const paused = client.microMotionValues(busyState, { deltaMs: 50, pack: clientPack, mode: 'idle', emotions: [], allowGaze: true, factor: 1, paused: true, random: rng });
check('忙碌时立刻撤掉正在演的那条', busyState.gesture === null && Object.keys(paused.values).length === 0, `was=${beforePaused}`);
check('忙碌时把下一次推后（不会一松就抽）', busyState.nextAtMs >= busyState.clockMs + 3000 - 50);

const talkState = client.createMicroMotionState();
let talkStarted = '';
for (let index = 0; index < 4000 && talkStarted === ''; index += 1) {
  const frame = client.microMotionValues(talkState, { deltaMs: 50, pack: clientPack, mode: 'talk', emotions: [], allowGaze: true, factor: 1, random: rng });
  if (frame.started !== '') talkStarted = frame.started;
}
const talkGesture = clientPack.gestures.find((item) => item.id === talkStarted);
check('说话档挑的是说话向的动作', talkGesture !== undefined && talkGesture.modes.includes('talk'), talkStarted);
check('总时长算法与 Host 一致', client.microMotionTotalMs(clientPack.gestures[0]) === microMotionTotalMs(clientPack.gestures[0]));
check('没有包时清空状态', (() => {
  const none = client.createMicroMotionState();
  const frame = client.microMotionValues(none, { deltaMs: 16, pack: null, mode: 'idle', emotions: [], allowGaze: true, factor: 1, random: rng });
  return Object.keys(frame.values).length === 0 && none.gesture === null;
})());

/*
 * §13.30「试演」的纯函数那一半：起演一条。
 *
 * 这里能断言的是**状态迁移**，不是画面 —— 「演得对不对」属于包络，`[7]` 已经用
 * `microMotionValues` 钉住了；这一段只回答「点了『试演』之后状态变成什么样」。
 */
console.log('[7b] startMicroMotion：点名起演');
{
  const fixture = client.normalizeMicroMotionPack(JSON.parse(JSON.stringify(pack)));
  const state = client.createMicroMotionState();
  state.clockMs = 5000;

  const started = client.startMicroMotion(state, fixture, 'head-tilt');
  check('起演成功：返回那一条、状态指向它、计数 +1',
    started !== null && started.id === 'head-tilt' && state.gesture !== null && state.gesture.id === 'head-tilt'
      && state.count === 1 && state.elapsedMs === 0, JSON.stringify({ gesture: state.gesture?.id, count: state.count }));

  check('★ 不改 nextAtMs（演完的排期交给播放器的 done 分支）', state.nextAtMs === 0, String(state.nextAtMs));

  check('不认识的 id 返回 null，状态不动', (() => {
    const before = state.gesture?.id ?? '';
    const missed = client.startMicroMotion(state, fixture, 'no-such-gesture');
    return missed === null && (state.gesture?.id ?? '') === before && state.count === 1;
  })());

  check('关掉的那条也能点名起演（开关只管自动播放）', (() => {
    const quiet = client.normalizeMicroMotionPack(JSON.parse(JSON.stringify(pack)));
    for (const item of quiet.gestures) item.enabled = false;
    const s = client.createMicroMotionState();
    const hit = client.startMicroMotion(s, quiet, 'nod');
    return hit !== null && hit.id === 'nod' && s.gesture !== null;
  })());

  check('空 id / 没有包都返回 null', client.startMicroMotion(client.createMicroMotionState(), fixture, '') === null
    && client.startMicroMotion(client.createMicroMotionState(), null, 'nod') === null);
}

/*
 * §13.32：多段错峰。
 *
 * 这一条只证「时间轴对不对」：主段先动 → 两段重叠 → 主段收完跟随段还在。
 * 真机上「自然不自然」不在这里断言 —— 那是幅度与段数的取舍，门禁能钉的只是
 * 「不是所有部位同一毫秒启动」。
 */
console.log('[7c] 多段错峰：同一次动作里后到的部位');
{
  const fixture = client.normalizeMicroMotionPack({
    version: 2,
    model: 'x',
    name: 'x',
    generatedAt: 0,
    strength: 1,
    roles: [],
    missing: [],
    gestures: [{
      id: 'two-part',
      label: '两段',
      parts: [
        { delayMs: 0, params: { ParamAngleZ: 10 } },
        { delayMs: 400, params: { ParamEyeBallX: 0.5 } },
      ],
      attackMs: 200,
      holdMs: 200,
      releaseMs: 200,
      gaze: false,
      tags: [],
      modes: ['idle'],
      weight: 1,
      enabled: true,
    }],
  });
  const state = client.createMicroMotionState();
  client.startMicroMotion(state, fixture, 'two-part');
  let sawAngleOnly = false;
  let sawBoth = false;
  let sawEyeOnly = false;
  let doneId = '';
  for (let index = 0; index < 40 && doneId === ''; index += 1) {
    const frame = client.microMotionValues(state, {
      deltaMs: 50, pack: fixture, mode: 'idle', emotions: [], allowGaze: true, factor: 1, random: () => 0,
    });
    const keys = Object.keys(frame.values);
    const hasAngle = keys.includes('ParamAngleZ');
    const hasEye = keys.includes('ParamEyeBallX');
    if (hasAngle && !hasEye) sawAngleOnly = true;
    if (hasAngle && hasEye) sawBoth = true;
    if (!hasAngle && hasEye) sawEyeOnly = true;
    if (frame.done !== '') doneId = frame.done;
  }
  check('主段先动、跟随段还没到（前 200 ms 只有主段）', sawAngleOnly);
  check('两段重叠时同时写两根参数（不是二选一）', sawBoth);
  check('主段收完、跟随段还在（尾巴对得上）', sawEyeOnly);
  check('总时长 = 最后一段延迟 + 包络（400+600=1000）', client.microMotionTotalMs(fixture.gestures[0]) === 1000, String(client.microMotionTotalMs(fixture.gestures[0])));
  check('到总时长才报 done', doneId === 'two-part' && state.gesture === null, `done=${doneId}`);
}

console.log('[8] 接线对账（源码）');
const indexSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/index.js'), 'utf8'));
const hostSource = stripComments(readFileSync(HOST_MODULE, 'utf8'));
const petSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/pet-model.ts'), 'utf8'));
const pluginSource = stripComments(readFileSync(resolve(PACKAGE, 'src/client/plugin.ts'), 'utf8'));
const buildSource = stripComments(readFileSync(resolve(PACKAGE, 'build.mjs'), 'utf8'));

check('Host 在清单上报之后生成包', (() => {
  const reportAt = indexSource.indexOf('state.activeModelId = id');
  const ensureAt = indexSource.indexOf('ensureMicroMotions(id, { capabilities: normalised })');
  return reportAt >= 0 && ensureAt > reportAt;
})());
check('Host 有 GET/POST /micro-motions 与 /micro-motions/generate 三条路', indexSource.includes("rest === '/micro-motions'") && indexSource.includes("rest === '/micro-motions/generate'"));
check('Host 面板补丁同时收 enabled 表与 gestures 数组', indexSource.includes('payload?.enabled') && indexSource.includes('payload?.gestures'));
check('Host 包落盘在 micro-motions 目录', indexSource.includes("'micro-motions'"));
check('live2d_status 的 schema 申报了 microMotion（additionalProperties:false）', /microMotion:\s*\{\s*\n\s*type: 'object'/.test(indexSource));
check('★ Host 的微动作视图经由 buildMicroMotionView 产出（视图带 version，渲染端严格校验它）', /version:\s*pack\?\.version\s*\?\?\s*0/.test(hostSource) && indexSource.includes('buildMicroMotionView(pack, {'));
check('★ 渲染端「Host 说 ok 但自己不认」时报错，而不是安静地退回', pluginSource.includes('E_MICRO_BAD_PACK') && /model\.microMotionPack === null/.test(pluginSource));
check('live2d_status 的 detail 里带一句微动作', indexSource.includes('microText') && indexSource.includes('微动作：这个模型生成不出'));

check('渲染端接上了 setMicroMotionPack / setTalking', petSource.includes('public setMicroMotionPack(') && petSource.includes('public setTalking('));
check('_applyGarnish 在有包时改走微动作层', /_applyGarnish\(delta: number\): void \{[\s\S]{0,400}if \(this\._microPack !== null\)/.test(petSource));
check('忙碌时把 paused 传给排期（不是自己另写一套闸门）', petSource.includes('paused: isBusyWithRealMotion(this.currentMotionPriority())'));
check('视线被 look_at 拽着时同样让路', petSource.includes('allowGaze: this._lookAllowsGaze()'));
check('情绪名传给了挑选器', petSource.includes('emotions: this._emotions.active.map((layer) => layer.name)'));
check('换模型时只清播放器、不清包', petSource.includes('this._microState = createMicroMotionState();'));

check('插件在清单上报**落地之后**才取包（否则必然抢跑成 NO_CAPABILITIES）', (() => {
  const reportAt = pluginSource.indexOf('const reported = reportCapabilities(model, modelPath);');
  const syncAt = pluginSource.indexOf('return syncMicroMotions(model);', reportAt);
  return reportAt >= 0 && syncAt > reportAt;
})());
check('说话态每帧灌给模型', pluginSource.includes('model.setTalking(speech.state.speaking === true);'));
check('取包失败退回首写七条（不是抛）', pluginSource.includes('model.setMicroMotionPack(null);') && pluginSource.includes("reportFailure('micro-motions', err);"));
check('面板有「微动作」一节且被渲染', pluginSource.includes('function MicroMotionSection()') && pluginSource.includes('h(MicroMotionSection, {})'));
check('面板能改的只有强度与开关', pluginSource.includes('saveMicroMotions') && pluginSource.includes("`${ROUTE_PREFIX}/micro-motions/generate`"));
check('面板显示每条动作的段数与部位（不再列一长串参数）', pluginSource.includes('function describeMicroMotionParts(') && pluginSource.includes('describeMicroMotionParts(item)'));
check('面板的视图类型也跟上了 v2（parts 而不是 params）', pluginSource.includes('interface MicroMotionPartView') && /parts:\s*MicroMotionPartView\[\]/.test(pluginSource));

/*
 * 「等一会儿」与「永远不行」必须分开。
 *
 * 这一条是被真机打回来的：页面刷新后这一节比模型加载先跑，Host 那时还没有清单
 * （挂载时还会主动清空一次），第一把必然是 `E_MICRO_NO_CAPABILITIES` —— 第一版把它
 * 当终态写成「微动作不可用」，于是一个纯粹的时间差被说成了一个错误，而且不会自愈。
 */
check('Host 把「还没清单」标成可重试', indexSource.includes("code: 'E_MICRO_NO_CAPABILITIES'")
  && /code: 'E_MICRO_NO_CAPABILITIES'[\s\S]{0,200}retryable: true/.test(indexSource));
check('Host 把「认不出角色」标成不可重试', /code: 'E_MICRO_NO_GESTURES'[\s\S]{0,300}retryable: false/.test(indexSource));
check('面板按 retryable 自动重试、并给出上限', pluginSource.includes('MICRO_MOTION_RETRY_LIMIT')
  && pluginSource.includes('!error.retryable')
  && pluginSource.includes('setAttempt((value) => value + 1)'));
check('重试耗尽之后仍有手动「重试」', pluginSource.includes("'重试',") && pluginSource.includes('setAttempt(0);'));
check('错误类型不被普通 Error 包掉（否则 retryable 会丢）',
  pluginSource.includes('if (!res.ok) throw await readMicroMotionError(res);')
  && !pluginSource.includes('new Error(await readMicroMotionError(res))'));

check('build.mjs 有渲染端纯逻辑产物', buildSource.includes("src/client/micro-motion.ts") && buildSource.includes('build(microMotionOptions)'));

/* ── §13.30「试演」：一条路，两个入口 ───────────────────────────────── */

const actionsSource = stripComments(readFileSync(resolve(PACKAGE, 'lib/host/actions.js'), 'utf8'));
check('指令类型表收了 microMotion', indexSource.includes("'microMotion'") && actionsSource.includes("'microMotion'"));
check('buildAction 的 microMotion 分支不需要能力清单（在校验清单之前返回）', (() => {
  const branch = actionsSource.indexOf("if (kind === 'microMotion')");
  const caps = actionsSource.indexOf('if (capabilities === null || capabilities === undefined)');
  return branch >= 0 && caps > branch;
})());
check('Host 有「点名演一条」的公共函数（路由与工具共用）', indexSource.includes('function playMicroMotionById('));
check('Host 有 POST /micro-motions/play', indexSource.includes("rest === '/micro-motions/play'") && indexSource.includes('playMicroMotionById(payload?.id)'));
check('AI 工具 live2d_micro_motion 已注册且不给 id 时只列清单', indexSource.includes("name: 'live2d_micro_motion'") && indexSource.includes('这个模型有 ${lines.length} 条微动作'));
check('演员不认识 id 时把现有 id 一起回出去（可自愈）', indexSource.includes('E_MICRO_UNKNOWN_GESTURE') && indexSource.includes('available: view.gestures.map'));
check('★ 执行层把 microMotion 当作认识的 kind', (() => {
  const runner = stripComments(readFileSync(resolve(PACKAGE, 'src/client/action-runner.ts'), 'utf8'));
  return runner.includes("case 'microMotion':") && /HANDLED_KINDS[\s\S]{0,200}'microMotion'/.test(runner);
})());
check('渲染端 PetModel 有 playMicroMotion', petSource.includes('public playMicroMotion(id: string)'));
check('微动作播放器有 startMicroMotion（状态只在这一处改）', client.startMicroMotion !== undefined);
check('★ 试演不看 enabled（关掉的是自动播放，不是这一下）', (() => {
  const start = stripComments(readFileSync(resolve(PACKAGE, 'src/client/micro-motion.ts'), 'utf8'));
  const fn = start.indexOf('export function startMicroMotion(');
  if (fn < 0) return false;
  const body = start.slice(fn, fn + 1200);
  return !body.includes('enabled');
})());
check('面板每条都有「试演」按钮，并走 Host 那条路', pluginSource.includes("'试演',") && pluginSource.includes("`${ROUTE_PREFIX}/micro-motions/play`"));
check('旧的渲染端（没有 playMicroMotion）报 E_ACTION_UNSUPPORTED 而不是假成功', (() => {
  const runner = stripComments(readFileSync(resolve(PACKAGE, 'src/client/action-runner.ts'), 'utf8'));
  return runner.includes("typeof target.playMicroMotion !== 'function'") && runner.includes('E_ACTION_UNSUPPORTED');
})());

/* ── §13.34 缺部位借力 + 参数实测 ───────────────────────────────────── */

console.log('[9] 缺部位借力与参数实测');

const reimuCaps = hiyoriCapabilities();
reimuCaps.parameters = reimuCaps.parameters.filter(
  (item) => item.id !== 'ParamShoulder' && item.id !== 'ParamHairAhoge',
);
const borrowed = buildMicroMotionPack({ capabilities: reimuCaps, model: 'reimu', name: '灵梦' });
check('缺肩与呆毛时记进 substitutions（不是安静地少几根参数）',
  borrowed.substitutions.some((item) => item.from === 'shoulder')
  && borrowed.substitutions.some((item) => item.from === 'hairAhoge'),
  JSON.stringify(borrowed.substitutions.map((item) => item.from)));
check('替代表：肩 → 身体侧倾，呆毛 → 头侧倾',
  host.MICRO_MOTION_ROLE_SUBSTITUTES.shoulder.some((item) => item.role === 'bodyAngleZ')
  && host.MICRO_MOTION_ROLE_SUBSTITUTES.hairAhoge.some((item) => item.role === 'angleZ'));
const borrowedKeys = [];
for (const gesture of borrowed.gestures) for (const part of gesture.parts) borrowedKeys.push(...Object.keys(part.params));
check('借来的量真的写进了动作（身体/头在动，不是只留在报告里）',
  borrowedKeys.includes('ParamBodyAngleZ') || borrowedKeys.includes('ParamAngleZ'));

const withDead = buildMicroMotionPack({
  capabilities: hiyoriCapabilities(),
  model: 'deadpen',
  deadParameters: ['ParamBrowLY', 'ParamBrowRY'],
});
check('实测判定「写了不动」的部位被记进 dead',
  withDead.dead.some((item) => item.role === 'browLY') && withDead.dead.some((item) => item.role === 'browRY'),
  JSON.stringify(withDead.dead.map((item) => item.role)));
const deadKeys = [];
for (const gesture of withDead.gestures) for (const part of gesture.parts) deadKeys.push(...Object.keys(part.params));
check('死参数不再出现在任何一段里（写了不动的值不该混进时间轴）',
  !deadKeys.includes('ParamBrowLY') && !deadKeys.includes('ParamBrowRY'));
check('死掉的部位也走借力，不是整条动作作废',
  withDead.substitutions.some((item) => item.from === 'browLY'));

const normalizedBorrowed = normalizeMicroMotionPack(JSON.parse(JSON.stringify({ ...borrowed, probeAt: 1234 })));
check('归一化留下 substitutions / dead / probeAt',
  Array.isArray(normalizedBorrowed.substitutions) && normalizedBorrowed.probeAt === 1234,
  String(normalizedBorrowed?.probeAt));
const borrowedView = buildMicroMotionView(borrowed, { source: 'disk' });
check('视图里也带 substitutions / dead / probeAt（面板要能说清借了哪几处）',
  Array.isArray(borrowedView.substitutions) && Array.isArray(borrowedView.dead) && 'probeAt' in borrowedView);

check('Host 有 deadParametersFor（只认当前模型那一次实测）', indexSource.includes('function deadParametersFor('));
check('Host 存了一次实测的结果与时间', /bindingProbe:\s*\{[\s\S]{0,80}at:/.test(indexSource));
check('Host 有了新实测就重算包（与磁盘包的 probeAt 比）',
  indexSource.includes('probeAt > (Number(cached.pack.probeAt) || 0)'));
check('Host 把死参数交给生成器', indexSource.includes('deadParameters: deadParametersFor(id)'));
check('Host 有 POST /binding-probe', indexSource.includes("rest === '/binding-probe'")
  && indexSource.includes('state.bindingProbe = {'));

check('渲染端有实测状态机与候选表', pluginSource.includes('function stepBindingProbe(')
  && pluginSource.includes('function bindingProbeTargets('));
check('扫极值用参数覆盖、扫完撤掉', pluginSource.includes('model.setParameterOverride({ [target.id]: target.high })')
  && pluginSource.includes('model.clearParameterOverrides();'));
check('★ 判定用 A-B-A（高 → 低 → 再高）：背景一直在动，单次差分证明不了绑定',
  pluginSource.includes('BINDING_PROBE_MIN_CHANGED') && pluginSource.includes('BINDING_PROBE_NOISE_FLOOR')
  && pluginSource.includes("job.step = 'high2'") && pluginSource.includes("job.step = 'sample-high2'")
  && /changedFraction\(job\.high,\s*pixels\)/.test(pluginSource));
check('探测期间把微动作层也摘掉（A-B-A 的前提是只有我在动）',
  /setMicroMotionPack\(null\);[\s\S]{0,80}model\.stopMotion\(\)/.test(pluginSource));
check('读的是画布像素（不是截屏 —— 那台机器上截屏不可用）',
  pluginSource.includes('function sampleBindingPixels(') && pluginSource.includes('getImageData('));
check('探测期间关漂移、测完打开', pluginSource.includes('model.setAmbientDrift(false);')
  && pluginSource.includes('model.setAmbientDrift(true);'));
check('实测结果回传 Host', pluginSource.includes("`${ROUTE_PREFIX}/binding-probe`"));
check('回传之后重新取包（否则这一轮模型上借力要等下次换模型才生效）',
  /reportBindingProbe\(job\)[\s\S]{0,80}then\(\(\) => syncMicroMotions\(model\)\)/.test(pluginSource));
check('帧循环在 draw() 之后调它（早一步就读到透明）', (() => {
  const drawAt = pluginSource.indexOf('model.draw(w, hgt);');
  const probeAt = pluginSource.indexOf('stepBindingProbe(host, model, canvas);');
  return drawAt >= 0 && probeAt > drawAt;
})());
check('RenderHost 上有实测任务那三格',
  /bindProbe:\s*BindingProbeJob \| null/.test(pluginSource) && pluginSource.includes('bindDoneFor: string | null'));
/*
 * §13.37：抽搐本身必须发生（A-B-A 靠像素），但不该被看见 —— 探测期间
 * 把画布藏起来、用一行说明替代。这条链两头都容易写漏：忘了打标记 = 用户看见抽搐；
 * 忘了摘标记 = 模型永远不出现。
 */
check('探测期间给舞台打 data-probing 标记（藏画面）',
  pluginSource.includes("stage.setAttribute('data-probing', probing)")
  && pluginSource.includes("host.bindProbe === null ? '0' : '1'"));
check('CSS 按标记藏掉画布并给出说明',
  /\.dsh-l2d-stage\[data-probing="1"\] > \.dsh-l2d-canvas \{ visibility: hidden; \}/.test(pluginSource)
  && pluginSource.includes('正在校准关节'));
check('藏的是合成、不是采样（仍从画布取像素）',
  pluginSource.includes('visibility: hidden') && pluginSource.includes('ctx.drawImage(canvas,'));
/*
 * §13.37 后半：已经量过的清单不要反复量。判据是「模型 + 清单指纹」都对上，
 * 只比模型名会让「同一只模型的另一个版本」拿着旧结论跑。
 */
check('Host 记下实测是照着哪份清单量的', /digest:\s*typeof state\.capabilitiesDigest === 'string'/.test(indexSource));
check('Host 回 probeFresh（模型与指纹都对上才算新鲜）',
  indexSource.includes('const probeFresh = state.bindingProbe !== null')
  && indexSource.includes('state.bindingProbe.digest === digest')
  && indexSource.includes('summary, probeFresh }'));
check('渲染端读 probeFresh 并据此跳过实测',
  pluginSource.includes('body.probeFresh === true') && pluginSource.includes('if (probeFresh) host.bindDoneFor = modelPath;'));
check('读不到 probeFresh 时按「没量过」处理（宁可多测一次）',
  pluginSource.includes('body !== null && body.probeFresh === true'));

const gateSource = stripComments(readFileSync(resolve(ROOT, 'tools/verify-all.mjs'), 'utf8'));
check('门禁登记在 verify-all 里', gateSource.includes('test-micro-motions.mjs'));

console.log('');
if (failed === 0) {
  console.log(`[8] MICRO MOTION GATE PASSED  ${passed} 通过 / 0 失败`);
  process.exit(0);
}
console.log(`[8] MICRO MOTION GATE FAILED  ${passed} 通过 / ${failed} 失败`);
process.exit(1);
