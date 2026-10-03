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

实际复用 OpenMAIC 时保留文件/包版权与许可，维护基线摘要和修改说明。根 MIT 不替代第三方依赖、字体、图片、头像、视频和音频的独立许可；renderer 的字体声明随实际引入资源保留。随包 Node、Electron、原生驱动和所有分发依赖也按实际版本登记，未采用资源不写成已复制。

来源材料的教材/真题版权与代码许可分别处理；导入不代表得到公开再分发教材的许可。用户私人材料不打进默认安装资源。

课堂演示实际采用 `katex@0.16.47` 的 `KaTeX_Main-Regular.woff2`（MIT，Copyright (c) 2013-2020 Khan Academy and other contributors），原始字节与完整许可保留在 `apps/learning/lib/classroom/assets/`，分发时复制到服务产物的 `classroom-assets/`。它只用于拉丁公式文本，不提供中文字体覆盖。演示 `monotonicity-demo.png` 为本项目自行生成的示意图；资产 SHA-256 和采用范围见 [上游适配记录](upstream-adaptation.md)。

下列许可文本从本地 LICENSE 完整保留。

课堂核心直接采用 OpenMAIC 1.1.1 的播放引擎、类型、动作导航、游标和时序代码；逐文件源摘要与改动范围见 `apps/learning/components/openmaic-adaptation/upstream-provenance.json`。该目录保留完整 MIT 许可，安装资源内位于服务 `third-party/openmaic/`。课堂宿主与服务存储适配为独立实现，不能列为复制了完整上游组件。

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
