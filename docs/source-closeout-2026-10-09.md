# 2026-10-09 源码收尾与 GitHub 检查点

## 当前完善程度

85 项原规划中，**71 partial / 14 planned / 0 done**，比本日上午核验的 66/19/0 新增五项部分实现。71 项已有不同程度的软件消费者，不代表 71 项全部验收通过，也不能换算为“完成了 84%”。UID 双人共同课堂是另外的必需范围，仍需完整部署和真人双设备验收。数据库迁移到 schema47。

已有主链路包括材料和来源审核、知识与计划、冻结证据包、课程/课件候选及发布、课堂本人作答和确定性判分、PBL 私有任务、受控媒体及录音、PDF/Office 提取与二进制原件追溯、可编辑 PPTX、静音 MP4 真编码/解码/下载、provider 协议与阶段路由、Pro 私有持久会话与受限外部 token、场景计划编辑/补丁/合并、草稿恢复等。

最新新增完成反馈、互动现场快照、语言选择/方向与十二语言注册、部署访问码、步骤技能训练；默认桌面备考空间及学习入口也已调整，首次启动不用先选择磁盘目录。语言文案尚未全部翻译，访问码尚未闭合远程房间接入，不能把这些部分实现标为完整产品。

仍 planned 的 14 项：OMA-030 圆桌与中断、031 逐步白板、039 三维、041 游戏评分、042 图流互动、043 编程测试、044 教师观察指导、052 音视频材料、053 网页多搜索、054 研究核查、055 可编辑 PPTX 导入、063 声音设计/克隆、078 owner/team/匿名认领、079 宿主扩展。其余 partial 的缺口仍逐项保留，详见 [能力清单](openmaic-feature-parity.json) 和 [能力矩阵](requirement-matrix-2026-10-09.md)。

## 本次收尾修复

前一接手轮已修补丁覆盖确认、在途 token 撤销、长 nonce 截断、草稿 CAS/撤销与离开保存、选择子集预览等问题。本次主审进一步处理：

1. 草稿 CAS 冲突保留本地编辑并停止自动覆盖，不自动采纳另一窗口的修订号后重写旧内容。
2. 队列 reset 使旧在途请求的成功/失败回调失效，旧请求不恢复已丢弃内容、不改变新基线、不提示旧内容已保存。
3. 显式载入最新计划先排空旧草稿请求再清草稿，读取真正的权威计划；保存计划在服务端写入事务中清草稿，删除客户端迟到清理请求，避免删除后续新编辑。
4. 长外部 nonce 有旧版截断回执时拒绝自动再次执行，要求核对原会话，避免升级映射后重复创建或派发付费请求。
5. 课程完成度总题数、已答数和正确数按题号去重；历史作答按时间正序供领域层选择最新，保留每个知识点的独立覆盖。当前统计本版本引用题目在项目中的本人正式作答，不等于课内会话独立完成签核。
6. 访问码兑换回执重放仍检查撤销、到期、scope 和指定 codeId；历史成功回执不代表凭据继续有效。
7. 快照接口拒绝不存在或非互动场景，保持项目/本人分区。

定向回归覆盖实际 API 状态、数据库草稿清理、旧 nonce 会话不重复创建、队列延迟请求、兑换撤销与题目去重；不以按钮存在代替交互验收。两项历史稳定性异常（昵称原子替换、崩溃后测验导航）有有限重试/超时/诊断改进，但原现场原因没有充分证据定位，不能写成已确定根因。原失败报告保留在本机 output。

本次曾委派三名只读审查员，但均因平台 application network permission was revoked 失败，未提供有效结论；主智能体接手核对并修复上述确定问题，不声称独立审查已完成。

## 本次验证与范围

本次最终结果：类型（含 IPC）、lint、格式检查通过；代码质量/边界检查 12/12 通过；源码测试 **177 文件 / 1593 测试通过，0 失败、0 跳过**。测试显式启用原生 MP4，使用现有测试用 FFmpeg/FFprobe 路径；三个依赖构建的测试暂不执行：desktop-http-boundary、lesson-review-page、model-connection-http。测试池 forks，最多两个 workers，NODE_OPTIONS 内存上限 8192 MiB。Git 暂存差异空白检查通过。

可重复的源码测试命令：

```powershell
$env:NODE_OPTIONS='--max-old-space-size=8192'
$env:SEW_RUN_MP4_INTEGRATION='1'
$env:SEW_FFMPEG_PATH=(Resolve-Path -LiteralPath 'output/mp4-runtime-tests/unpacked/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe').Path
$env:SEW_FFPROBE_PATH=(Resolve-Path -LiteralPath 'output/mp4-runtime-tests/unpacked/ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe').Path
pnpm exec vitest run --pool=forks --maxWorkers=2 --minWorkers=1 --exclude tests/desktop-http-boundary.test.ts --exclude tests/lesson-review-page.test.ts --exclude tests/model-connection-http.test.ts
```

本机机器报告为 `output/github-closeout-source-tests-final.json`，日志为同名 `.log`；其余检查日志为 `output/github-closeout-{typecheck,lint,format,code}-final.log`。这些运行证据不随 GitHub 提交上传；命令中的编码器也是本机测试运行时，复验环境须先配置真实可用的运行时，不能凭默认跳过宣称编码链路已跑。

本次不运行 build、服务组装、桌面打包或安装包验证。用户授权本次源码收尾和 GitHub 推送；此前“全部软件实现完成前不 build”仍适用，尚有软件缺口。本次主审读取的 .next 缺少 build-inputs 清单，旧产物不能证明新源码；下次按冻结后源码重新构建，恢复三个构建依赖测试，再核对 fingerprint/BUILD_ID/manifest/桌面产物。

源码指纹：539 输入，SHA-256 `f287db1eda1c295bc2d62e17d73771bfbe4b9cf124ba4bdc536d39369009238b`。指纹只覆盖学习服务、协作服务、共享包和根依赖等构建输入；桌面和测试/文档通过 Git 提交记录追踪，不把该摘要说成全仓库内容摘要。

## GitHub 交付范围

此次整合已存在的授权工作区成果与主审修复，推送 main。保留源码、测试、规划、固定资源和对应许可，Noto 字体 16,437,364 字节及来源/许可回执随源码提交。output、用户项目、数据库、运行时下载、安装产物和临时资料不提交；原本机文件保留。暂存文件检查未发现数据库、私钥、运行时 exe/zip/mp4 或匹配的真实服务商/GitHub 凭据。

不是 GitHub Release 或安装包发布。最终远端提交与本地 HEAD 一致性由实际 git push 和 git ls-remote 核对；提交号见本文件所在提交。

真实模型/本地引擎、正式教材语义核验、麦克风与 OS 权限、Office/WPS 人工编辑、真人双设备、干净 Windows 安装/升级/卸载及远程部署网络矩阵继续保留待验，不能由模拟或开发机报告代签。
