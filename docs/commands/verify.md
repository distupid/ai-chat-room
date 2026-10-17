---
description: "按项目真实配置执行验证"
---

# /verify

用项目真实配置执行验证。

```
!`pnpm dlx eslint .`
!`pnpm dlx tsc --noEmit`
!`pnpm test`
!`pnpm build`
```

参数：$ARGUMENTS（可选范围，例如 `/verify tests/unit`）。

1. 按顺序执行每一步，遇到失败即停。
2. 每一步给出 PASS/FAIL 与输出，不许把失败一笔带过。
3. 标为「待确认」的步骤：去跟维护者确认真实命令，不许编造。
