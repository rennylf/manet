@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Manet Windows 启动器
rem Whisper 引擎自动走 faster-whisper(CTranslate2);本地翻译自动切 API 模式
set "HF_HOME=%CD%\models\huggingface"
set "MODELSCOPE_CACHE=%CD%\models\modelscope"
if not exist models\ mkdir models
where uv >nul 2>nul || (echo [Manet] 未检测到 uv,请先安装: https://docs.astral.sh/uv/ & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo [Manet] 未检测到 ffmpeg,请安装并加入 PATH: https://ffmpeg.org/download.html & pause & exit /b 1)
uv run uvicorn app.main:app --host 127.0.0.1 --port 8642
pause
