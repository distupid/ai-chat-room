---
description: "执行安全检查"
---

# /security-audit

执行安全检查。

```
!`bash scripts/security-check.sh`
```

参数：$ARGUMENTS（可选关注点，例如 `/security-audit deps`）。

1. 运行脚本；失败时保留完整输出。
2. 把问题分流交给 security-reviewer agent，以 @docs/security/threat-model.md 为上下文。
3. 报告结论：已修复 / 已缓解 / 已接受的风险（负责人 + 到期时间）。不许默默忽略任何问题。
