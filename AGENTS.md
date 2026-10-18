# 项目 AI 协作规则

> AI 协作规则的唯一入口。细节在 `docs/` 中，本文件保持简洁。

## 项目事实

- **项目名称**：`ai-chat-room`
- **项目简介**：web ai chat admin
- **技术栈**：Node ≥ 22.13；前端为 Chrome MV3 插件（原生 JS），后端为 Node（ws + node:sqlite + jsdom）
- **目录布局**：前后端分层
- **默认分支**：`main`

## 目录职责

- `src/frontend/` —— Chrome 插件：站点适配、DOM 观察、事件上报、执行看板指令。
- `src/backend/` —— 监听会话：鉴权、持久化、广播、看板与 HTTP API。
- `contracts/` —— 前后端唯一契约：消息协议 `protocol.js` 与导出的 JSON Schema。
- `docs/bridge/` —— 迁移自 chatgpt-ws-bridge 的使用说明、多 Agent 规则与测试报告。
- `tests/unit/、tests/integration/、tests/e2e/` —— 自动化测试，与源码结构对应。
- `docs/` —— 长期文档：架构、开发、测试、安全。
- `skills/` —— Agent Skills 标准目录（agent 按需自动发现加载）。
- `docs/agents/` —— 协作角色提示词（architect / reviewer / tester / security-reviewer）。
- `docs/commands/` —— 常用命令模板（review / verify / security-audit）。
- `scripts/` —— 本地验证与安全检查脚本。

## 语言边界

- `src/frontend`：浏览器原生 JS（MV3），无构建、无框架（包管理：pnpm workspace）
- `src/backend`：Node ESM（包管理：pnpm workspace）
- 跨子项目通信只走 contracts/ 定义的接口，不许私下约定；如某子项目技术栈与上表不同，请在此处补充并同步更新其 AGENTS.md。

## 开发与验证要求

- 测试命令：`pnpm test`（全量）、`pnpm test:frontend`、`pnpm test:backend`
- 构建：`pnpm build`（导出 Schema + 同步协议到插件）
- Lint / typecheck：`pnpm lint`（eslint flat config，见 `eslint.config.mjs`；src/ 存量 warn 待各负责人清理后收紧）+ `pnpm check-syntax`（`node --check` 语法门）。暂不上 `tsc --checkJs`（纯 JS 无 JSDoc，MVP 后再评估）。
- 本地一键检查优先使用 `scripts/verify.sh`。

## 变更纪律（严格）

- 每次变更保持最小化：只动必须动的文件，不顺手重构无关代码。
- 变更完成前必须验证：运行 `scripts/verify.sh` 中的检查。
- 结论必须有证据（命令输出、文件路径、行号），不运行就不得声称修好了。
- 不得擅自扩大范围；发现相邻问题先报告，不默默修掉。

## 测试要求

- 新行为必须有测试：逻辑用单元测试，边界用集成测试。
- 测试必须确定：单元测试不依赖网络与真实时间。
- 覆盖范围变化时，同步更新 `docs/testing/test-matrix.md`。

## 安全基线

### 注入
- SQL 一律参数化查询，禁止字符串拼接 SQL（包括 order by / 表名）。
- 系统命令禁止拼接用户输入；必须调用外部程序时用参数数组 + 白名单。
- 不许把用户输入传给 eval 或模板引擎渲染。
### 认证与会话
- 密码用 argon2/bcrypt 哈希，不许明文、不许可逆加密、不许打日志。
- 登录失败返回统一错误，不区分"用户不存在 / 密码错误"。
- JWT 短有效期（≤15 分钟）+ refresh token；密钥放环境变量，不许硬编码。
- token 只存 httpOnly + Secure cookie，不许 localStorage。
### 越权
- 所有按 ID 访问资源的接口必须校验"当前用户有权访问该资源"。
- 管理接口单独鉴权，不许靠"前端不展示"代替后端校验。
- 角色/权限字段由后端从会话取，不许信任客户端传参。
### 敏感信息
- 错误信息不许泄露堆栈、SQL、路径；生产环境统一脱敏。
- 日志不许打印密码、token、身份证、完整手机号。
- `.env` 不许提交；密钥/连接串只从环境变量读。
### 输入与输出
- 所有外部输入（query/body/header/文件）先校验类型、长度、范围再使用。
- 输出到 HTML 一律转义；禁止把用户数据直接拼进 innerHTML / dangerouslySetInnerHTML。
- 文件上传：校验 MIME + 魔数 + 大小上限，存随机文件名，不许按原文件名保存，上传目录不可执行。
### 网络与请求
- 服务端请求用户提供的 URL 时做 SSRF 防护：禁内网 IP、禁重定向到内网、设超时。
- CORS 不许 `*` 与允许凭证并存；按需白名单域名。
- 登录、注册、短信等接口必须限流。
### 依赖与配置
- 新依赖先确认来源可信；定期跑漏洞扫描（npm audit / pip-audit）。
- 调试接口、测试账号、管理后台不许出现在生产配置。
### 提交前自查
- 本模块新增接口都过了越权检查；无新增的日志/错误信息泄露点；无硬编码密钥。

## 规则与文档导航

- 架构：`docs/architecture/overview.md`，决策记录在 `docs/architecture/decisions/`
- 编码规范与 Git 工作流：`docs/development/`
- 测试策略与测试矩阵：`docs/testing/`
- 威胁模型与检查清单：`docs/security/`
- Skills：`skills/`（Agent Skills 标准目录；AGENTS.md 中提及 skill 只是提示，加载靠目录扫描 + 描述匹配，无需在此声明）

## 完成标准

- 代码符合 `docs/development/coding-standards.md`。
- 新增/更新了测试且全部通过；验证脚本为绿。
- 影响用户或架构的变更已同步文档。
- 无密钥、无破坏性默认行为、无未经验证的结论。
