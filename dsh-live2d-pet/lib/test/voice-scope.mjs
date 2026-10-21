// src/client/voice-scope.ts
var VOICE_SCOPE = Object.freeze({
  /** 带训练权重的音色包（现在唯一的正式入口）。 */
  weightPacks: true,
  /** 只有参考音的零样本包。 */
  referencePacks: false,
  /** 预录台词包（面板里那一节「语音包」）。 */
  presetClips: false
});
function packScopeKey(pack) {
  return pack.weights === null || pack.weights === void 0 ? "referencePacks" : "weightPacks";
}
function packVisible(pack, scope = VOICE_SCOPE) {
  return scope[packScopeKey(pack)] === true;
}
function scopePacks(packs, scope = VOICE_SCOPE) {
  const shown = [];
  const activeWhileHidden = [];
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
export {
  VOICE_SCOPE,
  packScopeKey,
  packVisible,
  scopePacks
};
