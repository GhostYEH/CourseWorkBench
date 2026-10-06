/**
 * 独立协作服务的进程主逻辑（ADR-0005）。
 *
 * 只监听配置的地址（默认回环）；HTTP 层做信封与认证，业务在存储/领域层。
 * 启动完成后向 stdout 输出单行 JSON ready 握手（端口、协议版本、实例标识），
 * 由父进程（Electron 主进程或链路验证脚本）读取。
 */

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CollabServiceStore } from '@sew/study-storage';
import { COLLAB_PROTOCOL_VERSION } from '@sew/study-contracts';
import { loadCollabConfig } from './config';
import { dispatch, type CollabServiceContext, type SessionToken } from './service';

/** 请求体上限：共享快照最大 4 MiB，留一倍余量，避免把巨型载荷读进内存。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export const startCollabService = (): void => {
  const config = loadCollabConfig(process.argv.slice(2), process.env, COLLAB_PROTOCOL_VERSION);
  mkdirSync(config.dataDir, { recursive: true });
  const store = CollabServiceStore.open({ file: join(config.dataDir, 'collab.db') });

  const sessions = new Map<string, SessionToken>();
  const context: CollabServiceContext = {
    store,
    protocolVersion: config.protocolVersion,
    instanceId: config.instanceId,
    dev: config.dev,
    sessions,
    now: () => Date.now(),
  };

  const emit = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              code: 'INVALID_ARGUMENT',
              message: '请求体过大',
              pending: false,
              details: { reason: 'collab_body_too_large' },
            },
          }),
        );
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      let url: URL;
      try {
        url = new URL(request.url ?? '/', `http://${config.host}`);
      } catch {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              code: 'INVALID_ARGUMENT',
              message: '请求 URL 非法',
              pending: false,
              details: { reason: 'collab_url_invalid' },
            },
          }),
        );
        return;
      }
      const rawBody = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null;
      const result = dispatch(
        context,
        request.method ?? 'GET',
        url.pathname,
        url.searchParams,
        request.headers.authorization ?? null,
        rawBody,
        typeof request.headers['x-sew-collab-protocol'] === 'string'
          ? request.headers['x-sew-collab-protocol']
          : '',
      );
      response.writeHead(result.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(result.body));
    });
    request.on('error', () => {
      /* 客户端断开：连接已结束，无需额外处理。 */
    });
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
      process.exit(0);
    });
    // 兜底：若连接迟迟不关闭，强制退出。
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    emit({
      type: 'ready',
      host: config.host,
      port,
      origin: `http://${config.host}:${port}`,
      protocolVersion: config.protocolVersion,
      instanceId: config.instanceId,
      dev: config.dev,
      dataDir: config.dataDir,
    });
  });
};

startCollabService();
