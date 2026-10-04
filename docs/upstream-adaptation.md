# 上游适配记录

维护实际采用的上游路径、基线摘要、修改目的与关联验证。OpenMAIC 课堂和持久化适配的当前缺口见[待办事项](待办事项.md)。

## 1. 基线与来源边界

| 项目 | 本地位置 | 基线/许可 | 适配边界 |
| --- | --- | --- | --- |
| OpenMAIC | `F:/file/OpenMAIC-main/` | 1.1.1；Next 16.3.3；React 19.2.3；Node >= 22.19.0；pnpm 10.28.0 | 课堂渲染、教师、互动及相关存储合同的目标基线；尚需按实际接入记录修改路径与验证 |
| good-learning-skill | `F:/file/good-learning-skill-main/` | MIT，`Copyright (c) 2026 yoli-mi` | 备考领域合同参考；不把原始技能文本或不适用能力当作课堂运行时 |
| AI-Novel-Writer | `F:/file/AI-Novel-Writer-master/` | 桌面根 GPL-3.0 | 布局/主题/项目会话设计参考；遵循[第三方来源声明](THIRD_PARTY_NOTICES.md) |
| deepseek-harness | `F:/file/deepseek-harness-master/` | MIT | 事件、等待、收据和恢复语义参考 |
| EvoFlow | `F:/file/EvoFlow-main/EvoFlow-main/` | PolyForm Noncommercial | 任务可视化与记忆隔离参考；不复制其代码或引入其许可限制 |

当前直接依赖包括 `next`、`react`、`react-dom`、`zod`、`zustand`、`electron`、`electron-builder`、`typescript`、`vitest`、`tsx`。新增依赖需登记用途与许可证。

## 2. 待接入的上游合同与源位置

| 上游合同/源码位置 | 本项目适配位置 | 尚需完成的适配 |
| --- | --- | --- |
| `@openmaic/storage` `DocumentStore`（`document/http` 的 `HttpDocumentStore`） | `apps/learning/app/api/maic/documents/[[...segments]]/route.ts` + `packages/study-storage/src/repositories/classroom.ts` | 路径/方法、204 写入、上游错误码、409 `FUTURE_VERSION`、项目分区与读写审核指纹守卫已有真实客户端回归；outline 保留在完整文档内，无独立端点。修改 outline 同样须重新审核 |
| 上游 `DocumentFolderStore` 与 `/api/folders` | `app/api/folders/**`、`repositories/document-organization.ts`、schema v8 | 项目分区创建/重命名/成员归组与取消分组；摘要可选 folderId。删除仅支持 ungroup，remove 明确拒绝，不能通过组织操作级联删除受审课件；课程库 UI 未接入 |
| `@openmaic/storage` `AssetStore`/`HttpAssetStore` | `apps/learning/app/api/maic/assets/**` + `packages/study-storage/src/repositories/classroom-assets.ts` | SQLite 保存项目分区的字节、内部 SHA-256、元数据、修订与场景绑定；客户端按会话/项目代次下载并生成对象 URL。演示图片与公式字体使用实际字节；跨课程引用保护、离线回收和大媒体仍需补齐 |
| `@openmaic/storage` `HttpRuntimeStore`、`HttpAccountKV` | `app/api/maic/runtime/[...segments]/route.ts`、`app/api/maic/kv/[...segments]/route.ts` + SQLite runtime/KV repositories | 已实现原始客户端合同、服务绑定 learner、追加序号与版本冲突、项目代次复验。测验提交由服务原子保存本人作答、review 与收据；`AgentSessionStore` 和教师编排仍未接入 |
| OpenMAIC PlaybackEngine、课堂加载与场景分派 | `components/openmaic-adaptation/`、`components/classroom-surface.tsx` | 播放引擎、类型、游标、导航、时序及原 ClassroomSurface 页面加载/重试/退出流程实际复制后适配；Stage 视图与场景分派为窄适配。M0 通过服务加载/资源释放端口接线；Director、编辑器、教师/白板及生成媒体管线按后续里程碑接入 |
| OpenMAIC `ROLE_ACTIONS` 与角色运行时 | 课堂角色桥接 | 上游 student/assistant 可能默认拥有白板动作；本项目首版同学仅发言，需显式收窄权限 |
| OpenMAIC 前端 HTTP adapter | `apps/learning/app/api/maic/*` | 渲染端使用上游 `HttpDocumentStore`；文档 body 保持原始合同，额外项目身份/代次头由本地适配添加并在服务端复验 |
| 互动 iframe 与资源加载协议 | `openmaic-adaptation/SceneRenderer.tsx` | 保留沙箱、当前窗口与实例检查、onLoad 就绪、上游 runtime-error/早期错误重放协议。上游没有周期心跳；本适配没有声称实现心跳。编辑器/资源选择器与 iframe 池未采用 |


每项源码适配落地时记录真实上游路径、基线摘要、改动目的和相关验证。不得以设计目标代替实现记录。

## 3. 数据库驱动与运行边界

存储驱动入口为 `packages/study-storage/src/driver.ts` 的 `createNodeSqliteDriver`，对上层暴露 `SqlDatabase`。`node:sqlite` 避免把 SQLite 驱动绑定到 Electron ABI，便于由随包 Node 的本地服务持有数据库；若兼容性要求更换驱动，应在同一接口后评估 `better-sqlite3`。

风险：`node:sqlite` 属于实验特性，`DatabaseSync` API 可能变化并产生 `ExperimentalWarning`。驱动替换仍需核验事务、备份与错误语义。服务的其他依赖可能含动态原生模块，分发时须验证其与随包 Node 的运行兼容性。

## 4. 固定架构边界

1. `apps/learning` 是唯一生产入口，不并行维护 Vite 工作台。
2. 课堂复用 `ClassroomSurface`、`scene-renderer` 或 `director-loop` 时，来源准入、身份和持久化经 `study-domain` 与 `study-storage`，课堂不能成为知识权威。
3. 上游前端适配器可保留调用形状，后端接入本地 storage adapter。
4. iframe 保持隔离，资源访问由服务按项目/场景授权；不得接收任意磁盘路径。

## 5. 当前实现约束与待验收边界

| 源位置 | 需保留的技术边界 | 后续验收 |
| --- | --- | --- |
| `apps/learning/server.mjs` | 自定义启动器承担 127.0.0.1 监听、握手及会话/控制认证；直接换成上游 `server.js` 会丢失本应用边界 | 在真实课堂生产包与无开发 Node 的 Windows 环境验证，见 PACK-01/02 |
| `apps/learning/next.config.ts`、`scripts/prepare-learning-dist.mjs` | standalone 输出受 monorepo 根检测影响，产物需组装到消费者预期的服务目录；依赖树物化需避免指向仓库外部的链接 | 真实课堂接入后重建包，核对运行文件、静态资源及依赖 |
| `apps/desktop/src/main.cjs` | 由主进程定位随包 `resources/node/runtime/`，控制本地服务和项目授权；渲染层不持有原生能力 | 验证原生选择器、真实课堂、安装/卸载及干净环境恢复 |
| `packages/study-storage` | OpenMAIC AssetStore、课程 Material/Skill 和持久课堂会话仍需按使用范围适配 | 未接入的能力需明确禁用；启用后不能回落为浏览器权威数据 |
| 课堂入口 | 固定三场景使用上游渲染器、实际播放引擎和服务端存储；窄适配不能替代完整 OpenMAIC 宿主 | 完成生产包、安装态与干净 Windows 验收；教师、白板、Director 等继续按后续里程碑实现 |

## 6. 基线与来源核实记录（2026-10-03）

对本地快照 `F:/file/OpenMAIC-main` 执行 SET-01/SET-02 的核实结果，命令与观察均实测：

| 项 | 结果 |
| --- | --- |
| 版本身份 | `package.json` = **1.1.1**；`packageManager` = `pnpm@10.28.0+sha512.05df71…`；`engines.node` = `>=22.19.0`；生产依赖 132、开发依赖 32 |
| 框架版本 | Next 16.3.3、React 19.2.3（与 [全功能分析](OpenMAIC深度剖析与全功能对齐.md) 记录一致） |
| 工作区 | `packages/` 含 `@openmaic/*`、`mathml2omml`、`pptxgenjs`、`docs`；存在 `pnpm-lock.yaml`、`pnpm-workspace.yaml` |
| 版本控制 | **该目录不是 git 仓库**（`git rev-parse` 报 not a git repository），因此无法用提交哈希固定来源；只能以版本号 + lockfile 作为基线锚点 |
| 依赖安装 | `pnpm install --frozen-lockfile`：解析 **2531** 个包、下载/命中缓存 **2511** 个；虚拟存储 `node_modules/.pnpm` 已 2.0G / 2531 项 |
| 依赖链接失败根因（2026-10-03 复测） | 用 `pnpm install --frozen-lockfile --offline` 重跑：`added 2531` 后在创建符号链接时终止，报 `ERR_PNPM_EISDIR` 并明确提示 **「F: 驱动器是 exFAT，不支持符号链接」**。顶层 `node_modules` 仍为空、`next` 未链接、`packages/@openmaic/renderer/dist` 不存在。**上一轮记录的「沙箱内链接极慢」不是根因，exFAT 无符号链接才是** |
| 链接可选出路 | 把快照移到 NTFS 卷，或按 pnpm 提示在该快照里改用 `node-linker=hoisted`（会失去按 lockfile 精确隔离的形状）。本轮不需要它，见下条 |
| 课堂代码获取方式（本轮采用的决定） | OpenMAIC 的课堂契约与渲染器**已作为 MIT 包发布**，本项目直接按版本固定安装已发布产物，不再从快照链接/构建：`@openmaic/dsl@0.11.2`、`@openmaic/renderer@0.1.11`、`@openmaic/storage@0.35.1`（三者版本号与 1.1.1 快照内 `packages/@openmaic/*/package.json` 声明完全一致），许可均为 MIT（`LICENSE` 头部 `Copyright (c) 2026 THU-MAIC`） |
| 结论 | **基线身份、来源、许可与安装命令可复现；M0 所需课堂代码已由已发布包提供**。上游快照自身的源码级链接/构建仍未完成（受 exFAT 限制），只影响「跑上游自带测试」，不再阻塞真实课堂接入 |

复现命令（本项目内，registry 为 `registry.npmmirror.com`，两个 registry 均有同名产物）：

```bash
pnpm --filter @sew/learning add \
  @openmaic/dsl@0.11.2 @openmaic/renderer@0.1.11 @openmaic/storage@0.35.1 \
  clsx@^2.1.1 tailwind-merge@^3.4.0 tinycolor2@^1.6.0 motion@^12.27.5 \
  lucide-react@^0.562.0 katex@^0.16.33 html-to-image@^1.11.13 html2canvas-pro@^2.0.4 \
  echarts@^6.0.0 shiki@^3.21.0
pnpm add -D -w @openmaic/dsl@0.11.2 @openmaic/storage@0.35.1   # 供根目录用例驱动真实客户端
```

`@openmaic/dsl@0.11.2` 的 `dist/integrity` 为 `sha512-5XSktj2Yl7CoSUH+UPX7ptCuaS1pKnvgLl7ekIKMatso1pknouM28biRyFTRihgTwLCypK7mSCuxsyT007kNMQ==`；精确版本已写入 `pnpm-lock.yaml`。

环境阻断说明：链接阶段速率约 1 包/数秒的旧观察成立但不是根因；exFAT 无符号链接才是硬阻断。需要上游自带测试时，把快照复制到 NTFS 再 `pnpm install --frozen-lockfile`。


## 7. 实际采用登记（2026-10-03）

### 7.1 采用的上游包

| 包 | 固定版本 | 许可 | 用途 | 采用方式 |
| --- | --- | --- | --- | --- |
| `@openmaic/dsl` | 0.11.2 | MIT（THU-MAIC） | `Stage`/`Scene`/`SceneContent`/`Action` 合同、`validateStage`/`validateScene`/`migrate`、`DSL_VERSION` | 零改动直接使用（`apps/learning` 生产依赖；根 devDep 供用例驱动） |
| `@openmaic/renderer` | 0.1.11 | MIT（包内 `LICENSE`） | `SlideCanvas`/`SlideElement` 渲染 PPTist 风格幻灯片 | 零改动直接使用；随包传递依赖 `clsx tailwind-merge tinycolor2 motion lucide-react katex html-to-image html2canvas-pro echarts shiki` 按 1.1.1 快照声明的同版本一并登记 |
| `@openmaic/storage` | 0.35.1 | MIT | `HttpDocumentStore`、`HttpAssetStore`、`HttpRuntimeStore`、`HttpAccountKV` 及错误语义 | 客户端零改动使用；服务端按同一合同实现。固定 0.35.1 贴合锁定基线；本项目复合提交和 learner 查询使用独立 API 信封，不混入上游 raw response |

M0 的 SET-01 采用固定已发布包及锁文件完整性路线，不依赖 exFAT 上游快照的源码级构建。包的下载字节由 `pnpm-lock.yaml` 中 SHA-512 校验，生产实际使用由当前构建输入、服务文件 SHA-256 清单和目录包验证共同核对；上游自带测试的 NTFS 源码构建仍属于后续验证，不以本项目测试代替。

| 固定包 | lockfile integrity |
| --- | --- |
| `@openmaic/dsl@0.11.2` | `sha512-5XSktj2Yl7CoSUH+UPX7ptCuaS1pKnvgLl7ekIKMatso1pknouM28biRyFTRihgTwLCypK7mSCuxsyT007kNMQ==` |
| `@openmaic/renderer@0.1.11` | `sha512-o7uS+/F72VPpJsLEiF1waVeYMec3E1qfeJ9ObKU7RQ7UvcXBKqA2Agp5HoL6uBCWvW7P8WS73+fPiXcBLcJzCw==` |
| `@openmaic/storage@0.35.1` | `sha512-ikNDOtcHl37ekiLSTB1V6uSH122hVTl+zkO8dQelXJ9p2ZGxFa5z6Sjx+ls7EK64H54sPa8mrKFbEjHYdYaHCQ==` |

### 7.2 本项目为承接上游合同所写的适配（非复制上游代码）

| 本项目文件 | 承担的上游语义 | 与上游的差异及原因 |
| --- | --- | --- |
| `apps/learning/app/api/maic/documents/[[...segments]]/route.ts` | `HttpDocumentStore` 的 REST 形状与错误码 | 返回合同原始载荷而非 `{ok,data}` 信封；新增 `CLASSROOM_LESSON_NOT_REVIEWED`：写入必须与仓库内登记的审核课件同指纹，上游没有「未审核内容」这一约束 |
| `packages/study-storage/src/repositories/classroom.ts` + schema v4 | 文档持久化 | 按 `(project_id, stage_id)` 分区；来源绑定放侧表，因为生成的 DSL JSON Schema 对定义关闭了 `additionalProperties` |
| `packages/study-domain/src/classroom.ts` | 文档稳定序列化/指纹、版本位置判定、去答案 | 上游 `stripQuizAnswers` 不存在：上游测验视图在前端用 `content.answer` 自行判分，与本项目「判分权威在服务」冲突，因此服务端下发前剥掉答案与解析 |
| `apps/learning/lib/classroom/reviewed-lesson.ts`、`app/api/maic/demo/route.ts` | 固定课件与明确导入命令 | 明确导入登记 `recordScope=demo` 与 `demo_author` 审核来源；正式默认查询排除演示，正式审核入口为 `/workbench/review`。演示真人作答保持 human/real，通过内容范围排除正式统计；确认导入不等于用户逐项语义审核 |
| `apps/learning/components/classroom-surface.tsx`、`openmaic-adaptation/` | 课堂加载、播放与场景宿主 | 加载结果区分不存在、不可用、失败、取消；异步结果应用前检查代次。测验通过上游 RuntimeStore 恢复草稿与完成状态，由服务判分。完整原宿主/编辑器/教师管线未复制，精确范围见下节 |
| `packages/study-storage/src/repositories/classroom-assets.ts` + schema v5、`app/api/maic/assets/**` | 资产注册、字节读取、身份探测、替换与删除 | 新分配 ID 不暴露内容摘要；HEAD 不加载 BLOB，HTTP 不缓存；平台 multipart 解析前限制实际请求字节，元数据不回显；项目代次在异步读取后复验。摘要仅用于内部完整性校验，不作为访问凭据 |
| `lib/server/classroom-demo-assets.ts`、`app/api/maic/demo-assets/[stageId]/route.ts`、`lib/classroom/demo-asset-refs.ts` | 审核演示文档的稳定资源引用 | 显式导入保存图片/字体并绑定稳定槽位；读取先检查文档来源与资产摘要，浏览器复验下载字节后才渲染。固定文档保持跨项目同一摘要，项目资产 ID 放侧表 |

### 7.3 实际课堂资产

| 资产 | 来源与许可 | SHA-256 | 使用范围 |
| --- | --- | --- | --- |
| `lib/classroom/assets/monotonicity-demo.png` | 本项目生成的函数单调性演示示意图，无外部图片 | `3d6615700b057fc08b6287f57c2561f698711b8c8bd6241cc5526bf16da89efb` | 演示幻灯片图片元素 |
| `lib/classroom/assets/KaTeX_Main-Regular.woff2` | 实际安装 `katex@0.16.47` 的同名字节，MIT；完整版权与许可保留在相邻 `KaTeX-LICENSE.txt` | `c2342cd8b869e01752a9321dc17213fc40d4d04c79688c1d43f2cf316abd7866` | 可见拉丁公式文本，不能宣称已随包提供中文字体 |

`prepare-learning-dist` 显式复制上述原始资产与许可到服务产物的 `classroom-assets/`，避免服务端嵌入字节后 Next 文件追踪遗漏许可。资源下发通过项目授权 API，不接受任意磁盘路径，也不在课堂加载时请求外部字体或图片。

随包 Node 22.22.2 的完整发行许可与版本来源分别保留在 `resources/node/runtime/LICENSE` 与 `VERSION.json`，与二进制一并分发。下载先写临时文件，完整下载成功才重命名为缓存包，避免中断留下永久被误认成有效的压缩包。

本地服务沿用全局 URL 权限策略：编码路径分隔符与多重歧义编码在路由分派前返回 `400 PATH_NOT_ALLOWED`；资产仓库按不透明 ID 参数查询，不将 ID 解释为磁盘路径。正常注册返回的随机 ID 可由上游客户端访问；不能把本地 HTTP 对所有特殊 ID 的可达性写成无条件兼容。

文档下发时重算实际内容摘要，检查来源侧表与当前知识准入；来源失效保留历史但拒绝继续下发。来源绑定 JSON 为权威列，损坏须诊断拒绝。项目身份/代次随请求提交，并在异步读取结束后、实际访问数据库前复验；不允许旧课堂客户端跨项目读取或写入。

### 7.4 验证入口

`tests/classroom-document-store.test.ts`（真实 `HttpDocumentStore` 客户端驱动本项目路由）、
`tests/classroom-attempt-readback.test.ts`（本人提交、重启读回、模拟分区、旧代次拒绝）、
`tests/classroom-domain.test.ts`（纯判断），以及 `node scripts/run-electron-boundary-smoke.cjs`
在真实 Electron 窗口里断言 `SlideCanvas` 画出审核课件元素、互动 iframe 无 preload/Node。

资产验证入口为 `tests/classroom-assets.test.ts`、`tests/classroom-demo-assets.test.ts`，生产 HTTP 边界、真实 Electron 冒烟与随包服务试验同时覆盖实际图片/字体读取。它们不替代完整上游课堂或干净 Windows 安装验收。

运行与 KV 验证入口为 `tests/classroom-runtime-http.test.ts`；加载/播放适配验证为 `tests/classroom-upstream-adaptation.test.ts`；正式/演示分区和审核入口分别见 `tests/record-scope.test.ts`、`tests/source-review-page.test.ts`。真实目录包鼠标作答和整应用重启验收入口为 `pnpm verify:classroom`，实际结果以当前构建对应报告为准，不能把脚本存在记为已验收。

文件夹组织验证为 `tests/classroom-document-organization.test.ts`；outline 完整往返与未审核修改拒绝归入 `tests/classroom-document-store.test.ts`。组织层不改变内容 scope、审核摘要、来源绑定或资产权限。

### 7.5 直接复制的课堂核心代码

`apps/learning/components/openmaic-adaptation/upstream-provenance.json` 保存每个源文件的 SHA-256、保留语义与替换范围。直接复制并适配的是 `lib/playback/engine.ts`、`lib/playback/types.ts`、`lib/playback/action-navigation.ts`、`lib/choreography/cursor.ts`、`lib/choreography/timing.ts`。完整 MIT 许可放在该目录 `LICENSE`，产物准备脚本复制到服务 `third-party/openmaic/`。

原 `ClassroomSurface.tsx:103–297` 的页面加载、重试、effect 与卸载取消分支实际复制并适配到 `useOpenMaicClassroomLoad.ts` / `classroom-host-load.ts`；显示策略复制自 `progressive-load-policy.ts:15–37`，加载 token 来自原 stage store。来源摘要与替换边界登记于 `copiedAndAdapted`。生产 `classroom-surface.tsx` 实际调用该 hook，由服务端项目/代次/来源准入替代远端所有权存储，并通过清理端口释放图片、字体与旧实例；Stage 在宿主 ready 后才挂载。

Stage、PlaybackChromeRoot、SceneRenderer 与 QuizSceneView 的视图胶水仍为独立窄适配，不描述为整体复制原组件。M0 固定课件没有教师动作；执行端明确拒绝未支持动作，TTS/媒体、Director、白板、AI 同学、编辑与生成流程尚未启用，完整功能仍按 M2 及 A—F 跟踪。多课程引用保护已在仓库约束层实现，离线回收与大媒体继续跟踪。

### 7.6 当前分发验证与已知边界（2026-10-04）

当前构建 `49ENHGnGrzqlR_fZx8HK1` 的目录包验证为 [30/30](../apps/desktop/release/pack01-verification-2026-10-03T23-46-26.290Z.json)，随包服务为 14/14；完整 `pnpm check` 为 37 个文件、226 项通过且无跳过。安装态 [50 项课堂及 M1 来源界面验证](../apps/desktop/release/m0-installed-classroom-2026-10-03T23-46-57Z-retry.json) 使用真实原生选择器和鼠标，覆盖图片/字体、测验与解题过程、互动明确提交/去重/重启读回、初始化脚本错误诊断、离线手动重试、服务崩溃、会话轮换和项目切换；还验证空正文不写样例、二次导入建立新版本、历史段落定位。

安装态首轮滑块操作因脚本未等待滚动后坐标稳定而超时，[失败报告](../apps/desktop/release/m0-installed-classroom-2026-10-03T23-47-06Z.json) 保留。改为瞬时滚动、等待两帧、验证可见 iframe 命中并拖动滑块后，同一已安装应用重新通过；复测从便携验收包运行脚本，使用安装后的随包 Node。打包工具全局缓存曾报跨卷 rename EXDEV，下载归档经字节复制和摘要复验后使用任务本地缓存构建成功。没有更改课堂功能以回避失败。

随后卸载成功，两份外部项目清单与数据库 SHA-256 均不变，见 [安装/卸载验证](../apps/desktop/release/m0-install-uninstall-2026-10-04-final.json)。安装包为 `学科备考工作台-0.1.0-setup.exe`，194,237,536 字节，SHA-256 `43A79A98669E5D90BC5A39539D0E41E00806F49C1FF8D5C569997968A489FF0A`。[外部验收包](../apps/desktop/release/m0-acceptance-kit/README.md) 已生成，输入摘要与安装包/脚本一同保存。本机证据不能替代 PACK-02；用户已确认暂无独立环境，先完成代码与本机验收。

第一次安装比目录包缺少 1,090 个文件（包含 265 个 JS/CJS/MJS），路径集中在 256—378 字符；失败报告保留，未把缺失视为成功。修复采用确定的根版本选择和最近祖先依赖解析，避免无差别深层复制；版本冲突仍在消费者局部保留。无法安全纯物化的跨版本循环明确报错，不能无限展开或默默解析到错误版本。最终服务清单含 12,024 个文件，最长相对路径 132 字符。

准备脚本据实际清单生成 NSIS 路径预算；当前完整安装目录预算为 98 字符，交互目录页另预留 builder 可能追加的目录后缀。超过预算的静默安装以 code 2 拒绝，实测 149 字符目录未解压资源。目录包支持 Node 长路径不意味着 NSIS 解压器具有相同能力；新增依赖须重新组装和计算预算，不能只换安装位置绕过完整性检查。
