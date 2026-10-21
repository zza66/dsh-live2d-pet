/**
 * 声音功能的可见范围 —— **一个临时开关，不是架构**。
 *
 * 现在的面板上「换嗓子」有三条路并存：
 *   1. 预录台词包（`VoiceSection`，录好的固定句子，连引擎都不用）
 *   2. 零样本音色包（包里只有参考音 + 逐字文本）
 *   3. 带训练权重的音色包（包里还有 SoVITS + GPT 两份权重）
 *
 * 用户的原话是「有关音色的功能太过杂乱了，先只留下权重包的功能，把其他两个隐藏
 * （有关代码先不删除，等到最后再确定）」。所以：
 *
 *   - **只改这里**就能决定显示哪几种，`plugin.ts` 里不写死任何条件；
 *   - 代码一个都不删：`VoiceSection`、零样本包的渲染、Host 的 `/voices` 与
 *     `/tts/packs` 全都留着，只是没有入口；
 *   - 打开开关就能原样回来 —— 那时真正要决定的不是「留哪个」，而是「怎么让三条路
 *     在界面上不打架」，所以这里刻意做成**三个独立布尔**，而不是一个「模式」枚举。
 *
 * 被隐藏**不等于失效**：一个零样本音色包如果已经在 settings 里生效，它说的话仍然
 * 按那段参考音合成。宁可难看，也不能让用户看到的与机器里跑的不一致 ——
 * 于是 `scopePacks()` 会让**正在生效**的包无论如何都留在列表里（否则关不掉）。
 */
export const VOICE_SCOPE = Object.freeze({
  /** 带训练权重的音色包（现在唯一的正式入口）。 */
  weightPacks: true,
  /** 只有参考音的零样本包。 */
  referencePacks: false,
  /** 预录台词包（面板里那一节「语音包」）。 */
  presetClips: false,
});

export type VoiceScope = typeof VOICE_SCOPE;

/** 这个包由哪一种开关管：有权重段归 `weightPacks`，否则归 `referencePacks`。 */
export function packScopeKey(pack: { weights?: unknown }): 'weightPacks' | 'referencePacks' {
  return pack.weights === null || pack.weights === undefined ? 'referencePacks' : 'weightPacks';
}

/** 按开关判断一个包该不该出现在列表里（**不看**它是否正在生效）。 */
export function packVisible(pack: { weights?: unknown }, scope: VoiceScope = VOICE_SCOPE): boolean {
  return scope[packScopeKey(pack)] === true;
}

export interface ScopedPacks<T> {
  /** 要渲染的包，保持原顺序。 */
  shown: T[];
  /** 其中「被隐藏、但因为正在生效而仍然显示」的那些（面板要单独说一句）。 */
  activeWhileHidden: T[];
  /** 被隐藏掉的个数（不含 activeWhileHidden）。 */
  hiddenCount: number;
}

/**
 * 把清单切成「显示 / 隐藏」。
 *
 * 正在生效的包**永远显示**：隐藏它等于让用户没法取消，而只能去改 settings.json。
 * 这类包会被单独标出来（`activeWhileHidden`），因为它的行为与权重包不同 ——
 * 取消它之后引擎里可能还跑着换过的模型。
 */
export function scopePacks<T extends { weights?: unknown; active?: boolean }>(
  packs: readonly T[],
  scope: VoiceScope = VOICE_SCOPE,
): ScopedPacks<T> {
  const shown: T[] = [];
  const activeWhileHidden: T[] = [];
  let hiddenCount = 0;
  for (const pack of packs) {
    if (packVisible(pack, scope)) {
      shown.push(pack);
      continue;
    }
    if (pack.active === true) {
      shown.push(pack);
      activeWhileHidden.push(pack);
      continue;
    }
    hiddenCount += 1;
  }
  return { shown, activeWhileHidden, hiddenCount };
}
