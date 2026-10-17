# Git 工作流

## 分支模型

- `main` 为默认分支，永远保持可发布。
- 功能分支：`feat/<范围>-<描述>`；修复：`fix/<描述>`；文档：`docs/<描述>`。
- 合并前 rebase 到 `main`；功能分支用 `--no-ff` 合并。

## 提交信息

Conventional Commits：`feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:`。
示例：`feat(auth): add refresh-token rotation`

- 一次提交只做一件事；原因不明显时在正文写清为什么。
## PR 检查单（复制到 PR 描述）

- [ ] 测试已新增/更新且全绿（`pnpm test`）
- [ ] 行为或架构变化已同步文档
- [ ] 无密钥、无调试后门
- [ ] 关联了 issue（或说明为什么没有）
