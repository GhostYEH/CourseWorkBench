# 在线协作后续验收提示词 · 2026-10-08 更新

在线协作基础实现和本轮协议 5 / 数据库 schema v34 更新已完成本轮工程、原生回归和学习服务验收。本文件只列剩余实现与外部验收，不重复派发已完成的软件子项。实际检查、构建状态和遗留事项见[2026-10-08 收尾记录](closeout-2026-10-08.md)；运行与激活方法见 [ADR-0005](adr/0005-online-collaboration-service.md)。开始后续工作仍须核对 HEAD、工作区及远端，历史 BUILD_ID 和通过数不能沿用。

后续包含剩余软件与外部验收：

1. 当前协议 5 的公共板书已接通独立人工审核回执、write 准入和简图端点/方向/标签呈现；旧 v4 状态及未确认 write 保持为未审核历史，不自动重放或伪造回执。公共 AI 已有房主候选权威存储、受控路由、人工审核/播报面板和 shared-budget provider 本地主入口，目前是手动单次生成。不要重复实现上述基础流程。剩余工作是完整 Director、多代理自动整课及真实 provider、安装态验证。`origin: model_generated` 仅记录受控 gateway 的来源声明；独立服务上持有有效房主凭据的人可以提交 pending 候选，服务端不能据此证明发生了外部 provider 调用。继续保持唯一教师执行权、个人答案隔离和原请求幂等。

2. 在用户指定基础设施上部署独立协作服务，以 HTTPS 反向代理提供跨设备地址；本地学习服务继续只监听回环。分别为两位本人的 UID 离线签发一次性激活令牌，配置受控客户端环境。不要把公开 UID 当成登录或恢复凭据。
3. 两位真人、两台物理设备、一节已审核发布课程，完成邀请接受/拒绝/撤销/过期、双人准备和开始、公共课程与当前场景、双向文字讨论、各自个人课堂独立作答和判分、断连重连及客户端/服务重启读回。保留 COLLAB-EVAL-01 的真人证据，自动两个隔离进程不代替真人验收。
4. 继续保留干净 Windows 安装/升级/卸载、真实材料与 provider、真人两台设备及跨设备本人恢复的验收边界。PBL、媒体资产、PPTX/MP4 仍有未实现的完整产品范围，各按待办和开工清单分别推进，不承诺在一个实施批次全部完成。自动双客户端存储读回不等同真实 provider、完整 Director 或真人共同授课验收。

2026-10-07 公共板书与公共 AI 实施批次按用户要求使用 GPT-6-Luna / high 子智能体，主智能体集成和验收；后续委派以该次用户要求及适用 AGENTS.md 为准。不是唯一智能体，不回退他人改动；不读取或执行不可信 `.task-cache/` 脚本，不动真实项目/profile，不发未授权付费请求。

源码修改后，先冻结写入，再执行 `pnpm build:learning` → `pnpm check` → `node scripts/run-electron-boundary-smoke.cjs` → `node scripts/run-electron-boundary-smoke.cjs --suite collab-panel` → `node scripts/run-electron-boundary-smoke.cjs --suite pbl` → `node scripts/prepare-learning-dist.mjs` → `node scripts/verify-learning-dist.mjs`；另运行 `pnpm test:collab`。源码指纹、BUILD_ID、服务清单必须一致。无明确安装包/目录包请求不执行 `package:desktop` 或 `electron-builder`。

2026-10-06 在线实现批次已获当时用户授权提交/推送。该授权不是后续独立任务的自动发布许可；后续发布权限按该次用户请求确定。

2026-10-07 早先核验记录的已提交基线为 `3d9fa4d`（`11cd2db` 基础 + MP4 门禁修复），当时现存构建过期且没有重新构建。此后协议 5 / schema v34 以及 2026-10-08 的 PBL 本人运行消费者属于新的工作区变更；以[2026-10-08 收尾记录](closeout-2026-10-08.md)中根智能体记录的当前检查为准，不沿用旧通过数或发布授权。后续独立发布按当次用户请求办理。
