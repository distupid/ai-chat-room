# AGENTS.md — src/frontend/lib/（插件核心库）

## 文件与边界
| 文件 | 职责 | 能否用 chrome.* |
|---|---|---|
| `connection.js` | WS 客户端：hello、退避重连、心跳、有界队列、ack 移除、入站校验分流、广播去重 | 否（注入 WebSocket / storage） |
| `background-core.js` | page_event → event 信封、tab_id 补全、标签页与订阅、指令路由（含 focus） | 否（注入 chrome 适配） |
| `dom-config-client.js` | 调后端 `/api/dom-config/*` | 否（注入 fetch） |
| `dom-observer.js` | 站点识别、`SITE_PROFILES`、`resolveConfig`、MutationObserver、消息/会话/状态/生成检测、事件产出 | 否（注入 document / window） |
| `page-actions.js` | reply / regenerate 页面操作 | 否 |

**这些文件都不得直接调用 `chrome.*`**，平台能力由 `background.js` / `content.js` 注入，这样 Node 测试才能直接跑。

## dom-observer.js 规则
- 只输出协议规定的事件；event_id 用 `stableEventId`，内容不变则 id 不变。
- 站点适配全部写成数据（`SITE_PROFILES[site]`：选择器、属性、正则），不写站点专用分支代码；确需代码时加在 profile 的可选钩子并带测试。
- 外部配置（DomConfig）每个字段都要校验，无效回退并写 `warnings`，绝不 `eval`。
- 正文提取要过滤按钮、工具栏、标题等 UI 文字；代码块保留换行。
- 状态检测（限额 / 错误）只扫正文以外的区域。
- 文件已近 900 行，新增站点优先考虑拆到 `lib/sites/<site>.js`（经典脚本，挂到全局表），见根目录多线程通则。

## page-actions.js 规则
- 写入输入框要触发框架能感知的 input 事件；发送前确认按钮可用。
- 不支持的动作返回 `{ok:false, code:'unsupported'}`，不要静默成功。

## 测试
`tests/observer.test.js`、`tests/sites.test.js`、`tests/broadcast.e2e.test.js`。新站点必须有一份手写精简 DOM 夹具，覆盖：会话 ID、角色、正文过滤、生成中、模型、快速回复。
