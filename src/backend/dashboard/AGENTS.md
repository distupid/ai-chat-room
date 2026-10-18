# AGENTS.md — src/backend/dashboard/（看板）

## 职责
浏览器端会话管理：拉取 `/api/conversations`，用 observer token 走 WebSocket 订阅 `*` 实时更新；卡片（点击打开详情，页面已关的点击重新打开页面；置顶（强调色按钮“已置顶”）/ 复制（最后一个回答）/ 关闭 / 回复（只展开当前卡片），四个按钮同一行；不显示标签页数量和限额提示；浏览器窗口正显示的会话卡片高亮（tabs.snapshot 广播）；标签页会话（pending）显示为“新对话 · 来源”；来源筛选显示标签页数量；标题单行）、筛选（状态｜来源；无“全部”，再点取消；默认不含页面已关；顶栏星标=收藏）、搜索、排序（置顶在前，其余按最近活动）；顶栏“已连接 · N 个页面”、一键启动（POST /api/sites/launch）；搜索图标点击展开；卡片“回复”弹出快速回复栏；有收藏的会话打开详情滚到收藏处；网站下拉（地球图标，所有网站可编辑 / 配置（启用、域名、DOM 选择器、会话 ID 规则，常用项 + 完整 JSON，恢复默认）/ 删除，无内置，删掉默认网站后出现“恢复默认网站”，末尾“添加网站”：插件后台打开网址 → 抓 DOM → 后端分析 → 弹窗看结果 → 确认添加）；详情弹窗（打开即展开快速回复 + 常见回答候选、右上角置顶图标、流式、代码渲染、跳转页面；单条消息高于弹窗 2/3 自动折叠为首尾各 1/4 弹窗高度，可展开 / 收起；每条回答 复制 / 收藏 / 重新回答 / 折叠；源站删除的会话收到 `conversation.status=deleted` 后移除）；通知等级（普通会话回答完成→音效，置顶会话回答完成→弹窗；限额 / 出错只在页面内提示）；设置（连接、通知、常见回答管理、后台状态；主题只在顶栏切换）；详情打开后滚到最后一个回复并保持在底部；页面开 / 关状态由插件 tabs.snapshot 对账保证。

## 文件
- `index.html`：结构 + 样式（Material Design 3 token，浅色 / 深色 / 跟随系统）
- `app.js`：全部逻辑，ES module，从 `./protocol.js`（后端映射到 `contracts/protocol.js`）导入

## 依赖的契约
- HTTP：`GET/POST /api/sites`、`PATCH /api/sites/:key {name?, url?, hosts?, enabled?, config?}`、`POST /api/sites/:key/reset`、`POST /api/sites/defaults`、`POST /api/sites/probe`、`GET /api/sites/probe/:id`、`DELETE /api/sites/:key`、`GET /api/conversations`、`POST /api/conversations/:id/mark {archived?, pinned?}`、`POST /api/conversations/:id/messages/:mid/favorite {favorite}`、`GET /api/favorites`
- 指令 `regenerate` 可带 `answer_index` / `answer_total`（指定第几条回答，页面对不上时返回 `regenerate_target_not_found`）
- 常见回答、通知设置只存 `localStorage`（`bridgeDashboard.quickReplies` / `bridgeDashboard.notify`）
- WS：`hello`(observer) → `subscribe ['*']` → `broadcast`；发送 `command`，接收 `command_result`
- 站点表 `SOURCES` 由 `GET /api/sites` 生成（名称、`regenerate` = 配置里 `actions.regenerate_button` 非空，与 `page-actions.js` 的判断一致），没有写死的站点

## 约定
- 零构建、零依赖、无框架；新增文件要加进 `server.js` 的 `DASHBOARD_FILES` 白名单。
- 所有页面内容用 `textContent` 或经转义后插入，禁止把对话正文写进 `innerHTML`。消息的 `html` 只能经 `renderRich()`：`DOMParser` 解析成惰性文档 → 按 `RICH_TAGS` 白名单逐个节点用 `createElement` 重建（不复制事件属性 / style，链接 / 图片网址校验协议）。
- 详情里代码块 / 图片的按钮用 `data-act` + `#detailMsgs` 上的事件委托（长消息折叠的尾部是 `cloneNode` 复制的，不带监听器）。
- token 只存 `localStorage`，不得写进 URL。
- 文案中文；状态名与 README 的状态表一致。
- 新增 / 修改站点：只改后端网站列表（看板“添加网站”“网站配置”），不要在看板里 if-else 站点名（头像配色 `COLORED_SOURCES` 例外，只影响颜色）。

## 测试
`tests/dashboard.test.js`（jsdom 加载 index.html + app.js）。改 DOM id / 结构时同步改测试。
暂无真实浏览器截图测试，UI 改动需在 PR 附截图（浅色 + 深色）。

## 已知问题
- `app.js` 约 900 行单文件，下一步按 store / render / ws / settings 拆分。
