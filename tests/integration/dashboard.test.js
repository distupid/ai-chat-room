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
  assert.match(await (await get(server, '/dashboard')).text(), /会话管理/);
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

test('会话实体：来源、标题、模型、消息数、回答中 → 已到限额 → 页面已关（保留提示）、标记完成', async () => {
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
  await sendAndAck(ext, ev('conversation.status', { source: 'chatgpt', status: 'limit_reached', detail: '已达到 GPT-5 的使用上限，将在 18:30 重置。', model: 'GPT-5' }));
  c = (await list())[0];
  assert.equal(c.status, 'limit_reached');
  assert.equal(c.status_detail, '已达到 GPT-5 的使用上限，将在 18:30 重置。');
  assert.equal(c.generation_count, 1);
  assert.equal(c.last_duration_ms, 4200);

  await sendAndAck(ext, ev('page.closed', { url: CONV_URL, reason: 'tab_removed' }));
  c = (await list())[0];
  assert.equal(c.status, 'closed');
  assert.equal(c.open_tabs, 0);
  assert.equal(c.page_status, 'limit_reached', '页面关掉后仍保留最后的限额状态');
  assert.ok(c.status_detail);

  // 标记完成
  const origin = `http://127.0.0.1:${server.port}`;
  const mark = await fetch(`${origin}/api/conversations/${CONV}/mark`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKENS.observer}`, origin, 'content-type': 'application/json' }, body: '{"done":true}'
  });
  assert.equal(mark.status, 200);
  c = (await list())[0];
  assert.equal(c.done, true);
  assert.equal(c.activity_after_done, false);
  await sleep(5);
  await sendAndAck(ext, ev('page.opened', { url: CONV_URL, title: 't' }, { tab: 2 }));
  c = (await list())[0];
  assert.equal(c.activity_after_done, true, '完成后有新动态');
  assert.equal(c.status, 'limit_reached', '重新打开后显示页面状态');

  const msgs = await (await get(server, `/api/conversations/${CONV}/messages`, TOKENS.observer)).json();
  assert.deepEqual(msgs.messages.map((m) => [m.message_id, m.text]), [['u1', '你好'], ['a1', '你好！']]);
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

test('观察器：页面出现限额提示时上报 conversation.status（对话正文里的“上限”不误报）', async () => {
  class NoopWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const bg = createBackground({ WebSocketImpl: NoopWS, storage: null, clientId: 'ext-status-0001', settings: { serverUrl: 'ws://127.0.0.1:1', token: 'x' } });
  const results = [];
  const orig = bg.handleRuntimeMessage;
  bg.handleRuntimeMessage = (m, s) => { const r = orig(m, s); results.push({ m, r }); return r; };
  const page = openChatGPTPage({ url: CONV_URL, tabId: 3, background: bg, html: fakeChatGPT(CONV) });
  const statuses = () => results.filter((x) => x.m.event.event_type === 'conversation.status').map((x) => x.m.event.payload);
  await waitFor(() => statuses().length >= 1, { label: 'initial status' });
  assert.deepEqual(statuses()[0], { source: 'chatgpt', status: 'ok', detail: null, model: null });

  // 回答正文里出现“已达到使用上限”——不应触发
  page.doc.querySelector('[data-dil-message-id] p').textContent = '如果你已达到使用上限，可以等待重置';
  await sleep(1300);
  assert.equal(statuses().at(-1).status, 'ok');

  const banner = page.doc.createElement('div');
  banner.setAttribute('role', 'alert');
  banner.textContent = "You've reached your GPT-5 limit. Your limit resets at 6:30 PM.";
  page.doc.body.appendChild(banner);
  await waitFor(() => statuses().at(-1).status === 'limit_reached', { label: 'limit', timeout: 4000 });
  assert.match(statuses().at(-1).detail, /6:30 PM/);
  assert.ok(results.every((x) => x.r.ok), JSON.stringify(results.filter((x) => !x.r.ok).map((x) => x.r)));

  banner.remove();
  await waitFor(() => statuses().at(-1).status === 'ok', { label: 'back to ok', timeout: 4000 });
  page.close();
});

test('看板前端：在 jsdom 中加载，连接、渲染卡片、主题、设置、实时更新、点卡片跳转、详情复制、标记完成、快速回复', async () => {
  const { JSDOM } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('../helpers.js');
  const proto = await import('../../contracts/protocol.js');

  const server = await startServer({ commandTimeoutMs: 1500 });
  const origin = `http://127.0.0.1:${server.port}`;
  const ext = await extClient(server, 'ext-ui-000001');
  await sendAndAck(ext, ev('page.opened', { url: CONV_URL, title: '界面测试 - ChatGPT' }));
  await sendAndAck(ext, ev('conversation.status', { source: 'chatgpt', status: 'ok', detail: null, model: null }));
  await sendAndAck(ext, ev('message.added', { message_id: 'u1', role: 'user', index: 0, text: '问题一', text_length: 3 }));
  await sendAndAck(ext, ev('message.added', { message_id: 'a1', role: 'assistant', index: 1, text: '回答一', text_length: 3 }));

  const html = readFileSync(join(ROOT, 'src/backend/dashboard/index.html'), 'utf8').replace(/<script type="module"[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { url: `${origin}/dashboard`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const copied = [];
  const sockets = [];
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
  win.CSS = { escape: (s) => String(s).replace(/"/g, '\\"') };
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (t) => { copied.push(t); } } });
  const opened = [];
  win.open = (url) => { opened.push(url); return null; };
  const appSrc = readFileSync(join(ROOT, 'src/backend/dashboard/app.js'), 'utf8')
    .replace(/^import \{([^}]+)\} from '\.\/protocol\.js';/m, 'const {$1} = window.__proto;');
  const errors = [];
  win.addEventListener('error', (e) => errors.push(e.error || e.message));
  win.eval(`(async () => { ${appSrc} })().catch((e) => { window.__appError = e; });`);

  const d = win.document;
  d.getElementById('token').value = TOKENS.observer;
  d.getElementById('connect').click();
  await waitFor(() => d.getElementById('connText').textContent === '已连接', { label: 'connected' });
  const cardEl = await waitFor(() => d.querySelector(`.card[data-conv="${CONV}"]`), { label: 'card' });
  assert.equal(cardEl.querySelector('.title').textContent, '界面测试');
  assert.equal(cardEl.querySelector('.badge').textContent, '空闲');
  assert.match(cardEl.querySelector('.sub').textContent, /ChatGPT/);
  assert.match(d.getElementById('chips').textContent, /全部1/);
  assert.ok(!/复制回答|打开/.test([...cardEl.querySelectorAll('button, a')].map((b) => b.textContent).join('|')), '卡片上没有“复制回答”“打开”');

  // 主题切换 + 设置弹窗
  d.getElementById('themeBtn').click();
  assert.ok(['light', 'dark'].includes(d.documentElement.getAttribute('data-theme')));
  d.querySelector('[data-theme-opt="dark"]').click();
  assert.equal(d.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(JSON.parse(win.localStorage.getItem('bridgeDashboard.theme')), 'dark');
  d.getElementById('settingsBtn').click();
  assert.ok(d.getElementById('settingsScrim').classList.contains('open'));
  await waitFor(() => /在线客户端/.test(d.getElementById('serverInfo').textContent), { label: 'server info' });
  d.getElementById('settingsClose').click();

  // 点卡片：有标签页 → 下发 focus；测试里的“插件”不执行 → 超时 → 新开页面
  cardEl.click();
  await waitFor(() => opened.length === 1, { label: 'fallback open', timeout: 6000 });
  assert.equal(opened[0], CONV_URL);

  // 实时：状态变为“已到限额”
  await sendAndAck(ext, ev('conversation.status', { source: 'chatgpt', status: 'limit_reached', detail: '已达到使用上限', model: null }));
  await waitFor(() => d.querySelector(`.card[data-conv="${CONV}"] .badge`)?.textContent === '已到限额', { label: 'limit badge' });
  assert.match(d.querySelector(`.card[data-conv="${CONV}"] .notice`).textContent, /已达到使用上限/);

  const btn = (label) => [...d.querySelectorAll(`.card[data-conv="${CONV}"] .actions button`)].find((b) => b.textContent === label);

  // 标记完成
  btn('标记完成').click();
  await waitFor(() => btn('取消完成'), { label: 'marked' });
  assert.ok(d.querySelector(`.card[data-conv="${CONV}"]`).classList.contains('done'));

  // 详情 + 流式更新
  btn('详情').click();
  assert.equal(opened.length, 1, '点按钮不触发卡片跳转');
  assert.ok(d.getElementById('detailScrim').classList.contains('open'));
  await waitFor(() => d.querySelectorAll('#detailMsgs .msg').length === 2, { label: 'detail' });
  // 详情里复制回答
  d.getElementById('detailCopy').click();
  await waitFor(() => copied.length === 1, { label: 'copied' });
  assert.equal(copied[0], '回答一');
  await sendAndAck(ext, ev('message.updated', { message_id: 'a1', role: 'assistant', index: 1, text: '回答一（更新）', text_length: 7 }));
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant')?.textContent.includes('回答一（更新）'), { label: 'stream update' });
  await sendAndAck(ext, ev('message.updated', { message_id: 'a1', role: 'assistant', index: 1, text: '代码：\n\n```js\nconst a = 1;\n```\n\n用 `a` 即可', text_length: 30 }));
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant pre code')?.textContent === 'const a = 1;', { label: 'code block' });
  assert.equal(d.querySelector('#detailMsgs .msg.assistant code.inl').textContent, 'a');
  d.getElementById('detailClose').click();
  assert.ok(!d.getElementById('detailScrim').classList.contains('open'));

  // 快速回复：这里的“插件”是不会执行指令的测试客户端 → 后端超时，看板要提示失败
  btn('快速回复').click();
  const ta = await waitFor(() => d.querySelector(`.card[data-conv="${CONV}"] .quick.open textarea`), { label: 'quick open' });
  ta.value = '你好';
  ta.dispatchEvent(new win.Event('input'));
  d.querySelector(`.card[data-conv="${CONV}"] .quick .btn.filled`).click();
  await waitFor(() => /快速回复/.test(d.getElementById('snackbars').textContent) && /失败/.test(d.getElementById('snackbars').textContent), { label: 'reply toast', timeout: 6000 });

  assert.equal(win.__appError, undefined, String(win.__appError?.stack));
  assert.deepEqual(errors, []);
  for (const s of sockets) s.close();
  ext.close();
  win.close();
  await server.stop();
});
