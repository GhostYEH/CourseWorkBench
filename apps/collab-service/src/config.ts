/**
 * 独立协作服务的进程配置（ADR-0005）。
 *
 * 默认只监听回环地址；跨设备部署地址由配置提供，代码不写死远端。
 * 数据目录与用户项目数据分离：卸载本地应用不删除协作服务数据。
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export interface CollabServiceConfig {
  host: string;
  port: number;
  dataDir: string;
  dev: boolean;
  protocolVersion: number;
  instanceId: string;
}

/** 解析 `--key value` / `--flag` 形式的命令行参数。 */
export const parseArgs = (argv: readonly string[]): Record<string, string | true> => {
  const args: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
};

export const loadCollabConfig = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  protocolVersion: number,
): CollabServiceConfig => {
  const args = parseArgs(argv);
  const host =
    typeof args['host'] === 'string' ? args['host'] : (env['SEW_COLLAB_HOST'] ?? '127.0.0.1');
  // 生产/默认用 0：由系统分配可用端口，不预占后释放。开发可显式指定便于调试。
  const portValue =
    typeof args['port'] === 'string' ? Number(args['port']) : Number(env['SEW_COLLAB_PORT'] ?? 0);
  if (!Number.isSafeInteger(portValue) || portValue < 0 || portValue > 65535) {
    throw new Error('协作服务端口非法，应为 0-65535 的整数');
  }
  const dataDir =
    typeof args['data-dir'] === 'string'
      ? args['data-dir']
      : (env['SEW_COLLAB_DATA_DIR'] ?? resolve(process.cwd(), '.collab-data'));
  return {
    host,
    port: portValue,
    dataDir: resolve(dataDir),
    dev: Boolean(args['dev']) || env['SEW_COLLAB_DEV'] === '1',
    protocolVersion,
    instanceId: randomBytes(8).toString('hex'),
  };
};
