# ChatGPT WS Bridge

ChatGPT 页面 → Chrome 插件（MV3）→ Node.js 本地后端（Schema 校验 / SQLite 持久化 / WebSocket 广播）的完整双向事件链路。

```text
ChatGPT 页面
    ↓ DOM 观察（MutationObserver）            src/frontend/lib/dom-observer.js + content.js
Chrome Content Script
    ↓ chrome.runtime.sendMessage({kind:'page_event'})
Background Service Worker                      extension/background.js → lib/background-core.js
    ↓ WebSocket（hello / event / subscribe / ping）  lib/connection.js
Node.js 本地后端                               src/backend/src/server.js
    ├── 验证事件 Schema                        contracts/protocol.js
    ├── 持久化到 SQLite                         src/backend/src/db.js
    └── 广播事件给已连接客户端                  src/backend/src/broadcaster.js
             ↓
      所有符合广播规则的 WebSocket 客户端（插件 / 观察者）
```

## 快速开始

```bash
pnpm install         # 需要 Node.js >= 22.13（使用内置 node:sqlite，无需编译原生模块）
pnpm test            # 导出 Schema → 同步 shared 到插件 → 运行全部单元 + 多客户端 E2E 测试
pnpm start           # 启动后端：ws://127.0.0.1:8787（首次运行生成 src/backend/data/config.json 和 token）
```

加载插件：

1. `pnpm build:ext`（把 `contracts/` 同步到 `src/frontend/shared/`，zip 内已包含同步好的副本）
2. Chrome → `chrome://extensions` → 开启开发者模式 → “加载已解压的扩展程序” → 选择 `src/frontend/`
3. 点插件图标，填入后端地址和 `src/backend/data/config.json` 里 `extension` 的 token，保存
4. 打开 https://chatgpt.com ，徽标显示 `ON` 即已连接；弹窗内可看连接状态、发送队列、接收事件、错误

第二个客户端（手动多客户端测试）：

```bash
pnpm observer -- --token <config.json 里 observer 的 token>             # 订阅全部会话
pnpm observer -- --token <token> --conv <conversation_id> --since 0     # 指定会话 + 回放历史
```

健康检查与统计（不含任何对话内容）：`http://127.0.0.1:8787/healthz`、`/stats`。

## 目录

```text
contracts/protocol.js            共享协议：类型、版本、JSON Schema、零依赖校验器、event_id 算法
contracts/protocol.schema.json   导出的标准 JSON Schema（pnpm build:schema）
src/backend/src/server.js          WS 服务：握手/鉴权、校验、持久化、ack、订阅、广播、限流、Origin 检查
src/backend/src/db.js              SQLite：events（event_id UNIQUE）、messages、conversations
src/backend/src/broadcaster.js     统一广播服务：连接集合、broadcast / sendTo、失败隔离、统计
src/backend/src/config.js          配置与默认广播策略
src/frontend/manifest.json       MV3 清单
extension/background.js       Service Worker 入口（chrome.* 适配）
src/frontend/lib/connection.js   WS 客户端：重连退避、有界队列、入站分流、去重、诊断
src/frontend/lib/background-core.js  内容脚本消息 → 事件信封，标签页/订阅管理
src/frontend/lib/dom-observer.js ChatGPT DOM 观察器
extension/popup.*             设置 + 诊断面板
scripts/observer-client.js    命令行观察者客户端
test/                         单元测试 + 多客户端 E2E 验收测试
```

## 共享事件协议（v1）

所有消息都是 JSON 文本帧，公共信封：`{ v: 1, type, id, ts }`，其余字段由 `contracts/protocol.js` 的 Schema 严格定义（`additionalProperties: false`）。两端都用同一个 `validateMessage(msg, { direction })` 校验，并且会拒绝方向不对的类型。

| type | 方向 | 说明 |
|---|---|---|
| `hello` | C→S | 必须是第一条：`client_id`、`client_kind`（extension/observer）、`token` |
| `welcome` | S→C | `session_id`、授予的 `scopes`、广播策略 `policy` |
| `event` | C→S | 业务事件：`event_id`、`event_type`、`occurred_at`、`conversation_id`、`tab_id`、`payload` |
| `ack` | S→C | `ref_id`=event_id，`status`=`persisted`/`duplicate`，`seq` |
| `error` | S→C | `ref_id`、`code`、`message`、`fatal` |
| `broadcast` | S→C | `seq`、`origin_event_id`、`origin_client_id`、事件字段、`redacted`、`replay` |
| `subscribe` / `unsubscribe` | C→S | `conversations`（会话 id 或 `*`），`since_seq` 回放历史 |
| `subscribed` | S→C | 订阅结果、回放条数 |
| `ping` / `pong` | 双向 | 应用层心跳（插件每 20s，同时保持 MV3 SW 活跃） |

业务事件类型：`page.opened`、`page.closed`、`conversation.changed`、`message.added`、`message.updated`、`generation.started`、`generation.finished`，每种都有独立的 payload Schema。

**event_id 稳定性**：`message.added` = hash(类型, 会话, message_id)；`message.updated` = hash(类型, 会话, message_id, 内容哈希)。同一内容被反复观察、页面刷新、插件重连重发，都得到同一 event_id。

错误码：`INVALID_JSON`、`SCHEMA_VIOLATION`、`UNSUPPORTED_VERSION`、`NOT_HELLO`、`UNAUTHORIZED`、`FORBIDDEN`、`RATE_LIMITED`、`MESSAGE_TOO_LARGE`、`INTERNAL`。其中 SCHEMA_VIOLATION / UNSUPPORTED_VERSION / FORBIDDEN / MESSAGE_TOO_LARGE 为不可重试，插件会从队列移除对应事件；UNAUTHORIZED 会让插件停止重连直到修改设置。

## 持久化与确认策略

1. 校验 Schema（含方向）→ 不通过返回 `error`，不入库
2. 同一事务写入 `events`（`event_id UNIQUE`）并 upsert `messages`/`conversations`
3. 写入成功后才发 `ack(persisted, seq)`，然后广播
4. `event_id` 已存在 → `ack(duplicate, 原 seq)`，**不广播**
5. 插件在收到 ack 前一直保留事件；断线期间有界缓存（默认 500 条，溢出丢最旧并计数，存于 `chrome.storage.session`，SW 被回收后可恢复），重连后按原顺序重发

## 广播规则与隐私边界

| 规则 | 默认 |
|---|---|
| 可广播的事件 | `policy.broadcast_event_types`，默认全部业务事件；ack/error 永不广播 |
| 是否回显给发送者 | `echo_to_sender: false`。开启时插件按 `origin_client_id` 识别自身回显并忽略 |
| 新客户端连接后是否推送历史 | 否。仅当订阅时带 `since_seq` 且 token 有 `history` 权限，回放最多 `history_limit`（200）条，标记 `replay: true` |
| 按会话订阅 | 支持。不订阅则收不到任何广播；`*` 需要 `subscribe_all` 权限 |
| 不同客户端能否看到相同内容 | 由 token 的 scope 决定：无 `read_content` 的客户端只收到脱敏广播（去掉 `text`，保留 `text_length`，`redacted: true`） |
| 插件自身订阅 | 只订阅自己当前打开标签页的会话，不能订阅 `*` |

默认安全边界：

- 只监听 `127.0.0.1`；绑定非回环地址必须显式设置 `BRIDGE_ALLOW_REMOTE=1`
- 拒绝任何 `http(s)://` 网页 Origin 的升级请求（防止任意网页连接本机端口读取对话）；`chrome-extension://` 可在配置 `allowed_extension_origins` 中限定插件 ID
- 每个连接必须先用 token 握手（常量时间比较），5s 内不 hello 断开
- 限制：单消息 256KB（入站超限 1009 断开、出站超限跳过）、每连接令牌桶限流（200 突发 / 100 每秒）、最大 32 连接、慢消费者跳过并在多次超限后断开
- 广播对每个客户端独立 try/catch，单个失败不影响其他人；失败计入 `/stats` 的 `send_failures`、`skipped_*`、`last_errors`

## 防循环 / 去重

- 后端：event_id UNIQUE；客户端发来的 `broadcast`/`ack`/`error` 类型直接 `FORBIDDEN`，不会被当成新事件
- 插件：已排队或最近已确认的 event_id 本地直接丢弃；广播按 `seq` 和 `origin_event_id` LRU 去重；自身回显忽略
- 入站消息只在 `connection.js` 内部按 type 分流，永远不会进入内容脚本 → 后台的 `page_event` 通道

## DOM 配置：从真实页面分析选择器

ChatGPT 改版后选择器会失效。插件弹窗里点 **「分析当前页面 DOM 并应用」**：

1. 内容脚本抓取当前页面 HTML（去掉 script / style / svg / img 等）
2. 后台 POST 到 `http://127.0.0.1:8787/api/dom-config/analyze`（`Authorization: Bearer <extension token>`）
3. 后端 `src/backend/src/dom-analyzer.js` 分析出统一配置（DomConfig v1），保存到 `src/backend/data/dom-config.json`
4. 插件把配置存进 `chrome.storage.local.domConfig`，所有 ChatGPT 标签页的 dom-observer 立即 `setConfig()` 生效，刷新后依然使用

分析顺序：已知结构（旧版 `data-message-author-role`、新版 `data-chatgpt-search-unit-key`）→ 通用发现（找取值以 `user`/`assistant` 结尾的属性）→ 消息 ID（各消息取值互不相同的 UUID 属性）→ 正文选择器（避开按钮文字）→ 生成状态（内置候选 + 抓取时页面上的停止按钮，外加“文本活动”检测）。

配置只包含选择器、属性名和正则字符串，没有可执行代码；观察器会校验每个字段，无效项回退到内置默认值。点 **「恢复内置默认配置」** 可清除。

| 接口 | 说明 |
|---|---|
| `POST /api/dom-config/analyze` | body `{html, url, title}`，返回 `{ok, config, report}`；找不到消息返回 422，不覆盖已有配置 |
| `GET /api/dom-config` | 读取当前配置 |
| `DELETE /api/dom-config` | 清除配置 |

都需要带 `publish` 权限的 token（即 extension token），并拒绝普通网页 Origin。

## 支持的站点

| 站点 | 会话 ID | 说明 |
|---|---|---|
| chatgpt.com / chat.openai.com | URL `/c/<id>` | 快速回复、重新回答都支持 |
| duck.ai | 助手消息元素 id 中的 UUID，前缀 `duck-` | URL 不带会话 ID；新聊天在第一条回答出现后才有 ID。支持快速回复，不支持重新回答 |
| hark.com | `/chat` → `hark-main`；`/projects/<id>` → `hark-<id>` | 支持快速回复，不支持重新回答 |

各站点的选择器都是按 2026-10 的真实页面写的内置适配（`src/frontend/lib/dom-observer.js` 的 `SITE_PROFILES`）。页面改版后，在该站点点插件弹窗的“分析当前页面 DOM 并应用”：配置按站点分别保存（`chrome.storage.local.domConfigs[site]`），叠加在内置适配之上。duck.ai / hark.com 的分析会用内置适配在上传的页面上试跑并返回识别报告。

## 会话管理看板

后端启动后，浏览器打开 `http://127.0.0.1:8787/dashboard`，点右上角**设置**，填入 `src/backend/data/config.json` 里 **observer** 的 token 并连接。

- Material Design 3 界面，右上角一键切换浅色 / 深色 / 跟随系统
- 按状态筛选：回答中 / 已到限额 / 出错 / 空闲 / 页面已关 / 未完成 / 已完成；多个来源时还可以按来源筛选
- **点卡片**：有标签页开着这个会话就切换过去，否则新开页面
- 卡片按钮：快速回复（Ctrl+Enter 发送）、标记完成、重新回答（仅 ChatGPT）、详情
- **详情**弹窗：完整对话，实时流式更新，代码块和行内代码有格式；右上角可复制最后一条回答、跳转到页面
- **设置**：连接（token、连接 / 断开）、外观、系统通知（已到限额 / 回答完成 / 出错，可设为只在看板不在前台时通知，含测试通知）、后台状态（运行时间、在线客户端、事件和指令计数）

### 会话实体字段（`GET /api/conversations`）

| 字段 | 含义 |
|---|---|
| `conversation_id` | URL 中的会话 ID |
| `source` | 来源，chatgpt.com / chat.openai.com → `chatgpt` |
| `title` / `url` | 页面标题、地址 |
| `model` | 当前模型（页面上能找到模型切换按钮时） |
| `status` | `generating` 回答中 / `limit_reached` 已到限额 / `error` 出错 / `idle` 空闲 / `closed` 页面已关 |
| `page_status` / `status_detail` | 页面最后一次检测到的状态和提示原文（页面关闭后仍保留） |
| `open_tabs` | 当前开着这个会话的标签页数 |
| `message_count` / `user_count` / `assistant_count` | 消息数 |
| `last_message` | 最后一条消息的角色和预览 |
| `generation_count` / `last_duration_ms` | 回答次数、上次耗时 |
| `done` / `done_at` / `activity_after_done` | 标记完成 |
| `first_seen_at` / `last_seen_at` | 首次 / 最近活动时间 |

“已到限额 / 出错”由新事件 `conversation.status` 上报：观察器每秒在**消息正文以外**的页面文字里匹配提示语（正文、输入框、脚本都跳过），规则在 DomConfig 的 `status.limit_patterns` / `status.error_patterns` 中可改。

### 指令通道

`看板 --command--> 后端 --command(tab_id)--> 插件后台 --> 内容脚本执行 --> command_result 原路返回`

- 需要 `control` 权限。旧的 config.json 里，能读全部会话（subscribe_all + read_content）的 observer token 会自动获得 control；不想要可给该 client 加 `"no_control": true`
- 指令：`reply` 快速回复、`regenerate` 重新回答、`focus` 切换到该标签页（插件后台执行，不经过页面）
- 后端只把指令发给“最近一次页面事件显示正开着这个会话”的那个插件标签页；页面正在回答时返回 `busy`；20 秒没有结果返回 `timeout`
- 插件端选择器可在 DomConfig 的 `actions` 中覆盖（composer / send_button / regenerate_button / regenerate_menu_item / regenerate_menu_text）

## 测试与验收

`pnpm test` 启动真实后端（随机端口、临时 SQLite），用真实 `ws` 连接，插件端运行与 Service Worker 相同的 `background-core.js` + `connection.js`，内容脚本在 jsdom 中对真实 DOM 变化执行。验收用例与要求一一对应（见 `docs/TEST_REPORT.txt`）：

1. 插件连接后端 WebSocket
2. 捕获 DOM 变化（新消息、流式输出、生成开始/结束）并上报
3. 校验后写入 SQLite，ack 在持久化之后
4. 第二、第三个 WebSocket 客户端收到广播，顺序一致
5. 广播内容同时通过零依赖校验器和 Ajv（标准 JSON Schema）
6. 默认不回显；开启回显后插件识别并忽略，不触发重发
7. 页面刷新重复观察、重放旧事件、把广播反弹回服务端，都不会重复广播
8. 一个客户端被强制断开，其他客户端照常接收
9. 后端停机期间事件排队，重启后插件自动重连补发，新客户端通过 since_seq 回放
10. ack / error / broadcast 不会被误识别为页面事件

另含：脱敏广播、权限拒绝、网页 Origin 拒绝、错误 token、超大消息、非 hello 首包等用例。

### 已知限制

- ChatGPT 页面 DOM 会改版。选择器集中在 `dom-observer.js` 的 `SELECTORS`（当前：`[data-message-author-role][data-message-id]`、`[data-testid="stop-button"]`、`.result-streaming`），改版后只需改这里。
- 自动化测试中的页面是 jsdom 模拟的 ChatGPT 结构，不是登录后的 chatgpt.com 真实页面；在真实浏览器里加载插件后，可用 `pnpm observer` 观察实际广播进行人工确认。
