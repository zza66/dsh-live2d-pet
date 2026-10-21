@echo off
chcp 65001 >nul
title GPT-SoVITS API (:9880) — 插件连的就是这个
echo ============================================================
echo  GPT-SoVITS API (127.0.0.1:9880)
echo.
echo   [1] v5turbo 零样本（新，4 步，推荐）
echo   [2] v5dev 零样本（32 步，质量更好、慢 2~5 倍）
echo   [3] v2Pro 微调（旧版训练出来的权重）
echo   [4] v2Pro 零样本（训练前的对照）
echo   [5] v2 零样本（最老的配置）
echo ============================================================
set "PICK="
set "REPO="
set "CFG="
if not defined DSH_GSV_PICK set /p PICK=请输入 1 / 2 / 3 / 4 / 5 后回车（直接回车 = 1）：
if not defined PICK set PICK=%DSH_GSV_PICK%
set "REPO=D:\GPT-SoVITSv5\GPT-SoVITS-v2pro-20261006nvidia50x0"
set "CFG=GPT_SoVITS/configs/tts_infer_v5turbo.yaml"
if "%PICK%"=="2" set "CFG=GPT_SoVITS/configs/tts_infer_v5dev.yaml"
if "%PICK%"=="3" set "REPO=D:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50"
if "%PICK%"=="3" set "CFG=GPT_SoVITS/configs/tts_infer_dafeiyu.yaml"
if "%PICK%"=="4" set "REPO=D:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50"
if "%PICK%"=="4" set "CFG=GPT_SoVITS/configs/tts_infer_v2pro.yaml"
if "%PICK%"=="5" set "REPO=D:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50"
if "%PICK%"=="5" set "CFG=GPT_SoVITS/configs/tts_infer.yaml"
cd /d "%REPO%"
echo.
echo 目录：%REPO%
echo 配置：%CFG%
echo 看到 "Application startup complete" 就成了；这个窗口不要关。
echo.
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c %CFG%
echo.
echo API 已退出。按任意键关闭窗口。
pause >nul
