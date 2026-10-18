/**
 * 虚拟列表 + 分组消息（结构按 2026-10 Muse 页面精简）：
 * - 滚出视口的消息只剩读屏替身（data-message-accessibility-surrogate，“助手消息：……”）
 * - 一轮回答拆成 文字 + 文件卡片 + 文字 多个节点，共用 data-message-turn-id
 * - 代码块每行一个 span.block，行间没有换行符；代码块工具栏、sr-only“你：”不进正文
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDom } from '../../src/backend/src/dom-analyzer.js';
import { createBackground } from '../../src/frontend/lib/background-core.js';
import { memoryStorage, openChatGPTPage, waitFor, sleep } from '../helpers.js';

const U1 = '537b6ddb-ccd9-4fe1-9c41-49cbb3efd990';
const A1 = 'assistant-msg-2ce1fba5-c890-40cd-a26e-7e68dc08c28a';
const A1b = '209ec5ad-de12-423e-9c08-bd9799da35a0';
const A1c = 'assistant-msg-7b0351af-8ffd-4b0d-aa2d-c650b174631a';
const U2 = '81e8db0c-ca24-409f-b0e7-bce83802400d';
const A2 = 'assistant-msg-fe2be1a1-e006-4280-a6be-ac3cc3689a12';

const item = (id, role, turn, inner) => `<div data-message-item="true" data-message-id="${id}" data-message-role="${role}" data-message-side="${role === 'user' ? 'user' : 'agent'}" data-message-turn-id="${turn}" data-message-group-id="${turn}">${inner}</div>`;
const ghost = (label, text) => `<div class="opacity-0"><div><span data-message-accessibility-surrogate="true" data-message-search-surrogate="true" class="sr-only whitespace-pre-wrap">${label}：${text}</span></div></div>`;
const userBubble = (text) => `<div class="opacity-100"><div class="hatch-chat-groupable-bubble" aria-busy="false"><span class="sr-only" data-copy-exclude="true">你：</span><p class="whitespace-pre-wrap">${text}</p></div><button aria-label="更多选项"><svg></svg></button></div>`;
const asstBubble = (html) => `<div class="opacity-100"><div class="flex flex-col" aria-busy="false"><div data-hatch-assistant-message-body="true"><div class="prose" data-hatch-markdown-streaming="false">${html}</div></div><div data-copy-exclude="true"><button aria-label="复制"><svg></svg></button></div></div></div>`;
const code = `<div data-language="js" data-streamdown="code-block"><div data-streamdown="code-block-header"><span>js</span></div>
  <div data-streamdown="code-block-actions"><button title="Copy Code">c</button></div>
  <div data-streamdown="code-block-body"><pre class="language-js"><code><span class="block"><span>// 整页</span></span><span class="block"><span>copy</span><span>(document)</span></span><span class="block">\n</span><span class="block"><span>copy($0)</span></span></code></pre></div></div>`;

const html = (renderedFirst = false) => `<!doctype html><html><head><title>Chat — Muse</title></head><body><main>
  ${item(U1, 'user', U1, renderedFirst ? userBubble('返回完整代码') : ghost('用户消息', '返回完整代码'))}
  ${item(A1, 'assistant', A1, renderedFirst ? asstBubble('<p>完整文件已生成：</p>') : ghost('助手消息', '完整文件已生成：'))}
  ${item(A1b, 'assistant', A1, renderedFirst ? asstBubble('<p>dashboard.js</p>') : ghost('助手消息', 'dashboard.js'))}
  ${item(A1c, 'assistant', A1, renderedFirst ? asstBubble('<p>改动点回顾：Enter 发送。</p>') : ghost('助手消息', '改动点回顾：Enter 发送。'))}
  ${item(U2, 'user', U2, userBubble('F12 console 使用'))}
  ${item(A2, 'assistant', A2, asstBubble(`<p>直接跑：</p>${code}<p>完成。</p>`))}
</main></body></html>`;

test('虚拟列表 + 分组消息：分析出分组属性；替身文字去掉标签、不覆盖已上报内容；同一轮合并；代码按行', async () => {
  const url = 'https://www.muse.ai/chat/d5a0c1e2-1111-2222-3333-444455556666';
  const r = analyzeDom(html(), { url, title: 'Chat — Muse' });
  assert.ok(r.ok, JSON.stringify(r.report));
  assert.equal(r.config.message.group_attr, 'data-message-turn-id');
  assert.equal(r.config.message.id_attrs[0], 'data-message-id');
  assert.equal(r.config.text.user, '.whitespace-pre-wrap', '用户正文（替身 span 也有这个类，但不算）');
  assert.match(r.config.generating.selector, /data-hatch-markdown-streaming="true"/);
  assert.match(r.config.generating.selector, /assistant"\] \[aria-busy="true"\]/);
  assert.ok(r.report.samples.every((x) => !/^(你|用户消息|助手消息)：/.test(x.text)), JSON.stringify(r.report.samples));

  const results = [];
  const bg = createBackground({ WebSocketImpl: class {}, storage: memoryStorage(), clientId: 'ext-virt-0001', settings: { serverUrl: 'ws://127.0.0.1:1', token: '' } });
  const orig = bg.handleRuntimeMessage.bind(bg);
  bg.handleRuntimeMessage = (m, s) => { results.push(m); return orig(m, s); };
  const siteList = [{ key: 'muse', host: 'www.muse.ai', hosts: ['muse.ai'], enabled: true, updated_at: 1, config: { ...r.config, site: 'muse' } }];
  const page = openChatGPTPage({ url, tabId: 5, background: bg, html: html(true), storage: { siteList } });
  const msgs = () => {
    const m = new Map();
    for (const e of results.map((x) => x.event).filter(Boolean)) if (/^message\./.test(e.event_type)) m.set(e.payload.message_id, e);
    return m;
  };
  await waitFor(() => msgs().size === 4, { label: 'four messages' });
  const m = msgs();
  assert.deepEqual([...m.keys()], [U1, A1, U2, A2], '同一轮的三个节点合并成一条，ID 用组 ID');
  assert.equal(m.get(U1).payload.text, '返回完整代码', 'sr-only“你：”不进正文');
  assert.equal(m.get(A1).payload.text, '完整文件已生成：\n\ndashboard.js\n\n改动点回顾：Enter 发送。');
  assert.equal(m.get(A2).payload.text, '直接跑：\n\n// 整页\ncopy(document)\n\ncopy($0)\n\n完成。', '代码按行、去掉工具栏和语言标签');
  assert.match(m.get(A2).payload.html, /<pre><code class="language-js">\/\/ 整页\ncopy\(document\)\n\ncopy\(\$0\)<\/code><\/pre>/);
  const fullA1 = m.get(A1);

  // 滚出视口：只剩替身 → 不发更新，不覆盖完整内容
  const n0 = results.length;
  page.doc.querySelector('main').innerHTML = new (page.win.DOMParser)().parseFromString(html(false), 'text/html').querySelector('main').innerHTML;
  await sleep(600);
  const later = results.slice(n0).map((x) => x.event).filter((e) => e && e.event_type === 'message.updated' && [U1, A1].includes(e.payload.message_id));
  assert.equal(later.length, 0, '替身文字不覆盖');
  assert.equal(msgs().get(A1).payload.text, fullA1.payload.text);
  page.close();

  // 首次打开时就在视口外：用替身文字（去掉“助手消息：”标签）
  const results2 = [];
  const bg2 = createBackground({ WebSocketImpl: class {}, storage: memoryStorage(), clientId: 'ext-virt-0002', settings: { serverUrl: 'ws://127.0.0.1:1', token: '' } });
  const orig2 = bg2.handleRuntimeMessage.bind(bg2);
  bg2.handleRuntimeMessage = (mm, s) => { results2.push(mm); return orig2(mm, s); };
  const page2 = openChatGPTPage({ url, tabId: 6, background: bg2, html: html(false), storage: { siteList } });
  await waitFor(() => results2.filter((x) => x.event?.event_type === 'message.added').length === 4, { label: 'ghost messages' });
  const added = results2.map((x) => x.event).filter((e) => e?.event_type === 'message.added');
  assert.equal(added[0].payload.text, '返回完整代码');
  assert.equal(added[1].payload.text, '完整文件已生成：\n\ndashboard.js\n\n改动点回顾：Enter 发送。');
  assert.equal(added[1].payload.html, undefined, '替身没有富文本');
  page2.close();
});
