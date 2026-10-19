#!/usr/bin/env node
/**
 * 按 suite 跑测试：node scripts/run-suite.js <unit|frontend|backend> [...]
 * （package.json 的 test:unit / test:frontend / test:backend 都调它）
 *
 * 先跑 build 等价步骤（导出 schema + 同步 shared，保证"生成物一致"测试有效），
 * 再用 node --test 串行跑该 suite 的测试文件。
 * 文件列表唯一来源：scripts/test-map.js 的 SUITES。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES } from './test-map.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 等价于 pnpm build（只用 node 内置模块，不依赖 pnpm 在 PATH 中） */
export function build() {
  for (const s of ['scripts/export-schema.js', 'scripts/sync-shared.js']) {
    execFileSync(process.execPath, [join(ROOT, s)], { stdio: 'inherit', cwd: ROOT });
  }
}

/** 全量测试文件（去重，保持 suite 顺序） */
export function allTestFiles() {
  return [...new Set(Object.values(SUITES).flat())];
}

/** 跑指定的测试文件列表（先 build，失败时透出退出码） */
export function runTestFiles(files) {
  if (!files.length) {
    console.log('[run-suite] 没有测试文件，跳过');
    return;
  }
  build();
  console.log(`[run-suite] 运行 ${files.length} 个测试文件：\n  ${files.join('\n  ')}`);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 直接执行：node scripts/run-suite.js frontend backend
const names = process.argv.slice(2);
if (names.length) {
  const unknown = names.filter((s) => !SUITES[s]);
  if (unknown.length) {
    console.error(`[run-suite] 未知 suite: ${unknown.join(', ')}（可选：${Object.keys(SUITES).join(' / ')})`);
    process.exit(2);
  }
  runTestFiles([...new Set(names.flatMap((s) => SUITES[s]))]);
}
