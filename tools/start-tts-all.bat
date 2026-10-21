@echo off
chcp 65001 >nul
title 一键启动：GPT-SoVITS API (:9880) + 适配层 (:9881)
echo 会开两个窗口，两个都别关。
echo   1) GPT-SoVITS API  127.0.0.1:9880
echo   2) 适配层           127.0.0.1:9881  ^<-- 插件面板填这个
echo.
echo 一键启动不问菜单：默认 [1] v5turbo。想换版本（v5dev / 旧 v2Pro 微调），请单独双击 start-gpt-sovits-api.bat。
echo API 加载权重实测要 10~14 秒：等它的窗口冒出 "Application startup complete" 再说话，第一句才不会报错。
set "DSH_GSV_PICK=1"
start "GPT-SoVITS API :9880" "%~dp0start-gpt-sovits-api.bat"
timeout /t 20 /nobreak >nul
start "适配层 :9881" "%~dp0start-gptsovits-adapter.bat"
echo.
echo 两个窗口都起来之后，到 DSH 面板：音色 -^> 引擎「自定义 TTS 服务」-^> 地址 http://127.0.0.1:9881/tts
timeout /t 8 /nobreak >nul
