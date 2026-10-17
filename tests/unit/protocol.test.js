import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  SCHEMA, validateMessage, makeEnvelope, stableEventId, fnv1a64, PROTOCOL_VERSION
} from '../../contracts/protocol.js';
import { ajvValidate, ROOT } from '../helpers.js';
import { BridgeConnection } from '../../src/frontend/lib/connection.js';
import { Broadcaster } from '../../src/backend/src/broadcaster.js';
import { TokenBucket } from '../../src/backend/src/ratelimit.js';

const msgPayload = { message_id: 'm1', role: 'assistant', index: 0, text: 'hi', text_length: 2 };
const ev = (over = {}) => makeEnvelope('event', {
  event_id: 'madded:0123456789abcdef', event_type: 'message.added', occurred_at: 1,
  conversation_id: 'conv-1234', tab_id: 3, payload: msgPayload, ...over
});

const VALID = [
  makeEnvelope('hello', { client_id: 'client-0001', client_kind: 'extension', token: 't' }),
  ev(),
  ev({ event_type: 'page.opened', payload: { url: 'https://chatgpt.com/', title: 'ChatGPT' }, conversation_id: null }),
  ev({ event_type: 'generation.finished', payload: { message_id: null, duration_ms: 10 } }),
  makeEnvelope('ack', { ref_id: 'madded:0123456789abcdef', status: 'persisted', seq: 1 }),
  makeEnvelope('error', { ref_id: null, code: 'FORBIDDEN', message: 'x', fatal: false }),
  makeEnvelope('broadcast', {
    seq: 1, origin_event_id: 'madded:0123456789abcdef', origin_client_id: 'client-0001', event_type: 'message.added',
    occurred_at: 1, conversation_id: 'c', payload: msgPayload, redacted: false, replay: false
  }),
  makeEnvelope('broadcast', {
    seq: 2, origin_event_id: 'madded:0123456789abcdef', origin_client_id: 'client-0001', event_type: 'message.added',
    occurred_at: 1, conversation_id: 'c', payload: { message_id: 'm1', role: 'user', index: 0, text_length: 5 }, redacted: true, replay: false
  }),
  makeEnvelope('subscribe', { conversations: ['*'], since_seq: 0 }),
  makeEnvelope('ping', { nonce: 'abc' })
];

const INVALID = [
  { ...ev(), v: 2 },
  { ...ev(), extra: 1 },
  ev({ event_type: 'message.added', payload: { url: 'x', title: 'y' } }),
  ev({ event_type: 'nope' }),
  ev({ payload: { ...msgPayload, role: 'robot' } }),
  ev({ event_id: 'bad id with spaces' }),
  makeEnvelope('ack', { ref_id: 'madded:0123456789abcdef', status: 'ok', seq: 1 }),
  makeEnvelope('broadcast', {
    seq: 1, origin_event_id: 'madded:0123456789abcdef', origin_client_id: 'client-0001', event_type: 'page.opened',
    occurred_at: 1, conversation_id: null, payload: { url: 1 }, redacted: false, replay: false
  }),
  { type: 'hello' },
  'string'
];

test('共享 Schema：零依赖校验器与 Ajv（标准 JSON Schema）结论一致', () => {
  for (const m of VALID) {
    assert.equal(validateMessage(m).ok, true, JSON.stringify(validateMessage(m)));
    assert.equal(ajvValidate(m), true, JSON.stringify(ajvValidate.errors));
  }
  for (const m of INVALID) {
    assert.equal(validateMessage(m).ok, false, JSON.stringify(m));
    assert.equal(ajvValidate(m), false, JSON.stringify(m));
  }
});

test('方向约束：客户端不能发送 ack/broadcast/welcome/error', () => {
  for (const t of ['ack', 'broadcast', 'error']) {
    const m = VALID.find((x) => x.type === t);
    const r = validateMessage(m, { direction: 'c2s' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FORBIDDEN');
  }
  assert.equal(validateMessage(ev(), { direction: 's2c' }).ok, false);
});

test('插件内的 shared/ 与根目录 shared/ 逐字节一致（同一份协议）', () => {
  for (const f of ['protocol.js']) {
    assert.equal(readFileSync(join(ROOT, 'src/frontend/shared', f), 'utf8'), readFileSync(join(ROOT, 'contracts', f), 'utf8'));
  }
  const exported = JSON.parse(readFileSync(join(ROOT, 'contracts/protocol.schema.json'), 'utf8'));
  assert.deepEqual(exported, JSON.parse(JSON.stringify(SCHEMA)));
  assert.equal(SCHEMA.definitions.hello.properties.v.const, PROTOCOL_VERSION);
});

test('内容脚本的 stableEventId 与共享协议算法一致', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'src/frontend/lib/dom-observer.js'), 'utf8'), { globalThis: ctx });
  const O = ctx.ChatGPTBridgeObserver;
  for (const s of ['', 'hello', '中文内容', 'x'.repeat(1000)]) assert.equal(O.fnv1a64(s), fnv1a64(s));
  assert.equal(O.stableEventId('message.updated', 'c1', 'm|h'), stableEventId('message.updated', 'c1', 'm|h'));
  assert.equal(O.conversationIdFromUrl('https://chatgpt.com/c/6720a1b2-0000-1111-2222-333344445555'), '6720a1b2-0000-1111-2222-333344445555');
});

test('指数退避：按 2^n 增长、带抖动、不超过上限', () => {
  const c = new BridgeConnection({ url: 'ws://x', token: 't', clientId: 'client-0001', WebSocketImpl: class {}, random: () => 0 });
  assert.deepEqual([0, 1, 2, 3, 10].map((a) => c.computeBackoff(a)), [500, 1000, 2000, 4000, 30000]);
  const j = new BridgeConnection({ url: 'ws://x', token: 't', clientId: 'client-0001', WebSocketImpl: class {}, random: () => 1 });
  assert.equal(j.computeBackoff(3), 2000); // 50% 抖动
});

test('发送队列有界：超过上限丢弃最旧事件并计数', () => {
  const c = new BridgeConnection({ url: 'ws://x', token: 't', clientId: 'client-0001', WebSocketImpl: class {}, maxQueue: 3 });
  for (let i = 0; i < 5; i++) c.sendEvent(ev({ event_id: `madded:${String(i).padStart(16, '0')}` }));
  assert.equal(c.queue.length, 3);
  assert.equal(c.stats.dropped_overflow, 2);
  assert.equal(c.queue[0].event_id, 'madded:0000000000000002');
  assert.equal(c.sendEvent(ev({ event_id: 'madded:0000000000000004' })), 'duplicate');
});

test('广播：单个客户端发送失败/已关闭不影响其他客户端', () => {
  const b = new Broadcaster({ policy: { max_message_bytes: 1e6, max_buffered_bytes: 1e6, slow_consumer_strikes: 3 }, logger: { warn() {} } });
  const got = [];
  const ok = (id) => ({ readyState: 1, bufferedAmount: 0, send: (d) => got.push([id, d]), close() {}, terminate() {} });
  b.add({ clientId: 'a', ws: ok('a'), subscriptions: new Set(), scopes: new Set() });
  b.add({ clientId: 'boom', ws: { readyState: 1, bufferedAmount: 0, send() { throw new Error('EPIPE'); } }, subscriptions: new Set(), scopes: new Set() });
  b.add({ clientId: 'closed', ws: { readyState: 3, send() { throw new Error('should not be called'); } }, subscriptions: new Set(), scopes: new Set() });
  b.add({ clientId: 'c', ws: ok('c'), subscriptions: new Set(), scopes: new Set() });
  const r = b.broadcast(() => ({ type: 'broadcast', x: 1 }));
  assert.equal(r.delivered, 2);
  assert.equal(r.failed, 1);
  assert.deepEqual(got.map((g) => g[0]), ['a', 'c']);
  assert.equal(b.clients.has('closed'), false, '已关闭连接被移除');
  assert.equal(b.counters.send_failures, 1);
  assert.equal(b.lastErrors.length, 1);
});

test('广播：超大消息与慢消费者被跳过并计数', () => {
  const b = new Broadcaster({ policy: { max_message_bytes: 50, max_buffered_bytes: 10, slow_consumer_strikes: 2 }, logger: { warn() {} } });
  let terminated = false;
  b.add({ clientId: 'slow', ws: { readyState: 1, bufferedAmount: 100, send() {}, terminate() { terminated = true; } }, subscriptions: new Set(), scopes: new Set() });
  b.broadcast(() => ({ t: 1 }));
  b.broadcast(() => ({ t: 1 }));
  assert.equal(b.counters.skipped_slow, 2);
  assert.equal(terminated, true);
  b.add({ clientId: 'x', ws: { readyState: 1, bufferedAmount: 0, send() {} }, subscriptions: new Set(), scopes: new Set() });
  b.broadcast(() => ({ t: 'y'.repeat(100) }));
  assert.equal(b.counters.skipped_oversize, 1);
});

test('令牌桶限流', () => {
  let t = 0;
  const bucket = new TokenBucket({ capacity: 2, refill_per_sec: 1 }, () => t);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  t = 1000;
  assert.equal(bucket.take(), true);
});
