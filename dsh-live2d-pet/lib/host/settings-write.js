/**
 * settings-write —— 把一小块配置并回 DSH 的 `settings.json`。
 *
 * 为什么单独一个模块：
 *   `/bindings` 的 POST 是整个插件里**唯一一处写用户配置文件**的地方。写坏它
 *   不是「面板不好用」，是**替用户删掉他手写的配置**（他别处的 `modelsRoot`、
 *   `emotionScene`、别的插件写进去的键都在这一个文件里）。这种代码不能留在
 *   路由里当内联片段：路由要经 `req` / `res` 才能跑，门禁没法直接喂它一个坏
 *   JSON 看它会不会覆盖；抽成纯函数之后，门禁可以拿临时目录把每一种坏情况都
 *   真跑一遍（见 `tools/test-emotions.mjs` 的「写回 settings.json」那一段）。
 *
 * 三条不可动摇的规矩：
 *   ① **读不出来就不写**。现有文件不是合法 JSON（用户手写坏了、编辑器存了一半）
 *      → 拒绝并报 `E_SETTINGS_UNREADABLE`，一个字节都不动。
 *   ② **只动自己那个键**。别的键原样带过去（`{ ...existing }`），不排序、不重排。
 *   ③ **先写临时文件再改名**。直接写主文件的话，写到一半断电就是一个空文件 ——
 *      而那正好触发规矩 ①，用户下次打开面板会看到「读不出来」。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function fail(code, message, detail) {
  return { ok: false, code, message, detail: String(detail ?? '') };
}

/**
 * 把 `patch` 并进 `settingsPath`。
 *
 * `patch` 里值为 `undefined` 的键会被**删掉**（「面板上清空绑定」= 这一项不该
 * 留在文件里），其余键覆盖写入。没有 `undefined` 时行为就是浅合并。
 *
 * @param {string} settingsPath 目标文件（不允许是空串）
 * @param {Record<string, unknown>} patch 要写入 / 删除的键
 * @returns {{ok: true, keys: number} | {ok: false, code: string, message: string, detail: string}}
 */
export function applySettingsPatch(settingsPath, patch) {
  if (typeof settingsPath !== 'string' || settingsPath === '') {
    return fail('E_NO_SETTINGS_PATH', '解析不出 settings.json 的路径，没有写入', settingsPath);
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return fail('E_BAD_PATCH', '要写入的内容不是一个对象', typeof patch);
  }

  let existing = {};
  if (existsSync(settingsPath)) {
    let text = '';
    try {
      text = readFileSync(settingsPath, 'utf8');
    } catch (error) {
      // 读不动（权限 / 被占用）也不许往下写：那会拿一份「空配置」覆盖掉它。
      return fail('E_SETTINGS_UNREADABLE', '现有 settings.json 读不出来，没有覆盖它', error?.message ?? error);
    }
    if (text.trim() !== '') {
      try {
        existing = JSON.parse(text);
      } catch (error) {
        return fail('E_SETTINGS_UNREADABLE', '现有 settings.json 不是合法 JSON，没有覆盖它', error?.message ?? error);
      }
    }
    // 合法但不是对象（数组 / null / 数字）—— 不是「用户手写的配置」，按空处理。
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
  }

  const next = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, settingsPath);
  } catch (error) {
    return fail('E_SETTINGS_WRITE_FAILED', '写 settings.json 失败', error?.message ?? error);
  }

  return { ok: true, keys: Object.keys(next).length };
}
