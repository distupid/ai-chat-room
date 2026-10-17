// 会话管理看板：HTTP 拉取会话列表 + WebSocket 实时广播 + 页面指令（跳转 / 快速回复 / 重新回答）
import { makeEnvelope, MessageType, randomId } from './protocol.js';

const $ = (id) => document.getElementById(id);

const STATUS = {
  limit_reached: { label: '已到限额', order: 0 },
  generating: { label: '回答中', order: 1 },
  error: { label: '出错', order: 2 },
  idle: { label: '空闲', order: 3 },
  closed: { label: '页面已关', order: 4 }
};
const SOURCES = {
  chatgpt: { label: 'ChatGPT', short: 'G', regenerate: true },
  duckai: { label: 'Duck.ai', short: 'D', regenerate: false },
  hark: { label: 'Hark', short: 'H', regenerate: false }
};
const STATUS_FILTERS = [
  ['all', '全部'], ['generating', '回答中'], ['limit_reached', '已到限额'], ['error', '出错'],
  ['idle', '空闲'], ['closed', '页面已关'], ['todo', '未完成'], ['done', '已完成']
];

const ICON = {
  light: '<svg class="i" viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM2 13h2a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2zm18 0h2a1 1 0 0 0 0-2h-2a1 1 0 0 0 0 2zM11 2v2a1 1 0 0 0 2 0V2a1 1 0 0 0-2 0zm0 18v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0zM5.99 4.58a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41L5.99 4.58zm12.37 12.37a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41l-1.06-1.06zm1.06-10.96a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41l1.06-1.06zM7.05 18.36a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41l1.06-1.06z"/></svg>',
  dark: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>',
  system: '<svg class="i" viewBox="0 0 24 24"><path d="M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h4v2h8v-2h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H4V5h16v11z"/></svg>'
};

// ------------------------------------------------------------------ 本地设置

const LS = 'bridgeDashboard.';
const load = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => localStorage.setItem(LS + k, JSON.stringify(v));

const settings = {
  token: load('token', localStorage.getItem('bridgeDashboardToken') || ''),
  theme: load('theme', 'system'),
  notify: load('notify', { enabled: false, limit_reached: true, finished: true, error: true, background_only: true })
};

const state = {
  ws: null,
  wsState: 'idle',
  canControl: false,
  retry: 0,
  manualClose: false,
  conversations: [],
  filter: load('filter', 'all'),
  source: load('source', 'all'),
  search: '',
  sort: load('sort', 'activity'),
  selected: null,
  messages: new Map(),
  streaming: new Set(),
  quickOpen: new Set(),
  drafts: new Map(),
  pendingCommands: new Map(),
  lastStatus: new Map(),
  refreshTimer: null
};

// ------------------------------------------------------------------ 工具

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;   // 只用于本文件内置的 SVG 图标
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

function ago(ts) {
  if (!ts) return '-';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(ts).toLocaleString();
}

function duration(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

function snackbar(text, kind = '') {
  const t = el('div', { class: `snackbar ${kind}`, role: 'status' }, text);
  $('snackbars').append(t);
  while ($('snackbars').children.length > 3) $('snackbars').firstChild.remove();
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${settings.token}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) }
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function titleOf(c) {
  const t = (c.title || '').replace(/\s*[-|·]\s*(ChatGPT|Hark|Duck\.ai|DuckDuckGo)\s*$/i, '').trim();
  if (t && !/^(ChatGPT|Hark|Duck\.ai|聊天)$/i.test(t) && !/^Duck\.ai 是由/.test(t)) return t;
  if (c.first_user_text) return c.first_user_text.split('\n')[0].slice(0, 120);
  return c.conversation_id;
}
const sourceInfo = (s) => SOURCES[s] || { label: s || '未知', short: (s || '?').slice(0, 1).toUpperCase(), regenerate: false };

// ------------------------------------------------------------------ 主题

const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme() {
  const t = settings.theme === 'system' ? (media && media.matches ? 'dark' : 'light') : settings.theme;
  document.documentElement.setAttribute('data-theme', t);
  $('themeBtn').innerHTML = ICON[settings.theme] || ICON.system;
  $('themeBtn').title = `主题：${{ light: '浅色', dark: '深色', system: '跟随系统' }[settings.theme]}（点击切换）`;
  for (const b of document.querySelectorAll('[data-theme-opt]')) b.classList.toggle('on', b.dataset.themeOpt === settings.theme);
}
function setTheme(t) { settings.theme = t; save('theme', t); applyTheme(); }
media?.addEventListener?.('change', applyTheme);

// ------------------------------------------------------------------ 系统通知

function notificationsSupported() { return typeof window.Notification === 'function'; }

function renderNotifySettings() {
  const n = settings.notify;
  const perm = notificationsSupported() ? Notification.permission : 'unsupported';
  $('notifyEnabled').setAttribute('aria-checked', String(n.enabled && perm === 'granted'));
  $('notifyEnabled').disabled = perm === 'unsupported' || perm === 'denied';
  $('notifyPerm').textContent = {
    granted: '浏览器已允许通知',
    default: '打开时会请求浏览器通知权限',
    denied: '浏览器已拒绝通知：请在地址栏左侧的站点设置里允许',
    unsupported: '当前浏览器不支持系统通知'
  }[perm];
  for (const sw of document.querySelectorAll('[data-notify]')) {
    sw.setAttribute('aria-checked', String(!!n[sw.dataset.notify]));
    sw.disabled = !(n.enabled && perm === 'granted');
  }
}

async function toggleNotifications() {
  if (!notificationsSupported()) return;
  if (!settings.notify.enabled) {
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    settings.notify.enabled = perm === 'granted';
    if (perm !== 'granted') snackbar('浏览器没有允许通知', 'err');
  } else {
    settings.notify.enabled = false;
  }
  save('notify', settings.notify);
  renderNotifySettings();
}

/** kind: limit_reached | finished | error */
function notify(kind, conversationId, title, body) {
  const n = settings.notify;
  if (!n.enabled || !n[kind] || !notificationsSupported() || Notification.permission !== 'granted') return false;
  if (n.background_only && document.visibilityState === 'visible' && document.hasFocus?.()) return false;
  try {
    const note = new Notification(title, { body: (body || '').slice(0, 200), tag: `${kind}:${conversationId || ''}`, renotify: true });
    note.onclick = () => { window.focus(); if (conversationId) openDetail(conversationId); note.close(); };
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ 数据

async function loadConversations() {
  try {
    const data = await api('/api/conversations?limit=500');
    state.conversations = data.conversations;
    for (const c of data.conversations) {
      if (!state.lastStatus.has(c.conversation_id)) state.lastStatus.set(c.conversation_id, c.page_status);
    }
    render();
  } catch (e) {
    snackbar(`读取会话失败：${e.message}`, 'err');
    if (/unauthorized|forbidden/i.test(e.message)) setConn('off', 'token 无效或权限不足');
  }
}

function scheduleRefresh(delay = 400) {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; loadConversations(); }, delay);
}

const convById = (id) => state.conversations.find((x) => x.conversation_id === id);

async function openDetail(conversationId) {
  state.selected = conversationId;
  state.messages = new Map();
  state.streaming = new Set();
  $('detailScrim').classList.add('open');
  renderDetailHead();
  renderDetail(true, true);
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
    if (state.selected !== conversationId) return;
    for (const m of data.messages) state.messages.set(m.message_id, { role: m.role, index: m.msg_index, text: m.text });
    renderDetail(true, true);
  } catch (e) { snackbar(`读取消息失败：${e.message}`, 'err'); }
}

function closeDetail() {
  state.selected = null;
  $('detailScrim').classList.remove('open');
}

async function lastAnswer(conversationId) {
  let list = [];
  if (state.selected === conversationId && state.messages.size) list = [...state.messages.values()];
  else list = (await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`)).messages
    .map((m) => ({ role: m.role, index: m.msg_index, text: m.text }));
  const answers = list.filter((m) => m.role === 'assistant').sort((a, b) => a.index - b.index);
  return answers.length ? answers.at(-1).text : null;
}

// ------------------------------------------------------------------ 操作

async function copyAnswer(conversationId) {
  try {
    const text = await lastAnswer(conversationId);
    if (!text) return snackbar('这个会话还没有回答', 'err');
    await navigator.clipboard.writeText(text);
    snackbar(`已复制回答（${text.length} 字）`, 'ok');
  } catch (e) { snackbar(`复制失败：${e.message}`, 'err'); }
}

async function toggleDone(c) {
  try {
    await api(`/api/conversations/${encodeURIComponent(c.conversation_id)}/mark`, { method: 'POST', body: JSON.stringify({ done: !c.done }) });
    snackbar(c.done ? '已取消完成标记' : '已标记完成', 'ok');
    loadConversations();
  } catch (e) { snackbar(`标记失败：${e.message}`, 'err'); }
}

function sendCommand(conversationId, action, text, { quiet = false } = {}) {
  if (!state.ws || state.ws.readyState !== 1 || state.wsState !== 'open' || !state.canControl) return false;
  const commandId = randomId('cmd').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  state.pendingCommands.set(commandId, { conversation_id: conversationId, action });
  state.ws.send(JSON.stringify(makeEnvelope(MessageType.COMMAND, {
    command_id: commandId, action, conversation_id: conversationId, ...(text ? { text } : {})
  })));
  if (!quiet) snackbar(action === 'reply' ? '正在发送回复…' : '正在请求重新回答…');
  render();
  return true;
}

/** 点卡片：有标签页开着就切过去，没有就新开一个 */
function jumpTo(c) {
  if (c.open_tabs > 0 && sendCommand(c.conversation_id, 'focus', null, { quiet: true })) return;
  openUrl(c.url);
}
function openUrl(url) {
  if (!url) return snackbar('这个会话没有记录页面地址', 'err');
  window.open(url, '_blank', 'noopener');
}

const CODE_TEXT = {
  no_open_tab: '没有打开着这个会话的标签页',
  busy: '页面正在回答，稍后再试',
  tab_moved: '那个标签页已经切到别的会话了',
  composer_not_found: '页面上没找到输入框',
  regenerate_not_found: '没找到“重新生成”按钮',
  regenerate_unsupported: '这个站点不支持重新回答',
  timeout: '插件没有及时响应',
  tab_unreachable: '联系不上那个标签页（请刷新页面）'
};

function onCommandResult(msg) {
  const p = state.pendingCommands.get(msg.command_id);
  state.pendingCommands.delete(msg.command_id);
  if (p?.action === 'focus') {
    // 切换失败（标签页已关等）→ 新开页面
    if (!msg.ok) openUrl(convById(p.conversation_id)?.url);
    render();
    return;
  }
  const what = p?.action === 'reply' ? '快速回复' : '重新回答';
  if (msg.ok) {
    snackbar(`${what}：${msg.detail || '成功'}`, 'ok');
    if (p?.action === 'reply') { state.drafts.delete(p.conversation_id); state.quickOpen.delete(p.conversation_id); }
  } else {
    snackbar(`${what}失败：${CODE_TEXT[msg.code] || msg.detail || msg.code || '未知错误'}`, 'err');
  }
  render();
}

// ------------------------------------------------------------------ WebSocket

function setConn(kind, text) {
  $('connDot').className = `dot ${kind}`;
  $('connText').textContent = text;
  $('connDetail').textContent = text;
}

function disconnect() {
  state.manualClose = true;
  if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } }
  state.ws = null;
  state.wsState = 'closed';
  setConn('off', '已断开');
}

function connect() {
  if (state.ws) { try { state.ws.onclose = null; state.ws.close(); } catch { /* ignore */ } }
  state.manualClose = false;
  if (!settings.token) { setConn('off', '未设置 token'); openSettings(); return; }
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  state.ws = ws;
  state.wsState = 'connecting';
  setConn('', '连接中…');
  ws.onopen = () => {
    ws.send(JSON.stringify(makeEnvelope(MessageType.HELLO, {
      client_id: `dashboard-${randomId('d').replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}`,
      client_kind: 'observer',
      token: settings.token
    })));
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'welcome') {
      state.wsState = 'open';
      state.retry = 0;
      state.canControl = m.scopes.includes('control');
      setConn('on', state.canControl ? '已连接' : '已连接（无 control 权限，不能跳转 / 回复 / 重新回答）');
      ws.send(JSON.stringify(makeEnvelope(MessageType.SUBSCRIBE, { conversations: ['*'] })));
      loadConversations();
    } else if (m.type === 'broadcast') {
      onBroadcast(m);
    } else if (m.type === 'command_result') {
      onCommandResult(m);
    } else if (m.type === 'ping') {
      ws.send(JSON.stringify(makeEnvelope(MessageType.PONG, { nonce: m.nonce })));
    } else if (m.type === 'error') {
      if (m.fatal) setConn('off', `已断开：${m.message}`);
      else snackbar(`后台错误：${m.message}`, 'err');
    }
  };
  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    state.wsState = 'closed';
    render();
    if (state.manualClose) return;
    if (/UNAUTHORIZED/.test(ev.reason)) { setConn('off', 'token 无效'); return; }
    const delay = Math.min(15000, 500 * 2 ** state.retry++);
    setConn('off', `已断开，${Math.round(delay / 1000)} 秒后重连`);
    setTimeout(() => { if (state.ws === ws && !state.manualClose) connect(); }, delay);
  };
}

function onBroadcast(b) {
  const conv = b.conversation_id;
  const c = convById(conv);
  const name = c ? titleOf(c) : conv;
  if (conv && conv === state.selected) {
    if (b.event_type === 'message.added' || b.event_type === 'message.updated') {
      const p = b.payload;
      if (typeof p.text === 'string') {
        state.messages.set(p.message_id, { role: p.role, index: p.index, text: p.text });
        if (b.event_type === 'message.updated' && p.role === 'assistant') state.streaming.add(p.message_id);
        renderDetail(true);
      }
    } else if (b.event_type === 'generation.finished') {
      state.streaming.clear();
      renderDetail();
    }
  }
  if (b.event_type === 'conversation.status') {
    const prev = state.lastStatus.get(conv);
    const now = b.payload.status;
    state.lastStatus.set(conv, now);
    if (now !== prev && (now === 'limit_reached' || now === 'error')) {
      const label = now === 'limit_reached' ? '已到限额' : '出错';
      if (!notify(now, conv, `${label}：${name}`, b.payload.detail || sourceInfo(b.payload.source).label)) {
        snackbar(`${label}：${name}${b.payload.detail ? ' — ' + b.payload.detail : ''}`, 'err');
      }
    }
  }
  if (b.event_type === 'generation.finished') {
    const secs = b.payload.duration_ms != null ? `用时 ${duration(b.payload.duration_ms)}` : '';
    notify('finished', conv, `回答完成：${name}`, secs);
  }
  scheduleRefresh(b.event_type === 'message.updated' ? 1500 : 300);
}

// ------------------------------------------------------------------ 渲染：列表

function filtered() {
  const q = state.search.trim().toLowerCase();
  let list = state.conversations.filter((c) => {
    if (state.source !== 'all' && c.source !== state.source) return false;
    if (state.filter === 'todo' && c.done) return false;
    if (state.filter === 'done' && !c.done) return false;
    if (STATUS[state.filter] && c.status !== state.filter) return false;
    if (!q) return true;
    return [titleOf(c), c.conversation_id, c.first_user_text, c.last_message?.text, c.model, c.status_detail]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });
  if (state.sort === 'status') {
    list = [...list].sort((a, b) => (a.done - b.done) ||
      ((STATUS[a.status]?.order ?? 9) - (STATUS[b.status]?.order ?? 9)) || (b.last_seen_at - a.last_seen_at));
  }
  return list;
}

function renderChips() {
  const inSource = state.conversations.filter((c) => state.source === 'all' || c.source === state.source);
  const counts = { all: inSource.length, todo: 0, done: 0 };
  for (const c of inSource) {
    counts[c.status] = (counts[c.status] || 0) + 1;
    counts[c.done ? 'done' : 'todo']++;
  }
  const sources = [...new Set(state.conversations.map((c) => c.source))];
  const chip = (on, label, n, onclick) => el('button', { class: `chip ${on ? 'on' : ''}`, onclick },
    on ? el('span', { html: '<svg class="i s18" viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' }) : null,
    label, n != null ? el('span', { class: 'n' }, n) : null);
  $('chips').replaceChildren(
    ...STATUS_FILTERS.map(([key, label]) => chip(state.filter === key, label, counts[key] || 0,
      () => { state.filter = key; save('filter', key); render(); })),
    sources.length > 1 ? el('span', { class: 'sep' }) : null,
    ...(sources.length > 1 ? [['all', '全部来源'], ...sources.map((s) => [s, sourceInfo(s).label])] : [])
      .map(([key, label]) => chip(state.source === key, label, null, () => { state.source = key; save('source', key); render(); }))
  );
}

function card(c) {
  const id = c.conversation_id;
  const src = sourceInfo(c.source);
  const busy = [...state.pendingCommands.values()].some((p) => p.conversation_id === id && p.action !== 'focus');
  const online = c.open_tabs > 0 && state.wsState === 'open' && state.canControl;
  const canAct = online && !busy;
  const quickOpen = state.quickOpen.has(id);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };

  const textarea = el('textarea', { class: 'field', placeholder: `发到这个 ${src.label} 会话，Ctrl+Enter 发送` });
  textarea.value = state.drafts.get(id) || '';
  textarea.addEventListener('input', () => state.drafts.set(id, textarea.value));
  textarea.addEventListener('click', (e) => e.stopPropagation());
  // 输入法组字期间不重绘，组字结束/失焦后补一次
  textarea.addEventListener('compositionstart', () => { state.composing = true; });
  textarea.addEventListener('compositionend', () => { state.composing = false; flushRender(); });
  textarea.addEventListener('blur', () => setTimeout(flushRender, 0));
  const doSend = () => {
    const text = textarea.value.trim();
    if (!text) return snackbar('回复内容不能为空', 'err');
    if (!sendCommand(id, 'reply', text)) snackbar('实时连接未建立，无法发送', 'err');
  };
  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); }
  });

  const notice = c.status_detail && (c.page_status === 'limit_reached' || c.page_status === 'error')
    ? el('div', { class: `notice ${c.page_status === 'error' ? 'err' : ''}` }, c.status_detail) : null;
  const offlineTip = c.open_tabs ? '' : '需要有标签页开着这个会话';

  const node = el('article', {
    class: `card s-${c.status} ${c.done ? 'done' : ''}`,
    'data-conv': id, tabindex: '0', role: 'button',
    title: c.open_tabs ? '点击切换到这个会话的标签页' : '点击打开这个会话',
    onclick: () => jumpTo(c),
    onkeydown: (e) => { if (e.target === node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); jumpTo(c); } }
  },
    el('div', { class: 'head' },
      el('div', { class: `avatar ${SOURCES[c.source] ? c.source : 'other'}`, title: src.label }, src.short),
      el('div', { class: 'tt' },
        el('div', { class: 'title' }, titleOf(c)),
        el('div', { class: 'sub' },
          el('span', {}, src.label),
          c.model ? el('span', {}, c.model) : null,
          el('span', { title: new Date(c.last_seen_at).toLocaleString() }, ago(c.last_seen_at)))),
      el('span', { class: `badge b-${c.status}` }, STATUS[c.status]?.label || c.status)
    ),
    el('div', { class: 'tags' },
      el('span', { class: 'tag' }, `${c.user_count} 问 · ${c.assistant_count} 答`),
      el('span', { class: 'tag' }, `${c.open_tabs} 个标签页`),
      c.last_duration_ms != null ? el('span', { class: 'tag' }, `上次回答 ${duration(c.last_duration_ms)}`) : null,
      c.done ? el('span', { class: 'tag' }, '已完成') : null,
      c.activity_after_done ? el('span', { class: 'tag warn' }, '完成后有新动态') : null
    ),
    notice,
    c.last_message ? el('div', { class: 'preview' },
      el('b', {}, c.last_message.role === 'user' ? '我：' : `${src.label}：`), c.last_message.text) : null,
    el('div', { class: 'actions' },
      el('button', { class: 'btn tonal s', disabled: !canAct, title: offlineTip,
        onclick: stop(() => { quickOpen ? state.quickOpen.delete(id) : state.quickOpen.add(id); render(); }) },
        quickOpen ? '收起' : '快速回复'),
      el('button', { class: 'btn outlined s', onclick: stop(() => toggleDone(c)) }, c.done ? '取消完成' : '标记完成'),
      src.regenerate ? el('button', {
        class: 'btn outlined s', title: offlineTip,
        disabled: !canAct || c.status === 'generating' || c.assistant_count === 0,
        onclick: stop(() => sendCommand(id, 'regenerate'))
      }, '重新回答') : null,
      el('button', { class: 'btn text s', onclick: stop(() => openDetail(id)) }, '详情')
    ),
    el('div', { class: `quick ${quickOpen ? 'open' : ''}`, onclick: (e) => e.stopPropagation() },
      textarea,
      el('div', { class: 'row' },
        el('span', { class: 'hint' }, c.status === 'generating' ? '正在回答中，发送会被拒绝' : '在开着这个会话的标签页里发送'),
        el('button', { class: 'btn filled s', disabled: !canAct, onclick: stop(doSend) }, busy ? '发送中…' : '发送')))
  );
  return node;
}

function flushRender() {
  if (state.renderPending && !state.composing) { state.renderPending = false; render(); }
}

function render() {
  const grid = $('grid');
  const active = document.activeElement;
  const activeCard = active?.tagName === 'TEXTAREA' ? active.closest('.card') : null;
  const activeConv = activeCard?.dataset.conv || null;
  // 正在用输入法组字：整次重绘推迟，避免打断
  if (state.composing && activeConv) { state.renderPending = true; return; }
  renderChips();
  const caret = activeConv ? [active.selectionStart, active.selectionEnd] : null;

  const list = filtered();
  if (!state.conversations.length) {
    grid.replaceChildren(el('div', { class: 'empty' }, state.wsState === 'open'
      ? '还没有会话。打开 ChatGPT、Duck.ai 或 Hark 的一个对话试试。'
      : '点右上角的设置，填入 observer token 并连接。'));
  } else if (!list.length) {
    grid.replaceChildren(el('div', { class: 'empty' }, '没有符合条件的会话'));
  } else {
    // 正在输入的那张卡片保留原节点不替换，焦点和输入状态不受影响；失焦后再刷新它
    const nodes = list.map((c) => {
      if (c.conversation_id === activeConv) { state.renderPending = true; return activeCard; }
      return card(c);
    });
    if (activeCard && nodes.includes(activeCard)) {
      // 不能整体 replaceChildren（会让输入框失焦、打断输入法），只替换它周围的节点
      for (const n of [...grid.childNodes]) if (n !== activeCard) n.remove();
      const i = nodes.indexOf(activeCard);
      activeCard.before(...nodes.slice(0, i));
      activeCard.after(...nodes.slice(i + 1));
    } else {
      grid.replaceChildren(...nodes);
    }
  }
  if (activeConv && document.activeElement !== active) {
    const ta = [...grid.querySelectorAll('.card')].find((n) => n.dataset.conv === activeConv)?.querySelector('textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(caret[0], caret[1]); }
  }
  if (state.selected) renderDetailHead();
}

// ------------------------------------------------------------------ 渲染：详情

/** 轻量 Markdown：``` 代码块、空行分段、`行内代码`；全部用 textContent 写入，不解析 HTML */
function renderText(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text || '').split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      frag.append(el('pre', {}, el('code', {}, part.replace(/\n$/, ''))));
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = el('p');
      para.split(/(`[^`\n]+`)/).forEach((seg) => {
        if (/^`[^`\n]+`$/.test(seg)) p.append(el('code', { class: 'inl' }, seg.slice(1, -1)));
        else if (seg) p.append(seg);
      });
      frag.append(p);
    }
  });
  return frag;
}

function renderDetailHead() {
  const c = convById(state.selected);
  $('detailTitle').textContent = c ? titleOf(c) : state.selected;
  const sub = $('detailSub');
  if (!c) { sub.replaceChildren(); return; }
  sub.replaceChildren(
    el('span', { class: `badge b-${c.status}` }, STATUS[c.status]?.label || c.status),
    el('span', {}, sourceInfo(c.source).label),
    c.model ? el('span', {}, c.model) : null,
    el('span', {}, `${c.message_count} 条消息`),
    el('span', {}, ago(c.last_seen_at)),
    c.status_detail && c.page_status !== 'ok' ? el('span', {}, c.status_detail) : null
  );
}

function renderDetail(scrollToEnd = false, forceBottom = false) {
  const body = $('detailBody');
  const nearBottom = forceBottom || body.scrollHeight - body.scrollTop - body.clientHeight < 120;
  const msgs = [...state.messages.entries()].sort((a, b) => a[1].index - b[1].index);
  const c = convById(state.selected);
  const src = sourceInfo(c?.source);
  $('detailMsgs').replaceChildren(...(msgs.length ? msgs.map(([id, m]) => el('div', {
    class: `msg ${m.role} ${state.streaming.has(id) ? 'streaming' : ''}`
  },
    el('div', { class: 'meta' },
      el('span', {}, m.role === 'user' ? '我' : m.role === 'assistant' ? src.label : m.role),
      el('span', {}, `${m.text.length} 字`)),
    el('div', { class: 'body' }, renderText(m.text)))) : [el('div', { class: 'empty' }, '暂无消息')]));
  if (scrollToEnd && nearBottom) body.scrollTop = body.scrollHeight;
}

// ------------------------------------------------------------------ 设置

function openSettings() {
  $('token').value = settings.token;
  renderNotifySettings();
  applyTheme();
  $('settingsScrim').classList.add('open');
  loadServerInfo();
}
function closeSettings() { $('settingsScrim').classList.remove('open'); }

async function loadServerInfo() {
  try {
    const s = await (await fetch('/stats')).json();
    const c = s.counters || {};
    const rows = [
      ['运行时间', duration(s.server?.uptime_ms)],
      ['协议版本', s.server?.protocol ?? '-'],
      ['在线客户端', s.broadcast?.connected_clients ?? '-'],
      ['已存事件', s.events_in_db ?? '-'],
      ['事件 收到 / 入库 / 重复 / 拒收', `${c.events_received ?? 0} / ${c.events_persisted ?? 0} / ${c.events_duplicate ?? 0} / ${c.events_rejected ?? 0}`],
      ['指令 成功 / 失败', `${c.commands_ok ?? 0} / ${c.commands_failed ?? 0}`]
    ];
    $('serverInfo').replaceChildren(...rows.flatMap(([k, v]) => [el('span', { class: 'k' }, k), el('span', {}, String(v))]));
    const clients = s.broadcast?.clients || [];
    $('serverClients').textContent = clients.length
      ? '在线：' + clients.map((x) => `${x.kind}:${x.client_id}`).join('，') : '没有在线客户端';
  } catch (e) {
    $('serverInfo').replaceChildren(el('span', { class: 'k' }, '状态'), el('span', {}, `无法读取后台状态：${e.message}`));
  }
}

// ------------------------------------------------------------------ 启动

$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = closeSettings;
$('settingsScrim').addEventListener('click', (e) => { if (e.target === $('settingsScrim')) closeSettings(); });
$('connect').onclick = () => {
  settings.token = $('token').value.trim();
  save('token', settings.token);
  connect();
};
$('disconnect').onclick = disconnect;
$('themeBtn').onclick = () => setTheme({ light: 'dark', dark: 'system', system: 'light' }[settings.theme] || 'light');
for (const b of document.querySelectorAll('[data-theme-opt]')) b.onclick = () => setTheme(b.dataset.themeOpt);
$('notifyEnabled').onclick = toggleNotifications;
for (const sw of document.querySelectorAll('[data-notify]')) {
  sw.onclick = () => { settings.notify[sw.dataset.notify] = !settings.notify[sw.dataset.notify]; save('notify', settings.notify); renderNotifySettings(); };
}
$('notifyTest').onclick = () => {
  if (!settings.notify.enabled || Notification.permission !== 'granted') return snackbar('请先启用系统通知', 'err');
  try { new Notification('会话管理', { body: '这是一条测试通知' }); } catch (e) { snackbar(`通知失败：${e.message}`, 'err'); }
};
$('serverRefresh').onclick = loadServerInfo;
$('search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
$('sort').value = state.sort;
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; save('sort', state.sort); render(); });
$('detailClose').onclick = closeDetail;
$('detailScrim').addEventListener('click', (e) => { if (e.target === $('detailScrim')) closeDetail(); });
$('detailCopy').onclick = () => state.selected && copyAnswer(state.selected);
$('detailJump').onclick = () => { const c = convById(state.selected); if (c) jumpTo(c); };
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('settingsScrim').classList.contains('open')) closeSettings();
  else if (state.selected) closeDetail();
});

applyTheme();
render();
if (settings.token) connect(); else setConn('off', '未设置 token');
// 相对时间、标签页状态等每 15 秒刷新一次
setInterval(() => { if (state.wsState === 'open') loadConversations(); }, 15000);
