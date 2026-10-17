#!/usr/bin/env bash
# 本地验证：运行本技术栈的真实检查，遇到失败即停。
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> lint"
pnpm dlx eslint .
echo "==> typecheck"
pnpm dlx tsc --noEmit
echo "==> test"
pnpm test
echo "==> build"
pnpm build
echo "全部检查通过。"
