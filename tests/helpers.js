import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { JSDOM } from 'jsdom';
import Ajv from 'ajv';
import { createBridgeServer } from '../src/backend/src/server.js';
import { SCHEMA, makeEnvelope, validateMessage } from '../contracts/protocol.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const TOKENS = {
  extension: 'tok-extension-0123456789abcdef',
  observer: 'tok-observer-0123456789abcdef',
  meta: 'tok-meta-only-0123456789abcdef'
};

export const CLIENTS = [
  { name: 'extension', token: TOKENS.extension, kind: 'extension', scopes: ['publish', 'subscribe', 'read_content'] },
  { name: 'observer', token: TOKENS.observer, kind: 'observer', scopes: ['subscribe', 'subscribe_all', 'read_content', 'history'] },
  { name: 'meta', token: TOKENS.meta, kind: 'observer', scopes: ['subscribe'] }
];

export function tmpDb() {
  return join(mkdtempSync(join(tmpdir(), 'bridge-test-')), 'bridge.db');
}

export async function startServer({ dbPath, port = 0, policy = {}, domConfigPath, commandTimeoutMs } = {}) {
  const server = createBridgeServer({ dbPath: dbPath || tmpDb(), port, clients: CLIENTS, quiet: true, policy, domConfigPath, commandTimeoutMs });
  await server.start();
  return server;
}

const ajv = new Ajv({ strict: false, allErrors: true });
export const ajvValidate = ajv.compile(SCHEMA);

export async function waitFor(fn, { timeout = 5000, interval = 10, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 原始 WebSocket 测试客户端（第二、第三个客户端） */
export class TestClient {
  constructor(url, { origin } = {}) {
    this.url = url;
    this.origin = origin;
    this.messages = [];
    this.invalid = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      const headers = this.origin ? { Origin: this.origin } : {};
      this.ws = new WebSocket(this.url, { headers });
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', reject);
      this.ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        const v = validateMessage(m, { direction: 's2c' });
        if (!v.ok || !ajvValidate(m)) this.invalid.push({ m, errors: v.errors, ajv: ajvValidate.errors });
        this.messages.push(m);
      });
      this.ws.on('close', (code) => { this.closedWith = code; });
    });
  }

  send(msg) { this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }

  async hello(clientId, token, kind = 'observer') {
    this.clientId = clientId;
    this.send(makeEnvelope('hello', { client_id: clientId, client_kind: kind, token }));
    return waitFor(() => this.messages.find((m) => m.type === 'welcome' || (m.type === 'error' && m.fatal)), { label: 'welcome' });
  }

  async subscribe(conversations, since_seq) {
    const msg = makeEnvelope('subscribe', { conversations, ...(since_seq != null ? { since_seq } : {}) });
    this.send(msg);
    return waitFor(() => this.messages.find((m) => (m.type === 'subscribed' || m.type === 'error') && m.ref_id === msg.id), { label: 'subscribed' });
  }

  broadcasts() { return this.messages.filter((m) => m.type === 'broadcast'); }
  of(type) { return this.messages.filter((m) => m.type === type); }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
  terminate() { try { this.ws.terminate(); } catch { /* ignore */ } }
}

export const memoryStorage = () => {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, _m: m };
};

const OBSERVER_SRC = readFileSync(join(ROOT, 'src/frontend/lib/dom-observer.js'), 'utf8');
const CONTENT_SRC = readFileSync(join(ROOT, 'src/frontend/content.js'), 'utf8');
const ACTIONS_SRC = readFileSync(join(ROOT, 'src/frontend/lib/page-actions.js'), 'utf8');

/**
 * 在 jsdom 中打开一个模拟 ChatGPT 的页面，并注入真实的 dom-observer.js + content.js。
 * chrome.runtime.sendMessage 直接接到 background-core 的 handleRuntimeMessage。
 */
export function openChatGPTPage({ url, html, background, tabId, domConfig, storage }) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const sent = [];
  const msgListeners = [];
  const changeListeners = [];
  const local = new Map([...(domConfig ? [['domConfig', domConfig]] : []), ...Object.entries(storage || {})]);
  win.chrome = {
    runtime: {
      id: 'test-extension-id',
      sendMessage(message) {
        sent.push(message);
        return Promise.resolve(background.handleRuntimeMessage(JSON.parse(JSON.stringify(message)), { tab: { id: tabId } }));
      },
      onMessage: { addListener: (fn) => msgListeners.push(fn) }
    },
    storage: {
      local: {
        // 与 chrome.storage.local.get 一致：参数可以是字符串或字符串数组
        get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k])
          .filter((x) => local.has(x)).map((x) => [x, JSON.parse(JSON.stringify(local.get(x)))])),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            const oldValue = local.get(k);
            local.set(k, v);
            for (const fn of changeListeners) fn({ [k]: { oldValue, newValue: JSON.parse(JSON.stringify(v)) } }, 'local');
          }
        },
        remove: async (k) => {
          const oldValue = local.get(k);
          local.delete(k);
          for (const fn of changeListeners) fn({ [k]: { oldValue, newValue: undefined } }, 'local');
        }
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) }
    }
  };
  win.eval(OBSERVER_SRC);
  win.eval(ACTIONS_SRC);
  win.eval(CONTENT_SRC);
  /** 模拟插件后台给内容脚本发消息 */
  const sendToContent = (msg) => new Promise((resolve) => {
    for (const fn of msgListeners) fn(msg, { id: 'test-extension-id' }, resolve);
  });
  return { dom, win, doc: win.document, sent, sendToContent, storage: win.chrome.storage.local, close: () => win.close() };
}

export function chatHtml(messages = [], { generating = false } = {}) {
  const body = messages.map((m) =>
    `<article data-testid="conversation-turn"><div data-message-author-role="${m.role}" data-message-id="${m.id}"><div class="markdown">${m.text}</div></div></article>`
  ).join('');
  return `<!doctype html><html><head><title>ChatGPT</title></head><body><main id="thread">${body}</main>
    <form><button data-testid="${generating ? 'stop-button' : 'send-button'}">x</button></form></body></html>`;
}

/**
 * 在 jsdom 中加载看板（index.html + app.js），连接到测试后端（observer token）。
 * 返回 { win, d, copied, opened, errors, close }；close() 关闭 WebSocket 和窗口。
 */
export async function openDashboard(server, { token = TOKENS.observer } = {}) {
  const proto = await import('../contracts/protocol.js');
  const origin = `http://127.0.0.1:${server.port}`;
  const html = readFileSync(join(ROOT, 'src/backend/dashboard/index.html'), 'utf8').replace(/<script type="module"[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { url: `${origin}/dashboard`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const copied = [];
  const opened = [];
  const sockets = [];
  const errors = [];
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
  win.AudioContext = class {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createOscillator() { return { frequency: {}, type: '', connect: (g) => g, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x }; }
  };
  win.CSS = { escape: (s) => String(s).replace(/"/g, '\\"') };
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (t) => { copied.push(t); } } });
  win.open = (url) => { opened.push(url); return null; };
  win.confirm = () => true;
  win.__probePollMs = 30;
  win.addEventListener('error', (e) => errors.push(e.error || e.message));
  const appSrc = readFileSync(join(ROOT, 'src/backend/dashboard/app.js'), 'utf8')
    .replace(/^import \{([^}]+)\} from '\.\/protocol\.js';/m, 'const {$1} = window.__proto;');
  win.eval(`(async () => { ${appSrc} })().catch((e) => { window.__appError = e; });`);
  const d = win.document;
  d.getElementById('token').value = token;
  d.getElementById('connect').click();
  await waitFor(() => /^已连接/.test(d.getElementById('connText').textContent), { label: 'dashboard connected' });
  return { win, d, copied, opened, errors, close: () => { for (const s of sockets) s.close(); win.close(); } };
}
