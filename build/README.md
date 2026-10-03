# 构建资源

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `icon.ico` | Windows 安装包与窗口图标 | 待补：书页 + 核对标记的自有组合，不使用参考产品标识 |

图标未就位前，`electron-builder` 使用默认图标；补齐后 `apps/desktop/electron-builder.yml`
会自动读取 `build/` 作为 `buildResources`。
