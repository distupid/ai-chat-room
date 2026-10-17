# 子项目 AI 协作规则：`src/backend`（监听会话后端）

> 继承根目录 `AGENTS.md` 的全部规则（安全基线、变更纪律）；以下为本子项目补充。

## 范围
- 目录：`src/backend`：WebSocket 握手鉴权、校验、SQLite 持久化、ack、订阅与广播、指令转发、HTTP API，以及由后端托管的看板 `dashboard/`。
- 技术栈：Node ≥ 22.13（内置 `node:sqlite`）、`ws`、`jsdom`。
- 子目录规则：`src/AGENTS.md`（服务端）、`dashboard/AGENTS.md`（看板）。

## 命令
- 启动：`pnpm start`（默认 `ws://127.0.0.1:8787`，看板 `/dashboard`）
- 后端相关测试：`pnpm test:backend`；合并前跑全量 `pnpm test`

## 禁区
- 不许修改 `src/frontend/`（跨子项目改动先问负责人）。`dom-analyzer.js` 只读引用 `src/frontend/lib/dom-observer.js`。
- 消息格式只从 `contracts/protocol.js` 引入，不许手写；改协议或 HTTP 接口先提契约 PR（标题加 `[contract]`）。
- 不提交 `src/backend/data/`（含 token、数据库、对话）。

## 安全边界（不可放松）
- 默认只绑定 `127.0.0.1`；非回环需 `BRIDGE_ALLOW_REMOTE=1`。
- 拒绝普通 `http(s)` 网页 Origin；token 握手鉴权；无 `read_content` 必须脱敏。
- 日志、`/stats`、错误信息不含对话正文。

## 完成标准
- 相关测试全绿；结论附证据（命令输出、文件路径）。
