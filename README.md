# 听悟 Lite (tingwu-local)

开源本地版「通义听悟」：**音频 / 视频 → 转写稿 + AI 笔记**。
转写、翻译全部在 Apple Silicon 本机推理（MLX / FunASR），**数据不出机器**；
AI 笔记、问答、随笔等能力可接入任意 OpenAI 兼容端点。

> 本项目为独立开源作品，与阿里云及「通义听悟」无关联，仅作功能形态上的对标。

## 功能一览

**转写管线（全本地）**
- 三种转写引擎，设置页 / 新建转写弹窗可切换：

  | 引擎 | 特长 | 适用 |
  |---|---|---|
  | `whisper`（默认） | 多语种、语言检测稳（多点采样投票，不怕片头音乐） | 日 / 英等外语内容 |
  | `paraformer` | 原生标点 + **说话人分离** + 热词，约 16× 实时 | 中文会议 / 发布会 |
  | `sensevoice` | 速度最快、多语种、VAD 时间戳 | 快速出稿 |

- 热词 / 专有名词注入，提升领域词汇识别率
- 幻觉过滤：清除 Whisper 经典的「谢谢观看」「字幕志愿者」等输出
- AI 标点恢复 + 断句合并（Whisper 转写后自动执行，时间戳按碎片首尾对齐，不丢字音同步）
- 双通道任务队列：转写与 LLM 任务并行，支持**暂停 / 继续 / 终止**，服务重启自动恢复中断任务

**工作台**
- 段落式转写稿：点击跳转播放、当前句高亮、稿内搜索、在线编辑纠错
- **智能笔记**：摘要 / 章节速览（点击跳转）/ 待办事项 / 关键词
- **AI 随笔**：把长转写稿改写为主旨明确、内容精炼的随笔文章，提示词可自定义
- **思维导图**：LLM 生成三层树（主题 → 章节[带时间戳] → 要点），自绘 SVG，支持折叠 / 缩放 / 拖拽 / 导出 PNG
- **问答**：就这段录音提问，回答带可点击的时间点引用
- **我的笔记**：随手记录，自动保存
- **AI 翻译**：逐句对齐翻译（保时间戳），原文 / 中文 / 双语三态切换；翻译可走本地模型（mlx-lm，免联网零费用）或 API
- **软字幕封装**：SRT 作为独立字幕轨混流进 MP4 / MKV，播放时可开关；流拷贝不重编码，秒级完成
- **导出**：Markdown / TXT / SRT（各支持原文 / 中文 / 双语）；一键导出 **Obsidian** 知识库（YAML frontmatter、导出内容可配置；随笔单独导出，文件名即随笔标题）
- **内容库管理**：文件夹、搜索、重命名、移动、删除

## 系统要求

- macOS，**Apple Silicon**（M1 及以后；MLX 推理依赖）
- [ffmpeg](https://ffmpeg.org/)（`brew install ffmpeg`）
- [uv](https://docs.astral.sh/uv/)（Python 包管理，`brew install uv`）
- 磁盘约 **10GB**（模型首次运行自动下载到项目 `models/`，不占系统盘）
- 可选：任意 OpenAI 兼容 LLM 端点（DeepSeek / OpenAI / Ollama / Cherry Studio 代理等），
  用于标点恢复、智能笔记、脑图、问答、随笔、API 翻译。
  **不配置 LLM 也能用**：转写、编辑、导出等核心功能完全离线可用。

## 快速开始

```bash
git clone https://github.com/rennylf/tingwu-local.git
cd tingwu-local
uv sync          # 安装依赖（首次）
./start.sh       # 启动，浏览器打开 http://127.0.0.1:8642
```

拖入音视频文件 → 选择引擎 / 语言 → 开始转写。
首次转写会自动下载模型（HuggingFace / ModelScope）：

| 模型 | 用途 | 大小（约） |
|---|---|---|
| `mlx-community/whisper-large-v3-turbo` | Whisper 转写 | 1.6 GB |
| `iic/speech_seaco_paraformer_*` + VAD / 标点 / 说话人 | Paraformer 引擎 | 1.5 GB |
| `iic/SenseVoiceSmall` | SenseVoice 引擎 | 0.9 GB |
| `mlx-community/Qwen2.5-3B-Instruct-4bit` | 本地翻译（可选） | 1.6 GB |

> 大陆网络建议走镜像：启动前 `export HF_ENDPOINT=https://hf-mirror.com`
> （ModelScope 模型本身即国内源）。

## LLM 配置（AI 笔记 / 问答 / 随笔 / 标点恢复 / API 翻译）

推荐在网页「⚙️ 设置」中配置，保存到 `data/settings.json`，**立即生效、无需重启**：

- Base URL / API Key / 模型名（可一键拉取端点模型列表）
- 「测试连接」验证连通性
- 翻译引擎二选一：本地模型（mlx-lm 进程内驱动，免 Ollama）或 API
- 随笔生成提示词可自定义（`{transcript}` 为转写稿占位符）
- Obsidian 导出路径与导出内容

也可用环境变量（`start.sh` 支持，优先级低于设置页）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:23333/v1` | OpenAI 兼容端点 |
| `LLM_API_KEY` | 空 | API Key |
| `LLM_MODEL` | `deepseek:deepseek-chat` | 模型名 |
| `WHISPER_MODEL` | `mlx-community/whisper-large-v3-turbo` | MLX Whisper 仓库 |
| `TRANSLATE_MODE` | `local` | 翻译走本地（`local`）或 API（`api`） |
| `LOCAL_MODEL_REPO` | `mlx-community/Qwen2.5-3B-Instruct-4bit` | 本地翻译模型 |
| `ASR_ENGINE` | `whisper` | 默认转写引擎 |
| `POLISH_ENABLED` | `1` | 转写后自动 AI 标点恢复（仅 Whisper） |
| `LLM_MAX_CHARS` | `24000` | 超长文本 map-reduce 阈值 |
| `MAX_UPLOAD_MB` | `2048` | 上传大小上限 |

所有 LLM 调用都有超时 + 自动重试 + 兜底：标点失败保留原文、单块失败不影响整体。

## 项目结构

```
app/
├── main.py        # FastAPI 路由:上传/任务/转写稿/AI/导出/Obsidian/设置
├── config.py      # 全局配置(环境变量覆盖 + 默认提示词)
├── settings.py    # 运行时设置(data/settings.json,改后立即生效)
├── tasks.py       # 双通道任务队列(heavy/llm)+ 持久化 + 重启自愈
├── transcribe.py  # ffmpeg 抽音 + 语言检测 + 三引擎转写 + 幻觉过滤
├── llm.py         # 标点/翻译/笔记/脑图/问答/随笔(map-reduce + 并行)
├── local_llm.py   # 进程内 mlx-lm(本地翻译,模型存 models/llm/)
└── static/        # 前端单页(vanilla JS,无构建步骤)
scripts/           # 启动器(幂等启动/打开) + 冒烟测试
models/            # 本地模型(自动下载,git 忽略)
data/              # 用户数据(上传/转写结果/设置,git 忽略)
```

## 常见问题

- **转写慢？** Paraformer（中文）约 16× 实时、SenseVoice 最快；Whisper large-v3-turbo 约 10× 实时。追求速度选前两者，外语内容选 Whisper。
- **日语视频被识别成中文？** SenseVoice 的自动语言检测易漂移，日语内容请用 Whisper 引擎并显式指定语言。
- **AI 功能报「无法连接 LLM 服务」？** 在设置页配置可用的 OpenAI 兼容端点并「测试连接」。
- **换机器 / 迁移？** 拷贝整个项目目录即可（含 `models/` 与 `data/`），无需重新下载模型。

## 路线图

- [ ] 实时录音流式转写
- [ ] 原生 App 打包（脱离浏览器）
- [ ] 说话人分离可视化编辑

## License

[MIT](LICENSE)
