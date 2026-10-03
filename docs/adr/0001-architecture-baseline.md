# ADR 0001：桌面架构基线与首版落地选择

- 状态：已接受（部分待验证）
- 更新：2026-10-04
- 关联：`docs/Electron开发设计.md`、`docs/开工任务清单.md`（ADR-01）、`docs/upstream-adaptation.md`

## 背景

架构采用 Electron 桌面壳 + 随应用启动的本地 Next.js 服务；本地服务统一拥有 SQLite，
工作台与课堂同属一个 React/Next 应用。固定课堂已通过本机真实安装/卸载；完整原宿主管线与独立干净 Windows 环境仍需按
[待办事项](../待办事项.md)完成验收。架构选择是在「先落可运行骨架」和「先复制 OpenMAIC 基线」之间取舍。

## 决定

1. **先落骨架，再接入上游。** Electron、Next 和 contracts/domain/storage 作为应用边界；
   来源准入、审核、身份与提交去重由本项目负责，OpenMAIC 课堂从同一生产入口接入，
   不整体复制上游源码后再拆分。
2. **数据库驱动改用 `node:sqlite`**，藏在 `SqlDatabase` 接口之后；`better-sqlite3`
   仍是候选驱动。
3. **IPC 通道名单放在 JSON**（`packages/study-contracts/ipc-channels.json`），
   Electron 主进程与渲染层读取同一份合同；沙箱 preload 使用由该 JSON 生成的内嵌名单，
   通过生成物同步检查防止漂移。沙箱 preload 不能直接 require 工作区模块。
4. **本地服务用自定义启动器 `server.mjs`**：只监听 127.0.0.1、端口由系统分配、
   随机应用会话凭据经 stdout 单行 JSON 回传主进程。
5. **领域包只导出 TS 源码**，由 Next `transpilePackages` 直接消费，不额外维护构建产物；
   因此包内相对导入不使用 `.js` 扩展名。

## 理由

- 本作品的核心贡献是来源治理与执行可靠性（《规划书》第 1 节），这部分不依赖上游代码，
  可与课堂复用分层推进。
- 复制上游后再拆，会在没有验收标准的情况下同时改动框架版本、原生依赖与存储适配；
  《开工任务清单》明确要求「不因为首周困难退回只做静态页面」，也不要求先整体搬迁。
- `node:sqlite` 避免把 SQLite 驱动绑定到 Electron ABI，并将驱动选择限制在 `SqlDatabase`
  接口之后；服务中的其他动态原生模块仍需按随包 Node 环境验证。
- 领域错误需要跨打包实例判定（领域包与应用各自打包一份 contracts 时 `instanceof` 失效），
  因此 `isStudyError` 同时做结构判定。

## 后果

当前生产证据支持继续采用上述架构：目录包 30 项和本机安装态课堂 32 项验证通过，作答/review/收据保存在服务 SQLite，整应用重启与服务崩溃后读回同一记录；卸载保留外部项目与数据库。结果和安装包摘要见[上游适配记录](../upstream-adaptation.md)第 7.6 节。尚无证据要求引入第二套 Vite 入口或把数据库搬入主进程；这不是干净 Windows 或完整 OpenMAIC 宿主的最终签核。

分发试验暴露的是依赖物化布局和 NSIS 长路径限制，已通过精确版本共享、局部冲突依赖与安装路径预算处理。它没有推翻服务进程/数据库的责任划分。新增依赖必须重算预算并重复分发验证，不能把目录包能启动当作安装包资源完整。

正面：

- 本地服务作为 SQLite 唯一写入者，降低桌面 UI、课堂和存储之间的多权威风险。
- IPC 白名单由共享 JSON 约束，沙箱 preload 不需要加载工作区模块。
- OpenMAIC 课堂可通过同一生产入口接入，来源与身份规则留在本项目边界内。

风险与待处理：

- 完整原宿主管线、独立干净 Windows 环境、系统 DPI/多显示器仍需验收；M0 是否通过以[待办事项](../待办事项.md)列出的门槛为准。本机安装、卸载和原生项目切换已有实测，不再列为未执行。
- `node:sqlite` 是实验特性，API 可能变化；驱动实现位于 `packages/study-storage/src/driver.ts`。
- `server.mjs` 的认证与父子进程握手属于本应用边界；standalone 输出与静态资源由分发组装逻辑适配。直接改用上游 `server.js` 会丢失该边界。
- OpenMAIC 若要求不同的 Next/React 版本，需在 `apps/learning` 统一版本并单独评估升级影响。
- 服务的动态原生模块须与随包 Node 的 ABI/平台兼容；SQLite 驱动不绑定 Electron ABI 并不消除这一分发要求。

## 备选方案

| 方案 | 未采用原因 |
| --- | --- |
| 先整体复制 OpenMAIC，再逐步加备考页面 | 首周无法产出可验证的来源合同；依赖树庞大且含大量首版不启用的能力 |
| 工作台用 Vite、课堂用 Next（两套入口） | 《Electron 开发设计》明确避免并行两套生产入口与跨 iframe 消息协议 |
| 主进程直接用 `better-sqlite3` | 与「本地服务唯一写库」冲突，并把原生 ABI 绑定到 Electron |
