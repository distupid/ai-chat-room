---
name: code-quality
description: "在变更收尾前运行技术栈的代码检查与类型检查"
license: "MIT"
metadata:
  version: "1.0.0"
---

# Code Quality（代码质量）

## 适用场景

任何代码变更收尾前：新功能、重构、提 PR。

## 执行步骤

1. 先读 `docs/development/coding-standards.md`，确认适用规则。
2. 运行检查：
- Lint: `pnpm dlx eslint .`
- 类型检查：`pnpm dlx tsc --noEmit`
3. 修复所有发现的问题；不要无理由压制警告，压制必须写注释说明。
4. 反复运行直到全绿，然后总结检查了什么。

## 验证要求

- 把检查输出作为证据贴出来，「看着没问题」不算证据。

## 完成标准

- 最终 diff 的全部检查通过，且没有引入新警告。
