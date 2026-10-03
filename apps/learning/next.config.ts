import type { NextConfig } from 'next';

/**
 * 工作台与学习空间同属一个 Next 应用（《Electron 开发设计》第 1 节）。
 * 生产构建使用 standalone，由 Electron 随包 Node 启动。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // 允许 CI / 试验构建输出到独立目录，避免与开发期的 .next 相互清理。
  distDir: process.env.SEW_DIST_DIR || '.next',
  // 领域包以 TS 源码直接被应用消费，避免多一套构建产物。
  transpilePackages: ['@sew/study-contracts', '@sew/study-domain', '@sew/study-storage'],
  typescript: {
    tsconfigPath: 'tsconfig.json',
  },
};

export default nextConfig;
