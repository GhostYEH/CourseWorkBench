#!/usr/bin/env node
// Offline administrator entry. Never expose this capability through the HTTP service.
import { register } from 'tsx/esm/api';

register();
try {
  await import('./src/provision.ts');
} catch {
  process.stderr.write('激活令牌签发失败，请核对 UID、数据目录和登记状态。\n');
  process.exitCode = 1;
}
