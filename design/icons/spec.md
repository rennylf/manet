# Manet 图标系统规范 V1.0

> 克制、精致、理性、古典、现代。
> 图标是产品视觉语言的一部分：像精心编辑的书籍，细节统一、表达克制。

## 1. 基础网格

| 规则 | 值 |
|---|---|
| 画布 | 24 × 24 |
| 活区（live area） | 20 × 20（四周留白 2） |
| 线宽 | 1.5（全尺寸统一，随 viewBox 等比缩放） |
| 端点 / 转角 | round cap / round join |
| 几何转角半径 | 1 – 1.5 |
| 坐标 | 对齐 0.5 网格，避免半像素模糊 |
| 填充 | 默认纯线框；仅「状态点 / 品牌心点 / 省略点」用局部填充（class `.f`） |

## 2. 色彩

图标一律 `stroke: currentColor`，由上下文文字色驱动，不写死颜色：

| 上下文 | 颜色 | 场景 |
|---|---|---|
| 默认 | 墨灰 `#292824` / 灰褐 `#858176` | 正文区、次级按钮 |
| 强调 / 选中 | 复古棕 `#806B50` | 激活导航、主按钮、品牌标记 |
| 深色媒体画面 | 暖白 `#F7F5F0`（`.on-dark`） | 视频区浮层控件 |
| 状态 | 绿 `#6E8B5E` / 赭 `#9A7B2F` / 砖红 `#A6503C` | 仅状态图标（完成/进行/失败） |

## 3. 尺寸

| 尺寸 | class | 场景 |
|---|---|---|
| 14px | `.icon-14` | 按钮内、密集列表、菜单前缀 |
| 16px | `.icon`（默认） | 导航、工具栏 |
| 18px | `.icon-18` | 播放器、弹窗标题、任务行 |
| 20px | `.icon-20` | 品牌标记 |

## 4. 状态体系

| 状态 | 表现 |
|---|---|
| 默认 | 继承 currentColor |
| 悬停 | 随按钮文字色过渡到复古棕（`transition: color .12s`） |
| 选中 / 激活 | 复古棕；列表行可配浅棕底 `#EFEBE1` |
| 禁用 | `opacity: .45`（`button:disabled .icon`） |
| 进行中 | `.spin` 旋转动画（仅 `i-running`） |
| 局部填充 | `.f` 子元素 `fill: currentColor; stroke: none` |

## 5. 命名与扩展

- 命名：`i-<语义>`（动词/名词小写连字符），不使用编号。
- 新增图标：按第 1 节网格绘制 → 加入 `app/static/index.html` 顶部 sprite →
  同步 `design/icons/sprite.svg` 与 `design/icons/svg/<id>.svg` → 在本表登记。
- 禁止：emoji、外部图标库、魔法棒 / 闪光 / 机器人等套路化 AI 符号、
  羽毛笔 / 古书等具象古典元素、渐变与阴影。

## 6. 替换映射表（旧 → 新）

| 旧（emoji / 字符） | 新图标 | 位置 |
|---|---|---|
| 🎙️（logo / 转写） | `i-mark` / `i-wave` | 侧栏 logo / 任务行 |
| 📚 内容库 | `i-archive` 档案库 | 侧栏导航 |
| ⚙️ 设置 | `i-settings`（滑杆） | 侧栏导航 / 设置弹窗 |
| ＋ 上传 | `i-import` | 侧栏主按钮 |
| 📁 文件夹 / 新建文件夹 | `i-folder` / `i-folder-new` | 文件夹条 / 首页 / 卡片菜单 |
| ⋯ 更多 | `i-more` | 顶栏 / 卡片管理 |
| ← 返回 | `i-back` | 详情顶栏 |
| ✏️ 编辑 | `i-edit` | 转写工具栏 |
| 🌐 翻译 | `i-translate` | 转写工具栏 / 任务行 |
| （语言切换无图标） | `i-globe` | 工具栏语言分段控件前缀 |
| ⬇️ 导出 / ⬇ PNG / 💾 保存 | `i-export` / `i-download` | 顶栏 / 脑图弹窗 / 任务中心 |
| 🧠 脑图 | `i-mindmap` | 顶栏 / 脑图弹窗 |
| ✍️ 随笔 | `i-essay` | 顶栏 / 随笔弹窗 |
| ✨ AI 笔记 / AI 解读 | `i-interpret`（页边批注线） | 顶栏 / 任务行 |
| （问答无图标） | `i-chat` | 图标集预留 |
| 我的笔记 | `i-note` | 图标集 / Obsidian 导出按钮 |
| ▶ / ⏸ | `i-play` / `i-pause` | 播放栏 / 任务暂停继续 |
| 🔊 / 🔇 | `i-volume` / `i-mute` | 播放栏 |
| （倍速无图标） | `i-speed` | 播放栏倍速选择前缀 |
| ✅ / ❌ /  | `i-done` / `i-error` / `i-running` | 状态反馈 / 任务球 |
| ⏳ / 💾 任务球 | `i-running`(spin) / `i-download` | 右下任务球 |
| 📝 ✨ 🎬 任务行 | `i-interpret` `i-punct` `i-film` | 任务中心 |
| ⛔ 终止 | `i-close` | 任务中心 |
| ✕ 关闭 | `i-close` | 全部弹窗 |
| ↻ 重新生成 | `i-regen` | 脑图 / 随笔弹窗 |
| − / ＋ 缩放 | `i-zoom-out` / `i-zoom-in` | 脑图弹窗 |
| 适应 | `i-fit` | 脑图弹窗 |
| 📓 Obsidian | `i-note` | 导出菜单 / 随笔弹窗 |

## 7. 资产清单

- `app/static/index.html` 顶部内联 sprite（生产环境唯一来源，36 枚）
- `design/icons/sprite.svg` — 独立 sprite 资产
- `design/icons/svg/*.svg` — 36 枚单文件（设计稿 / 其他端直接用）
- `design/icons/specimen.html` — 设计稿：全图标 × 尺寸 × 背景 × 状态 + 界面应用示例
