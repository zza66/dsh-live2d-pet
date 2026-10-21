/**
 * settings.ts — 口型增益与字幕的**纯逻辑**（方案文档 §5 P2 交付物、§2 的配置表）。
 *
 * ★ 这个文件不许碰 DOM、不许碰 React、不许发请求、不许读 localStorage。
 *   所有副作用（读写存储、画界面）都在 `plugin.ts` 里，这里只回答两个问题：
 *     「用户存的这坨东西，应该被理解成什么设置？」
 *     「给定当前播放状态，字幕该显示什么？」
 *
 * 为什么要把这些判断从界面里挤出来：这个项目的门禁（`tools/*.mjs`）跑在 Node 里，
 * 碰不到 DOM。留在 `plugin.ts` 里的判断**永远不可能被断言**，而它们恰好是最容易
 * 写错的部分 —— 用户存了个 `"abc"`、存了个 `-1`、存了半截 JSON，界面不该因此变空。
 *
 * 配置项对应方案文档 §2 的 `lipSync.gain` 与 `subtitle.enabled`。
 * `lipSync.lookaheadMs` 刻意**没有**实现：它存在的意义是补偿「WordBoundary 的
 * Offset 相对未压缩流」那个系统性超前，而我们的口型走的是解码后的包络（同一个
 * 时钟，不超前），字幕那边残留的只有 10–30ms 输出延迟，远在 80ms 容忍以内。
 * 加一个我们无法标定的旋钮，只会让「它到底准不准」变成无法回答的问题。
 */

/** 口型增益的允许范围。下限不是 0：0 等于「关掉口型」，那是另一个功能（不是这一档）。 */
export const MIN_LIP_GAIN = 0.2;
export const MAX_LIP_GAIN = 2;
/** 滑块的步进。1.0 是「不放大也不缩小」。 */
export const LIP_GAIN_STEP = 0.05;

export interface PetSettings {
  /** 口型张开度的乘数。1 = 原样，>1 更夸张，<1 更含蓄。 */
  lipGain: number;
  /** 是否显示字幕。 */
  subtitles: boolean;
}

export const DEFAULT_SETTINGS: PetSettings = Object.freeze({
  lipGain: 1,
  subtitles: true,
});

/** localStorage 的键。与 `dsh-live2d-pet.model` / `.collapsed` 同一套命名。 */
export const SETTINGS_KEY = 'dsh-live2d-pet.settings';

function clampGain(value: number): number {
  if (!isFinite(value)) return DEFAULT_SETTINGS.lipGain;
  if (value < MIN_LIP_GAIN) return MIN_LIP_GAIN;
  if (value > MAX_LIP_GAIN) return MAX_LIP_GAIN;
  return value;
}

/**
 * 把任意一坨东西变成一份可用的设置。**永不抛。**
 *
 * 会走到这里的东西包括：用户手改过的 localStorage、上一个版本写的旧格式、
 * 半截 JSON（浏览器被强杀时正好写到一半）、以及 `null`。
 * 每一种的正确答案都是「用默认值补上缺的那部分」，而不是「报错然后什么都不显示」。
 */
export function normalizeSettings(raw: unknown): PetSettings {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  // 数字也可能以字符串形式存进来（JSON 里 `"1.2"` 完全合法）。
  const rawGain = typeof source.lipGain === 'string' ? Number(source.lipGain) : source.lipGain;
  const lipGain = typeof rawGain === 'number' ? clampGain(rawGain) : DEFAULT_SETTINGS.lipGain;

  const subtitles = typeof source.subtitles === 'boolean' ? source.subtitles : DEFAULT_SETTINGS.subtitles;

  return { lipGain, subtitles };
}

/** 序列化成 localStorage 能存的字符串。字段名与 `PetSettings` 一致，方便肉眼核对。 */
export function serializeSettings(settings: PetSettings): string {
  const clean = normalizeSettings(settings);
  return JSON.stringify({ lipGain: clean.lipGain, subtitles: clean.subtitles });
}

/**
 * 从存储里读。`storage` 传进来而不是直接用 `localStorage`，是为了让门禁能塞一个假的。
 * 任何异常（隐私模式下 `localStorage` 会抛、值不是 JSON）都退回默认值。
 */
export function readSettings(storage: StorageLike | null | undefined): PetSettings {
  if (storage === null || storage === undefined) return { ...DEFAULT_SETTINGS };
  try {
    const text = storage.getItem(SETTINGS_KEY);
    if (typeof text !== 'string' || text === '') return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 写回存储。写失败不影响返回值 —— 设置在这一会话里仍然有效。
 *
 * ★ 这是「改几个字段」而不是「替换整份」：它会先读出存储里的现值再叠加 `patch`。
 *   写成「用 patch 覆盖整份」的话，`writeSettings(storage, { subtitles: false })`
 *   会**悄悄把用户调好的口型增益打回 1.0** —— 而口型增益是用户拖滑块调出来的，
 *   他下次说话时发现幅度回到默认，只会以为「这个设置存不住」。
 */
export function writeSettings(storage: StorageLike | null | undefined, patch: Partial<PetSettings>): PetSettings {
  const current = readSettings(storage);
  const next = normalizeSettings({ ...current, ...patch });
  if (storage !== null && storage !== undefined) {
    try {
      storage.setItem(SETTINGS_KEY, serializeSettings(next));
    } catch {
      /* 隐私模式 / 配额满：忽略，设置本次会话内仍然生效 */
    }
  }
  return next;
}

/** 只用到 `getItem` / `setItem`，所以门禁里一个对象字面量就能当存储用。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/* ────────────────────────── 口型增益 ────────────────────────── */

/**
 * 把包络算出来的张开度乘上增益。
 *
 * **出口一定夹在 [0,1] 里**：`setMouthOverride` 自己也会夹，但那属于「下游兜底」，
 * 不是「这里没问题」的证明。增益 2.0 时几乎每一帧都会超过 1，如果不在这一层夹，
 * 面板上显示的张开度会是一串 1.97 这种数字，用户会以为坏了。
 */
export function applyLipGain(openness: unknown, gain: unknown): number {
  const value = typeof openness === 'number' && isFinite(openness) ? openness : 0;
  const factor = typeof gain === 'number' ? clampGain(gain) : DEFAULT_SETTINGS.lipGain;
  const scaled = value * factor;
  if (!isFinite(scaled)) return 0;
  if (scaled < 0) return 0;
  if (scaled > 1) return 1;
  return scaled;
}

/** 滑块旁边那行字。要说清「往哪边是更大」，否则用户得试两次才知道。 */
export function describeLipGain(gain: unknown): string {
  const value = typeof gain === 'number' ? clampGain(gain) : DEFAULT_SETTINGS.lipGain;
  const percent = Math.round(value * 100);
  if (Math.abs(value - 1) < 0.001) return `口型幅度 ${percent}%（默认）`;
  return value > 1 ? `口型幅度 ${percent}%（比默认大）` : `口型幅度 ${percent}%（比默认小）`;
}

/* ────────────────────────── 字幕 ────────────────────────── */

/** 字幕需要的东西。写成结构类型而不是 import `SpeechPlayerState`：见文件头。 */
export interface SubtitleSource {
  speaking: boolean;
  text: string | null;
  /** 当前正在念第几个词，来自 `SpeechPlayer.activeWordIndex()`。 */
  activeWordIndex: number;
  /** 这一句的词边界（可能为空 —— 降级路径就没有）。 */
  words: Array<{ text: string }>;
}

export interface SubtitleView {
  /** 是否要显示。 */
  visible: boolean;
  /** 显示的整句文本。 */
  text: string;
  /**
   * 高亮区间 `[from, to)`，`text.slice(from, to)` 就是当前这个词。
   * `from < 0` 表示「没有正在念的词」，这时整句同色。
   */
  highlightFrom: number;
  highlightTo: number;
}

const HIDDEN: SubtitleView = Object.freeze({ visible: false, text: '', highlightFrom: -1, highlightTo: -1 });

/**
 * 算出这一刻字幕该长什么样。
 *
 * 两条刻意的克制：
 * 1. **不说话就立刻收起来**，不留「说完再多显示 1 秒」的尾巴。要留就得有一个
 *    计时器和一个时钟，而那一秒钟里字幕说的是她已经不说了的话 —— 桌宠是个小卡片，
 *    停留的字幕会挡住模型。
 * 2. **只在 `speaking` 时显示**。排队等播的那几句不显示：它们还没开始，显示出来
 *    会让人以为已经在说了（而且队列是「取走即清空」的，下一句可能被新的打断）。
 *
 * 高亮靠 `highlightRange()` 在整句文本里**按顺序**找第 n 个词。Edge-TTS 的
 * WordBoundary 不带字符下标，所以只能这样找；这个取舍写在 `highlightRange` 里。
 */
export function subtitleView(source: SubtitleSource | null | undefined, settings: PetSettings): SubtitleView {
  if (!settings.subtitles) return HIDDEN;
  if (source === null || source === undefined) return HIDDEN;
  if (source.speaking !== true) return HIDDEN;

  const text = typeof source.text === 'string' ? source.text : '';
  if (text === '') return HIDDEN;

  const index = typeof source.activeWordIndex === 'number' ? source.activeWordIndex : -1;
  const words = Array.isArray(source.words) ? source.words : [];
  const range = highlightRange(text, words, index);

  return { visible: true, text, highlightFrom: range[0], highlightTo: range[1] };
}

/**
 * 整句文本里第 `index` 个词的字符区间。
 *
 * 从光标往后找，**找到就推进光标**，这样「了」这种在一句里出现多次的词不会被
 * 反复定位到第一处。找不到就返回 `[-1, -1]`（整句同色）—— 这与「猜一个位置然后
 * 高亮错地方」相比，是明显更好的失败方式。
 *
 * 已知不完美：Edge-TTS 的词边界与原文不总是逐字相同（可能去掉标点、可能把
 * 「3.14」切成别的样子）。那时高亮会漏，但整句字幕仍然对。
 */
export function highlightRange(
  text: string,
  words: Array<{ text?: string }>,
  index: number,
): [number, number] {
  if (typeof text !== 'string' || text === '') return [-1, -1];
  if (!Array.isArray(words)) return [-1, -1];
  if (typeof index !== 'number' || !isFinite(index) || index < 0) return [-1, -1];

  /*
   * 下标超出词表就**不高亮**，而不是退回去高亮最后一个词。
   *
   * 正常路径下不会发生（`activeWordIndex()` 的值恒小于 `words.length`），但真发生时
   * 「高亮最后一个词」是个会被当成事实的猜测 —— 界面上那一块颜色说的是「就是这个词」，
   * 而我们其实不知道。找不到就说找不到。
   */
  if (index >= words.length) return [-1, -1];

  let cursor = 0;
  let found: [number, number] = [-1, -1];
  for (let i = 0; i <= index; i += 1) {
    const raw = words[i]?.text;
    const word = typeof raw === 'string' ? raw : '';
    if (word === '') {
      found = [-1, -1];
      continue;
    }
    const at = text.indexOf(word, cursor);
    if (at < 0) {
      found = [-1, -1];
      continue;
    }
    cursor = at + word.length;
    found = [at, cursor];
  }
  return found;
}

/**
 * 面板上那句「字幕」的状态文字（开关旁边）。
 *
 * 与 `subtitleView` 分开是因为两者回答不同问题：那个回答「画什么」，
 * 这个回答「为什么现在没有字幕」—— 用户关掉开关之后需要看见开关是关着的。
 */
export function describeSubtitles(settings: PetSettings, view: SubtitleView): string {
  if (!settings.subtitles) return '字幕已关闭';
  if (!view.visible) return '字幕开着（说话时才显示）';
  const total = view.highlightFrom >= 0 ? '正在跟读' : '整句显示';
  return `字幕开着 · ${total}`;
}
