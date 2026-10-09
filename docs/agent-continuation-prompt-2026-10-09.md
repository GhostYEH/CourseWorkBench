# 后续 Agent 执行提示词：修复核验缺陷并完成全部剩余规划

以下全文可以直接交给接手 Agent 执行。它是实施任务，不是仅进行分析、评审或给出建议。

## 1. 目标、授权和硬性边界

你接手 Windows / PowerShell 项目：

`D:\File\Ai与辅助教学\subject-exam-workbench`

用户要求继续完善项目：先修复本次独立核验确认的问题，再完成原规划全部剩余软件功能，完成独立审查、实际消费者验证和最终产物核验。不要把任务缩成“完成本轮五个功能”“修完七个缺陷”或“做到一个可以 build 的阶段”。修完一批后继续队列，不要反复询问是否继续。

必须遵守：

1. **全部必需软件实现完成前，不再 build。** 现有 Next/服务/桌面产物只作为历史证据。不能自行把“全部完成”解释为“当前批次完成”。开发期运行源码级测试、类型/lint/格式/边界检查和不依赖应用 build 的解析、序列化、编码实验。全部软件实现完成、独立审查完成、源码检查通过后，才冻结源码并统一 build。
2. **不得通过减少要求取得完成状态。** `partial` 不算 `done`。不得删除规划能力、降低验收条件、把合同/路由/按钮/模拟输出当完整产品、把软件缺口全部归为外部验收。
3. **使用子智能体时遵循用户选择：`gpt-6-luna`、`reasoning_effort: high`。** 若不可用如实说明。分工明确文件/模块所有权，告知所有参与者不得回退他人改动。主智能体负责集成、审查、核验和最终状态判断。复杂实现完成后安排 `code_reviewer` 只读独立审查；适合委派的 ML/数据/推理任务使用 `machine_learning_engineer`。
4. **保护当前工作区。** 大量 tracked/untracked 文件是已有成果；禁止 reset/clean/checkout 覆盖、清空 output 或重克隆覆盖。先核实 Git 状态和当前源码。未明确授权时不提交、推送、发布或部署到外部服务；本地实现和验证继续执行。
5. **区分外部条件与软件缺口。** 不伪造 provider 成功、真人答题、正式教材来源、麦克风权限、Office/WPS 人工编辑、双物理设备或干净 Windows 安装。缺少这些条件时继续完成软件、配置和验收入口，单列待验条件；不要让一个外部阻塞停止其他独立工作。
6. 每约一分钟给用户一条简洁进展，说明已解决的问题、剩余不确定性和下一步验证。保留失败证据，不把重复运行直到成功写成问题已修复。

## 2. 先读取当前核验资料

按以下顺序阅读；相对路径均以项目根目录为准：

1. `output/project-verification-2026-10-09.md`：本次完整核验报告，含七个确认缺陷、三个实际 API 复现、稳定性异常和未完成范围。
2. `output/review-verification-2026-10-09.json`：本次机器核验摘要。
3. `docs/agent-handoff-prompt-2026-10-08.md`：覆盖全部剩余实施包的原提示词。已完成的子项以当前源码为准，不重复实现；其他要求继续有效。
4. `docs/规划书.md`、`docs/待办事项.md`、`docs/开工任务清单.md`。
5. `docs/OpenMAIC复用与学习空间.md`、`docs/openmaic-feature-parity.json`、`docs/completion-work-queue-2026-10-08.md`。
6. `docs/closeout-2026-10-09.md`、`docs/implementation-completion-2026-10-08.md`、`docs/handoff-checkpoint-2026-10-08.md`，注意历史与当前证据不同。
7. `docs/THIRD_PARTY_NOTICES.md`、`docs/upstream-adaptation.md` 和实际采用资源的来源/许可回执。

接手时的参考状态（必须现场核实，不硬编码历史总数）：

- HEAD：`8934c268581e09b819aef35f0f13e183b6cc3139`，核验轮未修改产品源码、未提交/推送。
- 85 项必需能力：**66 partial / 19 planned / 0 done**。UID 双人共同课堂是另一个新增必需范围，不能遗漏。
- 已有源码到 schema44；新表/迁移包含 AI 补丁、Pro 外部 token、编辑草稿和 token 命令回执。
- 核验时全量原生测试 172 文件、1575 测试通过、0 失败/0 跳过；服务 14/14、桌面目录包 30/30、课堂单独复跑 50/50。
- 首次完整测试发生昵称保存失败；课堂脚本首跑在服务崩溃后测验恢复处超时。后续通过，根因没有确认，仍需调查。
- 核验时旧构建 BUILD_ID：`oPOc8fujRLeQqxR5Loco5`，517 输入，源码 SHA-256：`81be0124f7eee949fedd6dbb3321606b44f1394eb51cac07b5264e5a7d905763`。源码一变，这些产物不再证明新源码正确。

## 3. 第一阶段：修复七个已确认问题

先建立能复现错误的回归，再实现修复。测试必须断言真实业务状态、权限或写入结果，不能只断言你新增了一个 if。行号来自核验时，接手后重新定位。

### 3.1 补丁覆盖确认必须绑定实际确认的计划

入口：`apps/learning/lib/server/lesson-service.ts` 的 `apply-scene-plan-patch`，约 899/923 行；同时检查合同、仓库、UI 确认和幂等回执。

已复现：计划 revision1 → 并发保存为 revision2 → 旧候选以 `override:true, expectedPlanRevision:1` 提交 → 错误返回 200，覆盖成 revision3。

要求：

- `override` 只允许豁免候选自身基线过期，不能豁免用户这次确认的计划修订/摘要已经变化。
- 最终事务内比较客户端确认的 revision（以及合同需要的 digest）与当前权威计划；不一致返回 VERSION_CONFLICT，不写计划、不改变候选成功状态。
- 不得用刚读取的 `current.revision` 替换客户端预期值后声称 CAS 成功。
- UI 计划推进后取消旧确认，重新比较；未知响应保持原 requestId/内容/确认基线，查询或重放原回执。
- 回归覆盖正常采用、显式覆盖旧候选、确认之后再次推进、已执行回执重放和失败回执，检查无重复 revision/无静默覆盖。

### 3.2 Pro 外部授权必须在最终业务提交前复验

入口：`apps/learning/lib/server/pro-external-service.ts:187`；下游 `pro-session-service.ts` 已预留 `verifyAuthorization`。

已复现：provider 挂起 → 本机撤销 token 返回 200 → provider 返回 → 外部 send 仍返回 200 并写入 assistant。

要求：

- 把原凭据的授权复验接到既有回调，检查原 secret hash、token 身份、当前 owner/project/session generation、scope、撤销、轮换和到期。不能只按不变 tokenId 判断，也不能闭包缓存首次认证的 DTO 当实时认证。
- 派发前、等待后和最终提交事务内使用实时状态，失效时禁止 assistant/工具候选等业务成功提交。已经派发的用量仍真实结算，不因授权失效删账或自动重派。
- 明确任务失效/未知/取消后的恢复状态，避免留下永远 running 的任务；外部接口继续只支持 read/create/send，管理仍要求本机 session。
- 确定性回归：长调用期间分别 revoke、rotate、到期和项目切换，旧凭据不能最终提交；新凭据正常，账务不重复，未知付费请求不自动重发。

### 3.3 草稿保存必须拒绝乱序和过期写入

入口：`lesson-scene-plan-editor.tsx:145`、`lesson-service.ts` 草稿命令、`study-storage/.../lesson-scene-plan.ts:239`。

要求：

- 设计端到端保存顺序与并发控制；可以串行队列保留最后快照，并结合草稿 revision/CAS 处理多窗口。不能仅 cancel fetch 后假定服务端没提交。
- 草稿继续绑定 owner/project/lesson/version/baseRevision/baseDigest。草稿自己的更新顺序与权威计划 revision 是不同的约束。
- 保存计划/丢弃/载入最新之后，旧在途草稿不能重新创建过期草稿或覆盖新编辑；响应迟到也不能错误更新新项目的“已保存”提示。
- 若新增表/字段，包含安全迁移、备份恢复及历史 fixture，不只修改 CREATE TABLE。
- 回归故意让旧请求晚于新请求到达；用独立数据库连接/窗口验证，最终重开必须读到最新合法快照。

### 3.4 撤销/重做也必须触发草稿持久化

入口：`lesson-scene-plan-editor.tsx:275/497/505`。

保存成功会清除 dirty，但 undo 栈仍可用；undo/redo 直接 setEditor，没有置脏。让所有改变编辑内容的入口采用一致的置脏/保存语义。测试“保存成功 → 撤销 → 等待草稿落库 → 重开”与 redo 路径。完整持久撤销历史仍是另一个规划项，不能修复置脏后宣称整个 OMA-024 已完成。

### 3.5 离开页面不能静默丢掉防抖中的编辑

入口：`lesson-scene-plan-editor.tsx:163/164`，1200ms 防抖和 cleanup。

要求：明确 pending/saving/saved/failed 状态；切课、路由导航、关闭窗口和隐藏页有可靠最后快照保存或明确的未保存确认。不能把 async unmount cleanup、beforeunload/sendBeacon “已调用”当作已被数据库确认。无法保证的突然断电窗口要明确，不承诺任意时刻零丢失。

真实交互回归：编辑后不足 1200ms 离开再重开，最后内容恢复或离开被明确阻止/确认；网络失败不显示已保存；旧页面响应不会污染下一页面。

### 3.6 预览必须对应当前选中补丁及实际应用数量

入口：`lesson-scene-plan-patch.tsx:408/425/215`、`lesson-service.ts:498`、领域补丁计算。

要求：

- 勾选子集后以当前选择和当前计划基线重新计算受控只读预览；区分 applicable、selected、applied、rejected 数量。
- 审核展示的最终 scenes/digest 与最终写入一致；选择或基线改变时旧预览失效，迟到的预览不能覆盖新选择。
- 至少覆盖两条合法操作仅选一条、选空、重复/越界/被拒索引，以及前后操作存在依赖的情况，不能采用未选中的操作。
- 审核回执保留准确选用结果；拒绝候选不写计划；来源、身份和未经审核资源仍不可修改。

### 3.7 外部 requestId 使用无截断碰撞的映射

入口：`pro-external-service.ts:167`。

原合同允许 200 字符 nonce，拼 token 前缀后 slice 会丢尾部。使用带清晰域分隔/结构序列化的稳定摘要映射，保持同 token+同请求稳定、不同合法 nonce 不碰撞、不同 token 隔离。考虑既有已执行回执的兼容，避免改变映射后把旧付费请求再执行一遍。

回归：两个只在末尾不同的 200 字符 nonce 分别成功创建不同会话；同 nonce 同意图重放；同 nonce 改意图拒绝；不同 token 同 nonce 独立。

## 4. 第二阶段：调查两项稳定性异常并补真实 UI 验证

### 昵称原子保存

核验首跑 `tests/learner-profile.test.ts:52` 的昵称更新在 `learner-profile.ts:113` 原子 replace 失败，focused 16/16 和后续全量通过。

保留失败日志。采集真实底层错误码、锁/临时文件状态和阶段，检查 Windows 文件占用/权限/并发等实际因素；不预设杀毒软件是根因。必要改动保留 UID、revision CAS、原文件完整性和失败不重生成身份的约束，不能删原文件再写新文件绕过原子性。

### 崩溃后测验导航与恢复

报告：`output/review-classroom-2026-10-09.json`；单独复跑通过报告：`output/review-classroom-isolated-2026-10-09.json`。

首跑服务重开及互动场景加载成功，但点击测验后仍停留在互动，等待 `[data-attempt-result]` 超时。不能直接宣称测验记录丢失，也不能直接归因于 hydration。

- 点击后先核实 quiz tab 成为当前场景，再检查测验结果。
- 失败时记录 tab current/disabled、position saving/error、控制台以及 `/api/maic/state` 导航 PUT 请求/响应；不得泄露 session/control/token。
- 查清若位置请求挂起，是否有可取消/超时/重试的产品路径；故障恢复不能一直禁用导航。
- 保留实际鼠标命中、真实渲染和退出清理断言；不通过延长所有 timeout、直接调用内部 React handler 或绕过认证伪造通过。
- 根因无法定位时明确记录未解决稳定性边界，继续其他实施包；重跑通过不是根因修复。

现有课堂脚本没有验证新增草稿/补丁/token/Pro 切课流程。补必要的真实组件或浏览器交互测试，覆盖本轮问题对应的用户行为，不只跑纯函数或直接调用 route。

## 5. 第三阶段：逐项完成全部剩余软件功能

建立并持续更新完整矩阵：**要求 → 代码入口 → 实际消费者 → 失败/恢复语义 → 实测证据 → 软件缺口 → 外部待验条件**。覆盖 OMA-001–085 以及 UID 双人课堂新增要求，不只覆盖 19 项 planned。

当前仍 planned 的 19 项：030 圆桌中断、031 逐步白板、033 完成反馈、039 三维、041 游戏评分、042 图流互动、043 编程测试、044 教师观察指导、045 快照恢复、052 音视频材料、053 网页多搜索、054 研究核查、055 PPTX 可编辑导入、063 声音设计/克隆、078 owner/team/匿名认领、079 宿主扩展、081 十二语言、083 远程部署访问码、085 步骤技能训练。编号和验收以实际 JSON 为准。

按原交接实施包继续：

| 实施包 | 必须补齐的核心范围 |
| --- | --- |
| B1 / 004–009 | 完整生成用户路径、阶段恢复、资源主题处理、渐进生成/取消/进度、全部候选可预览后采用、教学配置消费及失败矩阵 |
| B2 / 018–024 | 全部原生对象编辑、真实审核图片、操作级撤销、持久恢复、高级合并、批量再生成与逐项选用；保留受限补丁与 revision/digest/requestId |
| B3 / 050–055 | 扫描件 OCR、音视频时间/帧材料、受控网页抓取/多搜索/引用核查、可编辑 PPTX 对象导入及有损说明 |
| C1 / 025–028 | 角色活跃/参与、跨场景恢复、全屏/键盘/focus、窗口/DPI 和可访问布局 |
| C2 / 029–033 | 完整 Director、多真实 AI agent、自由问答/圆桌/中断、逐步白板绘画、个人结果页；真人记录保持隔离 |
| C3 / 034–037 | 作答/语义判分/反馈完整产品流程、rubric 和候选核对、provider 故障恢复；无真实数据不声称评分有效性提升 |
| C4 / 038–045、085 | 安全 HTML 实际生成消费者、三维/仿真/游戏/图流编辑、真正受限代码沙箱、观察指导、快照 registry 写入恢复、步骤技能训练 |
| C5 / 046–049 | 多人席位、角色演练编辑、共同任务执行和观察指导、跨设备 ownership/重连/接管；AI 不代真人提交 |
| D / 010–017 | Pro 完整候选预览/采用、真实材料选择、可靠 nonce 重放、durable 后台 worker/恢复/暂停/接管、自定义技能完整管理与旧快照 |
| E1 / 056–059、066 | 全部目标 provider 的真实协议/发现/能力边界、独立配置 profile/阶段路由、版本迁移/备份/回退及产品入口 |
| E2 / 060–065 | 其他媒体 provider、实际音色/设计/克隆消费者、音画同步、版本价格/用量、所有执行器 fencing/crash reconciliation |
| E3 / 067–072 | 完整 PPTX 对象/数学支持矩阵、离线 HTML、课堂 ZIP 导入导出和资源迁移、完整 MP4 时间线/音轨/互动投影同步 |
| F1 / 001–003 | 跨项目全局库、成员/访问/共享、发布撤回的实际受众路径 |
| F2 / 073–079 | 全部 DSL/DB 迁移、资产分层配额与大资源备份恢复、HTTP/Postgres 真消费者、owner/team/匿名认领、宿主 hooks、全部任务执行租约 |
| F3 / 080–084 | 完整窗口/DPI/键盘、十二语言与语言推断、全层恢复、部署访问码/持久身份、SBOM 和资源/字体/模型/运行时许可追踪 |

涉及联网/代码沙箱/身份共享时实际验证隔离、大小/时间/输出限额、取消、重启和权限边界。未经审核的网页或 AI 内容只能进入待核候选，不能进入正式知识。不要主进程任意 shell 执行，不默认执行技能附带脚本。

保留已存在的真实消费者：静音 MP4、可编辑 PPTX、PDF/Office 原件归档、媒体候选、录音/ASR、provider 注册、Pro 持久会话、执行租约和课堂导航等。扩展它们，不平行造一套绕过 guard/来源/预算/审核/存储的新实现。

## 6. 开发期间的检查与并行纪律

- 主智能体独占完整测试、全局格式、全局质量检查和最终构建。子智能体只运行其隔离定向测试；避免同时运行多套全量测试、桌面鼠标脚本或同时格式化共享文件。
- 每个关键缺陷先有失败回归；每个产品能力有真实消费者和可重复的成功/失败/取消/重开证据。不要写只镜像实现的低价值测试。
- 经主智能体集成和独立审查后，再扩大测试；保留失败报告，新的结果使用新文件名。
- 开发期：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm check:code`；源码测试暂时排除三项依赖旧 build 的文件：`tests/desktop-http-boundary.test.ts`、`tests/lesson-review-page.test.ts`、`tests/model-connection-http.test.ts`。最终 build 后必须全部恢复。
- `pnpm check` 默认包含构建依赖测试，源码变化后不能用旧产物运行它来证明新的完整通过，也不能为它提前 build。
- 资源/协议实现需要依赖时使用固定版本、记录来源/许可，并核实真实导出和协议，不能假造 SDK API。

原生 MP4 源码集成可在开发期运行，不构建应用；先确认路径存在：

```powershell
$env:NODE_OPTIONS='--max-old-space-size=8192'
$env:SEW_RUN_MP4_INTEGRATION='1'
$env:SEW_FFMPEG_PATH=(Resolve-Path -LiteralPath 'output/mp4-runtime-tests/unpacked/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe').Path
$env:SEW_FFPROBE_PATH=(Resolve-Path -LiteralPath 'output/mp4-runtime-tests/unpacked/ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe').Path
pnpm exec vitest run tests/mp4-export-service.test.ts tests/mp4-renderer.test.ts
```

默认两个 native MP4 测试会跳过，报告要如实标记。测试用编码器没有随包分发；若实现最终运行时安装/分发，另做许可、真实安装位置和实际运行验收。

## 7. 最终 build 的门槛与顺序

只有完整矩阵显示**全部必需软件路径已实现，无遗漏的软件缺口；七个缺陷已修、独立审查已处理、源码检查通过**，才进入此阶段。外部条件未具备的验收可以单列待签，但不能把缺产品消费者的项目划进外部待验。原验收尚未签核的项遵守既有 status 语义；用矩阵单列软件实现状态，不为了 build 将其虚标 done。

1. 冻结产品源码/依赖/资源，记录 Git 状态、源码指纹、许可回执和最终源码测试报告。
2. 按实际项目脚本依赖执行最终构建：`pnpm build:learning`，用 `node scripts/prepare-learning-dist.mjs` 组装服务，按桌面 package 脚本完成桌面构建和打包。先读脚本，避免重复构建；不要直接 next build 绕过 provenance。
3. 运行最终 `pnpm check`，恢复所有 build 依赖测试；必要时显式启用原生 MP4，报告实际通过/失败/跳过数量。
4. 对最新产物串行执行服务、桌面和课堂验证；桌面 UI 脚本不得相互抢鼠标/窗口。使用正确 app-dir/report 参数，不能引用旧报告替代运行。
5. 独立核对 source fingerprint、Next BUILD_ID、build-inputs、service manifest、桌面内嵌服务、app.asar 和报告属于同一批最后源码；实际读取最终 PPTX XML/OMML/图表工作簿/字体、MP4 完整解码与摘要核验下载，以及课程包导入后的实际资源。
6. 如果构建后发现必须改源码的问题，修复后重新冻结、重建受影响产物并重验，不能拼接不同批次证据。
7. 不把开发机隔离 PATH/profile 的目录包验收当干净 Windows 安装/升级/卸载，不代签真实设备/provider/真人/Office 验收。

## 8. 必须交付的结果

- 七项缺陷逐项修复说明、失败回归与修复后证据；稳定性异常的根因/诊断证据或明确未解决边界。
- 完整 85 项及 UID 新增要求矩阵，逐项列真实消费者、软件缺口和外部待验条件；保持规划要求不缩水。
- 更新规划/待办/实施队列/能力清单/收束记录，标清历史 schema/build/test 与最新状态，纠正“阶段批次等于全部完成”及提前 build 授权的错误表述。
- 新测试/构建/运行报告的实际命令、环境、退出码、数量和可查路径；失败与 skip 不隐藏。
- 最终源码与产物 provenance、产物路径/摘要、许可/SBOM、外部验收清单。
- 最终答复先说达到了哪一层完成条件。仍有软件缺口就继续实施；若遇到必须依赖外部输入的真实阻塞，准确说明已完成项、卡住项和最小必要输入，不能写“全部完成”后再附一大串尚未实现的软件。

立即开始：核对工作区，读取核验报告，建立七个问题的回归和全部范围矩阵，组织有边界的分工；修完七项后继续完成全部实施包。不要只返回计划或第一批修复总结。
