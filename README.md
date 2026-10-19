# ai-chat-room

web ai chat admin：把网页 AI 对话（ChatGPT / Duck.ai / Hark / Muse）实时汇集到本地后端，在看板里统一查看、标记、快速回复、群发。

```text
网页对话 ──DOM 观察──▶ Chrome 插件（src/frontend）──WebSocket──▶ 监听后端（src/backend）──▶ 看板 / 观察者
                                      ▲                                │
                                      └──────── 看板指令（回复、跳转）──┘
```

## 快速开始

```bash
pnpm install
pnpm test        # 导出 Schema → 同步协议到插件 → 全部测试
pnpm start       # ws://127.0.0.1:8787，看板 http://127.0.0.1:8787/dashboard
```

插件：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `src/frontend/`，在弹窗里填 `pnpm start` 打印的 extension token。

看板用 `pnpm start` 打印的 observer token 登录。

## 功能

- **会话卡片**：每个 AI 会话一张卡片，按站点配色区分；状态筛选（置顶 / 回答中 / 空闲 / 页面已关）；卡片与浏览器标签页 1 对 1 绑定。
- **一键打开**：四个站点各把"已关闭"的会话重开，没有数据才新建，不多开。
- **详情与快捷回复**：点卡片看完整对话，输入框快捷回复（chip 样式，支持附件），AI 回答带复制 / 收藏 / 折叠 / 转发。
- **转发**：把一条消息转给另一个 AI 会话，拿它的回答。
- **底部群发**：看板底部输入框，一键把内容发给所有空闲会话。
- **添加网站**：看板"添加网站" → 填会话网址 → 插件抓 DOM → 后端分析 → 确认添加。探测不到选择器时自动用保守通用配置。
- **消息通知**：新消息通知（去重 + 已读标记，内容级去重防心跳误报）。

## 默认站点

| key | 站点 | 网址 |
|-----|------|------|
| `chatgpt` | ChatGPT | https://chatgpt.com/ |
| `duckai` | Duck.ai | https://duck.ai/ |
| `hark` | Hark | https://www.hark.com/chat |
| `muse` | Muse | https://muse.ai/ |

（曾支持 meta.ai / claude.ai，已分别移除、替换。）

## 站点 DOM 速查（经常调试的）

各站点的选择器配置在 `src/frontend/lib/dom-observer.js` 的 `SITE_PROFILES`。下面是调试中踩过的坑：

**muse.ai**（`muse`，Muse 网页版，hatch-* 内核）
- 消息行：`[data-message-item="true"]`，`data-message-role="assistant" / "user"` 区分角色，`data-message-id` 取 ID。类名是 Tailwind 动态生成的，**只用 `data-*` / `aria-*` 属性**。
- 列表是**虚拟化**的：可视区外的消息只有 `sr-only` 替身 span（带"用户消息：/助手消息："前缀），`text.strip` 正则去前缀。
- 输入框：`textarea[aria-label="消息"]`；**空输入时发送按钮隐藏**，填字后才出现（`button[aria-label="发送"]`）。
- 生成中：`button[aria-label="停止任务"]:not([disabled])` 出现即为生成中。
- **后台标签页不加载**：探测/发送前需短暂激活标签页，`page_info` 的 `visible` 字段可区分"空会话"与"页面没加载"。
- 会话 ID 暂无 URL 模式（`url_pattern: null`）。

**meta.ai**（已移除默认）
- 输入框是 Lexical 编辑器：`div[contenteditable="true"][data-testid="composer-input"][data-lexical-editor="true"]`（不是 textarea）。
- 发送按钮 `button[data-testid="composer-send-button"]` 空输入时 `disabled`，需先聚焦填字再等启用。

**duck.ai**（`duckai`）
- URL 里没有会话 ID，从助手消息元素 id 取：`[id*="-assistant-message-"]`，`^([0-9A-Fa-f-]{36})-assistant-message`。
- 用户消息：`[data-testid="user-message"]`；生成中：`button[aria-label="停止生成"]`。

**hark**（`hark`）
- `/chat` 是一条长对话；角色无属性标记，看 `data-align`（`end`=用户），助手正文是 Markdown。

**chatgpt**（`chatgpt`）
- 用 `DEFAULT_CONFIG` 通用配置。

新增站点：先在看板跑"添加网站"探测，拿回 DOM 后照上面的格式补 `SITE_PROFILES` 条目。

## 项目结构

```text
ai-chat-room/
├── contracts/        # 前后端唯一契约：protocol.js + protocol.schema.json
├── src/frontend/     # Chrome MV3 插件（manifest、后台、内容脚本、弹窗）
├── src/backend/      # 监听会话：bin/ 启动、src/ 服务端、dashboard/ 看板
├── tests/            # unit / integration / e2e + helpers.js
├── scripts/          # Schema 导出、协议同步、命令行观察者、verify
└── docs/             # 架构、开发、测试、安全；docs/bridge/ 为详细使用说明
```

## 两端同时开发

前端、后端各自一个泳道，只通过 `contracts/` 沟通，规则见 `docs/development/multi-agent.md`。

```bash
pnpm test:frontend   # 插件：DOM 观察、站点适配
pnpm test:backend    # 后端：协议、DOM 分析、看板 API、广播 E2E
```

## 文档导航

- AI 协作规则：`AGENTS.md`（各子目录另有 AGENTS.md）
- 完整使用说明（配置、token、站点表、Tailscale 远程）：`docs/bridge/README.md`
- 架构：`docs/architecture/overview.md`
- 开发：`docs/development/`
- 测试：`docs/testing/`
- 安全：`docs/security/`
