# 全部能力矩阵（85 项 + UID 双人课堂新增范围）

本轮接手核验与实施记录。**口径**：`partial` 不等于 `done`；本矩阵单列「软件实现状态」，不把外部条件未具备的验收
划进软件缺口，也不把软件缺口归为外部待验。编号与验收以 `docs/openmaic-feature-parity.json` 为准。

- 基线：HEAD `8934c268581e09b819aef35f0f13e183b6cc3139`（本轮未提交/未推送、未 build）。
- 计数（本轮更新后，现场核实）：**85 项 = 71 partial / 14 planned / 0 done**。
  - 本轮把 **OMA-033、OMA-045、OMA-081、OMA-083、OMA-085** 由 planned 推进为 partial（各有真实消费者与回归）。
  - 其余 planned 14 项：OMA-030、031、039、041、042、043、044、052、053、054、055、063、078、079。
- 逐项证据见 `docs/openmaic-feature-parity.json`；本文件给出汇总与软件缺口/外部待验分类。

## 1. 本轮新增/推进的真实消费者

| 能力                  | 入口 → 消费者                                                                                                                                                                                                                                           | 回归                                                                                                                                                                                                                                                  | 仍存软件缺口                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| OMA-033 课程完成页    | `packages/study-domain/src/course-completion.ts` → `apps/learning/lib/server/course-completion-service.ts` → `app/api/study/lessons/completion/route.ts` → `components/course-completion-panel.tsx`（课程工作台已发布版本）                             | `tests/course-completion.test.ts` 3 项                                                                                                                                                                                                                | 真实科目题库完成度校准、真人验收          |
| OMA-081 十二语言      | `packages/study-contracts/src/locale.ts` + `http/preferences.ts`（uiLocale/courseLocale） → `app/layout.tsx`（lang/dir/data-locale） → `components/appearance-settings.tsx`                                                                             | `tests/locale-registry.test.ts` 5 项                                                                                                                                                                                                                  | 逐 key 界面翻译、课程内容本地化           |
| OMA-083 部署访问码    | `packages/study-contracts/src/deployment-access.ts` + `packages/study-domain/src/deployment-access.ts` + `schema46` → `apps/learning/lib/server/deployment-access-service.ts` → `app/api/study/deployment/*` → `components/deployment-access-codes.tsx` | `tests/deployment-access.test.ts` 6 项                                                                                                                                                                                                                | 接入方端到端远程房间、干净环境验收        |
| OMA-045 互动保活/快照 | `packages/study-contracts                                                                                                                                                                                                                               | domain/src/interactive-snapshot.ts`+`schema47`→`apps/learning/lib/server/interactive-snapshot-service.ts`→`app/api/study/interactive-snapshots/route.ts`→`components/openmaic-adaptation/InteractiveSceneView.tsx`                                    | `tests/interactive-snapshot.test.ts` 2 项 | 通用互动组件现场恢复、安装态验收        |
| OMA-085 步骤技能训练  | `packages/study-contracts                                                                                                                                                                                                                               | domain/src/formal-interaction.ts`（procedural_skill） → `lib/procedural-skill-authoring.ts`→`components/formal-interaction-author.tsx`+`openmaic-adaptation/FormalInteractiveSceneView.tsx`+`lib/server/formal-interaction-service.ts` + 共享快照投影 | `tests/procedural-skill.test.ts` 3 项     | 真实 provider 生成质量、Office/真人验收 |

## 2. 七项缺陷修复与稳定性

见 `docs/defect-fixes-2026-10-09.md`（3.1–3.7 逐项复现/修复/证据）与其中的两项稳定性异常（昵称原子保存、崩溃后测验恢复）。
稳定性异常根因未完全定位的边界已如实记录。

## 3. 逐项矩阵（85 项）

| ID      | 状态    | 阶段 | 能力                                   | 现有实现/消费者（摘要）                                                                       |
| ------- | ------- | ---- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| OMA-001 | partial | F    | 课程库与搜索/筛选                      | 课程库浏览已落地；缺跨项目/全局库与发布访问状态（OMA-003）。                                  |
| OMA-002 | partial | F    | 课程文件夹与成员管理                   | 项目分区文件夹 CRUD、归组/取消分组、空文件夹可重启读回。                                      |
| OMA-003 | partial | F    | 课程发布/撤回与访问状态                | 项目内发布/撤回与 published/withdrawn 存在；缺完整成员/访问及跨项目状态。                     |
| OMA-004 | partial | B    | 主题与资料创建课程                     | 生成总入口（冻结来源门禁→内容草案→大纲→课件→教学配置）；缺全流程恢复与真实 provider。         |
| OMA-005 | partial | B    | 大纲生成、预览与人工调整               | 逐场景派生、陈述改写、跨版本差异/合并预览；缺完整阶段消费者/断点矩阵。                        |
| OMA-006 | partial | B    | 幻灯片/测验/互动/PBL场景生成           | 真实 DSL 校验、24 场景上限、来源绑定；缺资产生成与互动/PBL 完整内容生成。                     |
| OMA-007 | partial | B    | 授课动作和角色档案生成                 | 角色/教学配置待核候选、事务内复验；尚非完整运行时动作生成。                                   |
| OMA-008 | partial | B    | 渐进生成、停止、局部重试与继续         | 独立阶段 + 显式继续/停止/新 nonce 重试 + lease fencing；缺全部阶段消费者与完整故障矩阵。      |
| OMA-009 | partial | B    | 图片/视频/音频媒体任务编排             | 真实图像/视频/TTS/ASR 请求、持久候选、审核消费；缺完整 provider/音色/同步。                   |
| OMA-010 | partial | D    | Pro对话式课程规划与修改                | owner-private SQLite 持久消息、多轮/nonce replay；缺完整后台任务/外部权限/产品恢复。          |
| OMA-011 | partial | D    | 工作台直接挂载真实课堂                 | 复用同一 ClassroomSurface；缺安装态与真实设备验收。                                           |
| OMA-012 | partial | D    | 持久会话、消息、事件与历史             | 严格序列事件、owner/project 分区、修订 CAS；缺完整会话管理/恢复。                             |
| OMA-013 | partial | D    | 取消、继续、干预与任务接管             | unknown 不自动重派 + 控制合同；缺实际接管恢复/队列执行与完整故障矩阵。                        |
| OMA-014 | partial | D    | 会话材料上传/引用/提取                 | 引用正式冻结材料包 + source admission guard；缺会话材料上传/提取完整产品路径。                |
| OMA-015 | partial | D    | 课程工具与24个内置教学skill            | 固定受控工具 + 24 内置技能登记；缺全工具产品/参数预览/端到端审批矩阵。                        |
| OMA-016 | partial | D    | 自定义skill创建、导入、管理与导出      | 自定义技能存储/会话启用/导出/删除；缺完整编辑/导入体验/旧快照恢复。                           |
| OMA-017 | partial | D    | 外部工作台skill与生成任务API           | bearer token、最小 scope、exact-path 入口；本轮补授权实时复验与 requestId 无截断映射。        |
| OMA-018 | partial | B    | 完整课件DSL与版本迁移                  | 写入前 validateStage/validateScene、未来版本 409；缺全 DSL 迁移矩阵。                         |
| OMA-019 | partial | B    | 文字/公式/图形/图片/表格/图表/媒体课件 | 真实 Slide/PPTText 形状、PNG 图片与公式字体；缺表格/图表/媒体完整编辑导出。                   |
| OMA-020 | partial | B    | Pro画布拖动/缩放/旋转/多选             | lesson-visual-canvas 接入编辑器；缺完整 Pro 对象及冲突/历史。                                 |
| OMA-021 | partial | B    | 元素属性、样式和富文本编辑             | 可编辑元素 + 富文本白名单 + 撤销/恢复；缺完整可视化画布与局部模型重生成。                     |
| OMA-022 | partial | B    | 场景增删、排序、复制与局部重生成       | 稳定 sceneId、差异/合并、逐项冲突决议；缺按整课大纲批量重生成。                               |
| OMA-023 | partial | B    | AI编辑及校验后的JSON Patch             | 受限补丁候选 + 逐项审核 + 乐观并发；本轮补覆盖确认绑定实际确认的计划。                        |
| OMA-024 | partial | B    | 编辑历史与多会话修改记录               | 持久编辑草稿；本轮补草稿级 CAS/串行保存/撤销置脏/离开保存；缺多会话修改追踪与完整版本时间线。 |
| OMA-025 | partial | C    | 真实课堂加载与四类场景导航             | 真实上游 PlaybackEngine/Stage；缺四类场景最终验收与干净 Windows。                             |
| OMA-026 | partial | C    | 播放/暂停/速度/动作级导航              | 实际播放引擎 + Space；缺速度/完整动作级导航。                                                 |
| OMA-027 | partial | C    | 沉浸模式与键盘操作                     | 全屏/退出/焦点恢复/方向键导航；本轮补位置写入有界超时；缺真实设备/DPI 验收。                  |
| OMA-028 | partial | C    | 多角色教师/同学档案与配置              | 角色/教学配置候选、权限派生；缺角色活跃状态/参与开关完整产品。                                |
| OMA-029 | partial | C    | 教师授课、自由问答与课堂讨论           | 受审核逐场景 Director 队列 + 模拟同学；缺公共房间/多真实模型代理/自由问答。                   |
| OMA-030 | planned | C    | 圆桌讨论和用户中断/优先                | 缺完整公开 Director 圆桌与中断产品。                                                          |
| OMA-031 | planned | C    | 白板文字/公式/图形与逐步推导           | 缺逐步白板绘画与完整关系呈现。                                                                |
| OMA-032 | partial | C    | 聚光灯/激光笔/聚焦与动作编排           | 真实画布 focus/laser + 撤销/重放；缺在线原生操作与真人验收。                                  |
| OMA-033 | partial | C    | 课程完成页与学习反馈                   | 本轮落地：完成度领域函数 + 只读服务/路由/面板。                                               |
| OMA-034 | partial | C    | 单选/多选/简答完整题型                 | 三题型登记、冻结、本人提交；缺真实科目与安装态验收。                                          |
| OMA-035 | partial | C    | 判分、过程、反馈与答案显示规则         | 客观题精确判分、简答待判、答案展示策略；缺真实语义评分质量标注。                              |
| OMA-036 | partial | C    | 不可变作答/草稿/进度持久化             | 同事务提交/收据/去重；缺整应用新安装态验收。                                                  |
| OMA-037 | partial | C    | 本人/AI演示分区与learner绑定           | 服务绑定主体、AI 不提高本人掌握；缺完整分区呈现验收。                                         |
| OMA-038 | partial | C    | 生成式HTML互动与iframe隔离             | sandbox allow-scripts + 边界断言；缺通用组件恢复与生成式互动完整产品。                        |
| OMA-039 | planned | C    | 3D可视化互动                           | 缺真实 3D 场景与资源/公式来源可查。                                                           |
| OMA-040 | partial | C    | 模拟实验与参数预测/观察                | 参数公式、本人预测/观察/解释；缺完整交互产品。                                                |
| OMA-041 | planned | C    | 知识游戏与评分/成就                    | 缺真实挑战与可信评分规则。                                                                    |
| OMA-042 | planned | C    | 思维导图/流程图/关系图互动             | 关系图有受控路径；缺完整图流编辑与标准关系证据。                                              |
| OMA-043 | planned | C    | 在线编程与测试用例                     | 缺真实受限代码执行后端。                                                                      |
| OMA-044 | planned | C    | 教师观察、高亮、设置条件与引导         | 缺真实场景消息与工具动作关联课程版本。                                                        |
| OMA-045 | partial | C    | 互动保活与可支持的快照恢复             | 本轮落地：互动快照合同/领域/schema47/服务/路由 + 演示组件保活；缺通用组件现场恢复。           |
| OMA-046 | partial | C    | 项目制学习场景与角色选择               | 本人语义冻结、AI 席位、证据准入；缺多真人授权与完整项目编辑。                                 |
| OMA-047 | partial | C    | 阶段任务、里程碑与交付物               | 任务开启/更新、草稿/收据、AI 贡献分离；缺多真人/跨设备。                                      |
| OMA-048 | partial | C    | 导师指导与项目评价                     | 真实连接运行时 + 候选采纳；缺外部 provider 指导质量验收。                                     |
| OMA-049 | partial | C    | PBL模拟器与任务工具                    | 真人 demo 回放工具、权限/步数/nonce 门禁；缺完整 AI/导师多角色演练。                          |
| OMA-050 | partial | B    | 文档上传与多格式内容抽取               | txt/md 导入 + 不可变版本；缺 OCR/媒体时序。                                                   |
| OMA-051 | partial | B    | PDF、OCR、表格与公式解析               | PDF.js 文本 + Office ZIP/XML + 原件归档；缺 OCR/可编辑 PPTX 导入。                            |
| OMA-052 | planned | B    | 音频/视频转写与关键帧材料              | 缺时间位置转写与关键帧提取。                                                                  |
| OMA-053 | planned | B    | 网页资料与多搜索provider               | 缺受控网页抓取与多搜索源。                                                                    |
| OMA-054 | planned | B    | 深度研究/事实核查/材料引用             | 缺研究候选证据与引用核查产品。                                                                |
| OMA-055 | planned | B    | PPTX导入与文档/资产转换                | 缺可编辑 PPTX 对象导入与出处登记。                                                            |
| OMA-056 | partial | E    | 完整LLM provider注册表与兼容接口       | 固定 registry + 真实 adapter；缺真实全 provider 覆盖。                                        |
| OMA-057 | partial | E    | 本地模型与Lemonade/Ollama连接          | loopback 路径进注册与校验；缺真实安装本机模型验收。                                           |
| OMA-058 | partial | E    | 模型发现、思考配置与分阶段路由         | 显式发现、有界结果；Bedrock 仅按需文本基础模型。                                              |
| OMA-059 | partial | E    | 配置预设、服务端配置与连接检测         | 固定预设/推理参数/阶段路由；缺多 provider profile 独立切换与版本恢复。                        |
| OMA-060 | partial | E    | 多provider图像生成与ComfyUI工作流      | 兼容 images/generations 消费者；缺 ComfyUI/多 provider/真实付费验收。                         |
| OMA-061 | partial | E    | 多provider视频生成与轮询任务           | 兼容 Videos 创建/轮询/下载；缺多 provider 与远端恢复/取消结算。                               |
| OMA-062 | partial | E    | 教师讲解与讨论TTS、播放速度            | 兼容 audio/speech 生成；缺完整课堂同步播放/多角色音色。                                       |
| OMA-063 | planned | E    | 音色管理、自然描述、声音设计/克隆      | 合同存在；缺真实音色参考持久化与合成可播放。                                                  |
| OMA-064 | partial | E    | 麦克风ASR与本地FunASR等后端            | 麦克风录制/远端转写消费者；缺真实设备/OS 权限与本地引擎。                                     |
| OMA-065 | partial | E    | 多模态用量记录与查看                   | 四档 ledger 重算；缺真实 provider 用量/价格版本/崩溃外部结算。                                |
| OMA-066 | partial | E    | 缺provider/断网/额度与任务失败状态     | 明确状态与预算保留；缺跨执行者完整故障矩阵。                                                  |
| OMA-067 | partial | E    | 可编辑PowerPoint导出                   | pptxgenjs 真实序列化 + 限定 OMML；缺字重/对象支持缺口与 Office/WPS 验收。                     |
| OMA-068 | partial | E    | 自包含互动HTML导出                     | 确定性 ZIP + index.html + manifest；缺 KaTeX/Three.js 内联。                                  |
| OMA-069 | partial | E    | 完整课堂ZIP导出/导入                   | 静态 ZIP 导出；缺正式互动的离线运行/提交与 ZIP 导入侧。                                       |
| OMA-070 | partial | E    | 离线资源内联与重导出                   | 资源清单逐项登记；缺 KaTeX/Three.js/addons/字体内联。                                         |
| OMA-071 | partial | E    | MP4导出与独立渲染任务                  | 持久任务 + 真实帧检查点 + 编码/解码；仅静音公开投影，缺完整音轨/互动时间线。                  |
| OMA-072 | partial | E    | 资源打包和媒体可移植引用               | 可移植相对路径；缺外部媒体重定位与更广格式。                                                  |
| OMA-073 | partial | F    | DocumentStore版本/CAS/DSL迁移合同      | schema 到 46；缺全 DSL/backend 迁移矩阵。                                                     |
| OMA-074 | partial | F    | RuntimeStore会话/追加seq/分区合同      | 有序追加/CAS/完成保护；缺真实聊天/教师运行分区。                                              |
| OMA-075 | partial | F    | AssetStore资产注册/替换/引用/回收/配额 | 项目分区字节/摘要/修订；缺多课程引用保护/大媒体/完整上游管线。                                |
| OMA-076 | partial | F    | device/account KV与偏好恢复            | HttpAccountKV 项目/代次绑定；缺完整跨设备同步。                                               |
| OMA-077 | partial | F    | SQLite默认与可选HTTP/Postgres后端适配  | 保留后端接口；缺规划 HTTP/Postgres 真实消费者。                                               |
| OMA-078 | planned | F    | 所有者认证/匿名认领/共享团队扩展       | 缺完整 owner 认证/匿名认领/共享团队。                                                         |
| OMA-079 | planned | F    | 课程库/创建/资产后端宿主扩展钩子       | 缺宿主扩展 hooks。                                                                            |
| OMA-080 | partial | F    | 暗色/主题/响应式/布局与操控            | 主题/密度/缩放偏好；缺完整窗口/DPI/键盘走查。                                                 |
| OMA-081 | partial | F    | 12个locale国际化与语言推断             | 本轮落地：12 locale 注册表 + 语言推断 + UI/课程语言设置。                                     |
| OMA-082 | partial | F    | 课堂文档/白板讨论/作答/互动分层恢复    | 四层恢复核对 + 持久状态；不代表所有组件/AI 讨论/真人跨设备恢复完成。                          |
| OMA-083 | partial | F    | 共享部署/访问码/可选远程连接           | 本轮落地：访问码合同/领域/schema46/服务/路由/界面。                                           |
| OMA-084 | partial | F    | 版本冻结、许可、资源与SDK可追踪复用    | 许可回执/SBOM 部分；缺全部复制源/字体/模型/运行时字节追踪。                                   |
| OMA-085 | partial | C    | procedural-skill步骤技能训练           | 本轮落地：procedural_skill 定义/领域核验/作者/消费者/共享投影。                               |

## 4. UID 双人共同课堂新增范围

- 现有：`collab-*` 服务与客户端、邀请/房间/成员/消息/事件、共同白板标记同步（协议 3）、公共白板命令（协议 4）、
  AI 候选通道（协议 5）；`scripts/collab-two-client-link.mjs` 双客户端链路。均为 `partial`。
- 本轮：访问码（OMA-083）为「共享部署接入授权」提供明确授权入口，但**不**等于把接入方接入真实在线房间的端到端远程部署。
- 外部待验：双真人双物理设备、跨设备 ownership/重连/接管。

## 5. 外部待验条件（单列，不计入软件缺口）

真实 provider 凭据/质量、正式教材来源、目标设备麦克风与 OS 权限、Office/WPS 人工编辑、双真人双物理设备共同课堂、
干净 Windows 安装/升级/卸载、远程部署网络矩阵。这些需要独立证据，不能由模拟测试替代；本轮不代签。

## 6. 软件缺口（继续实施，未缩减）

仍 planned 的 14 项（OMA-030/031/039/041/042/043/044/052/053/054/055/063/078/079）与 71 项 partial 的各自验收边界
（详见 `docs/openmaic-feature-parity.json` 每项 `evidence` 末尾的边界说明）均为**软件缺口**，需继续实现，不因本轮推进
五项而视为整体完成。全部软件实现完成前不 build。
