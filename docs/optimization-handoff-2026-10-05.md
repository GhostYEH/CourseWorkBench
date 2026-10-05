# 全面优化交接 · 2026-10-05

本记录按用户最新要求供其他智能体接手。目标是完成已有全面优化和集成验收。产品尚未实现的功能另见 `待办事项.md`；不要将代码重构完成解释为产品全部完成。工作区仍被另一项任务并行修改，下列内容是交接时快照，接手后先重新核对。

## Git 与并行工作

- 项目：`D:\File\Ai与辅助教学\subject-exam-workbench`，PowerShell，当前分支 `main`。
- 最近提交：`68e05ca` 保存此前源码及阶段进度；`6d423bb` 保存暂停记录；本轮收尾连同并行任务改动一起提交为 `7067679`（97 个文件，含全部新增模块与其测试）。
- 接手时上述恢复代码仍在工作区且含未跟踪新源码/测试，不能只用 `git diff` 判断完整范围；现已入库，`scripts/evaluation/artifacts/` 是生成结果，仍不提交。
- 工作区有并行任务的改动，应保留并整合备份/恢复、评测工具、课堂生命周期、模型状态订阅及 IPC 契约检查。编辑前重新读取文件；不要 reset、clean 或还原他人的修改。
- `.task-cache/` 不进 Git，可能含凭据：不要读取、运行其中脚本、删除或提交其内容。构建产物、`.next*`、`stale-*`、release 和缓存不属于真实源码；保留 `apps/desktop/build/` 等安装资源。

## 已落地的优化

1. HTTP 公共错误映射、详情清理、作用域校验和流式实际字节限制；共享 HTTP 合同拆成 `study-contracts/src/http/`，保持显式公开入口。
2. `StudyStore` 的课堂命令、模型计量关联拆到 `study-storage/src/services/`；模型用量汇总移入领域层；权威 JSON 读取、内容范围和迁移定义整理，保持公开方法及历史迁移语义。
3. `apps/learning/lib/server/model-call.ts` 拆为准入、调用、复验和事务结算阶段。业务拒绝白名单使用真实 `StudyErrorCode`；等待期间的 JSON 损坏/读取故障直接上抛，保留 started 预占，同一请求不重复派发。项目代次复验失败后不能再访问旧数据库。
4. `command-gate.ts` / `use-command.ts` 统一同步防重、取消、作用域和过期结果控制；旧请求不能清除新作用域的 busy/error，完成回调抛错也释放自身锁。评分、练习、反馈、个人课堂、AI 同学、个人档案已接入。档案仍保留 SSR 初始错误、UID 和 revision 冲突规则。
5. `QuizSceneView.tsx` 的生命周期提取到 `use-quiz-attempt-session.ts`，恢复逻辑合并；串行草稿写入、64 次尾序号冲突重试、提交摘要/nonce、作用域 headers 和持久收据保留。
6. 课程 GET/POST 编排移入 `lesson-service.ts`。课程目录在事务中批量读取，固定 5 次查询并按原有顺序组装；24 版本回归验证响应和项目隔离。模型用量仓储也改为批量解析行，移除逐条再次 get 的查询。
7. 新增 `tests/helpers/verified-knowledge.ts`，基础闭环测试复用正常审核种子；审核行为测试仍显式测试审核流程。
8. 根脚本接入 lint、限定范围格式化及 `check`；质量脚本拆分，共享真实源码枚举和 AST 依赖分析。另一项任务补充相对导入/CJS 分层、ESLint 及真实 native handler 的 IPC 语义检查。
9. 模型状态订阅具备可见错误、重试和会话隔离；课堂 token 轮询改用事件等待。首次配置/修改模型引起表单重挂载而丢失保存回执的问题已修复，新增实际 Electron 回执脚本尚未运行。
10. 完整项目目录备份/恢复已贯通 contracts/storage、原生选择器/IPC、控制 API 和界面：一致性 SQLite 快照、项目清单、归档原文/资产/导出、逐文件 SHA-256、UID/版本校验、暂存迁移及新目录发布。只保留外部路径元数据，不读取原外部文件，不包含用户身份文件、密钥或会话。普通项目清单也严格校验，损坏时在创建布局前拒绝；项目打开响应返回真实 formatVersion。
11. 冻结评测 schema、四项指标重算、摘要复验、CLI、临时生产 SQLite 机械攻击 runner、只读受 scope 约束的报告导入 API 和页面已实现。缺失输出不缩分母、空分母为 null，真实/合成、开发/测试/攻击和审核前后分开。A/B/C 比较已补构建及 Node/platform/arch 一致性检查。合成 11 用例通过，伪装检出 4/4、合法原题误拦 0/1；真实材料、语义及人工审核后仍未运行。
12. 改写题冒充真题原题的漏洞已修复：登记材料的 rewrittenFrom 只赋予 material_rewrite，自报 exam_original 标记伪装，已纳入固定攻击回归。N3 实际 native handler 通过 @ts-check、IpcContract 派生的参数与返回约束、unknown 结果验证以及实际源码漂移编译反例；依赖实现仍由类型端口建模，不代表整桌面依赖图全面 checkJs。

## 已执行验证与当前阻断

- 2026-10-05 09:17–09:26 对同一份源码内容（294 输入，SHA-256 `702b951ac01bdceab682e2aca632a01a3d74a9083834df630d0f4600af4a4f8c`，BUILD_ID `XTlrKzxq10meglOGXaEWK`）依次完成：`pnpm check` 全绿（typecheck 含 `typecheck:ipc`、lint、清单内 format:check、check:code 的 12 项工程反例与 20 个 preload 白名单方法，**89 文件 / 765 项测试通过、0 跳过**）；`node scripts/run-electron-boundary-smoke.cjs` **36 组通过**，含完整备份 native 链路与模型配置回执；`prepare-learning-dist.mjs` + `verify-learning-dist.mjs` **14/14**；`pnpm package:desktop` + `verify-packaged-desktop.mjs` **30/30**。
- **课堂走查未运行（并发导致，非缺陷）**：09:27 并行任务对**相同源码摘要**重新构建，得到新 BUILD_ID `0NaV76pOveX7LuPE577M_`，使本轮组装的 `dist/service` 与 `win-unpacked`（记录 `XTlrKzxq10meglOGXaEWK`）落后一版；`node scripts/verify-classroom-desktop.mjs` 按 bundle 清单的 buildId 拒绝启动。重跑 `node scripts/prepare-learning-dist.mjs` 与 `pnpm package:desktop` 后即可继续该走查；源码内容未变，之前的门禁与冒烟结果仍适用于当前源码。
- 独立 `code_reviewer` 只读复核评测解码边界与同学/个人档案命令迁移：**未发现确认缺陷**。已落实其两项建议：解码诊断随 `details.error` 返回、路由层补非法 UTF-8 与缺正文断言。两项遗留需要产品判断，未擅自改动：同学面板 `useCommand` 的 key 含会话 `status`，别处更新状态会静默中断在途发言（没有取消提示）；`use-command.ts` 的 `setError` 缺少 owner 写侧守卫（现有调用点都有 `isActive`/`isCurrent` 守卫，实际不可达）。
- 本轮另修复两处既有失败：`tests/attempt-grading-page.test.ts` 的服务 mock 缺 `requireSession`（自 `68e05ca` 起全量必失败，之前只在定向批次外）；`tests/domain-contracts.test.ts` 的旧断言与「绑定改写出处只保留材料改写身份」相冲突，已按现行身份派生规则更正并为两条新分支补测试（此前无覆盖）。
- README、`code-quality.md`、本记录与待办已按上述实测结果更新；历史 697/699、34 组冒烟和旧 BUILD_ID 不再是签核依据。

## 剩余步骤（从这里继续）

1. 等并行任务在备份模块上的改动稳定后按序重跑：`pnpm build:learning` → `pnpm check` → `node scripts/run-electron-boundary-smoke.cjs` → `node scripts/prepare-learning-dist.mjs` → `node scripts/verify-learning-dist.mjs` → `pnpm package:desktop` → `node scripts/verify-packaged-desktop.mjs --app-dir apps/desktop/release/win-unpacked` → `node scripts/verify-classroom-desktop.mjs`。构建期间若对方再次改变输入，构建脚本会拒绝记录摘要，协调完成后重建；不能伪造指纹或据旧产物通过。
2. 如需统一上游文档接口的 UTF-8 严格度：`apps/learning/app/api/maic/documents/**` 仍使用非致命解码（无效字节先被替换成 U+FFFD 才进 json-codec），改用 `lib/server/bounded-json.ts` 会把这类正文从接受变为拒绝，属于上游 `HttpDocumentStore` 写入合同变化，须单独带回归处理。
3. 同学面板的中断提示（key 含 `status` 时静默 abort）与 `use-command.ts` 的 `setError` owner 写侧守卫需要产品判断，不在本轮重构范围内。
4. 新的实质改动继续交 `code_reviewer` 做只读复核，并如实报告失败、跳过和未运行项。
5. 外部门槛按现有暂缓条件保留：真实材料与人工金标准、两位真人两台设备、独立干净 Windows、真实付费 provider 调用；不得用合成数据或单机双窗口替代。
6. 提交只包含源码、测试与文档；`.task-cache/`、`.next*`、`dist/`、`release/` 与缓存不入库，`apps/desktop/build/` 安装资源保留。

## 下一轮可复制的提示词

```text
请接手 D:\File\Ai与辅助教学\subject-exam-workbench，继续 docs/待办事项.md 的 M1—M4 与 A—F/85 项能力。先读适用 AGENTS.md、docs/optimization-handoff-2026-10-05.md、docs/待办事项.md、docs/规划书.md、docs/开工任务清单.md 与 docs/openmaic-feature-parity.json，再核对 git status、git log 与工作区实际内容。

边界：子智能体用 GPT-6.1 Sol、medium 并给明确文件所有权；主智能体负责集成与复审。不得 reset/clean 或覆盖他人改动；不读取、执行、删除或提交 .task-cache/；不修改真实用户项目或 profile；不调用未授权付费 provider；不为整仓格式化。

已完成且已验证，勿重做一轮泛化审计：HTTP/合同/存储服务拆分、模型调用分阶段、命令生命周期、测验 Hook、目录与用量批量读取、共享测试种子、lint/格式/分层门禁；完整备份恢复到原生 IPC 与界面；冻结评测 schema/重算/CLI/机械攻击与只读报告导入；改写题身份防伪装；模型状态可见错误与配置回执。评测接口已改用集中入口 apps/learning/lib/server/bounded-json.ts（实际字节上限→严格 UTF-8→json-codec），JSON.parse 允许入口已收窄。2026-10-05 09:17–09:26 对源码摘要 `702b951a…4f8c` 通过：pnpm check（89 文件 / 765 项，0 跳过）、原生冒烟 36 组、随包服务 14/14、目录包启动 30/30。

先做：确认并行任务在备份模块上的改动已稳定 → 按本记录「剩余步骤」第 1 条依次重建并重跑全部产物验证（课堂实际走查因源码指纹过期尚未运行）→ 新的实质改动交 code_reviewer 独立只读复核 → 按实测更新 README、code-quality、待办与本记录 → 核对新增模块与根导出后提交相关源码。

保留语义：模型未知结果预占与同请求不重派、切换项目后不访问旧库、测验串行草稿写入/尾序号冲突重试/nonce/持久收据、本人优先等待与 simulation 隔离、严格 JSON/schema/摘要门禁；不改公开 HTTP/IPC 语义、不删必要回归、不把局部通过写成里程碑验收。真实材料与人工金标准、两位真人两台设备、独立干净 Windows 按现有暂缓条件保留，不用合成数据或单机双窗口替代。
```

## 上一轮提示词（状态已由上文取代，仅保留历史）

```text
请接手 D:\File\Ai与辅助教学\subject-exam-workbench。先完成当前重构、新功能的集成验收，再按规划继续完善项目。阅读适用 AGENTS.md、docs/optimization-handoff-2026-10-05.md、docs/待办事项.md、docs/规划书.md、docs/开工任务清单.md 与 docs/openmaic-feature-parity.json，核对 git status/git log。交接时 HEAD=6d423bb，恢复后的大量修改与新增模块尚未提交，必须保留并整合另一项任务的改动，不得 reset/clean 或遗漏未跟踪源码。

如需分工，子智能体使用 GPT-6.1 Sol、medium；给出明确文件所有权并提醒不覆盖其他人，主智能体负责集成与复审。评测可交 machine_learning_engineer，新实质改动完成后交 code_reviewer 独立只读复核。不要读取、执行、删除或提交 .task-cache/ 内容；不修改真实用户项目/profile，不调用未授权的付费 provider。

HTTP/合同/存储服务拆分、模型分阶段、命令生命周期、测验 Hook、目录与用量批量读取已落地；新增完整备份恢复、冻结评测/11项机械攻击/报告导入、模型状态重试和实际 IPC 参数/返回检查。改写题身份、模型配置回执、A/B/C 构建与环境比较的已确认缺陷已修复。当前 typecheck（含IPC）、lint、限定 format:check、check:code（12项工程检查）及12文件115项定向测试通过。这些结果不能替代全量和产物验收。

先协调实现稳定，复核同学/个人档案最新迁移及新备份、评测入口；可整理评测限额读取重复并补非法 UTF-8/缺 body 回归，保留2MiB实际字节上限、严格schema与摘要重算。scripts/smoke-project-backup.cjs 已接入真实native handler（仅替换选择器），但尚未运行，重点验证备份恢复按钮、首次/修改模型配置回执和密钥清空，不发远程调用。

实现稳定后依次 pnpm build:learning、pnpm check、node scripts/run-electron-boundary-smoke.cjs，处理失败并报告全部跳过。当前旧BUILD_ID=7pcrnRklHsFNwJgze483G，源码指纹已确认过期；旧34组冒烟和历史目录包不能代表当前验收。保留未知结果预占与同请求不重派、切换项目后不访问旧库、串行草稿/尾序号冲突重试/nonce/持久收据、本人优先等待与simulation隔离，不削弱检查或整仓格式化。

随后 node scripts/prepare-learning-dist.mjs、pnpm verify:service，使用新的stage目录组装Windows目录包并运行verify-packaged-desktop/verify-classroom-desktop。核对构建ID、源码摘要、文件清单与实际操作；不覆盖原安装程序。更新README/code-quality/续作和待办，删除确定完成范围，保留真实剩余范围，核对新增模块后提交相关源码。不要恢复已删的审查报告。

集成完成后按待办继续M1—M4及A—F/85项能力。M2完整课件生成/编辑/实际画布聚焦/其余互动PBL，M3受控模型同学/复习调度/完整费用租约/故障恢复，在线认证UID/邀请/同步/交流仍未完成。真实材料与独立人工金标准、两位真人两台设备、干净Windows环境按现有暂缓条件保留，不重复索要或用合成/单机双窗口替代。M1—M4全部满足约定范围后才交付成品；持续实施、测试、复盘，不只给计划或提前宣称完成。
```
