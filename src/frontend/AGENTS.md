# 子项目 AI 协作规则：`src/frontend`

> 本文件继承根目录 `AGENTS.md` 的全部规则（安全基线、变更纪律）；以下为本子项目特有补充。

## 范围

- 本子项目目录：`src/frontend`
- 技术栈：全栈（Node 前后端）

## 命令

- 安装依赖：`pnpm install`
- 运行测试：`pnpm test`
- 代码检查：`pnpm dlx eslint .`
- 构建：`pnpm build`

## 禁区

- 不许修改以下目录：`src/backend`（跨子项目改动先问负责人）。
- 接口类型只从 contracts/ 生成，不许手写；改接口先提契约变更。

## 完成标准

- 相关测试全绿；结论附证据（命令输出、文件路径）。

