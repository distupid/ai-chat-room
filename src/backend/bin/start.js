#!/usr/bin/env node
// 启动本地桥接后端：npm start
//   BRIDGE_PORT=8787 BRIDGE_HOST=127.0.0.1 BRIDGE_DB=src/backend/data/bridge.db
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeServer } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const server = createBridgeServer({
  configPath: process.env.BRIDGE_CONFIG || join(dataDir, 'config.json'),
  dbPath: process.env.BRIDGE_DB || join(dataDir, 'bridge.db')
});
await server.start();
console.log('[bridge] config:', process.env.BRIDGE_CONFIG || join(dataDir, 'config.json'));
for (const c of server.config.clients) console.log(`[bridge] token ${c.name.padEnd(9)} scopes=${c.scopes.join(',')}  token=${c.token}`);
console.log(`[bridge] stats: http://${server.config.host}:${server.port}/stats`);
console.log(`[bridge] 看板: http://${server.config.host}:${server.port}/dashboard  （用 observer token 登录）`);
const shutdown = async () => { console.log('\n[bridge] shutting down'); await server.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
