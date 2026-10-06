# 在线协作后续验收提示词 · 2026-10-06

独立服务、受控本地客户端和共同课堂面板已经实现，本文件不再用于重复派发在线实现。当前源码、独立审查和精确验证结果见 [收尾记录](closeout-2026-10-06.md)；运行与激活方法见 [ADR-0005](adr/0005-online-collaboration-service.md)。开始后续工作仍须核对 HEAD、工作区及远端，历史 BUILD_ID 和通过数不能沿用。

后续范围是外部验收：

1. 在用户指定基础设施上部署独立协作服务，以 HTTPS 反向代理提供跨设备地址；本地学习服务继续只监听回环。分别为两位本人的 UID 离线签发一次性激活令牌，配置受控客户端环境。不要把公开 UID 当成登录或恢复凭据。
2. 两位真人、两台物理设备、一节已审核发布课程，完成邀请接受/拒绝/撤销/过期、双人准备和开始、公共课程与当前场景、双向文字讨论、各自个人课堂独立作答和判分、断连重连及客户端/服务重启读回。保留 COLLAB-EVAL-01 的真人证据，自动两个隔离进程不代替真人验收。
3. 继续保留干净 Windows 安装/升级/卸载、真实材料/真实 provider、完整公共白板与教师运行同步、跨设备本人凭据恢复的验收边界；本轮公共内容展示不代表其余完整教学能力均已完成。

用户指定实现与审查子智能体使用 GPT-6-Luna / high，主智能体集成和验收。不是唯一智能体，不回退他人改动；不读取或执行 `.task-cache/`，不动真实项目/profile，不发未授权付费请求。

源码修改后，先冻结写入，再执行 `pnpm build:learning` → `pnpm check` → `node scripts/run-electron-boundary-smoke.cjs` → `node scripts/run-electron-boundary-smoke.cjs --suite collab-panel` → `node scripts/prepare-learning-dist.mjs` → `node scripts/verify-learning-dist.mjs`；另运行 `pnpm test:collab`。源码指纹、BUILD_ID、服务清单必须一致。无明确安装包/目录包请求不执行 `package:desktop` 或 `electron-builder`。

本轮用户已授权最终验收通过后提交并推送仓库。后续独立任务的发布权限按该次用户请求确定。
