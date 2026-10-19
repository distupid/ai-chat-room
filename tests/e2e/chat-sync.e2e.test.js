/**
 * 聊天同步链路端到端验收（MVP 功能三）：
 *   插件上报事件 → ws 服务端校验 → sqlite 落盘 → ack(persisted, seq) →
 *   看板订阅者实时收到广播 → 看板 HTTP 接口查到会话与消息。
 * 每个用例自己起后端（随机端口、临时库），结束关闭。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnvelope } from '../../contracts/protocol.js';
import { startServer, tmpDb, TestClient, TOKENS, waitFor } from '../helpers.js';

const CONV = 'chat-sync-e2e-0001';

const ev = (n, event_type, payload) => makeEnvelope('event', {
  event_id: `t:sync:${n}`, event_type, occurred_at: Date.now(), conversation_id: CONV, payload
});

const CHAT_EVENTS = () => [
  ev(1, 'page.opened', { url: 'https://chat.example.com/c/abc', title: '联调验证会话' }),
  ev(2, 'message.added', { message_id: 'm-user-1', role: 'user', index: 0, text: '你好，请介绍一下你自己', text_length: 11 }),
  ev(3, 'generation.started', { message_id: 'm-asst-1' }),
  ev(4, 'message.added', { message_id: 'm-asst-1', role: 'assistant', index: 1, text: '你好！我是联调测试助手。', text_length: 12 }),
  ev(5, 'generation.finished', { message_id: 'm-asst-1', duration_ms: 1234 }),
  ev(6, 'conversation.status', { source: 'example', status: 'ok', detail: null, model: 'e2e-model' }),
];

test('聊天同步：插件上报 → 服务端落盘 → 看板实时收到广播 → HTTP 接口可查（整条链路跑通）', async () => {
  const server = await startServer({ dbPath: tmpDb() });
  const http = `http://127.0.0.1:${server.port}`;
  const ext = await new TestClient(server.url).open();
  const dash = await new TestClient(server.url).open();
  try {
    // 插件握手
    await ext.hello('ext-sync-0001', TOKENS.extension, 'extension');
    assert.ok(ext.of('welcome').length === 1, '插件收到 welcome');

    // 看板握手 + 订阅全部会话
    await dash.hello('dash-sync-0001', TOKENS.observer, 'observer');
    await dash.subscribe(['*']);
    assert.ok(dash.of('subscribed').length === 1, '看板订阅成功');

    // 插件上报一串聊天事件
    const events = CHAT_EVENTS();
    const acked = waitFor(
      () => ext.of('ack').length >= events.length ? ext.of('ack') : null,
      { label: '6 条 ack' });
    const broadcasted = waitFor(
      () => dash.broadcasts().length >= events.length ? dash.broadcasts() : null,
      { label: '6 条广播' });
    for (const e of events) ext.send(e);
    const acks = await acked;
    assert.ok(acks.every((a) => a.status === 'persisted'), '全部落盘 ack=persisted');
    const seqs = acks.map((a) => a.seq);
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `seq 严格递增：${seqs.join(',')}`);

    // 看板实时收到广播：顺序一致、带正文（observer 有 read_content）
    const bcs = await broadcasted;
    assert.deepEqual(bcs.map((b) => b.event_type), events.map((e) => e.event_type), '广播顺序与发送一致');
    const msgBc = bcs.find((b) => b.event_type === 'message.added' && b.payload.role === 'assistant');
    assert.equal(msgBc.payload.text, '你好！我是联调测试助手。');
    assert.equal(msgBc.redacted, false);

    // 看板 HTTP 接口：会话列表与消息
    const h = { authorization: `Bearer ${TOKENS.observer}` };
    const convs = await (await fetch(`${http}/api/conversations`, { headers: h })).json();
    const conv = convs.conversations.find((c) => c.conversation_id === CONV);
    assert.ok(conv, '会话列表里有该会话');
    assert.equal(conv.title, '联调验证会话');
    assert.equal(conv.user_count, 1);
    assert.equal(conv.assistant_count, 1);
    const msgs = await (await fetch(`${http}/api/conversations/${CONV}/messages`, { headers: h })).json();
    assert.equal(msgs.messages.length, 2);
    assert.deepEqual(msgs.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(msgs.messages[1].text, '你好！我是联调测试助手。');

    // 服务端发出的所有消息都符合协议（零依赖校验器 + Ajv 双重校验）
    assert.equal(ext.invalid.length, 0, JSON.stringify(ext.invalid.slice(0, 2)));
    assert.equal(dash.invalid.length, 0, JSON.stringify(dash.invalid.slice(0, 2)));
  } finally {
    ext.close(); dash.close();
    await server.stop();
  }
});
