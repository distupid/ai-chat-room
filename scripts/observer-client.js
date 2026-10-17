#!/usr/bin/env node
// 手动多客户端测试：作为第二个 WebSocket 客户端订阅并打印广播
//   npm run observer -- --token <observer token> [--url ws://127.0.0.1:8787] [--conv '*'] [--since 0]
import WebSocket from 'ws';
import { makeEnvelope, validateMessage } from '../contracts/protocol.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const url = args.url || 'ws://127.0.0.1:8787';
const token = args.token || process.env.BRIDGE_TOKEN;
if (!token) { console.error('need --token (see server/data/config.json → observer)'); process.exit(1); }
const conv = (args.conv || '*').split(',');
const since = args.since != null ? Number(args.since) : null;
const clientId = args.id || `observer-${process.pid}-cli`;

const ws = new WebSocket(url);
ws.on('open', () => ws.send(JSON.stringify(makeEnvelope('hello', { client_id: clientId, client_kind: 'observer', token }))));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  const v = validateMessage(m, { direction: 's2c' });
  if (!v.ok) return console.warn('[invalid]', v.errors);
  if (m.type === 'welcome') {
    console.log(`[welcome] session=${m.session_id} scopes=${m.scopes.join(',')}`);
    ws.send(JSON.stringify(makeEnvelope('subscribe', { conversations: conv, ...(since != null ? { since_seq: since } : {}) })));
  } else if (m.type === 'broadcast') {
    const text = m.payload.text != null ? ` "${String(m.payload.text).slice(0, 80)}"` : '';
    console.log(`[broadcast #${m.seq}${m.replay ? ' replay' : ''}] ${m.event_type} conv=${m.conversation_id ?? '-'} from=${m.origin_client_id}${text}`);
  } else {
    console.log(`[${m.type}]`, JSON.stringify(m));
  }
});
ws.on('close', (c, r) => { console.log(`[close] ${c} ${r}`); process.exit(0); });
ws.on('error', (e) => console.error('[error]', e.message));
