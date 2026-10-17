#!/usr/bin/env bash
# 安全检查：依赖审计 + 密钥模式扫描。只读，绝不做破坏性操作。
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> dependency audit"
pnpm audit
echo "==> secret pattern scan (tracked files only)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git grep -n -i -E "(api[_-]?key|secret|password|token)\s*[:=]" -- . || true
  echo "（请逐条核对以上命中，误报很常见。）"
else
  echo "非 git 仓库——跳过历史感知扫描。"
fi
