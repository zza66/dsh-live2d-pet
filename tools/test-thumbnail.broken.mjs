#!/usr/bin/env node
/**
 * 门禁�?*模型缩略�?*（`lib/test/thumbnail.mjs` �?`src/client/thumbnail.ts`）�? *
 * ## 为什么需要这个文�? *
 * 方案 P1 的交付物里写着「缩略图」，§6.1 的验收第 1 条更是拿它当判据 —�? * 「拖入含 `.model3.json` �?zip �?30 秒内出现在模型库�?*缩略图正�?*」�? * 而这一条此前一行实现都没有：面板的下拉框只显示文本名，用户面对
 * `miku_vts` / `空_vts` 这种名字只能逐个点进去看�? *
 * 补上它之后就有了这个文件要守的东西：这条链上真正会出错的地方全是
 * **算术与防�?*，而它们在没有门禁时全都够不着 —�? *
 *   - 包围盒算错：只表现为「图裁歪了一点」。肉眼说不清是裁歪，还是模型
 *     本来就长那样�? *   - `parseStored()` 少一个判空：表现为「面板偶尔白屏一下」。那�?§9.2
 *     那次事故的形状，而且复现不了�? *   - 指纹比对写错：表现为「换了模型还显示旧图」�?*一张错的图比没有图更糟**�? *     因为用户会拿它当依据�? *
 * ## 为什么这些能离线断言
 *
 * `thumbnail.ts` 被刻意写成了�?DOM、零 canvas、零 localStorage、零 `Date.now()`
 * —�?像素与时间都从参数进来。抓帧那一段（真的�?canvas �?GL）留�?`plugin.ts`�? * 因为它必然带着 `preserveDrawingBuffer: false` �?rAF 的时序约束，那部分只�? * 在浏览器里看。剩�?*所有会算错的地�?*都在这里，逐条钉死�? *
 * ## 用法
 *
 *     node tools/test-thumbnail.mjs     （离线：无网络、无 DOM、不写文件）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(here, '..', 'dsh-live2d-pet');
const modulePath = resolve(PACKAGE, 'lib/test/thumbnail.mjs');
const sourcePath = resolve(PACKAGE, 'src/client/thumbnail.ts');
const pluginPath = resolve(PACKAGE, 'src/client/plugin.ts');

let failed = 0;
let passed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  �?${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  �?${label}${detail ? `  ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

if (!existsSync(modulePath)) {
  console.error(`缩略图的测试产物不存在：${modulePath}`);
  console.error('先在 dsh-live2d-pet 里跑 `node build.mjs`�?);
  process.exit(2);
}

const mod = await import(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href);
const {
  ALPHA_THRESHOLD,
  BBOX_PAD,
  MAX_STORED_THUMBS,
  MAX_THUMB_CHARS,
  MAX_THUMB_SIDE,
  PROBE_MAX_SIDE,
  THUMB_PREFIX,
  bboxOfAlpha,
  fingerprintOf,
  fitInto,
  inkCenterNdc,
  isFresh,
  isStorableThumb,
  parseStored,
  pickEvictions,
  serializeThumb,
  thumbnailKey,
  thumbAlt,
} = mod;

const source = readFileSync(sourcePath, 'utf8');
const plugin = readFileSync(pluginPath, 'utf8');
const petModelPath = resolve(PACKAGE, 'src/client/pet-model.ts');
const petModel = readFileSync(petModelPath, 'utf8');

/**
 * 去掉注释再匹配�? *
 * 这一条是被自己绊出来的：`thumbnail.ts` 的文件头**正解释着**「这个文件里没有
 * DOM、没�?canvas、没�?localStorage、没�?Date.now()」，于是直接 grep 源码
 * 一定命中那句注释，断言必红�? * 「文档里承诺的东西」和「代码里做的事」必须分开�?—�?去掉注释之后剩下�? * 才是代码，而那才是要断言的对象�? */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}
const sourceCode = stripComments(source);
const pluginCode = stripComments(plugin);
const petModelCode = stripComments(petModel);

/** 造一�?`width × height` �?RGBA，`fill(x, y)` 返回该点�?alpha�?*/
function alphaField(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[(y * width + x) * 4 + 3] = fill(x, y);
    }
  }
  return data;
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const entry = (extra = {}) => ({ id: 'm', path: 'm/m.model3.json', name: 'm', ...extra });

// ───────────────────────────────────────────────────────────────────────────
section('[1] �?键与上限：只有一个定义处');

check(
  '键带前缀（不带前缀会与别的插件、与用户自己的键撞）',
  typeof THUMB_PREFIX === 'string' && THUMB_PREFIX !== '' && THUMB_PREFIX.endsWith(':'),
  `实测 ${JSON.stringify(THUMB_PREFIX)}`,
);
check(
  'thumbnailKey() 是「前缀 + id」，且与 id 一一对应',
  thumbnailKey('abc') === `${THUMB_PREFIX}abc` && thumbnailKey('abc') !== thumbnailKey('abd'),
  `实测 ${thumbnailKey('abc')}`,
);
check(
  '输出长边上限 96（面板里那一行高 48px，够 2 倍屏�?,
  MAX_THUMB_SIDE === 96,
  `实测 ${MAX_THUMB_SIDE}`,
);
check(
  '探测上限严格大于输出上限（先缩到 192 再找包围盒，直接 96 会缺手缺脚）',
  PROBE_MAX_SIDE > MAX_THUMB_SIDE && Number.isFinite(PROBE_MAX_SIDE),
  `实测 probe=${PROBE_MAX_SIDE} out=${MAX_THUMB_SIDE}`,
);
check(
  '每张图的字符上限存在且是个正数（配额的最后一道闸�?,
  typeof MAX_THUMB_CHARS === 'number' && MAX_THUMB_CHARS > 4096,
  `实测 ${MAX_THUMB_CHARS}`,
);
check(
  '张数上限存在且是个正�?,
  typeof MAX_STORED_THUMBS === 'number' && MAX_STORED_THUMBS > 0,
  `实测 ${MAX_STORED_THUMBS}`,
);
check(
  'alpha 阈值不�?0（取 0 会让抗锯齿的第一颗杂散像素把包围盒撑到整张画布）',
  typeof ALPHA_THRESHOLD === 'number' && ALPHA_THRESHOLD > 0,
  `实测 ${ALPHA_THRESHOLD}`,
);
check(
  '包围盒余量严格小�?1 且非�?,
  typeof BBOX_PAD === 'number' && BBOX_PAD >= 0 && BBOX_PAD < 1,
  `实测 ${BBOX_PAD}`,
);

check(
  '�?thumbnail.ts 里没�?Date.now() / localStorage / document（去掉注释之后）—�?纯逻辑模块',
  !/Date\.now\s*\(/.test(sourceCode) && !/localStorage/.test(sourceCode) && !/\bdocument\b/.test(sourceCode),
  '时间与像素必须从参数进来，否则这些断言没法离线�?,
);
check(
  '�?反过来说：文件头的注释确实写了这条承诺（承诺与代码都在，才算数）',
  /没有\s*localStorage/.test(source),
  '上一条守代码，这一条守「那句话还在�?,
);

// ───────────────────────────────────────────────────────────────────────────
section('[2] �?包围盒：模型在画面中间的一小块时，裁出来的必须是那一�?);

// 200×200 里，只有 (50,60)�?149,159) 这一块是透明的反面�?const centered = alphaField(200, 200, (x, y) => (x >= 50 && x <= 149 && y >= 60 && y <= 159 ? 255 : 0));
const box = bboxOfAlpha(centered, 200, 200);
check(
  '�?100×100 的实心块被裁出来，且**不是**整张画布',
  box !== null && box.width >= 100 && box.width <= 120 && box.height >= 100 && box.height <= 120,
  box === null ? '返回 null' : `实测 ${box.width}×${box.height} @ (${box.x},${box.y})`,
);
check(
  '�?裁出来的块包住了原来的那一块（不多不少，含余量�?,
  box !== null && box.x <= 50 && box.y <= 60 && box.x + box.width >= 150 && box.y + box.height >= 160,
  box === null ? '返回 null' : `实测 x∈[${box.x}, ${box.x + box.width - 1}] y∈[${box.y}, ${box.y + box.height - 1}]`,
);
check(
  '�?余量真的加上了（裁出来的�?100×100 大）',
  box !== null && box.width > 100 && box.height > 100,
  box === null ? '返回 null' : `实测 ${box.width}×${box.height}`,
);

// 贴边的模型：包围�?余量会越出画布，必须被夹回来�?const touching = alphaField(100, 100, (x, y) => (x >= 0 && x <= 9 && y >= 0 && y <= 9 ? 255 : 0));
const edgeBox = bboxOfAlpha(touching, 100, 100);
check(
  '�?模型贴着左上角时包围盒被夹回画布内（不夹会让 drawImage 的源矩形越界�?,
  edgeBox !== null && edgeBox.x === 0 && edgeBox.y === 0
    && edgeBox.x + edgeBox.width <= 100 && edgeBox.y + edgeBox.height <= 100,
  edgeBox === null ? '返回 null' : `实测 (${edgeBox.x},${edgeBox.y}) ${edgeBox.width}×${edgeBox.height}`,
);

const touchRight = alphaField(100, 100, (x, y) => (x >= 95 && y >= 95 ? 255 : 0));
const rightBox = bboxOfAlpha(touchRight, 100, 100);
check(
  '右下角同理：夹回之后右边界与下边界都不超过画�?,
  rightBox !== null && rightBox.x + rightBox.width <= 100 && rightBox.y + rightBox.height <= 100,
  rightBox === null ? '返回 null' : `实测 x+w=${rightBox.x + rightBox.width} y+h=${rightBox.y + rightBox.height}`,
);

check(
  '全透明 �?null（空图存下来**看起来像「这个模型就是空的�?*，比没有图更误导�?,
  bboxOfAlpha(alphaField(64, 64, () => 0), 64, 64) === null,
);
check(
  'alpha 恰好等于阈值不算数（判据是严格大于�?,
  bboxOfAlpha(alphaField(16, 16, () => ALPHA_THRESHOLD), 16, 16) === null,
  `阈�?${ALPHA_THRESHOLD}`,
);
check(
  'alpha 恰好比阈值大一点就算数',
  bboxOfAlpha(alphaField(16, 16, () => ALPHA_THRESHOLD + 1), 16, 16) !== null,
);
check(
  '单个像素也算数（模型可能只露出一只角�?,
  bboxOfAlpha(alphaField(32, 32, (x, y) => (x === 7 && y === 19 ? 255 : 0)), 32, 32) !== null,
);
check(
  '�?数据长度不够 �?null（canvas 被别�?resize 过就是这种情形，算出来的框会指向画布外）',
  bboxOfAlpha(new Uint8ClampedArray(10), 64, 64) === null,
);
check(
  'data �?null / undefined �?null，不�?,
  bboxOfAlpha(null, 64, 64) === null && bboxOfAlpha(undefined, 64, 64) === null,
);
check(
  '宽高�?0 / 负数 / 小数 �?null，不�?,
  bboxOfAlpha(new Uint8ClampedArray(64), 0, 64) === null
    && bboxOfAlpha(new Uint8ClampedArray(64), -8, 8) === null
    && bboxOfAlpha(new Uint8ClampedArray(64), 8.5, 8) === null,
);
/*
 * 退化实现：**只差在「一个都没找到」那个分�?*�? *
 * 收窄的逻辑与正确实现逐字相同，唯一的区别是 `maxX < minX` 时它返回整张画布�? * 而正确实现返�?`null`。这样构造是为了让反证只指向那一处差�?—�? * 如果退化实现连收窄都写错，红了也说不清是「漏了空图检查」还是「算术写错了」�? *
 * 症状不是黑图，是「缩略图里模型小得看不清、周围一大圈空白」，
 * 而那个看起来只像「模型本来就小」�? */
const naiveBox = (data, width, height, pad = BBOX_PAD) => {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[(row + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return { x: 0, y: 0, width, height }; // �?差别只在这一�?  const padX = Math.round((maxX - minX + 1) * pad);
  const padY = Math.round((maxY - minY + 1) * pad);
  const x0 = Math.max(0, minX - padX);
  const y0 = Math.max(0, minY - padY);
  const x1 = Math.min(width - 1, maxX + padX);
  const y1 = Math.min(height - 1, maxY + padY);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
};
const blank = alphaField(64, 64, () => 0);
const naiveBlank = naiveBox(blank, 64, 64);
check(
  '�?退化实现（漏掉「一个都没找到」的分支）：全透明时返�?64×64 整张，而正确实现返�?null',
  naiveBlank.width === 64 && naiveBlank.height === 64 && bboxOfAlpha(blank, 64, 64) === null,
  `退�?${naiveBlank.width}×${naiveBlank.height} —�?这就是「缩略图里模型小得看不清」的来源`,
);
check(
  '�?同一份退化实现在「正常找得到」时与正确实�?*逐字相同**（证明反证只指向那一处差别）',
  (() => {
    const a = naiveBox(centered, 200, 200);
    return box !== null && a.x === box.x && a.y === box.y && a.width === box.width && a.height === box.height;
  })(),
  `退�?${JSON.stringify(naiveBox(centered, 200, 200))} vs 正确 ${JSON.stringify(box)}`,
);

// ───────────────────────────────────────────────────────────────────────────
section('[3] �?缩放：只缩不放，且绝不出�?0');

check(
  '长边超限时按长边缩，长宽比保�?,
  JSON.stringify(fitInto(384, 192, 96)) === JSON.stringify({ width: 96, height: 48 }),
  `实测 ${JSON.stringify(fitInto(384, 192, 96))}`,
);
check(
  '�?长边没超限时**不放�?*�?0px 宽的模型放大�?96 只会糊）',
  JSON.stringify(fitInto(40, 30, 96)) === JSON.stringify({ width: 40, height: 30 }),
  `实测 ${JSON.stringify(fitInto(40, 30, 96))}`,
);
check(
  '�?极扁的图也不会缩�?0 高（0 宽的 canvas 会让 toDataURL �?IndexSizeError�?,
  fitInto(1000, 3, 96).height >= 1 && fitInto(1000, 3, 96).width === 96,
  `实测 ${JSON.stringify(fitInto(1000, 3, 96))}`,
);
check(
  '0 / 负数 / NaN / Infinity 的输入一律退化成至少 1×1，不�?,
  [fitInto(0, 0, 96), fitInto(-5, -5, 96), fitInto(NaN, NaN, 96), fitInto(Infinity, Infinity, 96)]
    .every((r) => Number.isInteger(r.width) && r.width >= 1 && Number.isInteger(r.height) && r.height >= 1),
  `实测 ${JSON.stringify(fitInto(NaN, NaN, 96))}`,
);
check(
  'max �?0 / NaN 时退回默认上限，不返�?0 尺寸',
  fitInto(100, 100, 0).width >= 1 && fitInto(100, 100, NaN).width >= 1,
  `实测 max=0 �?${JSON.stringify(fitInto(100, 100, 0))}`,
);
check(
  '默认参数就是输出上限 96',
  JSON.stringify(fitInto(1000, 1000)) === JSON.stringify(fitInto(1000, 1000, MAX_THUMB_SIDE)),
);
check(
  '正方形缩放后仍是正方�?,
  fitInto(500, 500, 96).width === fitInto(500, 500, 96).height,
  `实测 ${JSON.stringify(fitInto(500, 500, 96))}`,
);

// ───────────────────────────────────────────────────────────────────────────
section('[4] �?指纹与新鲜度：换过文件就必须重拍');

const rich = entry({ mtimeMs: 1700000000000, bytes: 12345, moc3: { version: 5 } });
const fp = fingerprintOf(rich);
check(
  '指纹�?mtime + bytes + moc3 版本拼成，三者任一不同则指纹不�?,
  fp !== '' && fp !== fingerprintOf({ ...rich, mtimeMs: 1700000000001 })
    && fp !== fingerprintOf({ ...rich, bytes: 12346 })
    && fp !== fingerprintOf({ ...rich, moc3: { version: 4 } }),
  `实测 ${fp}`,
);
check(
  '�?只有 bytes 相同、mtime 不同时指纹仍然不同（单靠 bytes 会显�?*别的模型的图**�?,
  fingerprintOf(entry({ mtimeMs: 1, bytes: 999 })) !== fingerprintOf(entry({ mtimeMs: 2, bytes: 999 })),
);
check(
  '两个文件信息都没有时返回空串（表示「拿不到身份」）',
  fingerprintOf(entry()) === '' && fingerprintOf(null) === '' && fingerprintOf(undefined) === '',
);
check(
  'mtime 有、bytes 没有（或反过来）也能算出非空指纹',
  fingerprintOf(entry({ mtimeMs: 5 })) !== '' && fingerprintOf(entry({ bytes: 5 })) !== '',
);
check(
  '�?空指纹一律判为不新鲜（信一张旧图的代价是显示错模型，多拍一张几乎不要成本）',
  isFresh({ id: 'm', dataUrl: PNG, fingerprint: '', at: 1 }, '') === false
    && isFresh({ id: 'm', dataUrl: PNG, fingerprint: 'x', at: 1 }, '') === false,
);
check(
  '指纹一致且图非�?�?新鲜',
  isFresh({ id: 'm', dataUrl: PNG, fingerprint: fp, at: 1 }, fp) === true,
);
check(
  '指纹不一�?�?不新鲜（模型文件被换过了�?,
  isFresh({ id: 'm', dataUrl: PNG, fingerprint: fp, at: 1 }, fingerprintOf({ ...rich, bytes: 1 })) === false,
);
check(
  '存的图是空的 / null / 不是对象 �?一律不新鲜，不�?,
  isFresh(null, fp) === false && isFresh(undefined, fp) === false
    && isFresh({ id: 'm', dataUrl: '', fingerprint: fp, at: 1 }, fp) === false,
);
check(
  '�?退化成「只�?id」就会把换过文件的旧图当成新鲜的',
  (() => {
    const naiveFresh = (stored, fingerprint) => stored !== null && stored.dataUrl !== '';
    return naiveFresh({ id: 'm', dataUrl: PNG, fingerprint: 'old', at: 1 }, 'new') === true
      && isFresh({ id: 'm', dataUrl: PNG, fingerprint: 'old', at: 1 }, 'new') === false;
  })(),
  '这就是「换了模型还显示旧图�?,
);

// ───────────────────────────────────────────────────────────────────────────
section('[5] �?坏数据解析：客户端半区不许抛（�?.2 白屏事故的教训）');

check(
  '正常的一条能读回来，字段齐全',
  (() => {
    const t = parseStored(serializeThumb({ id: 'a', dataUrl: PNG, fingerprint: 'f', at: 42 }));
    return t !== null && t.id === 'a' && t.dataUrl === PNG && t.fingerprint === 'f' && t.at === 42;
  })(),
);
check(
  '�?JSON 字符�?�?null，不�?,
  parseStored('{ 这不�?json') === null && parseStored('') === null,
);
check(
  'null / undefined / 数字 / 布尔 / 数组 �?null',
  parseStored(null) === null && parseStored(undefined) === null
    && parseStored(42) === null && parseStored(true) === null && parseStored([]) === null,
);
check(
  '缺字�?/ 字段类型�?�?null',
  parseStored('{"dataUrl":"x"}') === null
    && parseStored('{"id":"a"}') === null
    && parseStored(JSON.stringify({ id: 'a', dataUrl: 5, fingerprint: 'f', at: 1 })) === null
    && parseStored(JSON.stringify({ id: '', dataUrl: PNG, fingerprint: 'f', at: 1 })) === null,
);
check(
  '�?不是 data URL 的一律拒绝（`http://` 塞进来会�?<img src> 拿去发请求）',
  parseStored(JSON.stringify({ id: 'a', dataUrl: 'https://evil.example/x.png', fingerprint: 'f', at: 1 })) === null,
  '这个字段理论上可能来自被改过�?localStorage',
);
check(
  'at 缺失或不是有限数 �?退化成 0 而不�?null（排序用得上，缺了不该丢掉整条）',
  (() => {
    const t = parseStored(JSON.stringify({ id: 'a', dataUrl: PNG, fingerprint: 'f' }));
    const u = parseStored(JSON.stringify({ id: 'a', dataUrl: PNG, fingerprint: 'f', at: NaN }));
    return t !== null && t.at === 0 && u !== null && u.at === 0;
  })(),
);
check(
  '�?超过字符上限的条目也被拒（顺带让配额有自我修复能力：写得进去读不出来的键会被当垃圾清掉）',
  parseStored(JSON.stringify({ id: 'a', dataUrl: `data:image/png;base64,${'A'.repeat(MAX_THUMB_CHARS)}`, fingerprint: 'f', at: 1 })) === null,
);
check(
  'isStorableThumb �?parseStored 对本模块自己的产出判断一致（存得进去就必须读得回来）',
  isStorableThumb(PNG) === true && parseStored(serializeThumb({ id: 'a', dataUrl: PNG, fingerprint: 'f', at: 1 })) !== null,
);
check(
  'isStorableThumb 拒绝超大图、非字符串、非图片',
  isStorableThumb(`data:image/png;base64,${'A'.repeat(MAX_THUMB_CHARS)}`) === false
    && isStorableThumb(null) === false && isStorableThumb(12345) === false
    && isStorableThumb('https://x/y.png') === false,
);
check(
  '解析函数全都是防御式的：拿一堆畸形输入连打不�?,
  (() => {
    const junk = [null, undefined, '', '{', '[]', '[1,2,3]', '0', '"x"', '{"id":null}'];
    try {
      for (const j of junk) parseStored(j);
      return true;
    } catch {
      return false;
    }
  })(),
);

// ───────────────────────────────────────────────────────────────────────────
section('[6] �?淘汰：配额的最后一道闸');

const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, dataUrl: PNG, fingerprint: 'f', at: 1000 + i }));
check(
  '没超上限时一个都不删',
  pickEvictions(many.slice(0, MAX_STORED_THUMBS)).length === 0,
  `上限 ${MAX_STORED_THUMBS}`,
);
check(
  '�?超上限时删掉最旧的，留下的张数正好等于上限',
  (() => {
    const doomed = pickEvictions(many);
    return doomed.length === 40 - MAX_STORED_THUMBS && doomed.every((d) => d.at < 1000 + (40 - MAX_STORED_THUMBS));
  })(),
  `�?${pickEvictions(many).length} 张`,
);
check(
  'at 相同时按 id 排，结果稳定（不然每次启动删的可能不是同一批）',
  (() => {
    // id 补零，让字典序与数值序一�?—�?不补零的�?'z10' < 'z2'�?    // 断言里就得手写一串反直觉的期望值，读的人只会更糊涂�?    const ties = Array.from({ length: MAX_STORED_THUMBS + 2 }, (_, i) => ({
      id: `z${String(i).padStart(2, '0')}`, dataUrl: PNG, fingerprint: 'f', at: 7,
    }));
    const a = pickEvictions(ties).map((d) => d.id).join(',');
    const b = pickEvictions([...ties].reverse()).map((d) => d.id).join(',');
    return a === b && a === 'z32,z33';
  })(),
  `34 张同时间�?�?删最后两�?${(() => {
    const ties = Array.from({ length: MAX_STORED_THUMBS + 2 }, (_, i) => ({ id: `z${String(i).padStart(2, '0')}`, dataUrl: PNG, fingerprint: 'f', at: 7 }));
    return pickEvictions(ties).map((d) => d.id).join(',');
  })()}`,
);
check(
  '空数�?/ null / undefined �?不删也不�?,
  pickEvictions([]).length === 0 && pickEvictions(null).length === 0 && pickEvictions(undefined).length === 0,
);
check(
  '数组里混进垃圾条目也不会�?,
  (() => {
    try {
      const mixed = [null, undefined, 5, 'x', { id: 'ok', dataUrl: PNG, fingerprint: 'f', at: 1 }];
      return Array.isArray(pickEvictions(mixed));
    } catch {
      return false;
    }
  })(),
);
check(
  'limit 显式�?0 时全删，传负数退回默认上�?,
  pickEvictions(many, 0).length === 40 && pickEvictions(many, -1).length === 40 - MAX_STORED_THUMBS,
);

// ───────────────────────────────────────────────────────────────────────────
section('[7] �?接线：抓帧必须紧�?draw()，且只在真的画了它之后才�?);

check(
  '�?抓图调用排在 model.draw() 之后（GL �?preserveDrawingBuffer: false，出了这一帧缓冲就空了�?,
  (() => {
    const drawn = plugin.indexOf('model.draw(w, hgt);');
    const shot = plugin.indexOf('captureThumbnail(canvas,');
    return drawn > 0 && shot > drawn;
  })(),
  '排反了的症状是「缩略图永远存不下来」，看起来却像「模型没渲染�?,
);
/*
 * 这一条原来写的是「`captureThumbnail(` 必须排在
 * `host.raf = requestAnimationFrame(frame);` 之后」—�?拿源码里的先后顺序当�? * 「下一帧的调度不会被抓图挡掉」的替身�? *
 * 帧循环为了加异常护栏拆成了两层（`frame` 外壳负责重排下一�?+ try/catch�? * `drawFrame` 负责真正画），于是这两个字符串在文件里的先后**反了过来**�? * rAF 那行现在在外壳里，位置在 `drawFrame` 的定义之后。顺序断言因此变红�? * 而它想守的性质其实仍然成立、而且更好守了�? *
 * 所以这里改成直接断言结构，而不是断言两个字符串的偏移量：
 *   �?外壳�?`requestAnimationFrame` 排在 `drawFrame(now)` 调用**之前**�? *   �?抓图仍然�?`drawFrame` 体内、`model.draw()` 之后�? * 这比原来的写法强 —�?原来只要把任意一处挪到别处就可能假绿�? *
 * �?后来又改过一次：`drawFrame` 现在**有返回�?*（`true` = 这一帧真的落�? * 画布上了），调用点因此从 `drawFrame(now);` 变成 `const drew = drawFrame(now);`�? * 下面 probe 里的字符串跟着一起改 —�?这正是「断言的是替身而不是结构」的代价�? * 替身（那一行字面量）变了，断言就失效�? */
check(
  '�?下一帧的调度排在真正绘制之前，抓图排在绘制之后（两层帧循环的结构断言�?,
  (() => {
    const raf = plugin.indexOf('host.raf = requestAnimationFrame(frame);');
    const call = plugin.indexOf('drawFrame(now)');
    const body = plugin.indexOf('const drawFrame = (now: number): boolean =>');
    const drawn = plugin.indexOf('model.draw(w, hgt);');
    const shot = plugin.indexOf('captureThumbnail(canvas,');
    return raf > 0 && call > raf && body > 0 && drawn > body && shot > drawn;
  })(),
  '外壳先重排下一帧、再�?try 里画；抓图在绘制之后（GL 出了这一帧缓冲就空了�?,
);
check(
  '�?帧循环外层有 try/catch 兜底（rAF 回调里抛出的异常会被浏览器吞掉，症状就是画面永久定格且一行日志都没有�?,
  /try \{\s*const drew = drawFrame\(now\);/.test(pluginCode)
    && /catch \(err\) \{\s*frameErrors \+= 1;/.test(pluginCode)
    && /reportFailure\(\s*'frame',/.test(pluginCode),
);
/*
 * �?看门狗的电源来自 `drawFrame` 的返回值�? *
 * 这条断言守的是一�?*我自己写出来�?*缺陷：第一版把 `lastDrawnAt = Date.now()`
 * 记在调用处，于是「被判掉的帧」也算「画过了」。看门狗存在的唯一理由就是�? * 「帧率上限被算成 Infinity、每一帧都被判掉」那一�?—�?而那一类恰好被它自�? * 的记账方式盖住了：画面冻着，看门狗一声不吭�? *
 * 所以这里断言的是「记账的开关接在返回值上」，而不是「文件里出现�?lastDrawnAt」�? */
check(
  '�?停摆看门狗的记账开关接�?drawFrame 的返回值上（判掉的帧不算画过）',
  /const drew = drawFrame\(now\);/.test(pluginCode)
    && /if \(drew\) lastDrawnAt = Date\.now\(\);/.test(pluginCode)
    && !/^\s*lastDrawnAt = Date\.now\(\);/m.test(pluginCode),
  '不接返回值的话，「每一帧都被判掉」这种停摆会被看门狗自己盖住',
);
check(
  '�?三个前置条件都在：拍的是要拍的那�?/ 指纹没拍�?/ 过了重试间隔',
  /host\.renderedPath === modelPath/.test(plugin)
    && /host\.thumbDoneFor !== want\.fingerprint/.test(plugin)
    && /now >= host\.thumbRetryAt/.test(plugin),
);
check(
  '�?renderedPath 只在 activate 成功那一行赋值（失败路径一个字节都不动�?,
  (() => {
    // 只数真正的赋值。`===` 比较里的等号不算 —�?第一版用 `\s*=` 数出 3 处，
    // 其中两处是注释与比较表达式，那正是「模式凭记忆写」的老毛病�?    const assigns = pluginCode.match(/host\.renderedPath = [^=]/g) ?? [];
    const inActivate = /host\.current = prepared;[\s\S]{0,400}?host\.renderedPath = modelPath;/.test(pluginCode);
    return assigns.length === 1 && inActivate;
  })(),
  `实测 ${(pluginCode.match(/host\.renderedPath = [^=]/g) ?? []).length} 处赋值`,
);
check(
  '�?缩略图的两个值走 ref（`frame()` 看不到后�?props，为一�?96px 小图重启渲染循环不值）',
  /thumbWantRef\.current = props\.thumbWant;/.test(plugin) && /onThumbRef\.current = props\.onThumb;/.test(plugin),
);
check(
  '�?换模型后把重试节流放开（不然新模型要等�?250ms 才拍得到�?,
  (() => {
    const activate = plugin.indexOf('host.renderedPath = modelPath;');
    if (activate < 0) return false;
    return /host\.thumbRetryAt = 0;/.test(plugin.slice(activate, activate + 400));
  })(),
);
check(
  '�?存储与新鲜度判断留在面板里，舞台只拿像素（舞台不知道哪个模型被选中了）',
  /thumbWant: ThumbWant \| null;/.test(plugin) && /onThumb: \(want: ThumbWant, dataUrl: string\) => void;/.test(plugin),
);
check(
  '�?选中模型那一行的 <img> �?alt（读屏软件不该念一�?id�?,
  /alt: thumbAlt\(active\)/.test(plugin),
);
check(
  '�?面板 effect 的依赖是原始值而不�?active 对象（用对象当依赖会每轮扫描都重拍）',
  /active\?\.mtimeMs as number \| undefined/.test(plugin) && /active\?\.bytes as number \| undefined/.test(plugin),
);
check(
  '�?缩略图写盘走 writeStoredThumb（localStorage 配额爆掉时绝不能往上抛�?,
  /function writeStoredThumb\(thumb: StoredThumb\): void \{/.test(plugin)
    && /function readStoredThumb\(id: string\): StoredThumb \| null \{/.test(plugin),
  '这两个包装函数是唯一允许�?localStorage 的地�?,
);
check(
  '�?缩略图的存取只经由那两个包装函数（`thumbnailKey()` 只在这两个函数里�?localStorage 一起出现）',
  (() => {
    // 整个文件�?localStorage �?7 处（折叠状态、上次选的模型、用户设置……）�?    // 所以不能数总数 —�?要数的是**与缩略图键一�?*出现的那几处�?    const gets = pluginCode.match(/localStorage\.getItem\(thumbnailKey\(/g) ?? [];
    const sets = pluginCode.match(/localStorage\.setItem\(thumbnailKey\(/g) ?? [];
    const swept = pluginCode.match(/localStorage\.getItem\(key\)/g) ?? [];
    return gets.length === 1 && sets.length === 1 && swept.length === 1;
  })(),
  '�?1 处、写 1 处、清扫时读回 1 处，都在包装函数�?,
);

// ───────────────────────────────────────────────────────────────────────────
/*
 * �?自动居中：模型偏右时把它挪回来�? *
 * 这一节存在的理由是一个用户可见的故障：「miku 不在窗口正中心，偏向屏幕右侧�? * 而空没什么问题」。排查结论是**两边都没写错** —�?`draw()` �?contain 适配数学
 * 上必然居中、`cubismmatrix44.scale()` 是赋值、整条变换链里没有任何平移项�? * 偏心来自模型作者的画布摆放：miku 的本体在�?3500 宽的画布里整体偏右�? *
 * 所以修法不是「改数学」，是「量一次实际画在哪，把差值补回去」。量的对象是
 * **像素**而不是顶点：顶点里混着大量 `opacity <= 0` 的绘制对象（miku 440 个里
 * 166 个是 0），而且顶点包围盒包含画布外的几何；用户眼睛看到的是画出来的那一块�? */
section('[9] �?自动居中：本体中心的 NDC 换算');

const closeTo = (a, b, epsilon = 1e-9) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= epsilon;

check(
  '�?本体正好居中 �?0（四周留白对称）',
  closeTo(inkCenterNdc({ x: 0, width: 100 }, 100, 100), 0),
  `实测 ${inkCenterNdc({ x: 0, width: 100 }, 100, 100)}`,
);
check(
  '本体贴左�?�?负，贴右�?�?正，且互为相反数',
  closeTo(inkCenterNdc({ x: 0, width: 50 }, 100, 100), -0.5)
    && closeTo(inkCenterNdc({ x: 50, width: 50 }, 100, 100), 0.5),
  `�?${inkCenterNdc({ x: 0, width: 50 }, 100, 100)} / �?${inkCenterNdc({ x: 50, width: 50 }, 100, 100)}`,
);
check(
  '�?采样画布缩过尺寸时结果不变（少乘或多�?source/probe 的比例，症状只是「看着还偏一点」）',
  (() => {
    // 1920 宽的画布缩到 192 宽采样：源里 x=50 �?100 的那一块，在采样里�?x=5 �?10�?    const viaProbe = inkCenterNdc({ x: 5, width: 10 }, 192, 1920);
    const viaSource = inkCenterNdc({ x: 50, width: 100 }, 1920, 1920);
    return closeTo(viaProbe, viaSource, 1e-9);
  })(),
  `采样�?${inkCenterNdc({ x: 5, width: 10 }, 192, 1920)} vs 直算 ${inkCenterNdc({ x: 50, width: 100 }, 1920, 1920)}`,
);
check(
  '�?满幅的本�?�?0（不因为「没有留白」而算出偏移）',
  closeTo(inkCenterNdc({ x: 0, width: 192 }, 192, 192), 0),
);
check(
  '�?脏输入一�?null，不抛也不返�?NaN（NaN 传下�?`translate(-NaN)` 会让整只模型消失�?,
  inkCenterNdc(null, 192, 1920) === null
    && inkCenterNdc(undefined, 192, 1920) === null
    && inkCenterNdc({ x: 0, width: 0 }, 192, 1920) === null
    && inkCenterNdc({ x: 0, width: 10 }, 0, 1920) === null
    && inkCenterNdc({ x: 0, width: 10 }, 192, 0) === null
    && inkCenterNdc({ x: Number.NaN, width: 10 }, 192, 1920) === null
    && inkCenterNdc({ x: 0, width: 10 }, Number.NaN, 1920) === null,
);

section('[10] �?自动居中的接线：量在绘制之后、量过就不再量、只在真的偏心时平移');

check(
  '�?量居中的调用�?`drawFrame` 体内、排�?model.draw() 之后（GL �?preserveDrawingBuffer: false，晚一步就只剩透明�?,
  (() => {
    const drawn = pluginCode.indexOf('model.draw(w, hgt);');
    const measure = pluginCode.indexOf('measureInkCenterX(canvas, host.inkProbe)');
    const shot = pluginCode.indexOf('captureThumbnail(canvas,');
    return drawn > 0 && measure > drawn && shot > 0 && measure > shot;
  })(),
  '排反了的症状是「自动居中永远不生效」，看起来却像「这个模型不需要居中�?,
);
check(
  '�?量居中的三个前置条件都在（画面上是这一�?/ 这个模型没量�?/ 过了重试间隔�?,
  /host\.renderedPath !== null && host\.inkDoneFor !== host\.renderedPath && now >= host\.inkRetryAt/.test(pluginCode),
);
check(
  '�?「量过就不再量」的键是模型路径而不是别的（量→挪→再量会互相追着跑，位置永远收敛不了�?,
  /host\.inkDoneFor = host\.renderedPath;/.test(pluginCode)
    && /inkDoneFor: string \| null;/.test(pluginCode),
);
check(
  '�?只有量出了数�?`setInkCenterX`（量不到返回 null = 这一帧没画上去，不是「中心在 0」）',
  /if \(inkCenterX !== null\) \{/.test(pluginCode)
    && /model\.setInkCenterX\(inkCenterX\);/.test(pluginCode),
);
check(
  '�?换模型时把「量过」清掉（路径没变但模型换了的情况靠它兜底：换�?/ 重新导入�?,
  /host\.inkDoneFor = null;/.test(pluginCode),
);
check(
  '�?量像素这一步绝不抛（量不到只是「这一帧没居中」，不该让面板白�?—�?§9.2 的教训）',
  /reportFailure\('ink-center', err\);/.test(pluginCode),
);
check(
  '�?采样包围盒不做外扩（`pad` �?0：默认的 BBOX_PAD 会把边界往外扩，中心反而被推歪�?,
  (() => {
    /*
     * �?`measureInkCenterX` 的定义处开始找�?*不能**�?`indexOf` 找第一�?     * `bboxOfAlpha(`：`captureThumbnail()` 里也有一处，而那一�?*应该**用默认的
     * `pad`（缩略图要留余量）。第一版就是这么写错的，探针量到了隔壁那个函数�?     */
    const fn = pluginCode.indexOf('function measureInkCenterX(');
    if (fn < 0) return false;
    const call = pluginCode.slice(fn, fn + 900);
    const box = call.indexOf('const box = bboxOfAlpha(');
    if (box < 0) return false;
    return /,\s*undefined,\s*0,\s*\)/.test(call.slice(box, box + 300));
  })(),
);
check(
  '�?平移只在真的偏心时做（`_inkCenterX === 0` 时连 translate 都不调，避免给所有模型白加一层变换）',
  /\$\{this\._inkCenterX !== 0\}/.test(petModelCode) || /if \(this\._inkCenterX !== 0\) \{/.test(petModelCode),
);
check(
  '�?平移夹在 [-1, 1] 里且拒绝非有限数（越界平移会把模型推出画布）',
  /Math\.max\(-1, Math\.min\(1, inkCenterX\)\)/.test(petModelCode)
    && /if \(!Number\.isFinite\(inkCenterX\)\) \{/.test(petModelCode),
);
check(
  '�?平移加在 `multiplyByMatrix(modelMatrix)` **之后**（`translate()` 是赋值不是累加，放在后面写进去的才是最�?NDC 平移量；放前面会�?scale 再乘一遍）',
  (() => {
    const m = petModelCode.indexOf('projection.multiplyByMatrix(modelMatrix);');
    const t = petModelCode.indexOf('projection.translate(-this._inkCenterX,');
    return m > 0 && t > m;
  })(),
  '第一版这条断言写反了（要求 translate 在前），被门禁自己抓出来 —�?顺序确实是后面那个对',
);
check(
  '�?平移只改 x，y 原样读回来写回（`translate()` 两个分量都赋值，硬写 0 是在赌「模型矩阵的平移恰好�?0」）',
  /projection\.translate\(-this\._inkCenterX, projection\.getTranslateY\(\)\)/.test(petModelCode),
);

// ───────────────────────────────────────────────────────────────────────────
section('[8] �?反证：把关键判据改坏，上面这些断言必须能红');

// 反证 1：`isFresh` 退化成「只看有没有图」�?const naiveFresh = (stored) => stored !== null && stored !== undefined && stored.dataUrl !== '';
check(
  '反证 1：只比「有没有图」的实现在换过文件后仍然说新�?,
  naiveFresh({ id: 'm', dataUrl: PNG, fingerprint: 'old', at: 1 }) === true
    && isFresh({ id: 'm', dataUrl: PNG, fingerprint: 'old', at: 1 }, 'new') === false,
  '正确实现要求指纹逐字相等',
);

// 反证 2：包围盒不夹回画�?—�?贴边时会算出越界的框�?const unclamped = (data, width, height) => {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const padX = Math.round((maxX - minX + 1) * BBOX_PAD);
  const padY = Math.round((maxY - minY + 1) * BBOX_PAD);
  return { x: minX - padX, y: minY - padY, width: maxX - minX + 1 + padX * 2, height: maxY - minY + 1 + padY * 2 };
};
const bad = unclamped(touching, 100, 100);
check(
  '反证 2：不夹回画布的实现在模型贴左上角时给出负坐标',
  bad.x < 0 && bad.y < 0,
  `实测 x=${bad.x} y=${bad.y}；正确实�?${edgeBox === null ? 'null' : `x=${edgeBox.x} y=${edgeBox.y}`}`,
);

// 反证 3：`fitInto` 允许放大 —�?小模型会被拉糊�?const naiveFit = (w, h, max) => {
  const scale = max / Math.max(w, h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
};
check(
  '反证 3：允许放大的实现�?40px 宽的模型上给�?96，正确实现保�?40',
  naiveFit(40, 30, 96).width === 96 && fitInto(40, 30, 96).width === 40,
  '放大只会糊，不会更清�?,
);

// 反证 4：`parseStored` 不检查前缀 —�?一条外�?URL 就能�?<img> 发请求�?const naiveParse = (raw) => {
  try {
    const v = JSON.parse(raw);
    if (v === null || typeof v !== 'object') return null;
    if (typeof v.dataUrl !== 'string' || v.dataUrl === '') return null;
    return { id: String(v.id ?? ''), dataUrl: v.dataUrl, fingerprint: String(v.fingerprint ?? ''), at: Number(v.at) || 0 };
  } catch {
    return null;
  }
};
const evil = JSON.stringify({ id: 'a', dataUrl: 'https://evil.example/x.png', fingerprint: 'f', at: 1 });
check(
  '反证 4：不检�?data: 前缀的实现放行了外部 URL，正确实现拒�?,
  naiveParse(evil) !== null && parseStored(evil) === null,
  '这个字段理论上可能来自被改过�?localStorage',
);

/*
 * 反证 5：`pickEvictions` 不排序，直接按传进来的顺序切�? *
 * 淘汰列表来自遍历 localStorage 的键，那个顺序与时间无关。不排序就等�? * **碰运气删**：`many` 恰好是「最旧的在前面」，于是切掉的是最�?8 �?—�? * 也就�?*最新拍�?8 �?*。正确的实现必须删最旧的�? * （第一版把这条写反了：我拿「最新的排在前面」的输入去试，不排序恰好也对�? * 于是反证没红。反证本身也要挑一个真能分出对错的输入。）
 */
const naiveEvict = (list, limit) => (list.length <= limit ? [] : list.slice(limit));
const naiveDoomed = naiveEvict(many, MAX_STORED_THUMBS);
const rightDoomed = pickEvictions(many);
check(
  '反证 5：不排序的实现删掉的�?*最�?*�?8 张，正确实现删最旧的 8 �?,
  naiveDoomed.length === 8
    && naiveDoomed.every((d) => d.at >= 1000 + MAX_STORED_THUMBS)
    && rightDoomed.length === 8
    && rightDoomed.every((d) => d.at < 1000 + (many.length - MAX_STORED_THUMBS)),
  `退化删 at�?{1000 + MAX_STORED_THUMBS}，正确删 at<${1000 + (many.length - MAX_STORED_THUMBS)}`,
);

// 反证 6：`thumbAlt` 退化成固定文字�?check(
  '反证 6：固定替代文字在换模型后不变，正确实现跟着模型名走',
  thumbAlt(entry({ name: 'miku_vts' })) !== thumbAlt(entry({ name: '空_vts' }))
    && thumbAlt(entry({ name: 'miku_vts' })).includes('miku_vts'),
  `实测 ${thumbAlt(entry({ name: 'miku_vts' }))}`,
);

/*
 * 反证 7：帧循环那条 try/catch 断言�? *
 * 它是�?*源码探针**，所以红不红取决于正则写得准不准 —�?那正是最需要反证的一类�? * 这里�?`try {` 那层剥掉（只改这一处，其余原封不动），断言必须跟着变红�? * 探针如果对此无动于衷，它守的就不是「有没有兜底」，而是「文件里有没有这几个字」�? */
check(
  '反证 7：剥掉帧循环�?try/catch 外壳，那条护栏断言必须变红',
  (() => {
    const broken = pluginCode.replace(/try \{\s*const drew = drawFrame\(now\);/, 'const drew = drawFrame(now);');
    /*
     * 只断言「那条护栏的正则不再匹配」，**不要**顺带断言 `catch` 也没�?—�?     * 这次突变只拿掉了 `try {`，`catch` 还在文件里（只是没了配对�?try）�?     * 第一版就多写了这半句，于是反�?7 自己红了：反证红的时候，先怀疑反证�?     */
    return broken !== pluginCode && !/try \{\s*const drew = drawFrame\(now\);/.test(broken);
  })(),
);
/*
 * 反证 8：看门狗那条记账断言�? *
 * 突变的是**语义**而不是文本：�?`if (drew) lastDrawnAt = Date.now();`
 * 换成无条件的 `lastDrawnAt = Date.now();`（也就是我一开始写错的那一版）�? * 文本里仍然有 `lastDrawnAt = Date.now()`，只有断言里那�?`!` 那一半能发现它�? * 这正是这一条反证要证明的：那条断言真的在守语义，不是守字符串�? */
check(
  '反证 8：把记账改成无条件（判掉的帧也算画过），那条看门狗断言必须变红',
  (() => {
    const broken = pluginCode.replace(
      /if \(drew\) lastDrawnAt = Date\.now\(\);/,
      'lastDrawnAt = Date.now();',
    );
    return broken !== pluginCode && !/if \(drew\) lastDrawnAt = Date\.now\(\);/.test(broken);
  })(),
);

// ───────────────────────────────────────────────────────────────────────────
console.log('');
if (failed > 0) {
  console.log(`[17] THUMBNAIL GATE FAILED —�?${failed} 项失败，${passed} 项通过`);
  process.exit(1);
}
console.log(`[17] THUMBNAIL GATE PASSED —�?${passed} 项断言全绿`);
