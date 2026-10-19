import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  SCHEMA, validateMessage, makeEnvelope, stableEventId, fnv1a64, randomId, isBusinessEvent,
  PROTOCOL_VERSION, MessageType, Direction, EventType, ConversationStatus, Scope,
  ErrorCode, NON_RETRYABLE_ERRORS, CommandAction, Limits, EVENT_PAYLOAD_SCHEMAS
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
  for (const f of ['protocol.js', 'protocol.schema.json']) {
    assert.equal(readFileSync(join(ROOT, 'src/frontend/shared', f), 'utf8'), readFileSync(join(ROOT, 'contracts', f), 'utf8'));
  }
  const exported = JSON.parse(readFileSync(join(ROOT, 'contracts/protocol.schema.json'), 'utf8'));
  assert.deepEqual(exported, JSON.parse(JSON.stringify(SCHEMA)));
  assert.equal(SCHEMA.definitions.hello.properties.v.const, PROTOCOL_VERSION);
});

test('Schema 导出文件与内存 SCHEMA 字节一致（pnpm build 无漂移）', () => {
  const raw = readFileSync(join(ROOT, 'contracts/protocol.schema.json'), 'utf8');
  assert.equal(raw, JSON.stringify(SCHEMA, null, 2) + '\n', '请运行 pnpm build:schema 后提交');
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

// ---------------------------------------------------------------------------
// 契约自洽性（A1）：常量 ↔ JSON Schema 必须互相覆盖，任何一处漂移都会变红
// ---------------------------------------------------------------------------

const REP = {
  hello: () => makeEnvelope('hello', { client_id: 'client-0001', client_kind: 'extension', token: 't' }),
  welcome: () => makeEnvelope('welcome', {
    session_id: 'sess-0001', client_id: 'client-0001', scopes: ['publish'], server_time: 1,
    policy: { echo_to_sender: true, max_message_bytes: 1024, history_limit: 100, heartbeat_ms: 1000, broadcast_event_types: ['message.added'] }
  }),
  event: () => ev(),
  ack: () => makeEnvelope('ack', { ref_id: 'madded:0123456789abcdef', status: 'persisted', seq: 1 }),
  error: () => makeEnvelope('error', { ref_id: null, code: 'FORBIDDEN', message: 'x', fatal: false }),
  broadcast: () => makeEnvelope('broadcast', {
    seq: 1, origin_event_id: 'madded:0123456789abcdef', origin_client_id: 'client-0001', event_type: 'message.added',
    occurred_at: 1, conversation_id: 'c', payload: msgPayload, redacted: false, replay: false
  }),
  subscribe: () => makeEnvelope('subscribe', { conversations: ['*'] }),
  unsubscribe: () => makeEnvelope('unsubscribe', { conversations: ['a'] }),
  subscribed: () => makeEnvelope('subscribed', { ref_id: 'client-0001', conversations: ['*'], replayed: 0 }),
  ping: () => makeEnvelope('ping', { nonce: 'abc' }),
  pong: () => makeEnvelope('pong', { nonce: 'abc' }),
  command: () => makeEnvelope('command', { command_id: 'cmd-000001', action: 'reply', conversation_id: 'c1' }),
  command_result: () => makeEnvelope('command_result', { command_id: 'cmd-000001', ok: true })
};

test('契约自洽：13 种信封类型都有最小合法消息，且零依赖校验器与 Ajv 结论一致', () => {
  const types = Object.values(MessageType);
  assert.equal(types.length, 13);
  for (const t of types) {
    const m = REP[t]();
    assert.equal(validateMessage(m).ok, true, `${t}: ${JSON.stringify(validateMessage(m))}`);
    assert.equal(ajvValidate(m), true, `${t}: ${JSON.stringify(ajvValidate.errors)}`);
  }
});

test('契约自洽：方向表 Direction 与收发方向严格一致（后端靠它拒绝伪造 broadcast/ack）', () => {
  assert.deepEqual(new Set(Object.keys(Direction)), new Set(Object.values(MessageType)));
  for (const t of Object.values(MessageType)) {
    for (const d of ['c2s', 's2c']) {
      const allowed = Direction[t].includes(d);
      const r = validateMessage(REP[t](), { direction: d });
      assert.equal(r.ok, allowed, `${t} ${d}`);
      if (!allowed) assert.equal(r.code, 'FORBIDDEN', `${t} ${d}`);
    }
    for (const d of Direction[t]) assert.ok(d === 'c2s' || d === 's2c', `${t}: ${d}`);
  }
});

test('契约自洽：每个 EventType 都有且仅有对应的 payload schema', () => {
  assert.deepEqual(new Set(Object.keys(EVENT_PAYLOAD_SCHEMAS)), new Set(Object.values(EventType)));
});

const MIN_PAYLOAD = {
  'page.opened': { url: 'https://chatgpt.com/', title: 'ChatGPT' },
  'page.closed': { url: 'https://chatgpt.com/', reason: 'unload' },
  'conversation.changed': { url: 'https://chatgpt.com/', previous_conversation_id: null },
  'message.added': msgPayload,
  'message.updated': msgPayload,
  'generation.started': { message_id: null },
  'generation.finished': { message_id: null, duration_ms: 10 },
  'conversation.status': { source: 'chatgpt', status: 'ok', detail: null },
  'tabs.snapshot': { tabs: [] }
};

test('契约自洽：9 种业务事件都有最小合法载荷，且事件类型与载荷错配会被拒绝', () => {
  for (const t of Object.values(EventType)) {
    const m = makeEnvelope('event', {
      event_id: 'madded:0123456789abcdef', event_type: t, occurred_at: 1,
      conversation_id: null, tab_id: null, payload: MIN_PAYLOAD[t]
    });
    assert.equal(validateMessage(m).ok, true, `${t}: ${JSON.stringify(validateMessage(m))}`);
    assert.equal(ajvValidate(m), true, `${t}: ${JSON.stringify(ajvValidate.errors)}`);
  }
  // 错配：message.added 的载荷不能用于 page.opened
  const bad = makeEnvelope('event', {
    event_id: 'madded:0123456789abcdef', event_type: 'page.opened', occurred_at: 1,
    conversation_id: null, payload: msgPayload
  });
  assert.equal(validateMessage(bad).ok, false);
  assert.equal(ajvValidate(bad), false);
  // 未知事件类型
  const unknown = makeEnvelope('event', {
    event_id: 'madded:0123456789abcdef', event_type: 'nope', occurred_at: 1,
    conversation_id: null, payload: {}
  });
  assert.equal(validateMessage(unknown).ok, false);
  assert.equal(ajvValidate(unknown), false);
});

test('契约自洽：CommandAction 常量值都在 command.action 的 schema enum 内', () => {
  const sch = new Set(SCHEMA.definitions.command.properties.action.enum);
  for (const a of Object.values(CommandAction)) assert.ok(sch.has(a), a);
  // MVP 冻结：DOM 选择器必需的两个 action 已补齐
  assert.ok(Object.values(CommandAction).includes('probe_site'));
  assert.ok(Object.values(CommandAction).includes('sync_sites'));
  // 注：open_sites / new_chat / resync 在 schema enum 中已有、两端已在用，常量延后到 MVP 后补
});

test('契约自洽：ConversationStatus 常量覆盖 conversation.status 的状态取值', () => {
  const sch = new Set(EVENT_PAYLOAD_SCHEMAS['conversation.status'].properties.status.enum);
  assert.deepEqual(sch, new Set(Object.values(ConversationStatus)));
});

test('契约自洽：ErrorCode / Scope / NON_RETRYABLE_ERRORS 互相引用一致', () => {
  assert.deepEqual(new Set(SCHEMA.definitions.error.properties.code.enum), new Set(Object.values(ErrorCode)));
  assert.deepEqual(new Set(SCHEMA.definitions.welcome.properties.scopes.items.enum), new Set(Object.values(Scope)));
  for (const e of NON_RETRYABLE_ERRORS) assert.ok(Object.values(ErrorCode).includes(e), e);
  assert.ok(NON_RETRYABLE_ERRORS.length >= 4);
});

test('契约自洽：Limits 常量确实被 schema 引用（改 Limits 会收紧/放宽校验）', () => {
  const mp = EVENT_PAYLOAD_SCHEMAS['message.added'].properties;
  assert.equal(mp.text.maxLength, Limits.MAX_TEXT_CHARS);
  assert.equal(mp.html.maxLength, Limits.MAX_HTML_CHARS);
  assert.equal(SCHEMA.definitions.subscribe.properties.conversations.maxItems, Limits.MAX_SUBSCRIPTIONS);
  assert.equal(SCHEMA.definitions.command.properties.text.maxLength, Limits.MAX_COMMAND_TEXT);
});

test('契约自洽：所有 object schema 都显式声明 additionalProperties', () => {
  // 例外：event / broadcast 顶层 payload 故意保持开放，由 allOf 按 event_type 细化
  const open = new Set(['#/definitions/event/properties/payload', '#/definitions/broadcast/properties/payload']);
  const bad = [];
  (function walk(s, path) {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s)) { s.forEach((x, i) => walk(x, `${path}/${i}`)); return; }
    if (s.$ref) return; // 根 oneOf 的引用不重复遍历
    const types = s.type ? (Array.isArray(s.type) ? s.type : [s.type]) : [];
    if (types.includes('object') && !('additionalProperties' in s) && !open.has(path)) bad.push(path);
    for (const [k, v] of Object.entries(s)) {
      if (k === 'additionalProperties' || typeof v !== 'object') continue;
      walk(v, `${path}/${k}`);
    }
  })(SCHEMA, '#');
  assert.deepEqual(bad, []);
});

test('validateMessage：错误码语义正确', () => {
  assert.equal(validateMessage('str').code, 'SCHEMA_VIOLATION');
  assert.equal(validateMessage(null).code, 'SCHEMA_VIOLATION');
  assert.equal(validateMessage([]).code, 'SCHEMA_VIOLATION');
  assert.equal(validateMessage({ type: 'hello' }).code, 'UNSUPPORTED_VERSION');
  assert.equal(validateMessage({ ...REP.hello(), v: 999 }).code, 'UNSUPPORTED_VERSION');
  assert.equal(validateMessage({ ...REP.hello(), type: 'nope' }).code, 'SCHEMA_VIOLATION');
  const bad = validateMessage({ ...ev(), extra: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'SCHEMA_VIOLATION');
  assert.ok(bad.errors.some((e) => e.includes('$.extra')), JSON.stringify(bad.errors));
});

test('构造辅助函数：makeEnvelope / randomId / isBusinessEvent 行为稳定', () => {
  const m = makeEnvelope('ping', { nonce: 'n' }, 1234);
  assert.equal(m.v, PROTOCOL_VERSION);
  assert.equal(m.type, 'ping');
  assert.equal(m.ts, 1234);
  assert.match(m.id, /^[A-Za-z0-9_-]{8,64}$/);
  const id = randomId('m');
  assert.ok(id.startsWith('m') && id.length <= 64);
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  assert.equal(isBusinessEvent(ev()), true);
  assert.equal(isBusinessEvent(REP.ping()), false);
  assert.equal(isBusinessEvent(null), false);
});

test('stableEventId：确定性、可区分、符合 event_id 格式', () => {
  const a = stableEventId('message.added', 'c1', 'm|h');
  assert.equal(a, stableEventId('message.added', 'c1', 'm|h'));
  assert.notEqual(a, stableEventId('message.updated', 'c1', 'm|h'));
  assert.notEqual(a, stableEventId('message.added', 'c2', 'm|h'));
  assert.notEqual(a, stableEventId('message.added', 'c1', 'm|h2'));
  assert.match(a, /^[A-Za-z0-9:._-]{8,128}$/);
  assert.ok(!a.includes(' '));
  assert.equal(stableEventId('message.added', null, 'x'), stableEventId('message.added', null, 'x'));
});

test('fnv1a64：16 位十六进制、确定性', () => {
  for (const s of ['', 'hello', '中文']) {
    const h = fnv1a64(s);
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(h, fnv1a64(s));
  }
  assert.notEqual(fnv1a64('a'), fnv1a64('b'));
});
