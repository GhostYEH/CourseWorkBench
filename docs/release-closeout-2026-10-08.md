# 2026-10-08 工作区清理与提交

用户在完成本轮验收后明确要求清理项目文件夹，并通过代理推送 GitHub。本次提交包括此前未提交的设计计划清理、协议 5 / DB schema v34 的公共板书与公共 AI 工作流，以及 PBL 本人运行消费者。各批次原始证据见[公共教学收尾](closeout-2026-10-07.md)和[PBL 收尾](closeout-2026-10-08.md)。完整产品仍有剩余范围，继续以[待办事项](待办事项.md)为准。

## 提交前确认

- 最终源码通过 138 个测试文件 / 1357 项测试（0 跳过）、工程门禁 12/12、Electron 57 组、协议 5 双客户端 55/55、随包 Node 学习服务 14/14。发布整理没有修改产品源码，未重复执行已经通过的全量测试。
- 清理前核对当前 383 项输入、Next BUILD_ID `7rJaT38C5n95xrB-qffX6` 和学习服务清单；源 SHA-256 为 `c86a3cb792b151415f36d4631743e2ef0660b6b028fc9ca5d074d1eb3108b794`，清单为 13573 个文件。
- 清理后再次核对构建与服务指纹，无变化；20 份变更 Markdown 的 259 条仓库内链接/锚点检查通过。已迁移的历史产物改为原路径记录和归档说明，不保留失效的可点击入口。
- 远端为 `https://github.com/GhostYEH/CourseWorkBench.git`。通过本机 HTTP 代理 `127.0.0.1:7897` 拉取后，提交前的 `main` 与 `origin/main` 一致；不强制推送。

## 工作区整理

以下未跟踪的临时或生成内容已移至项目外的 `D:/File/Ai与辅助教学/.workspace-archives/subject-exam-workbench/20261008-094939/`，保留原目录结构及 `cleanup-manifest.json`：

- `.task-cache/`、`.playwright-mcp/`、`tmp/`：工具缓存、临时验证脚本和日志。最终 8 份验收日志已核实保留，旧脚本不作为可执行交接入口。
- `apps/learning/.next-build/`、`apps/desktop/release/`：过期的学习构建和旧桌面验收产物，合计约 13 GB；旧桌面包不能作为当前源码验收证据。
- 两份 `tsconfig.tsbuildinfo` 和随包 Node 的已下载 ZIP：可重建的增量缓存与下载缓存。

当前 `apps/learning/.next/`、`apps/learning/dist/service/`、`resources/node/runtime/` 与开发依赖保留。安装脚本及 `build/` 内跟踪文件保留；工具记忆、评测材料/报告和个人项目数据不当作垃圾删除。归档操作逐一检查绝对路径边界、跟踪文件及目标冲突，没有执行整仓库 `git clean`。

提交与代理推送完成后，使用 `git ls-remote origin refs/heads/main` 核对远端提交与本地 HEAD，再确认 Git 工作区干净。本次不生成新桌面安装包，也不把真实 provider、真人双设备或干净 Windows 验收标为完成。
