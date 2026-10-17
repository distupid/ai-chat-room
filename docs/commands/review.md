---
description: "审查当前变更"
---

# /review

审查当前变更。

```
!`git status --short`
!`git diff --stat`
```

参数：$ARGUMENTS（可选的关注范围，例如 `/review auth`）。

1. 通读变更文件的完整 diff：先看 @AGENTS.md 确认规则，再逐文件读。
2. 把深度审查交给 reviewer agent。
3. 给出问题表与结论；不自动改代码，改之前先问。
