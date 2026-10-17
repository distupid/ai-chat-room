# AGENTS.md — src/backend/src/（后端）

## 职责
HTTP + WebSocket 服务：hello 握手与 token 鉴权、Origin 检查、限流、Schema 校验、SQLite 持久化、ack、按会话订阅与历史回放、广播（含脱敏）、看板指令转发、DOM 配置分析 API、静态看板文件。

## 文件
| 文件 | 内容 |
|---|---|
| `server.js` | 连接生命周期、消息分派、HTTP 路由（`/healthz` `/stats` `/api/conversations` `/api/dom-config*` `/dashboard*`）、指令路由 |
| `db.js` | `events`（event_id UNIQUE）、`messages`、`conversations`、`conversation_marks` |
| `broadcaster.js` | 客户端集合、broadcast / sendTo、慢消费者、失败隔离与计数 |
| `config.js` | 配置、token 与 scope、默认广播策略、环境变量 `BRIDGE_*` |
| `dom-analyzer.js` | 页面 HTML → DomConfig v1（jsdom） |
| `ratelimit.js` | 令牌桶 |
| `../bin/start.js` | 启动入口 |

## 不变量
- 顺序：校验 → 同一事务写库 → ack(persisted, seq) → 广播。重复 event_id 只回 ack(duplicate)，不广播。
- seq 分配顺序 = 广播顺序。
- 单客户端发送失败不影响其他客户端（每个 send 独立 try/catch）。
- 默认只绑定 127.0.0.1；拒绝 `http(s)://` Origin 的升级与 API 请求。
- 无 `read_content` scope 的客户端只收到去掉 `text` 的广播（`redacted: true`）。
- 指令只发给最近一次页面事件显示正开着该会话的插件标签页；20 秒超时；回答中返回 `busy`。
- 日志和 `/stats` 不含正文。

## 数据库改动
- 目前只有 `CREATE TABLE IF NOT EXISTS`，**没有迁移机制**。加列必须写成幂等的 `ALTER TABLE ... ADD COLUMN`（先查 `PRAGMA table_info`），并在测试里用旧库文件验证。
- 派生表（messages / conversations）应能从 events 重建，不要把只存在于派生表的数据当事实来源（`conversation_marks` 除外）。

## 测试
`tests/broadcast.e2e.test.js`（多客户端、断线、回放）、`tests/dashboard.test.js`（会话 API、指令）、`tests/dom-config.test.js`。改动后至少跑相关文件：`node --test tests/e2e/broadcast.e2e.test.js`。

## 禁止
- 同步阻塞的大查询放在消息处理热路径（node:sqlite 是同步 API）
- 为看板单独开“绕过鉴权”的接口
