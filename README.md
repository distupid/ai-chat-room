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
