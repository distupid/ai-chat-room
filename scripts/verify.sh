#!/usr/bin/env bash
# 本地验证：运行本技术栈的真实检查，遇到失败即停。
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> install"
pnpm install --frozen-lockfile
echo "==> lint + syntax"
pnpm lint
pnpm check-syntax
echo "==> build + test"
pnpm test
echo "==> 生成物一致性"
git diff --exit-code -- contracts/protocol.schema.json src/frontend/shared/ || { echo "生成物未提交：请提交 pnpm build 的结果"; exit 1; }
echo "全部检查通过。"
