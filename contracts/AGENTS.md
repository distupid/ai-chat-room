# AGENTS.md — contracts/（协议，前后端唯一契约）

## 职责
整个系统唯一的消息格式定义：信封类型与方向、业务事件类型及 payload Schema、错误码、权限 scope、限额、指令动作、`validateMessage()`、`stableEventId()`。

## 文件
- `protocol.js`：源码，ES module，零依赖，需同时在 Node 与 MV3 Service Worker 中运行。
- `protocol.schema.json`：`pnpm build:schema` 导出，禁止手改。

## 对外契约（谁在用）
- 后端 `src/backend/src/server.js`：入站校验（direction: c2s）
- 插件 `src/frontend/lib/connection.js`、`background-core.js`：出站组装与入站校验（direction: s2c）
- 看板 `src/backend/dashboard/app.js`：通过 `/dashboard/protocol.js` 加载
- 测试：Ajv 对 SCHEMA 做标准校验，并逐字节比对 `src/frontend/shared/` 副本

## 不变量
- 所有 Schema `additionalProperties: false`；新增字段要么可选，要么升 `PROTOCOL_VERSION`。
- event_id 算法改动 = 历史数据去重失效，禁止随意修改；必须改时同时写迁移说明。
- 不得引入任何依赖或 Node/浏览器专属 API。
- 方向表 `Direction` 必须与实际收发一致，后端靠它拒绝客户端伪造 `broadcast` / `ack`。

## 改动流程
1. 改 `protocol.js` → `pnpm build:schema && pnpm build:ext`
2. 在 `tests/protocol.test.js` 增加正反例
3. PR 描述列出受影响的发送方和接收方，由各模块负责人确认

## 禁止
- 在其他模块里硬编码事件类型字符串（用 `EventType.*` / `MessageType.*`）
- 手改 `src/frontend/shared/`
