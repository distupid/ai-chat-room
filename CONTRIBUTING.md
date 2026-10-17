# 贡献指南

## 分支与提交

- 默认分支：`main`。从它切出功能分支：`feat/<范围>-<简述>`。
- 提交保持小而聚焦；使用 Conventional Commits（`feat:`、`fix:`、`docs:`、`test:`、`chore:`）。
- 提 PR 前先 rebase 到 `main`，在本地解决冲突。

## 提 PR 前的检查

- [ ] 新增/更新了测试且全部通过
- [ ] `scripts/verify.sh` 为绿
- [ ] 影响用户的变更已同步文档
- [ ] diff 中无密钥与凭据
- [ ] PR 描述讲清楚了为什么，而不只是做了什么
