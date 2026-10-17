# 仓库工作约定

## UI / 文案变更

- 任何界面设计、样式、组件、文案的调整，**必须先对照 `design/DESIGN.md`**（色彩/字体/布局/组件/语气）
  与 `design/icons/spec.md`（图标网格/线宽/状态/映射表）。
- 与规范冲突时：先更新规范文档，再改代码；禁止一次性特例样式。
- 新增图标：加入 `app/static/index.html` 顶部 sprite → 重新生成 `design/icons/` 资产 → 登记映射表。
- 禁止引入 emoji、外部图标库、CSS 框架或构建步骤（前端保持 vanilla JS 单页）。

## Git / 发布

- **Agent 默认不推送。仅当用户在本次任务中明确要求推送到 GitHub 时才执行 `git push`；
  未明确要求时只做本地提交。** 打标签推送、创建/更新 GitHub 资源同样需要明确指示。
- 提交信息用中文简述动机与范围；结尾保留 Co-Authored-By 行。

## 验证

- 交付前仅做秒级检查：`python3 -m py_compile`、`node --check`、服务可启动、必要时一条 curl 冒烟。
- 不做冗长自动化测试/无头浏览器复现/多轮截图自证；由用户体验后反馈再修。
