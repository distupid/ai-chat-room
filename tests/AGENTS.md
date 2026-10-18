# AGENTS.md — test/（测试）

## 组成
| 文件 | 覆盖 |
|---|---|
| `protocol.test.js` | Schema、零依赖校验器 vs Ajv、方向、event_id、shared 副本一致 |
| `observer.test.js` | ChatGPT DOM 观察：新消息、流式、生成开始/结束、去重 |
| `sites.test.js` | Duck.ai、Hark、ChatGPT 多站点适配、页面操作、focus |
| `dom-config.test.js` | DOM 分析 API 与配置应用 |
| `rich-content.test.js` | 富文本：观察器净化 html、协议上限、后端存储 / 脱敏 / 迁移、看板代码块 / 图片 / 文件卡片 / 再净化 / 长消息折叠 |
| `sites-config.test.js` | 网站全部可配置：默认种子、按域名选配置、编辑 / 停用 / 恢复默认、旧 sites.json 迁移、看板网站配置弹窗 |
| `broadcast.e2e.test.js` | 真实后端 + 真实 ws：持久化、多客户端顺序、回显、防循环、断线、重启补发、回放 |
| `dashboard.test.js` | 会话 API、看板渲染与指令 |
| `helpers.js` | 启动临时后端（随机端口、临时库）、jsdom 页面、waitFor |

## 规则
- 串行运行（`--test-concurrency=1`）；每个测试自己起后端、用随机端口和临时库，结束必须关闭，不留句柄。
- 不 sleep 固定时间判断结果，用 `waitFor(条件)`。
- 夹具只用手写精简 DOM，**不得放入用户保存的真实页面**（含隐私对话）。
- 每个 bug 修复先写一个能复现的失败用例。
- 测试名写成验收语句（中文），便于 `docs/TEST_REPORT.txt` 对照。

## 多人并行
- 每个模块的测试放在对应文件；新增站点新建 `sites-<site>.test.js` 而不是继续堆在 `sites.test.js`，减少合并冲突。
- 共享工具只加不改签名；必须改签名时在同一 PR 内更新所有调用方。

## 缺口
- 没有真实浏览器（Playwright）测试，插件加载、权限、隔离世界、真实站点 DOM 都没覆盖。
