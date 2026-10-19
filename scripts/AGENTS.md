# AGENTS.md — scripts/（构建与工具脚本）

| 脚本 | 用途 |
|---|---|
| `export-schema.js` | 从 `contracts/protocol.js` 导出 `contracts/protocol.schema.json` |
| `sync-shared.js` | 复制 `contracts/` → `src/frontend/shared/` |
| `observer-client.js` | 命令行观察者：`pnpm observer -- --token <t> [--conv id] [--since 0]` |
| `test-map.js` | suite→测试文件映射；`test:changed` 按 git 变更选 suite 的唯一来源（新增测试文件在此登记） |
| `run-suite.js` | `node scripts/run-suite.js <unit/frontend/backend>`：build 后串行跑该 suite |
| `test-changed.js` | `pnpm test:changed`：按 git 变更自动选 suite；无变更跑 unit 冒烟；工程文件变更跑全量 |

## 规则
- 脚本必须幂等、可重复运行，只依赖 Node 内置模块和 package.json 已有依赖。
- `pnpm test` 会先跑前两个脚本；改它们等于改所有人的构建，需要通知全组。
- 新增打包脚本（如生成 zip）必须排除 `node_modules/`、`src/backend/data/`、数据库和任何用户上传的页面文件。
