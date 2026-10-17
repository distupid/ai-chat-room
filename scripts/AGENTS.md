# AGENTS.md — scripts/（构建与工具脚本）

| 脚本 | 用途 |
|---|---|
| `export-schema.js` | 从 `contracts/protocol.js` 导出 `contracts/protocol.schema.json` |
| `sync-shared.js` | 复制 `contracts/` → `src/frontend/shared/` |
| `observer-client.js` | 命令行观察者：`pnpm observer -- --token <t> [--conv id] [--since 0]` |

## 规则
- 脚本必须幂等、可重复运行，只依赖 Node 内置模块和 package.json 已有依赖。
- `pnpm test` 会先跑前两个脚本；改它们等于改所有人的构建，需要通知全组。
- 新增打包脚本（如生成 zip）必须排除 `node_modules/`、`src/backend/data/`、数据库和任何用户上传的页面文件。
