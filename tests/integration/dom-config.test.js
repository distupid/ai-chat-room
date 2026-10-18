/**
 * DOM 配置：后端分析器 + HTTP 接口 + 插件内容脚本加载配置后的监听效果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { analyzeDom } from '../../src/backend/src/dom-analyzer.js';
import { createBackground } from '../../src/frontend/lib/background-core.js';
import { analyzeDomOnServer, getDomConfigFromServer, clearDomConfigOnServer, wsToHttp } from '../../src/frontend/lib/dom-config-client.js';
import { startServer, tmpDb, TOKENS, openChatGPTPage, chatHtml, waitFor, sleep, ROOT } from '../helpers.js';

const CONV_URL = 'https://chatgpt.com/c/6720a1b2-0000-4111-8222-999988887777';
const U1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const A1 = '11111111-aaaa-4bbb-8ccc-000000000002';
const U2 = '11111111-aaaa-4bbb-8ccc-000000000003';
const A2 = '11111111-aaaa-4bbb-8ccc-000000000004';

function newUiHtml(attr = 'data-chatgpt-search-unit-key', idsAttr = 'data-chatgpt-search-message-ids', { stopButton = false } = {}) {
  const user = (n, id, text) => `<div class="group/user-message" ${attr}="fallback-turn-${n}:0:user" ${idsAttr}="${id}">
      <div data-user-message-bubble="true"><div class="whitespace-pre-wrap">${text}</div></div>
      <button aria-label="复制消息">复制</button><button aria-label="编辑消息">编辑</button></div>`;
  const asst = (n, id, text) => `<div ${attr}="fallback-turn-${n}:1:assistant" ${idsAttr}="${id} ${id}">
      <div class="DilResponseRoot" data-dil-message-id="${id}" data-conv-id="99999999-0000-4000-8000-000000000000"><p>${text}</p></div>
      <button aria-label="复制">复制</button></div>`;
  return `<!doctype html><html data-build="test-build"><head><title>ChatGPT</title></head><body><main id="thread">
    ${user(0, U1, '第一个问题')}${asst(0, A1, '第一个回答')}${user(1, U2, '第二个问题')}${asst(1, A2, '第二个回答')}
  </main><form data-chatgpt-composer="">${stopButton ? '<button aria-label="停止流式传输">x</button>' : '<button aria-label="开始语音">x</button>'}</form></body></html>`;
}

function offlineBackground() {
  class NoopWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const bg = createBackground({ WebSocketImpl: NoopWS, storage: null, clientId: 'ext-offline-0002', settings: { serverUrl: 'ws://127.0.0.1:1', token: 'x' } });
  const results = [];
  const orig = bg.handleRuntimeMessage;
  bg.handleRuntimeMessage = (m, s) => { const r = orig(m, s); results.push({ m, r }); return r; };
  return { bg, results };
}

test('分析器：旧版结构（data-message-author-role）', () => {
  const r = analyzeDom(chatHtml([{ role: 'user', id: 'msg-u-1', text: '问' }, { role: 'assistant', id: 'msg-a-1', text: '答' }]));
  assert.equal(r.ok, true);
  assert.equal(r.config.strategy, 'legacy-author-role');
  assert.equal(r.config.message.selector, '[data-message-author-role]');
  assert.equal(r.config.text.assistant, '.markdown');
  assert.deepEqual(r.report.roles, { user: 1, assistant: 1 });
});

test('分析器：新版结构，ID 取自消息节点，排除所有消息相同的会话 ID，正文不含按钮', () => {
  const r = analyzeDom(newUiHtml());
  assert.equal(r.ok, true);
  assert.equal(r.config.strategy, 'search-unit-key-2026');
  assert.deepEqual(r.config.message.id_attrs, ['data-chatgpt-search-message-ids']);
  assert.equal(r.config.message.id_inner.attr, 'data-dil-message-id');
  assert.equal(r.config.text.user, '[data-user-message-bubble] .whitespace-pre-wrap');
  assert.equal(r.config.text.assistant, '[data-dil-message-id]');
  assert.deepEqual(r.report.samples.map((s) => [s.role, s.id, s.text]), [
    ['user', U1, '第一个问题'], ['assistant', A1, '第一个回答'], ['user', U2, '第二个问题'], ['assistant', A2, '第二个回答']
  ]);
  assert.equal(r.config.page.build, 'test-build');
  assert.equal(r.report.generating_now, false);
});

test('分析器：未知的新结构通过通用发现找到角色属性和 ID 属性', () => {
  const r = analyzeDom(newUiHtml('data-x-turn-key', 'data-x-ids'));
  assert.equal(r.ok, true);
  assert.equal(r.config.strategy, 'discovered:data-x-turn-key');
  assert.equal(r.config.message.selector, '[data-x-turn-key$="user"], [data-x-turn-key$="assistant"]');
  assert.deepEqual(r.config.message.id_attrs, ['data-x-ids']);
  assert.deepEqual(r.report.roles, { user: 2, assistant: 2 });
});

test('分析器：抓取时正在生成，会把页面上的停止按钮加入 generating 选择器', () => {
  const r = analyzeDom(newUiHtml(undefined, undefined, { stopButton: true }));
  assert.equal(r.report.generating_now, true);
  assert.ok(r.config.generating.selector.startsWith('button[aria-label="停止流式传输"]'));
});

test('分析器：没有对话消息时返回 422 语义的错误', () => {
  const r = analyzeDom('<!doctype html><html><body><p>hello</p></body></html>');
  assert.equal(r.ok, false);
  assert.equal(r.report.error, 'no conversation messages found');
});

test('HTTP 接口：认证、权限、Origin、保存、读取、清除、重启后仍在', async () => {
  const dbPath = tmpDb();
  const domConfigPath = join(dirname(dbPath), 'dom-config.json');
  let server = await startServer({ dbPath, domConfigPath });
  const base = `http://127.0.0.1:${server.port}`;
  const serverUrl = `ws://127.0.0.1:${server.port}`;
  assert.equal(wsToHttp(serverUrl), base);

  const post = (headers, body) => fetch(base + '/api/dom-config/analyze', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({}, { html: newUiHtml() })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${TOKENS.observer}` }, { html: newUiHtml() })).status, 403, 'observer 没有 publish 权限');
  assert.equal((await post({ authorization: `Bearer ${TOKENS.extension}`, origin: 'https://evil.example' }, { html: newUiHtml() })).status, 403, '普通网页 Origin 被拒绝');
  assert.equal((await post({ authorization: `Bearer ${TOKENS.extension}` }, { nohtml: 1 })).status, 400);

  const r = await analyzeDomOnServer({ serverUrl, token: TOKENS.extension, html: newUiHtml(), url: CONV_URL, title: 't' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.config.page.url, CONV_URL);
  assert.ok(existsSync(domConfigPath));
  assert.equal(JSON.parse(readFileSync(domConfigPath, 'utf8')).strategy, 'search-unit-key-2026');

  const bad = await analyzeDomOnServer({ serverUrl, token: TOKENS.extension, html: '<html><body>x</body></html>' });
  assert.equal(bad.status, 422);
  assert.equal((await getDomConfigFromServer({ serverUrl, token: TOKENS.extension })).config.strategy, 'search-unit-key-2026', '分析失败不覆盖已有配置');

  await server.stop();
  server = await startServer({ dbPath, domConfigPath, port: 0 });
  const serverUrl2 = `ws://127.0.0.1:${server.port}`;
  assert.equal((await getDomConfigFromServer({ serverUrl: serverUrl2, token: TOKENS.extension })).config.strategy, 'search-unit-key-2026', '重启后仍在');
  assert.equal((await clearDomConfigOnServer({ serverUrl: serverUrl2, token: TOKENS.extension })).config, null);
  assert.equal((await getDomConfigFromServer({ serverUrl: serverUrl2, token: TOKENS.extension })).config, null);
  await server.stop();
});

test('端到端：默认配置识别不了的页面 → 抓取 DOM → 后端分析 → 写入 storage → 观察器立即按新配置监听', async () => {
  const server = await startServer({});
  const serverUrl = `ws://127.0.0.1:${server.port}`;
  const { bg, results } = offlineBackground();
  const html = newUiHtml('data-x-turn-key', 'data-x-ids');
  const page = openChatGPTPage({ url: CONV_URL, tabId: 7, background: bg, html });
  await waitFor(() => results.some((x) => x.m.event.event_type === 'page.opened'), { label: 'opened' });
  await sleep(300);
  assert.equal(results.filter((x) => x.m.event.event_type === 'message.added').length, 0, '默认配置识别不了这种结构');

  // 弹窗按钮的流程（后台的 analyzeActiveTab 做的就是这几步）
  const captured = await page.sendToContent({ kind: 'capture_dom' });
  assert.equal(captured.ok, true);
  assert.ok(!/<script|<svg/i.test(captured.page.html), '上传前去掉了 script/svg');
  const r = await analyzeDomOnServer({ serverUrl, token: TOKENS.extension, ...captured.page });
  assert.equal(r.ok, true);
  await page.storage.set({ domConfig: r.config });

  await waitFor(() => results.filter((x) => x.m.event.event_type === 'message.added').length === 4, { label: 'added x4' });
  const added = results.filter((x) => x.m.event.event_type === 'message.added').map((x) => x.m.event.payload);
  assert.deepEqual(added.map((p) => [p.message_id, p.role, p.text]), [
    [U1, 'user', '第一个问题'], [A1, 'assistant', '第一个回答'], [U2, 'user', '第二个问题'], [A2, 'assistant', '第二个回答']
  ]);
  const cfg = await page.sendToContent({ kind: 'get_observer_config' });
  assert.equal(cfg.config.source, 'analyzer');

  // 新配置下流式输出同样逐步上报
  const p = page.doc.querySelector(`[data-dil-message-id="${A2}"] p`);
  for (let i = 0; i < 20; i++) { p.appendChild(page.doc.createTextNode('字')); await sleep(30); }
  await waitFor(() => results.some((x) => x.m.event.event_type === 'generation.finished'), { label: 'finished' });
  const ups = results.filter((x) => x.m.event.event_type === 'message.updated' && x.m.event.payload.message_id === A2);
  assert.ok(ups.length >= 3);
  assert.equal(ups.at(-1).m.event.payload.text, '第二个回答' + '字'.repeat(20));

  // 恢复默认配置
  await page.storage.remove('domConfig');
  assert.equal((await page.sendToContent({ kind: 'get_observer_config' })).config.source, 'default:chatgpt', '回到网站列表里的配置（这里还没同步列表，用默认种子）');
  assert.ok(results.every((x) => x.r.ok));
  page.close();
  await server.stop();
});

test('观察器：配置里的无效选择器回退到内置默认值', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: CONV_URL, runScripts: 'outside-only' });
  dom.window.eval(readFileSync(join(ROOT, 'src/frontend/lib/dom-observer.js'), 'utf8'));
  const O = dom.window.ChatGPTBridgeObserver;
  const c = O.resolveConfig({ source: 'analyzer', message: { selector: '[[bad', role_sources: [{ attr: 'x', pattern: '(' }] }, text: { user: '' } }, dom.window.document);
  assert.equal(c.messageSelector, O.DEFAULT_CONFIG.message.selector);
  assert.equal(c.userText, '');
  assert.ok(c.warnings.some((w) => w.includes('message.selector')));
  assert.ok(c.warnings.some((w) => w.includes('role pattern')));
  assert.ok(c.roleSources.length >= 1);
  dom.window.close();
});
