/**
 * dom-observer.js 回归测试：每个产出的事件都要能通过后台的共享 Schema 校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackground } from '../../src/frontend/lib/background-core.js';
import { openChatGPTPage, chatHtml, waitFor, sleep } from '../helpers.js';

const CONV_URL = 'https://chatgpt.com/c/6720a1b2-0000-4111-8222-999988887777';

/** 不连后端的后台：只做 Schema 校验并记录结果 */
function offlineBackground() {
  class NoopWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const bg = createBackground({
    WebSocketImpl: NoopWS, storage: null, clientId: 'ext-offline-0001',
    settings: { serverUrl: 'ws://127.0.0.1:1', token: 'x' }
  });
  const results = [];
  const orig = bg.handleRuntimeMessage;
  bg.handleRuntimeMessage = (m, s) => { const r = orig(m, s); results.push({ m, r }); return r; };
  return { bg, results };
}

test('所有事件都通过共享 Schema（含 truncated、generation_sequence、pagehide）', async () => {
  const { bg, results } = offlineBackground();
  const long = 'x'.repeat(60010);
  const page = openChatGPTPage({
    url: CONV_URL, tabId: 1, background: bg,
    html: chatHtml([{ role: 'user', id: 'u-1', text: '你好' }, { role: 'assistant', id: 'a-1', text: long }], { generating: true })
  });
  await waitFor(() => results.some((x) => x.m.event.event_type === 'generation.started'), { label: 'started' });
  page.doc.querySelector('[data-testid="stop-button"]').setAttribute('data-testid', 'send-button');
  await waitFor(() => results.some((x) => x.m.event.event_type === 'generation.finished'), { label: 'finished' });
  page.win.dispatchEvent(new page.win.Event('pagehide'));
  await waitFor(() => results.some((x) => x.m.event.event_type === 'page.closed'), { label: 'closed' });

  const rejected = results.filter((x) => !x.r.ok);
  assert.deepEqual(rejected.map((x) => [x.m.event.event_type, x.r.error]), []);
  const asst = results.find((x) => x.m.event.payload.message_id === 'a-1').m.event.payload;
  assert.equal(asst.truncated, true);
  assert.equal(asst.text.length, 60000);
  assert.equal(asst.text_length, 60010);
  assert.equal(results.find((x) => x.m.event.event_type === 'generation.started').m.event.payload.generation_sequence, 1);
  assert.equal(results.find((x) => x.m.event.event_type === 'page.closed').m.event.payload.reason, 'pagehide');
  page.close();
});

test('没有 data-message-id 时，流式输出不会被当成多条新消息', async () => {
  const { bg, results } = offlineBackground();
  const page = openChatGPTPage({
    url: CONV_URL, tabId: 2, background: bg,
    html: '<!doctype html><html><body><main id="t"><div data-message-author-role="user">问题</div></main></body></html>'
  });
  await waitFor(() => results.some((x) => x.m.event.event_type === 'message.added'), { label: 'user added' });
  const node = page.doc.createElement('div');
  node.setAttribute('data-message-author-role', 'assistant');
  page.doc.getElementById('t').appendChild(node);
  for (const chunk of ['第一段', '第二段', '第三段', '第四段']) {
    node.appendChild(page.doc.createTextNode(chunk));
    await sleep(350);
  }
  await sleep(1000);
  const added = results.filter((x) => x.m.event.event_type === 'message.added');
  const updated = results.filter((x) => x.m.event.event_type === 'message.updated');
  assert.equal(added.length, 2, '用户 1 条 + 助手 1 条');
  assert.equal(added[1].m.event.payload.message_id, 'fallback:assistant:1');
  assert.ok(updated.length >= 1);
  assert.ok(updated.every((x) => x.m.event.payload.message_id === 'fallback:assistant:1'));
  assert.equal(updated.at(-1).m.event.payload.text, '第一段第二段第三段第四段');
  assert.ok(results.every((x) => x.r.ok));
  page.close();
});

test('页面刷新：消息的 message.added 的 event_id 不变，page.opened 每次都是新的', async () => {
  const html = chatHtml([{ role: 'user', id: 'u-9', text: '同一条消息' }]);
  const a = offlineBackground();
  const b = offlineBackground();
  const p1 = openChatGPTPage({ url: CONV_URL, tabId: 3, background: a.bg, html });
  const p2 = openChatGPTPage({ url: CONV_URL, tabId: 3, background: b.bg, html });
  await waitFor(() => a.results.length >= 2 && b.results.length >= 2, { label: 'both scanned' });
  const id = (r, t) => r.results.find((x) => x.m.event.event_type === t).m.event.event_id;
  assert.equal(id(a, 'message.added'), id(b, 'message.added'));
  assert.notEqual(id(a, 'page.opened'), id(b, 'page.opened'));
  p1.close(); p2.close();
});

test('SPA 切换会话：A→B→A→B 每次 conversation.changed 都是新事件', async () => {
  const { bg, results } = offlineBackground();
  const page = openChatGPTPage({ url: CONV_URL, tabId: 4, background: bg, html: chatHtml([]) });
  // 内容脚本先异步读取 DOM 配置再启动观察器
  await waitFor(() => results.some((x) => x.m.event.event_type === 'page.opened'), { label: 'opened' });
  const other = 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  for (const u of [other, CONV_URL, other]) {
    page.win.history.pushState({}, '', u);
    page.win.dispatchEvent(new page.win.PopStateEvent('popstate'));
    await sleep(300);
  }
  const changes = results.filter((x) => x.m.event.event_type === 'conversation.changed');
  assert.equal(changes.length, 3);
  assert.equal(new Set(changes.map((x) => x.m.event.event_id)).size, 3);
  page.close();
});

test('生成期间约每 100ms 上报一次 message.updated（逐字输出）', async () => {
  const { bg, results } = offlineBackground();
  const page = openChatGPTPage({
    url: CONV_URL, tabId: 5, background: bg,
    html: chatHtml([{ role: 'user', id: 'u-1', text: '写点东西' }, { role: 'assistant', id: 'a-s', text: '' }], { generating: true })
  });
  await waitFor(() => results.some((x) => x.m.event.event_type === 'generation.started'), { label: 'started' });
  const node = page.doc.querySelector('[data-message-id="a-s"] .markdown');
  // 每 20ms 追加一个字，持续约 1.5 秒（DOM 持续变化，防抖不能把扫描一直推迟）
  for (let i = 0; i < 75; i++) {
    node.appendChild(page.doc.createTextNode('字'));
    await sleep(20);
  }
  page.doc.querySelector('[data-testid="stop-button"]').setAttribute('data-testid', 'send-button');
  await waitFor(() => results.some((x) => x.m.event.event_type === 'generation.finished'), { label: 'finished' });
  const ups = results.filter((x) => x.m.event.event_type === 'message.updated' && x.m.event.payload.message_id === 'a-s');
  assert.ok(ups.length >= 8, `1.5 秒内应有至少 8 次更新，实际 ${ups.length}`);
  assert.equal(ups.at(-1).m.event.payload.text, '字'.repeat(75));
  const lens = ups.map((x) => x.m.event.payload.text_length);
  assert.deepEqual(lens, [...lens].sort((a, b) => a - b), '文本长度单调递增');
  assert.ok(results.every((x) => x.r.ok));
  page.close();
});

// 2026-10 实测的新版 ChatGPT 结构（去掉了无关属性和样式）：没有 data-message-author-role / data-message-id，
// 也没有 stop-button；角色写在 data-chatgpt-search-unit-key 的末尾。
function newUiHtml() {
  return `<!doctype html><html><head><title>ChatGPT</title></head><body><main id="thread">
    <div class="group/user-message" data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="u-uuid-1">
      <div data-content-search-unit-key="fallback-turn-0:0:user"><div data-user-message-bubble="true">
        <div class="text-size-chat whitespace-pre-wrap" dir="auto">怎么把当前 dom 下载下来</div></div>
        <button aria-label="复制消息">复制</button><button aria-label="编辑消息">编辑</button></div>
    </div>
    <div data-content-search-unit-key="fallback-turn-0:1:assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant" data-chatgpt-search-message-ids="a-uuid-1 a-uuid-1">
      <div class="DilResponseRoot" data-dil-message-id="a-uuid-1"><p><span data-d-stream-word="">最简单：</span><span data-d-stream-word="">按 F12</span></p></div>
      <button aria-label="复制">复制</button>
    </div>
  </main><form data-chatgpt-composer=""><button aria-label="开始语音">x</button></form></body></html>`;
}

test('新版页面结构：识别角色、消息 ID、正文，并通过文本活动检测生成开始/结束', async () => {
  const { bg, results } = offlineBackground();
  const page = openChatGPTPage({ url: CONV_URL, tabId: 6, background: bg, html: newUiHtml() });
  await waitFor(() => results.filter((x) => x.m.event.event_type === 'message.added').length >= 2, { label: 'added x2' });
  const added = results.filter((x) => x.m.event.event_type === 'message.added').map((x) => x.m.event.payload);
  assert.deepEqual(added.map((p) => [p.message_id, p.role, p.text]), [
    ['u-uuid-1', 'user', '怎么把当前 dom 下载下来'],
    ['a-uuid-1', 'assistant', '最简单：按 F12']
  ]);
  assert.ok(!results.some((x) => x.m.event.event_type === 'generation.started'), '加载历史消息不算生成');

  // 新的一轮：助手回复逐词出现
  const unit = page.doc.createElement('div');
  unit.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-1:1:assistant');
  unit.setAttribute('data-chatgpt-search-message-ids', 'a-uuid-2 a-uuid-2');
  unit.innerHTML = '<div class="DilResponseRoot" data-dil-message-id="a-uuid-2"><p></p></div><button aria-label="复制">复制</button>';
  page.doc.getElementById('thread').appendChild(unit);
  const p = unit.querySelector('p');
  for (let i = 0; i < 40; i++) {
    const s = page.doc.createElement('span');
    s.setAttribute('data-d-stream-word', '');
    s.textContent = '词' + i + ' ';
    p.appendChild(s);
    await sleep(25);
  }
  await waitFor(() => results.some((x) => x.m.event.event_type === 'generation.finished'), { label: 'finished', timeout: 5000 });
  const evs = results.map((x) => x.m.event);
  const ups = evs.filter((e) => e.event_type === 'message.updated' && e.payload.message_id === 'a-uuid-2');
  assert.ok(evs.some((e) => e.event_type === 'generation.started'));
  assert.ok(ups.length >= 5, `应有多次逐步更新，实际 ${ups.length}`);
  assert.ok(!ups.at(-1).payload.text.includes('复制'), '按钮文字不算正文');
  assert.equal(ups.at(-1).payload.text.split(' ').filter(Boolean).length, 40);
  assert.equal(evs.find((e) => e.event_type === 'generation.finished').payload.message_id, 'a-uuid-2');
  assert.ok(results.every((x) => x.r.ok));
  page.close();
});
