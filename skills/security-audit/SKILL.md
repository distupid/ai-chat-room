---
name: security-audit
description: "执行依赖、密钥与信任边界安全检查"
license: "MIT"
metadata:
  version: "1.0.0"
---

# Security Audit（安全审计）

## 适用场景

发版前、依赖变更后、任何安全敏感的 diff。

## 执行步骤

1. 在仓库根目录运行 `scripts/security-check.sh`。
2. 检查项：
- Dependency audit: `pnpm audit`
- 密钥扫描：在 diff 与历史中搜索令牌、密钥与凭据。
- 对照 `docs/security/threat-model.md` 做信任边界评审。
3. 分流问题：修复、缓解，或记为「接受的风险」（写明负责人与到期时间）。
4. 反复运行直到无未解决的高风险问题。

## 验证要求

- 附上扫描输出；接受的风险必须落字，不能口头。

## 完成标准

- 无未解决的高风险问题；`docs/security/security-checklist.md` 已确认。
