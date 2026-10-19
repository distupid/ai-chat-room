# AI-Chat-Room（浏览器桥接）

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

**消息富文本（`html`，可选）**：`message.added` / `message.updated` 的 payload 除 `text` 外可带 `html`（≤ `Limits.MAX_HTML_CHARS` = 200000 字符）：观察器从与 `text` 相同的正文节点、按相同的 `text.exclude` 生成净化后的 HTML，只输出白名单 `p br h1-h6 ul ol li blockquote pre code(class=language-*) table thead tbody tfoot tr th td strong em b i del s sup sub hr a[href http(s)/data/blob] img[src http(s)/data:image]`，span / div 只保留内容（只有行内内容的 div 变成 `<p>`），script / style / iframe / form / button / svg 等整段丢掉，不复制任何事件属性 / style / class。文件链接（`download` 属性或文件扩展名）带 `data-file="文件名"`；没有网址的文件卡片（按钮文字就是文件名，如 Hark 的文件气泡）输出 `<span data-file="文件名">`。只有 p / br 时与 text 等价，不发送；text + html 估算超过 200KB 时也不发送（整条 WebSocket 消息上限 256KB），看板退回 text。后端存进 `messages.html`（旧库自动加列），`GET /api/conversations/:id/messages` 返回；无 `read_content` 的客户端广播里 `text` 和 `html` 都去掉。

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

网站改版后选择器会失效。看板网站下拉里的“添加网站”（或“网站配置”里的完整 JSON）用同一个分析器生成配置：

1. 插件后台打开网址（已打开的标签页直接用），抓取页面 HTML（去掉 script / style / svg / img 等）
2. 上传到后端，`src/backend/src/dom-analyzer.js` 分析出统一配置（DomConfig v1）
3. 确认后写进网站列表；插件同步网站列表（`chrome.storage.local.siteList`）后，对应标签页的 dom-observer 立即 `setConfig()` 生效

（插件弹窗里原来的“分析当前页面 DOM 并应用”已删除；后端 `/api/dom-config*` 接口保留。）

分析顺序：已知结构（旧版 `data-message-author-role`、新版 `data-chatgpt-search-unit-key`）→ 通用发现（找取值以 `user`/`assistant` 结尾的属性）→ 消息 ID（各消息取值互不相同的 UUID 属性）→ 正文选择器（避开按钮文字）→ 生成状态（内置候选 + 抓取时页面上的停止按钮，外加“文本活动”检测）。

配置只包含选择器、属性名和正则字符串，没有可执行代码；观察器会校验每个字段，无效项回退到默认值。重新分析会覆盖旧配置；要清除可调用 `DELETE /api/dom-config`。

| 接口 | 说明 |
|---|---|
| `POST /api/dom-config/analyze` | body `{html, url, title}`，返回 `{ok, config, report}`；找不到消息返回 422，不覆盖已有配置 |
| `GET /api/dom-config` | 读取当前配置 |
| `DELETE /api/dom-config` | 清除配置 |

都需要带 `publish` 权限的 token（即 extension token），并拒绝普通网页 Origin。

## 网站列表（全部可配置）

没有“内置”网站：所有网站（包括默认的 ChatGPT / Duck.ai / Hark）都是后端网站列表（`src/backend/data/sites.json`）里的普通条目，在看板顶栏的网站下拉里一样可以**编辑名称 / 网址**、打开**网站配置**（启用 / 停用、其他域名、DOM 选择器、会话 ID 规则、页面操作选择器，常用项 + 完整 JSON）、**删除**。

| 默认网站 | 会话 ID | 说明 |
|---|---|---|
| chatgpt.com / chat.openai.com | URL `/c/<id>` | 快速回复、重新回答都支持 |
| duck.ai | 助手消息元素 id 中的 UUID，前缀 `duck-` | URL 不带会话 ID；新聊天在第一条回答出现后才有 ID。支持快速回复，不支持重新回答 |
| hark.com | `/chat` → `hark-main`；`/projects/<id>` → `hark-<id>` | 支持快速回复，不支持重新回答 |
| meta.ai | 未验证（待 probe 补充） | 选择器未实测；generating 选择器故意留空（防状态卡“回答中”），靠文本活动检测 + 后端超时回落 |
| muse.ai | 暂无（快照 URL 仅为 `https://muse.ai/`，待补充） | 选择器按 2026-10-19 用户提供的真实 DOM 快照确认；虚拟化列表用替身 span 取正文；生成中信号为 `button[aria-label="停止任务"]`；无发送按钮，回车发送 |

- **默认种子**：上面五个网站的配置（ChatGPT / Duck.ai / Hark 按 2026-10 的真实页面编写；Meta AI 为未验证的保守通用配置；Muse 按 2026-10-19 用户提供的真实 DOM 快照确认，见 `SITE_PROFILES` 注释）在 `src/frontend/lib/dom-observer.js` 的 `SEED_SITES`，前后端同一份（后端 `src/backend/src/site-seeds.js` 读取）。后端第一次启动时写进网站列表；旧版 `sites.json` 里没有配置的默认网站会补上种子配置和域名。之后种子只用于“恢复默认”和插件的离线兜底。
- **恢复默认**：网站配置弹窗里的“恢复默认”把该网站的 DOM 配置和域名恢复为种子（`POST /api/sites/:key/reset`）；删掉的默认网站可以从网站下拉的“恢复默认网站”加回（`POST /api/sites/defaults`，`GET /api/sites` 的 `missing_defaults` 列出缺少的）。
- **插件怎么用这份列表**：后端在列表变化时给在线插件发 `sync_sites`；插件拉 `GET /api/sites`，存进 `chrome.storage.local.siteList`，并为每个**启用**的网站动态注册内容脚本（`chrome.scripting.registerContentScripts`，匹配本域名、子域名和其他域名；manifest 不再写死内容脚本）。内容脚本按当前域名在 `siteList` 里找网站（最长域名匹配，`www.` 忽略）并用它的配置；网站停用 / 被删除时不观察。还没同步过列表（例如第一次离线启动）时，插件和内容脚本都用默认种子。
- **配置变化立即生效**：内容脚本监听 `siteList` 变化并 `setConfig()`；停用的网站立即停止观察，重新启用后开始观察（已开着但没注入过内容脚本的页面需要刷新）。

| 接口（网站） | 说明 |
|---|---|
| `GET /api/sites` | 网站列表：`key, name, url, host, hosts[], enabled, config, has_default, updated_at` + `missing_defaults`（observer 或 extension token） |
| `PATCH /api/sites/:key` | `{name?, url?, hosts?, enabled?, config?}`（control）；`config` 必须是 JSON 对象（≤ 128KB），域名不能与其他网站重复 |
| `POST /api/sites/:key/reset` | 默认网站恢复默认配置（control） |
| `POST /api/sites/defaults` | 加回删掉的默认网站（control） |
| `DELETE /api/sites/:key` | 删除（control），任何网站都能删 |

## 会话管理看板

后端启动后，浏览器打开 `http://127.0.0.1:8787/dashboard`，点右上角**设置**，填入 `src/backend/data/config.json` 里 **observer** 的 token 并连接。

- Material Design 3 界面，右上角一键切换浅色 / 深色 / 跟随系统
- 按状态筛选：置顶 / 回答中 / 出错 / 空闲 / 页面已关（页面已关的会话只在这里显示，点击会重新打开页面并跳转）；多个来源时还可以按来源筛选；顶栏星标查看收藏会话
- **点卡片**：有标签页开着这个会话就切换过去，否则新开页面
- 卡片按钮：置顶、关闭页面（插件关掉开着该会话的标签页）、回复（向下弹出快速回复栏，Enter 发送、Shift+Enter 换行，发送后自动收起；点击常见回答直接发送）
- 顶栏：已连接 · N 个页面、搜索、网站（全部可编辑 / 配置 / 停用 / 删除，无“内置”，见“网站列表”）、收藏、设置、一键启动（插件在后台打开所有启用的网站）
- **回答完成**：置顶会话（或开启“所有会话”时任何会话）回答完成直接打开详情并定位到这条回答，不再有提示小弹窗；一次生成只弹一次（会话 + 回答 ID + 生成序号去重），正在看别的会话时排队、关掉当前详情后依次打开；正在输入（4 秒内打过字）时等输入停下再弹；看板在后台时另发系统通知（含回答内容）。
- **卡片“新建”**：取代原来的“复制”，在后台新建该卡片来源网站的空白会话。
- **详情**弹窗：完整对话，实时流式更新；消息有 `html` 时按原页面格式显示（标题、列表、表格、引用、粗体等），看板用 `DOMParser` 解析成惰性文档后按白名单逐个节点重建（不复制事件属性 / style，链接只允许 http(s) / data / blob，图片只允许 http(s) / data:image），从不把正文直接写进 `innerHTML`；没有 `html` 时按 `text` 的轻量 Markdown 显示
  - 代码块：语言标签 +“复制”（复制代码文字）+“下载”（按语言取扩展名，如 `.py` / `.js`，未知为 `.txt`）
  - 图片：内联显示（最大宽度 100%），点击打开原图，“下载”按钮（跨域图片浏览器可能改为打开）
  - 文件：文件卡片显示文件名，有网址时可下载 / 打开，没有网址只显示名称
  - 长消息首尾折叠、复制回答（复制 `text`）、收藏、搜索（按 `text`）照常
  - 右上角可复制最后一条回答、跳转到页面
- **设置**：连接（token、连接 / 断开）、外观、系统通知（已到限额 / 回答完成 / 出错，可设为只在看板不在前台时通知，含测试通知）、后台状态（运行时间、在线客户端、事件和指令计数）

### 会话实体字段（`GET /api/conversations`）

| 字段 | 含义 |
|---|---|
| `conversation_id` | URL 中的会话 ID |
| `source` | 来源：页面上报的网站标识；没有时按网站列表的域名匹配（chatgpt.com / chat.openai.com → `chatgpt`），都不匹配取主域名 |
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

“已到限额 / 出错 / 已删除”由事件 `conversation.status` 上报（`deleted`：页面上没有任何消息且出现“找不到对话 / Unable to load conversation”等提示，规则在 `status.deleted_patterns`；后端随后不再列出该会话）：观察器每秒在**消息正文以外**的页面文字里匹配提示语（正文、输入框、脚本都跳过），规则在 DomConfig 的 `status.limit_patterns` / `status.error_patterns` 中可改。

### 指令通道

`看板 --command--> 后端 --command(tab_id)--> 插件后台 --> 内容脚本执行 --> command_result 原路返回`

- 需要 `control` 权限。旧的 config.json 里，能读全部会话（subscribe_all + read_content）的 observer token 会自动获得 control；不想要可给该 client 加 `"no_control": true`
- 指令：`reply` 快速回复、`regenerate` 重新回答、`focus` 切换到该标签页、`close` 关闭该会话的所有标签页（含 PWA 窗口，按 `tab_ids` + 会话 `url` 查找）（插件后台执行，不经过页面）；后端 → 插件：`probe_site` / `sync_sites` / `open_sites` / `new_chat`（看板不能直接发；`new_chat` 由卡片“新建”经 `POST /api/sites/:key/new-chat` 触发，插件在后台打开该网站的 `config.new_chat_url` 或网站网址）
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

## 页面真实状态对账（tabs.snapshot）

插件定期（连上 / 重连、标签页关闭或跳转、每 30 秒检查，内容不变时最多 5 分钟一次）上报 `tabs.snapshot`：
`{ tabs: [{ tab_id, host, conversation_id, url?, title?, active? }] }`，来自 `chrome.tabs.query({})`（包含 PWA / app / 弹出窗口），`conversation_id` 由内容脚本 `page_info` 回答。
后端持久化快照但不广播，并对该插件的标签页对账：
- 后端认为开着、快照里没有，或 host / 会话已变 → 补 `page.closed`（`reason: "reconciled"`）
- 快照里开着某会话、后端认为已关闭 / 不存在 / 在别的会话 → 补 `page.opened`
补出的事件和普通事件一样广播，看板实时更新“N 个标签页 / 页面已关”。

补充：
- 还没进入具体会话的支持网站标签页，`conversation_id` 为 `tab-<client>-<tabId>`（标签页会话），列表返回 `pending: true`；页面关掉后不再出现在列表里。
- 后端把快照精简为 `{tab_id, host, conversation_id, active}` 广播给订阅 `*` 的看板，用于高亮浏览器窗口当前显示的会话卡片。
