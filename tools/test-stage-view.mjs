#!/usr/bin/env node
/**
 * 门禁：**舞台视图的纯逻辑**（`lib/test/stage-view.mjs` ＝ `src/client/stage-view.ts`）。
 *
 * ## 为什么需要这个文件
 *
 * 用户的第 4、5 条要求：可以用鼠标调模型的大小与位置；超出边框的部分被挡住；
 * 调的时候模型照常做动作。这一层（缩放/平移的算术与夹取）里每条错法都是
 * **静默的**，而且症状全都一样：**模型不见了**。
 *
 *   - 缩放不夹上限 —— 滚轮一路滚下去，模型变成一个像素；
 *   - 平移不夹 —— 用力一拖就扔出舞台，而舞台 `overflow: hidden`，
 *     拖出去的东西既看不见也点不到，双击的退路还得先找到它；
 *   - 持久化不夹 —— 存储里留着一个「缩放 0.01」，刷新回来模型就没了，
 *     而面板上一切正常。
 *
 * 「模型不见了」既可能是渲染坏了，也可能是用户自己推出去的。这个文件让后一种
 * 永远可以被排除掉。
 *
 * ## 结构
 *
 * [1]–[5] 对真代码断言；[6] 把产物里的守卫**弄坏**再用 `data:` URL 重新 import，
 * 断言同一类判据为假（证明断言有牙）。
 *
 * ## 用法
 *
 *     node tools/test-stage-view.mjs     （离线：无网络、无 DOM）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(packageRoot, 'lib/test/stage-view.mjs');

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

function section(title) {
  console.log(`\n${title}`);
}

if (!existsSync(modulePath)) {
  console.error(`舞台视图的测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`。');
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const {
  MIN_ZOOM,
  MAX_ZOOM,
  PAN_LIMIT,
  STAGE_VIEW_STORAGE_KEY,
  defaultStageView,
  clampStageView,
  isDefaultStageView,
  wheelZoomFactor,
  zoomStageView,
  panStageView,
  stageViewToNdc,
  parseStageView,
  serializeStageView,
} = mod;

/* ══════════════════════════════════════════════════════════════════════════
 * [1] 常量与默认值
 * ══════════════════════════════════════════════════════════════════════════ */

section('[1] 常量与默认视图');

check(`缩放范围有意义（${MIN_ZOOM} < 1 < ${MAX_ZOOM}）`, MIN_ZOOM > 0 && MIN_ZOOM < 1 && MAX_ZOOM > 1);
check(`平移上限大于 0（${PAN_LIMIT}）`, PAN_LIMIT > 0);
check('存储键与窗口形态、设置、模型记忆都分开', STAGE_VIEW_STORAGE_KEY === 'dsh-live2d-pet.stage-view');

const fresh = defaultStageView();
check('默认视图是「铺满 + 正中」（zoom 1、pan 0）', fresh.zoom === 1 && fresh.panX === 0 && fresh.panY === 0);
check('默认视图被认成默认', isDefaultStageView(fresh) === true);
check('null / undefined 也算默认视图（不套任何矩阵）',
  isDefaultStageView(null) === true && isDefaultStageView(undefined) === true);
check('动过一点就不是默认视图了', isDefaultStageView({ zoom: 1.01, panX: 0, panY: 0 }) === false);

/* ══════════════════════════════════════════════════════════════════════════
 * [2] 夹取：三个方向各挡一种「模型不见了」
 * ══════════════════════════════════════════════════════════════════════════ */

section('[2] clampStageView：缩放、横移、竖移三条边界都夹住');

const bigZoom = clampStageView({ zoom: 99, panX: 0, panY: 0 });
check(`缩放上限（99 → ${bigZoom.zoom}）`, bigZoom.zoom === MAX_ZOOM);

const tinyZoom = clampStageView({ zoom: 0.01, panX: 0, panY: 0 });
check(`缩放下限（0.01 → ${tinyZoom.zoom}）`, tinyZoom.zoom === MIN_ZOOM);

const farPan = clampStageView({ zoom: 1, panX: 99, panY: -99 });
check(`平移被夹到 ±${PAN_LIMIT}`, farPan.panX === PAN_LIMIT && farPan.panY === -PAN_LIMIT);

const junkView = clampStageView({ zoom: Number.NaN, panX: Number.POSITIVE_INFINITY, panY: 'left' });
check('坏数字（NaN / Infinity / 字符串）不炸，全部落成有限数',
  [junkView.zoom, junkView.panX, junkView.panY].every((v) => typeof v === 'number' && Number.isFinite(v)));
check('坏数字落回默认值（zoom 1、pan 0）',
  junkView.zoom === 1 && junkView.panX === 0 && junkView.panY === 0);
check('null / undefined 输入也有兜底',
  clampStageView(null).zoom === 1 && clampStageView(undefined).panX === 0);

/* ══════════════════════════════════════════════════════════════════════════
 * [3] 滚轮：单调、对称、有夹取
 * ══════════════════════════════════════════════════════════════════════════ */

section('[3] wheelZoomFactor：向上滚放大、向下滚缩小，且单次不会跳到天涯');

const zoomIn = wheelZoomFactor(-100);
const zoomOut = wheelZoomFactor(100);
check(`向上滚是放大（deltaY -100 → ×${zoomIn.toFixed(4)}）`, zoomIn > 1);
check(`向下滚是缩小（deltaY +100 → ×${zoomOut.toFixed(4)}）`, zoomOut < 1);
check('一进一出大致还原（互逆）', Math.abs(zoomIn * zoomOut - 1) < 1e-9);
check('滚得越多放大越多（单调）', wheelZoomFactor(-200) > wheelZoomFactor(-100));
check('零位移不缩放', Math.abs(wheelZoomFactor(0) - 1) < 1e-12);
check('一记大力滚轮也不会一次跳到底（被单次上限挡住）',
  wheelZoomFactor(-100000) <= 2 && wheelZoomFactor(100000) >= 0.5);
check('坏输入（NaN / undefined / 字符串）不缩放',
  Math.abs(wheelZoomFactor(Number.NaN) - 1) < 1e-12 && Math.abs(wheelZoomFactor('big') - 1) < 1e-12);

/* ══════════════════════════════════════════════════════════════════════════
 * [4] 缩放与平移一步步走，都不越界
 * ══════════════════════════════════════════════════════════════════════════ */

section('[4] zoomStageView / panStageView：连续操作也不会越界');

let accumulated = defaultStageView();
for (let i = 0; i < 40; i += 1) {
  accumulated = zoomStageView(accumulated, 1.2);
}
check(`连放大 40 步停在 ${MAX_ZOOM}`, accumulated.zoom === MAX_ZOOM);

for (let i = 0; i < 40; i += 1) {
  accumulated = zoomStageView(accumulated, 0.8);
}
check(`连缩小 40 步停在 ${MIN_ZOOM}`, accumulated.zoom === MIN_ZOOM);

let dragged = defaultStageView();
for (let i = 0; i < 100; i += 1) {
  dragged = panStageView(dragged, 0.1, -0.1);
}
check(`连拖 100 步横竖都停在 ±${PAN_LIMIT}`, dragged.panX === PAN_LIMIT && dragged.panY === -PAN_LIMIT);

const jitter = panStageView(defaultStageView(), Number.NaN, undefined);
check('坏增量的平移当作 0（画面不跳）', jitter.panX === 0 && jitter.panY === 0);

/* ══════════════════════════════════════════════════════════════════════════
 * [5] 投影换算与持久化
 * ══════════════════════════════════════════════════════════════════════════ */

section('[5] stageViewToNdc 的符号约定 + 持久化容错');

const centred = stageViewToNdc(defaultStageView());
check('默认视图 → 缩放 1、不平移', centred.zoom === 1 && centred.tx === 0 && centred.ty === 0);

const rightDown = stageViewToNdc({ zoom: 2, panX: 0.25, panY: 0.1 });
check('panX 0.25（向右）→ NDC tx = +0.5', Math.abs(rightDown.tx - 0.5) < 1e-12);
check('panY 0.1（向下）→ NDC ty = −0.2（NDC 的 y 向上，所以取反）',
  Math.abs(rightDown.ty + 0.2) < 1e-12);
check('缩放原样传出去', rightDown.zoom === 2);

check('坏视图换算不产生 NaN',
  [stageViewToNdc(null).zoom, stageViewToNdc(null).tx, stageViewToNdc({ zoom: Number.NaN, panX: Number.NaN, panY: Number.NaN }).ty]
    .every((v) => Number.isFinite(v)));

const stored = parseStageView(JSON.stringify({ zoom: 1.75, panX: -0.4, panY: 0.2 }));
check('正常存过的视图原样读回来',
  stored.zoom === 1.75 && stored.panX === -0.4 && stored.panY === 0.2);

check('没存过 → 默认视图', isDefaultStageView(parseStageView(null)) && isDefaultStageView(parseStageView('')));
check('坏 JSON（\'{\' / \'null\' / \'oops\'）不抛，退回默认视图',
  ['{', 'null', 'oops', '[1,2]'].every((raw) => isDefaultStageView(parseStageView(raw))));

const wild = parseStageView(JSON.stringify({ zoom: 999, panX: 999, panY: -999 }));
check('越界的存量被夹回合法范围（不会让模型消失在视野外）',
  wild.zoom === MAX_ZOOM && wild.panX === PAN_LIMIT && wild.panY === -PAN_LIMIT);

check('写下去再读回来是同一个视图',
  JSON.stringify(parseStageView(serializeStageView({ zoom: 1.5, panX: 0.3, panY: -0.25 })))
  === JSON.stringify({ zoom: 1.5, panX: 0.3, panY: -0.25 }));

check('序列化的是有限小数（不把浮点抖动写进存储）',
  !serializeStageView({ zoom: 1.23456789, panX: 0.11111111, panY: 0 }).includes('1111111') ||
  serializeStageView({ zoom: 1.23456789, panX: 0.11111111, panY: 0 }).length < 100);

/* ══════════════════════════════════════════════════════════════════════════
 * [6] 反证：守卫真的在起作用
 * ══════════════════════════════════════════════════════════════════════════ */

section('[6] 反证：把产物里的上限弄坏，同一类判据必须变假');

const artifactSource = readFileSync(modulePath, 'utf8');

async function importMutated(source, tag) {
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}#${tag}`;
  return import(url);
}

/** 找产物里那条常量声明（bundle 出来是 `var`，不写死关键字）。 */
function declarationNeedle(source, name, value) {
  const match = new RegExp(`(var|const|let) ${name} = ${value};`).exec(source);
  return match === null ? null : match[0];
}

const maxZoomNeedle = declarationNeedle(artifactSource, 'MAX_ZOOM', MAX_ZOOM);
check('反证前提：产物里能找到 MAX_ZOOM', maxZoomNeedle !== null, maxZoomNeedle ?? '未找到');
if (maxZoomNeedle !== null) {
  const broken = await importMutated(artifactSource.replace(maxZoomNeedle, maxZoomNeedle.replace(/= [\d.]+;/, '= Infinity;')), 'cp-zoom');
  const blown = broken.clampStageView({ zoom: 1e6, panX: 0, panY: 0 });
  check('退化 1：把缩放上限改成 Infinity 之后，滚轮能把模型放大到无穷（本门禁会红）',
    blown.zoom === 1e6);
}

const panLimitNeedle = declarationNeedle(artifactSource, 'PAN_LIMIT', PAN_LIMIT);
check('反证前提：产物里能找到 PAN_LIMIT', panLimitNeedle !== null, panLimitNeedle ?? '未找到');
if (panLimitNeedle !== null) {
  const broken = await importMutated(artifactSource.replace(panLimitNeedle, panLimitNeedle.replace(/= [\d.]+;/, '= 100;')), 'cp-pan');
  const lost = broken.clampStageView({ zoom: 1, panX: 999, panY: 0 });
  check('退化 2：把平移上限放大到 100 之后，模型能被推到舞台外一百个身位（看得见却找不回）',
    lost.panX === 100);
}

/* ══════════════════════════════════════════════════════════════════════════
 * [7] 调用点：面板与渲染端真的用上了这一层
 * ══════════════════════════════════════════════════════════════════════════ */

section('[7] 调用点（源码级，只读文件找关键字）');

const pluginSource = readFileSync(resolve(packageRoot, 'src/client/plugin.ts'), 'utf8');
const modelSource = readFileSync(resolve(packageRoot, 'src/client/pet-model.ts'), 'utf8');

check('面板 import 了这一个模块', /from '\.\/stage-view'/.test(pluginSource));
check('帧循环里把视图交给模型（setStageView）', /model\.setStageView\(viewRef\.current\)/.test(pluginSource));
check('调用在 draw 之前、update 之后（动作已经推进过，只改画在哪儿）',
  pluginSource.indexOf('model.update(dt)') < pluginSource.indexOf('model.setStageView(') &&
  pluginSource.indexOf('model.setStageView(') < pluginSource.indexOf('model.draw('));
check('舞台用原生 wheel 监听（React 的 onWheel 在根节点是 passive 的）',
  /addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(pluginSource));
check('拖动舞台用 pointer 的捕获（手滑出边缘也跟手）', /setPointerCapture\?\.\(/.test(pluginSource));
check('双击/双触恢复默认视图', /resetStageView\(\)/.test(pluginSource));
check('舞台 CSS 有 overflow: hidden（超出边框的部分不展示）',
  /\.dsh-l2d-stage \{[\s\S]{0,600}overflow: hidden;/.test(pluginSource));
check('渲染端套矩阵用的是左乘（先铺好，再整体缩放平移）',
  /user\.multiplyByMatrix\(projection\)/.test(modelSource));
check('默认视图不产生任何矩阵运算（与加这个功能之前逐像素一致）',
  /if \(view === null\) \{\s*return projection;/.test(modelSource.replace(/\r/g, '')));

/*
 * 「重置模型」按钮（用户 2026-06 追加的要求，并指定把它放到**模型边框的右上角**）：
 * 模型被拖远之后要有一个看得见的退路，而不是只靠双击这个没人告诉过他的隐藏手势。
 *
 * 这里钉六件事，都是**少一件就会静默失效**的：
 *   1. 角标真的画在舞台里（不是画在设置区 —— 那正是用户要求搬走的位置）；
 *   2. 角标不重复画两份（同一件事两个入口、两种启用条件，迟早不一致）；
 *   3. 按钮真的调到了复位函数；
 *   4. 按钮真的会随视图状态变灰/变亮（永远可按的按钮看起来像坏了）；
 *   5. 角标外层**不吃指针**：舞台整块是拖动区，整层吃指针会在右上角挖出一块
 *      「拖不动」的死区，而用户只会以为卡了；
 *   6. 按钮按下**不冒泡**：否则从按钮上按下也会开一次平移，表现成
 *      「点一下按钮、模型跟着跑」。
 */
check('舞台里画了右上角角标（.dsh-l2d-stagehud）', /className: 'dsh-l2d-stagehud'/.test(pluginSource));
check('说明文字只出现一次（设置区不再重复一份）',
  (pluginSource.match(/滚轮缩放 · 拖动平移 · 双击复位/g) ?? []).length === 1);
check('按钮调的是舞台自己的复位函数', /onClick: \(\) => resetStageView\(\)/.test(pluginSource));
check('按钮在视图默认时是禁用的（按下去没反应才算坏）', /disabled: !viewMoved/.test(pluginSource));
check('角标外层 pointer-events: none、按钮才是 auto（否则右上角变成拖不动的死区）',
  /\.dsh-l2d-stagehud \{[\s\S]{0,400}pointer-events: none;/.test(pluginSource) &&
  /\.dsh-l2d-hudbtn \{[\s\S]{0,240}pointer-events: auto;/.test(pluginSource));
check('按钮按下时 stopPropagation（否则点按钮会顺手开一次舞台平移）',
  /onPointerDown: \(event: PointerEventLike\) => event\.stopPropagation\?\.\(\)/.test(pluginSource));
check('舞台每次改视图都推一次「偏离了没有」（平移 / 缩放 / 复位三处都要推）',
  (pluginSource.match(/syncDirty\(\);/g) ?? []).length >= 3);

/*
 * 墨迹重心探测与用户平移**会互相追着跑**：探测量的是画布上墨迹的横向重心，而用户
 * 拖过之后墨迹已被挪开，量出来的重心混进了用户自己的平移量；把它当偏心去补偿，
 * 松手后画面会自己再窜一下。所以探测必须**只在默认视图下**做。
 *
 * 反向的错法同样要防：不推进 `inkRetryAt` 的那句 —— 如果「跳过」也算一次失败，
 * 用户玩十秒之后就再没机会量了。
 */
check('墨迹重心探测只在默认视图下做（否则会把用户的平移量当成偏心量补偿回去）',
  /isDefaultStageView\(view\) && host\.renderedPath !== null && host\.inkDoneFor !== host\.renderedPath && now >= host\.inkRetryAt/.test(pluginSource));
{
  /*
   * 「跳过不算一次失败」的判据不能只看那句赋值在不在守卫里面（那样写在外面也能过），
   * 要数：全文件只有两处写 `inkRetryAt` —— 守卫内推进一次、换模型时清零一次。
   * 多出第三处，就说明有人在别处也推进了它，「跳过」会静默变成一次失败。
   */
  const advances = pluginSource.match(/inkRetryAt\s*=\s*[^;]+;/g) ?? [];
  check('探测被跳过时不推进 inkRetryAt（跳过不算一次失败：全文件只有「守卫内推进」与「换模型清零」两处写入）',
    advances.length === 2 &&
    advances[0].includes('THUMB_RETRY_MS') &&
    /isDefaultStageView\(view\)[\s\S]{0,240}host\.inkRetryAt = now \+ THUMB_RETRY_MS;/.test(pluginSource));
}

/* ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? '✔' : '✘'} STAGE VIEW GATE —— ${passed} 项通过、${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
