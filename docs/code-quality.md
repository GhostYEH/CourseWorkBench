# 代码质量约定

本项目按职责分层，跨层依赖应朝向稳定契约：`study-contracts` 保存共享类型与 IPC 名称，`study-domain` 保存不依赖 Electron、文件系统或 UI 的规则，`study-storage` 实现持久化，应用层编排流程，Electron 主进程负责操作系统权限和窗口生命周期。底层包不要反向依赖应用层。

## 已核对整改与剩余门禁（2026-10-06）

| ID | 已完成的原定整改 | 仍需遵守/推进 |
| --- | --- | --- |
| N1 | ~~apiFetch 对成功/失败 envelope 和业务 DTO 做运行时 schema 校验，拒绝畸形响应~~（[客户端回归](../tests/api-client.test.ts)） | 新消费者继续复用合同；上游原始响应例外仍独立校验 |
| N3 | ~~实际 native handler 参数/返回值接 IPC 合同、独立 @ts-check 与漂移反例~~（[真实实现检查](../scripts/quality/ipc-contract.test.mjs)） | 范围限原生 handler，全部 CJS 类型覆盖未完成 |
| N8 | ~~既有计划/run/步骤收据等 JSON 的版本化 schema 与权威列损坏拒绝~~（[JSON](../tests/json-codec.test.ts)、[权威 JSON](../tests/storage-authoritative-json.test.ts)、[计划/run](../tests/plan-run-roles.test.ts)） | 新结构/迁移继续补消费者校验，不因原问题关闭而放宽权威边界 |
| N9 | ~~ESLint/Hooks、限定格式、分层依赖与原生 IPC 门禁接入~~ | learning/server.mjs 和其余历史脚本的语义 lint、完整 CJS 类型覆盖及明确格式范围仍待补 |

原定问题不重复派发；门禁要求持续有效。具体证据见[收尾记录](closeout-2026-10-06.md)，剩余范围见[待办](待办事项.md)。

## 类型与边界

- TypeScript 开启 `strict`、`noUncheckedIndexedAccess` 和未使用变量检查。优先为输入、返回值和外部数据定义具体类型。
- `any` 会关闭类型检查。除无法表达的第三方边界外禁止使用；边界处优先使用 `unknown`，通过校验或类型守卫缩窄。若确需 `any`，应把范围压到单个表达式并说明原因。
- JSON、IPC、HTTP、磁盘文件以及模型响应都是不可信输入。解析后先校验，再传入领域逻辑；不要把类型断言当作运行时校验。
- 界面调用使用 `apiFetch(path, responseSchema, init)`，响应类型从共享 schema 推导；必须同时校验信封、HTTP 状态和实际 DTO。RuntimeStore 独立错误格式仅在失败的运行接口适配；异常响应不得更新成功提示或作答收据状态。
- 命令视图状态只允许当前有效 scope 写入；旧回调不能清除新请求的 busy 或替换 error。scope 失效与主动取消分别处理；同学发言结果失效时显示中断提示并重读权威状态，不能把客户端停止等待写成服务端已撤销。
- 模型配置/诊断的原生回执与随后状态读取分开处理；读回失败不能改写已返回的诊断或诱导重复测试。未确认配置时清空密钥输入并提示重读，不宣称已加密保存；配置地址比较须兼容桌面入口的 URL 规范化，旧状态不能确认新配置。
- 返回给调用方的错误应可判断且不泄露凭据、绝对路径或内部堆栈。保留原始错误用于本地诊断，并在 UI 边界转换成可理解的提示。

## 权限与 IPC

- 文件、凭据、进程、网络监听和窗口控制权限由 Electron 主进程持有。渲染层通过 preload 暴露的逐项能力调用，不接触 Node API、`ipcRenderer` 或通用任意通道接口。
- preload 的 IPC 名称以 `packages/study-contracts/ipc-channels.json` 为唯一来源。修改该契约或 preload 模板后运行 `pnpm gen:preload`，提交生成的 `preload.cjs`；`pnpm check:code` 会检查同步状态及沙箱可加载性。Electron 沙箱 preload 的模块限制见[官方说明](https://www.electronjs.org/docs/latest/tutorial/sandbox)。
- 主进程处理每个请求时都要校验参数、项目/会话归属和允许的文件范围。界面隐藏按钮不构成权限检查。
- 渲染会话凭据与服务控制凭据分开；控制凭据只留在服务及主进程。内部授权、项目切换和备份必须走主进程能力。生产 SSR 与 API 都须验证会话；仅给本窗口主框架的精确服务 origin 注入会话头，不能给 iframe 或相似域名注入。
- 文件范围比较先解析真实路径，再使用目录相对关系判定；项目代次由服务统一分配。关闭/切换项目撤销临时授权，异步原生选择器返回后再次检查项目归属。
- 备份容器路径须可跨平台使用；Windows 非法字符和保留设备名（含 COM/LPT 的上标数字变体）在访问 payload 文件或创建恢复暂存目录前拒绝。测试修改清单声明，不创建危险路径，并核验原项目、备份与目标状态。
- 有副作用的命令应明确重复调用语义。能安全重试的写入、启动/停止和导入操作应具备幂等行为，或使用请求 ID 去重；不要让重试悄悄重复创建资源。

## 验证与提交前检查

- ESLint（含 React Hooks 规则）与 Prettier 已接入根脚本 `pnpm check`。格式检查只覆盖 `scripts/quality/format-scope.json` 里的显式文件清单，**清单通过不等于整仓已格式化**；不要为整仓运行格式化工具。`pnpm check:code` 负责可执行的分层与合同回归，**不替代人工代码审查**。它当前检查：
  1. preload 生成物与 IPC 合同同步、沙箱可加载性；
  2. 全部 Electron CJS 与 `server.mjs` 的 Node 语法；
  3. **分层依赖方向**（可执行）：`study-contracts` 不得反向依赖领域/存储或框架；`study-domain` 不得依赖框架、存储或文件系统 IO；`study-storage` 不得依赖 Electron/React/Next 或应用层；Electron 主进程不得依赖领域/存储包；独立协作服务 `apps/collab-service` 不得依赖 Electron/React/Next、应用层或本地学习服务（`apps/learning`）；
  4. **JSON 解析集中化**：`JSON.parse` 只允许出现在经校验或受控的少数文件（json-codec、项目 manifest、桌面状态/握手、全局偏好），其它位置必须改用 `json-codec` 或先经 schema 校验；多选提交的领域入口 `study-domain/src/assessment.ts` 与客户端恢复入口 `learning/lib/quiz-answer.ts` 分别在解析后校验数组、重复值和允许选项，损坏内容拒绝进入判分/恢复路径；HTTP 正文的带限额解码集中在 `apps/learning/lib/server/bounded-json.ts`（实际流式字节 → 严格 UTF-8 → json-codec，形状仍由调用方 schema 裁定），冻结评测导入和上游课堂文档接口均使用该入口，不再自带流式计数或直接解析；课堂文档仍保留 32 MiB、原始响应与审核顺序，非法 UTF-8 拒绝为 `VALIDATION_FAILED`，有效中文跨字节分片仍接受；浏览器侧用户选中的本地报告文件仍需在允许入口单独登记；
  5. **IPC 通道声明同步**：合同里声明的通道必须都被 preload 白名单使用。
  6. 客户端只消费 DTO 合同，不导入存储/领域包或服务端模块；包根导出显式维护。
  7. 构建输入摘要与 BUILD_ID 绑定；服务清单与 Electron asar 源码按内容校验，拒绝陈旧或不一致产物。
- `packages/study-storage/src/json-codec.ts` 是 JSON 列的唯一解析入口：版本化 zod schema + 可诊断错误；权威列（`knowledge_points` 的前置/证据、`questions` 的知识点绑定）损坏时抛 `INTERNAL` 拒绝使用，非权威列记录告警并回退显式默认值。禁止把损坏 JSON 静默当作合法数据。
- 新增或修复业务行为时，为关键分支、错误路径和权限边界补充测试；避免只断言实现细节的测试。
- 测验重试以提交内容摘要和单次提交 nonce 标识，不以字符串长度标识。持久收据复验题目、角色、内容、**请求声明的 kind 与实际提交类型**；新提交复验当前来源。前端浏览器存储不可用时退回页内去重，不能声称跨页面恢复仍可用。
- 运行 `pnpm typecheck` 检查包与应用的类型配置，`pnpm check:code` 检查上述分层与合同回归，`pnpm test` 运行 Vitest。
- Electron CJS 采用语法、生成合同与行为测试检查；普通桌面 tsconfig 的 `checkJs` 关闭，独立 `tsconfig.ipc.json` 对真实 native handler 实施 `@ts-check`、参数/返回约束与漂移反例，范围不等于全部 CJS。HTTP 生产集成用例依赖先完成 `pnpm build:learning`，缺少生产产物时该组跳过，须同时报告跳过数量。
- `pnpm build:desktop` 是桌面源码构建检查，会生成 preload 并检查 Electron CJS 语法。`pnpm package:desktop` 才会调用 electron-builder 打包。
- 领域核心不依赖 React / Electron / Next；`packages/study-domain` 只做判断，不做 IO。课堂文档使用上游 `@openmaic/dsl` 的形状，但该包只出现在 `apps/learning`：领域与存储层用 `unknown` + 自有 schema 处理文档，避免把上游契约变成领域权威。
- `apps/learning/app/api/maic/**` 是**合同例外**：`documents` 路由必须返回上游 `HttpDocumentStore` 能解析的原始载荷（文档对象、摘要数组、204）与 `{ error: { code, message, details } }` 错误体，不套本项目的 `{ ok, data }` 信封；`state` 等自有接口仍用信封。新增此类接口时同步更新 `docs/upstream-adaptation.md` 的采用登记。
- `assets` 同样遵循上游 `HttpAssetStore` 原始合同：分配返回 `201 {id}`，读取返回字节，替换/删除返回 204，HEAD 仅返回身份头；摘要只用于服务内部完整性校验。每个请求绑定项目身份与代次，异步读取后重新校验；读取、错误与 HEAD 均禁止缓存。上传先计数限制实际请求字节，再用平台 multipart 解析器处理，不能信任 Content-Length 或自行实现 multipart 语法。元数据不进入响应、错误详情或日志，不能接受调用者提交的权限身份。
- 课堂 `RuntimeStore` 与 account KV 的上游操作保留原始 HTTP 合同；本项目的学习者身份及复合测验提交接口使用自有信封。学习者身份由服务绑定；浏览器运行记录只保存草稿/低信任交互，不能提交判分结果或自行完成已判会话。本人作答、服务审核事件、会话完成与重试收据须在同一数据库事务提交，尾序号冲突须全部回滚。
- 演示/正式内容范围与本人/模拟行为身份分别保存。演示的编者审核不能满足正式人工语义审核；演示题上的本人作答仍为本人记录，但不得计入正式掌握和评测。页面读取不能隐式批准或把演示升级为正式。
- 已被课堂绑定的资产拒绝删除与内容替换；新资产须重新绑定经审核的新课件，不能通过替换旧 ID 改变已经审核的字节。相同内容的幂等导入保留既有修订。
- 上游课堂代码以固定版本的已发布包引入（见 `docs/upstream-adaptation.md` 第 7 节的版本与许可登记）。新增传递依赖时同时登记用途与许可，并确认 `pnpm prepare:learning-dist` 与 `pnpm verify:desktop` 的依赖解析检查覆盖它。
- 不要为整仓运行格式化工具来掩盖局部改动；沿用相邻代码的格式，提交时只包含任务相关文件。
- `pnpm build:learning` 通过受控脚本在成功构建且输入未变时记录摘要。组装与分发验证要求该记录匹配当前输入；直接 `next build` 不产生此凭据。生产 HTTP 测试前须用当前源码重建，不能仅检查 BUILD_ID 文件存在。
- 剩余缺口（N9）：格式清单仍按显式文件维护，`apps/learning/server.mjs` 与其余历史脚本尚未纳入语义 lint；桌面依赖图的完整 `checkJs` 尚未覆盖。上面的可执行检查是过渡措施。

## Agent 工作约定

- **打包限制**：除非用户明确要求生成安装包或未打包目录，否则任何 agent 在执行构建任务时不应调用 `pnpm package:desktop`、`electron-builder` 或其他打包命令。仅当用户明确请求"生成安装包"、"执行打包"或类似指令时才执行打包操作。
