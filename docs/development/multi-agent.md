# 多 Agent 并行工作约定

多个 agent 同时在本仓库工作时，遵守以下约定，避免互相覆盖。

## 隔离

- 每个 agent 独立分支：`d/<任务>`（开发）、`b/<任务>`（修复），或用 `git worktree` 独立工作目录。
- 一个文件同一时间只归一个 agent（按 AGENTS.md 的目录职责划分泳道）。

## 契约先行

- 跨模块接口先冻结契约（contracts/ 或接口文档），再并行实现；契约未过审不许开工。

## 合并顺序

- 契约 → 后端 → 前端 → 测试 → 文档；每步 rebase 到最新主分支并重跑测试。
- 审查只提意见不直接改别人的代码；最终合并由人拍板。

## 升级路径

- agent 之间僵持不下时升级给协调者裁决，超时未决则冻结并上报人类。


## 前后端两端同时开发（本仓库的默认并行方式）

| 泳道 | 拥有的目录 | 测试 | 分支前缀 |
|---|---|---|---|
| 契约 | `contracts/` | `tests/unit/protocol.test.js` | `a/` |
| 前端（插件） | `src/frontend/`（不含生成物 `shared/`） | `tests/integration/{observer,sites}.test.js` | `fe/` |
| 后端（监听会话 + 看板） | `src/backend/` | `tests/integration/{dom-config,dashboard}.test.js`、`tests/e2e/` | `be/` |
| 测试与工具 | `tests/helpers.js`、`scripts/`、`.github/`、`docs/` | — | `g/` |

- 两端只通过 `contracts/protocol.js`（WebSocket 消息）和 `docs/bridge/README.md` 里的 HTTP 接口表沟通。
- 需要新字段 / 新接口：先开 `a/` 契约 PR 合并，两端再基于它并行实现；对方未就绪时用测试桩或 mock。
- 前端 Agent 跑 `pnpm test:frontend`，后端 Agent 跑 `pnpm test:backend`，合并前都跑全量 `pnpm test`。
- 集成分支：`hark`。各泳道从 `hark` 拉分支、向 `hark` 提 PR；`hark` 稳定后再由人合并到 `main`。
- 详细泳道与热点文件拆分计划见 `docs/bridge/MULTI_AGENT_RULES.md`。
