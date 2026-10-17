/**
 * 看板：静态页面、数据接口、会话实体（来源 / 状态 / 限额）、标记完成、指令通道（快速回复 / 重新回答）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createBackground } from '../../src/frontend/lib/background-core.js';
import { makeEnvelope } from '../../contracts/protocol.js';
import { startServer, TestClient, TOKENS, waitFor, sleep, memoryStorage, openChatGPTPage } from '../helpers.js';

const CONV = '6720a1b2-0000-4111-8222-aaaabbbbcccc';
const CONV_URL = `https://chatgpt.com/c/${CONV}`;
let evSeq = 0;

function ev(type, payload, { conv = CONV, tab = 1 } = {}) {
  evSeq++;
  return makeEnvelope('event', {
    event_id: `t:${type.replace(/\W/g, '')}:${Date.now().toString(36)}:${evSeq}`,
    event_type: type, occurred_at: Date.now(), conversation_id: conv, tab_id: tab, payload
  });
}

async function extClient(server, id = 'ext-dash-0001') {
  const c = await new TestClient(server.url).open();
  await c.hello(id, TOKENS.extension, 'extension');
  return c;
}

async function sendAndAck(c, msg) {
  c.send(msg);
  await waitFor(() => c.messages.some((m) => m.type === 'ack' && m.ref_id === msg.event_id), { label: `ack ${msg.event_type}` });
}

const get = (server, path, token, headers = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

test('看板页面：静态文件、安全响应头', async () => {
  const server = await startServer({});
  for (const p of ['/dashboard', '/dashboard/app.js', '/dashboard/protocol.js']) {
    const r = await get(server, p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.match(await (await get(server, '/dashboard')).text(), /AI-Chat-Room/);
  assert.equal((await get(server, '/dashboard/../server/data/config.json')).status, 404);
  await server.stop();
});

test('数据接口：认证、权限、Origin', async () => {
  const server = await startServer({});
  const origin = `http://127.0.0.1:${server.port}`;
  assert.equal((await get(server, '/api/conversations')).status, 401);
  assert.equal((await get(server, '/api/conversations', TOKENS.extension)).status, 403, 'extension token 不能读看板');
  assert.equal((await get(server, '/api/conversations', TOKENS.meta)).status, 403);
  assert.equal((await get(server, '/api/conversations', TOKENS.observer)).status, 200);
  assert.equal((await get(server, '/api/conversations', TOKENS.observer, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get(server, '/api/conversations', TOKENS.observer, { origin: 'http://127.0.0.1:1' })).status, 403, '其他端口的页面不算同源');
  assert.equal((await get(server, '/api/conversations', TOKENS.observer, { origin })).status, 200, '看板同源页面');

  // WebSocket：看板同源 Origin 允许，其他 http Origin 拒绝
  const dash = await new TestClient(server.url, { origin }).open();
  const w = await dash.hello('dashboard-test-01', TOKENS.observer, 'observer');
  assert.equal(w.type, 'welcome');
  assert.ok(w.scopes.includes('control'), 'observer 自动获得 control');
  await assert.rejects(new TestClient(server.url, { origin: 'http://127.0.0.1:1' }).open(), /403/);
  dash.close();
  await server.stop();
});

test('会话实体：来源、标题、模型、消息数、回答中 → 出错 → 页面已关（保留提示）、归档、置顶、收藏', async () => {
  const server = await startServer({});
  const ext = await extClient(server);
  const list = async () => (await (await get(server, '/api/conversations', TOKENS.observer)).json()).conversations;

  await sendAndAck(ext, ev('page.opened', { url: CONV_URL, title: '写一个插件 - ChatGPT' }));
  await sendAndAck(ext, ev('conversation.status', { source: 'chatgpt', status: 'ok', detail: null, model: 'GPT-5' }));
  await sendAndAck(ext, ev('message.added', { message_id: 'u1', role: 'user', index: 0, text: '你好', text_length: 2 }));
  await sendAndAck(ext, ev('message.added', { message_id: 'a1', role: 'assistant', index: 1, text: '你好！', text_length: 3 }));
  await sendAndAck(ext, ev('generation.started', { message_id: 'a1', generation_sequence: 1 }));

  let c = (await list())[0];
  assert.equal(c.conversation_id, CONV);
  assert.equal(c.source, 'chatgpt');
  assert.equal(c.title, '写一个插件 - ChatGPT');
  assert.equal(c.model, 'GPT-5');
  assert.equal(c.status, 'generating');
  assert.equal(c.open_tabs, 1);
  assert.equal(c.user_count, 1);
  assert.equal(c.assistant_count, 1);
  assert.deepEqual(c.last_message, { role: 'assistant', text: '你好！' });

  await sendAndAck(ext, ev('generation.finished', { message_id: 'a1', duration_ms: 4200 }));
  await sendAndAck(ext, ev('conversation.status', { source: 'chatgpt', status: 'error', detail: 'Something went wrong. 18:30', model: 'GPT-5' }));
  c = (await list())[0];
  assert.equal(c.status, 'error');
  assert.equal(c.status_detail, 'Something went wrong. 18:30');
  assert.equal(c.generation_count, 1);
  assert.equal(c.last_duration_ms, 4200);

  await sendAndAck(ext, ev('page.closed', { url: CONV_URL, reason: 'tab_removed' }));
  c = (await list())[0];
  assert.equal(c.status, 'closed');
  assert.equal(c.open_tabs, 0);
  assert.equal(c.page_status, 'error', '页面关掉后仍保留最后的出错状态');
  assert.ok(c.status_detail);

  // 归档 / 置顶
  const origin = `http://127.0.0.1:${server.port}`;
  const post = (path, body) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKENS.observer}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal((await post(`/api/conversations/${CONV}/mark`, { archived: true })).status, 200);
  c = (await list())[0];
  assert.equal(c.archived, true);
  assert.equal(c.pinned, false);
  assert.equal(c.activity_after_archive, false);
  await sleep(5);
  await sendAndAck(ext, ev('page.opened', { url: CONV_URL, title: 't' }, { tab: 2 }));
  c = (await list())[0];
  assert.equal(c.activity_after_archive, true, '归档后有新动态');
  assert.equal(c.status, 'error', '重新打开后显示页面状态');
  assert.equal((await post(`/api/conversations/${CONV}/mark`, { done: false })).status, 200, '旧字段 done 等同归档');
  assert.equal((await list())[0].archived, false);
  assert.equal((await post(`/api/conversations/${CONV}/mark`, { pinned: true })).status, 200);
  c = (await list())[0];
  assert.equal(c.pinned, true);
  assert.equal(c.archived, false, '置顶不影响归档');
  assert.equal((await post(`/api/conversations/${CONV}/mark`, {})).status, 400);

  // 收藏回答
  assert.equal((await post(`/api/conversations/${CONV}/messages/a1/favorite`, { favorite: true })).status, 200);
  assert.equal((await post(`/api/conversations/${CONV}/messages/nope/favorite`, { favorite: true })).status, 404);
  assert.equal((await list())[0].favorite_count, 1);
  const favs = await (await get(server, '/api/favorites', TOKENS.observer)).json();
  assert.deepEqual(favs.favorites.map((f) => [f.conversation_id, f.message_id, f.text]), [[CONV, 'a1', '你好！']]);
  assert.equal((await get(server, '/api/favorites', TOKENS.extension)).status, 403);

  const msgs = await (await get(server, `/api/conversations/${CONV}/messages`, TOKENS.observer)).json();
  assert.deepEqual(msgs.messages.map((m) => [m.message_id, m.text, m.favorite]), [['u1', '你好', false], ['a1', '你好！', true]]);
  assert.equal((await post(`/api/conversations/${CONV}/messages/a1/favorite`, { favorite: false })).status, 200);
  assert.equal((await list())[0].favorite_count, 0);
  const evs = await (await get(server, `/api/conversations/${CONV}/events`, TOKENS.observer)).json();
  assert.ok(evs.events.length >= 8);
  assert.ok(evs.events.every((e) => e.payload.text === undefined), '事件时间线不含正文');

  ext.close();
  await server.stop();
});

// ---------------------------------------------------------------- 指令通道端到端

function fakeChatGPT(conv) {
  return `<!doctype html><html><head><title>测试 - ChatGPT</title></head><body>
  <main id="thread">
    <div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="11111111-0000-4000-8000-000000000001">
      <div data-user-message-bubble="true"><div class="whitespace-pre-wrap">第一个问题</div></div></div>
    <div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant" data-chatgpt-search-message-ids="11111111-0000-4000-8000-000000000002">
      <div data-dil-message-id="11111111-0000-4000-8000-000000000002"><p>第一个回答</p></div>
      <button aria-label="重新生成回复">r</button></div>
  </main>
  <form data-chatgpt-composer="">
    <div contenteditable="true" role="textbox" class="ProseMirror" aria-label="询问 ChatGPT"><p></p></div>
    <button type="button" data-testid="send-button" aria-label="发送提示">send</button>
  </form>
  <div id="menu"></div></body></html>`;
}

/** 给假页面装上“发送”和“重新生成”的行为：发送后追加问答并流式输出；重新生成先弹菜单 */
function wireFakePage(doc, win) {
  const thread = doc.getElementById('thread');
  let n = 1;
  const stream = (p, chunks) => {
    let i = 0;
    const t = win.setInterval(() => {
      p.textContent += chunks[i++];
      if (i >= chunks.length) win.clearInterval(t);
    }, 40);
  };
  doc.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    const editor = doc.querySelector('.ProseMirror');
    const text = editor.textContent.trim();
    if (!text) return;
    editor.innerHTML = '<p></p>';
    n++;
    const uid = `11111111-0000-4000-8000-${String(n * 10).padStart(12, '0')}`;
    const aid = `11111111-0000-4000-8000-${String(n * 10 + 1).padStart(12, '0')}`;
    thread.insertAdjacentHTML('beforeend', `
      <div data-chatgpt-search-unit-key="fallback-turn-${n}:0:user" data-chatgpt-search-message-ids="${uid}">
        <div data-user-message-bubble="true"><div class="whitespace-pre-wrap"></div></div></div>
      <div data-chatgpt-search-unit-key="fallback-turn-${n}:1:assistant" data-chatgpt-search-message-ids="${aid}">
        <div data-dil-message-id="${aid}"><p></p></div><button aria-label="重新生成回复">r</button></div>`);
    thread.querySelector(`[data-chatgpt-search-message-ids="${uid}"] .whitespace-pre-wrap`).textContent = text;
    stream(thread.querySelector(`[data-dil-message-id="${aid}"] p`), ['收', '到', '：', ...text.split('')]);
  });
  thread.addEventListener('click', (e) => {
    if (e.target.getAttribute('aria-label') !== '重新生成回复') return;
    const menu = doc.getElementById('menu');
    menu.innerHTML = '<div role="menuitem">重试</div>';
    menu.firstChild.addEventListener('click', () => {
      menu.innerHTML = '';
      const p = [...doc.querySelectorAll('[data-dil-message-id] p')].at(-1);
      p.textContent = '';
      stream(p, ['新', '的', '回', '答', '。', '。', '。']);
    });
  });
}

test('指令通道：看板 → 后端 → 插件 → 页面（快速回复 / 重新回答 / 忙碌 / 没有标签页）', async () => {
  const server = await startServer({});
  const origin = `http://127.0.0.1:${server.port}`;
  let page = null;
  const bg = createBackground({
    WebSocketImpl: WebSocket,
    storage: memoryStorage(),
    clientId: 'ext-cmd-000001',
    settings: { serverUrl: server.url, token: TOKENS.extension },
    connectionOptions: { backoff: { baseMs: 50, maxMs: 400 }, heartbeatMs: 1000, pongTimeoutMs: 3000 },
    executeCommand: (tabId, command) => page.sendToContent({ kind: 'bridge_command', command })
  });
  await bg.conn.start();
  await waitFor(() => bg.conn.state === 'open', { label: 'ext open' });

  // 先把指令发到一个没有标签页的会话
  const dash = await new TestClient(server.url, { origin }).open();
  await dash.hello('dashboard-cmd-01', TOKENS.observer, 'observer');
  const command = async (action, text, conv = CONV) => {
    const id = `cmd${Math.random().toString(36).slice(2, 12)}`;
    dash.send(makeEnvelope('command', { command_id: id, action, conversation_id: conv, ...(text ? { text } : {}) }));
    return waitFor(() => dash.messages.find((m) => m.type === 'command_result' && m.command_id === id), { label: `result ${action}`, timeout: 12000 });
  };
  assert.equal((await command('regenerate', null, 'no-such-conversation')).code, 'no_open_tab');

  page = openChatGPTPage({ url: CONV_URL, tabId: 9, background: bg, html: fakeChatGPT(CONV) });
  wireFakePage(page.doc, page.win);
  await waitFor(() => bg.conn.stats.acked >= 3 && bg.conn.queue.length === 0, { label: 'initial events acked' });

  // 快速回复
  const r1 = await command('reply', '帮我总结一下');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const userBubbles = [...page.doc.querySelectorAll('[data-user-message-bubble] .whitespace-pre-wrap')].map((e) => e.textContent);
  assert.deepEqual(userBubbles, ['第一个问题', '帮我总结一下']);

  // 生成中再发：忙碌
  const r2 = await command('reply', '再来一条');
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'busy');

  // 等这次回答结束，后端能看到新消息
  await waitFor(async () => {
    const list = (await (await get(server, '/api/conversations', TOKENS.observer)).json()).conversations;
    return list[0]?.status === 'idle' && list[0].assistant_count === 2 ? list[0] : null;
  }, { label: 'answer stored', timeout: 8000 });

  // 重新回答（先弹菜单再点“重试”）
  const r3 = await command('regenerate');
  assert.equal(r3.ok, true, JSON.stringify(r3));
  await waitFor(() => [...page.doc.querySelectorAll('[data-dil-message-id] p')].at(-1).textContent === '新的回答。。。', { label: 'regenerated', timeout: 5000 });

  // 指定某条回答重新生成：页面回答数和看板对不上 → 明确报错，不乱点
  const cmdAt = async (index, total) => {
    const id = `cmd${Math.random().toString(36).slice(2, 12)}`;
    dash.send(makeEnvelope('command', { command_id: id, action: 'regenerate', conversation_id: CONV, answer_index: index, answer_total: total }));
    return waitFor(() => dash.messages.find((m) => m.type === 'command_result' && m.command_id === id), { label: 'result regen at', timeout: 12000 });
  };
  await waitFor(async () => {
    const list = (await (await get(server, '/api/conversations', TOKENS.observer)).json()).conversations;
    return list[0]?.status === 'idle';
  }, { label: 'regenerate finished', timeout: 8000 });
  await sleep(300);
  const r4 = await cmdAt(0, 5);
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'regenerate_target_not_found');
  // 页面上 2 条回答各有一个按钮，对得上 → 点第一条的
  const firstBtn = page.doc.querySelectorAll('button[aria-label="重新生成回复"]')[0];
  let firstClicked = false;
  firstBtn.addEventListener('click', () => { firstClicked = true; });
  const r5 = await cmdAt(0, 2);
  assert.equal(r5.ok, true, JSON.stringify(r5));
  assert.ok(firstClicked, '点的是第一条回答的“重新生成”');

  // 无 control 权限的客户端不能下发
  const meta = await new TestClient(server.url).open();
  await meta.hello('meta-client-0001', TOKENS.meta, 'observer');
  meta.send(makeEnvelope('command', { command_id: 'cmdmeta0001', action: 'regenerate', conversation_id: CONV }));
  const err = await waitFor(() => meta.messages.find((m) => m.type === 'error'), { label: 'forbidden' });
  assert.equal(err.code, 'FORBIDDEN');

  // 扩展不能伪造别人的结果
  const fake = await extClient(server, 'ext-fake-00001');
  fake.send(makeEnvelope('command_result', { command_id: 'cmdmeta0001', ok: true, detail: null }));
  await sleep(100);
  assert.ok(!meta.messages.some((m) => m.type === 'command_result'));

  assert.ok(server.stats().counters.commands_ok >= 2);
  for (const c of [dash, meta, fake]) c.close();
  await bg.conn.stop?.();
  page.close();
  await server.stop();
});

test('观察器：不再判断限额；长对话只渲染部分消息时，序号保持稳定，新回答排在最后', async () => {
  class NoopWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const bg = createBackground({ WebSocketImpl: NoopWS, storage: null, clientId: 'ext-status-0001', settings: { serverUrl: 'ws://127.0.0.1:1', token: 'x' } });
  const results = [];
  const orig = bg.handleRuntimeMessage;
  bg.handleRuntimeMessage = (m, s) => { const r = orig(m, s); results.push({ m, r }); return r; };
  const page = openChatGPTPage({ url: CONV_URL, tabId: 3, background: bg, html: fakeChatGPT(CONV) });
  const statuses = () => results.filter((x) => x.m.event.event_type === 'conversation.status').map((x) => x.m.event.payload);
  const added = () => results.filter((x) => x.m.event.event_type === 'message.added').map((x) => x.m.event.payload);
  await waitFor(() => statuses().length >= 1 && added().length >= 1, { label: 'initial' });
  assert.deepEqual(statuses()[0], { source: 'chatgpt', status: 'ok', detail: null, model: null });

  const banner = page.doc.createElement('div');
  banner.setAttribute('role', 'alert');
  banner.textContent = "You've reached your GPT-5 limit. Your limit resets at 6:30 PM.";
  page.doc.body.appendChild(banner);
  await sleep(1300);
  assert.ok(statuses().every((x) => x.status !== 'limit_reached'), '限额提示不再上报');

  // 模拟长对话：前面的消息被移出 DOM，再追加一条新回答
  const first = [...page.doc.querySelectorAll('[data-chatgpt-search-unit-key]')];
  const before = Object.fromEntries(added().map((p) => [p.message_id, p.index]));
  const maxBefore = Math.max(...Object.values(before));
  const host = first[0].parentElement;
  for (const el of first.slice(0, -1)) el.remove();
  const n = page.doc.createElement('div');
  n.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-9:9:assistant');
  n.setAttribute('data-chatgpt-search-message-ids', 'virt-new-1');
  n.innerHTML = '<div data-dil-message-id="virt-new-1"><p>新的回答</p></div>';
  host.appendChild(n);
  await waitFor(() => added().some((p) => p.message_id === 'virt-new-1'), { label: 'new msg', timeout: 4000 });
  const np = added().find((p) => p.message_id === 'virt-new-1');
  assert.ok(np.index > maxBefore, `新回答序号 ${np.index} 应大于已有的 ${maxBefore}`);
  assert.ok(results.every((x) => x.r.ok), JSON.stringify(results.filter((x) => !x.r.ok).map((x) => x.r)));
  page.close();
});

test('页面真实状态对账：插件上报 tabs.snapshot，后端补 page.closed / page.opened，列表实时变化', async () => {
  const server = await startServer({});
  const ext = await extClient(server, 'ext-sync-0001');
  const list = async () => (await (await get(server, '/api/conversations', TOKENS.observer)).json()).conversations;
  const snap = (tabs) => makeEnvelope('event', {
    event_id: `t:snap:${Date.now().toString(36)}:${++evSeq}`, event_type: 'tabs.snapshot', occurred_at: Date.now(),
    conversation_id: null, tab_id: null, payload: { tabs }
  });
  await sendAndAck(ext, ev('page.opened', { url: CONV_URL, title: '对账' }));
  assert.equal((await list())[0].open_tabs, 1);
  // 标签页 1 在浏览器里已经没有了（关闭事件丢失）→ 补 page.closed
  await sendAndAck(ext, snap([{ tab_id: 7, host: 'example.com', conversation_id: null }]));
  let c = (await list()).find((x) => x.conversation_id === CONV);
  assert.equal(c.open_tabs, 0);
  assert.equal(c.status, 'closed');
  // PWA 窗口里的标签页 9 开着这个会话，但后端不知道 → 补 page.opened
  await sendAndAck(ext, snap([{ tab_id: 9, host: 'chatgpt.com', conversation_id: CONV, url: CONV_URL, title: '对账' }]));
  c = (await list()).find((x) => x.conversation_id === CONV);
  assert.equal(c.open_tabs, 1);
  // 首页（还没进入会话）的标签页会话：开着时有卡片，标签页关掉后从列表消失
  await sendAndAck(ext, ev('page.opened', { url: 'https://chatgpt.com/', title: 'ChatGPT' }, { conv: 'tab-sync0001-11', tab: 11 }));
  assert.ok((await list()).find((x) => x.conversation_id === 'tab-sync0001-11')?.pending);
  await sendAndAck(ext, ev('page.closed', { url: 'https://chatgpt.com/', reason: 'navigated' }, { conv: 'tab-sync0001-11', tab: 11 }));
  assert.ok(!(await list()).find((x) => x.conversation_id === 'tab-sync0001-11'));
  // 同样的快照再来一次不重复补
  await sendAndAck(ext, snap([{ tab_id: 9, host: 'chatgpt.com', conversation_id: CONV, url: CONV_URL, title: '对账' }]));
  const evs = (await (await get(server, `/api/conversations/${CONV}/events?limit=50`, TOKENS.observer)).json()).events;
  assert.equal(evs.filter((e) => e.event_type === 'page.opened').length, 2);
  assert.equal(evs.filter((e) => e.event_type === 'page.closed' && e.payload.reason === 'reconciled').length, 1);
  ext.close();
  await server.stop();
});

test('源站删除会话：页面没有消息且显示“找不到对话”→ 上报 deleted；后端列表不再包含该会话，看板移除卡片', async () => {
  class NoopWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const bg = createBackground({ WebSocketImpl: NoopWS, storage: null, clientId: 'ext-del-00001', settings: { serverUrl: 'ws://127.0.0.1:1', token: 'x' } });
  const results = [];
  const orig = bg.handleRuntimeMessage;
  bg.handleRuntimeMessage = (m, s) => { const r = orig(m, s); results.push({ m, r }); return r; };
  const page = openChatGPTPage({ url: CONV_URL, tabId: 4, background: bg, html: fakeChatGPT(CONV) });
  const statuses = () => results.filter((x) => x.m.event.event_type === 'conversation.status').map((x) => x.m.event.payload);
  await waitFor(() => statuses().length >= 1, { label: 'initial status' });
  // 有消息时，即使出现这句话也不判定为删除
  const note = page.doc.createElement('div');
  note.textContent = 'Unable to load conversation';
  page.doc.body.appendChild(note);
  await sleep(1300);
  assert.notEqual(statuses().at(-1).status, 'deleted');
  for (const m of page.doc.querySelectorAll('[data-chatgpt-search-unit-key], [data-message-author-role], [data-dil-message-id], article')) m.remove();
  await waitFor(() => statuses().at(-1).status === 'deleted', { label: 'deleted', timeout: 4000 });
  assert.match(statuses().at(-1).detail, /Unable to load conversation/);
  page.close();

  // 后台对账：内存里记着的标签页在浏览器里已经没有 → 补 page.closed；内容脚本不能伪造 tabs.snapshot
  bg.handleRuntimeMessage({ kind: 'page_event', event: { event_id: 'pageopen-x1', event_type: 'page.opened', occurred_at: Date.now(), conversation_id: CONV, payload: { url: CONV_URL, title: 't' } } }, { tab: { id: 42 } });
  assert.ok(bg.tabs.has(42));
  assert.equal(bg.syncTabs([{ tab_id: 1, host: 'example.com', conversation_id: null }]), 'offline');
  assert.ok(!bg.tabs.has(42));
  // 开着网站但还没进入会话：用标签页会话 ID，看板也会建卡片
  bg.handleRuntimeMessage({ kind: 'page_event', event: { event_id: 'pageopen-x2', event_type: 'page.opened', occurred_at: Date.now(), conversation_id: null, payload: { url: 'https://chatgpt.com/', title: 'ChatGPT' } } }, { tab: { id: 50 } });
  assert.match(bg.tabs.get(50).conversation_id, /^tab-[A-Za-z0-9_-]+-50$/);
  assert.equal(bg.handleRuntimeMessage({ kind: 'page_event', event: { event_id: 'snapshot-x1', event_type: 'tabs.snapshot', occurred_at: Date.now(), conversation_id: null, payload: { tabs: [] } } }, { tab: { id: 1 } }).ok, false);

  // 后端：deleted 之后列表里没有它；再上报 ok（误判）会恢复
  const server = await startServer();
  const ext = await extClient(server, 'ext-del-00002');
  await sendAndAck(ext, ev('page.opened', { url: CONV_URL, title: '要删除的会话' }));
  const list = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/conversations`, { headers: { authorization: `Bearer ${TOKENS.observer}` } })).json()).conversations.map((c) => c.conversation_id);
  assert.ok((await list()).includes(CONV));
  await sendAndAck(ext, ev('conversation.status', { source: 'chatgpt', status: 'deleted', detail: 'Unable to load conversation', model: null }));
  assert.ok(!(await list()).includes(CONV), '不再跟踪');
  await sendAndAck(ext, ev('conversation.status', { source: 'chatgpt', status: 'ok', detail: null, model: null }));
  assert.ok((await list()).includes(CONV), '再次正常上报后恢复');
  ext.close();
  await server.stop();
});

test('看板前端：在 jsdom 中加载，连接、渲染卡片、主题、设置、实时更新、点卡片开详情、置顶 / 归档、每条回答操作、快速回复候选、通知等级', async () => {
  const { JSDOM } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('../helpers.js');
  const proto = await import('../../contracts/protocol.js');

  const server = await startServer({ commandTimeoutMs: 1500 });
  const origin = `http://127.0.0.1:${server.port}`;
  const ext = await extClient(server, 'ext-ui-000001');
  await sendAndAck(ext, ev('page.opened', { url: CONV_URL, title: '界面测试：一个非常非常长的标题用来确认卡片标题只占一行不会换行 - ChatGPT' }));
  await sendAndAck(ext, ev('conversation.status', { source: 'chatgpt', status: 'ok', detail: null, model: null }));
  await sendAndAck(ext, ev('message.added', { message_id: 'u1', role: 'user', index: 0, text: '问题一', text_length: 3 }));
  await sendAndAck(ext, ev('message.added', { message_id: 'a1', role: 'assistant', index: 1, text: '回答一', text_length: 3 }));

  const html = readFileSync(join(ROOT, 'src/backend/dashboard/index.html'), 'utf8').replace(/<script type="module"[^>]*><\/script>/, '');
  assert.match(html, /\.card \.title \{[^}]*white-space: nowrap/, '卡片标题不换行');
  assert.match(html, /\.card \.actions \{ margin-top: auto/, '卡片按钮固定在底部');
  assert.match(html, /\.card\.s-idle \{ background: color-mix\(in srgb, var\(--src\)/, '空闲卡片背景取头像颜色');
  assert.ok(html.indexOf('id="quickText"') < html.indexOf('id="quickCands"'), '常见回答在输入框下方');
  const dom = new JSDOM(html, { url: `${origin}/dashboard`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const copied = [];
  const sockets = [];
  const sounds = [];
  win.__proto = proto;
  win.fetch = (path, opts = {}) => fetch(new URL(path, origin), { ...opts, headers: { ...(opts.headers || {}), origin } });
  win.WebSocket = class {
    constructor(url) {
      const ws = new WebSocket(url, { headers: { Origin: origin } });
      sockets.push(ws);
      ws.on('open', () => this.onopen?.());
      ws.on('message', (d) => this.onmessage?.({ data: d.toString() }));
      ws.on('close', (code, reason) => this.onclose?.({ code, reason: reason.toString() }));
      this.ws = ws;
    }
    get readyState() { return this.ws.readyState; }
    send(d) { this.ws.send(d); }
    close() { this.ws.close(); }
  };
  // 假的 Web Audio：记录每个音符（普通提示音 2 个音符，置顶提示音 3 个）
  win.AudioContext = class {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createOscillator() { return { frequency: {}, type: '', connect: (g) => g, start: () => sounds.push(1), stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (d) => d }; }
  };
  win.CSS = { escape: (s) => String(s).replace(/"/g, '\\"') };
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (t) => { copied.push(t); } } });
  const opened = [];
  win.open = (url) => { opened.push(url); return null; };
  const appSrc = readFileSync(join(ROOT, 'src/backend/dashboard/app.js'), 'utf8')
    .replace(/^import \{([^}]+)\} from '\.\/protocol\.js';/m, 'const {$1} = window.__proto;');
  const errors = [];
  win.addEventListener('error', (e) => errors.push(e.error || e.message));
  win.__probePollMs = 30;
  win.confirm = () => true;
  win.eval(`(async () => { ${appSrc} })().catch((e) => { window.__appError = e; });`);

  const d = win.document;
  const cardSel = `.card[data-conv="${CONV}"]`;
  d.getElementById('token').value = TOKENS.observer;
  d.getElementById('connect').click();
  await waitFor(() => /^已连接 · 1 个页面$/.test(d.getElementById('connText').textContent), { label: 'connected' });
  const cardEl = await waitFor(() => d.querySelector(cardSel), { label: 'card' });
  assert.match(cardEl.querySelector('.title').textContent, /^界面测试：/);
  assert.equal(cardEl.querySelector('.badge').textContent, '空闲');
  assert.ok(cardEl.classList.contains('src-chatgpt'), '卡片带来源类名（空闲时背景取头像颜色）');
  assert.ok(cardEl.querySelector('.side .badge + .time'), '时间在状态下方');
  assert.ok(!cardEl.querySelector('.sub .time'));
  assert.equal(d.title, 'AI-Chat-Room');
  assert.match(cardEl.querySelector('.sub').textContent, /ChatGPT/);
  // 筛选栏三块：状态（没有“全部”，再点一次取消）｜来源｜收藏、归档
  const chipTexts = () => [...d.querySelectorAll('#chips .chip')].map((b) => b.textContent);
  assert.ok(!chipTexts().some((t) => /^全部\d/.test(t)), `chips: ${chipTexts()}`);
  assert.ok(chipTexts().includes('空闲1'));
  assert.ok(!d.querySelector('#chips .cg.end'), '收藏 / 归档不在筛选栏');
  assert.ok(!chipTexts().some((t) => /已到限额|有收藏|已归档/.test(t)), `chips: ${chipTexts()}`);
  assert.ok(chipTexts().includes('页面已关0'));
  assert.ok(!d.querySelector(`${cardSel} .actions`).textContent.includes('重新回答'), '卡片没有重新回答');
  const idleChip = () => [...d.querySelectorAll('#chips .chip')].find((b) => /^空闲/.test(b.textContent));
  idleChip().click();
  assert.ok(idleChip().classList.contains('on'));
  idleChip().click();
  assert.ok(!idleChip().classList.contains('on'), '再点一次取消筛选');
  // 搜索：平时只有图标，点击展开
  assert.ok(!d.getElementById('searchBox').classList.contains('open'));
  d.getElementById('searchBtn').click();
  assert.ok(d.getElementById('searchBox').classList.contains('open'));
  d.getElementById('search').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!d.getElementById('searchBox').classList.contains('open'));
  assert.equal(d.getElementById('sitesBtn').textContent.trim(), '', '网站按钮只显示地球图标');
  const cardButtons = () => [...d.querySelectorAll(`${cardSel} button`)].map((b) => b.textContent);
  assert.ok(!cardButtons().some((t) => /快速回复|详情|复制回答|标记完成/.test(t)), `卡片按钮：${cardButtons()}`);
  assert.ok(cardButtons().includes('置顶'));
  assert.ok(!d.getElementById('detailCopy'), '详情头部不再有单独的“复制最后回答”');

  // 主题切换 + 设置弹窗（含常见回答管理）
  d.getElementById('themeBtn').click();
  assert.ok(['light', 'dark'].includes(d.documentElement.getAttribute('data-theme')));
  while (JSON.parse(win.localStorage.getItem('bridgeDashboard.theme')) !== 'dark') d.getElementById('themeBtn').click();   // 设置里不再有“外观”，只用顶栏按钮切换
  assert.equal(d.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(JSON.parse(win.localStorage.getItem('bridgeDashboard.theme')), 'dark');
  d.getElementById('settingsBtn').click();
  assert.ok(d.getElementById('settingsScrim').classList.contains('open'));
  await waitFor(() => /在线客户端/.test(d.getElementById('serverInfo').textContent), { label: 'server info' });
  const qrValues = () => [...d.querySelectorAll('#qrList input')].map((i) => i.value);
  assert.equal(qrValues()[0], '继续');
  d.getElementById('qrNew').value = '帮我写单元测试';
  d.getElementById('qrAdd').click();
  assert.equal(qrValues().at(-1), '帮我写单元测试');
  [...d.querySelectorAll('#qrList .qr-item')].at(-1).querySelector('[title="上移"]').click();
  assert.equal(qrValues().at(-2), '帮我写单元测试');
  d.querySelector('#qrList .qr-item [title="删除"]').click();   // 删掉“继续”
  assert.ok(!qrValues().includes('继续'));
  assert.ok(JSON.parse(win.localStorage.getItem('bridgeDashboard.quickReplies')).includes('帮我写单元测试'));
  // 通知等级：音效 / 置顶弹窗默认开启，且不依赖系统通知权限
  assert.equal(d.querySelector('[data-notify="sound"]').getAttribute('aria-checked'), 'true');
  assert.equal(d.querySelector('[data-notify="pinned_popup"]').getAttribute('aria-checked'), 'true');
  assert.equal(d.querySelector('[data-notify="sound"]').disabled, false);
  d.getElementById('settingsClose').click();

  // 点卡片：打开详情，不跳转
  cardEl.click();
  assert.equal(opened.length, 0, '点卡片不跳转页面');
  assert.ok(d.getElementById('detailScrim').classList.contains('open'));
  await waitFor(() => d.querySelectorAll('#detailMsgs .msg').length === 2, { label: 'detail' });
  const mact = (act) => d.querySelector(`#detailMsgs .msg.assistant [data-act="${act}"]`);
  assert.ok(!d.querySelector('#detailMsgs .msg.user .mact'), '提问上没有回答操作');
  // 复制
  mact('copy').click();
  await waitFor(() => copied.length === 1, { label: 'copied' });
  assert.equal(copied[0], '回答一');
  // 收藏
  mact('favorite').click();
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant.fav'), { label: 'favorited' });
  await waitFor(() => /1 条收藏/.test(d.querySelector(cardSel)?.textContent || ''), { label: 'favorite tag' });
  // 折叠 / 展开
  mact('fold').click();
  assert.ok(d.querySelector('#detailMsgs .msg.assistant').classList.contains('collapsed'));
  assert.equal(d.querySelector('#detailMsgs .msg.assistant .fold').textContent, '回答一');
  mact('fold').click();
  assert.ok(!d.querySelector('#detailMsgs .msg.assistant').classList.contains('collapsed'));
  // 重新回答（测试“插件”不执行 → 超时失败提示）
  assert.equal(mact('regenerate').disabled, false);
  // 流式更新 + 折叠状态保持
  mact('fold').click();
  await sendAndAck(ext, ev('message.updated', { message_id: 'a1', role: 'assistant', index: 1, text: '回答一（更新）', text_length: 7 }));
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant')?.textContent.includes('回答一（更新）'), { label: 'stream update' });
  assert.ok(d.querySelector('#detailMsgs .msg.assistant').classList.contains('collapsed'), '更新后保持折叠');
  assert.ok(d.querySelector('#detailMsgs .msg.assistant').classList.contains('fav'), '更新后保持收藏');
  mact('fold').click();
  await sendAndAck(ext, ev('message.updated', { message_id: 'a1', role: 'assistant', index: 1, text: '代码：\n\n```js\nconst a = 1;\n```\n\n用 `a` 即可', text_length: 30 }));
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant pre code')?.textContent === 'const a = 1;', { label: 'code block' });
  assert.equal(d.querySelector('#detailMsgs .msg.assistant code.inl').textContent, 'a');
  // 图片、下载链接按原样式显示；非 http(s) 的不渲染成元素
  await sendAndAck(ext, ev('message.updated', { message_id: 'a1', role: 'assistant', index: 1, text: '图：\n\n![结果](https://files.example.com/a.png)\n\n下载 [report.pdf](https://files.example.com/r.pdf "download") 和 [x](javascript:alert(1) "download")', text_length: 40 }));
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant img.rich'), { label: 'image' });
  assert.equal(d.querySelector('#detailMsgs .msg.assistant img.rich').getAttribute('src'), 'https://files.example.com/a.png');
  const dl = d.querySelectorAll('#detailMsgs .msg.assistant a.dl');
  assert.equal(dl.length, 1);
  assert.equal(dl[0].getAttribute('href'), 'https://files.example.com/r.pdf');
  assert.equal(dl[0].textContent, 'report.pdf');
  assert.equal(dl[0].getAttribute('rel'), 'noopener noreferrer');

  // 超长回答：正文高于弹窗 2/3 时自动折叠，保留首尾（各 1/4 弹窗高度），可展开 / 收起
  const origRect = win.HTMLElement.prototype.getBoundingClientRect;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const h = this.classList.contains('dialog') ? 600
      : this.classList.contains('body') && this.textContent.length > 500 ? 1200 : 40;
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: h, width: 100, height: h };
  };
  const longText = '开头第一段\n\n' + '中间内容。'.repeat(200) + '\n\n结尾最后一段';
  await sendAndAck(ext, ev('message.added', { message_id: 'a-long', role: 'assistant', index: 5, text: longText, text_length: longText.length }));
  const longSel = '#detailMsgs .msg[data-mid="a-long"]';
  await waitFor(() => d.querySelector(`${longSel} .longfold`), { label: 'long folded' });
  assert.equal(d.querySelector(`${longSel} .lhead`).style.height, '150px');
  assert.equal(d.querySelector(`${longSel} .ltail`).style.height, '150px');
  assert.match(d.querySelector(`${longSel} .lhead`).textContent, /开头第一段/);
  assert.match(d.querySelector(`${longSel} .ltail`).textContent, /结尾最后一段/);
  assert.ok(!d.querySelector('#detailMsgs .msg[data-mid="a1"] .longfold'), '短回答不折叠');
  d.querySelector(`${longSel} .longbtn`).click();
  assert.ok(!d.querySelector(`${longSel} .longfold`));
  assert.equal(d.querySelector(`${longSel} .longbtn`).textContent, '收起');
  d.querySelector(`${longSel} .longbtn`).click();
  assert.ok(d.querySelector(`${longSel} .longfold`));
  win.HTMLElement.prototype.getBoundingClientRect = origRect;

  // 详情右上角：快速回复 + 常见回答候选
  // 点卡片打开详情时快速回复已经展开；右上角是置顶按钮
  assert.ok(d.getElementById('composer').classList.contains('open'));
  assert.equal(d.getElementById('detailQuick'), null);
  assert.equal(d.getElementById('detailPin').getAttribute('aria-pressed'), 'false');
  d.getElementById('quickText').focus();
  d.getElementById('quickText').dispatchEvent(new win.Event('focus'));
  const ta = d.getElementById('quickText');
  await waitFor(() => d.getElementById('quickCands').classList.contains('open'), { label: 'cands open' });
  ta.value = '单元';
  ta.dispatchEvent(new win.Event('input'));
  const cands = [...d.querySelectorAll('#quickCands .cand')].map((b) => b.textContent);
  assert.deepEqual(cands, ['帮我写单元测试'], '按输入过滤常见回答');
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  const repliesBefore = ext.of('command').filter((x) => x.action === 'reply').length;
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // 选中常见回答 + Enter：直接发送，并关闭弹窗
  assert.ok(!d.getElementById('detailScrim').classList.contains('open'), '发送后关闭弹窗');
  await waitFor(() => ext.of('command').filter((x) => x.action === 'reply' && x.text === '帮我写单元测试').length > 0 && ext.of('command').filter((x) => x.action === 'reply').length > repliesBefore, { label: 'detail reply command', timeout: 6000 });
  await waitFor(() => /快速回复失败/.test(d.getElementById('snackbars').textContent), { label: 'reply toast', timeout: 6000 });

  // 再次进入弹窗：输入框是空的；普通文字按 Enter 发送（Shift+Enter 不发送）
  d.querySelector(cardSel).click();
  await waitFor(() => d.getElementById('detailScrim').classList.contains('open'), { label: 'detail reopen' });
  assert.equal(ta.value, '', '每次进入弹窗清空输入框');
  ta.value = '手动输入';
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  assert.ok(d.getElementById('detailScrim').classList.contains('open'), 'Shift+Enter 不发送');
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.ok(!d.getElementById('detailScrim').classList.contains('open'));
  await waitFor(() => ext.of('command').some((x) => x.action === 'reply' && x.text === '手动输入'), { label: 'enter reply', timeout: 6000 });
  d.querySelector(cardSel).click();
  await waitFor(() => d.getElementById('detailScrim').classList.contains('open'), { label: 'detail reopen 2' });

  // 详情里跳转：有标签页 → focus；测试“插件”不执行 → 超时 → 新开页面
  d.getElementById('detailJump').click();
  await waitFor(() => opened.length === 1, { label: 'fallback open', timeout: 6000 });
  assert.equal(opened[0], CONV_URL);
  d.getElementById('detailClose').click();
  assert.ok(!d.getElementById('detailScrim').classList.contains('open'));

  // 有收藏的会话：点开后滚动到收藏的回答（高亮一下）
  d.querySelector(cardSel).click();
  await waitFor(() => d.querySelector('#detailMsgs .msg.fav.flash'), { label: 'scroll to favorite' });
  d.getElementById('detailClose').click();

  // 卡片上的“回复”：向下弹出快速回复栏
  const replyBtn = () => d.querySelector(`${cardSel} [data-act="reply"]`);
  replyBtn().click();
  const panel = await waitFor(() => d.querySelector(`${cardSel} .creply`), { label: 'card reply' });
  assert.ok(!d.getElementById('detailScrim').classList.contains('open'), '不会打开详情');
  assert.ok([...panel.querySelectorAll('.qr button')].some((b) => b.textContent === '帮我写单元测试'));
  assert.ok(![...panel.querySelectorAll('button')].some((b) => b.textContent === '收起'), '没有收起按钮');
  const cardBefore = ext.of('command').filter((x) => x.action === 'reply').length;
  [...panel.querySelectorAll('.qr button')].find((b) => b.textContent === '帮我写单元测试').click();
  // 点常见回答直接发送，并自动收起
  await waitFor(() => !d.querySelector(`${cardSel} .creply`), { label: 'card reply closed' });
  await waitFor(() => ext.of('command').filter((x) => x.action === 'reply').length > cardBefore, { label: 'card quick command', timeout: 6000 });
  // 再展开：输入框为空；Enter 发送后收起
  replyBtn().click();
  const panel2 = await waitFor(() => d.querySelector(`${cardSel} .creply`), { label: 'card reply 2' });
  const cta = panel2.querySelector('textarea');
  assert.equal(cta.value, '');
  cta.value = '卡片里输入';
  cta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor(() => !d.querySelector(`${cardSel} .creply`), { label: 'card reply closed 2' });
  await waitFor(() => ext.of('command').some((x) => x.action === 'reply' && x.text === '卡片里输入'), { label: 'card enter command', timeout: 6000 });

  // 通知等级：普通会话回答完成 → 音效，不弹窗
  await sendAndAck(ext, ev('generation.started', { message_id: 'a1', generation_sequence: 1 }));
  await sendAndAck(ext, ev('generation.finished', { message_id: 'a1', duration_ms: 1200 }));
  await waitFor(() => sounds.length === 2, { label: 'sound' });
  assert.ok(!d.getElementById('alertScrim').classList.contains('open'));

  // 置顶：卡片排到前面，回答完成直接弹窗
  const btn = (label) => [...d.querySelectorAll(`${cardSel} .actions button`)].find((b) => b.textContent === label);
  btn('置顶').click();
  await waitFor(() => d.querySelector(cardSel)?.classList.contains('pinned'), { label: 'pinned' });
  assert.ok(btn('已置顶'), '置顶后按钮显示“已置顶”');
  const pinBtn = d.querySelector(`${cardSel} [data-act="pin"]`);
  assert.equal(pinBtn.getAttribute('aria-pressed'), 'true');
  assert.ok(pinBtn.classList.contains('filled'), '置顶按钮用强调色背景');
  assert.ok(!d.querySelector('#settingsScrim [data-theme-opt]'), '设置里没有“外观”');
  // 复制：复制最后一个回答
  btn('复制').click();
  await waitFor(() => copied.at(-1) === longText, { label: 'copy last answer' });
  assert.ok(!d.querySelector('[data-notify="limit_reached"]') && !d.querySelector('[data-notify="error"]') && !d.querySelector('[data-notify="background_only"]'), '设置里没有限额 / 出错系统通知');
  assert.match(d.getElementById('chips').textContent, /置顶1/);
  await sendAndAck(ext, ev('generation.started', { message_id: 'a1', generation_sequence: 2 }));
  await sendAndAck(ext, ev('generation.finished', { message_id: 'a1', duration_ms: 2300 }));
  await waitFor(() => d.getElementById('alertScrim').classList.contains('open'), { label: 'popup' });
  assert.equal(sounds.length, 5, '置顶回答完成也播放（更强的）提示音');
  assert.match(d.getElementById('alertBody').textContent, /界面测试/);
  d.getElementById('alertOpen').click();
  assert.ok(!d.getElementById('alertScrim').classList.contains('open'));
  assert.ok(d.getElementById('detailScrim').classList.contains('open'), '弹窗“查看”打开详情');
  d.getElementById('detailClose').click();

  // 已删除限额判断：旧插件上报 limit_reached 也不显示“已到限额”
  await sendAndAck(ext, ev('conversation.status', { source: 'chatgpt', status: 'limit_reached', detail: '已达到使用上限', model: null }));
  await sleep(300);
  assert.notEqual(d.querySelector(`${cardSel} .badge`)?.textContent, '已到限额');
  assert.ok(!d.querySelector(`${cardSel} .notice`), '卡片不再显示限额提示文字');
  assert.ok(![...d.querySelectorAll(`${cardSel} .tag`)].some((t) => /标签页/.test(t.textContent)), '卡片不显示标签页数量');
  assert.deepEqual([...d.querySelectorAll(`${cardSel} .actions > button`)].map((b) => b.textContent), ['已置顶', '复制', '关闭', '回复']);

  // 双向绑定：插件报告浏览器窗口正显示这个会话 → 卡片高亮
  await sendAndAck(ext, makeEnvelope('event', { event_id: `t:snap:${Date.now().toString(36)}:${++evSeq}`, event_type: 'tabs.snapshot', occurred_at: Date.now(), conversation_id: null, tab_id: null,
    payload: { tabs: [{ tab_id: 1, host: 'chatgpt.com', conversation_id: CONV, url: CONV_URL, title: 't', active: true }] } }));
  await waitFor(() => d.querySelector(cardSel)?.classList.contains('active-page'), { label: 'active page highlight' });

  // 收藏图标：只看有收藏的会话，再点返回
  d.getElementById('favBtn').click();
  assert.equal(d.getElementById('favBtn').getAttribute('aria-pressed'), 'true');
  assert.ok(d.querySelector(cardSel), '收藏视图里有这个会话');
  d.getElementById('favBtn').click();
  assert.equal(d.getElementById('favBtn').getAttribute('aria-pressed'), 'false');

  // 一键启动：插件收到 open_sites（后台打开所有网站）
  d.getElementById('launchBtn').click();
  const launch = await waitFor(() => ext.of('command').find((m) => m.action === 'open_sites'), { label: 'launch' });
  assert.deepEqual(launch.text.split('\n'), ['https://chatgpt.com/', 'https://duck.ai/', 'https://www.hark.com/chat']);

  // 关闭页面：插件收到 close；页面关闭后只在“页面已关”里显示，点击重新打开并跳转
  await waitFor(() => btn('关闭') && !btn('关闭').disabled, { label: 'close enabled', timeout: 8000 });
  btn('关闭').click();
  const closeCmd = await waitFor(() => ext.of('command').find((m) => m.action === 'close'), { label: 'close cmd' });
  assert.equal(closeCmd.conversation_id, CONV);
  assert.deepEqual(closeCmd.tab_ids, [1], '带上该插件里开着这个会话的所有标签页');
  assert.equal(closeCmd.url, CONV_URL, '带上会话地址，用来找 PWA 窗口里的标签页');
  ext.send(makeEnvelope('command_result', { command_id: closeCmd.command_id, ok: true, detail: '已关闭 1 个标签页' }));
  await sendAndAck(ext, ev('page.closed', { url: CONV_URL, reason: 'tab_removed' }));
  await waitFor(() => !d.querySelector(cardSel), { label: 'closed hidden' });
  await waitFor(() => /已连接 · 0 个页面/.test(d.getElementById('connText').textContent), { label: 'conn count 0' });
  [...d.querySelectorAll('#chips .chip')].find((b) => /^页面已关/.test(b.textContent)).click();
  await waitFor(() => d.querySelector(`${cardSel}.s-closed`), { label: 'in closed view' });
  const before = opened.length;
  d.querySelector(cardSel).click();
  assert.equal(opened.length, before + 1);
  assert.equal(opened.at(-1), CONV_URL);
  assert.ok(!d.getElementById('detailScrim').classList.contains('open'), '已关闭的不打开详情');

  // 网站下拉：没有“内置”，每个网站都可编辑 / 删除；末尾“添加网站”
  assert.equal(d.getElementById('sort'), null);
  d.getElementById('sitesBtn').click();
  await waitFor(() => d.querySelectorAll('#sitesMenu .mi').length === 4, { label: 'sites menu' });
  assert.deepEqual([...d.querySelectorAll('#sitesMenu .mi')].map((n) => n.dataset.site), ['chatgpt', 'duckai', 'hark', '+']);
  assert.equal(d.querySelectorAll('#sitesMenu .mi .ed').length, 3);
  assert.equal(d.querySelectorAll('#sitesMenu .mi .del').length, 3);
  d.querySelector('#sitesMenu [data-site="duckai"] .ed').click();
  const edit = d.querySelector('#sitesMenu .mi.editing');
  const [nameIn, urlIn] = edit.querySelectorAll('input');
  nameIn.value = 'Duck'; urlIn.value = 'https://duck.ai/chat';
  edit.querySelector('[data-act="save"]').click();
  await waitFor(() => d.querySelector('#sitesMenu [data-site="duckai"] .nm')?.textContent.startsWith('Duck' + 'https://duck.ai/chat'), { label: 'site edited' });
  d.querySelector('#sitesMenu [data-site="duckai"]').click();
  assert.equal(opened.at(-1), 'https://duck.ai/chat');
  d.getElementById('sitesBtn').click();
  d.querySelector('#sitesMenu [data-site="+"]').click();
  assert.ok(d.getElementById('siteScrim').classList.contains('open'));
  d.getElementById('siteUrl').value = 'https://chat.example.com/c/abc12345def';
  d.getElementById('siteProbe').click();
  const probe = await waitFor(() => ext.of('command').find((m) => m.action === 'probe_site'), { label: 'ui probe' });
  const page = `<!doctype html><html><head><title>Example Chat</title></head><body><div class="msg-user">问一个</div><div class="msg-bot">答一个</div><textarea></textarea></body></html>`;
  await fetch(`${origin}/api/sites/probe/${probe.command_id}/dom`, { method: 'POST', headers: { authorization: `Bearer ${TOKENS.extension}`, 'content-type': 'application/json' }, body: JSON.stringify({ html: page, url: probe.text, title: 'Example Chat' }) });
  await waitFor(() => !d.getElementById('siteConfirm').disabled, { label: 'probe result' });
  assert.match(d.getElementById('siteKv').textContent, /chat\.example\.com/);
  assert.match(d.getElementById('siteSamples').textContent, /答一个/);
  assert.equal(d.getElementById('siteName').value, 'Example Chat');
  d.getElementById('siteConfirm').click();
  await waitFor(() => !d.getElementById('siteScrim').classList.contains('open'), { label: 'site added' });
  d.getElementById('sitesBtn').click();
  await waitFor(() => d.querySelector('#sitesMenu [data-site="example"]'), { label: 'new site in menu' });
  d.querySelector('#sitesMenu [data-site="example"] .del').click();
  await waitFor(() => !d.querySelector('#sitesMenu [data-site="example"]') && d.querySelectorAll('#sitesMenu .mi').length === 4, { timeout: 3000, label: 'site removed' });

  assert.equal(win.__appError, undefined, String(win.__appError?.stack));
  assert.deepEqual(errors, []);
  for (const s of sockets) s.close();
  ext.close();
  win.close();
  await server.stop();
});

test('数据库迁移：旧库的“标记完成”迁移为归档', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDatabase } = await import('../../src/backend/src/db.js');
  const file = join(mkdtempSync(join(tmpdir(), 'bridge-mig-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE conversation_marks (conversation_id TEXT PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0, done_at INTEGER, updated_at INTEGER NOT NULL);
    INSERT INTO conversation_marks VALUES ('c-done', 1, 1000, 1000), ('c-todo', 0, NULL, 1000);`);
  old.close();
  const db = openDatabase(file);
  const rows = Object.fromEntries(db.raw.prepare('SELECT conversation_id, archived, archived_at, pinned FROM conversation_marks').all().map((r) => [r.conversation_id, { ...r }]));
  assert.equal(rows['c-done'].archived, 1);
  assert.equal(rows['c-done'].archived_at, 1000);
  assert.equal(rows['c-todo'].archived, 0);
  assert.equal(rows['c-done'].pinned, 0);
  db.setPinned('c-todo', true);
  db.close();
  // 再打开一次：迁移幂等，不覆盖新数据
  const db2 = openDatabase(file);
  db2.setArchived('c-done', false);
  db2.close();
  const db3 = openDatabase(file);
  const r = db3.raw.prepare("SELECT archived, pinned FROM conversation_marks WHERE conversation_id = 'c-done'").get();
  assert.equal(r.archived, 0, '第二次打开不重新从 done 迁移');
  assert.equal(db3.raw.prepare("SELECT pinned FROM conversation_marks WHERE conversation_id = 'c-todo'").get().pinned, 1);
  db3.close();
});

test('添加网站：看板发起 → 插件收到 probe_site → 上传 DOM → 分析结果 → 确认添加 → 插件收到 sync_sites → 删除', async () => {
  const server = await startServer();
  const api = (path, { method = 'GET', body, token = TOKENS.observer } = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

  const list0 = await (await api('/api/sites')).json();
  assert.deepEqual(list0.sites.map((x) => x.key), ['chatgpt', 'duckai', 'hark']);
  assert.equal((await api('/api/sites', { token: 'nope' })).status, 401);
  assert.equal((await api('/api/sites/probe', { method: 'POST', body: { url: 'https://chat.example.com/c/abc12345def' } })).status, 409, '没有在线插件');

  const ext = await extClient(server, 'ext-site-000001');
  assert.equal((await api('/api/sites/probe', { method: 'POST', body: { url: 'http://chat.example.com/' } })).status, 400, '只支持 https');
  assert.equal((await api('/api/sites/probe', { method: 'POST', body: { url: 'https://chat.example.com/x' }, token: TOKENS.extension })).status, 403, '插件 token 不能发起');
  const pr = await (await api('/api/sites/probe', { method: 'POST', body: { url: 'https://chat.example.com/c/abc12345def' } })).json();
  assert.ok(pr.ok && pr.probe_id);
  const cmd = await waitFor(() => ext.of('command').find((m) => m.action === 'probe_site'), { label: 'probe_site' });
  assert.equal(cmd.command_id, pr.probe_id);
  assert.equal(cmd.text, 'https://chat.example.com/c/abc12345def');
  assert.equal((await (await api(`/api/sites/probe/${pr.probe_id}`)).json()).status, 'pending');

  const html = `<!doctype html><html><head><title>Example Chat - AI</title></head><body><main>
    <div class="turn turn-user"><p>写一句诗</p></div><div class="turn turn-bot"><p>床前明月光</p><button>复制</button></div>
    <div class="turn turn-user"><p>下一句</p></div><div class="turn turn-bot"><p>疑是地上霜</p></div></main>
    <form><textarea></textarea><button type="submit">发送</button></form></body></html>`;
  assert.equal((await api(`/api/sites/probe/${pr.probe_id}/dom`, { method: 'POST', body: { html, url: cmd.text }, token: TOKENS.observer })).status, 403, '看板 token 不能上传');
  assert.equal((await api(`/api/sites/probe/${pr.probe_id}/dom`, { method: 'POST', body: { html, url: cmd.text, title: 'Example Chat - AI' }, token: TOKENS.extension })).status, 200);
  const res = await (await api(`/api/sites/probe/${pr.probe_id}`)).json();
  assert.equal(res.status, 'done');
  assert.equal(res.report.message_count, 4);
  assert.deepEqual(res.report.roles, { user: 2, assistant: 2 });
  assert.equal(res.report.conversation_id, 'example-abc12345def');
  assert.equal(res.suggested_name, 'Example Chat');
  assert.match(res.report.samples[1].text, /床前明月光/);
  assert.doesNotMatch(res.report.samples[1].text, /复制/);

  const add = await (await api('/api/sites', { method: 'POST', body: { probe_id: pr.probe_id, name: 'Example' } })).json();
  assert.equal(add.site.key, 'example');
  await waitFor(() => ext.of('command').some((m) => m.action === 'sync_sites'), { label: 'sync_sites' });
  const list1 = await (await api('/api/sites', { token: TOKENS.extension })).json();
  const site = list1.sites.find((x) => x.key === 'example');
  assert.equal(site.host, 'chat.example.com');
  assert.equal(site.config.site, 'example');
  assert.equal((await api('/api/sites', { method: 'POST', body: { probe_id: pr.probe_id } })).status, 400, '同一次分析不能重复添加');

  // 插件抓取失败 → 看板看到错误
  const pr2 = await (await api('/api/sites/probe', { method: 'POST', body: { url: 'https://other.example.org/' } })).json();
  await waitFor(() => ext.of('command').some((m) => m.command_id === pr2.probe_id), { label: 'probe 2' });
  ext.send(makeEnvelope('command_result', { command_id: pr2.probe_id, ok: false, code: 'probe_failed', detail: '页面打不开' }));
  await waitFor(async () => (await (await api(`/api/sites/probe/${pr2.probe_id}`)).json()).status === 'error', { label: 'probe error' });
  assert.equal((await (await api(`/api/sites/probe/${pr2.probe_id}`)).json()).error, '页面打不开');

  assert.equal((await api('/api/sites/example', { method: 'DELETE' })).status, 200);
  assert.equal((await api('/api/sites/example', { method: 'DELETE' })).status, 404);
  assert.deepEqual((await (await api('/api/sites')).json()).sites.map((x) => x.key), ['chatgpt', 'duckai', 'hark']);
  assert.ok((await (await api('/api/sites')).json()).sites.every((x) => !('builtin' in x)), '没有“内置”概念');

  // 编辑：任何网站都能改名称 / 网址；只接受 https，域名不能重复
  const ed = await (await api('/api/sites/chatgpt', { method: 'PATCH', body: { name: 'GPT', url: 'https://chatgpt.com/g/x' } })).json();
  assert.deepEqual([ed.site.name, ed.site.url, ed.site.host], ['GPT', 'https://chatgpt.com/g/x', 'chatgpt.com']);
  assert.equal((await api('/api/sites/chatgpt', { method: 'PATCH', body: { url: 'http://chatgpt.com/' } })).status, 400);
  assert.equal((await api('/api/sites/chatgpt', { method: 'PATCH', body: { url: 'https://duck.ai/' } })).status, 409);
  assert.equal((await api('/api/sites/chatgpt', { method: 'PATCH', body: { name: ' ' } })).status, 400);
  assert.equal((await api('/api/sites/chatgpt', { method: 'PATCH', body: { name: 'x' }, token: TOKENS.extension })).status, 403);
  // 一键启动：插件收到 open_sites（所有网址）
  const ln = await (await api('/api/sites/launch', { method: 'POST' })).json();
  assert.equal(ln.count, 3);
  const open = await waitFor(() => ext.of('command').find((m) => m.action === 'open_sites'), { label: 'open_sites' });
  assert.match(open.text, /https:\/\/chatgpt\.com\/g\/x/);
  // 默认网站也能删除
  assert.equal((await api('/api/sites/hark', { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await api('/api/sites')).json()).sites.map((x) => x.key), ['chatgpt', 'duckai']);
  ext.close?.();
  await server.stop();
});
