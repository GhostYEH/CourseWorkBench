# ADR-0005：在线协作服务与受控客户端链路

日期：2026-10-06。范围：M3 双人共同课堂的**在线部分**（UID-01 / ROOM-01 / INVITE-01 / SYNC-01 / CHAT-01 的联调前置）。
上游设计：[ADR-0004](0004-collaboration-service.md) 已定地址/协议/部署方向；本 ADR 把「在线登记、本人认证、独立服务进程、双客户端链路」落实为可运行实现。
状态：**实现与自动化双客户端链路本机验证完成；在线部署与真人双设备 COLLAB-EVAL-01 未验收。**

## 1. 复用边界与文件所有权

沿用既有合同与判定，不另立第二套协作方言：

| 层 | 复用 | 本 ADR 新增 |
| --- | --- | --- |
| `packages/study-contracts` | `classroom-collaboration.ts` 的命令/结果形状；`classroom-room.ts` 的 `classroomSharedCourseSchema` | `collaboration-service.ts`：在线登记/凭据/会话/场景同步/快照命令与结果；`authority` 放宽为 `local_link \| online` |
| `packages/study-domain` | `collaboration.ts` 的邀请/消息/事件/游标/入场/执行权判定 | `collaboration-auth.ts`：凭据验证、登记并发、吊销、恢复、会话绑定、场景推进的纯判定 |
| `packages/study-storage` | `CollaborationRepository`（邀请/房间/成员/消息/事件/收据） | `collaboration-service.ts`：独立库 `CollabServiceStore`（自有迁移、在线 authority、凭据/会话/快照表）；`CollaborationRepository` 增加 `authority` 选项、`syncScene`、快照与凭据方法 |
| `apps/collab-service` | — | 独立进程入口 `server.mjs` + TS 应用（认证、路由、健康检查、协议版本） |
| `apps/learning` | 本机链路 `/api/study/collab/*` 与 `collab-classroom.tsx` | 受控客户端：`/api/study/collab/online/*` 代理、凭据受控存储、在线面板接线 |

分层约束不变：客户端只消费 DTO；`study-domain` 不做 IO；`study-storage` 不依赖应用层；协作服务只依赖 contracts/domain/storage。

## 2. 独立协作服务

- **入口** `apps/collab-service/server.mjs`（纯 JS，与 `apps/learning/server.mjs` 同源）：解析 `--host --port --data-dir --dev`，用 `node --import tsx` 加载 TS 应用，`--port 0` 由系统分配并把真实端口写进 stdout 单行 JSON ready 握手；`/health` 返回 `{ ready, protocolVersion, instanceId, dev }`。
- **地址**：默认 `127.0.0.1`；跨设备地址由配置 `SEW_COLLAB_SERVICE_URL` 提供，必须使用 HTTPS 反向代理。HTTP 只接受 `127.0.0.1`、`localhost`、`[::1]` 本机测试地址，不发送跨设备明文凭据。本地学习服务始终只监听回环，不直接开放给远端。
- **数据**：独立数据目录（`SEW_COLLAB_DATA_DIR`），与用户项目数据分离；卸载本地应用不删除协作服务数据。
- **协议**：HTTP 轮询；信封与本地服务一致（`{ ok:true, data }` / `{ ok:false, error }`）；路径前缀 `/collab/v1`，协议版本写入响应与健康检查。所有协作 API 还必须携带 `x-sew-collab-protocol: 1`；版本不一致在产生副作用前拒绝。

## 3. 在线唯一登记与本人认证

- **UID 是公开标识，不是凭据**：知道 UID 不能登录。
- **登记**：管理员通过离线 `provision.mjs` 按本人 UID 签发一次性激活令牌，服务端只存哈希（迁移 32）。首次登记须验证并在登记事务中消费该令牌，不能凭公开 UID 抢注。客户端在受控边界生成随机 `credentialId + secret`，网络发送前保存完整未确认登记意图；响应丢失或重启后仍复用原凭据、激活令牌和 requestId。后续追加/轮换必须证明本人有效凭据，激活令牌不能替代恢复证明。收据中的秘密只保存哈希，并参与意图比对，不含明文。
- **会话**：`POST /collab/v1/session` 用 `{ credentialId, secret }` 换取服务端会话令牌（32 字节随机数，不可猜测），绑定 `uid`。其余请求用 `Authorization: Bearer <token>`，服务端从会话取 UID；请求体自报他人 UID 一律 `collab_identity_mismatch`。吊销凭据会同时清理该凭据已签发的会话。
- **吊销/恢复**：本人可吊销凭据；吊销后不能认证。恢复只能凭未吊销凭据重新登记，**无法验证归属的恢复不开放**。
- **凭据边界**：只留在受控服务/原生配置（`apps/learning` 用户数据目录），不进浏览器存储、日志、项目快照或导出。

## 4. 共享权威与隐私投影

- 共享房间/邀请/成员/消息/事件由协作服务持有；个人草稿/答案/判分/错题/掌握/材料库留在各人本地。
- 共享快照只发送经 `classroomSharedCourseSchema` 校验的**公共投影**（复用 `freezePublishedRoomCourse`）：剔除测验答案、排序 `correctOrder`、关系正确目标、评分依据与私人观察。
- 发出邀请前，本地受控客户端读取实际冻结课程，依次创建共享房间、发布公共投影、发出邀请；每一步使用由原 requestId 派生的稳定收据，丢响应可继续原操作。上传仅限房主，首次投影正文冻结，同一文档摘要也不能替换正文；退出成员无上传/推进收据重放权限。本地冻结时复验资源字节，服务端存取投影时复算正文摘要。
- 两端通过 `CollabSharedScene` 消费同一公共快照和服务端场景指针；公开题干、参数/关系/排序材料可共同查看，私人答案、评分与观察仍留个人课堂。公共展示不代替个人作答或判分。

## 5. 结构化场景同步

- `syncScene` 命令：目标 `sceneId` + 课程身份（lessonId/lessonVersion）+ 房间 `revision` + `expectedSeq` + actor。
- 服务端复验唯一教师执行权（`assertCollabTeacherEventAllowed`）与序号（`assertCollabEventAppendable`），并**要求房间已 `active`**（未开课不得借推进把房间从 `ready` 置为 `active`，`collab_room_not_active`），在**同一事务**内推进 `currentSceneId`、房间 `revision` 与 `scene_changed` 事件收据；不再用只有 `summary` 的摘要代替同步。
- 普通事件入口（`POST /collab/v1/events`）拒绝 `kind=scene_changed`：场景切换只能经 `scene-sync`，避免「事件说切了场景、房间 `current_scene_id` 没变」的脱节。
- 流程状态不代替本人作答，也不广播私人答案。

## 6. 客户端、断连与代次

- 增量轮询（按 `afterSeq` 取 `(afterSeq, tailSeq]`）、断连提示、重连与**原 requestId 重试**；丢失响应后不换 requestId 重发。未确认共享命令按项目和本人 UID 隔离恢复，持久化不含凭据；磁盘凭据与未确认登记只在受控用户目录。
- 项目切换/退出/卸载停止旧客户端写 UI；旧身份与旧代次的迟到响应无效；当前状态未查明时不显示邀请或准备成功。
- 只有真实连接与本人认证均成功才开放在线能力；离线或 `local_link` 继续显示「不能联网邀请」。

## 7. 验证

- 单元：`tests/collaboration-auth.test.ts`（认证判定）、`tests/collaboration-service-storage.test.ts`（凭据/吊销/场景原子提交/隐私投影）、`tests/collab-online-client.test.ts`（地址解析/凭据受控存储/失败语义）、`tests/collab-online-http.test.ts`（在线入口 HTTP 边界）。
- 双客户端链路：`scripts/collab-two-client-link.mjs` 用两个隔离数据目录、两个本人凭据、两个真实客户端连同一独立服务，覆盖登记、邀请接受、双人准备与 start、同一快照、双向消息、结构化场景推进、断连重连、丢响应原 requestId 重试、重启读回，以及第三身份越权/已退出/争抢房间/游标越界/版本不一致/隐私投影/重复副作用计数负例（最终通过数见收尾记录）。
- 自动双客户端**不**称为两位真人两台物理设备验收。

## 8. 保留未验收

在线部署、两位真人两台设备 COLLAB-EVAL-01、干净 Windows 安装/升级/卸载、真实材料与真实 provider 未执行时均保留未验收。`local_link` 仍是本机事实，不静默改成在线认证成功。

## 9. 可运行命令

- 启动协作服务（开发）：`node apps/collab-service/server.mjs --dev --data-dir <目录>`；生产默认 `--port 0` 由系统分配，`--host`/`SEW_COLLAB_HOST` 默认 `127.0.0.1`。
- 管理员按本人 UID 签发令牌：`node apps/collab-service/provision.mjs --data-dir <服务数据目录> --uid <本人UID>`。命令返回 `{uid,activationToken}`；该能力不开放 HTTP 接口，管理员将令牌交给对应本人。
- 在本人的受控本地服务/桌面启动环境设置 `SEW_COLLAB_ENROLLMENT_TOKEN=<activationToken>`，开通成功后无需再次配置。令牌不填写到网页或项目文件。
- 让本地学习服务连接它：跨设备设置 `SEW_COLLAB_SERVICE_URL=https://<协作服务域名>`；本机自动测试可用 `http://127.0.0.1:<port>`。桌面进程会向受控本地服务传递配置环境。
- 双客户端链路验证：`node scripts/collab-two-client-link.mjs`（两隔离数据目录、两凭据、两真实客户端；最终通过数见收尾记录）。
- 单测：`pnpm vitest run tests/collaboration-auth.test.ts tests/collaboration-service-storage.test.ts tests/collab-online-client.test.ts tests/collab-online-http.test.ts`。
