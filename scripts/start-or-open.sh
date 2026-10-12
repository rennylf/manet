#!/usr/bin/env bash
# 一键启动/打开:
#   服务已在跑 → 只打开浏览器
#   服务未启动 → 后台启动,等就绪后打开浏览器
cd "$(dirname "$0")/.."

URL="http://127.0.0.1:8642/"

if curl -s -m 1 "$URL" > /dev/null 2>&1; then
  open "$URL"
  exit 0
fi

mkdir -p data
nohup ./start.sh > data/server.log 2>&1 &

for _ in $(seq 1 60); do          # 最多等 30 秒
  sleep 0.5
  if curl -s -m 1 "$URL" > /dev/null 2>&1; then
    open "$URL"
    exit 0
  fi
done

osascript -e 'display alert "听悟 Lite 启动失败" message "请查看 data/server.log 了解原因(常见:工作盘未挂载)" as critical' 2>/dev/null
exit 1
