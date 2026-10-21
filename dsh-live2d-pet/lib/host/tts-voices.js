/**
 * tts-voices —— 「让桌宠换一种音色说话」的**纯策略**模块：音色清单、参数校验、设置归一化。
 *
 * 为什么需要它（用户原话 m25769）：
 *   > 我想要的效果是，让 tts 用另外一种音色说话，不是播放已有的语句。
 *
 *   在这之前 `voice` 是一条**只能由调用方给**的可选参数：`live2d_speak({voice})`
 *   传什么就用什么，没传就永远是 `zh-CN-XiaoxiaoNeural`。于是「换音色」这件事
 *   在插件里根本没有入口 —— 用户既看不见有哪些音色，也没地方存「我要用哪一个」。
 *   本模块补的就是这两件事的数据部分：**有哪些音色** + **用户选的那个存成什么形状**。
 *
 * ★ 硬约束：零 import、不碰任何 `node:` 内置模块。
 *   客户端 bundle 也会 import 它（面板要画那个下拉框），一旦有人在这里写
 *   `import fs`，客户端构建会当场失败。刻意选的失败方式同 `tts-adapters.js`。
 *
 * ★ 这个模块**不负责合成**，也不联网校验音色。
 *   清单里的 `id` 都是 Edge 朗读接口的 ShortName，但微软会调整后台可用列表 ——
 *   所以面板上的「试听」按钮才是唯一权威：**能不能用，点一下就知道**。
 *   写死一份「保证可用」的名单只会让某天突然失败时没人知道为什么。
 */

/**
 * 一个可选音色。
 *
 * @typedef {object} VoicePreset
 * @property {string} id      Edge 朗读接口的 ShortName，直接发给 Host。
 * @property {string} label   给人看的名字（面板下拉里就是这一列）。
 * @property {string} locale  语言地区，用来分组与排序。
 * @property {'female'|'male'|'neutral'} gender
 * @property {string} note    一句话说明「听起来像什么」，不写技术细节。
 */

/** @type {ReadonlyArray<VoicePreset>} */
export const VOICE_PRESETS = Object.freeze([
  Object.freeze({ id: 'zh-CN-XiaoxiaoNeural', label: '晓晓', locale: 'zh-CN', gender: 'female', note: '默认音色，自然温和，适合日常对话' }),
  Object.freeze({ id: 'zh-CN-XiaoyiNeural', label: '晓伊', locale: 'zh-CN', gender: 'female', note: '年轻活泼，略带撒娇感' }),
  Object.freeze({ id: 'zh-CN-XiaochenNeural', label: '晓辰', locale: 'zh-CN', gender: 'female', note: '放松随性，像在聊天' }),
  Object.freeze({ id: 'zh-CN-XiaohanNeural', label: '晓涵', locale: 'zh-CN', gender: 'female', note: '温柔克制，情绪起伏小' }),
  Object.freeze({ id: 'zh-CN-XiaomengNeural', label: '晓梦', locale: 'zh-CN', gender: 'female', note: '甜，偏少女' }),
  Object.freeze({ id: 'zh-CN-XiaomoNeural', label: '晓墨', locale: 'zh-CN', gender: 'female', note: '沉稳清晰，适合叙述' }),
  Object.freeze({ id: 'zh-CN-XiaoqiuNeural', label: '晓秋', locale: 'zh-CN', gender: 'female', note: '从容偏成熟' }),
  Object.freeze({ id: 'zh-CN-XiaoruiNeural', label: '晓睿', locale: 'zh-CN', gender: 'female', note: '成熟稳重' }),
  Object.freeze({ id: 'zh-CN-XiaoshuangNeural', label: '晓双', locale: 'zh-CN', gender: 'female', note: '童声，偏小' }),
  Object.freeze({ id: 'zh-CN-XiaoxuanNeural', label: '晓萱', locale: 'zh-CN', gender: 'female', note: '干练自信' }),
  Object.freeze({ id: 'zh-CN-XiaoyanNeural', label: '晓颜', locale: 'zh-CN', gender: 'female', note: '亲切自然' }),
  Object.freeze({ id: 'zh-CN-XiaoyouNeural', label: '晓悠', locale: 'zh-CN', gender: 'female', note: '更小的童声' }),
  Object.freeze({ id: 'zh-CN-XiaozhenNeural', label: '晓甄', locale: 'zh-CN', gender: 'female', note: '利落' }),
  Object.freeze({ id: 'zh-CN-YunxiNeural', label: '云希', locale: 'zh-CN', gender: 'male', note: '年轻的男声，偏清爽' }),
  Object.freeze({ id: 'zh-CN-YunyangNeural', label: '云扬', locale: 'zh-CN', gender: 'male', note: '播音腔，适合解说' }),
  Object.freeze({ id: 'zh-CN-YunjianNeural', label: '云健', locale: 'zh-CN', gender: 'male', note: '浑厚有力，适合赛事解说' }),
  Object.freeze({ id: 'zh-CN-YunxiaNeural', label: '云夏', locale: 'zh-CN', gender: 'male', note: '少年音' }),
  Object.freeze({ id: 'zh-CN-YunyeNeural', label: '云野', locale: 'zh-CN', gender: 'male', note: '沉稳成熟' }),
  Object.freeze({ id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（东北话）', locale: 'zh-CN', gender: 'female', note: '东北方言' }),
  Object.freeze({ id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮（陕西话）', locale: 'zh-CN', gender: 'female', note: '陕西方言' }),
  Object.freeze({ id: 'zh-TW-HsiaoChenNeural', label: '曉臻（台湾）', locale: 'zh-TW', gender: 'female', note: '台湾腔' }),
  Object.freeze({ id: 'zh-HK-HiuMaanNeural', label: '曉曼（粤语）', locale: 'zh-HK', gender: 'female', note: '粤语' }),
  Object.freeze({ id: 'en-US-AriaNeural', label: 'Aria（美音）', locale: 'en-US', gender: 'female', note: '英文女声' }),
  Object.freeze({ id: 'en-US-GuyNeural', label: 'Guy（美音）', locale: 'en-US', gender: 'male', note: '英文男声' }),
]);

/** 没有设置过时用哪个：与 `edge-tts.js` 的 `DEFAULT_VOICE` 保持一致。 */
export const DEFAULT_VOICE_ID = 'zh-CN-XiaoxiaoNeural';

/** 语速的默认值，与 `edge-tts.js` 的 `DEFAULT_RATE` 一致。 */
export const DEFAULT_RATE = '+0%';

/**
 * 合成器目前认识的引擎。
 *
 * `edge` 是内置的；`custom` 是**留给用户自己的 TTS 服务**的接口位
 * （本地 GPT-SoVITS / CosyVoice 之类，详见 `custom-tts.js` 头部的协议说明）。
 * 这里先把它登记出来，是为了让设置文件里那个 `ttsEngine` 字段从一开始就
 * 有一个合法值域 —— 以后加引擎只改这张表，不改别处。
 */
export const TTS_ENGINES = Object.freeze([
  Object.freeze({ id: 'edge', label: 'Edge-TTS', note: '内置，联网，零配置' }),
  Object.freeze({ id: 'custom', label: '自定义 TTS 服务', note: '你自己跑的 HTTP 服务，地址写在 ttsEndpoint' }),
]);

export const DEFAULT_ENGINE_ID = 'edge';

/** 语速能开多大：超过 ±100% 基本听不清，也不该写进配置。 */
export const MAX_RATE_PERCENT = 100;

/**
 * 这是一个形状像 ShortName 的音色 id 吗？
 *
 * **只做形状检查，不查在线可用性**（那要联网，且随时会变）。放进来的是一个
 * 兜底通道：清单里没有的音色允许手写，写错了由合成器报 `E_TTS_BAD_VOICE`，
 * 面板的「试听」会当场听见失败。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isVoiceShortName(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '') return false;
  // zh-CN-XiaoxiaoNeural / zh-CN-liaoning-XiaobeiNeural / en-US-AriaNeural
  //
  // 正则本身就是长度上限（名字部分最多 41 字符，整串最长 61），所以**不必**再写一条
  // `text.length > 64` —— 那条永远为假。第一版真写了，被门禁的反证 ① 当场揪出来，
  // 教训与 `voice-pack.js` 的 `sanitizeClipId` 那次一样：反证会告诉你哪条检查没有牙。
  return /^[A-Za-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z]{2,10})?-[A-Za-z][A-Za-z0-9]{0,40}$/.test(text);
}

/**
 * 按 id 找清单里的音色。
 *
 * @param {unknown} id
 * @returns {VoicePreset | null}
 */
export function voicePresetById(id) {
  if (typeof id !== 'string') return null;
  for (const preset of VOICE_PRESETS) {
    if (preset.id === id) return preset;
  }
  return null;
}

/**
 * 给人看的音色名：清单里有就「晓晓（zh-CN）」，没有就原样返回 id。
 *
 * 为什么不返回「未知音色」：用户手写了一个清单外的 id 并用成功了，
 * 面板上再把它遮成「未知」就是在否认他自己的配置。
 *
 * @param {unknown} id
 * @returns {string}
 */
export function describeVoice(id) {
  if (typeof id !== 'string' || id.trim() === '') return '';
  const preset = voicePresetById(id.trim());
  if (preset === null) return id.trim();
  return `${preset.label}（${preset.locale}）`;
}

/**
 * 语速归一化：接受 `+15%` / `-10%` / `15%` / `0`，一律返回 `+15%` 这种形状。
 *
 * @param {unknown} value
 * @returns {{ ok: true, value: string, percent: number } | { ok: false, code: string, detail: string }}
 */
export function normalizeRate(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: DEFAULT_RATE, percent: 0 };
  }
  const text = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : '');
  if (text === '') return { ok: true, value: DEFAULT_RATE, percent: 0 };

  const match = /^([+-]?)(\d{1,4})%?$/.exec(text);
  if (match === null) {
    return { ok: false, code: 'E_TTS_BAD_RATE', detail: `语速要写成 '+15%' 或 '-10%' 这种形状，收到的是 ${JSON.stringify(value)}` };
  }
  const percent = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  if (!Number.isFinite(percent) || percent > MAX_RATE_PERCENT || percent < -MAX_RATE_PERCENT) {
    return { ok: false, code: 'E_TTS_BAD_RATE', detail: `语速要在 ±${MAX_RATE_PERCENT}% 之内，收到的是 ${JSON.stringify(value)}` };
  }
  return { ok: true, value: `${percent >= 0 ? '+' : '-'}${Math.abs(percent)}%`, percent };
}

/**
 * 按 id 找引擎。
 *
 * @param {unknown} id
 * @returns {{id: string, label: string, note: string} | null}
 */
export function engineById(id) {
  if (typeof id !== 'string') return null;
  for (const engine of TTS_ENGINES) {
    if (engine.id === id) return engine;
  }
  return null;
}

/**
 * 把 `settings.json` 里那三个扁平键收成一份**永远可用**的设置。
 *
 * 键名用扁平的 `ttsVoice` / `ttsRate` / `ttsEngine` / `ttsEndpoint`，与这个文件里
 * 已有的 `modelsRoot` / `voicesRoot` / `emotionBindings` 一个风格 —— 嵌套对象会让
 * `applySettingsPatch()` 的浅合并在「用户手写了一半的 tts 对象」上把另一半抹掉。
 *
 * 坏值**不抛错**，退回默认值并在 `notes` 里留一句：面板与 `/speak` 都要能读到
 * 一份可用的设置，否则改坏一个字符就等于桌宠不会说话。
 *
 * @param {Record<string, unknown> | null | undefined} raw settings.json 的内容
 * @returns {{ voice: string, voiceSource: 'settings'|'default', rate: string, engine: string, endpoint: string, voicePack: string, localRoot: string, localConfig: string, notes: string[] }}
 */
export function normalizeTtsSettings(raw) {
  const notes = [];
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  let voice = DEFAULT_VOICE_ID;
  let voiceSource = 'default';
  if (source.ttsVoice !== undefined && source.ttsVoice !== null && source.ttsVoice !== '') {
    if (isVoiceShortName(source.ttsVoice)) {
      voice = String(source.ttsVoice).trim();
      voiceSource = 'settings';
    } else {
      notes.push(`ttsVoice 不是合法的音色 id（${JSON.stringify(source.ttsVoice)}），已忽略`);
    }
  }

  const rateResult = normalizeRate(source.ttsRate);
  const rate = rateResult.ok ? rateResult.value : DEFAULT_RATE;
  if (!rateResult.ok) notes.push(`ttsRate 不合法（${rateResult.detail}），已忽略`);

  let engine = DEFAULT_ENGINE_ID;
  if (source.ttsEngine !== undefined && source.ttsEngine !== null && source.ttsEngine !== '') {
    if (engineById(source.ttsEngine) !== null) engine = String(source.ttsEngine);
    else notes.push(`ttsEngine 不是已知引擎（${JSON.stringify(source.ttsEngine)}），已忽略`);
  }

  const endpoint = typeof source.ttsEndpoint === 'string' ? source.ttsEndpoint.trim() : '';
  if (engine === 'custom' && endpoint === '') {
    notes.push('ttsEngine 是 custom 但没有配 ttsEndpoint，实际仍会用 Edge-TTS');
  }

  /*
   * 音色包（参考音 registry）的 id。
   *
   * 与 `ttsVoice` 是两个不同的概念，不能合并：
   *   - `ttsVoice` 是**引擎自己的**音色名（Edge 的 ShortName）；
   *   - `ttsVoicePack` 是**我们这边**的一个参考音包，只在自定义引擎下有意义，
   *     它最终被翻译成 `voiceProfile` 随请求发给适配层。
   *
   * 形状校验放在这里而不是路由里，理由与 `ttsVoice` 相同：读配置要宽容（坏值
   * 退回「不用包」并留一句 notes），否则一个字写错桌宠就不出声了。
   */
  let voicePack = '';
  if (source.ttsVoicePack !== undefined && source.ttsVoicePack !== null && source.ttsVoicePack !== '') {
    const raw = String(source.ttsVoicePack).trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw)) voicePack = raw;
    else notes.push(`ttsVoicePack 不是合法的音色包 id（${JSON.stringify(source.ttsVoicePack)}），已忽略`);
  }

  /*
   * 本地 TTS「用哪份」（§13.28）。
   *
   * 为什么必须落在 settings.json，而不是面板里的一份 state：点「检测本机」是去问
   * Host「你认得哪几份安装」，Host 只能回答**探测结果**；如果面板把它的 `selected`
   * 当成当前选的权威，用户挑的「v5 + tts_infer_dafei-v5.yaml」就会被探测的默认值
   * （第一处安装 + tts_infer.yaml）顶掉 —— 那正是真机上看到的现象。
   *
   * 校验放在这里而不是路由：读配置要宽容（坏值退回「没选」并留一句 notes），
   * 否则手改一个字，启动按钮就会去点一份不存在的目录。
   */
  let localRoot = '';
  if (source.ttsLocalRoot !== undefined && source.ttsLocalRoot !== null && source.ttsLocalRoot !== '') {
    const text = typeof source.ttsLocalRoot === 'string' ? source.ttsLocalRoot.trim() : '';
    if (text !== '' && text.length <= 512) localRoot = text;
    else notes.push(`ttsLocalRoot 不是合法的目录路径（${JSON.stringify(source.ttsLocalRoot)}），已忽略`);
  }

  let localConfig = '';
  if (source.ttsLocalConfig !== undefined && source.ttsLocalConfig !== null && source.ttsLocalConfig !== '') {
    const text = typeof source.ttsLocalConfig === 'string' ? source.ttsLocalConfig.trim() : '';
    /* 只收文件名：这一段会被拼进 `GPT_SoVITS\configs\<name>`，路径分隔符一律不收。 */
    if (/^[^\\/:*?"<>|]{1,64}$/.test(text)) localConfig = text;
    else notes.push(`ttsLocalConfig 只能是 yaml 文件名（${JSON.stringify(source.ttsLocalConfig)}），已忽略`);
  }

  return {
    voice, voiceSource, rate, engine, endpoint, voicePack, localRoot, localConfig, notes,
  };
}

/**
 * 面板要画的那个下拉框的内容：清单 + 「当前值不在清单里」时的补位项。
 *
 * 补位项不能省：用户手写了 `zh-CN-XiaozhenNeural` 之外的新音色并存进了配置，
 * 下拉框如果不含它，下次打开面板就会显示成「晓晓」——**看起来像配置没保存成功**。
 *
 * @param {unknown} current
 * @returns {Array<{ id: string, label: string, locale: string, note: string, custom: boolean }>}
 */
export function voiceOptions(current) {
  /*
   * label 里必须带**性别**。
   *
   * 这个下拉框存在的唯一理由是「换一种声音」，而 23 个选项如果都写成
   * 「晓晓（zh-CN）」「云希（zh-CN）」，用户在拉开的列表里根本看不出
   * 哪几个是男声 —— 那等于把这件事留给他逐个试听。性别是这一屏唯一
   * 能区分「另一种声音」的字段，宁可占几个字符也要写出来。
   */
  const options = VOICE_PRESETS.map((preset) => ({
    id: preset.id,
    label: `${preset.label}（${preset.gender === 'male' ? '男声' : '女声'} · ${preset.locale}）`,
    locale: preset.locale,
    note: preset.note,
    custom: false,
  }));

  const text = typeof current === 'string' ? current.trim() : '';
  if (text !== '' && voicePresetById(text) === null) {
    options.unshift({ id: text, label: `${text}（手写）`, locale: '', note: '清单里没有这个音色，能不能用要点试听才知道', custom: true });
  }
  return options;
}
