#!/usr/bin/env bash
# 端到端冒烟:生成测试音频 → 上传 → 转写 → 导出 → 清理(约 1 分钟)
set -e
BASE="${1:-http://127.0.0.1:8642}"
say -v Tingting -o /tmp/smoke.aiff "这是一段冒烟测试音频,用于验证转写管线。" 
ffmpeg -y -i /tmp/smoke.aiff -ar 16000 -ac 1 /tmp/smoke.wav 2>/dev/null
TID=$(curl -s -F "file=@/tmp/smoke.wav" -F "language=zh" "$BASE/api/upload" | python3 -c "import json,sys;print(json.load(sys.stdin)['task_id'])")
echo "测试任务: $TID"
for i in $(seq 1 60); do
  S=$(curl -s "$BASE/api/tasks/$TID" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
  [ "$S" = done ] && break
  [ "$S" = error ] && echo "❌ 转写失败" && exit 1
  sleep 2
done
echo "--- SRT 导出预览 ---"
curl -s "$BASE/api/tasks/$TID/export?format=srt&lang=orig" | head -4
curl -s -X DELETE "$BASE/api/tasks/$TID" > /dev/null
echo "✅ 冒烟通过(测试任务已清理)"
