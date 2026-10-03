import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Match Next's automatic JSX runtime when exercising server page read behavior.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@sew/study-contracts': r('./packages/study-contracts/src/index.ts'),
      '@sew/study-domain': r('./packages/study-domain/src/index.ts'),
      '@sew/study-storage': r('./packages/study-storage/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 20_000,
    // 沙箱环境禁止派生新进程，使用 worker 线程池。
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
