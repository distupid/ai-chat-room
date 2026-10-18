/**
 * 网站全部可配置：ChatGPT / Duck.ai / Hark 只是默认种子，和看板添加的网站一样在网站列表里可编辑（DOM 配置、域名、启用）、删除、恢复默认；
 * 插件 / 内容脚本按域名从同步的网站列表里选配置，没有列表时才用种子。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createBridgeServer } from '../../src/backend/src/server.js';
import { createBackground } from '../../src/frontend/lib/background-core.js';
import {
  ROOT, CLIENTS, TOKENS, TestClient, startServer, waitFor, sleep, tmpDb, memoryStorage, openChatGPTPage, openDashboard
} from '../helpers.js';

const OBSERVER_SRC = readFileSync(join(ROOT, 'src/frontend/lib/dom-observer.js'), 'utf8');

function observerLib() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.com/', runScripts: 'outside-only' });
  dom.window.eval(OBSERVER_SRC);
  return { O: dom.window.ChatGPTBridgeObserver, close: () => dom.window.close() };
}

const apiOf = (server) => (path, { method = 'GET', body, token = TOKENS.observer } = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

function offlineBackground() {
  const results = [];
  const bg = createBackground({ WebSocketImpl: class {}, storage: memoryStorage(), clientId: 'ext-sitecfg-0001', settings: { serverUrl: 'ws://127.0.0.1:1', token: '' } });
  const orig = bg.handleRuntimeMessage.bind(bg);
  bg.handleRuntimeMessage = (m, s) => { const r = orig(m, s); results.push({ m, r }); return r; };
  return { bg, results };
}

test('默认种子：按域名找网站（本域名 / 子域名 / www / 其他域名），网站列表优先，找不到返回 null', () => {
  const { O, close } = observerLib();
  assert.deepEqual([...O.SEED_SITES.map((x) => x.key)], ['chatgpt', 'duckai', 'hark']);
  assert.ok(O.SEED_SITES.every((x) => x.config && x.config.message && x.enabled === true));
  assert.equal(O.siteForHost('chat.openai.com'), 'chatgpt');
  assert.equal(O.siteForHost('chatgpt.com'), 'chatgpt');
  assert.equal(O.siteForHost('www.hark.com'), 'hark');
  assert.equal(O.siteForHost('hark.com'), 'hark');
  assert.equal(O.siteForHost('x.duck.ai'), 'duckai');
  assert.equal(O.siteForHost('notduck.ai'), null, '只匹配本域名或子域名');
  assert.equal(O.siteForHost('kimi.moonshot.cn'), null);
  const list = [{ key: 'moonshot', host: 'kimi.moonshot.cn', config: {} }, { key: 'mine', host: 'duck.ai', hosts: [], config: {} }];
  assert.equal(O.siteForHost('kimi.moonshot.cn', list), 'moonshot');
  assert.equal(O.siteForHost('duck.ai', list), 'mine', '列表里的配置优先于种子');
  assert.equal(O.siteForHost('chatgpt.com', list), null, '有列表时不再看种子（种子网站被删除了）');
  assert.equal(O.sourceFromUrl('https://kimi.moonshot.cn/chat/1'), 'moonshot');
  close();
});

test('后端网站列表：首次启动写入默认种子（含 DOM 配置）；编辑 DOM 配置 / 域名 / 停用 → 通知插件同步；恢复默认；删除后可恢复默认网站', async () => {
  const server = await startServer();
  const api = apiOf(server);
  const ext = await new TestClient(server.url).open();
  await ext.hello('ext-sitecfg-0002', TOKENS.extension, 'extension');

  const list = await (await api('/api/sites')).json();
  assert.deepEqual(list.sites.map((x) => x.key), ['chatgpt', 'duckai', 'hark']);
  assert.deepEqual(list.missing_defaults, []);
  for (const x of list.sites) {
    assert.equal(x.enabled, true);
    assert.equal(x.has_default, true);
    assert.equal(x.config.site, x.key);
    assert.match(x.config.source, /^default:/);
    assert.ok(Array.isArray(x.hosts));
  }
  assert.deepEqual(list.sites.find((x) => x.key === 'chatgpt').hosts, ['chatgpt.com', 'chat.openai.com']);
  assert.ok(list.sites.find((x) => x.key === 'duckai').config.conversation.dom, '会话 ID 规则也在配置里');

  // 编辑 DOM 配置（选择器、会话 ID 规则）
  const duck = list.sites.find((x) => x.key === 'duckai');
  const cfg = { ...duck.config, message: { ...duck.config.message, selector: '.my-msg' }, conversation: { ...duck.config.conversation, prefix: 'dk-' } };
  const syncs = () => ext.of('command').filter((m) => m.action === 'sync_sites').length;
  const s0 = syncs();
  const r = await (await api('/api/sites/duckai', { method: 'PATCH', body: { config: cfg, hosts: ['duck.ai', 'duckduckgo.com'] } })).json();
  assert.equal(r.site.config.message.selector, '.my-msg');
  assert.equal(r.site.config.conversation.prefix, 'dk-');
  assert.deepEqual(r.site.hosts, ['duck.ai', 'duckduckgo.com']);
  assert.ok(r.site.updated_at > 0);
  await waitFor(() => syncs() > s0, { label: 'sync after config' });

  // 校验
  assert.equal((await api('/api/sites/duckai', { method: 'PATCH', body: { config: [1] } })).status, 400);
  assert.equal((await api('/api/sites/duckai', { method: 'PATCH', body: { config: 'x' } })).status, 400);
  assert.equal((await api('/api/sites/duckai', { method: 'PATCH', body: { enabled: 'no' } })).status, 400);
  assert.equal((await api('/api/sites/duckai', { method: 'PATCH', body: { hosts: ['not a host'] } })).status, 400);
  assert.equal((await api('/api/sites/duckai', { method: 'PATCH', body: { hosts: ['chatgpt.com'] } })).status, 409, '域名不能和其他网站重复');
  assert.equal((await api('/api/sites/duckai', { method: 'PATCH', body: { config: { a: 'x'.repeat(140 * 1024) } } })).status, 413);
  assert.equal((await api('/api/sites/duckai', { method: 'PATCH', body: { enabled: false }, token: TOKENS.extension })).status, 403);

  // 停用：一键启动跳过
  const s1 = syncs();
  assert.equal((await (await api('/api/sites/chatgpt', { method: 'PATCH', body: { enabled: false } })).json()).site.enabled, false);
  await waitFor(() => syncs() > s1, { label: 'sync after disable' });
  const ln = await (await api('/api/sites/launch', { method: 'POST' })).json();
  assert.equal(ln.count, 2);
  const open = await waitFor(() => ext.of('command').find((m) => m.action === 'open_sites'), { label: 'open_sites' });
  assert.doesNotMatch(open.text, /chatgpt/);

  // 恢复默认配置
  const rs = await (await api('/api/sites/duckai/reset', { method: 'POST' })).json();
  assert.equal(rs.site.config.message.selector, duck.config.message.selector);
  assert.deepEqual(rs.site.hosts, ['duck.ai']);
  assert.equal((await api('/api/sites/nope/reset', { method: 'POST' })).status, 404);

  // 删除默认网站 → missing_defaults → 恢复默认网站
  assert.equal((await api('/api/sites/hark', { method: 'DELETE' })).status, 200);
  const l2 = await (await api('/api/sites')).json();
  assert.deepEqual(l2.missing_defaults, ['hark']);
  const rd = await (await api('/api/sites/defaults', { method: 'POST' })).json();
  assert.deepEqual(rd.added, ['hark']);
  const l3 = await (await api('/api/sites')).json();
  assert.ok(l3.sites.some((x) => x.key === 'hark' && x.config));
  assert.deepEqual(l3.missing_defaults, []);
  ext.close();
  await server.stop();
});

test('旧版 sites.json（默认网站没有 DOM 配置）：启动时补上种子配置和域名并写回；用户改过的名称保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-sites-'));
  const sitesPath = join(dir, 'sites.json');
  writeFileSync(sitesPath, JSON.stringify([
    { key: 'chatgpt', name: 'GPT', url: 'https://chatgpt.com/', host: 'chatgpt.com', seeded: true },
    { key: 'example', name: 'Example', url: 'https://chat.example.com/', host: 'chat.example.com', config: { site: 'example', message: { selector: '.m' } }, seeded: true }
  ]));
  const server = createBridgeServer({ dbPath: tmpDb(), port: 0, clients: CLIENTS, quiet: true, sitesPath });
  await server.start();
  const list = await (await apiOf(server)('/api/sites')).json();
  assert.deepEqual(list.sites.map((x) => x.key), ['chatgpt', 'example'], '删掉的默认网站不会自动回来');
  const gpt = list.sites[0];
  assert.equal(gpt.name, 'GPT');
  assert.equal(gpt.config.source, 'default:chatgpt');
  assert.deepEqual(gpt.hosts, ['chatgpt.com', 'chat.openai.com']);
  assert.equal(list.sites[1].has_default, false);
  assert.deepEqual(list.missing_defaults, ['duckai', 'hark']);
  const saved = JSON.parse(readFileSync(sitesPath, 'utf8'));
  assert.ok(saved[0].config && saved[0].config.message, '写回文件');
  await server.stop();
});

test('内容脚本：按域名从同步的网站列表选配置（编辑过的选择器生效）；停用的网站不观察，重新启用后开始观察；没有列表时用默认种子', async () => {
  const { bg, results } = offlineBackground();
  const events = () => results.map((x) => x.m.event).filter(Boolean);
  // 一个任意网站：配置完全来自网站列表
  const html = `<!doctype html><html><head><title>My Chat</title></head><body>
    <div class="q" data-id="q1">你好</div><div class="a" data-id="a1">你好，有什么可以帮你？</div></body></html>`;
  const siteList = [{
    key: 'mychat', host: 'chat.mine.dev', hosts: [], enabled: true, updated_at: 1,
    config: {
      site: 'mychat', conversation: { url_pattern: '/c/([a-z0-9]+)', prefix: 'my-' },
      message: { selector: '.q, .a', role_sources: [], role_rules: [{ selector: '.q', role: 'user', scope: 'self' }, { selector: '.a', role: 'assistant', scope: 'self' }], id_attrs: ['data-id'], id_inner: null },
      text: { user: '', assistant: '', exclude: 'button' }, generating: { selector: '', activity_idle_ms: 0 }
    }
  }, { key: 'duckai', host: 'duck.ai', hosts: ['duck.ai'], enabled: false, config: { site: 'duckai' } }];
  const page = openChatGPTPage({ url: 'https://chat.mine.dev/c/abc123', tabId: 3, background: bg, html, storage: { siteList } });
  await waitFor(() => events().filter((e) => e.event_type === 'message.added').length === 2, { label: 'messages via site list' });
  const added = events().filter((e) => e.event_type === 'message.added');
  assert.deepEqual(added.map((e) => [e.conversation_id, e.payload.role, e.payload.text]), [
    ['my-abc123', 'user', '你好'], ['my-abc123', 'assistant', '你好，有什么可以帮你？']
  ]);
  assert.equal(events().find((e) => e.event_type === 'conversation.status').payload.source, 'mychat');
  // 看板改了配置（插件同步到 siteList）→ 立即按新配置观察
  const next = JSON.parse(JSON.stringify(siteList));
  next[0].config.conversation.prefix = 'mine-';
  await page.storage.set({ siteList: next });
  await waitFor(() => events().some((e) => e.event_type === 'message.added' && e.conversation_id === 'mine-abc123'), { label: 'new config applied' });
  page.close();

  // 停用的网站：不观察
  const n0 = results.length;
  const duck = openChatGPTPage({ url: 'https://duck.ai/', tabId: 4, background: bg, html: '<html><body><div data-testid="user-message">hi</div></body></html>', storage: { siteList } });
  await sleep(300);
  assert.equal(results.length, n0, '停用的网站没有任何事件');
  assert.equal((await duck.sendToContent({ kind: 'page_info' })).ok, false);
  const on = JSON.parse(JSON.stringify(siteList));
  on[1] = { key: 'duckai', host: 'duck.ai', hosts: ['duck.ai'], enabled: true, config: null };
  await duck.storage.set({ siteList: on });
  await waitFor(() => results.slice(n0).some((x) => x.m.event?.event_type === 'page.opened'), { label: 'enabled starts observer' });
  duck.close();

  // 没有网站列表（第一次离线启动）：用默认种子
  const gpt = openChatGPTPage({ url: 'https://chat.openai.com/c/6720a1b2-0000-4111-8222-000011112222', tabId: 5, background: bg,
    html: '<html><body><div data-message-author-role="user" data-message-id="u-1"><div class="whitespace-pre-wrap">种子</div></div></body></html>' });
  await waitFor(() => results.some((x) => x.m.event?.event_type === 'message.added' && x.m.event.payload.text === '种子'), { label: 'seed fallback' });
  assert.equal((await gpt.sendToContent({ kind: 'get_observer_config' })).config.site, 'chatgpt');
  gpt.close();
});

test('看板：网站配置弹窗（启用开关、域名、常用选择器与完整 JSON 双向同步、恢复默认）；空状态文案不写死网站名', async () => {
  const server = await startServer();
  const api = apiOf(server);
  const ui = await openDashboard(server);
  const { d } = ui;
  await waitFor(() => /网站列表/.test(d.getElementById('grid').textContent), { label: 'generic empty state' });
  assert.doesNotMatch(d.getElementById('grid').textContent, /ChatGPT|Duck\.ai|Hark/);

  d.getElementById('sitesBtn').click();
  await waitFor(() => d.querySelectorAll('#sitesMenu .mi .cfg').length === 3, { label: 'cfg buttons' });
  d.querySelector('#sitesMenu [data-site="hark"] .cfg').click();
  assert.ok(d.getElementById('siteCfgScrim').classList.contains('open'));
  assert.match(d.getElementById('siteCfgTitle').textContent, /Hark/);
  assert.equal(d.getElementById('siteCfgReset').hidden, false, '默认网站可恢复默认');
  const field = d.querySelector('#siteCfgFields input[data-path="message.selector"]');
  assert.equal(field.value, '[data-entry-kind="message"][data-message-id]');
  field.value = '.row-msg';
  field.dispatchEvent(new d.defaultView.Event('input'));
  assert.equal(JSON.parse(d.getElementById('siteCfgJson').value).message.selector, '.row-msg', '常用项写进完整 JSON');
  const j = JSON.parse(d.getElementById('siteCfgJson').value);
  j.conversation.prefix = 'hk-';
  d.getElementById('siteCfgJson').value = JSON.stringify(j);
  d.getElementById('siteCfgJson').dispatchEvent(new d.defaultView.Event('change'));
  assert.equal(d.querySelector('#siteCfgFields input[data-path="conversation.prefix"]').value, 'hk-', '完整 JSON 改动同步到常用项');
  d.getElementById('siteCfgEnabled').click();
  d.getElementById('siteCfgHosts').value = 'hark.com, hark.ai';
  d.getElementById('siteCfgSave').click();
  await waitFor(() => !d.getElementById('siteCfgScrim').classList.contains('open'), { label: 'saved' });
  const hark = (await (await api('/api/sites')).json()).sites.find((x) => x.key === 'hark');
  assert.equal(hark.enabled, false);
  assert.deepEqual(hark.hosts, ['hark.com', 'hark.ai']);
  assert.equal(hark.config.message.selector, '.row-msg');
  assert.equal(hark.config.conversation.prefix, 'hk-');
  d.getElementById('sitesBtn').click();
  await waitFor(() => d.querySelector('#sitesMenu [data-site="hark"].off .off-tag'), { label: 'disabled tag' });

  // 无效 JSON 不提交
  d.querySelector('#sitesMenu [data-site="hark"] .cfg').click();
  d.getElementById('siteCfgJson').value = '{ bad';
  d.getElementById('siteCfgSave').click();
  await sleep(50);
  assert.match(d.getElementById('siteCfgErr').textContent, /JSON/);
  // 恢复默认
  d.getElementById('siteCfgReset').click();
  await waitFor(async () => (await (await api('/api/sites')).json()).sites.find((x) => x.key === 'hark').config.message.selector === '[data-entry-kind="message"][data-message-id]', { label: 'reset' });
  await waitFor(() => d.querySelector('#siteCfgFields input[data-path="message.selector"]')?.value === '[data-entry-kind="message"][data-message-id]', { label: 'dialog refreshed' });
  d.getElementById('siteCfgCancel').click();

  // 删除默认网站后菜单里没有“恢复默认网站”
  d.getElementById('sitesBtn').click();
  await waitFor(() => d.querySelector('#sitesMenu [data-site="duckai"] .del'), { label: 'menu' });
  d.querySelector('#sitesMenu [data-site="duckai"] .del').click();
  await waitFor(() => !d.querySelector('#sitesMenu [data-site="duckai"]'), { label: 'deleted' });
  assert.ok(!d.querySelector('#sitesMenu [data-site="restore"], #sitesMenu .mi.restore'), '没有恢复默认');

  assert.equal(ui.win.__appError, undefined, String(ui.win.__appError?.stack));
  assert.deepEqual(ui.errors, []);
  ui.close();
  await server.stop();
});
