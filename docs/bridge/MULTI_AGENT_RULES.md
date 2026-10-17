# 多线程（多 Agent 并行）开发通则

## 1. 先分工，再动手
- 一个任务开始前，由“协调者”写一张任务卡：目标、负责模块、会改的文件清单、会改的契约（协议 / HTTP / 内部消息 / DOM 配置）、验收用例。
- **一个文件同一时间只归一个 Agent。** 文件清单有交集的任务不能并行，要么串行，要么先拆文件。
- 按下面的泳道分配，泳道之间只通过契约沟通：

| 泳道 | 拥有的文件 | 典型任务 |
|---|---|---|
| A 协议 | `shared/*` | 新事件类型、新字段、新指令 |
| B 后端 | `src/backend/src/*`、`src/backend/bin/*` | 新 API、持久化、广播策略 |
| C 看板 | `src/backend/dashboard/*` | 界面、交互、通知 |
| D 插件后台 | `src/frontend/background.js`、`src/frontend/lib/{connection,background-core,dom-config-client}.js` | 队列、重连、指令路由 |
| E 站点适配 | `src/frontend/content.js`、`src/frontend/lib/{dom-observer,page-actions}.js`（拆分后为 `lib/sites/<site>.js`） | 新站点、站点改版修复 |
| F 插件界面 | `src/frontend/popup.*`、`src/frontend/manifest.json` | 设置、诊断、权限 |
| G 测试与工具 | `tests/helpers.js`、`scripts/*`、`docs/*` | 测试基础设施、打包、报告 |

各泳道自己的测试文件归各泳道（例如站点适配拥有 `tests/sites-*.test.js`）。

## 2. 契约优先
- 跨泳道的变化顺序：**A 协议先合并 → 其他泳道基于新协议并行实现**。协议 PR 里只改协议和协议测试。
- 契约变更要向后兼容：新增字段可选、新增事件类型对旧接收方无害；不兼容才升 `PROTOCOL_VERSION`。
- 契约清单（改任何一项都要在 PR 标题加 `[contract]`）：
  1. `contracts/protocol.js` 的类型、Schema、错误码、scope、指令
  2. 后端 HTTP 接口（路径、参数、返回）
  3. 插件内部消息 `kind`（page_event / capture_dom / bridge_command / bridge_diag / analyze_dom…）
  4. DomConfig v1 结构与 `SITE_PROFILES` 字段
  5. `chrome.storage` 键名（`domConfigs`、设置、队列）
  6. 会话实体字段（`GET /api/conversations`）

## 3. 热点文件，先拆再并行
以下文件是冲突高发区，并行前优先拆分（拆分本身单独一个 PR，不夹带功能）：
- `src/frontend/lib/dom-observer.js`（约 870 行）：拆为核心观察器 + `lib/sites/{chatgpt,duckai,hark}.js` 站点 profile，经典脚本挂到全局 `ChatGPTBridgeSites`，`manifest.json` 按顺序加载。
- `src/backend/dashboard/app.js`（约 670 行）：拆为 `store.js`（状态）、`ws.js`（连接）、`render.js`（卡片/详情）、`settings.js`（设置/通知）。
- `src/backend/src/server.js`（约 550 行）：拆为 `ws-handler.js`、`http-routes.js`、`commands.js`。
- `tests/sites.test.js`：每个站点一个测试文件。

## 4. 分支与合并
- 分支名：`<泳道>/<简述>`，如 `e/duckai-live-fix`、`a/add-message-deleted`。
- 小步提交，一个 PR 只做一件事；超过约 400 行改动先拆。
- 合并顺序：协议 → 后端 → 插件后台 → 站点适配 → 看板 / 弹窗。后合并的一方负责解决冲突。
- 合并前必须 rebase 到最新主干并重新跑 `pnpm test`。
- `src/frontend/shared/`、`contracts/protocol.schema.json` 是生成物：冲突时不手动解决，直接重跑 `pnpm test`（会重新生成）。

## 5. 每个 PR 的完成标准
- [ ] `pnpm test` 全绿，新增行为有测试
- [ ] 只改了任务卡里列出的文件；越界改动拆到别的 PR 或先和文件归属者协调
- [ ] 契约变更已标 `[contract]`，写明受影响泳道
- [ ] 插件改动升了 `manifest.json` 版本；新增权限写明需要用户重新授权
- [ ] README / 对应 AGENTS.md 已同步
- [ ] 界面改动附截图（浅色、深色）
- [ ] 不含真实对话、token、用户页面、`src/backend/data/`

## 6. Agent 之间怎么沟通
- 只通过三样东西：任务卡、契约文档（协议文件 + README 表格）、PR 描述。不要依赖“我记得另一个 Agent 说过”。
- 需要别的泳道配合时，开一张新任务卡给对方，写明需要的接口形状和期望行为，自己先用 mock 或测试桩开发。
- 发现别的泳道的 bug：写失败用例 + 任务卡，不直接改对方文件。

## 7. 站点适配专用流程（最常见的并行任务）
1. 用户在目标站点 Ctrl+S 保存页面（只给负责人，不入库）
2. 负责人据此写手写精简夹具 `tests/fixtures/<site>.html` 或测试内联 DOM
3. 先写失败测试（会话 ID、角色、正文过滤、生成中、模型、快速回复）
4. 写 `SITE_PROFILES[site]` / `lib/sites/<site>.js`
5. 同步 manifest、page-actions、看板 `SOURCES`、README 站点表
6. 真实站点上看 `diag(startup)` 日志确认

## 8. 质量底线
- 不放松安全边界（回环、Origin、token、脱敏）
- 不在日志、错误、`/stats` 中输出正文
- 不引入构建步骤或前端框架，除非全组同意并单独立项
- 任何“暂时绕过”的代码都要带 `TODO(<泳道>):` 和任务卡编号
