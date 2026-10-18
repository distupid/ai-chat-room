/**
 * 富文本：观察器把消息正文转成净化后的 html（与 text 同一节点、同样的 exclude），后端存进 messages.html 并在消息接口返回，
 * 看板再净化一次后按原格式显示（代码块 语言 / 复制 / 下载，图片 内联 / 打开原图 / 下载，文件卡片），否则退回 text。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { makeEnvelope, validateMessage, Limits } from '../../contracts/protocol.js';
import { openDatabase } from '../../src/backend/src/db.js';
import { ROOT, TOKENS, TestClient, startServer, waitFor, sleep, ajvValidate, openDashboard } from '../helpers.js';

const OBSERVER_SRC = readFileSync(join(ROOT, 'src/frontend/lib/dom-observer.js'), 'utf8');
const CONV = '6720a1b2-0000-4111-8222-ddddeeeeffff';
const CONV_URL = `https://chatgpt.com/c/${CONV}`;

function runObserver(html, url = CONV_URL) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.eval(OBSERVER_SRC);
  const events = [];
  const obs = win.ChatGPTBridgeObserver.createChatGPTObserver({ document: win.document, window: win, emit: (e) => events.push(JSON.parse(JSON.stringify(e))), pollMs: 50, debounceMs: 10 });
  obs.start();
  return { win, O: win.ChatGPTBridgeObserver, obs, events, added: () => events.filter((e) => e.event_type === 'message.added').map((e) => e.payload) };
}

const RICH_ANSWER = `<h2>步骤</h2><p>先 <strong>安装</strong>，再运行 <code>main.py</code>：</p>
  <pre><div data-markdown-copy="exclude"><span>python</span><button>复制代码</button></div><code class="hljs language-python">import sys
print(sys.argv)</code></pre>
  <ol><li>第一步</li><li>第二步</li></ol>
  <table><thead><tr><th>名称</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>
  <p><img src="https://files.example.com/chart.png" alt="图表" onerror="alert(1)" width="400" height="300"></p>
  <p>下载 <a href="https://files.example.com/out/report.pdf">report.pdf</a>，参考 <a href="https://example.com/doc" onclick="steal()">文档</a>，<a href="javascript:alert(1)">坏链接</a></p>
  <script>alert(1)</script><style>p{color:red}</style><iframe src="https://evil.example"></iframe>
  <form action="https://evil.example"><input value="x"></form><svg><text>svg 文字</text></svg>`;

const chatPage = (answer) => `<!doctype html><html><head><title>ChatGPT</title></head><body><main>
  <div data-message-author-role="user" data-message-id="u-1"><div class="whitespace-pre-wrap">怎么运行？</div></div>
  <div data-message-author-role="assistant" data-message-id="a-1"><div class="markdown">${answer}</div></div>
  </main></body></html>`;

test('观察器：消息带净化后的 html（白名单标签、代码语言、图片、文件链接），去掉脚本 / 样式 / iframe / 表单 / 按钮 / svg / 事件属性 / javascript: 链接；事件通过 Schema', () => {
  const { win, obs, events, added } = runObserver(chatPage(RICH_ANSWER));
  const [user, answer] = added();
  assert.equal(user.html, undefined, '纯文本消息不带 html');
  const h = answer.html;
  assert.ok(h, 'html');
  assert.match(h, /<h2>步骤<\/h2>/);
  assert.match(h, /<strong>安装<\/strong>/);
  assert.match(h, /<pre><code class="language-python">import sys\nprint\(sys\.argv\)<\/code><\/pre>/, '代码块保留语言和换行，工具栏被排除');
  assert.match(h, /<ol><li>第一步<\/li><li>第二步<\/li><\/ol>/);
  assert.match(h, /<table><thead><tr><th>名称<\/th>/);
  assert.match(h, /<img src="https:\/\/files\.example\.com\/chart\.png" alt="图表">/);
  assert.match(h, /<a href="https:\/\/files\.example\.com\/out\/report\.pdf" data-file="report\.pdf">report\.pdf<\/a>/);
  assert.match(h, /<a href="https:\/\/example\.com\/doc">文档<\/a>/);
  assert.doesNotMatch(h, /<script|<style|<iframe|<form|<input|<svg|<button|onerror|onclick|javascript:|alert|复制代码|svg 文字|class="hljs/);
  assert.match(h, /坏链接/, '不安全的链接只保留文字');
  assert.equal(answer.text.includes('import sys'), true, 'text 不变');
  for (const e of events) {
    const env = makeEnvelope('event', { ...e, tab_id: 1 });
    assert.ok(validateMessage(env, { direction: 'c2s' }).ok, e.event_type);
    assert.ok(ajvValidate(env), JSON.stringify(ajvValidate.errors));
  }
  obs.stop();
  win.close();
});

test('观察器：duck.ai 代码语言取自 data-language、按行补换行；没有网址的文件卡片（按钮文字是文件名）→ data-file；图片只要 http(s) / data:image；超过上限不带 html', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="m">
    <div data-language="js" data-streamdown="code-block"><div data-streamdown="code-block-header"><span>js</span></div>
      <pre><code><span>a();</span><span>b();</span></code></pre></div>
    <button aria-label="打开 a.html 的预览"><span>a.html</span></button><button>复制</button>
    <a href="https://x.example.com/get?id=1" download="data.csv">数据</a>
    <img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="javascript:alert(1)"><img src="https://x.example.com/i.png" width="16" height="16">
    <div>行内 div<br>第二行</div>
  </div></body>`, { url: 'https://duck.ai/', runScripts: 'outside-only' });
  dom.window.eval(OBSERVER_SRC);
  const O = dom.window.ChatGPTBridgeObserver;
  const h = O.extractHtml(dom.window.document.getElementById('m'), '[data-streamdown="code-block-header"]');
  assert.match(h, /<pre><code class="language-js">a\(\);\nb\(\);<\/code><\/pre>/);
  assert.match(h, /<span data-file="a\.html">a\.html<\/span>/);
  assert.doesNotMatch(h, />复制</, '普通按钮丢掉');
  assert.match(h, /<a href="https:\/\/x\.example\.com\/get\?id=1" data-file="data\.csv" download="data\.csv">数据<\/a>/);
  assert.match(h, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="">/);
  assert.doesNotMatch(h, /svg\+xml|javascript:|i\.png/, 'svg 图片、javascript:、小图标都不要');
  assert.match(h, /<p>行内 div<br>第二行<\/p>/);
  dom.window.close();

  // 超过上限：只发 text
  const big = '<p>' + '<b>粗</b>'.repeat(30000) + '</p>';
  const { win, obs, added } = runObserver(chatPage(big));
  const a = added()[1];
  assert.equal(a.html, undefined);
  assert.equal(a.text.length, 30000);
  obs.stop();
  win.close();
});

test('后端：messages.html 存储并由消息接口返回；无 read_content 的客户端广播里去掉 text 和 html；旧库自动加 html 列；Schema 限制 html 长度', async () => {
  const server = await startServer();
  const ext = await new TestClient(server.url).open();
  await ext.hello('ext-rich-000001', TOKENS.extension, 'extension');
  const meta = await new TestClient(server.url).open();
  await meta.hello('obs-rich-meta01', TOKENS.meta);
  await meta.subscribe([CONV]);
  const html = '<p>看 <strong>这里</strong></p><pre><code class="language-js">a()</code></pre>';
  const ev = (id, payload, type = 'message.added') => makeEnvelope('event', { event_id: `t:rich:${id}`, event_type: type, occurred_at: Date.now(), conversation_id: CONV, tab_id: 1, payload });
  ext.send(ev('1', { message_id: 'a1', role: 'assistant', index: 1, text: '看 这里\n\na()', text_length: 8, html }));
  await waitFor(() => ext.messages.some((m) => m.type === 'ack' && m.ref_id === 't:rich:1'), { label: 'ack' });
  const r = await (await fetch(`http://127.0.0.1:${server.port}/api/conversations/${CONV}/messages`, { headers: { authorization: `Bearer ${TOKENS.observer}` } })).json();
  assert.equal(r.messages[0].html, html);
  const b = await waitFor(() => meta.broadcasts().find((m) => m.payload.message_id === 'a1'), { label: 'redacted broadcast' });
  assert.equal(b.redacted, true);
  assert.equal('html' in b.payload, false);
  assert.equal('text' in b.payload, false);
  assert.deepEqual(meta.invalid, []);
  // 更新时不带 html（超过上限）→ 清空
  ext.send(ev('2', { message_id: 'a1', role: 'assistant', index: 1, text: '只有文字', text_length: 4 }, 'message.updated'));
  await waitFor(() => ext.messages.some((m) => m.type === 'ack' && m.ref_id === 't:rich:2'), { label: 'ack 2' });
  const r2 = await (await fetch(`http://127.0.0.1:${server.port}/api/conversations/${CONV}/messages`, { headers: { authorization: `Bearer ${TOKENS.observer}` } })).json();
  assert.equal(r2.messages[0].html, null);
  // Schema：超长 html 被拒
  const tooLong = ev('3', { message_id: 'a2', role: 'assistant', index: 2, text: 'x', text_length: 1, html: 'x'.repeat(Limits.MAX_HTML_CHARS + 1) });
  assert.equal(validateMessage(tooLong, { direction: 'c2s' }).ok, false);
  assert.equal(validateMessage(ev('4', { message_id: 'a2', role: 'assistant', index: 2, text: 'x', text_length: 1, html: 1 }), { direction: 'c2s' }).ok, false);
  ext.close();
  meta.close();
  await server.stop();

  // 旧库迁移
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(mkdtempSync(join(tmpdir(), 'bridge-rich-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE messages (conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL, msg_index INTEGER NOT NULL,
    text TEXT NOT NULL, updated_seq INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, message_id));
    INSERT INTO messages VALUES ('c1', 'm1', 'assistant', 0, '旧消息', 1, 1);`);
  old.close();
  const db = openDatabase(path);
  const cols = db.raw.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  assert.ok(cols.includes('html'));
  assert.deepEqual(db.listMessages('c1').map((m) => [m.text, m.html]), [['旧消息', null]]);
  db.raw.close();
});

test('看板详情：按原格式显示 html（标题 / 列表 / 表格），代码块 语言 + 复制 + 下载，图片内联可打开原图并下载，文件卡片；再净化一次；长消息折叠后按钮仍可用；复制回答 / 搜索仍用 text', async () => {
  const server = await startServer();
  const ext = await new TestClient(server.url).open();
  await ext.hello('ext-rich-000002', TOKENS.extension, 'extension');
  let seq = 0;
  const send = async (type, payload) => {
    const env = makeEnvelope('event', { event_id: `t:richui:${++seq}`, event_type: type, occurred_at: Date.now(), conversation_id: CONV, tab_id: 1, payload });
    ext.send(env);
    await waitFor(() => ext.messages.some((m) => m.type === 'ack' && m.ref_id === env.event_id), { label: `ack ${type}` });
  };
  await send('page.opened', { url: CONV_URL, title: '富文本测试 - ChatGPT' });
  await send('message.added', { message_id: 'u1', role: 'user', index: 0, text: '给我代码', text_length: 4 });
  // 后端存的 html 里故意混入危险内容（模拟旧插件 / 被篡改的数据），看板必须再净化
  const html = '<h3>结果</h3><ul><li>一</li><li>二</li></ul>' +
    '<table><tr><th>k</th><td>v</td></tr></table>' +
    '<pre><code class="language-python">print("hi")\nprint(2)</code></pre>' +
    '<pre><code>plain text</code></pre>' +
    '<p><img src="https://files.example.com/pic.png" alt="示意图" onerror="window.__xss=1"></p>' +
    '<p><a href="https://files.example.com/out/report.pdf" data-file="report.pdf">report.pdf</a> <span data-file="notes.txt">notes.txt</span> ' +
    '<a href="https://example.com/doc" style="color:red" onclick="window.__xss=1">文档</a> <a href="javascript:window.__xss=1">坏</a></p>' +
    '<script>window.__xss=1</script><iframe src="https://evil.example"></iframe><img src="javascript:alert(1)"><button onclick="window.__xss=1">按钮</button>';
  await send('message.added', { message_id: 'a1', role: 'assistant', index: 1, text: '结果\n\n一\n二\n\nprint("hi")\nprint(2)\n\n唯一关键词XYZ', text_length: 40, html });

  const ui = await openDashboard(server);
  const { d, win, copied, opened } = ui;
  const cardSel = `.card[data-conv="${CONV}"]`;
  await waitFor(() => d.querySelector(cardSel), { label: 'card' });
  // 搜索仍按 text
  d.getElementById('search').value = '唯一关键词XYZ';
  d.getElementById('search').dispatchEvent(new win.Event('input'));
  await waitFor(() => d.querySelector(cardSel), { label: 'search by text' });
  d.getElementById('search').value = '';
  d.getElementById('search').dispatchEvent(new win.Event('input'));

  d.querySelector(cardSel).click();
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant .codeblock'), { label: 'rich detail' });
  const body = d.querySelector('#detailMsgs .msg.assistant .body');
  assert.ok(body.classList.contains('rich'));
  assert.equal(body.querySelector('h3').textContent, '结果');
  assert.equal(body.querySelectorAll('ul > li').length, 2);
  assert.ok(body.querySelector('.tablewrap > table th'));
  // 再净化：没有脚本 / iframe / 按钮 / 事件属性 / style / javascript:
  assert.equal(body.querySelectorAll('script, iframe, button:not(.cbtn), style').length, 0);
  assert.ok(![...body.querySelectorAll('*')].some((n) => [...n.attributes].some((a) => /^on/i.test(a.name) || a.name === 'style')), '没有事件属性和 style');
  assert.ok(![...body.querySelectorAll('[href], [src]')].some((n) => /^javascript:/i.test(n.getAttribute('href') || n.getAttribute('src') || '')));
  assert.match(body.textContent, /坏/);
  await sleep(20);
  assert.equal(win.__xss, undefined);

  // 代码块：语言标签、复制、下载（扩展名按语言）
  const blocks = body.querySelectorAll('.codeblock');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].querySelector('.lang').textContent, 'python');
  assert.equal(blocks[1].querySelector('.lang').textContent, '代码');
  blocks[0].querySelector('[data-act="code-copy"]').click();
  await waitFor(() => copied.includes('print("hi")\nprint(2)'), { label: 'code copied' });
  const downloads = [];
  win.URL.createObjectURL = (blob) => { downloads.push({ blob }); return 'blob:test-1'; };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () { downloads.at(-1).name = this.getAttribute('download'); downloads.at(-1).href = this.getAttribute('href'); };
  blocks[0].querySelector('[data-act="code-download"]').click();
  assert.equal(downloads[0].name, 'code.py');
  assert.equal(await downloads[0].blob.text(), 'print("hi")\nprint(2)');
  blocks[1].querySelector('[data-act="code-download"]').click();
  assert.equal(downloads[1].name, 'code-2.txt');

  // 图片：内联、点击打开原图、下载按钮
  const img = body.querySelector('img.rich');
  assert.equal(img.getAttribute('src'), 'https://files.example.com/pic.png');
  assert.equal(body.querySelectorAll('img').length, 1, 'javascript: 图片被丢掉');
  img.click();
  assert.equal(opened.at(-1), 'https://files.example.com/pic.png');
  const imgDl = body.querySelector('a.imgdl');
  assert.equal(imgDl.getAttribute('href'), 'https://files.example.com/pic.png');
  assert.equal(imgDl.getAttribute('download'), 'pic.png');

  // 文件卡片：有网址可下载 / 打开；没有网址只显示名称
  const chip = body.querySelector('a.filechip');
  assert.equal(chip.getAttribute('href'), 'https://files.example.com/out/report.pdf');
  assert.equal(chip.getAttribute('download'), 'report.pdf');
  assert.equal(chip.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(chip.textContent, 'report.pdf');
  const nolink = body.querySelector('.filechip.nolink');
  assert.equal(nolink.textContent, 'notes.txt');
  assert.equal(nolink.getAttribute('href'), null);
  const link = [...body.querySelectorAll('a')].find((a) => a.textContent === '文档');
  assert.equal(link.getAttribute('target'), '_blank');

  // 回答的“复制”仍复制 text
  d.querySelector('#detailMsgs .msg.assistant [data-act="copy"]').click();
  await waitFor(() => copied.includes('结果\n\n一\n二\n\nprint("hi")\nprint(2)\n\n唯一关键词XYZ'), { label: 'answer text copied' });

  // 流式更新带 html；没有 html 的消息退回 text（Markdown）
  await send('message.updated', { message_id: 'a1', role: 'assistant', index: 1, text: '更新', text_length: 2, html: '<p>更新后 <em>强调</em></p><pre><code class="language-js">x()</code></pre>' });
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant em')?.textContent === '强调', { label: 'rich update' });
  assert.equal(d.querySelector('#detailMsgs .msg.assistant .codeblock .lang').textContent, 'js');
  await send('message.updated', { message_id: 'a1', role: 'assistant', index: 1, text: '纯文本\n\n```sh\nls -la\n```', text_length: 20 });
  await waitFor(() => !d.querySelector('#detailMsgs .msg.assistant .body.rich') && d.querySelector('#detailMsgs .msg.assistant .codeblock .lang')?.textContent === 'sh', { label: 'text fallback with code buttons' });

  // 超长富文本消息：折叠为首尾，尾部（复制出的节点）的代码按钮也能用
  const origRect = win.HTMLElement.prototype.getBoundingClientRect;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const h = this.classList.contains('dialog') ? 600 : this.classList.contains('body') && this.textContent.length > 500 ? 1200 : 40;
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: h, width: 100, height: h };
  };
  const longHtml = '<p>' + '很长的段落。'.repeat(120) + '</p><pre><code class="language-ts">const end = 1;</code></pre>';
  await send('message.updated', { message_id: 'a1', role: 'assistant', index: 1, text: '很长的段落。'.repeat(120) + '\n\nconst end = 1;', text_length: 735, html: longHtml });
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant .longfold'), { label: 'long fold' });
  const tailBtn = d.querySelector('#detailMsgs .msg.assistant .ltail [data-act="code-copy"]');
  assert.ok(tailBtn, '尾部有代码块按钮');
  tailBtn.click();
  await waitFor(() => copied.includes('const end = 1;'), { label: 'tail code copy' });
  d.querySelector('#detailMsgs .msg.assistant [data-act="longfold"]').click();
  await waitFor(() => !d.querySelector('#detailMsgs .msg.assistant .longfold') && d.querySelector('#detailMsgs .msg.assistant .body.rich'), { label: 'expanded' });
  win.HTMLElement.prototype.getBoundingClientRect = origRect;

  // 收藏仍可用
  d.querySelector('#detailMsgs .msg.assistant [data-act="favorite"]').click();
  await waitFor(() => d.querySelector('#detailMsgs .msg.assistant.fav'), { label: 'favorite' });

  assert.equal(win.__appError, undefined, String(win.__appError?.stack));
  assert.deepEqual(ui.errors, []);
  ui.close();
  ext.close();
  await server.stop();
});
