// MV3 Service Worker 入口：把 chrome.* API 适配到 background-core
import { createBackground, DEFAULT_SETTINGS } from './lib/background-core.js';
import { randomId } from './shared/protocol.js';
// 观察器脚本（经典脚本，挂到 globalThis.ChatGPTBridgeObserver）：用它的默认种子和按域名找网站的规则，与内容脚本一致
import './lib/dom-observer.js';
import { getSitesFromServer, submitProbeDom, fetchAttachments } from './lib/dom-config-client.js';

const Observer = globalThis.ChatGPTBridgeObserver;

// ------------------------------------------------------------- 看板添加的网站
const CONTENT_JS = ['lib/dom-observer.js', 'lib/page-actions.js', 'content.js'];

/** 页面里执行：去掉脚本 / 样式等，返回 HTML（交给后端分析） */
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

/** 页面里执行：正文长度（判断单页应用是否渲染完） */
function pageTextSize() { return document.body ? document.body.innerText.length : 0; }

/** 等单页应用渲染稳定：正文长度连续两次不变（最多 maxMs） */
async function waitRendered(tabId, maxMs) {
  const end = Date.now() + maxMs;
  let last = -1, stable = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    let size = 0;
    try { [{ result: size }] = await chrome.scripting.executeScript({ target: { tabId }, func: pageTextSize }); } catch { continue; }
    stable = size > 0 && size === last ? stable + 1 : 0;
    last = size;
    if (stable >= 2) return;
  }
}

/**
 * 后端指令 probe_site：抓 DOM → 上传分析。
 * 已经打开了这个网站的标签页时直接用它（不新开、不关闭，也不会把用户正在看的页面关掉）；
 * 否则后台新开一个，等渲染稳定后抓取，抓完关闭。
 */
async function probeSite(command) {
  const url = command.text;
  if (!/^https:\/\//.test(url || '')) return { ok: false, code: 'bad_url', detail: '只支持 https 网址' };
  const host = new URL(url).hostname.replace(/^www\./, '');
  let tab, opened = false;
  try {
    const tabs = (await chrome.tabs.query({})).filter((t) => {
      try { const h = new URL(t.url || '').hostname.replace(/^www\./, ''); return h === host || h.endsWith('.' + host); } catch { return false; }
    });
    // 优先：网址完全一致 → 正在看的 → 不在首页（多半是对话页）
    tab = tabs.find((t) => t.url === url) || tabs.find((t) => t.active) || tabs.find((t) => new URL(t.url).pathname.length > 1) || tabs[0];
    if (!tab) {
      tab = await chrome.tabs.create({ url, active: false });
      opened = true;
      await waitTabComplete(tab.id, 30000);
    }
    await waitRendered(tab.id, opened ? 15000 : 3000);
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage });
    if (!res?.result?.html) return { ok: false, code: 'capture_failed', detail: '没能读取页面内容' };
    const { serverUrl, token } = await loadSettings();
    const r = await submitProbeDom({ serverUrl, token, probeId: command.command_id, ...res.result });
    return r.ok ? { ok: true, detail: '已上传页面' } : { ok: false, code: 'upload_failed', detail: r.error || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, code: 'probe_failed', detail: String(e?.message || e) };
  } finally {
    if (opened && tab?.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** 网站 → 内容脚本注册项（本域名及子域名；停用 / 没有配置的不注册） */
function scriptsFor(list) {
  return (list || []).filter((x) => x && x.key && x.enabled !== false && x.config).map((x) => ({
    id: `site-${x.key}`,
    matches: Observer.siteHosts(x).flatMap((h) => [`https://${h}/*`, `https://*.${h}/*`]),
    js: CONTENT_JS, runAt: 'document_idle', persistAcrossSessions: true
  })).filter((x) => x.matches.length);
}

/** 按网站列表注册内容脚本（与已注册的一致时不动）；已打开的页面刷新后生效 */
async function registerSites(list) {
  const want = scriptsFor(list);
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const mine = registered.filter((x) => x.id.startsWith('site-'));
  const sig = (arr) => JSON.stringify(arr.map((x) => [x.id, [...(x.matches || [])].sort()]).sort());
  if (sig(mine) === sig(want)) return want.length;
  if (mine.length) await chrome.scripting.unregisterContentScripts({ ids: mine.map((x) => x.id) });
  if (want.length) await chrome.scripting.registerContentScripts(want);
  return want.length;
}

/** 启动时：还没同步过网站列表（例如第一次离线启动）就按默认种子注册，保证默认网站能被观察 */
async function ensureRegistered() {
  const { siteList } = await chrome.storage.local.get(['siteList']);
  try { await registerSites(Array.isArray(siteList) ? siteList : Observer.SEED_SITES); }
  catch (e) { console.warn('[bridge] register content scripts failed', e); }
}

/**
 * 拉取网站列表（所有网站，含默认种子网站）：存进 siteList（内容脚本按域名选配置），并按列表注册内容脚本。
 */
async function syncSites() {
  const { serverUrl, token } = await loadSettings();
  if (!token) return { ok: false, code: 'no_token' };
  let r;
  try { r = await getSitesFromServer({ serverUrl, token }); } catch (e) { return { ok: false, code: 'unreachable', detail: String(e?.message || e) }; }
  if (!r.ok) return { ok: false, code: 'sites_failed', detail: r.error };
  const list = (r.sites || []).filter((x) => x && x.key && x.host).map((x) => ({
    key: x.key, name: x.name, url: x.url, host: x.host, hosts: Array.isArray(x.hosts) ? x.hosts : [],
    enabled: x.enabled !== false, config: x.config ? { ...x.config, site: x.key } : null, updated_at: x.updated_at || 0
  }));
  await chrome.storage.local.set({ siteList: list });
  // 旧版字段（弹窗“分析当前页面”留下的本地覆盖配置、旧的自定义域名）：不再使用
  await chrome.storage.local.remove(['customSiteHosts', 'customSiteKeys', 'domConfig', 'domConfigReport', 'domConfigs', 'domConfigReports']);
  let n;
  try { n = await registerSites(list); } catch (e) { return { ok: false, code: 'register_failed', detail: String(e?.message || e) }; }
  return { ok: true, detail: `${list.length} 个网站，${n} 个已启用` };
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

/** 一键启动：在后台（不抢焦点）打开网站列表里还没开着的网址（按域名判断，包含 PWA / app 窗口） */
/**
 * 一键启动：按网站列表里配置的网址（用户指定的，不是站点默认首页）在后台打开。
 * 已打开的判断：同一主机（忽略 www.）且标签页路径落在配置网址的路径下；配置网址是首页时，该主机任意标签页都算已开。
 * 正在加载的标签页看 pendingUrl；同一批里重复的网址只开一次。
 */
function siteUrlKey(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
    return { host: x.hostname.replace(/^www\./, '').toLowerCase(), path: x.pathname.replace(/\/+$/, '') || '/' };
  } catch { return null; }
}
function coversTab(site, tab) {
  if (!tab || site.host !== tab.host) return false;
  if (site.path === '/') return true;
  return tab.path === site.path || tab.path.startsWith(site.path + '/');
}
async function openSites(text) {
  const urls = [...new Set(String(text || '').split('\n').map((u) => u.trim()).filter((u) => /^https:\/\/[^\s]+$/.test(u)))].slice(0, 50);
  let tabs = [];
  try { tabs = (await chrome.tabs.query({})).map((t) => siteUrlKey(t.pendingUrl || t.url || '')).filter(Boolean); } catch { /* ignore */ }
  let n = 0;
  let skipped = 0;
  for (const url of urls) {
    const key = siteUrlKey(url);
    if (!key) continue;
    if (tabs.some((t) => coversTab(key, t))) { skipped++; continue; }
    try { await chrome.tabs.create({ url, active: false }); n++; tabs.push(key); } catch { /* 单个失败不影响其他 */ }
  }
  if (!n && !skipped) return { ok: false, code: 'tab_unreachable', detail: '没有可打开的网站' };
  return { ok: true, detail: skipped ? `已在后台打开 ${n} 个网站，${skipped} 个已开着` : `已在后台打开 ${n} 个网站` };
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

/** 看板指令 → 对应标签页执行 */
async function runCommand(tabId, command) {
  if (command.action === 'probe_site') return probeSite(command);
  if (command.action === 'sync_sites') return syncSites();
  if (command.action === 'open_sites') return openSites(command.text);
  if (command.action === 'new_chat') {
    const url = String(command.text || '').trim();
    if (!/^https:\/\/[^\s]+$/.test(url)) return { ok: false, code: 'bad_url', detail: '只支持 https 网址' };
    await chrome.tabs.create({ url, active: false });
    return { ok: true, detail: '已在后台新建会话' };
  }
  if (command.action === 'resync') {
    // 后端重置了数据库：让每个页面把当前会话重新上报，并强制对账一次标签页
    const all = await chrome.tabs.query({});
    await Promise.all(all.filter((t) => t.id != null && /^https:/.test(t.url || '')).map((t) =>
      chrome.tabs.sendMessage(t.id, { kind: 'resync' }).catch(() => null)));
    ready.then((bg) => syncTabsNow(bg, true));
    return { ok: true, detail: '已重新上报' };
  }
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
  if (command.action === 'reply' && Array.isArray(command.attachments) && command.attachments.length) {
    // 快速回复带文件：先从后端取回文件，再交给页面自己的上传控件
    const { serverUrl, token } = await loadSettings();
    const got = await fetchAttachments({ serverUrl, token, attachments: command.attachments });
    if (!got.ok) return got;
    command = { ...command, files: got.files };
  }
  try {
    const r = await chrome.tabs.sendMessage(tabId, { kind: 'bridge_command', command });
    return r || { ok: false, code: 'no_response' };
  } catch (e) {
    return { ok: false, code: 'tab_unreachable', detail: String(e?.message || e) };
  }
}

function showConnBadge(state) {
  const badge = { open: 'ON', auth_failed: 'AUTH', waiting: '…', connecting: '…', handshaking: '…' }[state] || '';
  chrome.action.setBadgeText({ text: badge }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state === 'open' ? '#16a34a' : '#dc2626' }).catch(() => {});
  chrome.action.setTitle({ title: 'AI-Chat-Room' }).catch(() => {});
}

const ready = (async () => {
  const settings = await loadSettings();
  const bg = createBackground({
    WebSocketImpl: WebSocket, storage, clientId: settings.clientId, settings,
    // 看板指令 → 对应标签页的内容脚本执行
    executeCommand: runCommand
  });
  await ensureRegistered();
  if (settings.token) { await bg.conn.start(); syncSites().catch(() => {}); }
  bg.conn.onStateChange = (state) => {
    showConnBadge(state);
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
        let supported = false;
        try {
          const r = await Promise.race([
            chrome.tabs.sendMessage(t.id, { kind: 'page_info' }),
            new Promise((res) => setTimeout(() => res(null), 800))
          ]);
          if (r?.ok) { conversationId = r.conversation_id || null; supported = true; }
        } catch { /* 没有内容脚本的标签页 */ }
        let host = '';
        try { host = new URL(t.url).hostname; } catch { /* ignore */ }
        return { tab_id: t.id, host, conversation_id: conversationId, supported, active: !!t.active, url: t.url, title: t.title || '' };
      }));
      bg.syncTabs(list, { force: f });
    } catch (e) { console.warn('[bridge] tab sync failed', e); }
  }, 300);
}

// 注意：监听器必须在顶层同步注册，SW 被唤醒时才能收到事件
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ready.then(async (bg) => {
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
chrome.tabs.onActivated.addListener(() => { ready.then((bg) => syncTabsNow(bg)); });
chrome.windows?.onFocusChanged?.addListener(() => { ready.then((bg) => syncTabsNow(bg)); });

// SW 可能被回收：用 alarm 定期唤醒并检查连接
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'bridge-keepalive') ready.then((bg) => { bg.conn.poke(); syncTabsNow(bg); }); });
