# 子项目 AI 协作规则：`src/frontend`（Chrome MV3 插件）

> 继承根目录 `AGENTS.md` 的全部规则（安全基线、变更纪律）；以下为本子项目补充。

## 范围
- 目录：`src/frontend`，即 Chrome 插件本体；`chrome://extensions` → 加载已解压的扩展程序 → 选本目录。
- 技术栈：原生 JS，MV3，无构建步骤、无框架；Service Worker 用 ES module，内容脚本是经典脚本（不能 `import`）。

## 命令
- 同步协议副本：`pnpm build`（把 `contracts/` 复制到 `src/frontend/shared/`）
- 前端相关测试：`pnpm test:frontend`；合并前跑全量 `pnpm test`

## 禁区
- 不许修改 `src/backend/`（跨子项目改动先问负责人）。
- `src/frontend/shared/` 是生成物，禁止手改；协议只改 `contracts/protocol.js`，且先提契约 PR。
- `lib/dom-observer.js` 同时被后端 `dom-analyzer.js` / `site-seeds.js` 读取（分析、默认网站种子、按域名找网站），改它的导出（`ChatGPTBridgeObserver`、`DEFAULT_CONFIG`、`SITE_PROFILES`、`SEED_SITES`、`findSite`、`siteHosts`）视为契约变更。
- 不要写死站点域名：站点由后端网站列表决定（`chrome.storage.local.siteList`，内容脚本由后台按列表动态注册），`SEED_SITES` 只是默认种子 / 离线兜底。

## 完成标准
- 相关测试全绿；插件改动升 `manifest.json` 的 `version`；新增 host 权限写明需用户重新授权。

插件分三块，**多人并行时按块分配**，不要两人同时改同一块：

| 块 | 文件 | 运行环境 |
|---|---|---|
| 后台 | `background.js`、`lib/background-core.js`、`lib/connection.js`、`lib/dom-config-client.js` | Service Worker，ES module |
| 页面 | `content.js`、`lib/dom-observer.js`、`lib/page-actions.js` | 内容脚本，经典脚本，隔离世界 |
| 界面 | `popup.html`、`popup.js`、`manifest.json` | 弹窗 |

`contracts/` 是 `pnpm build:ext` 生成的副本，禁止手改。

## 消息通道（内部）
- 页面 → 后台：只有 `chrome.runtime.sendMessage({kind:'page_event', event})` 会被上报
- 后台 → 页面：`page_info`、`get_observer_config`、`bridge_command`
- 弹窗 → 后台：`get_diagnostics`、`save_settings`
- 后端发来的 ack / error / broadcast 只在 `connection.js` 内部分流，**永远不能进入 page_event 通道**（防循环）

## 不变量
- 事件收到 ack 前一直在有界队列（默认 500，存 `chrome.storage.session`），重连按原顺序重发。
- `UNAUTHORIZED` 停止重连直到设置变更；不可重试错误从队列移除。
- 插件只订阅自己打开标签页的会话，不订阅 `*`。
- 每个站点的 DOM 配置只来自网站列表 `chrome.storage.local.siteList`（没有本地覆盖配置；旧版的 `domConfig` / `domConfigs` 在同步时清除）。
- 看板“添加网站”（运行时添加，不改代码）：后端发 `probe_site` → `background.js` 后台打开网址、`chrome.scripting.executeScript` 抓 DOM、上传 `/api/sites/probe/:id/dom`；确认后后端发 `sync_sites` → `syncSites()` 把网站列表写入 `siteList`，并用 `registerContentScripts`（id `site-<key>`）注册内容脚本；`content.js` 按 `siteList` 的域名决定站点和配置。
- 内置新增站点（写进代码）必须同时改：`manifest.json` 的 `host_permissions` 与 `content_scripts.matches`、`dom-observer.js` 的 `siteForHost` + `SITE_PROFILES`、`page-actions.js` 的站点动作、看板 `SOURCES`、README 站点表、`tests/sites.test.js`。

## 调试
- 页面 Console 会打印 `[chatgpt-bridge] observer started` 和启动 3 秒后的 `diag(startup)`。
- 直接调用 `ChatGPTBridgeObserver` 需把 Console 上下文从 `top` 切到本插件。
- 后台日志：`chrome://extensions` → Service Worker → 检查。

## 发布
改动后升 `manifest.json` 的 `version`；新增 host 权限会让 Chrome 要求用户重新授权，需在说明里写明。
