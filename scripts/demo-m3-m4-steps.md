# M3/M4 回归与人工演示步骤

更新：2026-10-06。命令从仓库根目录运行。自动回归、人工演示和安装态验收分别记录；未执行的步骤不得标为通过。

## 自动回归

生产 HTTP/SSR 用例依赖最终源码构建，不能沿用旧 BUILD_ID。

```powershell
pnpm build:learning
pnpm check
node scripts/run-electron-boundary-smoke.cjs
node scripts/run-electron-boundary-smoke.cjs --suite collab-panel
node scripts/prepare-learning-dist.mjs
node scripts/verify-learning-dist.mjs
pnpm test:collab
```

上述命令不生成桌面安装包。默认原生冒烟依次运行 boundary 和 lesson-plan；另选 collab-panel 验证真实登记表单、带项目代次的读写、受控轮询和离页清理。各套使用临时项目与 profile；服务验证也使用隔离数据。只有明确要求打包时才执行 `pnpm package:desktop` 或 `electron-builder`。

单独排查可用以下真实入口，它们不能代替全量门禁和真人验收。

| 行为              | 命令                                                                                                                                                  | 证据范围                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| AI 同学与本人优先 | `pnpm exec vitest run tests/classroom-peer.test.ts tests/classroom-peer-http.test.ts tests/classroom-peers-panel.test.ts`                             | simulation 分区、服务端调度与面板状态  |
| 共享预算          | `pnpm exec vitest run tests/shared-budget.test.ts tests/model-call-guard.test.ts`                                                                     | 本机受控调用，无真实付费请求           |
| 判分、订正与复做  | `pnpm exec vitest run tests/attempt-grading-storage.test.ts tests/feedback-review-storage.test.ts tests/feedback-review-http.test.ts`                 | 持久收据与本人行为约束                 |
| 课堂恢复          | `pnpm exec vitest run tests/classroom-recovery.test.ts tests/classroom-recovery-http.test.ts tests/storage-transaction-recovery.test.ts`              | 自动故障用例，完整应用崩溃矩阵另行验收 |
| 评测合同          | `pnpm exec vitest run tests/evaluation.test.ts tests/evaluation-api.test.ts`                                                                          | 合成机械数据，不代表真实准确率         |
| 本机协作          | `pnpm exec vitest run tests/classroom-collaboration.test.ts tests/classroom-collaboration-storage.test.ts tests/classroom-collaboration-http.test.ts` | local_link，不代表在线或双设备协作     |
| 在线协作链路      | `pnpm test:collab` | 两个隔离受控本地 route 连接独立服务，身份/邀请/公共场景/消息/恢复；不代表真人两台设备 |
| 课件导出          | `pnpm exec vitest run tests/lesson-export.test.ts tests/lesson-export-http.test.ts tests/zip-archive.test.ts`                                         | 静态 HTML ZIP，PPTX 尚未实现           |

## 已验证子项与人工待验

依据[最终收尾记录](../docs/closeout-2026-10-06.md)，~~原生 boundary/lesson-plan/collab-panel、隔离服务验证及 35 项独立协作双客户端链路~~已完成该源码快照的自动验收。当前源码一致性仍须重新核对；人工演示、真实材料/provider 与安装/双设备门槛继续待验，下列人工步骤不划为已执行。

## 人工演示

在专用演示目录创建测试项目，导入可公开的固定材料，完成知识点、课程与计划审核。不修改真实项目数据库，不通过手工 UPDATE、删除来源或终止所有同名进程制造故障。

1. 打开已发布课程，播放讲解，检查来源可定位、未审核内容不进入正式课堂。
2. 启用 AI 同学并提问，核对身份标注；等待本人作答时，同学与教师遵循服务端调度限制。
3. 本人提交简答题，核对待判分状态；在反馈页审核候选，检查订正与复做依据可核验本人行为。
4. 正常关闭并重开演示项目，核对冻结版本、当前场景、本人草稿与收据。正常重开不称为崩溃恢复验收。
5. 导出已发布课件，离线打开 HTML，核对正文、资源、来源与缺口；便携包核对清单。动态运行、真人协作和 PPTX 不包含在静态导出证明中。
6. 查看个人 UID。未配置独立协作服务或未通过本人认证时，应显示不能联网邀请；配置与激活方法见 [ADR-0005](../docs/adr/0005-online-collaboration-service.md)。在专用两个隔离客户端可检查邀请/双方准备/开始、同一公共场景、双向消息和重连；自动同机验证不代替两位真人两台物理设备，冻结已审核陈述讲解、真实元素聚焦/激光/清除与按 UID 等待/确认/释放或取消已实现，自动验证见同一双客户端脚本；生成式教师与完整公共白板仍留作后续。

每步记录提交、产物、测试项目、操作、实际结果和证据。录屏不得包含密钥、会话凭据、私人答案或无关项目内容。人工步骤未执行时记录“待执行”。

## 单独验收边界

- 两位真人、两台物理设备连接同一服务完成邀请、准备、同课、交流、独立作答与重连（COLLAB-EVAL-01）。
- 真实材料金标准、真实 provider、完整应用崩溃与迟到响应矩阵。
- 当前源码桌面目录包，以及干净 Windows 的安装、升级、卸载与数据保留。
- 窄窗、DPI、键盘和主题走查；个人档案/剪贴板历史偶发问题继续取证。

详细门槛见 [待办事项](../docs/待办事项.md)。
