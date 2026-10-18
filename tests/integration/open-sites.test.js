/** 一键启动：按配置网址打开；已打开检测按主机 + 路径，正在加载的标签页也算 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../../src/frontend/background.js', import.meta.url), 'utf8');
const pick = (name) => { const i = src.indexOf(name); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const code = ['function siteUrlKey', 'function coversTab', 'async function openSites'].map(pick).join('\n');

function load(tabs) {
  const created = [];
  const chrome = { tabs: { query: async () => tabs, create: async ({ url }) => { created.push(url); return {}; } } };
  const ctx = vm.createContext({ chrome, URL });
  vm.runInContext(`${code}\nthis.openSites = openSites;`, ctx);
  return { openSites: ctx.openSites, created };
}

test('一键启动：打开配置的指定网址；同主机其他路径不算已开，www / 末尾斜杠 / 加载中都识别', async () => {
  const { openSites, created } = load([
    { url: 'https://chatgpt.com/c/123' },                       // 普通会话，不在指定 GPT 路径下
    { url: 'about:blank', pendingUrl: 'https://www.duck.ai/chat?q=1' },   // 正在加载
    { url: 'chrome://extensions' }
  ]);
  const r = await openSites([
    'https://chatgpt.com/g/g-abc-my-gpt',     // 指定路径：未打开 → 打开
    'https://duck.ai/',                        // 首页：主机已有标签页 → 已开
    'https://hark.example/app/',               // 未打开
    'https://hark.example/app',                // 同一批重复（末尾斜杠差异）→ 只开一次
    'http://insecure.example/'                 // 非 https 忽略
  ].join('\n'));
  assert.deepEqual(created, ['https://chatgpt.com/g/g-abc-my-gpt', 'https://hark.example/app/']);
  assert.equal(r.ok, true);
  assert.match(r.detail, /打开 2 个网站，2 个已开着/);
});

test('一键启动：指定路径下的子页面算已开', async () => {
  const { openSites, created } = load([{ url: 'https://chatgpt.com/g/g-abc-my-gpt/c/999' }]);
  const r = await openSites('https://chatgpt.com/g/g-abc-my-gpt');
  assert.deepEqual(created, []);
  assert.match(r.detail, /1 个已开着/);
});
