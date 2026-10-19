/**
 * 测试分层映射（A4 维护）。
 *
 * `pnpm test:changed`（按 git 变更自动选 suite）、`scripts/run-suite.js`
 *（`pnpm test:unit|frontend|backend`）、CI 分 job 并行，都以此文件为准。
 *
 * 新增测试文件时请在此登记归属 suite；跨前后端的测试文件可同时归属
 * 两个 suite（宁可多跑，不可漏跑）。
 */

/** suite → 测试文件（相对仓库根目录） */
export const SUITES = {
  // 契约：前后端唯一协议。跑得快（~3s），改 contracts/ 必跑。
  unit: [
    'tests/unit/protocol.test.js',
    'tests/unit/protocol-mvp.test.js',
  ],
  // 插件侧：DOM 观察、站点适配、页面操作、附件上报链路
  frontend: [
    'tests/integration/observer.test.js',
    'tests/integration/sites.test.js',
    'tests/integration/open-sites.test.js',
    'tests/integration/virtual-list.test.js',
    'tests/integration/dom-config.test.js',
    'tests/integration/rich-content.test.js',
    'tests/integration/attachments.test.js',
  ],
  // 后端侧：WS 服务、看板、站点配置、指令安全、端到端
  // （unit 也在此：test:backend 历史上一直包含 unit，保持兼容）
  backend: [
    'tests/unit/protocol.test.js',
    'tests/unit/protocol-mvp.test.js',
    'tests/integration/dashboard.test.js',
    'tests/integration/sites-config.test.js',
    'tests/integration/command-security.test.js',
    'tests/integration/dom-config.test.js',
    'tests/integration/rich-content.test.js',
    'tests/integration/attachments.test.js',
    'tests/e2e/broadcast.e2e.test.js',
    'tests/e2e/chat-sync.e2e.test.js',
  ],
};

/** 反向索引：测试文件 → 所属 suites */
const FILE_TO_SUITES = {};
for (const [suite, files] of Object.entries(SUITES)) {
  for (const f of files) (FILE_TO_SUITES[f] ??= []).push(suite);
}

/**
 * 变更文件 → 要跑的测试。
 * 返回 { suites, files, full, reason, warnings }：
 * - full=true：触及工程文件，走全量（与 pnpm test 一致）
 * - files=[]：纯文档变更，调用方跑 unit 冒烟即可
 * - warnings：tests/ 下未登记的新文件（会直接跑该文件，并提示在此登记）
 */
export function suitesForChangedFiles(changed) {
  const suites = new Set();
  const extraFiles = [];
  const warnings = [];
  let full = false;

  for (const f of changed) {
    if (/^(scripts\/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|eslint\.config\.mjs|\.github\/)/.test(f)) {
      full = true;
      continue;
    }
    if (/^contracts\//.test(f)) { suites.add('unit'); continue; }
    if (/^src\/frontend\//.test(f)) { suites.add('frontend'); continue; }
    if (/^src\/backend\//.test(f)) { suites.add('backend'); continue; }
    if (/^tests\/unit\//.test(f)) { suites.add('unit'); continue; }
    if (/^tests\/e2e\//.test(f)) { suites.add('backend'); continue; }
    if (/^tests\/helpers\.js$/.test(f)) { suites.add('frontend'); suites.add('backend'); continue; }
    if (/^tests\/integration\//.test(f)) {
      const hit = FILE_TO_SUITES[f];
      if (hit) hit.forEach((s) => suites.add(s));
      else { extraFiles.push(f); warnings.push(`新测试文件尚未在 scripts/test-map.js 登记，已直接加入本次运行：${f}`); }
      continue;
    }
    if (/^(docs\/|.*\.md$)/.test(f)) continue; // 纯文档：不触发测试
    full = true; // 其他未知路径：保守起见全量
  }

  const files = [];
  for (const s of ['unit', 'frontend', 'backend']) {
    if (suites.has(s)) for (const tf of SUITES[s]) if (!files.includes(tf)) files.push(tf);
  }
  for (const tf of extraFiles) if (!files.includes(tf)) files.push(tf);

  const reason = full
    ? '变更触及工程文件（scripts/package.json/eslint/.github 等）'
    : suites.size
      ? `变更命中 suite: ${[...suites].join(', ')}`
      : '仅文档变更';

  return { suites: [...suites], files, full, reason, warnings };
}
