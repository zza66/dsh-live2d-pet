#!/usr/bin/env node
/**
 * 门禁：**配置在设置页、卡片只负责「看她」**（§13.35）。
 *
 * ## 为什么需要这个文件
 *
 * 这件事没有一个会报错的失败方式：把导入块、滑块、绑定节从卡片里删掉之后，
 * 如果设置页那份没接上，页面**照样渲染**，只是「设置 → Live2D 桌宠」里空着、
 * 桌宠卡片上也没有 —— 用户看到的是「功能消失了」，而控制台一声不响。
 *
 * 反向也一样：只要有人图省事在卡片里再放一份 `h(VoiceToneSection, {})`，
 * 两棵树就会各有一份状态，改一边另一边不动，这种不同步比没有更糟。
 *
 * 所以这里断言的是**分工**，不是「某个组件存在」：
 *
 *   - 设置页那一份必须齐全（模型库 / 音色 / 绑定 / 口型字幕 / 运行状态）；
 *   - 卡片那一份必须**不在**（只留舞台、模型下拉、说话、微动作、指路）；
 *   - 两棵树之间唯一的那条同步通道（`MODEL_PREF_EVENT`）必须还在。
 *
 * ## 用法
 *
 *     node tools/test-settings-section.mjs     （离线：只读源码，无 DOM）
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', 'dsh-live2d-pet');
const pluginPath = resolve(packageRoot, 'src/client/plugin.ts');

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

/**
 * 去掉注释。注释里会「提到」组件名（解释为什么搬走），
 * 而这里断言的是**代码**里有没有 —— 不去注释会把说明文当成实现。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const raw = readFileSync(pluginPath, 'utf8');
const code = stripComments(raw);

function sliceFrom(startMarker, endMarker) {
  const start = code.indexOf(startMarker);
  if (start < 0) return '';
  const end = code.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? code.slice(start) : code.slice(start, end);
}

const overlay = sliceFrom('function Live2DOverlay', 'function BindingsSection');
const settings = sliceFrom('function Live2DSettings', 'function installStyles');
const library = sliceFrom('function SettingsModelLibrary', 'function Live2DSettings');

section('[1] 两棵树都在');
check('注册了 shell.overlay（桌宠卡片）', code.includes("slots.inject('shell.overlay'"));
check('注册了 settings.section（设置页）', code.includes("slots.inject('settings.section'"));
check('两处都带 order（框架要求）', /slots\.inject\('shell\.overlay'[\s\S]{0,400}?order:\s*60/.test(code)
  && /slots\.inject\('settings\.section'[\s\S]{0,400}?order:\s*45/.test(code));
check('切出了卡片那一段源码（切片非空）', overlay.length > 2000, `${overlay.length} 字符`);
check('切出了设置页那一段源码（切片非空）', settings.length > 400, `${settings.length} 字符`);

section('[2] 设置页承担配置');
check('模型库（导入 / 清单 / 体检）在设置页', settings.includes('h(SettingsModelLibrary, {})'));
check('音色在设置页', settings.includes('h(VoiceToneSection, {})'));
check('参数绑定在设置页', settings.includes('h(BindingsSection, {})'));
check('运行状态在设置页', settings.includes('h(StatusRows,'));
check('口型滑杆在设置页', settings.includes("id: 'dsh-l2d-gain'"));
check('字幕开关在设置页', settings.includes('说话时在气泡里显示台词'));
check('设置页用了 SettingsSection 分节', (settings.match(/h\(SettingsSection, \{/g) ?? []).length >= 2);
check('设置页根节点不套 .dsh-l2d-root（那是浮层的定位类）', !settings.includes("className: 'dsh-l2d-root'"));

section('[3] 模型库那一块真的能导入');
check('库组件里有上传调用', library.includes('uploadZip('));
check('库组件收 zip 与 rar', library.includes('.zip,.rar'));
check('库组件有拖放区', library.includes("className: 'dsh-l2d-drop'") || library.includes('dsh-l2d-drop'));
check('库组件渲染模型行', library.includes('dsh-l2d-modelline'));

section('[4] 卡片只剩「看她」');
check('卡片保留模型下拉（换着看）', overlay.includes("className: 'dsh-l2d-select'"));
check('卡片保留微动作（看效果 / 试演）', overlay.includes('h(MicroMotionSection, {})'));
check('卡片保留对话入口（§13.36 用对话节替换了「说一句」）', overlay.includes('h(PetChatSection, {})'));
check('对话节自己带输入框与发送键', code.includes("className: 'dsh-l2d-chat'")
  && code.includes("className: 'dsh-l2d-say'")
  && code.includes('sendChat(text)'));
check('卡片有指路那一句', overlay.includes('设置 → Live2D 桌宠'));
check('卡片里没有音色那一节', !overlay.includes('h(VoiceToneSection'));
check('卡片里没有参数绑定那一节', !overlay.includes('h(BindingsSection'));
check('卡片里没有运行状态', !overlay.includes('h(StatusRows'));
check('卡片里没有口型滑杆', !overlay.includes("id: 'dsh-l2d-gain'"));
check('卡片里没有上传调用', !overlay.includes('uploadZip('));
check('卡片里没有模型库组件', !overlay.includes('SettingsModelLibrary'));
check('卡片仍拦「文件拖到页面空白处」的默认行为', overlay.includes("document.addEventListener('drop', guard)"));

section('[5] 跨树同步（导入完自动切过去）');
check('writeModelPref 广播事件', /window\.dispatchEvent\(new CustomEvent\(MODEL_PREF_EVENT\)\)/.test(code));
check('事件常量只有一处定义', (code.match(/const MODEL_PREF_EVENT = /g) ?? []).length === 1);
check('设置页监听同一事件', /window\.addEventListener\(MODEL_PREF_EVENT/.test(library) || /window\.addEventListener\(MODEL_PREF_EVENT/.test(settings));

section('[6] CSS：设置页不钉在右下角');
/** 这个标题下唯一要判的事，抽出来给正向与反证共用（两条必须用同一个判据）。 */
const hasFixedPosition = (cssText) => /position:\s*fixed/.test(cssText);
const cssBlock = (() => {
  const start = raw.indexOf('.dsh-l2d-settings {');
  if (start < 0) return '';
  const end = raw.indexOf('}', start);
  return end < 0 ? '' : raw.slice(start, end + 1);
})();
check('有 .dsh-l2d-settings 规则', cssBlock !== '');
check('.dsh-l2d-settings 不写 position: fixed', !hasFixedPosition(cssBlock));
check('有模型清单的滚动样式', raw.includes('.dsh-l2d-modellist {'));
check('有拖放区的样式', raw.includes('.dsh-l2d-drop {'));

section('[7] 反证：把分工弄坏，判据必须变假');
const withBindingBack = `${overlay}\nh(BindingsSection, {})`;
check('反证 1：卡片里塞回绑定节 → 判据为假', withBindingBack.includes('h(BindingsSection'));
const settingsWithoutLibrary = settings.replace('h(SettingsModelLibrary, {})', '');
check('反证 2：设置页拿掉模型库 → 判据为假', settingsWithoutLibrary.includes('h(SettingsModelLibrary, {})') === false);
check('反证 3：设置页根节点写 fixed → 判据为真', hasFixedPosition('.dsh-l2d-settings { position: fixed; }') === true);

console.log('');
if (failed > 0) {
  console.error(`✘ SETTINGS SECTION GATE FAILED  ${passed} 通过 / ${failed} 失败`);
  process.exit(1);
}
console.log(`[7] SETTINGS SECTION GATE PASSED  ${passed} 通过 / 0 失败`);
