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

用户指定网关的模型连接已独立接通：`model-connection.ts` 负责 HTTPS Chat Completions 诊断，`settings.cjs` 以 Electron safeStorage 保存用户级凭据，主进程恢复后经控制接口传入服务内存。实际桌面报告见 [模型连接验证](../apps/desktop/release/model-connection-live-2026-10-04.json)：请求 `muse-spark-1.3`，网关返回 `muse-spark-1.3-contributor`，有效回复、主框架无密钥回显、控制接口鉴权、整应用重启恢复与不自动重试均成立。凭据不进入安装包或项目备份；这是连接诊断实现，尚非上游 provider 全功能或教师/生成验收。

32/256 token 的诊断曾返回空最终文本，实测模型先消耗 511 个推理 token；调整固定上限至 1024 后取得有效回复，[失败记录](../apps/desktop/release/model-connection-live-2026-10-04-token-cap-failed.json) 保留。独立代码审查发现服务 shutdown gate 会拒绝自身取消请求，已改成专用父进程取消路由，并用真实生产 HTTP 退出回归验证取消被受理。加密写入的 Windows EXDEV 回退只写密文；初次配置程序改为正常退出以完成系统加密状态落盘，之后跨进程解密与实际应用重启已验证。

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

模型连接补强后的当前构建为 `nmbMeLOKKj__yqRm22QyP`：完整检查 45 个文件/288 项通过，无跳过；随包服务 14/14，当前 [目录包 30/30](../apps/desktop/release/pack01-verification-2026-10-04T02-59-59.536Z.json)，服务清单 12,131 个文件逐字节匹配当前源码。实际模型调用及整应用重启 [9/9](../apps/desktop/release/model-connection-live-2026-10-04.json) 通过。新版安装包 194,162,258 字节，SHA-256 `D12756102244CC5F54FBDD0C3162B00C4B6DBE0DC2D005A04CB98FB239014C66`，外部验收包已同步。本轮没有重新执行安装/卸载或独立环境验收；下文的 50 项安装态证据与摘要属于此前 M0 基线版本，不作为新版安装态证据。

此前 M0 基线构建 `49ENHGnGrzqlR_fZx8HK1` 的目录包验证为 [30/30](../apps/desktop/release/pack01-verification-2026-10-03T23-46-26.290Z.json)，随包服务为 14/14；完整 `pnpm check` 为 37 个文件、226 项通过且无跳过。安装态 [50 项课堂及 M1 来源界面验证](../apps/desktop/release/m0-installed-classroom-2026-10-03T23-46-57Z-retry.json) 使用真实原生选择器和鼠标，覆盖图片/字体、测验与解题过程、互动明确提交/去重/重启读回、初始化脚本错误诊断、离线手动重试、服务崩溃、会话轮换和项目切换；还验证空正文不写样例、二次导入建立新版本、历史段落定位。

安装态首轮滑块操作因脚本未等待滚动后坐标稳定而超时，[失败报告](../apps/desktop/release/m0-installed-classroom-2026-10-03T23-47-06Z.json) 保留。改为瞬时滚动、等待两帧、验证可见 iframe 命中并拖动滑块后，同一已安装应用重新通过；复测从便携验收包运行脚本，使用安装后的随包 Node。打包工具全局缓存曾报跨卷 rename EXDEV，下载归档经字节复制和摘要复验后使用任务本地缓存构建成功。没有更改课堂功能以回避失败。

随后卸载成功，两份外部项目清单与数据库 SHA-256 均不变，见 [安装/卸载验证](../apps/desktop/release/m0-install-uninstall-2026-10-04-final.json)。安装包为 `学科备考工作台-0.1.0-setup.exe`，194,237,536 字节，SHA-256 `43A79A98669E5D90BC5A39539D0E41E00806F49C1FF8D5C569997968A489FF0A`。[外部验收包](../apps/desktop/release/m0-acceptance-kit/README.md) 已生成，输入摘要与安装包/脚本一同保存。本机证据不能替代 PACK-02；用户已确认暂无独立环境，先完成代码与本机验收。

第一次安装比目录包缺少 1,090 个文件（包含 265 个 JS/CJS/MJS），路径集中在 256—378 字符；失败报告保留，未把缺失视为成功。修复采用确定的根版本选择和最近祖先依赖解析，避免无差别深层复制；版本冲突仍在消费者局部保留。无法安全纯物化的跨版本循环明确报错，不能无限展开或默默解析到错误版本。最终服务清单含 12,024 个文件，最长相对路径 132 字符。

准备脚本据实际清单生成 NSIS 路径预算；当前完整安装目录预算为 98 字符，交互目录页另预留 builder 可能追加的目录后缀。超过预算的静默安装以 code 2 拒绝，实测 149 字符目录未解压资源。目录包支持 Node 长路径不意味着 NSIS 解压器具有相同能力；新增依赖须重新组装和计算预算，不能只换安装位置绕过完整性检查。

### 7.7 N1 分发验证记录（2026-10-04，早于当前 M2）

N1 的构建 `lRAF-MacCtj9Lt1oUz7dc` 完成运行时响应 schema 与显式课程 DTO 补强；完整检查为 47 个文件 / 311 个用例，跳过 0。随包服务 14/14、[目录包 30/30](../apps/desktop/release/pack01-verification-2026-10-04T03-24-40.757Z.json)、[实际 Electron 课堂 50/50](../apps/desktop/release/m0-classroom-ui-2026-10-04T03-26-37.716Z.json) 通过，包含课堂互动、离线重试、崩溃恢复与材料历史读回。服务清单 12,132 个文件，最长相对路径 132 字符；对应源码为 191 个文件，摘要 `ae2bc1b56ea53b424fb9ab39c993ace7dc8878f321d929fd7d378fa8a30129dc`。

该轮生成的安装包为 194,169,810 字节，SHA-256 `166b5bcd836115b9f663b4b3de143b3842dc53dbd2e0819834f1f6741ec88f0b`，外部验收包已同步，但未重做安装/卸载及独立环境验收。此分发产物早于 M2 的课程审核与课堂会话提交，不作为当前 M2 的安装证据。

### 7.8 当前 M2 源码复核（2026-10-04）

提交基准 `abe159e` 已包含证据包、课程版本审核/发布/撤回、草案生成 guard、讲解卡与持久课堂会话。本次在该基准上修复撤回/取代后的旧会话播放、多卡重试推进、模型迟到结果写入及未派发调用错误计费，补齐原子事务与生产页面入口回归。剩余范围见[待办事项](待办事项.md)。

生产构建 `b-NbUYfAKkVxyb0mjKVqm` 成功，对应源码 202 个文件、摘要 `a9042a38fa79222b4e93e3a1fa0e3266b9a5b4046674811b3627bfda2b23afe9`；类型检查、代码质量与公共边界检查、51 个测试文件 / 368 个用例全部通过，跳过 0，包含使用当前构建的生产 HTTP 测试。GPT-6 Luna / high 独立只读复核未发现四项修复中的确凿漏修。此次未重新打包或进行新的付费整课调用；正式 OpenMAIC 课件挂接、白板、多进程执行租约、崩溃结算、完整成本/时间预算与 PACK-02 独立环境验收仍保留。

### 7.9 M2-E 正式测验适配（2026-10-04）

新增三题型仍使用已固定的 `@openmaic/dsl@0.11.2` quiz 形状和 `@openmaic/storage@0.35.1` RuntimeStore。单选和多选的正确答案由冻结证据包提供，服务端精确判分；简答只提交答案与过程，保持待判分。返回渲染器前剥除答案、解析和评分标准，客户端不能写权威判分。课程版本仅装配其选中的陈述/题目，来源侧表逐场景绑定并与确定性文档复核，文档、挂接与测验事务均保留准入约束。

`QuizSceneView` 支持单选、多选、简答以及每题独立的会话、草稿、不可变提交和重开恢复；它仍是本项目的窄视图适配，没有新增复制上游代码或变更依赖版本。schema v16 保存评分规则与作答题目/答案版本，旧证据包迁移保持字节及摘要不变。未登记规则的旧正式题待判分，固定演示仍使用原合同。

生产构建 `KijbcQ6icl-s3UuPCVoyY` 对应 208 个输入文件、SHA-256 `ff42c9bf295565930139fca1b42c4a0ea4b2b201d191d3c9b59a226ba773af74`；`pnpm check` 为 55 文件 / 424 用例通过、跳过 0。实际 Electron 冒烟新增真实表单登记、三题型提交、未完成题与已提交题独立恢复、SQLite 项目重开读回及无重复作答检查；文字输入使用表单事件、控件使用浏览器鼠标事件。隐藏窗口的 `sendInputEvent` 未派发到控件，测试驱动改用原验收脚本已使用的 `Input.dispatchMouseEvent` 后验证通过，未修改业务逻辑以回避该问题。GPT-6.1 Sol / medium 独立只读审查提出的跨题会话复用及在途切题忙碌问题已修复、复审通过。

本轮只验证本机回归材料，不签核真实科目、整课 provider 授课或 PACK-02；简答人工评分及模型评分候选、互动/PBL、白板与教师聚焦继续保留。

### M2-F 简答审核适配（2026-10-04）

本轮继续使用固定 DSL/RuntimeStore 包与本项目 QuizSceneView，没有新增复制上游代码或依赖版本变化。人工审核与模型待审候选属于本地学习域的追加记录，原始 Runtime review 及提交收据不改写；完成提交后通过明确范围的评分接口读取最新有效审核及参考依据，未提交时不下发这些内容。模型输出不是权威判分，只有人工语义审核确认才能更新有效评分和未被更晚作答覆盖的知识点。

SQLite 升至 v18：v17 保存候选/审核/命令收据，v18 保存绑定 run 的派发前命令及共享额度预留。失败、取消、过期结果不产生有效评分；同 nonce 失败/未知结果不重复调用，未结算预留持续进入课程/教师/评分共用预算。已验证 SQLite 故障下没有第二次派发；实际成本与未知外部结果结算仍属于 BUDGET-01 的剩余范围。

当前生产构建为 `O-oinHG8rYoy1vmD9FvWJ`，216 个输入文件，SHA-256 `7ce24e51f85ecd9f077216f25526d6fdeffe0ed441f0a90e031322fac86a1f9f`；`pnpm check` 为 60 文件 / 482 用例通过，无跳过。模型测试均使用假连接，未进行真实 provider 评分；真实材料语义效果、完整答案显示走查与新安装态验收继续保留。

同构建的 Electron 沙箱实测通过简答部分分/满分两版人工表单审核与数据库重开后最新评分恢复；随包服务 14/14、新目录包 30/30 均通过，12,168 个服务文件按摘要验证。新目录位于 `apps/desktop/release/m2f-2026-10-04/win-unpacked`，报告 `apps/desktop/release/m2f-2026-10-04/pack01-verification.json`；未更新 NSIS 安装包，也未以目录包运行替代独立环境签核。

M2-E 补充历史记录（早于 M2-F 及本阶段）：浏览器层暂停真实题 B 提交请求，切回题 A 并断言其草稿和可提交状态，放行原请求后确认 B 已持久判分。关闭隐藏窗口的后台节流并在滚动后等待两帧，完整 Electron 冒烟再次通过。随包服务已按该轮构建重新组装，清单 12,155 文件，最长相对路径 132 字符；`pnpm verify:service` 14/14 通过。

上述 M2-E 目录包位于 `apps/desktop/release/m2e-2026-10-04/win-unpacked/`，使用本地同版本 Electron 38.8.6 组装，未更新安装包。[实际目录包 30/30](../apps/desktop/release/m2e-2026-10-04/pack01-verification.json) 通过：包内 10 个桌面 CJS 摘要、runtime 元数据、12,155 个服务文件及该轮构建来源均匹配；从临时中文空格路径启动实际 exe，生产 SSR、沙箱 preload、认证边界、隔离 profile 与受控关闭均通过。复跑命令为 `node scripts/verify-packaged-desktop.mjs --app-dir apps/desktop/release/m2e-2026-10-04/win-unpacked`。这是历史本机目录包证据，不等于本阶段安装/卸载或独立 Windows 环境验收。

### 本阶段：本地房间、白板与正式互动（2026-10-04）

继续使用固定 `@openmaic/dsl@0.11.2`、`@openmaic/storage@0.35.1` 和现有 SlideCanvas，没有新增复制上游代码或依赖版本变化。`FormalInteractiveSceneView`、白板/房间和人工反馈面板为本地消费者实现；正式互动仍采用真实 interactive 场景形状，定义与 UID 个人观察使用专用受保护 Runtime 分区，不允许通用接口伪造。公开关系定义去掉正确目标，草稿/提交分别保存；观察不直接写知识或掌握。演示 iframe 增加随机 nonce、来源窗口/实例验证，保留 opaque origin 与仅 `allow-scripts`。

schema v19—v23 依次新增旧本人 UID 映射、个人房间/快照/教师租约和会话绑定、审核白板、不可变本人反馈/复习记录及课程/教师模型调用持久账本。ROOM 公共投影仅支持文字幻灯片与无答案测验；任意 HTML/资源标签及未实现安全投影的互动/PBL 拒绝冻结。在线身份/邀请/同步/交流仍未实现，不能把本地房间视为双人协作签核。

该阶段历史构建 `2oj_FjjcGYi2uTYty5UUh`，248 个输入文件，SHA-256 `7c6a5fe38a9fda0cd831cc928e78f3a1e7881e3eea064343a1f37f363eb7a7f8`；`pnpm check` **72 文件 / 588 用例通过，零跳过**。房间绑定、推进/结束原子同步与共享 HTML 边界有实际路由/SQLite 回归。原生 Electron 冒烟 29 组覆盖包含真实房间/白板/参数与关系互动、数据库重开和 UID 实际剪贴板；数据库重开不替代整应用崩溃或安装态功能验收。

该历史随包服务为 12,254 文件，最长相对路径 132；服务 **14/14**、[目录包 **30/30**](../apps/desktop/release/stage-handoff-2026-10-04/pack01-verification.json) 通过。目录 `apps/desktop/release/stage-handoff-2026-10-04/win-unpacked` 使用本地同版本 Electron 38.8.6，早于后续同学/预算/恢复源码；未重建 NSIS、未安装/卸载、无真实付费 provider。当前验证见[项目说明](../README.md#当前验证)，剩余范围见[待办事项](待办事项.md)。用户暂缓真实材料金标准和真人双设备验收，85 项清单仍为 22 partial / 63 planned / 0 完整签核。

### 本轮：AI 同学运行、共享预算与四层恢复（2026-10-04，接手轮）

上游采用范围不变：仍固定 `@openmaic/dsl@0.11.2`、`@openmaic/renderer@0.1.11`、`@openmaic/storage@0.35.1`，没有新增复制上游代码、没有依赖版本变化，也没有放宽既有共享投影边界。本轮改动全部落在本项目自有的合同、领域、存储与服务层：

- schema v24 新增 `classroom_peer_turns`（`partition`/`actor_type` 由 CHECK 固定为 `simulation`/`peer_ai`）与 `classroom_session_peer_settings`（同学参与度）。参与度用独立表而不是给 `classroom_sessions` 加列：SQLite 没有 `ADD COLUMN IF NOT EXISTS`，加列会让「重建旧库」路径无法重跑。
- schema v25 给 `attempt_grade_generation_calls` 追加 `accounted_tokens`/`token_measurement`/`elapsed_ms`，用于保存评分计量；旧列为空的数据仍须按兼容策略归一，不改变原始作答和收据。
- 新增 `packages/study-domain/src/peer.ts`（同学权限、参与度上限、来源约束、分区）与 `budget.ts`（共享额度、结算口径、费用口径、断线不重放），两者都是纯判断，不依赖 React/Electron/Next，也不做 IO。
- 新增 `apps/learning/lib/server/classroom-peer.ts` 与 `classroom-recovery.ts`，以及 `/api/study/recovery` 只读核对入口与课堂面板里的同学/恢复两个子面板。
- `MODEL_CALL_PURPOSE` 扩到六类用途并与 `MODEL_USAGE_PURPOSE` 同源；`modelUsageCallSchema` 追加角色归属与用量口径列。

本轮没有引入真实付费 provider 调用、重建 NSIS 或创建 Git 提交。目录包与安装态、整应用/服务崩溃及跨版本冲突矩阵仍须验收；85 项清单仍为 22 partial / 63 planned / 0 完整签核。实现与验证范围见[项目说明](../README.md#当前验证)。

### 本轮：M2 缺口（预测字段、教师聚焦、公式排版、ROOM 互动投影）（2026-10-04）

上游采用范围不变：仍固定 `@openmaic/dsl@0.11.2`、`@openmaic/renderer@0.1.11`、`@openmaic/storage@0.35.1`，没有新增复制上游代码、没有依赖版本变化，也没有放宽共享投影边界。本轮新引入的唯一第三方运行时能力是**项目已声明的 `katex` 依赖**（此前仅作为演示字体来源登记），现在用于白板公式的数学排版，渲染固定 `trust:false`。

- 新增 `packages/study-domain/src/formal-interaction.ts`：把互动定义的摘要、场景编号、定义/观察分区编号与「公开投影（去掉关系正确目标）」下沉为纯函数。此前这些只存在于 `apps/learning/lib/server/formal-interaction-definition-store.ts`，ROOM 冻结需要同一套规则；下沉后本地课堂与共享投影共用一份实现。
- `packages/study-contracts`：`formal-interaction` 增加 `predictionRequired`/`prediction`/`predictionMatched`；`classroom-board` 增加 `focus` 内容类型与公式 `latex` 字段（含 LaTeX 专用安全黑名单）；`classroom-room` 的共享场景增加 `interactive` 变体。
- `packages/study-storage`：房间冻结接受互动场景并投影公开定义；白板绑定校验改为同时接收内容，`focus` 的元素编号必须存在于该版本冻结课件。
- `apps/learning`：互动服务加入预测强制与匹配判定；白板面板加入 KaTeX 渲染、聚焦元素下拉；房间页显示互动场景类型。

本轮未调用真实付费 provider、创建 Git 提交或重建 NSIS。公式排版、独立预测与安全互动投影的验证和目录产物以[项目说明](../README.md#当前验证)为准；聚焦目前提供冻结元素绑定和审核白板说明，画布中的实际聚焦效果仍由[待办事项](待办事项.md)跟踪。85 项清单仍为 22 partial / 63 planned / 0 完整签核。
