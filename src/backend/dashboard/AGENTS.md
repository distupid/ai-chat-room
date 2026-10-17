# AGENTS.md — src/backend/dashboard/（看板）

## 职责
浏览器端会话管理：拉取 `/api/conversations`，用 observer token 走 WebSocket 订阅 `*` 实时更新；卡片（点击打开详情；置顶 / 归档 / 重新回答；标题单行）、筛选（全部不含已归档；置顶、有收藏、已归档）、搜索、排序（置顶在前，其余按最近活动）；网站下拉（已适配网址，末尾“添加网站”：插件后台打开网址 → 抓 DOM → 后端分析 → 弹窗看结果 → 确认添加）；详情弹窗（流式、代码渲染、右上角快速回复 + 常见回答候选、跳转页面；每条回答 复制 / 收藏 / 重新回答 / 折叠）；通知等级（普通会话回答完成→音效，置顶会话回答完成→弹窗）；设置（连接、主题、通知、常见回答管理、后台状态）。

## 文件
- `index.html`：结构 + 样式（Material Design 3 token，浅色 / 深色 / 跟随系统）
- `app.js`：全部逻辑，ES module，从 `./protocol.js`（后端映射到 `contracts/protocol.js`）导入

## 依赖的契约
- HTTP：`GET/POST /api/sites`、`POST /api/sites/probe`、`GET /api/sites/probe/:id`、`DELETE /api/sites/:key`、`GET /api/conversations`、`POST /api/conversations/:id/mark {archived?, pinned?}`、`POST /api/conversations/:id/messages/:mid/favorite {favorite}`、`GET /api/favorites`
- 指令 `regenerate` 可带 `answer_index` / `answer_total`（指定第几条回答，页面对不上时返回 `regenerate_target_not_found`）
- 常见回答、通知设置只存 `localStorage`（`bridgeDashboard.quickReplies` / `bridgeDashboard.notify`）
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
- `app.js` 约 900 行单文件，下一步按 store / render / ws / settings 拆分。
