#!/usr/bin/env bash
# 本地验证：运行本技术栈的真实检查，遇到失败即停。
# 用法：scripts/verify.sh [--quick] [--install]
#   --quick：跳过 install，只跑 lint + check-syntax + 受影响的测试（日常开发）
#   --install：与 --quick 合用时也执行 install
# 完整模式（默认）：合分支 / 发布前跑。
set -euo pipefail
cd "$(dirname "$0")/.."

QUICK=0
DO_INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1; DO_INSTALL=0 ;;
    --install) DO_INSTALL=1 ;;
    *) echo "未知参数：$arg（可用：--quick --install）"; exit 2 ;;
  esac
done

if [ "$DO_INSTALL" = 1 ]; then
  echo "==> install"
  pnpm install --frozen-lockfile
else
  echo "==> install（--quick 跳过）"
fi
echo "==> lint + syntax"
pnpm lint
pnpm check-syntax
if [ "$QUICK" = 1 ]; then
  echo "==> changed tests"
  pnpm test:changed
else
  echo "==> build + test"
  pnpm test
fi
echo "==> 生成物一致性"
git diff --exit-code -- contracts/protocol.schema.json src/frontend/shared/ || { echo "生成物未提交：请提交 pnpm build 的结果"; exit 1; }
echo "全部检查通过。"
