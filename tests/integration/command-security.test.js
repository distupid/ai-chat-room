/**
 * MVP 安全与主链路：
 * 1. 客户端伪造后端指令（probe_site / sync_sites / open_sites / new_chat / resync）→ command_result code=forbidden_action
 * 2. 无 control 权限的 token 下发指令 → error FORBIDDEN
 * 3. 聊天同步主链路：插件上报 message.added → 后端落盘（ack=persisted）→ 看板消息接口可读
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnvelope, ErrorCode } from '../../contracts/protocol.js';
import { startServer, TestClient, TOKENS, waitFor } from '../helpers.js';

const CONV = 'a4cmd-0000-4111-8222-aaaabbbbcccc';
let evSeq = 0;

function ev(type, payload, { conv = CONV } = {}) {
  evSeq++;
  return makeEnvelope('event', {
    event_id: `a4:${type.replace(/\W/g, '')}:${Date.now().toString(36)}:${evSeq}`,
    event_type: type, occurred_at: Date.now(), conversation_id: conv, payload,
  });
}

async function extClient(server, id) {
  const c = await new TestClient(server.url).open();
  await c.hello(id, TOKENS.extension, 'extension');
  return c;
}

/** observer token 自动获得 control（config.js：subscribe_all + read_content 的 observer 内存补 control） */
async function controlClient(server, id) {
  const c = await new TestClient(server.url).open();
  const w = await c.hello(id, TOKENS.observer, 'observer');
  assert.ok(w.scopes.includes('control'), '测试前置：observer 应有 control 权限');
  return c;
}

test('客户端伪造后端指令 → forbidden_action（probe_site / sync_sites / open_sites / new_chat / resync）', async () => {
  const server = await startServer();
  const c = await controlClient(server, 'a4-sec-0001');
  for (const action of ['probe_site', 'sync_sites', 'open_sites', 'new_chat', 'resync']) {
    const msg = makeEnvelope('command', {
      command_id: `cmd-forge-${action}`, action, conversation_id: 'sites', text: 'https://example.com/',
    });
    c.send(msg);
    const res = await waitFor(
      () => c.messages.find((m) => m.type === 'command_result' && m.command_id === msg.command_id),
      { label: `forbidden_action ${action}` },
    );
    assert.equal(res.ok, false, action);
    assert.equal(res.code, 'forbidden_action', action);
  }
  assert.equal(c.invalid.length, 0, '服务端返回的 command_result 应全部通过 s2c 校验');
  c.close();
  await server.stop();
});

test('无 control 权限的 token 下发指令 → FORBIDDEN 错误', async () => {
  const server = await startServer();
  const c = await extClient(server, 'a4-sec-0002');
  const msg = makeEnvelope('command', { command_id: 'cmd-no-control', action: 'reply', conversation_id: CONV, text: 'hi' });
  c.send(msg);
  const err = await waitFor(
    () => c.messages.find((m) => m.type === 'error' && m.ref_id === msg.id),
    { label: 'forbidden error' },
  );
  assert.equal(err.code, ErrorCode.FORBIDDEN);
  assert.equal(err.fatal, false);
  c.close();
  await server.stop();
});

test('聊天同步主链路：插件上报 → 后端落盘（ack=persisted）→ 看板消息接口可读', async () => {
  const server = await startServer();
  const ext = await extClient(server, 'a4-chain-0001');

  const msgEv = ev('message.added', {
    message_id: 'msg-a4-0001', role: 'assistant', index: 0, text: 'MVP 联调消息', text_length: 6,
  });
  ext.send(msgEv);
  const ack = await waitFor(
    () => ext.messages.find((m) => m.type === 'ack' && m.ref_id === msgEv.event_id),
    { label: 'ack persisted' },
  );
  assert.equal(ack.status, 'persisted', '先落盘再 ack');

  const r = await fetch(`http://127.0.0.1:${server.port}/api/conversations/${CONV}/messages`, {
    headers: { authorization: `Bearer ${TOKENS.observer}` },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  const found = body.messages.find((m) => m.message_id === 'msg-a4-0001');
  assert.ok(found, '落盘的消息在看板接口可读');
  assert.equal(found.text, 'MVP 联调消息');

  ext.close();
  await server.stop();
});
