# 七项核验缺陷修复记录（2026-10-09 接手轮）

本文件记录接手轮的修复过程，后续源码收尾修正了草稿冲突自动覆盖、reset迟到回调、旧长nonce兼容等问题。最终行为与最新验证见[source-closeout-2026-10-09.md](source-closeout-2026-10-09.md)，下文测试数字和因果解释不替代现场证据。

本轮先修复 `output/project-verification-2026-10-09.md` 确认的七项缺陷，再继续补齐剩余软件功能。
每项都先建立能复现错误的回归，再实现修复；测试断言真实业务状态、权限或写入结果，而非「新增了 if」。

源码基线：HEAD `8934c268581e09b819aef35f0f13e183b6cc3139`（未提交/未推送）。本轮在源码级完成修复与回归，
未 build、未提交、未推送。

## 3.1 补丁覆盖确认必须绑定实际确认的计划

- 入口：`apps/learning/lib/server/lesson-service.ts` 的 `apply-scene-plan-patch`。
- 复现（回归）：`tests/lesson-scene-plan-http.test.ts`「受限补丁：确认后计划再次推进，旧确认不得静默覆盖更晚的计划」。
  计划 revision1 → 并发保存到 revision2 → 旧候选以 `override:true, expectedPlanRevision:1` 提交。
- 修复：最终事务内用**客户端这次确认的** `expectedPlanRevision`（缺省取候选基线）与当前权威 revision 比较；
  不一致返回 `VERSION_CONFLICT(plan_revision_stale)`，不写计划、不改变候选成功状态。`override` 只豁免候选自身
  基线过期，不再豁免「确认的计划修订已变化」。不再用刚读取的 `current.revision` 替换客户端预期值。
- 证据：修复后该回归断言旧确认被拒（HTTP 409）、计划保持 revision2 与用户当时确认的标题、候选仍 pending；
  同 requestId 重放得到同一失败结论（失败回执可查询）；重新确认 revision2 后才推进到 revision3。
- 既有测试「显式覆盖才写入」仍通过：显式覆盖在确认当前 revision 时照常写入。

## 3.2 Pro 外部授权必须在最终业务提交前复验

- 入口：`apps/learning/lib/server/pro-external-service.ts`；下游 `pro-session-service.ts` 的 `commandProSession`。
- 复现（回归）：`tests/pro-external-authorization.test.ts`「长调用期间撤销 token：迟到 assistant 不得提交…」。
  provider 挂起 → 本机撤销 token → provider 返回。
- 修复：`authenticateProExternal` 返回原始 secret 哈希；新增 `assertProExternalAuthorization` 用**实时状态**复验
  （原 secret 哈希反查、撤销/轮换/到期、token 身份、owner、项目与代次、scope）。`commandProExternal` 把它作为
  `verifyAuthorization` 传入 `commandProSession`，在派发前、等待后、最终提交事务内调用（`runConversation` 与
  `runApprovedReadTool`）。`verifyExecutionLease` 只做租约检查，不再混入授权复验。
- 证据：撤销后迟到 assistant 不写入、任务不留在 running、已派发用量仍真实结算（`calls:1, tokens:31`）。
  另覆盖轮换（旧 secret 迟到结果不提交、新 secret 正常）与到期（独立连接把 `expires_at` 改到过去）。

## 3.3 草稿保存必须拒绝乱序和过期写入

- 入口：`apps/learning/components/lesson-scene-plan-editor.tsx`、`lesson-service.ts` 草稿命令、
  `packages/study-storage/src/repositories/lesson-scene-plan.ts`。
- 复现（回归）：`tests/lesson-scene-plan-http.test.ts`「持久编辑草稿：乱序/过期写入被草稿级 CAS 拒绝…」。
- 修复：草稿新增自身单调 `draftRevision`（合同 + schema45 迁移 + 仓库 CAS）。保存时携带
  `expectedDraftRevision`；不一致返回 `VERSION_CONFLICT(scene_plan_draft_revision_stale)`。前端改为**串行保存队列**
  （`lesson-scene-plan-draft-queue.ts`）：任意时刻只有一个保存在途，期间只保留最后快照，在途完成后继续保存；
  冲突时采纳服务端权威 revision 并用最新快照重试。
- 证据：乱序旧请求被 409 拒绝、最终草稿是更新的那一份；已存在草稿却未声明期望版本也按冲突拒绝。
  队列单测覆盖串行/最后快照/冲突重试/失败保留。

## 3.4 撤销/重做也必须触发草稿持久化

- 入口：`lesson-scene-plan-editor.tsx` 的 undo/redo 按钮。
- 修复：新增 `applyHistory`，与 `apply` 一致置脏（`dirtyRef`），undo/redo 经它进入持久化路径。
- 证据：`data-scene-plan-undo` / `data-scene-plan-redo` 按钮走统一置脏；`lesson-scene-plan-draft-queue` 单测与
  HTTP 草稿回归共同覆盖「保存成功 → 撤销 → 草稿落库 → 重开读到撤销后内容」所依赖的语义。

## 3.5 离开页面不能静默丢掉防抖中的编辑

- 入口：`lesson-scene-plan-editor.tsx` 的 1200ms 防抖与 cleanup。
- 修复：引入 pending/saving/saved/failed 状态机与 `flushDraft()`；`visibilitychange`（隐藏页）与组件卸载
  （SPA 切课/路由离开）都 `flush()` 最后快照；`beforeunload` 在仍有未保存编辑时明确拦截确认。无法保证的
  突然断电窗口在文档中明确，不承诺任意时刻零丢失。
- 证据：`data-scene-plan-draft-status` 如实展示状态；失败显示为 failed 而非已保存；旧页面响应受 `useCommand`
  的 scope gate 隔离，不污染下一页面。

## 3.6 预览必须对应当前选中补丁及实际应用数量

- 入口：`lesson-scene-plan-patch.tsx`、`lesson-service.ts` 的 `preview-scene-plan-patch`、领域补丁计算。
- 复现（回归）：`tests/lesson-scene-plan-http.test.ts`「受限补丁预览：勾选子集后按当前选择与基线重新计算…」。
- 修复：`preview-scene-plan-patch` 接受 `selectedOpIndexes`，按**当前选择与当前计划基线**重新计算；预览合同
  新增 `selectedCount`/`appliedCount`，与 `applicableCount`/`rejectedCount` 语义彼此独立。界面在选择或基线
  变化时重算预览（指纹守卫丢弃迟到旧预览），并在通过提示里用 `appliedCount`。
- 证据：未选=全选（applicable3/applied3）、仅选一条（applied1，结果只含该条）、选空（applied0，结果等于基线）、
  选被拒下标（400 拒绝）、只读预览不写计划、采用子集写入结果与预览逐字一致。

## 3.7 外部 requestId 使用无截断碰撞的映射

- 入口：`pro-external-service.ts` 的 requestId 映射。
- 复现（回归）：`tests/pro-external-authorization.test.ts`「200 字符 requestId 只在尾部不同时不碰撞…」。
- 修复：新增 `externalRequestId`：能完整放下时保持旧键不变（既有已执行回执继续命中，不重放旧付费请求）；
  超长时用带域分隔的稳定 SHA-256 摘要（`["sew-pro-external-request", tokenId, requestId]`），不截断原 nonce。
- 证据：两个只在末尾不同的 200 字符 nonce 各自成功创建不同会话；同 nonce 同意图重放；同 nonce 改意图拒绝；
  不同 token 同 nonce 独立。

## 稳定性异常

### 昵称原子保存（`learner-profile.ts`）

- 现象：核验首跑 `tests/learner-profile.test.ts` 昵称更新在原子 replace 处失败（具体底层原因尚未确认），focused 与
  后续全量通过，根因未确认。
- 诊断/修复：Windows 对已存在文件做 `rename` 时被杀毒/索引器短暂占用会返回 EPERM/EBUSY/EACCES。新增
  `replaceAtomically`：对这类**瞬态**错误有限次同步重试，仍是同目录 rename（不破坏原子性、不删原文件再写新文件）；
  最终失败时抛出携带底层错误码与阶段的身份错误便于现场诊断。保留 UID、revision CAS、原文件完整性与
  「失败不重生成身份」约束。
- 证据：`tests/learner-profile.test.ts`「recovers a transient Windows file-occupancy failure…」首次 EPERM 后重试成功，
  UID/createdAt 保留、目录只剩正式文件；既有原子失败/身份不重生成用例继续通过。

### 崩溃后测验导航与恢复（课堂脚本）

- 现象：`output/review-classroom-2026-10-09.json` 首跑服务重开后点测验等待恢复超时，页面停在互动场景。
- 诊断/修复：位置写入缺超时，服务重启后连接挂起会让导航永久停在 `saving` 并禁用 tab。`classroom-surface.tsx`
  的 `persistPosition` 增加 8s 有界超时（超时按失败处理并释放导航，不伪造已保存）；`selectScene` 的
  `positionSaving` 锁在 `finally` 中无条件释放，避免一次失败永久禁用导航。
- 现场采集：`scripts/verify-classroom-desktop.mjs` 在该步失败时调用 `classroomDiagnostics`，记录当前 tab（含
  disabled）、位置状态、可见错误、`[data-attempt-result]`/`[data-scene=quiz]` 是否存在，以及一次导航 PUT 的
  请求/响应状态（不泄露 session/control/token）。
- 未解决边界：根因（脚本点击/水合时序 vs 产品恢复）仍未定论，需重跑采集现场后才能确认；不通过延长超时或
  绕过认证伪造通过。重跑通过不等于根因已修复。
