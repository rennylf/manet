# Manet

> *Quod manet, manet.* — 留下来的，依然留下。
> *What remains, remains.*

Manet 是一场个人产品实验：探索知识工作者如何用语音与文本思考、生产意义，并改变生活。

它不记录一切。它帮你决定什么值得仍在。

声音在本地转写为文字（Apple Silicon 全本地推理，数据不出机器），
再经 AI 解读：摘要、章节、随笔、脑图、问答。
文本不是终点，意义才是；保存不是目的，解读才是。

> 名字取自拉丁语 *manet*（它留下 / 它仍在）。
> 与法国画家 Manet（马奈）无关；本项目为独立个人作品。

## 产品哲学

- 不是所有话都值得留下，但有些必须仍在。
- 文本不是终点，意义才是。
- 保存不是目的，解读才是。
- Manet 不承诺记录真相。它保存的是你此刻的叙述——以后你可以重读、改写、覆盖。
  重要的不是当时到底怎样，而是你现在如何理解。

## 功能一览

**转写（全本地）**
- 三种转写引擎，设置页 / 导入弹窗可切换：

  | 引擎 | 特长 | 适用 |
  |---|---|---|
  | `whisper`（默认） | 多语种、语言检测稳（多点采样投票） | 日 / 英等外语内容 |
  | `paraformer` | 原生标点 + 说话人分离 + 热词，约 16× 实时 | 中文会议 / 访谈 |
  | `sensevoice` | 速度最快、多语种、VAD 时间戳 | 快速出稿 |

- 热词 / 专有名词注入；Whisper 幻觉过滤
- AI 标点恢复 + 断句合并（Whisper 转写后自动执行，时间戳对齐不丢）
- 双通道任务队列：暂停 / 继续 / 终止；服务重启自动恢复中断任务

**AI 解读**
- **解读笔记**：摘要 / 章节速览（点击跳原声）/ 待办 / 关键词
- **随笔**：把长转写稿改写为主旨明确、内容精炼的文章，提示词可自定义
- **思维导图**：三层树（主题 → 章节[带时间戳] → 要点），可折叠 / 缩放 / 导出 PNG
- **问答**：向这段留存提问，回答带可点击的时间点引用
- **翻译**：逐句对齐保时间戳，原文 / 中文 / 双语三态；可走本地模型（mlx-lm），零费用

**留存与导出**
- 段落式正文：点击跳转播放、当前句高亮、稿内搜索、在线编辑纠错
- 我的札记：随手记录，自动保存
- 导出 Markdown / TXT / SRT（原文 / 中文 / 双语）
- 软字幕封装：SRT 混流进 MP4 / MKV，播放时可开关，流拷贝秒级完成
- 一键导出 Obsidian 知识库（frontmatter 与导出内容可配置；随笔单独导出，文件名即随笔标题）
- 档案库管理：文件夹、搜索、重命名、移动、删除

## 系统要求

- macOS，**Apple Silicon**（M1 及以后；MLX 推理依赖）
- [ffmpeg](https://ffmpeg.org/)（`brew install ffmpeg`）
- [uv](https://docs.astral.sh/uv/)（`brew install uv`）
- 磁盘约 **10GB**（模型首次运行自动下载到项目 `models/`）
- 可选：任意 OpenAI 兼容 LLM 端点（解读 / 问答 / 随笔 / 标点恢复 / API 翻译）。
  **不配置也能用**：转写、编辑、导出完全离线。

## 快速开始

```bash
git clone https://github.com/rennylf/tingwu-local.git
cd tingwu-local
uv sync          # 安装依赖（首次）
./start.sh       # 启动，浏览器打开 http://127.0.0.1:8642
```

把声音放进来，选择引擎与语言，开始转写。
首次转写自动下载模型（HuggingFace / ModelScope）：

| 模型 | 用途 | 大小（约） |
|---|---|---|
| `mlx-community/whisper-large-v3-turbo` | Whisper 转写 | 1.6 GB |
| `iic/speech_seaco_paraformer_*` + VAD / 标点 / 说话人 | Paraformer 引擎 | 1.5 GB |
| `iic/SenseVoiceSmall` | SenseVoice 引擎 | 0.9 GB |
| `mlx-community/Qwen2.5-3B-Instruct-4bit` | 本地翻译（可选） | 1.6 GB |

> 大陆网络建议走镜像：启动前 `export HF_ENDPOINT=https://hf-mirror.com`。

## LLM 配置

推荐在网页「⚙️ 设置」中配置，保存到 `data/settings.json`，立即生效、无需重启：
Base URL / API Key / 模型名、翻译引擎（本地 mlx-lm 或 API）、随笔提示词、Obsidian 导出路径与内容。

也可用环境变量（优先级低于设置页）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:23333/v1` | OpenAI 兼容端点 |
| `LLM_API_KEY` | 空 | API Key |
| `LLM_MODEL` | `deepseek:deepseek-chat` | 模型名 |
| `WHISPER_MODEL` | `mlx-community/whisper-large-v3-turbo` | MLX Whisper 仓库 |
| `TRANSLATE_MODE` | `local` | 翻译走本地或 API |
| `LOCAL_MODEL_REPO` | `mlx-community/Qwen2.5-3B-Instruct-4bit` | 本地翻译模型 |
| `ASR_ENGINE` | `whisper` | 默认转写引擎 |
| `POLISH_ENABLED` | `1` | 转写后自动标点恢复（仅 Whisper） |
| `LLM_MAX_CHARS` | `24000` | 超长文本 map-reduce 阈值 |
| `MAX_UPLOAD_MB` | `2048` | 上传大小上限 |

所有 LLM 调用都有超时 + 重试 + 兜底：标点失败保留原文，单块失败不影响整体。

## 项目结构

```
app/
├── main.py        # FastAPI 路由:导入/任务/正文/解读/导出/Obsidian/设置
├── config.py      # 全局配置(环境变量覆盖 + 默认提示词)
├── settings.py    # 运行时设置(data/settings.json,改后立即生效)
├── tasks.py       # 双通道任务队列(heavy/llm)+ 持久化 + 重启自愈
├── transcribe.py  # ffmpeg 抽音 + 语言检测 + 三引擎转写 + 幻觉过滤
├── llm.py         # 标点/翻译/解读/脑图/问答/随笔(map-reduce + 并行)
├── local_llm.py   # 进程内 mlx-lm(本地翻译)
└── static/        # 前端单页(vanilla JS,无构建步骤)
scripts/           # 启动器 + 冒烟测试
models/            # 本地模型(自动下载,git 忽略)
data/              # 你的留存(上传/转写结果/设置,git 忽略)
```

## 设计

Light Academia × Editorial：暖白、墨灰、复古棕、细分隔线；宋体正文，无衬线功能界面。
克制、安静、书卷气——深夜图书馆，而非喧嚣的效率机器。

## 常见问题

- **转写慢？** Paraformer（中文）约 16× 实时、SenseVoice 最快；Whisper 约 10× 实时。
- **日语被识别成中文？** SenseVoice 语言检测易漂移，日语内容请用 Whisper 并显式指定语言。
- **解读报「无法连接 LLM 服务」？** 在设置页配置可用端点并「测试连接」。
- **换机器？** 拷贝整个项目目录（含 `models/` 与 `data/`），无需重新下载模型。

## 路线图

- [ ] 实时录音流式转写
- [ ] 原生 App 打包（脱离浏览器）
- [ ] 说话人分离可视化编辑

## License

[MIT](LICENSE)

*长日将尽，遗思仍在。*
