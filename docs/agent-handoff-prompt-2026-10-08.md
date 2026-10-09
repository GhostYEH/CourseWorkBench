# 后续智能体完整执行提示词

下面全文可直接交给后续主智能体。它是继续实施与核验的指令，不是“项目已完成”的声明。

## 目标与授权

你接手 `D:\File\Ai与辅助教学\subject-exam-workbench`。用户要求：核对项目规划，把所有尚未完成的软件功能做完，并完成独立审查、实际消费者验证和交付核验。用户已授权继续实现，不要只分析或完成一小批就停下询问“是否继续”。

用户明确要求 **全部软件实现完成前不要 build；全部实现完成后才统一 build**。开发期间可以安装必要固定依赖（使用 `--ignore-scripts`）、运行源码测试、TypeScript、lint、格式与边界检查，以及无需构建的真实解析／序列化／编码测试。不要为了跑依赖旧产物的测试提前 build。先修复软件缺口，再冻结源码，最终统一构建和产物验证；构建后再改源码就必须重新构建和重新核验对应产物。

用户要求子智能体使用 **`gpt-6-luna`，`reasoning_effort: high`**。模型名称来自用户输入“gpt6lunna高”的明确意图。如果平台不可用，明确报告，不能声称用了它。按实际并发额度分工，子智能体拥有明确文件／模块，不可覆盖其他人的改动；主智能体负责集成、核验和判断。实现复杂功能后安排只读独立审查。机器学习／数据集／推理实验可以用 `machine_learning_engineer`；代码审查用 `code_reviewer`。

这是 Windows / PowerShell 工作区。当前大量 tracked 和 untracked 文件都是用户授权进行中的成果，**不要 reset、clean、checkout 覆盖、删除 output 整个目录，或重新克隆覆盖项目**。本轮没有提交／推送，也没有最终 build。先读取 `git status`、HEAD 和实际代码，不要只依赖旧文档或本提示词里的计数。

## 必读资料与状态判定

先读这些文件，并为全部能力维护“要求 → 实现入口 → 消费者 → 核验证据 → 剩余边界”表：

1. `docs/规划书.md`、`docs/待办事项.md`、`docs/开工任务清单.md`。
2. `docs/OpenMAIC复用与学习空间.md`、`docs/openmaic-feature-parity.json`（全部 **85 项 OMA-001–085**）。
3. `docs/completion-work-queue-2026-10-08.md`（跨全部 85 项的实施包）。
4. `docs/implementation-completion-2026-10-08.md`、`docs/handoff-checkpoint-2026-10-08.md`（此次交接源码证据和未完成项）。
5. `docs/implementation-media-pptx-2026-10-08.md`、`docs/implementation-director-2026-10-08.md`、`docs/implementation-recording-2026-10-08.md`，注意它们含阶段历史结果。
6. `docs/THIRD_PARTY_NOTICES.md`、`docs/upstream-adaptation.md`，以及采用目录内的许可／来源回执。

“有合同”“有路由”“有按钮”“有 skill 文件”“模拟测试通过”均不能单独证明产品能力完成。必须确认真正用户路径消费了实现，失败／权限／恢复行为正确。`partial` 不等于 `done`，实施阶段不会删除原要求。不要为了写成全完成而缩减规划、修改验收条件、删测试、扩大 JSON.parse 白名单、关闭 lint/typecheck，或把 unsupported 内容静默假装成功。

真实外部条件不足时继续完成可实现的软件、配置和验收入口，把需用户／环境提供的条件单列；不能伪造真人成绩、正式教材来源、服务商成功、设备录音或干净系统安装。缺少这些证据时，最终明确区分“软件实现完成”和“真实验收未签核”。

## 已落地成果：先验证并保留

- 兼容服务媒体生成、待核候选、审批、实际下载及正式图片绑定；与模型共用来源准入、预算、频次、取消和未知用量保留规则。麦克风是 PCM16 WAV 真字节，明确开始／停止／试听／丢弃／保存，ASR 另需本人同意。ComfyUI、Whisper HTTP、FunASR WebSocket 已有实际协议适配和本地配置，但没有真实引擎／模型性能验收。
- B1 生成总入口在课程页：冻结证据 → 内容草案候选 → 人工审核创建课程 → 大纲候选与审核 → 课件候选 → 授课角色／教学配置候选与审核。任务落私有 KV；显式继续／重试，无自动发布。课件沿用既有候选区人工审核。
- 可视编辑画布支持拖动、多选、尺寸、旋转、图层并走原有 scene-plan revision/digest/requestId 保存。完整高级编辑仍未完成，见 B2。
- PDF/Office 实际提取、预览确认和一次性 token 导入；同一数据库事务分别归档提取 UTF-8 文本与原 PDF/DOCX/PPTX/XLSX 二进制，保留原件摘要／位置回执。原件下载复验 owner/project/generation/version/SHA。提取文本的 byte span **不代表 PDF 二进制位置**。无文本层 PDF 尚无 OCR；PPTX 当前是文本提取，不能冒充可编辑对象导入。
- PPTX 是 `pptxgenjs` 真序列化；支持原生可编辑表格／图表及限定数学 OMML，缺口诚实报告。`mphantom`、`mpadded` 不能删除语义后声称原生成功。静态 NotoSansCJKsc-Regular 已按 fsType／家族／字节／许可核验嵌入；粗体／斜体缺失不能伪造。Office/WPS 人工编辑仍未验收。
- MP4 真实闭合路径：持久任务、实际帧字节检查点、明确取消／恢复、Chrome 隔离截图、FFmpeg 编码、ffprobe 与全量解码、保存摘要绑定的 prepared 证明、文件发布、校验下载。发布后状态提交中断可复验原文件，不借用其他文件的解码证明。**当前是幻灯片／测验题面的静音公开投影**，不是完整互动／语音课堂。
- Pro 初步落地：owner-private SQLite 会话／消息／事件／技能，24 个固定技能参考，明确工具确认、课程候选和审核接入；共享 guarded conversation，实际多轮／nonce replay／取消晚响应测试。**仍是 partial**：外部认证、完整工具／技能产品、后台调度和恢复、候选完整预览及 UI 重试协议等未完成。
- 模型 provider 注册表、原生协议、显式模型发现、阶段路由、推理设置与桌面配置校验；阶段调用点已接课程、教学、反馈、判分、PBL、Pro。Anthropic/Google/Azure/Bedrock 经受控 SDK transport；通用兼容协议保留兼容旧精简响应的手写 adapter。注册表位于 `apps/learning/lib/provider-registry.ts`，服务目录是重导出；客户端禁止直接引用 server 模块。
- 课堂新加入沉浸全屏、角色面板开关、方向／Page／Home／End 导航及 Space 播放暂停，复用原实际播放引擎和持久导航。忽略输入控件、编辑区域、按钮链接、iframe、组合输入与修饰键；仍需浏览器／Electron 实机验收、角色活跃状态等。
- 数据库当前源码迁移到 **schema39**：35 媒体、36 MP4、37 文档二进制原件、38 执行租约、39 Pro 会话／技能。`store.executions` 支持独立 SQLite 连接下 claim/renew/release/fence/同步事务，不执行 callback 内异步等待。
- 课程生成和 MP4 已接 durable lease。旧执行者只能结算已派发用量，不得写业务候选；停止任务事务内撤销 lease，启动前读新状态，过期 running 恢复事务内写 failed；禁止自动重派未知付费请求。Pro 有接线，但需要更完整 crash／恢复矩阵。

## 全部剩余软件工作，逐包完成

以下是交接时的真实缺口摘要。请再对照 85 项各自 `acceptance` 和实际代码细化，不能仅完成摘要就忽略清单其他要求。

### B1 — OMA-004–009：生成总入口

补完整用户路径、阶段恢复、资源和主题处理、增量生成／并行取消／进度呈现、全部候选可查看后审核、教学配置采用。验证从材料到审核课件／授课配置的真实连续消费者；outline/provider 晚响应抢占后只结账，不能持久候选正文。模拟额度／超时／项目关闭／source revision 改变／lease 过期／独立连接 stop/retry／响应丢失的矩阵。

### B2 — OMA-018–024：DSL 与编辑器

- `lesson-scene-plan-editor.tsx`／`lesson-visual-canvas.tsx`：补完整原生对象属性和真实图片显示；`assetRef` 不能接受任意未审核资源当正式图片。输入框逐字符 commit 会膨胀撤销栈，应按完成一次用户操作提交。
- `lesson-scene-plan-state.ts`：当前 50 步历史仅组件内存，`loadLatest` 会重置；补 SQLite 或受控项目持久草稿／撤销恢复，绑定 owner/project/lesson/version/baseRevision/baseDigest。仅 sessionStorage 不足以跨桌面端口／重启恢复。保存后更新基线，不能把旧草稿盖到新 revision。
- `lesson-scene-plan-merge.tsx`：目前只展示 conflict，mergedScenes 默认保留目标；补逐项 keep-current/use-incoming/manual 决议与真实预览，全部冲突解决后才允许提交。换 source／关闭预览清理决议，保存仍经 baseRevision/requestId。
- `lesson-workbench.tsx` 已有完整课件候选，但未接编辑器；批量再生成应生成待核候选，人工逐 scene／element 选用，再一次提交计划，不能自动覆盖。
- 新建严格受限 AI JSON Patch 合同／预览／逐项审核／应用：允许必要 scene/element 属性，拒绝 source binding、身份、knowledge、未知路径/op、越界及未审核资产。复用生成 guard、现有 revision/digest/nonce，不另开无预算模型路径。

### B3 — OMA-050–055：导入与研究

补扫描件 OCR（实际可配置引擎与位置／原件追溯）、音视频时间／帧提取、网页抓取与多搜索源／研究事实核对、完整可编辑 PPTX 对象导入。当前 PDF/Office 文本提取需保留有损警告，不渲染／执行 macros、外部关系、嵌入脚本。网络研究必须 DNS/IP/redirect/内容大小／超时／取消受控；正文只能成为待核来源候选，未经审核不能入正式知识。上传／预览／确认要复验真实字节，不能信 renderer 自报摘要或长度。

### C1 — OMA-025–028：课堂界面

继续实机验证本轮沉浸／键盘／focus cleanup；补角色活跃状态、参与开关、跨场景恢复、窗口/DPI可访问布局。UI 应准确展示教师、AI 同学、本人身份和发言状态，不能把固定演练稿当实际代理输出。

### C2 — OMA-029–033：课堂编排

当前本地 Director 有本人核对的教师候选、固定演练同学队列、明确继续与私有等待。补完整公开 Director、多真实 AI agent、自由问答／圆桌／中断、分步板书／绘画及个人结果页。任何 AI 都不能代本人答题或写正式掌握度；教师白板权限、停止／handback／来源漂移／lease 边界须真实核验。

### C3 — OMA-034–037：作答／判分／反馈

保留现有本人不可变作答、客观题确定性判分、主观题待核候选、语义反馈人工审批。补全产品呈现、provider错误和恢复矩阵／候选冲突核对。测试语义评分质量必须真实标注材料与 rubric，不能凭无数据测试声称有效提升。

### C4 — OMA-038–045、085：互动

补来源绑定的安全 HTML 生成消费者、3D／仿真／游戏／关系图与流程图编辑、真实受限代码执行沙箱、教师观察／指导、interaction snapshot registry 的写入与恢复、按步骤技能训练。现有 iframe 和二维交互不能算完整能力。生成 HTML 必须防脚本权限逸出、网络与父窗口凭据泄漏；代码执行要实际隔离、超时／内存／输出限额／取消及重启，不能主进程任意执行 shell。正式互动记录仍是本人操作且有真实来源和 scene binding。

### C5 — OMA-046–049：PBL

补多人席位、角色／演练编辑、多人观察／指导／任务执行、跨设备 ownership 和恢复。当前本人私有 PBL 与指导候选不能代替多人产品。用独立真人／身份连接验证权限、重复提交、重连、lease 接管、AI 和本人记录隔离；模拟两客户端只证明协议。

### D — OMA-010–017：Pro

优先审查 `pro-session-service.ts`、合同／domain／storage／UI：

- 本轮已有成功多轮、付费用量、nonce replay、显式只读工具确认、取消忽略 Abort 晚响应验证。进一步验证 `courses.draft` 和 `courses.scene-plan.propose` 的完整候选预览、工具参数审核、人工采用、nonce lost-response replay、source漂移、竞态与崩溃恢复。
- Pro 页目前按冻结材料包 ID／摘要输入，应该接实际材料选择，不把内部编号作为常规产品流程。候选按钮目前引导去原课程区查看，需完整可审预览和可靠 revision 展示；不要让用户凭猜测输入 revision 来批准。
- 只要 UI 操作失败就新生成 nonce 会导致付费重复：应持久保存原意图／原 requestId，未知结果只查询／明确处理，不能自动重派。同一已执行请求应在 expectedRevision 校验前匹配可回放回执。
- pause/resume/takeover 有状态合同，但不能把 queued 当后台调度已完成；补实际 durable worker/claim/heartbeat/control/result reconciliation。Pro cancelled、paused、unknown 不应重新自动执行。跨进程控制必须 fence lease，所有业务 commit 要在同事务复验。
- 完整自定义技能编辑／导入／导出／删除／会话绑定／旧快照恢复；24 内置目录存在不代表 deep-research、pptx-import 等技能对应的产品消费者都实现。保持惰性有界资料，不默认执行脚本。
- **外部任务 bearer 认证尚未实现，本轮没有 `/pro/external` 路由或 token 仓库。** 外部 API 需要 owner/project-bound 高熵 token，数据库仅保存 hash、有效期、action scopes、撤销／轮换；明确创建一次展示，管理仅当前认证本机 session。项目 ID／generation 不是凭据。当前 `server.mjs` 在 handler 前需要 `x-sew-session`，外部 route 若要不同认证必须严格 exact-path 独立入口，不能放宽全部 `/api`、Host、Origin、桌面 control 路由。
- 服务预留 `commandProSession(raw, signal?, verifyAuthorization?)`，但外部撤销／过期最终commit与账务边界需要真正token消费者实测。外部最小scope只read/create/send，不默认授予工具执行／审核／发布权限。未写服务即不得声称 OMA-017 完成。

### E1 — OMA-056–059、066：模型配置

核对固定基线全部 providers 的协议能力和发现结果；SDK/transport、默认模型／窗口、推理参数要按实际适配，不把列表名当支持所有服务。阶段路由现在单 provider routeModels，不自动证明多 provider profile 独立切换已完整。补完整版本配置导入／迁移／回退和产品选择路径。Bedrock API key 推理与 SigV4 发现不同；文本按需 discovery 不包括 inference profiles/custom/provisioned，需要真实说明并按规划补齐。真实服务凭据不可写 fixture、日志或导出。

### E2 — OMA-060–065：媒体

补规划其他 image/video/TTS/ASR providers、声音设计／克隆／voice列表、音画同步、版本化价格与可核对实际usage/cost、全部媒体多执行器 lease／崩溃结果恢复。未知费用／usage 留预占，不能按 0 显示免费；重放原 nonce 不重新付费。别把已完成的麦克风／本地 adapter 重做成抽象stub；需要真实 engines／audio设备才能最终签核。

### E3 — OMA-067–072：导出

补 PPTX 对全部实际对象和数学结构的清晰支持矩阵／资源缺口、离线可运行 HTML、完整课堂 ZIP 导出／导入／资源迁移与恢复、MP4 完整课堂时间线／实际授课音轨／互动内容投影与同步。保留可编辑输出原则和教师／本人答案隔离。导出源必须当前审核发布版本，exported digest、plan digest、source digest都要匹配；非静态功能缺口不可吞掉。

### F1 — OMA-001–003：课程库

补跨项目全局库、成员管理、访问／共享状态、发布与撤回的实际受众路径。项目内文件夹／空文件夹／搜索已存在，不能误报未做，也不能用这些替代跨项目授权。

### F2 — OMA-073–079：持久化与宿主

补全部 DSL／历史数据库迁移链、资产存储层级／配额／真实大资源／备份恢复、规划 HTTP/Postgres adapters与部署消费者、team/anonymous owner claim、宿主 hooks。`@openmaic/storage@0.35.1` 的 agent-session/skill 有 pg adapter、无现成 SQLite Pro，不要假造package export；当前私有Pro自建仓库要保留。新表需同步旧 schema 模拟 fixture 的 drop 与 backup恢复检查；generic历史表枚举 regex必须含数字，否则 mp4 表不会被删除。

租约当前已可跨 SQLite writers；检查全部 media/model/Pro/background consumers都接 fencing，只有进程 Map不能当全局执行权。`withLease` callback只能同步，不能持DB事务跨 provider await。过期／关项目不重派 paid未知请求；恢复结果绑定真实输出／usage／nonce，不允许旧执行者覆盖新状态。

### F3 — OMA-080–084：产品与交付

补完整窗口/DPI／keyboard／accessibility、规划 12 语言与推理设置、所有层级恢复故障矩阵、远程部署／访问码／持久化／可靠身份、SBOM、 copied源／字体／图像／模型／运行时资产许可与字节追踪。默认用户流程不暴露内部 implementation。安装包实际运行与源码检查是不同证据。

## 执行顺序与核验

1. 先核对当前交接检查点与源码，然后尽快独立审查 Pro／MP4／B1 新路径，修复确定问题；不要停止在报告。
2. 逐实施包完成真实用户路径，先合同／storage/domain，再 guarded service，再 route/UI；每包跑有意义的定向测试。安排独立审查，主智能体逐项处理。不断更新85项证据表，但整项条件未满足不要标done。
3. 开发期源码检查：

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm check:code
pnpm exec vitest run --pool=forks --maxWorkers=2 --minWorkers=1 --exclude tests/desktop-http-boundary.test.ts --exclude tests/lesson-review-page.test.ts --exclude tests/model-connection-http.test.ts
```

三个暂时排除项依赖旧 build 的真实 HTTP/page；**最后 build 后必须跑回来**。不能永久排除，也不能声称包含它们的全测试通过。

交接检查点实际全量结果为167文件/1532测试通过，0失败/0跳过（native MP4显式启用），源码指纹503输入文件。测试命令使用forks/2 workers及临时 `$env:NODE_OPTIONS='--max-old-space-size=8192'`。该环境只影响测试进程，不是项目运行配置；以当前机器可用资源调整。详细日志、机器回执、剩余独立审查边界见交接检查点。

原生 MP4 源码集成（测试运行时独立未随包）：

```powershell
$env:SEW_RUN_MP4_INTEGRATION='1'
$env:SEW_FFMPEG_PATH=(Resolve-Path -LiteralPath 'output/mp4-runtime-tests/unpacked/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe').Path
$env:SEW_FFPROBE_PATH=(Resolve-Path -LiteralPath 'output/mp4-runtime-tests/unpacked/ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe').Path
pnpm exec vitest run tests/mp4-export-service.test.ts tests/mp4-renderer.test.ts
```

默认 MP4 两项 native 测试会 skip；启用上述环境才是真运行。若路径不存在先查实际环境，不下载假文件凑验收。测试 FFmpeg 9.0.2 essentials 为 GPLv3，不在正式依赖／PATH／分发中；要分发编码器，必须实际选择可合法交付的方案、许可和安装路径。

4. 重要实证：独立读取最终 PPTX ZIP XML／OMML／chart workbook／嵌入font/license；PDF/Office提取和原件下载实际 byteLength/SHA；全量 MP4 decode + frozen-source-reviewed → job → download；material version改变／取消／并发／重开／中断后late响应的确定性验证。模拟provider无需真实凭据，报告必须注明。
5. 所有软件项完成并源码检查通过后冻结写入，记录 HEAD/worktree、源码fingerprint、测试报告和资源receipt。再按项目脚本构建：`pnpm build:learning`（不要直接 next build绕过provenance）、`pnpm build:desktop`；使用已有prepare脚本组装服务，再做packaged运行和安装包核验。按脚本依赖避免无意义重建，最终证明 source fingerprint、Next BUILD_ID、service manifest、desktop package、verification reports属于同一批最后源码。
6. 最终 build 后执行 `pnpm check`／全部HTTP/page测试，`pnpm verify:service`、`pnpm verify:desktop`、`pnpm verify:classroom` 及实际脚本要求的路径／flag；如果verify脚本针对旧输出，需要正确参数和最新产物，不能拿历史report凑数。
7. 真正验收缺环境时，完成可审查代码和可复现实验／脚本，列清楚所缺凭据／设备／真人／材料；对正式materials、Mic／Electron、Office/WPS、真人双设备、remote部署、cleanWindows安装／升级／卸载等不代签。最终给出85项对照、测试数量与失败／跳过、构建产物路径／摘要、许可／SBOM、已修审查问题和真实剩余边界。

不要提交或推送未经明确授权的发布动作。用户此时授权实现、审查和最后构建；若最终要发布，先完成全部可review工作，再根据已有授权判断。
