/**
 * dsh-live2d-pet — 微动作包的磁盘层。
 *
 * 一个模型一份包：`<DSH_HOME>/live2d-pet/micro-motions/<slug>.json`。
 *
 * ## 为什么落盘，而不是每次打开面板现生成
 *
 * 生成是确定性的，但**用户会改**：某一条她不想要（关掉）、整体太轻（拉强度）。
 * 现生成会把这两样一起抹掉。而且生成要读 capabilities，渲染端没起来的时候
 * Host 手里根本没有 —— 面板那时打开只能是空的。落盘之后，「这个模型有哪些
 * 微动作」这件事就与「渲染端此刻在不在」解耦了。
 *
 * ## 为什么与 settings.json 分家
 *
 * `settings.json` 是**偏好**（一个模型的开关、强度），这份包是**数据**（动作本身）。
 * 同一个模型的包在换用户/换版本后仍应有效，而偏好可以重来。与 voice-packs 同一个
 * 思路（§13.23）。
 *
 * ## 原子写
 *
 * 写 `<slug>.json.tmp` 再 `renameSync` 覆盖。理由同 §13.24 的账本：DSH 每次改 Host
 * 都重启，写到一半被杀会留下一个截断的 JSON —— 下次读到就是「这个模型的微动作
 * 全没了」。rename 在同一个卷上是原子的，读到的是旧版或新版，不会是半份。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MICRO_MOTION_VERSION, normalizeMicroMotionPack } from './micro-motions.js';

/** 包文件后缀：和目录里可能的临时文件区分开。 */
const PACK_SUFFIX = '.json';
const TEMP_SUFFIX = '.tmp';

/** 一个 slug 最多这么长；后面那 8 位哈希是给「两个模型同名不同路径」兜底的。 */
const MAX_SLUG_LENGTH = 64;

/**
 * 模型 id → 文件名 slug。
 *
 * 模型 id 是模型库里的相对路径（可能是 `hiyori/hiyori.model3.json`，也可能带中文
 * 目录名）。文件名不能直接用：Windows 不认 `:` `*` `?`，而中文在某些解压工具里
 * 会被转码。所以只留 ASCII 的可读部分，再补 8 位哈希 —— 两个不同模型恰好都叫
 * `model` 时不会互相覆盖。
 */
export function slugForModel(modelId) {
  const text = typeof modelId === 'string' ? modelId : '';
  if (text === '') return '';
  const digest = createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8);
  const readable = text
    .toLowerCase()
    .replace(/\.model3\.json$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH - 9);
  return readable === '' ? `model-${digest}` : `${readable}-${digest}`;
}

/**
 * @param {{root: string, now?: () => number}} options
 */
export function createMicroMotionStore(options = {}) {
  const root = resolve(String(options?.root ?? ''));
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();

  const packPathFor = (modelId) => {
    const slug = slugForModel(modelId);
    return slug === '' ? null : join(root, `${slug}${PACK_SUFFIX}`);
  };

  /** 读一份包。`code` 分开报：没有（NOT_FOUND）与坏了（BAD_JSON）不是一回事。 */
  function load(modelId) {
    const path = packPathFor(modelId);
    if (path === null) return { ok: false, code: 'E_MICRO_BAD_MODEL', message: '模型 id 是空的' };
    if (!existsSync(path)) return { ok: false, code: 'E_MICRO_NOT_FOUND', message: '这个模型还没有微动作包' };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      return { ok: false, code: 'E_MICRO_BAD_JSON', message: `微动作包不是合法 JSON：${error?.message ?? error}`, path };
    }
    const pack = normalizeMicroMotionPack(parsed);
    if (pack === null) {
      return { ok: false, code: 'E_MICRO_BAD_PACK', message: '微动作包格式不对（或版本不认识）', path };
    }
    return { ok: true, pack, path };
  }

  /** 写一份包（原子替换）。`pack` 必须已经是 normalize 过的。 */
  function save(modelId, pack) {
    const path = packPathFor(modelId);
    if (path === null) return { ok: false, code: 'E_MICRO_BAD_MODEL', message: '模型 id 是空的' };
    const normalized = normalizeMicroMotionPack({ ...pack, model: modelId });
    if (normalized === null) return { ok: false, code: 'E_MICRO_BAD_PACK', message: '微动作包格式不对' };
    try {
      mkdirSync(root, { recursive: true });
      const temp = `${path}${TEMP_SUFFIX}`;
      writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      renameSync(temp, path);
    } catch (error) {
      return { ok: false, code: 'E_MICRO_WRITE_FAILED', message: `写微动作包失败：${error?.message ?? error}`, path };
    }
    return { ok: true, pack: normalized, path, bytes: statSync(path).size };
  }

  /** 删掉一个模型过期的包（换模型文件后重新生成时用）。 */
  function remove(modelId) {
    const path = packPathFor(modelId);
    if (path === null || !existsSync(path)) return { ok: false, code: 'E_MICRO_NOT_FOUND', message: '没有可删的包' };
    try {
      renameSync(path, `${path}.deleted`);
    } catch (error) {
      return { ok: false, code: 'E_MICRO_DELETE_FAILED', message: `删包失败：${error?.message ?? error}` };
    }
    return { ok: true };
  }

  /** 目录里已有的包（诊断面用：面板要能说「一共有几份」）。 */
  function list() {
    if (!existsSync(root)) return { ok: true, root, packs: [] };
    const packs = [];
    for (const name of readdirSync(root)) {
      if (!name.endsWith(PACK_SUFFIX)) continue;
      const path = join(root, name);
      let pack = null;
      try {
        pack = normalizeMicroMotionPack(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        pack = null;
      }
      packs.push({
        file: name,
        ok: pack !== null,
        model: pack?.model ?? '',
        name: pack?.name ?? '',
        gestures: pack?.gestures.length ?? 0,
        generatedAt: pack?.generatedAt ?? 0,
      });
    }
    packs.sort((left, right) => right.generatedAt - left.generatedAt);
    return { ok: true, root, packs };
  }

  return { root, packPathFor, load, save, remove, list, now };
}

/** 包里那条「生成于」写给人看的时间（面板与 status 用）。 */
export function describeMicroMotionTime(value) {
  const time = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (time <= 0) return '时间未知';
  const date = new Date(time);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export { MICRO_MOTION_VERSION };
