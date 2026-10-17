/**
 * 广播验收：真实 Node 后端 + 真实 WebSocket（ws）+ 真实 SQLite + jsdom 中执行的真实内容脚本。
 * 插件端使用 extension/lib/background-core.js + connection.js（与 Service Worker 同一份代码），
 * 仅把浏览器 WebSocket 替换为 Node 的 ws 实现。
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createBackground } from '../../src/frontend/lib/background-core.js';
import { makeEnvelope, validateMessage } from '../../contracts/protocol.js';
import {
  startServer, tmpDb, TestClient, TOKENS, waitFor, sleep, memoryStorage,
  openChatGPTPage, chatHtml, ajvValidate
} from '../helpers.js';

const CONV = '6720a1b2-0000-4111-8222-333344445555';
const CONV_URL = `https://chatgpt.com/c/${CONV}`;
const EXT_ID = 'ext-e2e-client-0001';

describe('WebSocket 双向通信与广播验收', () => {
  let server, dbPath, port, bg, page, B, C;
  const userText = '帮我写一个 WebSocket 广播服务';
  const finalText = '好的，下面是一个完整的实现：服务端维护连接集合并广播。';

  before(async () => {
    dbPath = tmpDb();
    server = await startServer({ dbPath });
    port = server.port;
    bg = createBackground({
      WebSocketImpl: WebSocket,
      storage: memoryStorage(),
      clientId: EXT_ID,
      settings: { serverUrl: server.url, token: TOKENS.extension },
      connectionOptions: { backoff: { baseMs: 50, maxMs: 400 }, heartbeatMs: 500, pongTimeoutMs: 2000 }
    });
  });

  after(async () => {
    bg?.conn.stop();
    page?.close();
    B?.close(); C?.close();
    await server?.stop();
  });

  test('1. 插件成功连接后端 WebSocket（hello → welcome）', async () => {
    await bg.conn.start();
    await waitFor(() => bg.conn.state === 'open', { label: 'extension open' });
    const d = bg.diagnostics();
    assert.equal(d.state, 'open');
    assert.ok(d.session.id);
    assert.deepEqual(new Set(d.session.scopes), new Set(['publish', 'subscribe', 'read_content']));
    assert.equal(d.session.policy.echo_to_sender, false);

    // 第二、第三个客户端：观察者，订阅全部会话
    B = await new TestClient(server.url).open();
    assert.equal((await B.hello('observer-B-0001', TOKENS.observer)).type, 'welcome');
    assert.equal((await B.subscribe(['*'])).type, 'subscribed');
    C = await new TestClient(server.url).open();
    await C.hello('observer-C-0001', TOKENS.observer);
    await C.subscribe(['*']);
    assert.equal(server.broadcaster.size, 3);
  });

  test('2. 插件捕获真实 DOM 变化并上报事件', async () => {
    page = openChatGPTPage({
      url: CONV_URL, tabId: 7, background: bg,
      html: chatHtml([{ role: 'user', id: 'msg-user-1', text: userText }])
    });
    const { doc, win } = page;
    await waitFor(() => page.sent.some((m) => m.event.event_type === 'message.added'), { label: 'initial scan' });

    // 模拟 ChatGPT 开始生成：出现 stop 按钮 + 新的 assistant 节点，然后流式追加文字
    doc.querySelector('[data-testid="send-button"]').setAttribute('data-testid', 'stop-button');
    const turn = doc.createElement('article');
    turn.innerHTML = '<div data-message-author-role="assistant" data-message-id="msg-asst-1"><div class="markdown result-streaming"></div></div>';
    doc.getElementById('thread').appendChild(turn);
    const md = turn.querySelector('.markdown');
    // 流式输出：每 400ms 追加一段（内容脚本默认 250ms 合并、同一消息 1s 节流）
    for (const chunk of ['好的，', '下面是', '一个完整的实现：', '服务端维护连接集合', '并广播。']) {
      md.appendChild(doc.createTextNode(chunk));
      await sleep(400);
    }
    md.classList.remove('result-streaming');
    doc.querySelector('[data-testid="stop-button"]').setAttribute('data-testid', 'send-button');
    await waitFor(() => page.sent.some((m) => m.event.event_type === 'generation.finished'), { label: 'generation.finished' });

    const types = page.sent.map((m) => m.event.event_type);
    for (const t of ['page.opened', 'message.added', 'generation.started', 'generation.finished']) assert.ok(types.includes(t), t);
    assert.equal(types.filter((t) => t === 'message.added').length, 2);
    assert.ok(types.includes('message.updated'));
    assert.ok(page.sent.every((m) => m.kind === 'page_event'));
    assert.equal(win.ChatGPTBridgeObserver != null, true);
    await waitFor(() => bg.conn.queue.length === 0, { label: 'all acked' });
  });

  test('3. 后端验证事件并按策略写入 SQLite（ack 在持久化之后）', async () => {
    const sentIds = page.sent.map((m) => m.event.event_id);
    for (const id of sentIds) {
      const row = server.db.getEvent(id);
      assert.ok(row, `event ${id} persisted`);
      assert.equal(row.client_id, EXT_ID);
      assert.equal(row.tab_id, 7);
    }
    const msg = server.db.getMessage(CONV, 'msg-asst-1');
    assert.equal(msg.text, finalText, '派生 messages 表保存最终完整文本');
    assert.equal(server.db.getMessage(CONV, 'msg-user-1').text, userText);
    assert.equal(bg.conn.stats.acked, sentIds.length);
    assert.equal(bg.conn.stats.received.ack, sentIds.length);
    assert.equal(server.stats().counters.events_persisted, sentIds.length);
  });

  test('4. 第二个 WebSocket 客户端收到符合规则的广播', async () => {
    const n = page.sent.length;
    await waitFor(() => B.broadcasts().length >= n, { label: 'B broadcasts' });
    const got = B.broadcasts();
    assert.equal(got.length, n);
    assert.deepEqual(got.map((b) => b.origin_event_id), page.sent.map((m) => m.event.event_id), '顺序与上报顺序一致');
    assert.ok(got.every((b) => b.origin_client_id === EXT_ID && b.conversation_id === CONV && b.replay === false));
    const last = got.filter((b) => b.event_type === 'message.updated').at(-1);
    assert.equal(last.payload.text, finalText);
    assert.equal(C.broadcasts().length, n, '第三个客户端同样收到');
  });

  test('5. 广播内容与共享 Schema 一致（零依赖校验器 + Ajv）', () => {
    for (const client of [B, C]) {
      assert.deepEqual(client.invalid, []);
      for (const m of client.messages) {
        assert.equal(validateMessage(m, { direction: 's2c' }).ok, true);
        assert.equal(ajvValidate(m), true);
      }
    }
    assert.equal(bg.conn.stats.received.invalid, 0);
  });

  test('6. 发送者回显行为符合配置（默认不回显；开启后被识别为自身回显并忽略）', async () => {
    assert.ok(bg.conn.subscriptions.has(CONV), '插件已订阅自己打开的会话');
    assert.equal(bg.conn.stats.received.broadcast, 0, 'echo_to_sender=false：发送者收不到自己的广播');

    server.config.policy.echo_to_sender = true;
    const before = { B: B.broadcasts().length, sent: bg.conn.stats.sent };
    page.doc.querySelector('[data-message-id="msg-user-1"] .markdown').textContent = userText + '（已编辑）';
    await waitFor(() => bg.conn.stats.received.broadcast === 1, { label: 'self echo' });
    assert.equal(bg.conn.stats.broadcast_self_echo, 1);
    assert.equal(bg.conn.stats.broadcast_delivered, 0, '自身回显不交给业务回调');
    await waitFor(() => B.broadcasts().length === before.B + 1, { label: 'B got edit' });
    await sleep(300);
    assert.equal(bg.conn.stats.sent, before.sent + 1, '回显没有触发任何重新上报');
    server.config.policy.echo_to_sender = false;
  });

  test('7. 重复事件不会重复广播、不会形成循环', async () => {
    const baseline = B.broadcasts().length;
    const persistedBefore = server.stats().counters.events_persisted;

    // a) DOM 有变化但消息内容没变（触发重新扫描）→ 不产生事件
    const sentBefore = page.sent.length;
    page.doc.getElementById('thread').className = 'rescan';
    await sleep(300);
    assert.equal(page.sent.length, sentBefore);

    // b) 刷新页面：新内容脚本对同一 DOM 重新观察 → message.added 的稳定 event_id 相同 → 后端 duplicate
    const page2 = openChatGPTPage({ url: CONV_URL, tabId: 8, background: bg, html: page.doc.documentElement.outerHTML });
    await waitFor(() => page2.sent.filter((m) => m.event.event_type === 'message.added').length === 2, { label: 'page2 scan' });
    const dupIds = page2.sent.filter((m) => m.event.event_type === 'message.added').map((m) => m.event.event_id);
    assert.ok(dupIds.every((id) => server.db.getEvent(id)), '与第一次观察到的 event_id 相同');

    // c) 另一个连接原样重放已存在的事件（模拟重连重发）→ ack duplicate，不广播
    const replayer = await new TestClient(server.url).open();
    await replayer.hello('ext-replayer-0001', TOKENS.extension, 'extension');
    const original = server.db.getEvent(dupIds[0]);
    const again = makeEnvelope('event', {
      event_id: original.event_id, event_type: original.event_type, occurred_at: original.occurred_at,
      conversation_id: original.conversation_id, tab_id: original.tab_id, payload: original.payload
    });
    replayer.send(again); replayer.send(again);
    await waitFor(() => replayer.of('ack').length === 2, { label: 'dup acks' });
    assert.ok(replayer.of('ack').every((a) => a.status === 'duplicate' && a.seq === original.seq));

    // d) 客户端试图把 broadcast 当事件发回 → FORBIDDEN，不入库、不广播
    const bounced = { ...B.broadcasts()[0], id: 'bounce-000001' };
    replayer.send(bounced);
    await waitFor(() => replayer.of('error').length === 1, { label: 'bounce error' });
    assert.equal(replayer.of('error')[0].code, 'FORBIDDEN');

    await sleep(400);
    const page2Added = page2.sent.length - dupIds.length; // page.opened 等非重复事件
    assert.equal(B.broadcasts().length, baseline + page2Added, '只有新的 page.opened 被广播，重复的 message.added 没有');
    assert.equal(server.stats().counters.events_persisted, persistedBefore + page2Added);
    // page2 的两条重复 message.added：插件端已确认过的 event_id 在本地直接去重；replayer 的两条由后端去重
    assert.ok(bg.conn.stats.skipped_local_duplicate >= 2);
    assert.ok(server.stats().counters.events_duplicate >= 2);
    const seqs = B.broadcasts().map((b) => b.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'B 没有收到任何重复 seq');
    page2.close();
    replayer.close();
  });

  test('8. 一个客户端断开不影响其他客户端接收广播', async () => {
    C.terminate();
    await waitFor(() => server.broadcaster.size === 2 || ![...server.broadcaster.clients.keys()].includes('observer-C-0001'), { label: 'C removed' });
    const before = B.broadcasts().length;
    page.doc.querySelector('[data-message-id="msg-asst-1"] .markdown').appendChild(page.doc.createTextNode('（补充）'));
    // 助手文本变化会被“活动检测”视为一次生成，所以可能同时收到 generation.started/finished
    const upd = () => B.broadcasts().slice(before).find((x) => x.event_type === 'message.updated');
    await waitFor(() => upd(), { label: 'B still receives' });
    assert.equal(upd().payload.text, finalText + '（补充）');
    await waitFor(() => B.broadcasts().slice(before).some((x) => x.event_type === 'generation.finished'), { label: 'activity finished' });
    assert.equal(bg.conn.state, 'open');
  });

  test('9. 后端重启后插件自动恢复连接，断线期间事件有界缓存并补发', async () => {
    const lastSeq = B.broadcasts().at(-1).seq;
    const connectsBefore = bg.conn.stats.connects;
    B.close();
    await server.stop();
    await waitFor(() => bg.conn.state === 'waiting' || bg.conn.state === 'connecting', { label: 'ext noticed down' });

    // 后端停机期间页面继续变化 → 事件进入发送队列
    const t = page.doc.createElement('article');
    t.innerHTML = '<div data-message-author-role="user" data-message-id="msg-user-2"><div class="markdown">后端重启期间的新消息</div></div>';
    page.doc.getElementById('thread').appendChild(t);
    await waitFor(() => bg.conn.queue.length >= 1, { label: 'queued while down' });
    const queuedIds = bg.conn.queue.map((e) => e.event_id);
    await sleep(500); // 让插件经历几次失败的重连（指数退避）
    assert.ok(bg.conn.stats.reconnects >= 2);

    server = await startServer({ dbPath, port });
    const B2 = await new TestClient(server.url).open();
    await B2.hello('observer-B-0002', TOKENS.observer);
    await B2.subscribe(['*'], lastSeq); // 有 history 权限：回放 lastSeq 之后的事件
    await waitFor(() => bg.conn.state === 'open' && bg.conn.queue.length === 0, { timeout: 8000, label: 'ext reconnected & flushed' });
    assert.equal(bg.conn.stats.connects, connectsBefore + 1);
    for (const id of queuedIds) assert.ok(server.db.getEvent(id), `queued ${id} persisted after restart`);
    await waitFor(() => queuedIds.every((id) => B2.broadcasts().some((b) => b.origin_event_id === id)), { label: 'B2 got queued events' });
    const seqs = B2.broadcasts().map((b) => b.seq);
    assert.equal(new Set(seqs).size, seqs.length);
    B = B2;
  });

  test('10. ACK、错误、广播不会被误识别为新的页面事件', async () => {
    const d = bg.diagnostics();
    const contentEmitted = page.sent.length + 3 /* page2 的非重复事件已单独计 */;
    assert.ok(d.stats.received.ack > 0);
    // 插件只把内容脚本的 page_event 上报；服务端收到的该插件事件数 == 内容脚本发出的事件数
    const fromExt = server.db.raw.prepare('SELECT COUNT(*) n FROM events WHERE client_id = ?').get(EXT_ID).n;
    assert.ok(fromExt <= contentEmitted);
    assert.equal(d.page_events.accepted, bg.conn.stats.sent + bg.conn.stats.skipped_local_duplicate);

    // 把后端消息塞进内部消息通道也不会被当作页面事件
    const r1 = bg.handleRuntimeMessage({ kind: 'broadcast', event: B.broadcasts()[0] });
    const r2 = bg.handleRuntimeMessage({ kind: 'page_event', event: { type: 'ack', ref_id: 'x' } });
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);

    // 观察者发来的 ack / error 类型会被服务端拒绝（方向错误），不会入库
    const before = server.db.countEvents();
    B.send(makeEnvelope('ack', { ref_id: 'madded:0000000000000000', status: 'persisted', seq: 1 }));
    B.send(makeEnvelope('error', { ref_id: null, code: 'INTERNAL', message: 'x', fatal: false }));
    await waitFor(() => B.of('error').length >= 2, { label: 'direction errors' });
    assert.ok(B.of('error').every((e) => e.code === 'FORBIDDEN'));
    assert.equal(server.db.countEvents(), before);
    assert.equal(bg.conn.stats.received.invalid, 0);
  });

  test('访问边界：无 read_content 只收到脱敏广播；无权订阅全部/历史；网页 Origin 与错误 token 被拒绝', async () => {
    const M = await new TestClient(server.url).open();
    await M.hello('observer-meta-001', TOKENS.meta);
    assert.equal((await M.subscribe(['*'])).code, 'FORBIDDEN');
    assert.equal((await M.subscribe([CONV], 0)).code, 'FORBIDDEN');
    assert.equal((await M.subscribe([CONV])).type, 'subscribed');
    page.doc.querySelector('[data-message-id="msg-user-2"] .markdown').textContent = '机密内容';
    await waitFor(() => M.broadcasts().length === 1, { label: 'meta broadcast' });
    const b = M.broadcasts()[0];
    assert.equal(b.redacted, true);
    assert.equal('text' in b.payload, false);
    assert.equal(b.payload.text_length, 4);
    assert.deepEqual(M.invalid, []);
    M.close();

    await assert.rejects(new TestClient(server.url, { origin: 'https://evil.example' }).open(), /403/);
    const bad = await new TestClient(server.url).open();
    const r = await bad.hello('observer-bad-0001', 'wrong-token');
    assert.equal(r.code, 'UNAUTHORIZED');
    await waitFor(() => bad.closedWith != null, { label: 'bad closed' });
    const ext = await new TestClient(server.url, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }).open();
    assert.equal((await ext.hello('ext-origin-0001', TOKENS.extension, 'extension')).type, 'welcome');
    ext.close();
  });

  test('限制：超大消息被拒绝、首条非 hello 被断开', async () => {
    const big = await new TestClient(server.url).open();
    await big.hello('observer-big-0001', TOKENS.observer);
    big.send('x'.repeat(300 * 1024));
    await waitFor(() => big.closedWith != null, { label: 'oversize close' });
    assert.equal(big.closedWith, 1009);

    const rude = await new TestClient(server.url).open();
    rude.send(makeEnvelope('ping', { nonce: 'n' }));
    await waitFor(() => rude.of('error')[0], { label: 'not hello' });
    assert.equal(rude.of('error')[0].code, 'NOT_HELLO');
    await waitFor(() => rude.closedWith != null, { label: 'rude closed' });
    assert.equal(bg.conn.state, 'open', '其他连接的异常不影响插件');
  });
});
