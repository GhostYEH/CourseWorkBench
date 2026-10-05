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

- **当前有效签核范围（2026-10-05 10:00–10:30，接手验收）**：在 `7067679` 之后继续改码，源码摘要变为 295 输入 / SHA-256 `9ace3e7d8e00f714304188a057fbae4504923249e434bce1b84a4069f825b710`，BUILD_ID `9s6BSq2Fe6_DyXXzB3Wyj`。同一份内容串行通过：`pnpm typecheck`（含 `typecheck:ipc`）、`pnpm lint`、清单内 `format:check`、`check:code` 12 项、`pnpm check` **90 文件 / 771 项、0 跳过**（含按当前产物实际执行的生产 HTTP 边界 13 项）、`run-electron-boundary-smoke.cjs` **36 组**、`prepare-learning-dist` + `verify-learning-dist` **14/14**、`package:desktop` 后复制到新 stage 目录 `apps/desktop/release/m4-integration-2026-10-05b/win-unpacked` 再验 **30/30** 与随包课堂 **50/50**。原 `win-unpacked`、既有安装程序与 NSIS 包未被覆盖或安装。
- 本节下方 09:17–09:26 与 09:27 复验的数据属于摘要 `702b951a…4f8c`，只作为该版本的历史记录保留，不再代表当前源码。
- 接手期间新增实现：**教师聚焦作用于真实画布元素**（`apps/learning/lib/classroom/board-focus.ts` 解析「同一场景中 seq 最大的已播放 focus 效果」，`SceneRenderer.tsx` 用上游 `SlideCanvas` 的 `effects` 画出高亮，线型元素退化为聚光，文档中不存在的元素 id 一律不高亮；`classroom-surface.tsx` 仅在所指向场景显示，并给出文本状态而不是只靠颜色；白板面板卸载时收回效果）。冒烟新增断言 `[data-canvas-focus]`、`slide-element-<id>` 与 `.highlight-overlay`，并断言切场景后高亮消失。
- 接手期间修复：恢复目标禁止落在**当前打开的项目**内（`destination_in_open_project`）；调用方路径缺失/不可读改为可诊断拒绝 `path_unavailable`（原先逃成原始 ENOENT→500）；暂存改为**单次 rename 发布**消除半发布窗口，冲突仍归为 `destination_exists`；容器数据库只读打开失败归入 `database_unreadable`；手工构造但缺少自身 `project.json` 或 `.study/study.db` 的容器在读取前拒绝；容器版本改用 `PROJECT_BACKUP_VERSION` 常量；主进程回显比较改为真实路径比较，避免目录联接或盘符大小写造成「已成功却报失败」；`apps/learning/tsconfig.json` 排除 `dist` 产物树，修掉「先 build 再 check」时 typecheck 检查产物内复制源码的误报；恢复服务的授权顺序改为先 `assertScope` 再取保护根，避免 `requireSession` 按环境引导出新项目时保护落空。
- 一次冒烟首跑（10:07）以渲染脚本报错失败，同一产物随即两次重跑（含官方 runner）均通过且期间源码未变，与上文 09:37 的产物 ENOENT 同属**首跑瞬时失败**，机制未确定；按待观察项保留，不作为功能结论也不掩盖。
- 独立只读复核（`code_reviewer`）对本轮改动给出两项残留判断：`renameSync`/`realpathSync` 的 TOCTOU 极端窗口（已按建议把 publish 冲突归为 `destination_exists`）与恢复容器的原始异常出口（已补守卫）。另有两项判定为**当前不可达**因此未改：`use-command.ts` 的 `setError` 缺 owner 写侧守卫（所有调用点都在门禁内）、22 个未迁移组件的 `finally { setBusy(false) }`（项目切换走 `window.location.assign` 整文档导航，组件树随文档销毁，且服务侧代次复验拒绝旧写入）；记录于此以免下一轮误当作缺陷重构。

- 2026-10-05 09:17–09:26 对同一份源码内容（294 输入，SHA-256 `702b951ac01bdceab682e2aca632a01a3d74a9083834df630d0f4600af4a4f8c`，BUILD_ID `XTlrKzxq10meglOGXaEWK`）依次完成：`pnpm check` 全绿（typecheck 含 `typecheck:ipc`、lint、清单内 format:check、check:code 的 12 项工程反例与 20 个 preload 白名单方法，**89 文件 / 765 项测试通过、0 跳过**）；`node scripts/run-electron-boundary-smoke.cjs` **36 组通过**，含完整备份 native 链路与模型配置回执；`prepare-learning-dist.mjs` + `verify-learning-dist.mjs` **14/14**；`pnpm package:desktop` + `verify-packaged-desktop.mjs` **30/30**。
- **随包课堂走查最终通过**：并行任务 09:27 对同一源码摘要重建得到 BUILD_ID `0NaV76pOveX7LuPE577M_`，使先前组装的产物落后一版；按它重跑 `prepare-learning-dist.mjs` 与 `pnpm package:desktop` 后，`verify-learning-dist` 再次 **14/14**、`verify-packaged-desktop` 再次 **30/30**，`verify-classroom-desktop` **50/50 通过**（原生中文空格路径选择器、导入建立新版本、固定版本来源定位、切换项目后旧项目写入隔离、退出后端口释放）。首次走查在 09:37 报打包内某 `app-page-turbo.runtime.dev.js.map` 的 ENOENT，但该文件实测存在且可读，同产物重试通过；机制未确定，按待观察项处理，不写成缺陷也不忽略。
- 独立 `code_reviewer` 只读复核评测解码边界与同学/个人档案命令迁移：**未发现确认缺陷**。已落实其两项建议：解码诊断随 `details.error` 返回、路由层补非法 UTF-8 与缺正文断言。两项遗留需要产品判断，未擅自改动：同学面板 `useCommand` 的 key 含会话 `status`，别处更新状态会静默中断在途发言（没有取消提示）；`use-command.ts` 的 `setError` 缺少 owner 写侧守卫（现有调用点都有 `isActive`/`isCurrent` 守卫，实际不可达）。
- 本轮另修复两处既有失败：`tests/attempt-grading-page.test.ts` 的服务 mock 缺 `requireSession`（自 `68e05ca` 起全量必失败，之前只在定向批次外）；`tests/domain-contracts.test.ts` 的旧断言与「绑定改写出处只保留材料改写身份」相冲突，已按现行身份派生规则更正并为两条新分支补测试（此前无覆盖）。
- README、`code-quality.md`、本记录与待办已按上述实测结果更新；历史 697/699、34 组冒烟和旧 BUILD_ID 不再是签核依据。

## 剩余步骤（从这里继续）

1. 本轮 09:17–09:40 已把这条链走通：`pnpm build:learning` → `pnpm check` → `run-electron-boundary-smoke.cjs` → `prepare-learning-dist.mjs` → `verify-learning-dist.mjs` → `pnpm package:desktop` → `verify-packaged-desktop.mjs` → `verify-classroom-desktop.mjs`。之后任何源码改动都要按同一顺序**串行**重跑：构建会重写 `apps/learning/.next`，而生产 HTTP 用例直接对该产物起服务，并发跑会伪报 500；构建期间对方再改输入会使摘要记录失效，须协调后重建，不能伪造指纹或据旧产物通过。
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

先做：本轮验证链（含随包课堂 50/50）已走完，直接从待办的产品缺口继续——M2 逐场景课件改写与画布实际聚焦、其余互动/PBL，M3 受控模型同学、复习调度、完整费用租约与故障恢复，以及 UID 邀请/同步/交流。改动源码后按「剩余步骤」第 1 条串行重跑整条验证链；新的实质改动交 code_reviewer 独立只读复核；按实测更新 README、code-quality、待办与本记录，再提交相关源码。

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
