/**
 * 多站点适配：duck.ai、hark.com（结构按 2026-10 的真实页面精简），以及 ChatGPT 正文去掉代码块工具栏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createBackground } from '../../src/frontend/lib/background-core.js';
import { analyzeDom } from '../../src/backend/src/dom-analyzer.js';
import { ROOT, waitFor, sleep, openChatGPTPage } from '../helpers.js';

const OBSERVER_SRC = readFileSync(join(ROOT, 'src/frontend/lib/dom-observer.js'), 'utf8');
const ACTIONS_SRC = readFileSync(join(ROOT, 'src/frontend/lib/page-actions.js'), 'utf8');
const DUCK_CONV = '90578cf8-b5c3-4664-a126-a3c1a4e0cd18';

const duckHtml = (withAnswer = true) => `<!doctype html><html><head><title>Duck.ai</title></head><body><div id="app">
  <div data-testid="duckai-top-toolbar"><button aria-label="显示边栏">≡</button></div>
  <div>
    <div data-testid="user-message" tabindex="0">
      <h3 style="clip: rect(0px, 0px, 0px, 0px); position: absolute;">你说</h3>
      <div><div><p>如何下载当前页面 DOM</p></div></div>
      <div><button aria-label="复制到剪贴板">c</button><button aria-label="编辑">e</button></div>
    </div>
    ${withAnswer ? `<div id="${DUCK_CONV}-assistant-message-0-1" data-activeresponse="true">
      <h3 data-response-heading="active" style="clip: rect(0px, 0px, 0px, 0px)">Duck.ai 说</h3>
      <div><div tabindex="-1" id="heading-${DUCK_CONV}-assistant-message-0-1"><div aria-live="off"><div aria-hidden="true">*</div>
        <span><span><strong><span><strong>GPT-6</strong></span> Luna</strong></span></span></div></div></div>
      <div><p>在控制台运行：</p>
        <div data-language="js" data-streamdown="code-block">
          <div data-streamdown="code-block-header"><span>js</span></div>
          <div data-streamdown="code-block-actions"><button title="下载文件">d</button><button title="复制代码">c</button></div>
          <div data-streamdown="code-block-body"><pre><code><span><span>(() =&gt; {</span></span><span><span>  console.log(1);</span></span><span><span>})();</span></span></code></pre></div>
        </div>
        <p>完成。</p></div>
      <div data-message-actions="true"><button aria-label="更多操作">…</button><button aria-label="第二意见"><span>第二意见</span></button></div>
    </div>` : ''}
  </div>
  <form data-chat-footer="true"><div data-testid="duckai-chat-input">
    <textarea name="user-prompt" aria-label="回复 Duck.ai"></textarea>
    <button type="submit" aria-label="发送">s</button>
    <button type="button" aria-label="停止生成" disabled>x</button>
  </div></form>
</div></body></html>`;

const harkRow = (id, inner) => `<div data-message-id="${id}" data-entry-kind="message" data-transcript-row=""><div>${inner}</div></div>`;
const harkUser = (id, text) => harkRow(id, `<div data-testid="message-bubble" data-bubble-id="${id}" data-bubble-kind="text">
  <div><div data-message-timestamp-trigger="true"><div dir="auto" data-testid="message-text"><span aria-hidden="true" data-continuous-fill=""></span><span>${text}</span></div></div>
  <time datetime="x" data-testid="message-hover-timestamp"><span>13:24</span></time></div></div>`);
const harkAssistant = (id, html, quote) => harkRow(id, `${quote ? `<div data-testid="reply-chain"><div data-reply-parent="" role="button" aria-label="前往被引用的消息">
  <div data-testid="message-text"><span>${quote}</span></div></div></div>` : ''}
  <div data-testid="message-bubble" data-bubble-id="${id}" data-bubble-kind="text"><div><div data-message-timestamp-trigger="true">
  <div><div dir="auto" data-testid="message-text"><span aria-hidden="true"></span><div class="space-y-4 whitespace-normal">${html}</div></div></div></div>
  <time datetime="x" data-testid="message-hover-timestamp"><span>13:25</span></time></div></div>`);
const harkHtml = () => `<!doctype html><html><head><title>聊天 · Hark</title></head><body><div id="root">
  <div data-testid="chat-column"><div data-testid="message-list">
    ${harkUser('391fb7c1-0592-4d5a-87ee-b96e60926b31', '在卡片上添加快捷操作')}
    ${harkAssistant('57ad3587-4d37-44ac-8455-653d4aaeb4b7', '<p>收到，一起做进看板。</p><p>第二段。</p>', '在卡片上添加快捷操作')}
    ${harkRow('05a051fa-a898-458f-b436-f0054859659c', `<div data-testid="message-bubble" data-bubble-kind="empty"><div data-align="end"><button aria-label="打开 a.html 的预览"><span>a.html</span></button></div></div>`)}
    ${harkRow('34e63b1f-108e-4d3f-a42b-f9b77dd3efe2', `<div role="group" aria-label="打开摘要" data-artifact-card="true" data-testid="summary-card"><div><p>修复步骤</p></div><div data-testid="summary-preview"><ol><li><p>覆盖文件</p></li></ol></div></div>`)}
  </div></div>
  <div data-composer-pill="true"><textarea aria-label="消息输入" data-testid="chat-input"></textarea>
    <button type="button" data-testid="send-button" aria-label="发送消息">s</button></div>
</div></body></html>`;

function runObserver(html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.eval(OBSERVER_SRC);
  const events = [];
  const obs = win.ChatGPTBridgeObserver.createChatGPTObserver({
    document: win.document, window: win, emit: (e) => events.push(e), pollMs: 50, debounceMs: 10
  });
  obs.start();
  return { win, doc: win.document, obs, events, added: () => events.filter((e) => e.event_type === 'message.added').map((e) => e.payload) };
}

test('duck.ai：会话 ID 取自助手消息 id、角色、正文去掉标题/按钮/代码块工具栏、代码按行换行、模型', async () => {
  const { win, obs, events, added } = runObserver(duckHtml(), 'https://duck.ai/');
  assert.equal(obs.getConfig().site, 'duckai');
  assert.equal(events[0].event_type, 'page.opened');
  assert.equal(events[0].conversation_id, `duck-${DUCK_CONV}`);
  const msgs = added();
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.equal(msgs[0].text, '如何下载当前页面 DOM');
  assert.equal(msgs[1].message_id, `${DUCK_CONV}-assistant-message-0-1`);
  assert.equal(msgs[1].text, '在控制台运行：\n\n(() => {\n  console.log(1);\n})();\n\n完成。');
  const st = events.find((e) => e.event_type === 'conversation.status');
  assert.deepEqual(JSON.parse(JSON.stringify(st.payload)), { source: 'duckai', status: 'ok', detail: null, model: 'GPT-6 Luna' });
  obs.stop();
  win.close();
});

test('duck.ai：新聊天时还没有会话 ID，第一条回答出现后切换到该会话并重新上报消息', async () => {
  const { win, doc, obs, events } = runObserver(duckHtml(false), 'https://duck.ai/');
  assert.equal(events[0].conversation_id, null);
  const tmp = new JSDOM(duckHtml(true)).window.document;
  doc.querySelector('[data-testid="user-message"]').after(doc.importNode(tmp.getElementById(`${DUCK_CONV}-assistant-message-0-1`), true));
  const changed = await waitFor(() => events.find((e) => e.event_type === 'conversation.changed'), { label: 'changed' });
  assert.equal(changed.conversation_id, `duck-${DUCK_CONV}`);
  assert.equal(changed.payload.previous_conversation_id, null);
  await waitFor(() => events.filter((e) => e.event_type === 'message.added' && e.conversation_id === `duck-${DUCK_CONV}`).length === 2, { label: 'messages under new conversation' });
  obs.stop();
  win.close();
});

test('hark.com：/chat 为 hark-main，项目页取项目 ID；角色识别、引用文字和时间不进正文', async () => {
  const { win, obs, events, added } = runObserver(harkHtml(), 'https://hark.com/chat');
  assert.equal(obs.getConfig().site, 'hark');
  assert.equal(events[0].conversation_id, 'hark-main');
  const msgs = added();
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [
    ['user', '在卡片上添加快捷操作'],
    ['assistant', '收到，一起做进看板。\n\n第二段。'],
    ['user', 'a.html'],
    ['assistant', '修复步骤\n\n覆盖文件']
  ]);
  assert.equal(msgs[1].message_id, '57ad3587-4d37-44ac-8455-653d4aaeb4b7');
  assert.equal(events.find((e) => e.event_type === 'conversation.status').payload.source, 'hark');
  obs.stop();
  win.close();

  const p = runObserver(harkHtml(), 'https://hark.com/projects/proj_abc123');
  assert.equal(p.events[0].conversation_id, 'hark-proj_abc123');
  p.obs.stop();
  p.win.close();
  const home = runObserver('<html><body><div>主页</div></body></html>', 'https://hark.com/');
  assert.equal(home.events[0].conversation_id, null, '主页不是会话');
  home.obs.stop();
  home.win.close();
});

test('ChatGPT：助手正文去掉代码块工具栏（复制代码 / 启用自动换行）', () => {
  const html = `<html><body><main>
    <div data-chatgpt-search-unit-key="t:1:assistant" data-chatgpt-search-message-ids="11111111-0000-4000-8000-000000000002">
      <div data-dil-message-id="11111111-0000-4000-8000-000000000002"><p>看代码：</p>
        <pre><div data-markdown-copy="exclude" contenteditable="false"><span>JavaScript</span><button>启用自动换行</button><button>复制代码</button></div><code>const a = 1;
const b = 2;</code></pre></div>
    </div></main></body></html>`;
  const { win, obs, added } = runObserver(html, 'https://chatgpt.com/c/6720a1b2-0000-4111-8222-333344445555');
  assert.equal(added()[0].text, '看代码：\n\nconst a = 1;\nconst b = 2;');
  obs.stop();
  win.close();
});

test('后端分析：duck.ai / hark.com 页面返回对应站点适配和识别报告', () => {
  const duck = analyzeDom(duckHtml(), { url: 'https://duck.ai/' });
  assert.equal(duck.ok, true);
  assert.equal(duck.config.strategy, 'site-profile:duckai');
  assert.equal(duck.config.site, 'duckai');
  assert.deepEqual(duck.report.roles, { user: 1, assistant: 1 });
  assert.equal(duck.report.model, 'GPT-6 Luna');
  const hark = analyzeDom(harkHtml(), { url: 'https://hark.com/chat' });
  assert.equal(hark.ok, true);
  assert.deepEqual(hark.report.roles, { user: 2, assistant: 2 });
  assert.equal(hark.report.conversation_id, 'hark-main');
  const empty = analyzeDom(duckHtml(false).replace(/data-testid="user-message"/, 'data-x="1"'), { url: 'https://duck.ai/' });
  assert.equal(empty.ok, false);
});

test('页面操作：Hark 快速回复走 textarea + 发送按钮；duck.ai 不支持重新回答', async () => {
  const { win, doc, obs } = runObserver(harkHtml(), 'https://hark.com/chat');
  win.eval(ACTIONS_SRC);
  const sent = [];
  doc.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    const ta = doc.querySelector('[data-testid="chat-input"]');
    sent.push(ta.value);
    ta.value = '';
  });
  const ctx = {
    document: doc, window: win, actions: obs.getConfig().actions,
    isGenerating: () => obs.isGenerating(), conversationId: () => obs.getConversationId()
  };
  const r = await win.ChatGPTBridgeActions.execute(ctx, { action: 'reply', conversation_id: 'hark-main', text: '你好 Hark' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(sent, ['你好 Hark']);
  const moved = await win.ChatGPTBridgeActions.execute(ctx, { action: 'reply', conversation_id: 'hark-other', text: 'x' });
  assert.equal(moved.code, 'tab_moved');
  obs.stop();
  win.close();

  const d = runObserver(duckHtml(), 'https://duck.ai/');
  d.win.eval(ACTIONS_SRC);
  const r2 = await d.win.ChatGPTBridgeActions.execute({
    document: d.doc, window: d.win, actions: d.obs.getConfig().actions,
    isGenerating: () => false, conversationId: () => d.obs.getConversationId()
  }, { action: 'regenerate', conversation_id: `duck-${DUCK_CONV}` });
  assert.equal(r2.code, 'regenerate_unsupported');
  d.obs.stop();
  d.win.close();
});

test('页面操作：ChatGPT 快速回复走 contenteditable 输入框；重新生成点击对应按钮', async () => {
  const conv = '6720a1b2-0000-4111-8222-999988887777';
  const html = `<!doctype html><html><head><title>ChatGPT</title></head><body><main>
    <article><div data-message-author-role="assistant" data-message-id="msg-1"><div class="markdown"><p>你好</p></div></div></article>
    <form data-chatgpt-composer="true">
      <div id="prompt-textarea" contenteditable="true"></div>
      <button type="button" data-testid="send-button" aria-label="发送">s</button>
    </form>
    <button type="button" aria-label="重新生成回复">r</button>
  </main></body></html>`;
  const { win, doc, obs } = runObserver(html, `https://chatgpt.com/c/${conv}`);
  win.eval(ACTIONS_SRC);
  assert.equal(obs.getConversationId(), conv);
  const sent = [];
  doc.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    const ed = doc.querySelector('[contenteditable="true"]');
    sent.push(ed.textContent);
    ed.textContent = '';
  });
  let generating = false;
  doc.querySelector('[aria-label="重新生成回复"]').addEventListener('click', () => { generating = true; });
  const ctx = {
    document: doc, window: win, actions: obs.getConfig().actions,
    isGenerating: () => generating || obs.isGenerating(), conversationId: () => obs.getConversationId()
  };
  const r = await win.ChatGPTBridgeActions.execute(ctx, { action: 'reply', conversation_id: conv, text: '你好 ChatGPT' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(sent, ['你好 ChatGPT']);
  const r2 = await win.ChatGPTBridgeActions.execute(ctx, { action: 'regenerate', conversation_id: conv });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.detail, '已开始重新生成');
  obs.stop();
  win.close();
});

test('选择器降级：站点改版后旧选择器全失效，观察器不崩、page_info 报告 0 命中', async () => {
  const conv = '6720a1b2-0000-4111-8222-999988887777';
  // 改版后的页面：没有任何旧选择器能命中的标记，但 URL 里仍有会话 ID
  const redesigned = `<!doctype html><html><head><title>ChatGPT</title></head><body><div id="app-v2">
    <section class="thread"><article class="turn" data-kind="assistant"><div class="content"><p>改版后的回答</p></div></article></section>
  </div></body></html>`;

  // 观察器层：不崩，健康度报告 0 命中，page.opened 照常发出
  const o = runObserver(redesigned, `https://chatgpt.com/c/${conv}`);
  await waitFor(() => o.events.some((e) => e.event_type === 'page.opened'), { label: 'page.opened' });
  const health = o.obs.getSelectorHealth();
  assert.equal(health.message_selector_hits, 0);
  assert.ok(Array.isArray(health.warnings));
  o.obs.stop();
  o.win.close();

  // 内容脚本层：page_info 把健康度带给后台
  class NoopWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const bg = createBackground({
    WebSocketImpl: NoopWS, storage: null, clientId: 'ext-health-0001',
    settings: { serverUrl: 'ws://127.0.0.1:1', token: 'x' },
    executeCommand: async () => ({ ok: true })
  });
  const page = openChatGPTPage({ url: `https://chatgpt.com/c/${conv}`, tabId: 11, background: bg, html: redesigned });
  const info = await waitFor(async () => {
    const r = await page.sendToContent({ kind: 'page_info' });
    return r && r.ok ? r : null;
  }, { label: 'page_info ok' });
  assert.equal(info.conversation_id, conv);
  assert.equal(info.selector_health.message_selector_hits, 0);
  assert.ok(Array.isArray(info.selector_health.warnings));
  page.close();
});

// ---------------------------------------------------------------------------
// 新默认站点种子：meta.ai / muse.ai（2026-10-19）
// 注意：两站选择器均为未验证的保守通用配置（见 SITE_PROFILES 注释），非实测 DOM；
// 断言的是“配置按假设工作”，真实选择器待看板 probe_site 细化。
// ---------------------------------------------------------------------------

test('新种子：meta.ai / muse.ai 按域名找到对应站点配置', () => {
  const { win, obs } = runObserver('<!doctype html><html><head><title>x</title></head><body></body></html>', 'https://www.meta.ai/');
  const O = win.ChatGPTBridgeObserver;
  assert.equal(O.findSite('www.meta.ai').key, 'metai');
  assert.equal(O.findSite('meta.ai').key, 'metai');
  assert.equal(O.findSite('muse.ai').key, 'muse');
  assert.equal(O.siteHosts(O.findSite('www.meta.ai')).join(','), 'meta.ai');
  // 种子顺序：chatgpt、duck.ai、hark 之后是 meta.ai、muse.ai
  assert.equal(O.SEED_SITES.map((s) => s.key).join(','), 'chatgpt,duckai,hark,metai,muse');
  obs.stop();
  win.close();
});

test('muse.ai：generating 选择器故意留空（防卡“回答中”）；健康度可观测', async () => {
  const { win, obs, events } = runObserver(
    '<!doctype html><html><head><title>Muse</title></head><body><div id="app"></div></body></html>',
    'https://muse.ai/');
  await waitFor(() => events.some((e) => e.event_type === 'page.opened'), { label: 'page.opened' });
  const cfg = obs.getConfig();
  assert.equal(cfg.site, 'muse');
  // 解析后的 generating 选择器为空：不猜停止按钮，防卡“回答中”
  const O = win.ChatGPTBridgeObserver;
  const resolved = O.resolveConfig(null, win.document, O.SITE_PROFILES.muse);
  assert.equal(resolved.generating, '', 'generating 选择器留空，不猜停止按钮');
  assert.equal(obs.isGenerating(), false);
  // 选择器未验证，0 命中属预期，且能被后台观测到（等 probe 拿回真实 DOM 后写实）
  assert.equal(obs.getSelectorHealth().message_selector_hits, 0);
  obs.stop(); win.close();
});

test('meta.ai：generating 选择器故意留空（防卡“回答中”）；健康度可观测', async () => {
  const { win, obs, events } = runObserver(
    '<!doctype html><html><head><title>Meta AI</title></head><body><div id="app"></div></body></html>',
    'https://www.meta.ai/');
  await waitFor(() => events.some((e) => e.event_type === 'page.opened'), { label: 'page.opened' });
  const cfg = obs.getConfig();
  assert.equal(cfg.site, 'metai');
  // 解析后的 generating 选择器为空：不猜停止按钮，防卡“回答中”
  const O = win.ChatGPTBridgeObserver;
  const resolved = O.resolveConfig(null, win.document, O.SITE_PROFILES.metai);
  assert.equal(resolved.generating, '', 'generating 选择器留空，不猜停止按钮');
  assert.equal(obs.isGenerating(), false);
  // 选择器未验证，0 命中属预期，且能被后台观测到（等 probe_site 细化）
  assert.equal(obs.getSelectorHealth().message_selector_hits, 0);
  obs.stop(); win.close();
});

test('插件后台：focus 指令交给后台切换标签页（不经过内容脚本），会话不符时拒绝', async () => {
  class NoopWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const calls = [];
  const bg = createBackground({
    WebSocketImpl: NoopWS, storage: null, clientId: 'ext-focus-0001', settings: { serverUrl: 'ws://127.0.0.1:1', token: 'x' },
    executeCommand: async (tabId, cmd) => { calls.push([tabId, cmd.action]); return { ok: true }; }
  });
  const page = openChatGPTPage({ url: 'https://hark.com/chat', tabId: 7, background: bg, html: harkHtml() });
  await waitFor(() => bg.tabs.get(7)?.conversation_id === 'hark-main', { label: 'tab registered' });
  assert.deepEqual(await bg.conn.onCommand({ command_id: 'cmdfocus0001', action: 'focus', conversation_id: 'hark-main', tab_id: 7 }), { ok: true });
  assert.deepEqual(calls, [[7, 'focus']]);
  const r = await bg.conn.onCommand({ command_id: 'cmdfocus0002', action: 'focus', conversation_id: 'hark-x', tab_id: 7 });
  assert.equal(r.code, 'tab_moved');
  await sleep(10);
  page.close();
});

test('正文里的图片和下载链接：观察器转成 ![]() / [](url "download")，普通链接保持文字', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="m"><p>看图：</p><img src="https://files.example.com/a.png" alt="结果图"><img src="data:image/png;base64,xx" alt="内联">
    <p>文件 <a href="https://files.example.com/out/report.pdf">report.pdf</a>，下载 <a href="https://x.example.com/get?id=1" download>数据</a>，参考 <a href="https://example.com/page">这里</a>。</p>
    <button><img src="https://files.example.com/icon.png"></button></div></body>`, { url: 'https://chatgpt.com/c/abc12345', runScripts: 'outside-only' });
  dom.window.eval(OBSERVER_SRC);
  const O = dom.window.ChatGPTBridgeObserver;
  const text = O.extractText(dom.window.document.getElementById('m'), 'button');
  assert.match(text, /!\[结果图\]\(https:\/\/files\.example\.com\/a\.png\)/);
  assert.doesNotMatch(text, /data:image|icon\.png/);
  assert.match(text, /\[report\.pdf\]\(https:\/\/files\.example\.com\/out\/report\.pdf "download"\)/);
  assert.match(text, /\[数据\]\(https:\/\/x\.example\.com\/get\?id=1 "download"\)/);
  assert.match(text, /参考 这里。/);
});
