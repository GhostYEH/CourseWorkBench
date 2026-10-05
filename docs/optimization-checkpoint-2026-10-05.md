# 全面优化续作记录 · 2026-10-05

本页保留暂停时的历史快照。恢复后已完成模型分阶段、命令生命周期、测验提取、目录批量读取及门禁接入；用户现要求交给其他智能体继续。最新验证、阻断和可复制提示词见[全面优化交接](optimization-handoff-2026-10-05.md)，下文的遗留项与检查结果不能直接当作当前状态。

暂停时用户要求先保存、提交，明天继续。源码保存为本地提交 `68e05ca`，本记录另存为 `6d423bb`。产品剩余范围仍以[待办事项](待办事项.md)为准。

## 已保存的优化改动

- 区分真实源码、构建产物与历史目录；忽略 `.task-cache/` 和 ESLint 缓存。保留桌面安装所需的 `apps/desktop/build/` 资源。优化前的本地源码快照在 `.task-cache/optimization/baseline/`，该目录不进入 Git。
- 建立 ESLint、React Hooks 与 Prettier 配置及依赖，尚未加入根脚本或完整工程门禁。没有对整仓格式化。
- HTTP 边界提取公共错误映射、错误详情清理、项目作用域校验和实际请求字节限制；文档、资产和 RuntimeStore 继续各自使用上游要求的原始响应合同。
- 将 `study-contracts/src/api.ts` 拆成按功能组织的 `src/http/` 模块，保留原来的显式导出入口。
- 将课堂命令与模型计量关联从 `StudyStore` 提取为应用服务，保留公开方法；计量汇总提取到纯领域函数，移除为读取总量而构造的假限额。运行事件尾序号改为直接查询。
- 统一权威 JSON 列读取、严格内容范围解码；新增存储模块的 SQL 插入显式列出字段；白板表结构只从版本迁移定义取得。历史迁移 SQL 保留，迁移版本检查连续性。
- 模型回包复验只将指定业务拒绝转换为迟到结果，内部/存储故障上抛并保留预占；已补入实际来源变化错误 `KNOWLEDGE_INVALIDATED`。
- 增加客户端命令锁、取消及过期结果门禁；评分、独立练习、反馈复习与个人课堂入口已接入。业务请求 ID 和持久收据仍由各自协议管理。
- 模型连接状态改为共享订阅，合并并发读取，以配置、会话和窗口聚焦事件刷新；设置界面从实际状态初始化。
- 计划生成/确认从 HTTP 路由提取为 `plan-service.ts`；部分工作台页面统一使用 `requireSession()`。计划服务拆分时的括号问题已修复。

该源码提交也保存了此前工作区中已有的身份、个人课堂、白板、正式互动、评分、反馈、共享预算和恢复功能及测试，不仅包含本轮重构。

## 暂停时验证

- `pnpm typecheck`：三个配置全部通过。
- `pnpm check:code`：分层、公开 DTO 边界、preload 同步、JavaScript 语法和构建一致性反例检查通过。
- 定向 Vitest：10 个文件、144 项全部通过，覆盖客户端命令门禁、模型调用复验、共享预算、课堂命令、白板存储、权威 JSON、范围隔离、正式互动、计划运行和 API 边界。
- ESLint：退出码 1，剩余 5 项 `react-hooks/exhaustive-deps` 错误，见下一节。
- 本次保存没有重新执行完整生产构建、全量测试、原生 Electron 冒烟或分发包验收。此前构建的输入摘要与当前源码已有差异，不能据旧产物声明当前版本验收通过。未调用真实付费模型服务。

定向回归命令：

```powershell
pnpm exec vitest run tests/command-gate.test.ts tests/model-call-guard.test.ts tests/shared-budget.test.ts tests/classroom-teaching.test.ts tests/storage-authoritative-json.test.ts tests/record-scope.test.ts tests/classroom-board-storage.test.ts tests/formal-interaction.test.ts tests/plan-run-roles.test.ts tests/api-boundary.test.ts
```

## 下次继续顺序

1. 修复当前 5 项 Hooks lint 问题：`classroom-board-panel.tsx` 的 `refresh` 依赖，`classroom-panel.tsx` 的 `refresh` 和清理阶段 ref，`FormalInteractiveSceneView.tsx` 的清理阶段 ref，以及 `use-command.ts` 的 `scopeKey` 依赖表达。`scopeKey` 用来换项目时重建门禁，不能直接删掉依赖来消除报错。
2. 完成客户端生命周期整合：继续检查白板、同学、档案、测验及正式互动入口；处理 `useCommand` 的错误状态随作用域变化，以及完成回调异常时的锁释放。测验事件串行追加、尾序号冲突重试、请求 nonce 和持久收据语义必须保留。
3. 收尾模型状态订阅：提供首次读取失败的可见错误与重试；将课堂表面残留的会话 token 轮询改为已有的事件等待入口，并核对界面/文档文案。
4. 核对 `DISCARDABLE_GENERATION_ERRORS`，用 `StudyErrorCode` 限制真实错误码，清理不存在的旧名称。补模型等待期间权威数据损坏和存储读取失败的复验回归，明确内部故障不会被误报为来源变化。保留项目代次复验失败后不访问数据库的边界。
5. 继续整理工作台编排、共享测试夹具和大型组件。计量历史兼容仍按实际请求 ID、来源与时间窗关联；不要新增已有的 `request_id` 列或把兼容投影当作授权数据。
6. 接入 lint/格式检查脚本及合适的检查范围；只格式化本轮相关模块。确认上游原样采用文件与安装资源的豁免范围，继续保留运行依赖和 fail-closed 边界。
7. 重新 `pnpm build:learning`，再执行 `pnpm check` 和 `node scripts/run-electron-boundary-smoke.cjs`，消除生产构建摘要失配并报告所有未执行用例。实质实现收尾后，请 `code_reviewer` 做独立只读复核，处理发现的问题；按产品待办需要继续组装并验证随包服务和当前目录程序。

初始独立代码审查已完成；本轮重构整体的完成后复核尚未执行。全面优化仍未结束，不能把本次保存解释为全功能完成。
