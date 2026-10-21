/**
 * Edge-TTS **适配器**门禁（P0 #6 → Host 生产代码）。
 *
 * 与 `probe-edge-tts.mjs` 的分工：
 *   - 探针回答「这条路还通不通」——它是一份独立于插件的协议取证。
 *   - 这个门禁回答「搬进 `lib/host/edge-tts.js` 之后还对不对」——它 import 的是
 *     **真实生产模块**，所以能抓到搬迁过程中引入的错（漏掉一个查询参数、
 *     缓存写坏、返回值形状变了）。
 *
 * 联网，所以只在 `verify-all.mjs --live` 里跑。
 *
 * 用法：node tools/test-edge-tts-adapter.mjs
 */

import { synthesize, cacheStats, DEFAULT_VOICE } from '../dsh-live2d-pet/lib/host/edge-tts.js';
/*
 * `MAX_TEXT_CHARS` 从**定义处**取，不从 `edge-tts.js` 取。
 *
 * 它原来有两个定义（`actions.js` 与 `edge-tts.js` 各一份 2000），这道门禁
 * 从 `edge-tts.js` 导入那一份，于是它验的是「TTS 这一层拒了超长文本」，
 * 却完全不知道工具那一层用的是不是同一个数 —— 而两者分叉时的症状正是
 * 「工具说已排队、然后一个字都没说出来」。改从定义处取之后，下面那条
 * 「超长文本被拒」才真正是在验「同一个上限」。
 */
import { MAX_TEXT_CHARS } from '../dsh-live2d-pet/lib/host/actions.js';

const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    console.log(`  ✘ ${label}${detail ? `  ${detail}` : ''}`);
    failures.push(label);
  }
}

const PHRASE = '口型测试，一二三四五。';

console.log('[1] 首次合成（命中网络）');
const first = await synthesize({ text: PHRASE, voice: DEFAULT_VOICE });
check('拿到音频字节', first.audio.length > 1000, `${first.audio.length} 字节`);
// 不做「首字节必须是 0xFF」这种断言：带 ID3 标签的 MP3 会以 'ID3' 开头，
// 而那是完全合法的、浏览器也照解不误。只要求同步字出现在前 1KB 内。
const syncAt = (() => {
  for (let i = 0; i < Math.min(first.audio.length - 1, 1024); i += 1) {
    if (first.audio[i] === 0xff && (first.audio[i + 1] & 0xe0) === 0xe0) return i;
  }
  return -1;
})();
check('是 MP3（前 1KB 内找到帧同步字）', syncAt >= 0, `偏移 ${syncAt}`);
check('拿到了词边界', Array.isArray(first.words) && first.words.length > 0, `${first.words?.length ?? 0} 条`);
check('时长估计合理', first.durationSeconds > 0.5 && first.durationSeconds < 20, `${first.durationSeconds.toFixed(3)}s`);
check('这次不是缓存命中', first.cached === false);

if (first.words?.length > 0) {
  const w = first.words[0];
  check(
    '词边界形状正确',
    typeof w.text === 'string' && w.text.length > 0 && w.offsetSeconds >= 0 && w.durationSeconds > 0,
    `${w.offsetSeconds.toFixed(3)}s +${w.durationSeconds.toFixed(3)}s ${JSON.stringify(w.text)}`,
  );
  const monotonic = first.words.every((item, i, arr) => i === 0 || item.offsetSeconds >= arr[i - 1].offsetSeconds);
  check('词边界按时间单调递增', monotonic);
  const last = first.words[first.words.length - 1];
  check(
    '最后一条词边界落在音频时长之内',
    last.offsetSeconds <= first.durationSeconds + 0.5,
    `${last.offsetSeconds.toFixed(3)}s vs ${first.durationSeconds.toFixed(3)}s`,
  );
}

console.log('\n[2] 第二次合成同样文本（应命中缓存，且不该再打网络）');
const t0 = Date.now();
const second = await synthesize({ text: PHRASE, voice: DEFAULT_VOICE });
const elapsed = Date.now() - t0;
check('标记为缓存命中', second.cached === true);
check('缓存很快（<50ms，说明确实没联网）', elapsed < 50, `${elapsed}ms`);
check('缓存返回的字节与首次一致', Buffer.compare(first.audio, second.audio) === 0);
check('缓存返回的词边界也一致', JSON.stringify(first.words) === JSON.stringify(second.words));

console.log('\n[3] 换文本不该命中缓存');
const other = await synthesize({ text: '换一句完全不同的话。', voice: DEFAULT_VOICE });
check('是新合成', other.cached === false);
check('字节数不同', other.audio.length !== first.audio.length, `${other.audio.length} vs ${first.audio.length}`);

console.log('\n[4] 参数校验（这些必须**不联网**就失败）');
const expectReject = async (label, promise, codeFragment) => {
  try {
    await promise;
    check(label, false, '竟然成功了，本该失败');
  } catch (error) {
    const message = String(error?.message ?? error);
    check(label, message.includes(codeFragment), message.slice(0, 110));
  }
};
await expectReject('空文本被拒', synthesize({ text: '   ' }), 'E_TTS_EMPTY_TEXT');
await expectReject('超长文本被拒', synthesize({ text: '好'.repeat(MAX_TEXT_CHARS + 1) }), 'E_TTS_TEXT_TOO_LONG');

console.log('\n[5] 缓存统计');
const stats = cacheStats();
check('缓存里有 2 条（同一句两次 + 另一句）', stats.entries === 2, JSON.stringify(stats));
check('缓存没有超过上限', stats.entries <= stats.limit);

console.log('');
if (failures.length === 0) {
  console.log('[6] EDGE-TTS ADAPTER GATE PASSED');
} else {
  console.log(`[x] EDGE-TTS ADAPTER GATE FAILED：${failures.length} 项未通过`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exitCode = 1;
}
