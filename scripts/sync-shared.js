// 把 shared/ 复制到 extension/shared/（Chrome 插件只能加载自身目录内的文件）。
// 插件与后端因此使用同一份协议代码；测试会校验两份内容逐字节一致。
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'contracts');
const dst = join(root, 'src', 'frontend', 'shared');
mkdirSync(dst, { recursive: true });
const files = readdirSync(src).filter((f) => !f.endsWith('.md'));
for (const f of files) copyFileSync(join(src, f), join(dst, f));
console.log(`[sync-shared] contracts/ → src/frontend/shared/ (${files.join(', ')})`);
