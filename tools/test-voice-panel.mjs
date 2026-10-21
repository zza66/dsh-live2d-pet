/**
 * 门禁：面板「语音包」一节（源码级）。
 *
 * 为什么是源码级而不是运行时：这一节的逻辑几乎全是「请求哪个 URL、把返回值绑到哪」，
 * 而插件是从 DSH 的 Slot 挂进真实页面的，Node 里没有那个宿主。能验证的只有两件事：
 *   · **接线**：它真的有去 `/voices`、真的有把 `pack` 与 `clip` 都 encode 上去；
 *   · **顺序**：试听必须先把通道里排队的 AI 台词掐掉再播，否则症状是
 *     「点了没反应，几秒后突然念起另一句」。
 *
 * 每条关键判据都带一个**反证**：把源码里那一行改坏，同一条判据必须变假。
 * 只断言「字符串出现了」的门禁在重构后照样全绿，那种绿没有价值。
 *
 * 用法：node tools/test-voice-panel.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginPath = resolve(here, '..', 'dsh-live2d-pet', 'src', 'client', 'plugin.ts');
const speechPath = resolve(here, '..', 'dsh-live2d-pet', 'src', 'client', 'speech.ts');

const plugin = readFileSync(pluginPath, 'utf8');
const speech = readFileSync(speechPath, 'utf8');

let passed = 0;
let failed = 0;

function report(ok, label, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === '' ? '' : `  → ${detail}`}`);
  }
}

function check(label, value, detail = '') {
  report(value === true, label, detail);
}

/** 从 `start` 那次出现往后取 `len` 个字符，用来把判据钉在一个局部。 */
function sliceFrom(source, needle, len = 600) {
  const at = source.indexOf(needle);
  if (at < 0) return '';
  return source.slice(at, at + len);
}

/* ── [1] 列表：请求哪一个 URL ─────────────────────────────────────────── */
console.log('[1] 列语音包');

const fetchVoices = sliceFrom(plugin, 'async function fetchVoices', 400);
check('有 fetchVoices()', fetchVoices !== '');
check('它打的是 /voices', fetchVoices.includes('/voices'), fetchVoices.slice(0, 80));
check('★ 关掉 HTTP 缓存（现扫磁盘才有意义）', fetchVoices.includes("cache: 'no-store'"));
check('返回前过一遍 normaliseVoiceList()', fetchVoices.includes('normaliseVoiceList('));

/* ── [2] 取一条：两个参数都必须编码 ───────────────────────────────────── */
console.log('\n[2] 取一条语音');

const fetchClip = sliceFrom(plugin, 'async function fetchVoiceClip', 700);
check('有 fetchVoiceClip()', fetchClip !== '');
check('打的是 /voice', fetchClip.includes('/voice?'));
check('★ pack 参数 encodeURIComponent（包目录名可以是中文）',
  /pack=\$\{encodeURIComponent\(pack\)\}/.test(fetchClip), fetchClip.slice(0, 200));
check('★ clip 参数 encodeURIComponent（id 里可以有 . 与 -）',
  /clip=\$\{encodeURIComponent\(clipId\)\}/.test(fetchClip), fetchClip.slice(0, 200));
check('非 2xx 时抛出带 code 的错误，而不是返回空音频',
  fetchClip.includes('throw new Error(') && fetchClip.includes('data.code'));

/* ── [3] 试听：先掐通道，再播 ─────────────────────────────────────────── */
console.log('\n[3] 试听');

const audition = sliceFrom(plugin, 'async function auditionVoice', 900);
check('有 auditionVoice()', audition !== '');
const stopAt = audition.indexOf('stopAll()');
const playAt = audition.indexOf('playBase64(');
check('★ 先 stopAll() 再 playBase64()（顺序反了会「点一条播另一条」）',
  stopAt >= 0 && playAt >= 0 && stopAt < playAt, `stopAll@${stopAt} play@${playAt}`);
check('★ 播放时声明音源是 voice（否则面板写着 Edge-TTS）',
  audition.includes("{ adapterId: 'voice' }"), audition.slice(0, 200));
check('字幕用回包里的 text（本地录音也有字幕）', audition.includes('reply.clip.text'));

/* ── [4] 面板：入口与折叠 ─────────────────────────────────────────────── */
console.log('\n[4] 面板');

const section = sliceFrom(plugin, 'function VoiceSection()', 6000);
check('有 VoiceSection()', section !== '');
check('★ 它被挂进卡片里（h(VoiceSection, {})）', plugin.includes('h(VoiceSection, {})'));
check('★ 挂在参数绑定之后（同一块设置区，顺序固定）',
  plugin.indexOf('h(BindingsSection, {})') < plugin.indexOf('h(VoiceSection, {})'),
  `${plugin.indexOf('h(BindingsSection, {})')} vs ${plugin.indexOf('h(VoiceSection, {})')}`);
check('用原生 details/summary 折叠（不自己造折叠状态）',
  section.includes("'details'") && section.includes("'summary'"));
check('摘要行报出包数与条数', section.includes('包 ·') && section.includes('条'));
check('坏包也列出来（clipCount 照样显示）', section.includes('有错误'));
check('没有包时给出「怎么建」而不是空白', section.includes('还没有语音包'));
check('★ Host 还没重启的 404 与「你的包坏了」区分开',
  section.includes('Host 还是旧代码'));
check('试听按钮在取/播期间禁用（连点会互相掐）',
  /disabled:\s*playing !== ''/.test(section), 'disabled: playing !== ...');
check('一条语音一行，文字可省略（否则长台词撑宽卡片）',
  plugin.includes('.dsh-l2d-cliptext') && plugin.includes('text-overflow: ellipsis'));
check('★ 刷新按钮真的重新拉一次列表', section.includes('onClick: () => void load()'));

/* ── [5] 音源名字：不许再写死 Edge-TTS ───────────────────────────────── */
console.log('\n[5] 音源名字');

check('speech.ts 导出了 engineLabel()', /export function engineLabel\(/.test(speech));
/*
 * 判据只看 describeSpeechState 的**函数体**，不看整个文件：
 * 文件里还有注释在引用旧写法（「以前这里是写死的 …」），拿全文去断言会永远为假。
 */
const describeBody = (() => {
  const at = speech.indexOf('export function describeSpeechState');
  if (at < 0) return '';
  const end = speech.indexOf('\n}', at);
  return end < 0 ? speech.slice(at) : speech.slice(at, end);
})();
check('★ describeSpeechState 走 engineLabel 而不是写死的三元',
  describeBody.includes('engineLabel(state.adapterId)') && !describeBody.includes("'Edge-TTS'"),
  describeBody.slice(0, 120));
check("engineLabel 认识 'voice'", /adapterId === 'voice'\)\s*return '语音包'/.test(speech));
check('playBase64 接受 options.adapterId', speech.includes('options?: { adapterId?: string }'));

/* ── [6] 反证：把关键那行改坏，判据必须变假 ───────────────────────────── */
console.log('\n[6] 反证');

function mutatedSwap(source, from, to) {
  if (!source.includes(from)) throw new Error(`反证锚点没找到：${from.slice(0, 60)}`);
  return source.split(from).join(to);
}

{
  const broken = mutatedSwap(plugin, 'getSpeechLane().stopAll();', '/* 掐掉通道这一步被删了 */');
  const mutated = sliceFrom(broken, 'async function auditionVoice', 900);
  report(!mutated.includes('stopAll()'), '反证 1：删掉 stopAll() 后「先掐通道」判据为假');
}

{
  const broken = mutatedSwap(plugin, "pack=${encodeURIComponent(pack)}", 'pack=${pack}');
  const mutated = sliceFrom(broken, 'async function fetchVoiceClip', 700);
  report(!/pack=\$\{encodeURIComponent\(pack\)\}/.test(mutated), '反证 2：不编码 pack 后编码判据为假');
}

{
  const broken = mutatedSwap(plugin, "{ adapterId: 'voice' }", '{}');
  const mutated = sliceFrom(broken, 'async function auditionVoice', 900);
  report(!mutated.includes("adapterId: 'voice'"), '反证 3：去掉音源声明后音源判据为假');
}

{
  const broken = mutatedSwap(speech, "adapterId === 'voice') return '语音包';", "adapterId === 'voice') return 'Edge-TTS';");
  report(!/adapterId === 'voice'\)\s*return '语音包'/.test(broken), '反证 4：把「语音包」改回 Edge-TTS 后判据为假');
}

{
  const broken = mutatedSwap(plugin, 'Host 还是旧代码', '重启试试');
  report(!sliceFrom(broken, 'function VoiceSection()', 6000).includes('Host 还是旧代码'),
    '反证 5：去掉「Host 还是旧代码」的提示后 404 判据为假');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} VOICE PANEL GATE —— ${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
