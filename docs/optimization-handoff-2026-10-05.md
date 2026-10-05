# 阶段交接 · 2026-10-05

本轮按用户要求重新检查既有优化，保留并整合并行任务的改动，再收尾场景计划正确性与升级兼容。此前执行与复核使用 GPT-6 Luna / xhigh；最新续作按用户指定改用 GPT-6.1-Sol / high，主智能体指挥、集成并核验。部分子任务因账户额度中断，由主智能体接手；迁移兼容补丁与独立只读复核随后完成。M1—M4 仍按《待办事项》推进，阶段收尾不代表成品验收。

## 工作区与边界

- 项目：`D:\File\Ai与辅助教学\subject-exam-workbench`，PowerShell，分支 `main`；本阶段起点为 `a039835`，在其上依次推进 LESSON-02 陈述正文改写闭环与完整课件生成/场景计划编辑。源码摘要随新代码变化：陈述改写闭环阶段的旧摘要（6f9bc7d7…b4d7，304 个构建输入）已被后续提交取代，**当前**为 316 个构建输入、BUILD_ID `d5D529prjZ7Chbt5_Nos-`；304 与旧摘要均不代表当前源码。
- 另一智能体的未提交实现已保留并整合；只提交相关源码、测试与文档。评测生成目录已忽略，数据保留；构建、release 和缓存不入库。
- 不读取、执行、删除或提交 `.task-cache/`；不修改真实用户项目/profile，不发未授权付费 provider 请求。
- 最新续作按用户指定使用 GPT-6.1-Sol / high 子智能体，明确文件所有权，不回退他人改动；主智能体集成，实质改动完成后交 `code_reviewer` 独立只读复核。
- 验证期间停止源码写入；构建、check、原生、服务与目录包检查串行执行。

## 本阶段已完成

1. `useCommand` 的失效 scope 写保护：旧回调不能清除新请求 busy/error；有效命令启动后接管可见状态。
2. 同学面板区分主动取消与 scope 失效，失效提示恰好一次，并重读服务端权威状态；提示不声称服务端发言已撤销，卸载后不再通知或重读。
3. 上游课堂文档接口复用带实际字节限额的严格 UTF-8 入口，保留 32 MiB、204/原始错误体及审核顺序；真实 HttpDocumentStore 损坏正文能检出回退，中文逐字节分片仍被接受。
4. 评测生成结果目录加入忽略，格式清单覆盖新增同学模块和测试。
5. 课程派生按实际已选 statementId 集合判断变化；自动默认后缀不算标题改动，显式改标题或选择集合可派生。5 项定向回归通过。
6. SQLite CORRUPT/NOTADB（含扩展码）在完整性读取阶段归为 database_unreadable，其余异常保留；24 项备份回归验证具体 reason、源/原项目不变、关闭与暂存清理。随包 Node 22.22.2 的错误码也已核对。
7. 模型原生配置/诊断成功后，状态读取失败不再改写为操作失败；有效配置回执清空密钥，未确认保存方式时明确提示重读，保留真实诊断且不自动重发。10 项回归覆盖真实 desktop 校验入口的地址规范化、server 原字符读回、无效/旧状态、native/schema 失败和 scope 失效；复核发现的 URL 比较漏判已修正。
8. 备份路径提前拒绝 Windows 非法字符及 COM/LPT 上标数字设备名，仍接受合法 COM10；38 项备份回归覆盖恶意路径声明、源/备份不变、目标不存在及暂存清理，不实际创建危险文件名。README 同步移除过期的默认 provider 示例，说明加密不可用时只保留会话凭据。

本轮续作（LESSON-02 陈述正文改写闭环）：

9. 新增陈述正文改写候选：`lesson_statement_revisions` 表与 repository，候选只落待核区（`pending`），不写入课程版本、不改写原陈述；`origin` 固定为 `model_generated`，`reviewedBy` 由服务端写入，请求体不能自报。
10. 候选生成 `apps/learning/lib/server/lesson-revision-model.ts` 复用与课程草案/课堂讲解/错因归因同一套守卫（来源/run/预算/deadline/取消/项目代次），未配置模型或 guard 判定不通过时不发出任何 provider 请求；输出只解码一次并严格校验（新增允许入口），失败只记失败不落候选。
11. 人工处置 `store.applyStatementRevision`：通过时在同一事务内按知识点当前已批准证据重新冻结证据包（来源与准入重新复验）并追加新草案版本，来源与知识点沿用原陈述、正文变化得到新 statementId，且只替换目标场景、不回加基线已排除的场景；旧版本与旧证据包保持原样。拒绝只留档。
12. 课程派生命令补 `requestId` 幂等：`lesson_draft_receipts` 收据按意图返回既有版本，重复请求不追加；候选生成与处置也按 requestId 幂等（`lesson_statement_revision_receipts`）。
13. 独立只读复核发现并修复一处阻塞缺陷：`applyStatementRevision` 曾用重冻结证据包的全部陈述作为新版本场景集合，会把基线版本（如逐场景勾选派生得到的子集）已排除的场景静默加回。现改为沿用基线的 `statementIds`、只把目标场景替换为改写后的新 statementId，并拒绝候选指向本版本未选中的陈述（生成与处置两条路径都拦）。新增回归 `tests/lesson-statement-revision.test.ts`（18）、`tests/lesson-revision-http.test.ts`（3）覆盖上述行为，并扩展生产 SSR 断言；迁移 26 与两处历史迁移测试同步。

本轮两项修复经独立只读复核，未发现剩余确认缺陷；公共命令与同学面板生命周期复查也无确认缺陷，未修改其行为。既有备份容器、冻结评测、真实画布聚焦及审核/发布链保留。

本轮续作（LESSON-02 模型完整课件生成与多场景编辑，OMA-006/021/022）：

14. 新增场景计划与完整课件候选合同（`packages/study-contracts/src/scene-plan.ts`）：`scenePlanSchema`（场景用稳定 `sceneId`、元素带字号/颜色/加粗/斜体/对齐与位置尺寸、`revision` 乐观并发、`origin` 区分确定性/模型）、`scenePlanSaveSchema`、`coursewareProposeSchema`/`coursewareOutputSchema`/`coursewareApplySchema`；`MODEL_CALL_PURPOSE` 增 `courseware_generation`。
15. 领域层 `packages/study-domain/src/scene-plan.ts`：`assertPlanGrounded` 复验计划与冻结证据包相容（绑定在本版本已选范围内、知识点由服务端沿用一致）、`assertRichTextSafe` 富文本白名单（拒绝脚本标签、事件属性与脚本协议）、`duplicateScene`/`removeScene`/`reorderScenes`/`replaceSceneElements`（稳定编号）与 `coursewarePrompt`。
16. 存储层迁移 27：`lesson_scene_plans`（计划只挂草案版本、发布即冻结历史、`revision` 乐观并发）、`lesson_courseware_candidates` + `lesson_courseware_receipts`（候选只落待核区、按 requestId 幂等）；`store.saveScenePlan`/`applyCoursewareCandidate` 与 repository 落库。
17. 装配 `apps/learning/lib/classroom/planned-lesson-document.ts`：按计划装配幻灯片/测验/互动/PBL 四类场景，同一（证据包 + 计划）得到同一文档与同一指纹；`classroom-service` 的 `planFormalLessonDocument` 在有计划时走计划装配、无计划时回退确定性装配，两条路径共用同一份「这节课长什么样」的判定。
18. 服务/模型：`lesson-service` 增 `save-scene-plan` 与 `apply-courseware`（均按 requestId 幂等、来源与知识点由服务端沿用复验）；`apps/learning/lib/server/lesson-courseware-model.ts` 复用与其他模型入口同一套 guard，未配置或判定不通过时不发请求，产物只落待核区。
19. 界面：`lesson-scene-plan-editor.tsx`（增删/排序/复制/局部重生成、元素富文本与样式编辑、撤销/恢复）与 `lesson-courseware-generation.tsx`（生成/停止/通过/拒绝），状态机在 `lesson-scene-plan-state.ts`（整份快照历史，撤销/恢复语义确定）。
20. 新增回归 `tests/lesson-scene-plan.test.ts`（16）、`tests/lesson-scene-plan-http.test.ts`（5）、`tests/lesson-courseware-model.test.ts`（7），并扩展生产 SSR 断言；迁移 27 与历史迁移测试同步；格式清单覆盖新增文件。

本轮续作（场景计划正确性收尾，基于 `4eaa4ef`）：

21. 审核绑定实际计划 revision/digest；手工保存或应用候选改变内容后旧审核失效，发布与上课共用判定。运行时 get/list 复算内容摘要并核对 SQL/JSON 身份，拒绝正文被改写却仍保留旧摘要的计划。
22. 编辑器保存绑定实际加载的 revision；刷新到新计划时保留本地编辑，明确载入最新或确认覆盖。候选记录生成基线；覆盖确认绑定当前 revision/digest，服务端在同一事务复验预期修订，不能仅更新预期修订绕过冲突。
23. 保存与候选审批建立四态事务回执。前端保留原内容与 requestId，响应丢失只重放原请求；权威失败/取消后由用户明确开始新尝试。模型先查询回执及派发台账，已派发未知结果继续预占且不重发 provider。初次保存/审批先用共享合同校验，校验失败不锁死编辑器。
24. 迁移 29 兼容真实 v27 和已执行 v28 SQL 的旧 JSON、旧生成/审批回执。按实际快照回填摘要与归属，不用最新内容冒充旧回执。旧候选基线未知，已有计划时要求明确覆盖。旧 completed 回执保留 25–48 场景读取兼容；损坏身份、意图或内容整次升级回滚。
25. 历史已发布课程只有在 approved、两审核绑定均 NULL、bundle 一致、JSON/SQL 计划时间一致且有效、严格 `计划保存 < 审核 <= 发布` 时恢复绑定。草案、同毫秒、缺失时间或审核后改写无法证明，继续要求派生新草案并重审；历史课件、题目、答案与作答保持原内容。
26. 新保存/模型输出与领域上限统一为 24；历史 DTO 仍可读 48，编辑器提示删减而不自动截断。默认计划保留已选测验，题目课程不再初始化为空。富文本只重建无属性行内白名单，文本实体解码后转义，编码标签保持文本；通过真实 DSL 校验。
27. 原生冒烟增加真实鼠标/键盘编辑、本地无效标题修正、审核后编辑阻断发布、刷新保留未保存内容、真实已提交响应丢失后同 requestId 恢复、重新审核发布与实际课堂正文核验。模型专项使用假 provider，无真实付费调用。

GPT-6.1-Sol / high 的最终独立只读复核未发现额外确认缺陷；复核过程中发现的状态提示、无效输入锁死、迁移回执归属与历史大计划兼容问题均已修复。

## 当前验证

- 构建输入：316，BUILD_ID `d5D529prjZ7Chbt5_Nos-`，SHA-256 `6b67b22c0254db8599482ef6842c8d91d0da9118d2b321f8261e7c929eb6fca2`；重新验证当前输入与产物一致。
- pnpm check：102 文件 / 951 项，0 跳过；类型（含 IPC）、lint、格式与 12 项工程门禁通过。其后仅拆分原生测试脚本，工程检查与格式另行重验。
- 原生：默认 launcher 顺序运行 boundary 36 组、lesson-plan 7 组，均通过；每套独立临时项目/profile，保持原 240 秒与清理边界。原 36 组断言完整保留，包含真实剪贴板、备份恢复；计划 7 组含 2 个安全启动断言与 5 组真实计划界面回归。
- 服务：清单 12373 文件（不含自身）、最长相对路径 132/140，14/14；打包后逐文件摘要核对一致。
- 新目录包：`apps/desktop/release/plan-closeout/win-unpacked`，30/30（`apps/desktop/release/plan-closeout/pack01-verification.json`）；随包课堂 50/50（`apps/desktop/release/plan-closeout/classroom-verification.json`）。保留原 `win-unpacked`、历史 `review-*`、NSIS 与安装态；未执行正式安装升级卸载或独立干净 Windows 验收。打包工具下载了 Electron 运行时，无真实 provider 调用。
- 最终 GPT-6.1-Sol / high 独立复核：生产关键路径与原生套件拆分均无剩余确认缺陷；复核仅运行纯函数/内存 mock，最终产物与 UI 验收由主智能体完成。

本轮原生首跑在旧测验点击处报 `hit-obstructed`，加入点击序号、受控 hitTag 与几何诊断后未复现。第二次新增计划流程完成后，整条链在后续个人档案阶段触及总 240 秒；现默认命令拆为两套隔离运行并都通过，没有跳过断言或扩大时限。历史个人档案渲染/剪贴板偶发问题继续按 EVAL-03/UX-01 观察，不声称根因已修复。诊断不记录 UID、正文、剪贴板内容或凭据。

随包课堂 50 项不包含备份恢复或完整失效 Notice 生命周期；备份另由 boundary 覆盖。源与产物验证均针对本轮一致内容，旧 313 输入及旧报告只作历史。生成报告和评测 artifacts 不入库，未推送远端。

## 剩余范围与续作

- LESSON-02：陈述正文改写闭环、课程派生 requestId 幂等、模型完整课件生成与场景计划编辑（OMA-006/021/022）已落地；仍待做的是其余互动/PBL 的完整内容生成、资产生成（图片/媒体由模型产出并落库）与跨版本计划差异合并。
- M3：受控模型同学、复习调度、完整费用/租约与整应用故障恢复；在线 UID/邀请/同步/交流仍待推进。
- M4：当前产物评测/异常与 UI 走查、正式安装升级卸载、文档和演示；详细剩余工作只维护 `待办事项.md` 与 85 项能力清单，不新增审查报告。
- 真实材料与独立人工金标准、两位真人两台设备、独立干净 Windows、真实付费 provider 已按用户要求暂缓，保持未签核，不反复索要或用合成/单机双窗口代替。
- 正文改写闭环已落地（旧冻结版本与历史答案保持不变，新学科内容待审，生成/审核/发布/授课均复验来源；模型入口复用凭据/来源/预算/deadline/取消/项目代次守卫，测试使用假 provider）。下阶段按待办扩展审核互动绑定、PBL、媒体与跨版本合并，并继续偶发异常取证。

## 下一轮可复制的提示词

```text
请接手 D:\File\Ai与辅助教学\subject-exam-workbench。先读适用 AGENTS.md、docs/optimization-handoff-2026-10-05.md、docs/规划书.md、docs/开工任务清单.md、docs/待办事项.md 与 docs/openmaic-feature-parity.json，核对 git status/log 和当前输入。此前四项质量补丁、课程派生/SQLite 补漏、模型回执/备份路径修复、陈述正文改写闭环、课程派生 requestId 幂等，以及完整课件生成与场景计划编辑（OMA-006/021/022）均已收尾：画布聚焦、逐场景勾选派生、陈述改写闭环、场景计划编辑器与完整课件候选**不要重复实现**。

场景计划的审核绑定、编辑器实际修订/刷新冲突、候选基线/覆盖确认、事务内四态回执、原意图重试、已派发模型台账恢复、v27/v28旧JSON与回执迁移、受限历史已发布兼容、安全富文本装配、24场景新写入上限及默认已选测验均已实现并补回归，不要重复实现。先核验当前HEAD/工作树与文档所列最终报告是否匹配，保留现有合同、历史兼容边界与失败诊断。

随后按待办推进：默认计划中的审核互动与稳定定义绑定（区分显式删除与漏装配）、互动实际运行与本人提交、真实 PBL（任务/里程碑/交付物/评价，不以静态占位算完成）、受统一模型 guard 约束的局部生成、可视化画布、资产生成与落库、跨版本差异比较与合并（新增内容仍须经候选/来源绑定/人工审核/冻结发布）。另完成 UID 认证、邀请、同步与真人交流的软件链路。不要把 partial 当完成。

子智能体使用用户最新指定的 GPT-6.1-Sol / high，认领不重叠文件，主智能体指挥、集成、核验并交 code_reviewer 独立只读复核。若路由或额度不可用，如实报告并由主智能体接手，不能偷偷替换模型。保留未知模型结果预占且不自动重发、scope 隔离、测验 nonce/持久收据、本人优先与 simulation 分区，以及严格 schema/摘要和审核守卫。不得读取/执行/删除/提交 .task-cache/、覆盖他人改动、修改真实 profile/项目或发未授权 provider 请求。

停止并行写入后串行执行 build:learning、check、原生冒烟、服务组装/验证和新的 stage 目录包/课堂验证；核对同一源码摘要、BUILD_ID 与文件清单，失败如实处理，生成结果不入库。按实测从待办删除确定完成范围，更新交接和能力清单并提交相关改动。用户暂缓的外部门槛保留，M1—M4 满足约定范围和适用验收后才交付成品。
```
