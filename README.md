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

在 `pnpm build:learning` 后，可运行 `node scripts/run-electron-boundary-smoke.cjs` 验证真实 Electron 隐藏窗口的 preload、认证/iframe、项目切换、正式三题型/评分、个人房间/白板、正式参数/关系互动、个人 UID/剪贴板和数据库重开。测试用受控临时目录替代系统选择器，不代表整应用故障恢复、安装包或双设备验收。

安装与卸载试验入口为 `scripts/verify-installed-desktop.ps1`：先拒绝已有同产品安装，再安装一份新的测试产物，使用随包 Node 执行原生选择器和课堂 UI 验证，最后卸载测试应用并核对项目清单与数据库仍保留。失败时保留测试目录供检查。它在开发机运行只能证明本机安装态；独立 Windows 用户或 VM 仍须单独验收。

端到端验收（需要本地服务已启动）：

```bash
TOKEN=$(grep -o '"sessionToken":"[a-f0-9]*"' <服务日志> | head -1 | cut -d'"' -f4)
BASE=http://127.0.0.1:<端口> TOKEN=$TOKEN bash scripts/smoke-first-phase.sh
```

## 当前开发边界

**M0 有本机基线，M1 主要工作面已实现，M2/M3 仍有剩余范围**：课程具备冻结证据、审核/发布/撤回、持久教师会话、停止控制、正式幻灯片与三题型测验；简答人工审核/模型待审候选不改写原提交。离线 UID、个人房间/教师租约、审核白板、正式参数/关系互动和模型台账已有实现。同学命令的界面更新、来源/租约校验、统一预算及四层恢复门禁已修复；AI 错因与复习建议保存为待审候选。公式排版、独立预测及互动安全公共投影已加入。下一项工作以[待办事项](docs/待办事项.md)为准；主智能体直接实施。
本机验收覆盖原生选择器、鼠标测验与互动明确提交、整应用重启读回、项目切换与服务故障恢复。用户确认目前暂无独立环境，先完成代码与本机验收；PACK-02 继续保留，不据此宣称 M0 全部通过。

使用正式测验：先完成知识点来源审核和计划确认，再到「课程与讲解」登记题目与评分规则；在证据包选入这些题目，创建课程版本、人工审核并发布，随后生成课件文档并进入课堂。简答题提交后显示待判分，点击「核对评分」进入错题本，填写得分、依据、不确定性并确认语义核对即可保存人工评分。模型候选需要已启动运行、可用连接及剩余额度，必须手动请求和人工审核；候选本身不更新掌握。

历史本机目录版：[阶段目录程序](apps/desktop/release/stage-handoff-2026-10-04/win-unpacked/学科备考工作台.exe)，对应构建 `2oj_FjjcGYi2uTYty5UUh`。其随包服务 14/14、[目录包 30/30](apps/desktop/release/stage-handoff-2026-10-04/pack01-verification.json)、12,254 文件摘要核对均通过；该产物早于新增同学/预算/恢复源码，不能作为新功能的分发验收。真实材料金标准和真人双设备验收按用户要求暂缓；原已安装程序不会自动升级。

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
条目一经登记后「考纲内」候选必须完成映射才能批准；正式评测使用独立冻结的原子要求与金标准，工作区登记数不自动成为核心评测分母。
真题出处核对入口在材料版本页：勾选确认后写入服务端权威记录（重复提交只更新同一条，材料新版本需重新核对），
题目身份据此派生，自称真题不改变身份。
未被课件绑定的课堂资源可在「科目设置」显式回收：读取只报告不删除，回收途中出现绑定整批取消，
重复提交按幂等处理，正式与演示分区互不越界；材料版本与原始归档不可删除，证据链优先于磁盘整理。
工作台侧栏是三层项目树（项目→分组→条目），条目链接固定到具体记录锚点，支持方向键展开折叠与 Enter 激活；
分区导航用「当前页」标记，不声明并不控制面板的 tablist。`node scripts/run-electron-boundary-smoke.cjs` 覆盖这些渲染器行为。
计划草案支持逐条人工确认，只有已确认版本能启动备考 run：run 按「项目 + 计划版本」的收据去重，
冻结知识点摘要、材料版本、教学偏好与角色配置摘要，重复启动读回既有 run 与事件，不重放已提交动作。
角色档案（教师唯一、同学至多两名）只配置表达方式，权限由服务端按类型派生且合同拒绝客户端自报权限。
计划载荷、运行快照、步骤收据与运行事件都改为版本化 schema 读写：损坏数据可诊断拒绝，恢复不消费损坏收据（N8 已闭合）。
界面 HTTP 调用必须提供响应 schema，实际 JSON 的信封与 DTO 校验通过后才进入界面；异常 JSON、缺字段与 HTTP 失败不会显示为保存成功。课程接口已显式映射 DTO，缺失课程返回 `NOT_FOUND`。课程草案须由本地用户审核通过后才能发布，撤回与被新版本取代分列；模型草案生成先过 run、额度、来源与审核四道判定，判定不通过时不向模型服务发出任何请求，返回正文只作为草案记录。
可用 `node scripts/prepare-m0-acceptance-kit.mjs` 生成无需仓库或开发 Node 的外部验收包，生成工具包本身不代表 PACK-02 通过。
下一项依赖与剩余工作见 [待办事项](docs/待办事项.md)，完整验收要求见 [开工任务清单](docs/开工任务清单.md)；
基线核实与采用登记见 [上游适配记录](docs/upstream-adaptation.md)。

## 当前验证

2026-10-05 本轮复查以核心提交 `a039835` 和源码摘要 `6f9bc7d7a99855164e756461e21f41981b69c4920861f66f2a4baa1e2f77b4d7`（299 个构建输入）为准。当前 BUILD_ID 为 `3EXxKtlNjqFaWCVH8X4Bn`；同一源码于 13:50 和 13:54 再次构建后编号更新，旧 `review-2026-10-05-luna` 目录保留作历史，新目录包按最新编号组装并核验。

- `pnpm check`：**93 文件 / 817 项通过、0 跳过**；类型（含真实 IPC）、lint、清单内格式与 12 项工程门禁通过。
- 最新真实 Electron 原生冒烟第五、六跑：**36 组通过**，含真实 OS 剪贴板复制；不发远程 provider 调用。此前第一跑 generic renderer error、第二跑剪贴板 UID 不匹配、第三跑 36 组通过、第四跑在 `classroom-widget-isolated` 阶段 generic renderer error。新增诊断保留原断言，只记录 workbench/formal quiz 阶段、静态异常类型、受控 `hitTag` 枚举、`associatedLabel` 布尔值和剪贴板六个布尔值；异常根因仍未确认。
- 随包服务：组装清单 **12376 文件**，源码摘要、BUILD_ID 与 SHA-256 一致；启动验证 **14/14**。最新 production HTTP 冒烟：**3 个文件 / 21 项通过**。
- 新桌面目录包：`apps/desktop/release/review-2026-10-05-luna-final/win-unpacked`，实际启动 **30/30**、随包课堂 **50/50**。机器报告为同目录的 `pack01-verification.json` 与 `classroom-verification.json`；既有 `win-unpacked`、NSIS 与安装态未覆盖。

本阶段集成命令 scope 写保护、同学失效结果提示与权威重读、课堂文档严格 UTF-8/32 MiB 边界及真实上游客户端回归，并忽略保留评测生成结果。补漏修复：课程派生按实际所选 ID 集合判断变化，默认标题后缀不算用户改动；已知 SQLite 损坏错误在完整性读取阶段也返回明确诊断，原项目、备份与清理规则保持。全部实质改动经独立只读复核。

本轮按用户要求由 GPT-6 Luna / xhigh 子智能体执行并独立复核，主智能体核验：模型原生回执与状态读取分开处理，未知保存方式不宣称已加密，规范化地址仍可确认，失败读回不诱导重复测试；备份补齐 Windows 非法字符/保留设备名的提前拒绝，38 项回归核验数据保护并允许合法 COM10。

原生冒烟六次结果依次为 generic renderer error、个人档案 OS 剪贴板 UID 不匹配、36 组通过、在 `classroom-widget-isolated` 阶段 generic renderer error、第五、六跑各 36 组通过（含真实剪贴板）。新增 smoke 诊断记录 workbench/formal quiz 阶段、静态异常类型、受控 `hitTag` 枚举和 `associatedLabel` 布尔值；剪贴板诊断仅六个布尔值，既有断言保留。前述异常根因未确认，继续作为 EVAL-03/UX-01 待观察项，不声称根因或剪贴板缺陷已修复，也不记录剪贴板内容、UID 或凭据。

随包课堂 50 项不包含备份恢复，也不代替失效提示的完整 DOM 生命周期验收。真实材料金标准、真人双设备、独立干净 Windows、真实付费 provider 继续按用户要求暂缓；正式安装升级卸载本轮未执行。M1—M4 的未完成范围见[待办事项](docs/待办事项.md)，当前交接见[阶段交接](docs/optimization-handoff-2026-10-05.md)。既有审查报告保持删除。

## 剩余范围（按里程碑）

- M0 剩余：无开发 Node 的独立干净 Windows 安装/错误恢复验收；正式材料语义审核与独立环境风险仍需签核。当前 M0 宿主流程不代表完整 OpenMAIC 接入
- M1：主要工作台闭环已有实现；仍需真实考纲与科目材料走查、安装态打开原文与角色设置走查，以及大媒体存储与随包备份策略，尚未整体验收完成
- M2：模型完整课件草案生成与陈述正文级改写、其余互动/PBL，以及当前产物和真实整课验收。已落地：教师聚焦作用于真实画布元素（高亮随冻结场景生效、切场景收回）、以稳定条目标识逐场景勾选派生新草案版本并强制重新审核
- M3：受控模型同学讨论、复习调度、完整冻结配置计量与费用依据、整应用故障和在线身份/邀请/同步/交流
- M4：冻结评测与合成机械工具已有实现；仍需当前产物走查、真实金标准、完整故障矩阵、Windows 安装验收和演示录屏

模型连接可在「科目设置 → 模型连接」填写自己的 HTTPS API 地址、模型名称和密钥；已有配置从实际状态读回。系统加密可用时保存加密凭据，不可用时只在本次应用会话保留并显示提示；密钥不随代码、项目或安装包分发。配置或测试的原生操作完成后，状态读取失败会保留操作回执并提示仅重新读取状态；无法确认保存方式时不会声称已加密保存，测试不会自动重放。课程页已有受约束的生成与讲解工作面；连接测试通过不能替代真实来源材料下的一节课验收。

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
