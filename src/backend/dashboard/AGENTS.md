# AGENTS.md — src/backend/dashboard/（看板）

## 职责
浏览器端会话管理：拉取 `/api/conversations`，用 observer token 走 WebSocket 订阅 `*` 实时更新；卡片（点击打开详情，页面已关的点击重新打开页面；置顶（强调色按钮“已置顶”）/ 复制（最后一个回答）/ 关闭 / 回复（只展开当前卡片），四个按钮同一行；不显示标签页数量和限额提示；浏览器窗口正显示的会话卡片高亮（tabs.snapshot 广播）；标签页会话（pending）显示为“新对话 · 来源”；来源筛选显示标签页数量；标题单行）、筛选（状态｜来源；无“全部”，再点取消；默认不含页面已关；顶栏星标=收藏）、搜索、排序（置顶在前，其余按最近活动）；顶栏“已连接 · N 个页面”、一键启动（POST /api/sites/launch）；搜索图标点击展开；卡片“回复”弹出快速回复栏；有收藏的会话打开详情滚到收藏处；网站下拉（地球图标，所有网站可编辑 / 删除，无内置，末尾“添加网站”：插件后台打开网址 → 抓 DOM → 后端分析 → 弹窗看结果 → 确认添加）；详情弹窗（打开即展开快速回复 + 常见回答候选、右上角置顶图标、流式、代码渲染、跳转页面；单条消息高于弹窗 2/3 自动折叠为首尾各 1/4 弹窗高度，可展开 / 收起；每条回答 复制 / 收藏 / 重新回答 / 折叠；源站删除的会话收到 `conversation.status=deleted` 后移除）；通知等级（普通会话回答完成→音效，置顶会话回答完成→弹窗；限额 / 出错只在页面内提示）；设置（连接、通知、常见回答管理、后台状态；主题只在顶栏切换）；详情打开后滚到最后一个回复并保持在底部；页面开 / 关状态由插件 tabs.snapshot 对账保证。

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
