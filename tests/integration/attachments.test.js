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
import { fetchAttachments } from '../../src/frontend/lib/dom-config-client.js';
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
    assert.equal((await up(TOKENS.extension, 'x', 'x.txt')).status, 403, '上传需要 control 权限');
    const r = await up(TOKENS.observer, Buffer.from('报告内容'), '报告/2026.txt');
    assert.equal(r.status, 201);
    const att = (await r.json()).attachment;
    assert.equal(att.name, '报告_2026.txt', '文件名里的路径分隔符被替换');
    assert.equal(att.type, 'text/plain');
    assert.equal(att.size, Buffer.byteLength('报告内容'));
    const bad = await (await up(TOKENS.observer, 'x', 'a.bin', 'not a type')).json();
    assert.equal(bad.attachment.type, 'application/octet-stream');

    const get = (token, id) => fetch(`${http}/api/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await get(TOKENS.observer, att.id)).status, 403, '取文件需要 publish（插件）权限');
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

test('插件后台：fetchAttachments 取回文件转 base64；404 → attachment_expired', async () => {
  const store = { '/api/attachments/att-0000000001': Buffer.from('hello 文件') };
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
