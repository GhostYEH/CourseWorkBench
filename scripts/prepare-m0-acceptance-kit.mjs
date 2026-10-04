#!/usr/bin/env node
/** Portable installed-app verification: Windows PowerShell + bundled Node only. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './freshness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'apps/desktop/release');
const installerName = '学科备考工作台-0.1.0-setup.exe';
const installer = join(release, installerName);
if (!existsSync(installer)) throw new Error('Build the Windows installer before preparing the acceptance kit');
const output = join(release, 'm0-acceptance-kit');
mkdirSync(output, { recursive: true });
const files = [
  ['scripts/verify-installed-desktop.ps1', 'verify-installed-desktop.ps1'],
  ['scripts/verify-classroom-desktop.mjs', 'verify-classroom-desktop.mjs'],
  ['scripts/select-native-project.ps1', 'select-native-project.ps1'],
  ['scripts/freshness.mjs', 'freshness.mjs'],
  [`apps/desktop/release/${installerName}`, installerName],
];
for (const [source, destination] of files) copyFileSync(join(root, source), join(output, destination));
const build = JSON.parse(readFileSync(join(release, 'win-unpacked/resources/learning/bundle-manifest.json'), 'utf8'));
writeFileSync(join(output, 'acceptance-inputs.json'), `${JSON.stringify({
  createdAt: new Date().toISOString(), buildId: build.buildId,
  installerSha256: sha256File(installer),
  files: files.map(([, destination]) => ({ file: destination, sha256: sha256File(join(output, destination)) })),
  independentCleanWindowsPassed: false,
}, null, 2)}\n`);
writeFileSync(join(output, 'README.md'), `# M0 独立 Windows 验收包

本文件夹可以复制到另一台 Windows x64 电脑或干净 VM，不需要仓库、开发 Node、pnpm 或数据库服务。
必须在可交互的 Windows 桌面中运行；脚本会操作原生目录选择器和实际应用窗口。

先对照 acceptance-inputs.json 核对安装包摘要，确认环境没有本产品既有安装，再在此目录的 PowerShell 运行：

\`\`\`powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\verify-installed-desktop.ps1 -Installer '.\\${installerName}' -ReportDirectory '.\\reports'
\`\`\`

脚本安装一份隔离测试应用，使用安装后的随包 Node 验证课堂、真实作答、互动明确提交、重启读回、断网、服务崩溃、项目切换和退出清理，然后卸载测试应用并验证外部项目保留。
它拒绝覆盖已有同产品安装。失败时保留安装和测试项目；成功后仍保留测试项目和报告。

reports 包含环境事实、逐项课堂记录和安装/卸载记录。环境记录不会自行认定环境独立或干净。
PACK-02 签核还须人工记录设备/VM 来源、独立用户、是否安装开发 Node/数据库/仓库依赖及实际未覆盖项，再与报告和安装包摘要一起审查。

本包的生成只代表验收工具已经准备，不能作为独立 Windows 验收通过的证据。
`, 'utf8');
console.log(`M0 acceptance kit prepared: ${output}`);
