// MV3 Service Worker 入口：把 chrome.* API 适配到 background-core
import { createBackground, DEFAULT_SETTINGS } from './lib/background-core.js';
import { randomId } from './shared/protocol.js';
import { analyzeDomOnServer, clearDomConfigOnServer, getSitesFromServer, submitProbeDom } from './lib/dom-config-client.js';

const SUPPORTED_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com|duck\.ai|(?:www\.)?hark\.com)\//;
function siteOf(url) {
  const host = new URL(url).hostname;
  if (/(^|\.)duck\.ai$/.test(host)) return 'duckai';
  if (/(^|\.)hark\.com$/.test(host)) return 'hark';
  return 'chatgpt';
}

/** 弹窗按钮：抓取当前标签页 DOM → 后端分析 → 保存配置（内容脚本监听 storage 变化后立即生效） */
async function analyzeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !SUPPORTED_URL.test(tab.url || '')) return { ok: false, error: '请先切换到 chatgpt.com / duck.ai / hark.com 的对话页面再点分析' };
  const site = siteOf(tab.url);
  let captured;
  try { captured = await chrome.tabs.sendMessage(tab.id, { kind: 'capture_dom' }); }
  catch { return { ok: false, error: '页面上没有运行内容脚本：重新加载插件后，请按 F5 刷新 ChatGPT 页面' }; }
  if (!captured?.ok) return { ok: false, error: captured?.error || '抓取 DOM 失败' };
  const { serverUrl, token } = await loadSettings();
  if (!token) return { ok: false, error: '请先填写并保存 extension token' };
  let result;
  try {
    result = await analyzeDomOnServer({ serverUrl, token, ...captured.page });
  } catch (e) {
    return { ok: false, error: `无法访问后端分析接口：${e?.message || e}` };
  }
  if (result.ok && result.config) {
    const { domConfigs = {}, domConfigReports = {} } = await chrome.storage.local.get(['domConfigs', 'domConfigReports']);
    await chrome.storage.local.set({
      domConfigs: { ...domConfigs, [site]: { ...result.config, site } },
      domConfigReports: { ...domConfigReports, [site]: result.report },
      ...(site === 'chatgpt' ? { domConfig: result.config, domConfigReport: result.report } : {})
    });
  }
  return { ...result, html_bytes: captured.page.html.length };
}

async function clearDomConfig() {
  await chrome.storage.local.remove(['domConfig', 'domConfigReport', 'domConfigs', 'domConfigReports']);
  const { serverUrl, token } = await loadSettings();
  if (token) { try { await clearDomConfigOnServer({ serverUrl, token }); } catch { /* 后端不可达时只清本地 */ } }
  return { ok: true };
}

// ------------------------------------------------------------- 看板添加的网站
const CONTENT_JS = ['lib/dom-observer.js', 'lib/page-actions.js', 'content.js'];

/** 页面里执行：去掉脚本 / 样式等，返回 HTML（与 content.js 的 captureDom 相同） */
function capturePage() {
  const root = document.documentElement.cloneNode(true);
  root.querySelectorAll('script, style, noscript, link, svg, iframe, template, img, video, canvas').forEach((n) => n.remove());
  return { html: '<!DOCTYPE html>\n' + root.outerHTML, url: location.href, title: document.title };
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(on); resolve(); };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }, done);
  });
}

/** 后端指令 probe_site：后台打开网址（用这个浏览器的登录状态）→ 等页面渲染 → 抓 DOM → 上传分析 → 关闭标签页 */
async function probeSite(command) {
  const url = command.text;
  if (!/^https:\/\//.test(url || '')) return { ok: false, code: 'bad_url', detail: '只支持 https 网址' };
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitTabComplete(tab.id, 30000);
    await new Promise((r) => setTimeout(r, 4000));   // 单页应用：再等消息渲染出来
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage });
    if (!res?.result?.html) return { ok: false, code: 'capture_failed', detail: '没能读取页面内容' };
    const { serverUrl, token } = await loadSettings();
    const r = await submitProbeDom({ serverUrl, token, probeId: command.command_id, ...res.result });
    return r.ok ? { ok: true, detail: '已上传页面' } : { ok: false, code: 'upload_failed', detail: r.error || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, code: 'probe_failed', detail: String(e?.message || e) };
  } finally {
    if (tab?.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** 拉取网站列表：保存各站点的 DomConfig，并为添加的网站注册内容脚本（已打开的页面刷新后生效） */
async function syncSites() {
  const { serverUrl, token } = await loadSettings();
  if (!token) return { ok: false, code: 'no_token' };
  let r;
  try { r = await getSitesFromServer({ serverUrl, token }); } catch (e) { return { ok: false, code: 'unreachable', detail: String(e?.message || e) }; }
  if (!r.ok) return { ok: false, code: 'sites_failed', detail: r.error };
  const custom = (r.sites || []).filter((x) => x.host && x.key && x.config);
  const { domConfigs = {} } = await chrome.storage.local.get(['domConfigs']);
  const { customSiteKeys: oldKeys = [] } = await chrome.storage.local.get(['customSiteKeys']);
  const next = { ...domConfigs };
  for (const k of oldKeys) delete next[k];
  const hosts = {};
  for (const x of custom) { next[x.key] = { ...x.config, site: x.key }; hosts[x.host] = x.key; }
  await chrome.storage.local.set({ domConfigs: next, customSiteHosts: hosts, customSiteKeys: custom.map((x) => x.key) });
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const ids = registered.map((x) => x.id).filter((id) => id.startsWith('site-'));
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
    if (custom.length) {
      await chrome.scripting.registerContentScripts(custom.map((x) => ({
        id: `site-${x.key}`, matches: [`https://${x.host}/*`], js: CONTENT_JS, runAt: 'document_idle', persistAcrossSessions: true
      })));
    }
  } catch (e) {
    return { ok: false, code: 'register_failed', detail: String(e?.message || e) };
  }
  return { ok: true, detail: `${custom.length} 个添加的网站` };
}

/**
 * 关闭页面：后端指定的标签页 + 后端记录的该插件所有标签页 + 本插件记录的标签页
 * + 按会话地址在所有窗口（含 PWA / app 窗口、弹出窗口）里找到的标签页，一起关掉。
 */
async function closeConversationTabs(tabId, command) {
  const bgNow = await ready;
  const ids = new Set([tabId, ...(command.tab_ids || []),
    ...[...bgNow.tabs.entries()].filter(([, t]) => t.conversation_id === command.conversation_id).map(([id]) => id)]);
  if (command.url) {
    const strip = (u) => String(u || '').split('#')[0].split('?')[0].replace(/\/$/, '');
    const target = strip(command.url);
    try {
      const all = await chrome.tabs.query({})   // 不加 windowType：包含普通、PWA(app)、弹出窗口;
      for (const t of all) if (t.id != null && (strip(t.url) === target || strip(t.pendingUrl) === target)) ids.add(t.id);
    } catch { /* 没有 tabs 权限读取地址时只关已知标签页 */ }
  }
  const list = [...ids].filter((x) => Number.isInteger(x) && x >= 0);
  let n = 0;
  for (const id of list) {
    try { await chrome.tabs.remove(id); n++; } catch { /* 已经关掉的忽略 */ }
  }
  return n ? { ok: true, detail: `已关闭 ${n} 个标签页` } : { ok: false, code: 'tab_unreachable', detail: '没有找到可关闭的标签页' };
}

/** 一键启动：在后台（不抢焦点）打开网站列表里的每个网址 */
async function openSites(text) {
  const urls = String(text || '').split('\n').map((u) => u.trim()).filter((u) => /^https:\/\/[^\s]+$/.test(u)).slice(0, 50);
  let n = 0;
  for (const url of urls) {
    try { await chrome.tabs.create({ url, active: false }); n++; } catch { /* 单个失败不影响其他 */ }
  }
  return { ok: n > 0, detail: `已在后台打开 ${n} 个网站` };
}

const storage = {
  async get(key) { return (await chrome.storage.session.get(key))[key]; },
  async set(key, value) { await chrome.storage.session.set({ [key]: value }); }
};

async function loadSettings() {
  const s = await chrome.storage.local.get(['serverUrl', 'token', 'clientId']);
  let clientId = s.clientId;
  if (!clientId) {
    clientId = randomId('ext').slice(0, 32);
    await chrome.storage.local.set({ clientId });
  }
  return { serverUrl: s.serverUrl || DEFAULT_SETTINGS.serverUrl, token: s.token || DEFAULT_SETTINGS.token, clientId };
}

const ready = (async () => {
  const settings = await loadSettings();
  const bg = createBackground({
    WebSocketImpl: WebSocket, storage, clientId: settings.clientId, settings,
    // 看板指令 → 对应标签页的内容脚本执行
    executeCommand: async (tabId, command) => {
      if (command.action === 'probe_site') return probeSite(command);
      if (command.action === 'sync_sites') return syncSites();
      if (command.action === 'open_sites') return openSites(command.text);
      if (command.action === 'close') return closeConversationTabs(tabId, command);
      if (command.action === 'focus') {
        try {
          const tab = await chrome.tabs.update(tabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          return { ok: true, detail: '已切换到该标签页' };
        } catch (e) {
          return { ok: false, code: 'tab_unreachable', detail: String(e?.message || e) };
        }
      }
      try {
        const r = await chrome.tabs.sendMessage(tabId, { kind: 'bridge_command', command });
        return r || { ok: false, code: 'no_response' };
      } catch (e) {
        return { ok: false, code: 'tab_unreachable', detail: String(e?.message || e) };
      }
    }
  });
  if (settings.token) { await bg.conn.start(); syncSites().catch(() => {}); }
  bg.conn.onStateChange = (state) => {
    const badge = { open: 'ON', auth_failed: 'AUTH', waiting: '…', connecting: '…', handshaking: '…' }[state] || '';
    chrome.action.setBadgeText({ text: badge }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: state === 'open' ? '#16a34a' : '#dc2626' }).catch(() => {});
    if (state === 'open') syncTabsNow(bg, true);   // 连上（含重连）后立刻对账一次
  };
  return bg;
})();

/**
 * 页面真实状态同步：列出浏览器里所有标签页（含 PWA / app / 弹出窗口），问内容脚本当前在哪个会话，
 * 交给 background-core 上报 tabs.snapshot，后端据此补齐页面打开 / 关闭状态。连续触发时合并为一次。
 */
let syncTimer = null;
let syncForce = false;
function syncTabsNow(bg, force = false) {
  syncForce = syncForce || force;
  if (syncTimer) return;
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    const f = syncForce; syncForce = false;
    try {
      const all = await chrome.tabs.query({});
      const list = await Promise.all(all.filter((t) => t.id != null && /^https?:/.test(t.url || '')).map(async (t) => {
        let conversationId = null;
        try {
          const r = await Promise.race([
            chrome.tabs.sendMessage(t.id, { kind: 'page_info' }),
            new Promise((res) => setTimeout(() => res(null), 800))
          ]);
          if (r?.ok) conversationId = r.conversation_id || null;
        } catch { /* 没有内容脚本的标签页 */ }
        let host = '';
        try { host = new URL(t.url).hostname; } catch { /* ignore */ }
        return { tab_id: t.id, host, conversation_id: conversationId, url: t.url, title: t.title || '' };
      }));
      bg.syncTabs(list, { force: f });
    } catch (e) { console.warn('[bridge] tab sync failed', e); }
  }, 300);
}

// 注意：监听器必须在顶层同步注册，SW 被唤醒时才能收到事件
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ready.then(async (bg) => {
    if (message?.kind === 'analyze_dom') return sendResponse(await analyzeActiveTab());
    if (message?.kind === 'clear_dom_config') return sendResponse(await clearDomConfig());
    if (message?.kind === 'save_settings') {
      await chrome.storage.local.set({ serverUrl: message.serverUrl, token: message.token });
      if (bg.conn.stopped) { bg.conn.url = message.serverUrl; bg.conn.token = message.token; await bg.conn.start(); }
      else bg.conn.reconfigure({ url: message.serverUrl, token: message.token });
      return sendResponse({ ok: true });
    }
    sendResponse(bg.handleRuntimeMessage(message, sender));
  });
  return true; // 异步 sendResponse
});

chrome.tabs.onRemoved.addListener((tabId) => { ready.then((bg) => { bg.onTabRemoved(tabId); syncTabsNow(bg); }); });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url || info.status === 'complete') ready.then((bg) => syncTabsNow(bg)); });

// SW 可能被回收：用 alarm 定期唤醒并检查连接
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'bridge-keepalive') ready.then((bg) => { bg.conn.poke(); syncTabsNow(bg); }); });
