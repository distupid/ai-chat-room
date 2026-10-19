# MVP 协议冻结清单（A1 维护）

> 目标：第一版 MVP「文件上传、DOM 选择器、聊天同步」三功能联调跑通。
> 本文件冻结三功能涉及的 WS 协议字段。联调期间 A2/A3 以此为准实现。
> HTTP 接口（`/api/attachments`、`/api/sites/*`）不在 contracts/ 内，其路径与方法冻结由 A3 另行确认。

## 冻结期规则（联调期间）

1. **只许加字段，不许改现有字段**：不改字段名、类型、取值范围、必填性；不删除字段。
2. 新增字段必须可选（或同步升 `PROTOCOL_VERSION`，见 `contracts/AGENTS.md` 不变量）。
3. 任何例外先在本文件记录理由，经协调人批准后 A1 统一改 `contracts/protocol.js`。

## 功能一：文件上传（冻结字段）

| 位置 | 字段 |
|---|---|
| `command` 信封 | `action='reply'`、`text`（≤ `Limits.MAX_COMMAND_TEXT`）、`attachments: ATTACHMENT[]`（≤ `Limits.MAX_ATTACHMENTS`=10） |
| `ATTACHMENT` | `id`（必填，8–64）、`name`（必填，1–255）、`type`（≤128）、`size`（int ≥ 0）、`url`（≤300；后端转发给插件时填 `/api/attachments/:id`） |
| `command_result` | `ok`、`code`、`detail`（失败码如 `attachment_expired`、`text_required` 由后端定义，见 server.js） |
| `conversation.status` payload | `composer.attach`（插件上报输入框上传能力：`label`、`accept`、`multiple`、`icon`；看板照着画） |
| `Limits` | `MAX_ATTACHMENTS`、`MAX_ATTACHMENT_BYTES`（25MB）、`MAX_COMMAND_TEXT` |
| `Scope` | 下发 reply 需 `CONTROL`；附件下载需 `publish` 的 extension token |

说明：上传文件走 `command.reply` 通道，不经过 `event`；`message.*` 的 payload 无 attachments 字段。

**转发功能（第 6 项需求，2026-10-19 确认）：复用 `command{action:'reply'}`，零协议变更。**
看板（CONTROL 权限）发送 `command{command_id, action:'reply', conversation_id:<目标会话>, text:<原文>}`，
后端现有 `onCommand` 逻辑直接路由到目标会话的插件标签页执行，`command_result` 回执、AI 回答经正常
`message.added` 广播返回。注意（实现侧处理，无需改协议）：`text` 上限 20000（原文超长由看板截断）；
仅转文本，附件不跟随（观测到的消息 payload 不带附件 id，服务端附件会过期）；目标会话必须有打开的
插件标签页，否则 `command_result.code='no_open_tab'`。

## 功能二：DOM 选择器（冻结字段）

| 位置 | 字段 |
|---|---|
| `command` 信封 | `action='probe_site'`（仅后端→插件；`conversation_id='probe'`，`text`=目标 URL）→ 插件抓 DOM 上传分析 |
| `command_result` | 回传抓取/分析结果（`command_id` 关联后端 probes 记录） |
| `command` 信封 | `action='sync_sites'`（仅后端→插件；`conversation_id='sites'`）→ 插件同步站点配置 |
| 安全 | 后端拒绝客户端伪造 `probe_site / sync_sites / open_sites / new_chat / resync`（server.js `forbidden_action`） |

所需常量（待批，见下）：`CommandAction.PROBE_SITE`、`CommandAction.SYNC_SITES`。

## 功能三：聊天同步（冻结字段）

| 位置 | 字段 |
|---|---|
| 握手 | `hello`（`client_id`、`client_kind`、`token`）→ `welcome`（`session_id`、`scopes`、`server_time`、`policy`） |
| 上报 | `event`：`page.opened`、`page.closed`、`conversation.changed`、`message.added`、`message.updated`、`generation.started`、`generation.finished`、`conversation.status`、`tabs.snapshot`（payload 见 `EVENT_PAYLOAD_SCHEMAS`） |
| 确认/错误 | `ack`（`ref_id`、`status: persisted\|duplicate`、`seq`）、`error`（`code` 取自 `ErrorCode`） |
| 广播/订阅 | `broadcast`（`seq`、`redacted` 脱敏规则不变）、`subscribe`/`unsubscribe`/`subscribed`、`ping`/`pong` |
| 去重 | `stableEventId()` 算法冻结（改动=历史去重失效）；`event_id` 格式 `^[A-Za-z0-9:._-]+$` |
| 方向 | `Direction` 表冻结（后端靠它拒绝伪造 `broadcast`/`ack`） |
| `conversation.status` | `status` 取值 `ok / limit_reached / error / deleted` |

所需常量（待批，见下）：`ConversationStatus.DELETED`。

## 待批清单（属于三功能必需，批后 A1 改 protocol.js）

1. `CommandAction` 新增 `PROBE_SITE='probe_site'`、`SYNC_SITES='sync_sites'`（DOM 选择器必需；schema enum 已有、两端已在用，仅常量滞后）。
2. `ConversationStatus` 新增 `DELETED='deleted'`（聊天同步必需；schema enum 已有、两端已在用，仅常量滞后）。

## 延后（MVP 之后再动）

- `CommandAction` 缺 `OPEN_SITES`、`NEW_CHAT`、`RESYNC`（一键启动 / 新建会话 / 重置重同步，非三功能必需；schema enum 已有、两端已在用）。
