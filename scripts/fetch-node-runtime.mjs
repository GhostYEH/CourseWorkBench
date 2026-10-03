#!/usr/bin/env node
/**
 * 下载并落盘随包 Node 运行时（PACK-01 使用）。
 *
 * 用法：node scripts/fetch-node-runtime.mjs [版本，默认 22.22.2]
 *
 * 职责：
 * 1. 从 npmmirror 镜像下载对应平台的 Node 压缩包（已存在则跳过下载）。
 * 2. 解压到临时暂存目录，把二进制整理到 runtime/ 根目录：
 *      resources/node/runtime/node.exe   （Windows x64）
 *      resources/node/runtime/node       （macOS / Linux）
 * 3. 清理暂存目录，保留压缩包作为下次缓存。
 * 4. 版本与来源 URL 写入 VERSION.json 供来源清单登记。
 *
 * 幂等：runtime 内二进制版本匹配且完整许可存在时直接跳过。
 */

import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const version = process.argv[2] || '22.22.2';
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`无效 Node 版本：${JSON.stringify(version)}；格式必须为 major.minor.patch`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeDir = join(root, 'resources', 'node');
const targetDir = join(nodeDir, 'runtime');
const platform = process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const binaryName = platform === 'win32' ? 'node.exe' : 'node';
const targetBinary = join(targetDir, binaryName);
const targetLicense = join(targetDir, 'LICENSE');
// Node 官方压缩包命名：Windows 为 win-x64/win-x86，其余平台为 platform-arch。
const distLabel = platform === 'win32'
  ? (arch === 'arm64' ? 'win-arm64' : arch === 'x86' ? 'win-x86' : 'win-x64')
  : `${platform}-${arch}`;
const ext = platform === 'win32' ? 'zip' : 'tar.gz';
const url = `https://npmmirror.com/mirrors/node/v${version}/node-v${version}-${distLabel}.${ext}`;
const archive = join(nodeDir, `node-v${version}-${distLabel}.${ext}`);
const stagingDir = join(nodeDir, `node-v${version}-${distLabel}`);

const assertSafeStagingPath = () => {
  const resolvedNodeDir = resolve(nodeDir);
  const resolvedStagingDir = resolve(stagingDir);
  const relativeStagingPath = relative(resolvedNodeDir, resolvedStagingDir);
  if (
    relativeStagingPath === '' ||
    isAbsolute(relativeStagingPath) ||
    relativeStagingPath === '..' ||
    relativeStagingPath.startsWith(`..${sep}`)
  ) {
    throw new Error(`拒绝递归操作暂存目录（路径越界）：${resolvedStagingDir}`);
  }
};

const removeStagingDir = () => {
  assertSafeStagingPath();
  rmSync(stagingDir, { recursive: true, force: true });
};

const versionOf = (binaryPath) => execFileSync(binaryPath, ['--version'], { encoding: 'utf8' }).trim();

if (existsSync(targetBinary)) {
  const current = versionOf(targetBinary);
  if (current === `v${version}` && existsSync(targetLicense)) {
    console.log(`随包 Node 已就绪：${targetBinary}（${current}），跳过`);
    writeVersionManifest();
    process.exit(0);
  }
  console.log(current === `v${version}`
    ? '随包 Node 缺少发行许可，重新整理缓存发行包'
    : `随包 Node 版本不符（${current}，期望 v${version}），重新获取`);
} else {
  mkdirSync(targetDir, { recursive: true });
}

if (!existsSync(archive)) {
  console.log(`下载 ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const partialArchive = `${archive}.download-${process.pid}`;
  try {
    await pipeline(response.body, createWriteStream(partialArchive, { flags: 'wx' }));
    renameSync(partialArchive, archive);
  } catch (error) {
    rmSync(partialArchive, { force: true });
    throw error;
  }
} else {
  console.log(`使用已有压缩包 ${archive}`);
}

console.log('解压到暂存目录…');
const stagingBinary = join(stagingDir, `node-v${version}-${distLabel}`,
  platform === 'win32' ? binaryName : join('bin', binaryName));
const stagingLicense = join(stagingDir, `node-v${version}-${distLabel}`, 'LICENSE');
if (existsSync(stagingBinary) && existsSync(stagingLicense)) {
  console.log('暂存目录已存在解压结果，跳过解压');
} else {
  // Only discard an incomplete extraction; preserve a valid staged binary for
  // retry after a previous run was interrupted between extraction and rename.
  removeStagingDir();
  mkdirSync(stagingDir, { recursive: true });
  if (platform === 'win32') {
    try {
      // Windows includes tar.exe, which handles ZIP paths directly without
      // embedding user-controlled paths in a PowerShell command string.
      execFileSync('tar.exe', ['-xf', archive, '-C', stagingDir]);
    } catch (tarError) {
      // Keep a built-in PowerShell fallback for Windows installations where
      // tar.exe is missing or cannot read the archive.
      removeStagingDir();
      mkdirSync(stagingDir, { recursive: true });
      const quotePowerShellLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
      try {
        execFileSync('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force -LiteralPath ${quotePowerShellLiteral(archive)} -DestinationPath ${quotePowerShellLiteral(stagingDir)}`,
        ]);
      } catch (powerShellError) {
        throw new AggregateError(
          [tarError, powerShellError],
          'Windows ZIP 解压失败：tar.exe 与 PowerShell Expand-Archive 均未成功',
        );
      }
    }
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', stagingDir]);
  }
}

// 二进制在包内一层目录的根（Windows）或 bin/（其他平台）。
const extractedBinary = stagingBinary;
if (!existsSync(extractedBinary) || !existsSync(stagingLicense)) {
  removeStagingDir();
  throw new Error('解压结果缺少 Node 二进制或完整 LICENSE，压缩包可能已损坏');
}
copyFileSync(stagingLicense, targetLicense);
renameSync(extractedBinary, targetBinary);
removeStagingDir();

writeVersionManifest();
console.log(`随包 Node 就绪：${targetBinary}（${versionOf(targetBinary)}）`);

function writeVersionManifest() {
  const manifest = `${JSON.stringify({ version, platform, arch, url, license: 'LICENSE', fetchedAt: new Date().toISOString() }, null, 2)}\n`;
  writeFileSync(join(nodeDir, 'VERSION.json'), manifest, 'utf8');
  writeFileSync(join(targetDir, 'VERSION.json'), manifest, 'utf8');
}
