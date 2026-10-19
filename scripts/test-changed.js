#!/usr/bin/env node
/**
 * pnpm test:changed：按 git 变更自动选择要跑的测试 suite（日常开发提速）。
 *
 * - 工作区有变更 → 只跑受影响的 suite（映射规则见 scripts/test-map.js）
 * - 无变更 → 跑 unit 做冒烟（~3s）
 * - 变更触及工程文件（scripts/package.json/eslint/.github 等）→ 跑全量
 */
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES, suitesForChangedFiles } from './test-map.js';
import { allTestFiles, runTestFiles } from './run-suite.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** 变更文件：未提交的（含已暂存/未暂存/未跟踪）+ 本分支独有提交的 */
function changedFiles() {
  const set = new Set();
  for (const line of git('diff --name-only HEAD').split('\n')) if (line) set.add(line);
  for (const line of git('ls-files --others --exclude-standard').split('\n')) if (line) set.add(line);
  const base = git('merge-base HEAD main');
  const head = git('rev-parse HEAD');
  if (base && head && base !== head) {
    for (const line of git(`diff --name-only ${base} HEAD`).split('\n')) if (line) set.add(line);
  }
  return [...set];
}

const changed = changedFiles();
if (!changed.length) {
  console.log('[test:changed] 工作区无变更，跑 unit 冒烟');
  runTestFiles(SUITES.unit);
  process.exit(0);
}

const { files, full, reason, warnings } = suitesForChangedFiles(changed);
for (const w of warnings) console.warn(`[test:changed] 注意：${w}`);

if (full) {
  console.log(`[test:changed] ${reason}，跑全量（${allTestFiles().length} 个文件）`);
  runTestFiles(allTestFiles());
} else if (!files.length) {
  console.log(`[test:changed] ${reason}，跑 unit 冒烟`);
  runTestFiles(SUITES.unit);
} else {
  console.log(`[test:changed] ${reason}；变更 ${changed.length} 个文件`);
  runTestFiles(files);
}
