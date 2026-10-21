#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GPT-SoVITS → Live2D 插件 的适配层（只用标准库，不需要 pip install 任何东西）。

为什么需要这一层
----------------
插件的契约是「POST 一个 JSON 进来，回音频字节」：

    POST http://127.0.0.1:9881/tts
    { "text": "要念的句子", "voice": "", "rate": "+0%", "format": "wav" }

而 GPT-SoVITS 的 api_v2.py 虽然也收 POST，但它**必须要**三样插件不知道的东西：
参考音频路径、参考音频的原文、语言。每次请求都带一遍既啰嗦又容易漏，
所以把它们固定在下面这段配置里，适配层只负责转手。

用法
----
1. 先把 GPT-SoVITS 的 API 跑起来（默认 9880）：

       runtime\\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml

2. 改下面 REF_AUDIO / PROMPT_TEXT 两行（改成你自己的参考音频与它的原文），然后：

       python gptsovits-adapter.py            # 监听 9881
       # 整合包自带 python：  runtime\\python.exe gptsovits-adapter.py

3. 插件面板 →「音色」→ 引擎「自定义 TTS 服务」→ 地址填 http://127.0.0.1:9881/tts
   → 点「测试连接」→ 应该显示「连通了：HTTP 200」→ 试听。

参考音频怎么选（决定像不像）
--------------------------
- 3~10 秒、单人、无背景音乐、无回声，wav/mp3 都行。
- **PROMPT_TEXT 必须逐字等于那段音频里说的话**（多一个字少一个字都会让韵律发飘）。
- 想用它唱 UTAU 音源那种碎音节是不行的：那里面没有连续的句子。
"""

import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ─── 配置 ───────────────────────────────────────────────────────────────
# 优先顺序：环境变量 > 同目录的 gptsovits-adapter.config.json > 下面的默认值。
# 换音色只需要改那个 JSON 文件，不用动这个脚本（脚本可以留在版本库里当工具）。
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gptsovits-adapter.config.json')


def _load_config():
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as error:  # noqa: BLE001 - 配置坏了就说一声，不拦住启动
        print('配置文件读不了，已忽略：%s' % error)
        return {}


_CONFIG = _load_config()


def _pick(env_key, cfg_key, fallback):
    if env_key in os.environ and os.environ[env_key] != '':
        return os.environ[env_key]
    value = _CONFIG.get(cfg_key)
    if value is not None and value != '':
        return value
    return fallback


GPT_SOVITS_URL = _pick('GSV_URL', 'gpt_sovits_url', 'http://127.0.0.1:9880/tts')
REF_AUDIO = _pick('GSV_REF', 'ref_audio', r'D:\GPT-SoVITS\ref\voice.wav')
PROMPT_TEXT = _pick('GSV_PROMPT', 'prompt_text', '这里填参考音频里逐字对应的那句话')
PROMPT_LANG = _pick('GSV_PROMPT_LANG', 'prompt_lang', 'zh')   # zh / en / ja / ko / yue
TEXT_LANG = _pick('GSV_TEXT_LANG', 'text_lang', 'zh')         # 插件发来的句子是什么语言

# 切句方式 —— 这一项直接决定「一句话里会不会突然停顿、冒出一声含糊的『哼』」。
#   · cut5（api_v2.py 的默认档，曾经是本文件的默认值）：按标点切，**逗号也切**。
#     每一片单独合成再拼回去，于是：碎片之间插进 0.3~0.7 秒静音，短碎片还会被合成成
#     一声 0.3~0.4 秒的含糊音节 —— 实测 43 字的一句话因此拉长到 13.4 秒、多出 6 个短块。
#   · cut0：整句不切，韵律最连贯（同一句话 9.3 秒、0 个短块），但句子太长会跑飞。
#   · cut2：只按句号/问号/叹号切，长文本的折中档。
# 'auto' = 短句用 cut0、超过 AUTO_SPLIT_LIMIT 字改用 cut2；也可以直接写死成 cut0 / cut2 / cut5。
TEXT_SPLIT_METHOD = str(_pick('GSV_SPLIT', 'text_split_method', 'auto')).strip().lower()
AUTO_SPLIT_LIMIT = 150          # 字；'auto' 模式下超过它就不敢再用 cut0

LISTEN_HOST = _pick('GSV_HOST', 'listen_host', '127.0.0.1')
LISTEN_PORT = int(_pick('GSV_PORT', 'listen_port', '9881'))

# 留档 —— 只在「耳朵里出了问题、脚本里看不出来」时才需要：每次合成成功，
# 把**请求原文**和**回来的音频字节**原样存一份（`<时间戳>.wav` + `.json`）。
# 有了它，「哪一句、哪个字之后冒出一声哼」就不用靠录屏猜了 —— 直接量那段 wav。
# 想关掉：环境变量 GSV_DUMP=off，或配置里 "dump_dir": ""。
DUMP_DIR = str(_pick('GSV_DUMP', 'dump_dir', os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'work', 'tts-dumps')))
DUMP_KEEP = 80                  # 只留最近多少份，不会把盘写满

UPSTREAM_TIMEOUT = 120          # 秒；第一次合成要加载权重，别设太小
MAX_TEXT_CHARS = 500            # 一句台词的上限，超了直接拒（防止误传整篇文章）

# 音色包缓存 —— 插件发来的 `voiceProfile.refAudioBase64` 落在这里，
# 下一次同一个包（按 sha256 认）就不用再解码一遍。
# `refAudioPath` 能读到文件时**根本不走这条路**（同机场景永远是这条路）。
PACK_CACHE_DIR = str(_pick('GSV_PACK_CACHE', 'pack_cache_dir', os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'work', 'voice-pack-cache')))
# ───────────────────────────────────────────────────────────────────────


def rate_to_speed_factor(rate) -> float:
    """插件发的是 '+10%' / '-5%' / '+0%'，GPT-SoVITS 要的是倍率 1.1 / 0.95。"""
    if not isinstance(rate, str):
        return 1.0
    text = rate.strip()
    if text.endswith('%'):
        text = text[:-1]
    try:
        percent = float(text)
    except ValueError:
        return 1.0
    factor = 1.0 + percent / 100.0
    return min(2.0, max(0.5, factor))


def pick_split_method(text: str) -> str:
    """决定这一句交给上游用哪种切分：短句整句念，长句才按句号切开。"""
    if TEXT_SPLIT_METHOD not in ('', 'auto'):
        return TEXT_SPLIT_METHOD
    return 'cut0' if len(text) <= AUTO_SPLIT_LIMIT else 'cut2'


def resolve_voice(payload):
    """把插件发来的 `voiceProfile` 折成「这一句用哪段参考音」。

    返回 `(ref_audio, prompt_text, prompt_lang, text_lang, label)`。

    ## 为什么参考音要随请求走，而不是改配置文件

    音色包是**插件那边**的数据（用户在面板上挑的），适配层不该知道
    `%DSH_HOME%` 在哪、也不该在每次换包时被重启一遍。所以插件把「这一段参考音
    + 它的逐字文本」随请求递过来，这里只负责用它覆盖配置里的默认值。

    ## 两个退路

    - 没有 `voiceProfile`（老调用方、或面板没选包）→ 用配置文件里那套，行为与
      加这个字段之前**完全一致**；
    - 有 `voiceProfile` 但参考音拿不到（文件被删、base64 坏了）→ **不报错**，
      退回配置里的音色并在日志里说一句。一个坏掉的音色包不该让她哑掉。
    """
    profile = payload.get('voiceProfile')
    if not isinstance(profile, dict):
        return REF_AUDIO, PROMPT_TEXT, PROMPT_LANG, TEXT_LANG, ''

    prompt_text = profile.get('promptText')
    if not isinstance(prompt_text, str) or prompt_text.strip() == '':
        return REF_AUDIO, PROMPT_TEXT, PROMPT_LANG, TEXT_LANG, ''

    ref_audio = profile.get('refAudioPath')
    ref_audio = ref_audio if isinstance(ref_audio, str) else ''
    if not os.path.isfile(ref_audio):
        ref_audio = _materialize_pack_audio(profile)
    if not ref_audio or not os.path.isfile(ref_audio):
        print('  （音色包 %s 的参考音拿不到，退回配置里的音色）' % (profile.get('id') or '?'))
        return REF_AUDIO, PROMPT_TEXT, PROMPT_LANG, TEXT_LANG, ''

    prompt_lang = profile.get('promptLang') if isinstance(profile.get('promptLang'), str) else ''
    text_lang = profile.get('textLang') if isinstance(profile.get('textLang'), str) else ''
    label = '%s（%s）' % (profile.get('name') or profile.get('id') or '音色包', profile.get('id') or '?')
    return (
        ref_audio,
        prompt_text.strip(),
        prompt_lang or PROMPT_LANG,
        text_lang or TEXT_LANG,
        label,
    )


def _materialize_pack_audio(profile):
    """把 `refAudioBase64` 落成文件（跨机场景），按 sha256 缓存，返回路径。

    同机场景 `refAudioPath` 直接读得到，根本走不到这里 —— 这条退路是给
    「适配层跑在容器里 / 另一台机器上」的调用方留的。
    """
    encoded = profile.get('refAudioBase64')
    if not isinstance(encoded, str) or encoded == '':
        return ''
    digest = str(profile.get('refAudioSha256') or '')[:16]
    if digest == '':
        digest = hashlib.sha256(encoded.encode('ascii', 'ignore')).hexdigest()[:16]
    try:
        os.makedirs(PACK_CACHE_DIR, exist_ok=True)
    except OSError as error:
        print('  （音色包缓存目录建不了：%s）' % error)
        return ''
    safe_id = ''.join(ch for ch in str(profile.get('id') or 'pack') if ch.isalnum() or ch in '._-')[:40] or 'pack'
    path = os.path.join(PACK_CACHE_DIR, '%s-%s.wav' % (safe_id, digest))
    if os.path.isfile(path):
        return path
    try:
        with open(path, 'wb') as handle:
            handle.write(base64.b64decode(encoded))
    except Exception as error:  # noqa: BLE001 - 坏包不该拦住合成
        print('  （音色包 base64 解不开：%s）' % error)
        return ''
    return path


# ─── 换权重（音色包带训练好的模型时）────────────────────────────────────
# api_v2.py 有三个 GET 可以在**不重启**的前提下换模型：/set_sovits_weights、
# /set_gpt_weights、/set_refer_audio。实测换一次 0.3~0.8 秒，比冷启动 10 秒便宜得多。
UPSTREAM_BASE = GPT_SOVITS_URL[:-4] if GPT_SOVITS_URL.endswith('/tts') else GPT_SOVITS_URL
UPSTREAM_BASE = UPSTREAM_BASE.rstrip('/')

# 这个进程「换进来过」的上一份权重。换失败时用它回滚；空表示还没换过。
LAST_WEIGHTS = {'sovits': '', 'gpt': ''}


def _upstream_get(path: str):
    """调一次上游的 GET，返回 (ok, 说明)。上游把异常塞在 JSON 的 Exception 字段里。"""
    request = urllib.request.Request(UPSTREAM_BASE + path)
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
            body = response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as error:
        """
        400/500 不是「连不上」，是「服务看懂了但拒绝」。

        实测把 v5 训练出来的权重（文件头 08 = v5turbo LoRA）换进 v2 包的引擎时，
        上游回 400 + {"message":"change sovits weight failed","Exception":"b'08'"} ——
        它按文件头查表，表里没有 08 就 KeyError。这时候对用户最有用的信息是
        上游那句 Exception，而不是「先确认服务在跑」（它明明在跑）。
        """
        raw = error.read().decode('utf-8', 'replace') if error.fp is not None else ''
        detail = raw[:300]
        try:
            parsed = json.loads(raw) if raw.strip() else {}
            if isinstance(parsed, dict):
                parts = [str(parsed.get('message') or ''), str(parsed.get('Exception') or '')]
                detail = ' '.join(part for part in parts if part) or detail
        except Exception:  # noqa: BLE001 - 不是 JSON 就原样给
            pass
        return False, '上游拒绝：HTTP %d %s' % (error.code, detail)
    try:
        parsed = json.loads(body) if body.strip() else {}
    except Exception:  # noqa: BLE001 - 不是 JSON 就当成一句人话
        return False, body[:300]
    if isinstance(parsed, dict) and parsed.get('Exception'):
        return False, str(parsed.get('Exception'))[:300]
    if isinstance(parsed, dict) and parsed.get('message'):
        return True, str(parsed.get('message'))
    return True, ''


def _check_weight_file(label: str, path):
    if not isinstance(path, str) or path.strip() == '':
        return '缺 %s 权重路径' % label
    if not os.path.isabs(path):
        return '%s 权重必须给绝对路径（适配层要能直接读它）' % label
    if not os.path.isfile(path):
        return '%s 权重不存在：%s' % (label, path)
    return ''


def switch_weights(sovits: str, gpt: str) -> dict:
    """把这两份权重换进正在跑的 GPT-SoVITS。

    顺序是 SoVITS 先、GPT 后（与官方面板一致）。任何一步失败都把上一份换回去 ——
    「换了一半」的声音比原来难听得更没道理，而且用户看不出是哪半步坏的。
    """
    started = time.time()
    steps = (
        ('SoVITS', sovits, '/set_sovits_weights?weights_path=', 'sovits'),
        ('GPT', gpt, '/set_gpt_weights?weights_path=', 'gpt'),
    )
    for label, path, route, key in steps:
        try:
            ok, detail = _upstream_get(route + urllib.parse.quote(path))
        except Exception as error:  # noqa: BLE001 - 连不上就是连不上
            _rollback_weights()
            return {'ok': False, 'code': 'E_WEIGHTS_UPSTREAM_UNREACHABLE',
                    'detail': '%s 换不上：%s（先确认 api_v2.py 在 %s 上跑着）' % (label, error, UPSTREAM_BASE)}
        if not ok:
            _rollback_weights()
            return {'ok': False, 'code': 'E_WEIGHTS_UPSTREAM_REFUSED',
                    'detail': '%s 换不上：%s' % (label, detail)}
        LAST_WEIGHTS[key] = path
    return {'ok': True, 'sovits': sovits, 'gpt': gpt, 'elapsedMs': int((time.time() - started) * 1000)}


def _rollback_weights() -> None:
    if LAST_WEIGHTS['sovits'] == '' and LAST_WEIGHTS['gpt'] == '':
        return
    for key, route in (('sovits', '/set_sovits_weights?weights_path='), ('gpt', '/set_gpt_weights?weights_path=')):
        path = LAST_WEIGHTS[key]
        if path == '':
            continue
        try:
            _upstream_get(route + urllib.parse.quote(path))
        except Exception:  # noqa: BLE001 - 回滚是尽力而为
            pass


def synthesize(text: str, rate, split_method: str, voice=None) -> bytes:
    ref_audio, prompt_text, prompt_lang, text_lang = voice if voice else (
        REF_AUDIO, PROMPT_TEXT, PROMPT_LANG, TEXT_LANG)
    payload = {
        'text': text,
        'text_lang': text_lang,
        'ref_audio_path': ref_audio,
        'prompt_text': prompt_text,
        'prompt_lang': prompt_lang,
        'text_split_method': split_method,
        'batch_size': 1,
        'media_type': 'wav',
        'streaming_mode': False,
        'speed_factor': rate_to_speed_factor(rate),
    }
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    request = urllib.request.Request(
        GPT_SOVITS_URL,
        data=body,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
        return response.read()


def dump_request(text: str, rate, split_method: str, audio: bytes, seconds: float):
    """把一次合成（原文 + 音频）落盘，返回 wav 文件名；关掉或失败时返回 None。

    留档失败**绝不能**影响这次合成：诊断是附加能力，不是契约的一部分。
    """
    if DUMP_DIR.strip().lower() in ('', 'off', 'none', '0', 'false'):
        return None
    try:
        os.makedirs(DUMP_DIR, exist_ok=True)
        stamp = time.strftime('%Y%m%d-%H%M%S') + '-%03d' % int((time.time() * 1000) % 1000)
        wav_name = stamp + '.wav'
        with open(os.path.join(DUMP_DIR, wav_name), 'wb') as handle:
            handle.write(audio)
        meta = {
            'at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'text': text,
            'chars': len(text),
            'rate': rate,
            'rateSpeedFactor': rate_to_speed_factor(rate),
            'splitMethod': split_method,
            'bytes': len(audio),
            'seconds': round(seconds, 2),
        }
        with open(os.path.join(DUMP_DIR, stamp + '.json'), 'w', encoding='utf-8') as handle:
            json.dump(meta, handle, ensure_ascii=False, indent=2)
        # 只留最近 DUMP_KEEP 份（按文件名排序＝按时间排序）
        names = sorted(name for name in os.listdir(DUMP_DIR) if name.endswith('.wav'))
        for old in names[:-DUMP_KEEP]:
            for name in (old, old[:-4] + '.json'):
                try:
                    os.remove(os.path.join(DUMP_DIR, name))
                except OSError:
                    pass
        return wav_name
    except Exception as error:  # noqa: BLE001 - 留档坏了不能连累合成
        print('  （留档失败，不影响合成：%s）' % error)
        return None


class AdapterServer(ThreadingHTTPServer):
    """单实例服务器。

    `allow_reuse_address = False` 是**故意**的：Windows 上 SO_REUSEADDR 的语义是
    「允许第二个进程绑同一个端口」（Linux 上不是），于是重复双击启动时会出现两个
    适配层都在跑、请求被更晚那个悄悄接走的情况 —— 面板显示连通，逻辑却不在同一份
    代码上。关掉它，第二个实例会直接拿到 WSAEADDRINUSE，走下面那句友好提示。
    """

    allow_reuse_address = False
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'gptsovits-adapter/1.0'
    def log_message(self, fmt, *args):  # 让日志带时间戳，出问题能对时
        """记一行日志，**永不抛异常**。

        这不是洁癖：Windows 的控制台默认是 GBK，而日志里带一个 `«` 就会让
        `sys.stdout.write` 抛 UnicodeEncodeError —— 它发生在合成**成功之后、回包之前**，
        于是客户端收到的是「语音合成失败」，而实际上音频已经做好了。
        一次成功的合成不该死在日志上。
        """
        line = '[%s] %s' % (time.strftime('%H:%M:%S'), fmt % args)
        try:
            sys.stdout.write(line + '\n')
            sys.stdout.flush()
        except Exception:  # noqa: BLE001 - 日志失败绝不能影响请求
            try:
                encoding = getattr(sys.stdout, 'encoding', None) or 'ascii'
                sys.stdout.write(line.encode(encoding, 'backslashreplace').decode(encoding, 'replace') + '\n')
                sys.stdout.flush()
            except Exception:  # noqa: BLE001
                pass

    # 面板的「测试连接」走 GET：只证明服务活着，**不做合成**（否则每次点按钮都要等模型）
    def do_GET(self):
        ref_ok = os.path.isfile(REF_AUDIO)
        self._send_json(200, {
            'ok': True,
            'service': 'gptsovits-adapter',
            'upstream': GPT_SOVITS_URL,
            'refAudio': REF_AUDIO,
            'refAudioExists': ref_ok,
            'promptLang': PROMPT_LANG,
            'textLang': TEXT_LANG,
            'textSplitMethod': TEXT_SPLIT_METHOD,
            'dumpDir': DUMP_DIR or None,
            # 认不认 `voiceProfile`（音色包）：插件据此决定面板要不要提示「适配层太旧」
            'voicePackSupport': True,
            # 认不认 `POST /weights`（音色包里带训练好的模型时用）
            'weightsSupport': True,
            'lastWeights': dict(LAST_WEIGHTS),
            'hint': '' if ref_ok else 'REF_AUDIO 里的文件不存在：合成会失败（GET 只是探活）',
        })

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return self._send_json(400, {'code': 'E_TTS_EMPTY_TEXT', 'detail': '请求体是空的'})
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode('utf-8'))
        except Exception as error:  # noqa: BLE001 - 契约里 400 就是给调用方看的
            return self._send_json(400, {'code': 'E_BAD_JSON', 'detail': str(error)})

        text = payload.get('text')
        if self.path.split('?')[0].rstrip('/').endswith('/weights'):
            return self._handle_weights(payload)
        if not isinstance(text, str) or text.strip() == '':
            return self._send_json(400, {'code': 'E_TTS_EMPTY_TEXT', 'detail': 'text 为空'})
        if len(text) > MAX_TEXT_CHARS:
            return self._send_json(400, {
                'code': 'E_TTS_TEXT_TOO_LONG',
                'detail': 'text 有 %d 字，上限 %d' % (len(text), MAX_TEXT_CHARS),
            })
        packed = resolve_voice(payload)
        ref_audio, prompt_text, prompt_lang, text_lang, pack_label = packed
        if not os.path.isfile(ref_audio):
            return self._send_json(400, {
                'code': 'E_TTS_REF_AUDIO_MISSING',
                'detail': '参考音频不存在：%s（改本文件顶部的 REF_AUDIO，或在面板里选一个音色包）' % ref_audio,
            })

        started = time.time()
        split_method = pick_split_method(text)
        try:
            audio = synthesize(
                text, payload.get('rate'), split_method,
                (ref_audio, prompt_text, prompt_lang, text_lang),
            )
        except urllib.error.HTTPError as error:
            detail = error.read()[:400].decode('utf-8', 'replace')
            return self._send_json(502, {
                'code': 'E_TTS_UPSTREAM_BAD_STATUS',
                'detail': 'GPT-SoVITS 回了 HTTP %d：%s' % (error.code, detail),
            })
        except Exception as error:  # noqa: BLE001
            return self._send_json(502, {
                'code': 'E_TTS_UPSTREAM_UNREACHABLE',
                'detail': '%s（先确认 api_v2.py 在 %s 上跑着）' % (error, GPT_SOVITS_URL),
            })

        if len(audio) < 64:
            return self._send_json(502, {
                'code': 'E_TTS_UPSTREAM_EMPTY_AUDIO',
                'detail': '上游只回了 %d 字节' % len(audio),
            })
        seconds = time.time() - started
        dumped = dump_request(text, payload.get('rate'), split_method, audio, seconds)
        preview = text if len(text) <= 24 else text[:24] + '…'
        self.log_message('合成 %d 字（%s）→ %d 字节，%.1f 秒  «%s»%s%s',
                         len(text), split_method, len(audio), seconds, preview,
                         '' if pack_label == '' else '  [音色包 %s]' % pack_label,
                         '' if dumped is None else '  → ' + dumped)
        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def _handle_weights(self, payload):
        """POST /weights：把音色包里的两份权重换进正在跑的上游。"""
        sovits = payload.get('sovits')
        gpt = payload.get('gpt')
        problem = _check_weight_file('SoVITS', sovits) or _check_weight_file('GPT', gpt)
        if problem:
            return self._send_json(400, {'code': 'E_WEIGHTS_BAD_REQUEST', 'detail': problem})
        result = switch_weights(sovits, gpt)
        if result.get('ok') is True:
            self.log_message('换权重 → %s + %s（%d ms）',
                             os.path.basename(sovits), os.path.basename(gpt), result.get('elapsedMs', 0))
            return self._send_json(200, result)
        self.log_message('换权重失败：%s', result.get('detail'))
        return self._send_json(502, result)

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    # 控制台编码是 GBK 时，启动横幅里一个生僻字就能让进程起不来；宁可显示成 \xXX。
    try:
        sys.stdout.reconfigure(errors='backslashreplace')
    except Exception:  # noqa: BLE001 - 老 Python 没有 reconfigure 也无所谓
        pass
    print('GPT-SoVITS 适配层：http://%s:%d/tts' % (LISTEN_HOST, LISTEN_PORT))
    print('  upstream : %s' % GPT_SOVITS_URL)
    print('  参考音频 : %s%s' % (REF_AUDIO, '' if os.path.isfile(REF_AUDIO) else '  ← 不存在！'))
    print('  原文     : %s' % (PROMPT_TEXT[:60] + ('…' if len(PROMPT_TEXT) > 60 else '')))
    print('  留档     : %s（最近 %d 份；GSV_DUMP=off 关掉）' % (DUMP_DIR or '已关闭', DUMP_KEEP))
    print('  切句     : %s%s' % (
        TEXT_SPLIT_METHOD,
        '（≤%d 字整句不切，更长按句号切）' % AUTO_SPLIT_LIMIT if TEXT_SPLIT_METHOD in ('', 'auto') else '',
    ))
    if not os.path.isfile(REF_AUDIO):
        print('  （GET 探活仍会成功，POST 合成会明确报 E_TTS_REF_AUDIO_MISSING）')
    try:
        server = AdapterServer((LISTEN_HOST, LISTEN_PORT), Handler)
    except OSError as error:
        # 最常见的就是「上一次的适配层窗口没关，端口还占着」——给出能直接照做的提示，
        # 而不是让用户对着一整页 Traceback 猜。
        print('端口 %d 起不来：%s' % (LISTEN_PORT, error))
        print('  → 多半是已经有一个适配层在跑。查一下：')
        print('     Get-NetTCPConnection -LocalPort %d -State Listen' % LISTEN_PORT)
        print('  或者等 30 秒让旧进程退出，或者直接用它（如果那个窗口还开着）。')
        return 3
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n停止。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
