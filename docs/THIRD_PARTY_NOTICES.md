# 第三方来源声明

更新：2026-10-03。本文档包明确参考合同与计划代码复用范围。实际工程采用内容在实现时另维护逐文件清单；本文不声明桌面适配已完成或安装包已验证。

## 采用范围

| 项目 | 文档与计划采用范围 | 声明 |
| --- | --- | --- |
| Good Learning | 知识清单、独立计划、错题结构和不虚构合同，按档案/课堂范围适配 | 本地 MIT，Copyright (c) 2026 yoli-mi；全文如下 |
| OpenMAIC | 学习空间主要代码复用基线；课堂、场景、教师/同学、白板、互动、测验与相关包/存储合同 | 本地根 MIT，Copyright (c) 2026 THU-MAIC；全文如下；实际复制清单在实现时更新 |
| AI-Novel-Writer | 布局、外观、项目会话与领域/来源设计参考，工作台自行实现 | 本地桌面根 GPL-3.0，独立 DSH 插件 MIT；本规划不复制源码或文档原文 |
| deepseek-harness | 工具、事件、上下文与等待语义参考，不嵌入完整运行时 | 本地 MIT；本规划不复制源码 |
| EvoFlow | 任务可视化、角色记忆隔离和人工干预设计参考 | 本地 PolyForm Noncommercial；本规划不复制源码 |

来源均为用户提供的 F:/file 本地目录。Good Learning 参考 SKILL.md、references/prepare-and-plan.md、references/daily-study.md。OpenMAIC 本地应用 package.json 为 1.1.1，其他包版本独立登记，不假定一致。具体文件与摘要见 [参考项目快照](参考项目快照.json)，课堂采用范围见 [复用规格](OpenMAIC复用与学习空间.md)。

参考图/AI-Novel-Writer参考界面.png 是用户提供的截图，归档用于布局与风格比照。参考产品名称、标识和小说示例不作为新应用品牌、图标或默认内容。

## 实现和分发登记

可编辑 PowerPoint 序列化实际采用 `pptxgenjs@4.0.1`（MIT，Copyright (c) 2015-2022 Brent Ely），固定版本登记在学习服务依赖及锁文件中。完整许可保留在 [pptxgenjs-MIT.txt](licenses/pptxgenjs-MIT.txt)；服务组装脚本会复制到 `third-party/pptxgenjs/LICENSE`。本项目的课程准入、正文投影与文件读回适配为独立实现。当前未执行最终构建或分发验证。

文档提取与原生公式 XML 检查新增固定依赖：`pdfjs-dist@6.4.299`（Apache-2.0）、`fflate@0.8.3`（MIT）、`@xmldom/xmldom@0.8.15`（MIT）。完整许可分别保留在 [PDF.js](licenses/pdfjs-dist-Apache-2.0.txt)、[fflate](licenses/fflate-MIT.txt)、[xmldom](licenses/xmldom-MIT.txt)，组装脚本会复制到服务 `third-party/`。尚未执行组装或最终 build。解析器仅处理授权本机文件，不将用户材料作为默认分发资源。

原生 MP4 集成试验使用 `output/mp4-runtime-tests/` 下独立的 FFmpeg 9.0.2 essentials 测试发行版（GPLv3）及本机 Chrome，未把这些可执行文件加入依赖、全局 PATH 或桌面分发。视频能力的最终运行时分发与许可登记仍须独立验收，测试产物不能证明编码器已随包部署。

实际复用 OpenMAIC 时保留文件/包版权与许可，维护基线摘要和修改说明。根 MIT 不替代第三方依赖、字体、图片、头像、视频和音频的独立许可；renderer 的字体声明随实际引入资源保留。随包 Node、Electron、原生驱动和所有分发依赖也按实际版本登记，未采用资源不写成已复制。

来源材料的教材/真题版权与代码许可分别处理；导入不代表得到公开再分发教材的许可。用户私人材料不打进默认安装资源。

课堂演示实际采用 `katex@0.16.47` 的 `KaTeX_Main-Regular.woff2`（MIT，Copyright (c) 2013-2020 Khan Academy and other contributors），原始字节与完整许可保留在 `apps/learning/lib/classroom/assets/`，分发时复制到服务产物的 `classroom-assets/`。它只用于拉丁公式文本，不提供中文字体覆盖。演示 `monotonicity-demo.png` 为本项目自行生成的示意图；资产 SHA-256 和采用范围见 [上游适配记录](upstream-adaptation.md)。

下列许可文本从本地 LICENSE 完整保留。

课堂核心直接采用 OpenMAIC 1.1.1 的播放引擎、类型、动作导航、游标和时序代码；逐文件源摘要与改动范围见 `apps/learning/components/openmaic-adaptation/upstream-provenance.json`。该目录保留完整 MIT 许可，安装资源内位于服务 `third-party/openmaic/`。课堂宿主与服务存储适配为独立实现，不能列为复制了完整上游组件。

新增模型协议采用固定 AI SDK／AWS SDK／Smithy 依赖，均声明 Apache-2.0。逐项版本、完整许可路径与实际字节摘要见 [provider-sdk-receipts.json](licenses/provider-sdk-receipts.json)，服务组装脚本保留这些完整许可。SDK 的请求经受控传输适配；未用真实凭据验收外部服务。

PPTX 中文可编辑字体实际采用静态 `NotoSansCJKsc-Regular.otf`，来源为 notofonts/noto-cjk commit `523d033d6cb47f4a80c58a35753646f5c3608a78`。原始字体、SIL OFL 1.1 全文、NOTICE 和字节回执位于 `apps/learning/resources/fonts/noto-sans-cjk-sc/`；服务组装保留该目录，PPTX 也包含字体许可。仅提供已验证的常规字重，缺失字形／粗体／斜体按实际资源缺口报告。

Pro 内置技能采用固定 OpenMAIC v1.1.1（commit `33553362be22a8a5efe56c62f2c0472694705280`）的 24 个技能目录及其参考／约束文件。复制范围、逐文件 SHA-256 和 MIT 许可保留在 `apps/learning/resources/pro-skills/`；只作为有界提示上下文使用，不执行技能脚本。服务组装保留目录；最终分发尚未核验。

## Good Learning — MIT License

```text
MIT License

Copyright (c) 2026 yoli-mi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OpenMAIC — MIT License

```text
MIT License

Copyright (c) 2026 THU-MAIC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
