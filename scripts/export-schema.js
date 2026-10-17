// 导出 shared/protocol.schema.json（标准 JSON Schema，供文档和第三方客户端使用）
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA } from '../contracts/protocol.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'protocol.schema.json');
writeFileSync(out, JSON.stringify(SCHEMA, null, 2) + '\n');
console.log(`[export-schema] wrote ${out}`);
