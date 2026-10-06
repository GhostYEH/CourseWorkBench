#!/usr/bin/env node
/**
 * 独立协作服务入口（ADR-0005）。
 *
 * 与本地学习服务的 `server.mjs` 同源：这是一个纯 JS 启动器，不做业务判断，
 * 业务全部在 `src/*.ts`（由 tsx 即时编译，避免 Node 直接加载 TS 的解析差异）。
 *
 * 用法：
 *   node server.mjs [--host 127.0.0.1] [--port 0] [--data-dir <目录>] [--dev]
 *
 * 默认只监听回环地址，端口 0 由系统分配；跨设备部署地址由配置提供，代码不写死远端。
 * 启动后向 stdout 输出单行 JSON ready 握手，父进程据此获知真实端口。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const emitError = (message) => {
  process.stdout.write(`${JSON.stringify({ type: 'error', message })}\n`);
};

const main = async () => {
  // tsx 在当前进程注册 ESM loader，随后即可 import .ts。
  // 若 tsx 不可用（例如安装包只带了运行时依赖），回退到 Node 原生 TS 支持。
  let registered = false;
  try {
    const api = await import('tsx/esm/api');
    api.register();
    registered = true;
  } catch {
    registered = false;
  }
  try {
    await import(pathToFileURL(join(here, 'src', 'main.ts')).href);
  } catch (error) {
    emitError(
      registered
        ? `协作服务启动失败：${error instanceof Error ? error.message : String(error)}`
        : `协作服务启动失败（未能加载 TS 运行时）：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};

main().catch((error) => {
  emitError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
