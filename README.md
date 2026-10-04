# 学科备考工作台

最终产品需覆盖本地 OpenMAIC 1.1.1 的全部产品能力；源码剖析、差距及实施批次见 [OpenMAIC 全功能分析](docs/OpenMAIC深度剖析与全功能对齐.md)，逐项跟踪见 [85 项必需清单](docs/openmaic-feature-parity.json)。此处范围是目标，当前实现状态见下文。

具有来源约束与多智能体互动课堂的 Electron 桌面学习系统。设计文档在 [`docs/`](docs/)，本目录是代码。

## 目录

```text
subject-exam-workbench/
├── apps/desktop/              Electron 主进程/preload（原生权限、凭据、服务生命周期）
├── apps/learning/             本地 Next.js 服务：备考工作台 + 学习空间 + 领域 HTTP 接口
├── packages/study-contracts/  错误码、状态枚举、IPC/HTTP 合同、设计令牌类型
├── packages/study-domain/     来源规范化与指纹、机械检查、审核、准入、题目身份、作答分区
├── packages/study-storage/    SQLite schema/迁移/事务收据/备份、项目目录布局
├── resources/node/            随包 Node（不进仓库）
├── scripts/                   主题 CSS 生成、随包 Node 下载、端到端验收脚本
├── tests/                     领域合同与第一阶段闭环测试
├── build/                     安装配置与图标
└── docs/                      设计文档包
```

## 环境

- Node >= 22.19.0（`node:sqlite` 需要 22.5+）
- pnpm 10.x（仓库声明 `packageManager: pnpm@10.28.0`）
- Windows x64 优先

```bash
pnpm install
```

安装包形态的资源准备（PACK-01 前置）：先运行
`node scripts/fetch-node-runtime.mjs` 下载随包 Node，再运行 `pnpm prepare:learning-dist` 生成
`apps/learning/dist/service`（standalone 平整布局 + 物化依赖并保留消费者版本 + server.mjs），
随后 `pnpm verify:service` 用随包 Node 实机启动验证。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm typecheck` | 三个 tsconfig 全量类型检查 |
| `pnpm check:code` | 分层与 DTO 边界、preload 同步、JavaScript 语法及构建一致性反例检查 |
| `pnpm check` | 类型、代码合同检查与全部测试 |
| `pnpm test` | 领域合同 + 第一阶段闭环（vitest，线程池） |
| `pnpm gen:theme` | 由 `docs/设计令牌.json` 生成 `apps/learning/app/theme-tokens.css` |
| `pnpm gen:preload` | 由 IPC 合同生成沙箱可加载的 preload |
| `pnpm dev:learning` | 以开发模式启动本地服务，并打开 `../.dev-project` |
| `pnpm build:learning` | 生成 standalone 构建并记录输入摘要与 BUILD_ID |
| `pnpm dev:desktop` | 启动 Electron 壳（自动拉起本地服务并握手） |
| `pnpm build:desktop` | 生成 preload 并检查桌面源码，尚不生成安装包 |
| `pnpm package:desktop` | electron-builder 生成未打包目录（PACK-01） |
| `pnpm verify:desktop` | 将目录包复制到临时中文空格路径，以实际 Electron exe 验证生产 SSR、preload、随包服务和隔离用户数据；报告写入 `apps/desktop/release/` |
| `pnpm verify:classroom` | 用实际目录包和原生项目选择器操作固定课堂，鼠标作答后关闭整应用，再重新授权项目读回；在开发机运行不等于干净 Windows 验收 |
| `pnpm dist:desktop` | 生成 Windows x64 NSIS 安装包（不会自动安装） |
| `node scripts/fetch-node-runtime.mjs` | 下载 Windows x64 随包 Node；运行服务产物准备前必需 |
| `pnpm prepare:learning-dist` | 构建并组装 standalone 服务产物，含随包 Node 的 native sharp 验证（`apps/learning/dist/service`） |
| `pnpm verify:service` | 用随包 Node 启动服务产物，验证握手、会话/控制凭据边界与受控退出 |

PACK-01 本地验收顺序：先运行 `node scripts/fetch-node-runtime.mjs`，再运行 `pnpm prepare:learning-dist`，随后
`pnpm package:desktop` 生成 `apps/desktop/release/win-unpacked`，最后运行 `pnpm verify:desktop`。
桌面验证会在系统临时目录创建随机 profile，并在 Electron 退出后清理；它会核对 Chromium 子进程
的 `--user-data-dir` 与 `desktop-state.json` 确实落在本次临时 profile。验证 JSON 保留在
`apps/desktop/release/`，包含逐项通过/失败记录。`pnpm dist:desktop` 单独生成 NSIS 草包，
不代表已在干净 Windows 环境完成安装验收。

在 `pnpm build:learning` 后，可运行 `node scripts/run-electron-boundary-smoke.cjs` 验证真实 Electron 隐藏窗口的 preload、页面/API 认证、iframe 隔离与项目页面切换。测试用受控临时目录替代系统选择器，不代表安装包验收。

安装与卸载试验入口为 `scripts/verify-installed-desktop.ps1`：先拒绝已有同产品安装，再安装一份新的测试产物，使用随包 Node 执行原生选择器和课堂 UI 验证，最后卸载测试应用并核对项目清单与数据库仍保留。失败时保留测试目录供检查。它在开发机运行只能证明本机安装态；独立 Windows 用户或 VM 仍须单独验收。

端到端验收（需要本地服务已启动）：

```bash
TOKEN=$(grep -o '"sessionToken":"[a-f0-9]*"' <服务日志> | head -1 | cut -d'"' -f4)
BASE=http://127.0.0.1:<端口> TOKEN=$TOKEN bash scripts/smoke-first-phase.sh
```

## 当前开发边界

**M0 尚未完成独立环境签核，M1 已开始**：固定课堂采用上游播放核心、渲染器，以及实际原 ClassroomSurface 的页面加载、重试、退出取消与显示准入流程；文档、资产和来源权限由本地服务承接。教师/白板/Director、编辑和媒体生成按后续里程碑推进。
本机验收覆盖原生选择器、鼠标测验与互动明确提交、整应用重启读回、项目切换与服务故障恢复。用户确认目前暂无独立环境，先完成代码与本机验收；PACK-02 继续保留，不据此宣称 M0 全部通过。

当前采用的上游部分：DSL、幻灯片渲染器与文档客户端按固定版本从已发布 MIT 包取得
（`@openmaic/dsl@0.11.2`、`@openmaic/renderer@0.1.11`、`@openmaic/storage@0.35.1`）；`/classroom/[id]`
用上游 `HttpDocumentStore` 合同读文档、用上游 `SlideCanvas` 渲染幻灯片，测验与参数实验互动使用真实 DSL
场景形状，测验与互动视图由本项目实现。演示导入须用户明确确认，页面读取不写审核知识；文档下发复验实际摘要、来源与测验题目绑定。
文档、来源绑定、播放位置、RuntimeStore 有序事件与 KV 落在 SQLite；本人提交、服务 review 与去重收据在同一事务保存，客户端不能直接写权威判分。安装态 UI 已重启读回同一答案和解题过程，未重复计数。
Electron 冒烟覆盖演示渲染、显式导入与 iframe 隔离。上游快照源码级构建阻断与采用范围见适配记录。
演示幻灯片的 PNG 和公式字体经真实 `HttpAssetStore` 下载，SQLite 保存字节、内部摘要与稳定引用；
浏览器复验字节并加载字体后才显示课堂。字体与直接采用的播放核心许可随服务产物保留；被课程引用的资产禁止删除或替换，离线回收与大媒体仍待补齐。
演示内容使用独立机器范围，正式查询默认排除演示；演示编者审核与用户语义审核区分。独立来源审核入口为 `/workbench/review`，仍须以正式考纲和真实材料完成走查。
M1 已补严格 UTF-8 解码、空正文拒绝、不可变材料历史版本和固定版本段落链接；文件导入还会按版本原样归档
原始字节与其 SHA-256，段落记录原文中的字节区间与行号，可读取归档原文并在主进程复验路径归属后打开项目内
原文副本；粘贴导入与升级前的历史版本明确标记为未归档，不宣称可打开原文。
考纲原子项落在 `syllabus_items`：`/workbench/syllabus` 登记条目与必要要素（同一范围内考纲编号唯一，重复登记被拒绝），
审核时把知识点绑定到条目内单个必要要素，覆盖率按条目计数（完整/部分/未覆盖分列，必要前置与未准入知识点不进分子），
条目一经登记后「考纲内」候选必须完成映射才能批准；评测页的覆盖率分母改用登记条目数，未登记时显示为分母未建立。
真题出处核对入口在材料版本页：勾选确认后写入服务端权威记录（重复提交只更新同一条，材料新版本需重新核对），
题目身份据此派生，自称真题不改变身份。
可用 `node scripts/prepare-m0-acceptance-kit.mjs` 生成无需仓库或开发 Node 的外部验收包，生成工具包本身不代表 PACK-02 通过。
下一项依赖与剩余工作见 [待办事项](docs/待办事项.md)，完整验收要求见 [开工任务清单](docs/开工任务清单.md)；
基线核实与采用登记见 [上游适配记录](docs/upstream-adaptation.md)。

## 尚未实现（按里程碑）

- M0 剩余：无开发 Node 的独立干净 Windows 安装/错误恢复验收；正式材料语义审核与独立环境风险仍需签核。当前 M0 宿主流程不代表完整 OpenMAIC 接入
- M1：真实考纲拆分与科目材料走查、来源审核与计划闭环、安装态打开原文验证、后续存储适配和安全回收
- M2：课程生成接入、真实教师/白板、两种二维互动、题目与场景来源侧表
- M3：AI 同学、错题归因、分层恢复、预算
- M4：评测指标冻结与攻击集、Windows 安装验收、演示录屏

模型连接尚未配置；未配置时相关入口明确显示不可用，不伪造进度。

## 约定

具体代码约定和检查入口见 [`docs/code-quality.md`](docs/code-quality.md)。

- 领域核心不依赖 React / Electron / Next；`packages/study-domain` 只做判断，不做 IO。
- 本地服务是唯一数据库写入者；Electron 主进程不打开数据库。
- 页面不散落硬编码色值，颜色与尺寸只来自 `theme-tokens.css` 的变量。
- 状态同时用文字与图标表达，不能只靠颜色区分。
- 界面文案使用「引用可定位」而不是「内容正确」，「草稿已保存」而不是「知识已确认」。

## 第三方来源

见 [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md)。上游复用清单与逐项改动记录见
[`docs/upstream-adaptation.md`](docs/upstream-adaptation.md)。
