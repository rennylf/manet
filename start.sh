#!/usr/bin/env bash
# 启动 Manet(quod manet, manet · 思想仍在)。LLM 走 Cherry Studio 本地 API 代理(设置页可改)。
cd "$(dirname "$0")"

# ---- 定位 uv:双击/LaunchAgent 启动时 PATH 可能不含其安装位置 ----
if ! command -v uv >/dev/null 2>&1; then
  for d in \
    "$HOME/.cherrystudio/bin" \
    "$HOME/.local/bin" \
    "$HOME/.cargo/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"; do
    if [ -x "$d/uv" ]; then export PATH="$d:$PATH"; break; fi
  done
fi

# ---- 模型全部存放在项目工作文件夹 models/ 下 ----
export HF_HOME="$PWD/models/huggingface"
export MODELSCOPE_CACHE="$PWD/models/modelscope"

# ---- SSD 挂载自检:项目本身在 SSD 一号,未挂载时工作目录不存在 ----
if [ ! -d "$PWD/models" ]; then
  echo "❌ 错误:models/ 目录不存在(工作盘未挂载?)"
  echo "   模型(Whisper/Paraformer/本地 LLM)全部存放在项目 models/ 下,"
  echo "   请先挂载工作盘再运行 ./start.sh"
  exit 1
fi

# LLM 配置存放在 data/settings.json(设置页可改),这里只给首次启动的兜底默认值
export LLM_BASE_URL="${LLM_BASE_URL:-http://localhost:23333/v1}"
export LLM_API_KEY="${LLM_API_KEY:-}"
export LLM_MODEL="${LLM_MODEL:-deepseek:deepseek-chat}"
# 转写完成后自动做 AI 标点恢复
export POLISH_ENABLED="1"

exec uv run uvicorn app.main:app --host 127.0.0.1 --port 8642
