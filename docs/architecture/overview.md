# 架构概览

## 系统上下文

- **用户**：在浏览器里同时使用多个 AI 对话站点、需要集中查看与回复的个人用户。
- **外部系统**：ChatGPT / Duck.ai / Hark 网页（只读 DOM + 模拟输入）；无第三方后端服务。
- **信任边界**：网页 DOM（不可信）→ 插件；插件 / 观察者 → 后端 WebSocket（token 鉴权、Origin 检查）；看板 HTTP API（observer token）。见 `../security/threat-model.md`。

## 组件划分

| 组件 | 位置 | 职责 |
|---|---|---|
| 协议 | `contracts/` | 消息信封、事件类型、Schema、错误码、scope、event_id 算法 |
| 插件（前端） | `src/frontend/` | 站点适配、DOM 观察、事件上报与重发队列、执行看板指令 |
| 监听后端 | `src/backend/src/` | 鉴权、校验、SQLite 持久化、ack、订阅与广播、指令转发、DOM 分析 |
| 看板 | `src/backend/dashboard/` | 会话列表、详情、快速回复、通知、设置（后端托管静态文件） |

## 数据流

```text
页面 DOM 变化 → content.js / dom-observer → background（信封 + 队列）
  → WS publish → 后端校验 → 同一事务写库 → ack(seq) → 广播给订阅者（无 read_content 则脱敏）
看板快速回复 → WS command → 后端路由到正开着该会话的插件标签页 → page-actions 执行 → 结果回传
```

## 关键决策

以 ADR 形式记录在 `decisions/`。
