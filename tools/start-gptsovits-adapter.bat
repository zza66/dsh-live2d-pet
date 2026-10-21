@echo off
chcp 65001 >nul
title 适配层 (:9881) —— 插件面板填的就是这个地址
cd /d D:\dsh工作区\live2d
echo 适配层会读 tools\gptsovits-adapter.config.json（换声音改那个文件，不用动脚本）。
echo 面板里填：http://127.0.0.1:9881/tts
echo.
rem 让 Python 输出的中文日志也走 UTF-8，否则重定向到文件里会变乱码
set PYTHONIOENCODING=utf-8
"D:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50\runtime\python.exe" tools\gptsovits-adapter.py
echo.
echo 适配层已退出。按任意键关闭窗口。
pause >nul
