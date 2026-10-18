/**
 * 详情输入框上传文件：
 *   - 观察器读取源站输入框的上传按钮（文字 / 图标图形 / accept / multiple），随 conversation.status 上报
 *   - 页面操作把文件交给页面自己的 <input type=file>，等上传完成（发送按钮可用）再发送
 *   - 后端：看板上传 → 指令带附件 → 插件凭 token 取回；过期 / 无权限
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { validateMessage, makeEnvelope } from '../../contracts/protocol.js';
import { fetchAttachments, uploadAttachment } from '../../src/frontend/lib/dom-config-client.js';
import { createBackground } from '../../src/frontend/lib/background-core.js';
import { ROOT, startServer, tmpDb, TestClient, TOKENS, waitFor, ajvValidate } from '../helpers.js';

const OBSERVER_SRC = readFileSync(join(ROOT, 'src/frontend/lib/dom-observer.js'), 'utf8');
const ACTIONS_SRC = readFileSync(join(ROOT, 'src/frontend/lib/page-actions.js'), 'utf8');

const page = () => `<!doctype html><html><head><title>Hark</title></head><body><div id="root">
  <div data-testid="message-list"><div data-message-id="11111111-aaaa" data-entry-kind="message" data-transcript-row="">
    <div data-testid="message-bubble" data-bubble-id="11111111-aaaa" data-bubble-kind="text"><div dir="auto" data-testid="message-text"><span>你好</span></div></div></div></div>
  <form data-composer-pill="true">
    <input type="file" accept=".pdf,image/*" multiple hidden />
    <button type="button" aria-label="添加文件" data-testid="attach-button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" onclick="alert(1)"/><circle cx="12" cy="12" r="10" fill="url(#x)"/></svg>
    </button>
    <textarea aria-label="消息输入" data-testid="chat-input"></textarea>
    <button type="button" data-testid="send-button" aria-label="发送消息">s</button>
  </form>
</div></body></html>`;

function run() {
  const dom = new JSDOM(page(), { url: 'https://hark.com/chat', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.eval(OBSERVER_SRC);
  win.eval(ACTIONS_SRC);
  const events = [];
  const obs = win.ChatGPTBridgeObserver.createChatGPTObserver({ document: win.document, window: win, emit: (e) => events.push(e), pollMs: 50, debounceMs: 10 });
  obs.start();
  return { win, doc: win.document, obs, events };
}

test('观察器：读取源站上传按钮（文字、图标图形、accept、multiple），不带不安全的属性', async () => {
  const { win, obs, events } = run();
  const st = await waitFor(() => events.find((e) => e.event_type === 'conversation.status'), { label: 'status' });
  const attach = JSON.parse(JSON.stringify(st.payload.composer.attach));   // jsdom 里创建的对象原型不同
  assert.equal(attach.label, '添加文件');
  assert.equal(attach.accept, '.pdf,image/*');
  assert.equal(attach.multiple, true);
  assert.equal(attach.icon.view_box, '0 0 24 24');
  assert.equal(attach.icon.stroke, 'currentColor');
  assert.equal(attach.icon.stroke_width, '2');
  assert.deepEqual(attach.icon.shapes.map((x) => x.tag), ['path', 'circle']);
  assert.deepEqual(attach.icon.shapes[0].attrs, { d: 'M12 5v14M5 12h14' }, '不带 onclick');
  assert.equal(attach.icon.shapes[1].attrs.fill, undefined, 'url(...) 填充被丢掉');
  // 事件本身符合协议
  const env = makeEnvelope('event', { event_id: 'evt-test-0001', event_type: st.event_type, occurred_at: Date.now(), conversation_id: 'hark-main', payload: st.payload });
  const v = validateMessage(env, { direction: 'c2s' });
  assert.ok(v.ok, JSON.stringify(v.errors));
  obs.stop();
  win.close();
});

test('页面操作：文件交给页面的文件选择框，等上传完成再发送；只发文件也可以', async () => {
  const { win, doc, obs } = run();
  // jsdom 没有 DataTransfer：按浏览器的样子补一个
  win.DataTransfer = class { constructor() { this.list = []; this.items = { add: (f) => this.list.push(f) }; } get files() { return this.list; } };
  const input = doc.querySelector('input[type=file]');
  let given = null;
  Object.defineProperty(input, 'files', { configurable: true, get: () => given, set: (v) => { given = v; } });
  const send = doc.querySelector('[data-testid="send-button"]');
  const sent = [];
  // 页面：收到文件后上传 300ms，期间发送按钮不可用
  input.addEventListener('change', () => { send.disabled = true; setTimeout(() => { send.disabled = false; }, 300); });
  send.addEventListener('click', () => { sent.push({ text: doc.querySelector('textarea').value, files: given.map((f) => f.name) }); doc.querySelector('textarea').value = ''; send.disabled = true; });
  const ctx = { document: doc, window: win, actions: obs.getConfig().actions, isGenerating: () => false, conversationId: () => obs.getConversationId() };
  const files = [{ name: 'a.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1').toString('base64') }, { name: 'b.png', type: 'image/png', data: Buffer.from('png').toString('base64') }];
  const t0 = Date.now();
  const r = await win.ChatGPTBridgeActions.execute(ctx, { action: 'reply', conversation_id: 'hark-main', text: '看看这两个', files });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Date.now() - t0 >= 300, '等页面上传完成才发送');
  assert.deepEqual(sent, [{ text: '看看这两个', files: ['a.pdf', 'b.png'] }]);
  assert.equal(given[0].type, 'application/pdf');
  assert.equal(await given[0].text(), '%PDF-1');

  send.disabled = false;
  const r2 = await win.ChatGPTBridgeActions.execute(ctx, { action: 'reply', conversation_id: 'hark-main', files: [files[0]] });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(sent[1], { text: '', files: ['a.pdf'] });

  // 只能单选的网站：多个文件直接拒绝
  input.removeAttribute('multiple');
  send.disabled = false;
  const r3 = await win.ChatGPTBridgeActions.execute(ctx, { action: 'reply', conversation_id: 'hark-main', files });
  assert.equal(r3.code, 'attach_single_only');
  obs.stop();
  win.close();
});

test('后端：看板上传文件 → 快速回复带附件转发给插件 → 插件凭 token 取回；过期 / 没权限', async () => {
  const server = await startServer({ dbPath: tmpDb() });
  const http = `http://127.0.0.1:${server.port}`;
  const CONV = '6720a1b2-0000-4111-8222-ffffeeee0001';
  const ext = await new TestClient(server.url).open();
  const dash = await new TestClient(server.url).open();
  try {
    const up = (token, body, name, type = 'text/plain') => fetch(`${http}/api/attachments`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-file-name': encodeURIComponent(name), 'content-type': type }, body
    });
    assert.equal((await up(TOKENS.meta, 'x', 'x.txt')).status, 403, '上传需要 control 或 publish 权限');
    const rExt = await up(TOKENS.extension, Buffer.from('plugin-bytes'), '页面文件.pdf');
    assert.equal(rExt.status, 201, '插件凭 publish 权限可以上传页面里观察到的文件');
    const r = await up(TOKENS.observer, Buffer.from('报告内容'), '报告/2026.txt');
    assert.equal(r.status, 201);
    const att = (await r.json()).attachment;
    assert.equal(att.name, '报告_2026.txt', '文件名里的路径分隔符被替换');
    assert.equal(att.type, 'text/plain');
    assert.equal(att.size, Buffer.byteLength('报告内容'));
    const bad = await (await up(TOKENS.observer, 'x', 'a.bin', 'not a type')).json();
    assert.equal(bad.attachment.type, 'application/octet-stream');

    const get = (token, id) => fetch(`${http}/api/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await get(TOKENS.meta, att.id)).status, 403, '取文件需要 publish 或 read_content 权限');
    const gObs = await get(TOKENS.observer, att.id);
    assert.equal(gObs.status, 200, '看板凭 read_content 可以下载插件上传的文件');
    assert.equal(await gObs.text(), '报告内容');
    const g = await get(TOKENS.extension, att.id);
    assert.equal(g.status, 200);
    assert.equal(await g.text(), '报告内容');
    assert.equal((await get(TOKENS.extension, 'att-doesnotexist')).status, 404);

    // 快速回复带附件：后端补上 url 转发给开着这个会话的插件
    await ext.hello('ext-att-0001', TOKENS.extension, 'extension');
    const ev = (type, payload, n) => makeEnvelope('event', { event_id: `t:att:${type.replace(/\W/g, '')}:${n}`, event_type: type, occurred_at: Date.now(), conversation_id: CONV, tab_id: 3, payload });
    const opened = ev('page.opened', { url: `https://chatgpt.com/c/${CONV}`, title: 't' }, 1);
    ext.send(opened);
    await waitFor(() => ext.messages.some((m) => m.type === 'ack' && m.ref_id === opened.event_id), { label: 'ack' });
    await dash.hello('dash-att-0001', TOKENS.observer);
    const cmd = makeEnvelope('command', { command_id: 'cmd-att-00001', action: 'reply', conversation_id: CONV, attachments: [{ id: att.id, name: att.name }] });
    dash.send(cmd);
    const fwd = await waitFor(() => ext.of('command').find((m) => m.command_id === 'cmd-att-00001'), { label: 'forwarded' });
    assert.equal(fwd.text, undefined, '只发文件时不带 text');
    assert.deepEqual(fwd.attachments, [{ id: att.id, name: att.name, type: 'text/plain', size: att.size, url: `/api/attachments/${att.id}` }]);
    assert.ok(ajvValidate(fwd), JSON.stringify(ajvValidate.errors));
    ext.send(makeEnvelope('command_result', { command_id: 'cmd-att-00001', ok: true, detail: '已发送' }));
    await waitFor(() => dash.of('command_result').some((m) => m.command_id === 'cmd-att-00001' && m.ok), { label: 'result' });

    // 不存在 / 过期的附件：直接拒绝；没文字也没文件：拒绝
    dash.send(makeEnvelope('command', { command_id: 'cmd-att-00002', action: 'reply', conversation_id: CONV, attachments: [{ id: 'att-expired0001', name: 'old.pdf' }] }));
    const exp = await waitFor(() => dash.of('command_result').find((m) => m.command_id === 'cmd-att-00002'), { label: 'expired' });
    assert.equal(exp.code, 'attachment_expired');
    dash.send(makeEnvelope('command', { command_id: 'cmd-att-00003', action: 'reply', conversation_id: CONV }));
    const empty = await waitFor(() => dash.of('command_result').find((m) => m.command_id === 'cmd-att-00003'), { label: 'empty' });
    assert.equal(empty.code, 'text_required');
  } finally {
    ext.close(); dash.close();
    await server.stop();
  }
});

test('后端：插件上传页面里观察到的文件 → 看板凭 read_content 下载；无权限被拒绝', async () => {
  const server = await startServer({ dbPath: tmpDb() });
  const http = `http://127.0.0.1:${server.port}`;
  try {
    const up = (token, body, name, type = 'application/pdf') => fetch(`${http}/api/attachments`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-file-name': encodeURIComponent(name), 'content-type': type }, body
    });
    const get = (token, id) => fetch(`${http}/api/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } });

    // 既无 publish 也无 control 的 token 不能上传
    assert.equal((await up(TOKENS.meta, 'x', 'x.txt', 'text/plain')).status, 403);

    // 插件凭 publish 上传页面里观察到的文件
    const r = await up(TOKENS.extension, Buffer.from('%PDF-1.4 fake'), '合同.pdf');
    assert.equal(r.status, 201);
    const att = (await r.json()).attachment;
    assert.match(att.id, /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(att.name, '合同.pdf');
    assert.equal(att.type, 'application/pdf');
    assert.equal(att.size, Buffer.byteLength('%PDF-1.4 fake'));

    // 看板凭 read_content 下载（observer token 有 read_content）
    const g = await get(TOKENS.observer, att.id);
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await g.arrayBuffer()).toString(), '%PDF-1.4 fake');

    // 既无 publish 也无 read_content 的 token 不能下载
    assert.equal((await get(TOKENS.meta, att.id)).status, 403);

    // 插件把文件 URL 写进消息 html（<a data-file href="/api/attachments/:id">），看板据此渲染文件卡片
    const url = `/api/attachments/${att.id}`;
    assert.ok(url.length <= 300, '符合 ATTACHMENT.url ≤ 300');
  } finally {
    await server.stop();
  }
});

test('插件后台：fetchAttachments 取回文件转 base64；404 → attachment_expired', async () => {  const store = { '/api/attachments/att-0000000001': Buffer.from('hello 文件') };
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.headers.authorization, 'Bearer tok');
    const path = new URL(url).pathname;
    const buf = store[path];
    return buf
      ? { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), headers: { get: () => 'text/plain' } }
      : { ok: false, status: 404 };
  };
  const r = await fetchAttachments({ fetchImpl, serverUrl: 'ws://127.0.0.1:8787', token: 'tok', attachments: [{ id: 'att-0000000001', name: 'a.txt', type: 'text/plain', url: '/api/attachments/att-0000000001' }] });
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(r.files[0].data, 'base64').toString(), 'hello 文件');
  const r2 = await fetchAttachments({ fetchImpl, serverUrl: 'ws://127.0.0.1:8787', token: 'tok', attachments: [{ id: 'att-0000000002', name: 'b.txt', url: '/api/attachments/att-0000000002' }] });
  assert.equal(r2.code, 'attachment_expired');
});

test('插件后台整链：reply+attachments → 取回文件 → 发给内容脚本(files) → 结果回传', async () => {
  class NoopWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const mk = (fetchCommandFiles, executeCommand) => createBackground({
    WebSocketImpl: NoopWS, storage: null, clientId: 'ext-chain-0001',
    settings: { serverUrl: 'ws://127.0.0.1:1', token: 'x' },
    fetchCommandFiles, executeCommand
  });
  const replyCmd = (id, attachments) => ({
    command_id: id, action: 'reply', conversation_id: 'conv-1', tab_id: 3, text: '看看这个', attachments
  });
  const att = { id: 'att-00000001', name: 'a.pdf', type: 'application/pdf', size: 6, url: '/api/attachments/att-00000001' };

  // 成功：内容脚本收到的是 files（不是 attachments），结果原样回传
  const seen = [];
  const bg = mk(
    async (atts) => ({ ok: true, files: atts.map((a) => ({ name: a.name, type: 'application/pdf', data: Buffer.from('%PDF-1').toString('base64') })) }),
    async (tabId, command) => {
      seen.push([tabId, command]);
      assert.deepEqual(command.files.map((f) => f.name), ['a.pdf']);
      assert.equal(command.attachments, undefined);
      return { ok: true, detail: '已发送' };
    }
  );
  bg.tabs.set(3, { url: 'https://chatgpt.com/c/conv-1', conversation_id: 'conv-1' });
  const r = await bg.conn.onCommand(replyCmd('cmdchain0001', [att]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.detail, '已发送');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 3);

  // 取回失败：直接返回错误，不打扰标签页
  let executed = false;
  const bg2 = mk(
    async () => ({ ok: false, code: 'attachment_expired', detail: '文件已过期' }),
    async () => { executed = true; return { ok: true }; }
  );
  bg2.tabs.set(3, { url: 'https://chatgpt.com/c/conv-1', conversation_id: 'conv-1' });
  const r2 = await bg2.conn.onCommand(replyCmd('cmdchain0002', [{ id: 'att-00000002', name: 'old.pdf', url: '/api/attachments/att-00000002' }]));
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'attachment_expired');
  assert.equal(executed, false);

  // 不带附件的 reply：不走取文件分支，直接执行
  const bg3 = mk(async () => { throw new Error('不应取文件'); }, async () => ({ ok: true, detail: '已发送' }));
  bg3.tabs.set(3, { url: 'https://chatgpt.com/c/conv-1', conversation_id: 'conv-1' });
  const r3 = await bg3.conn.onCommand({ command_id: 'cmdchain0003', action: 'reply', conversation_id: 'conv-1', tab_id: 3, text: '纯文字' });
  assert.equal(r3.ok, true, JSON.stringify(r3));
});

test('插件后台：uploadAttachment 上传文件（raw bytes + x-file-name）；失败转错误码', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push([url, opts]);
    assert.equal(opts.method, 'POST');
    assert.ok(opts.body instanceof Uint8Array, 'body 是原始字节');
    assert.ok(url.endsWith('/api/attachments'), url);
    const fname = decodeURIComponent(opts.headers['x-file-name']);
    return {
      ok: true, status: 201,
      json: async () => ({ ok: true, attachment: { id: 'att-00000009', name: fname, type: opts.headers['content-type'], size: opts.body.length } })
    };
  };
  const r = await uploadAttachment({
    fetchImpl, serverUrl: 'ws://127.0.0.1:8787', token: 'tok',
    name: '合同.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4')
  });
  assert.equal(r.ok, true);
  assert.equal(r.attachment.id, 'att-00000009');
  assert.equal(r.attachment.name, '合同.pdf');
  assert.equal(r.attachment.size, 8);
  assert.equal(calls[0][1].headers['x-file-name'], encodeURIComponent('合同.pdf'));
  assert.equal(calls[0][1].headers['content-type'], 'application/pdf');

  // base64 字符串也能传（内容脚本抓到的文件）
  const r2 = await uploadAttachment({
    fetchImpl, serverUrl: 'ws://127.0.0.1:8787', token: 'tok',
    name: 'a.txt', data: Buffer.from('hi').toString('base64')
  });
  assert.equal(r2.ok, true);

  // 403 → forbidden；非法 data → bad_argument
  const bad = await uploadAttachment({
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'control or publish scope required' }) }),
    serverUrl: 'ws://127.0.0.1:8787', token: 'bad', name: 'x.txt', data: new Uint8Array([1])
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'forbidden');
  const badArg = await uploadAttachment({ fetchImpl, serverUrl: 'ws://127.0.0.1:8787', token: 'tok', name: 'x', data: 123 });
  assert.equal(badArg.code, 'bad_argument');
});
test('联调（A2 插件侧契约）：插件上传文件 → 消息 html 引用文件 URL → 看板下载展示（端到端）', async () => {
  const server = await startServer({ dbPath: tmpDb() });
  const http = `http://127.0.0.1:${server.port}`;
  const ext = await new TestClient(server.url).open();
  const CONV = '6720a1b2-0000-4111-8222-ffffeeee0002';
  try {
    await ext.hello('ext-upflow-0001', TOKENS.extension, 'extension');

    // 1. 插件用 publish token 上传页面里观察到的文件（raw bytes + x-file-name 头）
    const up = await fetch(`${http}/api/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKENS.extension}`,
        'x-file-name': encodeURIComponent('会议纪要.pdf'),
        'content-type': 'application/pdf'
      },
      body: Buffer.from('%PDF-1.4 fake-bytes')
    });
    assert.equal(up.status, 201);
    const { attachment } = await up.json();
    const url = `/api/attachments/${attachment.id}`;
    assert.ok(url.length <= 300, '符合 ATTACHMENT.url ≤ 300');

    // 2. 插件上报消息，html 里用 <a data-file href="文件URL"> 引用（看板渲染文件卡片）
    const html = `<p>这是今天的纪要 <a data-file="会议纪要.pdf" href="${url}">会议纪要.pdf</a></p>`;
    const msgEv = makeEnvelope('event', {
      event_id: 't:upflow:msg:1', event_type: 'message.added', occurred_at: Date.now(),
      conversation_id: CONV,
      payload: {
        message_id: 'm-file-0001', role: 'assistant', index: 0,
        text: '这是今天的纪要 [文件：会议纪要.pdf]', text_length: 22, html
      }
    });
    const v = validateMessage(msgEv, { direction: 'c2s' });
    assert.ok(v.ok, '插件上报的消息符合协议：' + JSON.stringify(v.errors));
    ext.send(msgEv);
    await waitFor(
      () => ext.of('ack').find((a) => a.ref_id === msgEv.event_id && a.status === 'persisted'),
      { label: '消息落盘 ack' });

    // 3. 看板查消息：html 原样存下，文件 URL 可点
    const h = { authorization: `Bearer ${TOKENS.observer}` };
    const msgs = await (await fetch(`${http}/api/conversations/${CONV}/messages`, { headers: h })).json();
    const m = msgs.messages.find((x) => x.message_id === 'm-file-0001');
    assert.ok(m, '看板能查到这条消息');
    assert.ok(m.html.includes(url), 'html 里保留了文件 URL');

    // 4. 看板凭 read_content 把文件下载下来展示
    const g = await fetch(`${http}${url}`, { headers: h });
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'application/pdf');
    assert.equal(await g.text(), '%PDF-1.4 fake-bytes');
  } finally {
    ext.close();
    await server.stop();
  }
});
