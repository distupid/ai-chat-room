# AGENTS.md — 根目录（总则）

本仓库：网页对话（ChatGPT / Duck.ai / Hark）→ Chrome MV3 插件 → 本地 Node 后端（校验、SQLite、WebSocket 广播）→ 看板 / 观察者。
每个模块目录下都有自己的 AGENTS.md，**进入哪个目录工作，先读那个目录的 AGENTS.md**；本文件是所有模块共同遵守的通则。

## 模块与负责范围
| 模块 | 目录 | 一句话职责 |
|---|---|---|
| 协议 | `contracts/` | 消息类型、Schema、校验器、event_id 算法（唯一事实来源） |
| 后端 | `src/backend/src/` | WS 握手鉴权、校验、持久化、ack、订阅、广播、指令转发、HTTP API |
| 看板 | `src/backend/dashboard/` | 会话列表、详情、快速回复、通知、设置 |
| 插件-后台 | `src/frontend/background.js`, `src/frontend/lib/{background-core,connection,dom-config-client}.js` | 事件信封、WS 客户端、队列重发、标签页与指令路由 |
| 插件-页面 | `src/frontend/content.js`, `src/frontend/lib/{dom-observer,page-actions}.js` | 站点适配、DOM 观察、页面操作 |
| 插件-界面 | `src/frontend/popup.*`, `src/frontend/manifest.json` | 设置、诊断、权限 |
| 测试 | `tests/` | 单元 + 真实 ws 的多客户端 E2E |
| 脚本 | `scripts/` | Schema 导出、shared 同步、命令行观察者 |

## 硬性规则
1. 协议只在 `contracts/protocol.js` 改；`src/frontend/shared/` 是构建产物，禁止手改（`pnpm build:ext` 生成）。
2. 任何跨模块的字段、事件类型、指令、HTTP 接口变化，先改协议/接口文档，再改实现，并在 PR 描述里列出受影响模块。
3. `pnpm test` 必须全绿才能合并；新增行为必须带测试。
4. 安全边界不可放松：只监听回环地址、拒绝网页 Origin、token 鉴权、无 `read_content` 权限必须脱敏。
5. 日志、`/stats`、错误信息里不得出现对话正文。
6. 不提交 `src/backend/data/`、数据库、用户保存的页面 HTML（含隐私对话）；测试夹具只用手写精简 DOM。
7. 内容脚本是经典脚本（非 ES module），不能 `import`；共享逻辑通过全局 `ChatGPTBridgeObserver` / `ChatGPTBridgeActions` 暴露。
8. 版本号：插件改动升 `src/frontend/manifest.json` 版本；协议不兼容改动升 `PROTOCOL_VERSION`。
9. 注释与文档用中文，标识符用英文。

## 常用命令
```bash
pnpm install
pnpm test          # 导出 schema → 同步 shared → 全部测试（串行）
pnpm start         # ws://127.0.0.1:8787，看板 /dashboard
pnpm observer -- --token <observer token>
```
