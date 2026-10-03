# 随包 Node 运行时

安装版必须自带 Node，用户无需另装，也避免把 Next 服务绑定 Electron 的 Node ABI。

放置位置：

```text
resources/node/runtime/node.exe     # Windows x64
resources/node/runtime/node         # macOS / Linux
resources/node/runtime/LICENSE      # 发行包的完整许可
resources/node/runtime/VERSION.json # 随安装资源保留的版本与来源
```

该目录不进仓库（见 `.gitignore`）。由脚本自动完成下载、解压与落盘，二进制
直接放在 runtime/ 根目录，压缩包保留作缓存：

```bash
node scripts/fetch-node-runtime.mjs 22.22.2
```

脚本会把版本号与来源 URL 写入 `resources/node/VERSION.json`，供来源清单登记；
二进制已存在、版本匹配且许可齐全时跳过重复下载。PACK-01 阶段需要用真实安装包验证：
没有开发 Node 的 Windows 机器能安装、启动、读写项目并导出。
