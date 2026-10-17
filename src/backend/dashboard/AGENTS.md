# AGENTS.md — src/backend/dashboard/（看板）

## 职责
浏览器端会话管理：拉取 `/api/conversations`，用 observer token 走 WebSocket 订阅 `*` 实时更新；卡片、筛选、搜索、排序；详情弹窗（流式、代码渲染、复制最后回答）；快速回复 / 标记完成 / 重新回答 / focus；设置（连接、主题、系统通知、后台状态）。

## 文件
- `index.html`：结构 + 样式（Material Design 3 token，浅色 / 深色 / 跟随系统）
- `app.js`：全部逻辑，ES module，从 `./protocol.js`（后端映射到 `contracts/protocol.js`）导入

## 依赖的契约
- HTTP：`GET /api/conversations`、会话标记接口（见 `server.js`）
- WS：`hello`(observer) → `subscribe ['*']` → `broadcast`；发送 `command`，接收 `command_result`
- 站点能力表 `SOURCES`（如 `regenerate`）必须与 `src/frontend/lib/page-actions.js` 实际支持一致

## 约定
- 零构建、零依赖、无框架；新增文件要加进 `server.js` 的 `DASHBOARD_FILES` 白名单。
- 所有页面内容用 `textContent` 或经转义后插入，禁止把对话正文当 HTML。
- token 只存 `localStorage`，不得写进 URL。
- 文案中文；状态名与 README 的状态表一致。
- 新增站点：在 `SOURCES` 加一项（label、short、能力），不要在别处 if-else 站点名。

## 测试
`tests/dashboard.test.js`（jsdom 加载 index.html + app.js）。改 DOM id / 结构时同步改测试。
暂无真实浏览器截图测试，UI 改动需在 PR 附截图（浅色 + 深色）。

## 已知问题
- `app.js` 约 670 行单文件，下一步按 store / render / ws / settings 拆分。
