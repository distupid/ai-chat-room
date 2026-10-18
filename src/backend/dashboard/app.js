// AI-Chat-Room 看板：HTTP 拉取会话列表 + WebSocket 实时广播 + 页面指令（跳转 / 快速回复 / 重新回答）
// 卡片：点击打开详情；置顶 / 归档 / 重新回答。详情：快速回复（常见回答候选）、每条回答 复制 / 收藏 / 重新回答 / 折叠。
import { makeEnvelope, MessageType, randomId } from './protocol.js';

const $ = (id) => document.getElementById(id);

const STATUS = {
  generating: { label: '回答中', order: 1 },
  error: { label: '出错', order: 2 },
  idle: { label: '空闲', order: 3 },
  closed: { label: '页面已关', order: 4 }
};
// 来源（网站）信息：全部来自后端网站列表（GET /api/sites），没有内置网站；
// regenerate = 该网站的 DOM 配置里有“重新生成”按钮（与 page-actions.js 的判断一致）
const SOURCES = {};
// 状态筛选（再点一次已选中的取消 = 全部，“全部”不含页面已关）；“收藏”由顶栏星标按钮切换
const STATUS_FILTERS = [
  ['all', '全部'], ['pinned', '置顶'], ['generating', '回答中'], ['error', '出错'],
  ['idle', '空闲'], ['closed', '页面已关'], ['favorite', '收藏']
];
const DEFAULT_QUICK_REPLIES = ['继续', '请详细解释一下', '给出完整代码', '总结一下要点', '换一种思路再试试', '用中文回答', '谢谢，没问题了'];

const SVG = {
  closeTab: '<svg class="i s18" viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-3.59 12L14 16.41 12 14.41l-2 2L8.59 15l2-2-2-2L10 9.59l2 2 2-2L15.41 11l-2 2 2 2z"/></svg>',
  reply: '<svg class="i s18" viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
  pin: '<svg class="i s18" viewBox="0 0 24 24"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>',
  copy: '<svg class="i s18" viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>',
  star: '<svg class="i s18" viewBox="0 0 24 24"><path d="m22 9.24-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/></svg>',
  starOn: '<svg class="i s18" viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
  redo: '<svg class="i s18" viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
  fold: '<svg class="i s18" viewBox="0 0 24 24"><path d="M7.41 18.59 8.83 20 12 16.83 15.17 20l1.41-1.41L12 14l-4.59 4.59zm9.18-13.18L15.17 4 12 7.17 8.83 4 7.41 5.41 12 10l4.59-4.59z"/></svg>',
  unfold: '<svg class="i s18" viewBox="0 0 24 24"><path d="M12 5.83 15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z"/></svg>',
  up: '<svg class="i s18" viewBox="0 0 24 24"><path d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>',
  down: '<svg class="i s18" viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>',
  del: '<svg class="i s18" viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
};

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
  // sound：普通会话回答完成播放音效；pinned_popup：置顶会话回答完成直接弹窗；enabled：系统通知（需要浏览器权限）
  // all_popup：所有会话回答完成都弹窗（默认关）
  notify: { enabled: false, sound: true, pinned_popup: true, all_popup: false, ...load('notify', {}) },
  quickReplies: load('quickReplies', DEFAULT_QUICK_REPLIES)
};
delete settings.notify.finished;
if (!Array.isArray(settings.quickReplies)) settings.quickReplies = [...DEFAULT_QUICK_REPLIES];

const state = {
  ws: null,
  wsState: 'idle',
  canControl: false,
  retry: 0,
  manualClose: false,
  conversations: [],
  filter: STATUS_FILTERS.some(([k]) => k === load('filter', 'all')) ? load('filter', 'all') : 'all',
  source: load('source', 'all'),
  search: '',
  sites: [],
  probe: null,
  selected: null,
  messages: new Map(),
  streaming: new Set(),
  collapsed: new Set(),
  stickBottom: true,      // 详情是否跟随到底部（最后一个回复）
  activeTabs: new Map(),  // 插件 client_id → 各窗口当前显示的会话
  longOpen: new Set(),   // 超长消息：用户手动展开了全文的 message_id
  composerOpen: false,
  candIndex: -1,
  drafts: new Map(),
  cardReply: null,
  pendingCommands: new Map(),
  lastStatus: new Map(),
  refreshTimer: null,
  refreshAt: 0
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

const escRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 页面标题里的网站名（网站列表里的名称 / 标识）：标题去掉“ - 网站名”后缀；只剩网站名的标题不算标题。
 * 正则按网站名缓存（每次渲染每张卡片都要用，网站列表变了才重建）。
 */
let siteRes = { key: null, suffix: null, bare: null };
function siteTitleRes() {
  const names = [...new Set(Object.entries(SOURCES).flatMap(([k, v]) => [k, v.label]).filter(Boolean))].map(escRe).join('|');
  if (siteRes.key !== names) {
    siteRes = names
      ? { key: names, suffix: new RegExp(`\\s*[-|·]\\s*(${names})\\s*$`, 'i'), bare: new RegExp(`^(?:(${names})$|(${names}) 是由)`, 'i') }
      : { key: names, suffix: null, bare: null };
  }
  return siteRes;
}
function titleOf(c) {
  if (c.pending) return `新对话 · ${sourceInfo(c.source).label}`;
  const re = siteTitleRes();
  let t = (c.title || '').trim();
  if (re.suffix) t = t.replace(re.suffix, '').trim();
  const bare = /^聊天$/.test(t) || (re.bare && re.bare.test(t));
  if (t && !bare) return t;
  if (c.first_user_text) return c.first_user_text.split('\n')[0].slice(0, 120);
  return c.conversation_id;
}
// 只影响头像配色：index.html 里有专门配色的来源，其余统一配色
const COLORED_SOURCES = ['chatgpt', 'duckai', 'hark'];
const avatarClass = (s) => COLORED_SOURCES.includes(s) ? s : 'other';
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
    sw.disabled = sw.dataset.needsSystem ? !(n.enabled && perm === 'granted') : false;
  }
}

// 提示音：Web Audio 合成，不需要音频文件；浏览器要求先有一次用户操作才能出声
let audioCtx = null;
function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) { try { audioCtx = new AC(); } catch { audioCtx = null; } }
  if (audioCtx?.state === 'suspended') audioCtx.resume?.().catch(() => {});
  return audioCtx;
}
function playSound(strong = false) {
  const ctx = unlockAudio();
  if (!ctx) return false;
  try {
    const notes = strong ? [880, 1175, 1568] : [988, 1319];
    const t0 = ctx.currentTime + 0.01;
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.3);
    });
    return true;
  } catch { return false; }
}

const pageInFront = () => document.visibilityState === 'visible' && (document.hasFocus ? document.hasFocus() : true);

/** 页面内弹窗（置顶会话回答完成） */
function showPopup(conversationId, title, body) {
  state.alertConv = conversationId || null;
  $('alertTitle').textContent = title;
  $('alertBody').replaceChildren(...String(body || '').split('\n').filter(Boolean).map((line) => el('p', { style: 'margin:0 0 6px' }, line)));
  $('alertOpen').hidden = !conversationId;
  $('alertScrim').classList.add('open');
}
function closePopup() { $('alertScrim').classList.remove('open'); state.alertConv = null; }

/** 最后一个回答的文字（系统通知里展示），取不到时用卡片上的摘要 */
async function latestAnswerText(c, conversationId) {
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
    const list = (data.messages || []).filter((m) => m.role === 'assistant');
    const t = list.at(-1)?.text;
    if (t) return t;
  } catch { /* 退回卡片摘要 */ }
  return c?.last_message?.role === 'assistant' ? c.last_message.text || '' : '';
}

async function systemNotify(c, conversationId, title, secs) {
  const answer = (await latestAnswerText(c, conversationId)).replace(/\s+/g, ' ').trim();
  const body = [secs, answer.length > 300 ? answer.slice(0, 300) + '…' : answer].filter(Boolean).join('\n');
  try {
    const note = new Notification(title, { body, tag: `answer:${conversationId}`, renotify: true, requireInteraction: !!c?.pinned });
    note.onclick = () => { window.focus(); closePopup(); openDetail(conversationId); note.close(); };
  } catch { /* 系统通知失败时只保留页面内弹窗 */ }
}

/**
 * 回答完成：普通会话 → 音效（打开“所有会话弹窗”时同置顶）；置顶会话 → 弹窗 + 提示音。
 * 看板在前台：直接打开该会话的详情；在后台：系统通知（含回答内容），回来时看到页面内弹窗。
 */
function onAnswerFinished(c, conversationId, name, secs) {
  const n = settings.notify;
  const pinned = !!c?.pinned;
  if (pinned && !n.pinned_popup) return 'none';
  if (!pinned && !n.all_popup) {
    if (n.sound) { playSound(false); return 'sound'; }
    return 'none';
  }
  if (pinned || n.sound) playSound(pinned);
  const title = `${pinned ? '置顶会话回答完成' : '回答完成'}：${name}`;
  if (pageInFront()) {
    // 正在另一个会话的详情里输入时不打断，改用小弹窗
    const typing = state.selected && state.selected !== conversationId && $('quickText').value.trim();
    if (!typing) { closePopup(); openDetail(conversationId); return 'detail'; }
  } else if (n.enabled && notificationsSupported() && Notification.permission === 'granted') {
    systemNotify(c, conversationId, title, secs);
  }
  showPopup(conversationId, pinned ? '置顶会话回答完成' : '回答完成', `${name}${secs ? '\n' + secs : ''}`);
  return 'popup';
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

// ------------------------------------------------------------------ 数据

/** 拉取会话列表；正在拉取时再次调用只记一次，结束后再拉一次（避免并发请求、旧结果覆盖新结果） */
let loadingConversations = null;
let reloadConversations = false;
function loadConversations() {
  if (loadingConversations) { reloadConversations = true; return loadingConversations; }
  loadingConversations = fetchConversations().finally(() => {
    loadingConversations = null;
    if (reloadConversations) { reloadConversations = false; loadConversations(); }
  });
  return loadingConversations;
}

async function fetchConversations() {
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

/** 合并刷新：已有待执行的刷新时不重复排队；新请求要求更早时提前（流式更新 1.5 秒一次，回答完成等 0.3 秒） */
function scheduleRefresh(delay = 400) {
  const at = Date.now() + delay;
  if (state.refreshTimer) {
    if (at >= state.refreshAt) return;
    clearTimeout(state.refreshTimer);
  }
  state.refreshAt = at;
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; loadConversations(); }, delay);
}

const convById = (id) => state.conversations.find((x) => x.conversation_id === id);

async function openDetail(conversationId, { toFavorite = false } = {}) {
  if (state.selected && state.selected !== conversationId) state.drafts.set(state.selected, $('quickText').value);
  state.selected = conversationId;
  state.messages = new Map();
  msgCache.clear();
  state.streaming = new Set();
  state.longOpen = new Set();
  state.composerOpen = true;   // 点卡片打开详情时直接展开快速回复
  $('quickText').value = '';   // 每次进入弹窗清空输入框，避免把上次没发出去的文字发到别的会话
  closeCands();
  $('detailScrim').classList.add('open');
  renderDetailHead();
  renderComposer();
  renderDetail(true, true);
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
    if (state.selected !== conversationId) return;
    for (const m of data.messages) state.messages.set(m.message_id, { role: m.role, index: m.msg_index, text: m.text, html: m.html || null, favorite: !!m.favorite });
    renderDetail(true, true);
    if (toFavorite) { state.stickBottom = false; scrollToFavorite(); } else scrollDetailBottom();
    if (state.selected === conversationId && state.composerOpen && document.activeElement !== $('quickText')) $('quickText').focus();
  } catch (e) { snackbar(`读取消息失败：${e.message}`, 'err'); }
}

/** 有收藏的会话：打开详情后滚动到（最近的一条）收藏回答并闪一下 */
function scrollToFavorite() {
  const favs = $('detailMsgs').querySelectorAll('.msg.fav');
  const target = favs[favs.length - 1];
  if (!target) return;
  const body = $('detailBody');
  body.scrollTop = Math.max(0, target.offsetTop - body.offsetTop - 8);
  target.scrollIntoView?.({ block: 'start' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1700);
}

function closeDetail() {
  if (state.selected) state.drafts.set(state.selected, $('quickText').value);
  closeCands();
  state.selected = null;
  $('detailScrim').classList.remove('open');
}

// ------------------------------------------------------------------ 操作

async function setMark(c, patch, okText) {
  try {
    await api(`/api/conversations/${encodeURIComponent(c.conversation_id)}/mark`, { method: 'POST', body: JSON.stringify(patch) });
    Object.assign(c, patch);   // 先本地更新，避免等下一次拉取
    render();
    snackbar(okText, 'ok');
    loadConversations();
  } catch (e) { snackbar(`操作失败：${e.message}`, 'err'); }
}
const togglePin = (c) => setMark(c, { pinned: !c.pinned }, c.pinned ? '已取消置顶' : '已置顶，回答完成会直接弹窗');

async function toggleFavorite(conversationId, messageId) {
  const m = state.messages.get(messageId);
  if (!m) return;
  const next = !m.favorite;
  try {
    await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/favorite`,
      { method: 'POST', body: JSON.stringify({ favorite: next }) });
    m.favorite = next;
    renderDetail();
    snackbar(next ? '已收藏这条回答' : '已取消收藏', 'ok');
    scheduleRefresh(100);
  } catch (e) { snackbar(`收藏失败：${e.message}`, 'err'); }
}

/** 卡片“复制”：读取会话消息，复制最后一个回答 */
async function copyLastAnswer(c) {
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(c.conversation_id)}/messages`);
    const last = [...(data.messages || [])].filter((m) => m.role === 'assistant').sort((a, b) => a.msg_index - b.msg_index).pop();
    if (!last || !last.text) return snackbar('这个会话还没有回答', 'err');
    await copyText(last.text);
  } catch (e) { snackbar(`复制失败：${e.message}`, 'err'); }
}

async function copyText(text, what = '回答') {
  try {
    await navigator.clipboard.writeText(text);
    snackbar(`已复制${what}（${text.length} 字）`, 'ok');
  } catch (e) { snackbar(`复制失败：${e.message}`, 'err'); }
}

function sendCommand(conversationId, action, text, { quiet = false, extra = {} } = {}) {
  if (!state.ws || state.ws.readyState !== 1 || state.wsState !== 'open' || !state.canControl) return false;
  const commandId = randomId('cmd').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  state.pendingCommands.set(commandId, { conversation_id: conversationId, action });
  state.ws.send(JSON.stringify(makeEnvelope(MessageType.COMMAND, {
    command_id: commandId, action, conversation_id: conversationId, ...(text ? { text } : {}), ...extra
  })));
  if (!quiet) snackbar({ reply: '正在发送回复…', close: '正在关闭页面…' }[action] || '正在请求重新回答…');
  render();
  if (state.selected === conversationId) { renderComposer(); renderDetail(); }
  return true;
}

/** 详情里的“跳转到页面”：有标签页开着就切过去，没有就新开一个 */
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
  regenerate_target_not_found: '页面上找不到这条回答的“重新生成”按钮（只能重新回答最后一条）',
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
  const what = { reply: '快速回复', close: '关闭页面' }[p?.action] || '重新回答';
  if (msg.ok) {
    snackbar(`${what}：${msg.detail || '成功'}`, 'ok');
    if (p?.action === 'reply') {
      state.drafts.delete(p.conversation_id);
      if (state.selected === p.conversation_id) $('quickText').value = '';
    }
  } else {
    snackbar(`${what}失败：${CODE_TEXT[msg.code] || msg.detail || msg.code || '未知错误'}`, 'err');
  }
  render();
  if (state.selected) { renderComposer(); renderDetail(); }
}

// ------------------------------------------------------------------ WebSocket

/** 顶栏“已连接”：显示当前在线（开着标签页）的会话页面数 */
function connLabel() {
  const pages = state.conversations.reduce((n, c) => n + (c.open_tabs > 0 ? c.open_tabs : 0), 0);
  return `已连接 · ${pages} 个页面${state.canControl ? '' : '（无 control 权限）'}`;
}

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
      setConn('on', connLabel());
      ws.send(JSON.stringify(makeEnvelope(MessageType.SUBSCRIBE, { conversations: ['*'] })));
      // 先拿网站列表（来源名称 / 能力都来自它），再拉会话
      loadSites().then(() => loadConversations());
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

/** 双向绑定：浏览器里每个窗口当前显示的标签页 → 对应卡片高亮（来自插件 tabs.snapshot） */
function activeConvs() {
  const s = new Set();
  for (const set of state.activeTabs.values()) for (const id of set) s.add(id);
  return s;
}

function onBroadcast(b) {
  if (b.event_type === 'tabs.snapshot') {
    const set = new Set((b.payload.tabs || []).filter((t) => t.active && t.conversation_id).map((t) => t.conversation_id));
    state.activeTabs.set(b.origin_client_id || 'ext', set);
    const active = activeConvs();
    for (const n of document.querySelectorAll('.card[data-conv]')) n.classList.toggle('active-page', active.has(n.dataset.conv));
    return;
  }
  const conv = b.conversation_id;
  const c = convById(conv);
  const name = c ? titleOf(c) : conv;
  if (conv && conv === state.selected) {
    if (b.event_type === 'message.added' || b.event_type === 'message.updated') {
      const p = b.payload;
      if (typeof p.text === 'string') {
        state.messages.set(p.message_id, { role: p.role, index: p.index, text: p.text, html: typeof p.html === 'string' ? p.html : null, favorite: !!state.messages.get(p.message_id)?.favorite });
        if (b.event_type === 'message.updated' && p.role === 'assistant') state.streaming.add(p.message_id);
        renderDetail(true);
      }
    } else if (b.event_type === 'generation.finished') {
      state.streaming.clear();
      renderDetail();
    }
  }
  if (b.event_type === 'conversation.status' && b.payload.status === 'deleted') {
    // 源站删除了这个会话：从看板移除，不再跟踪
    state.conversations = state.conversations.filter((x) => x.conversation_id !== conv);
    if (state.selected === conv) closeDetail();
    if (state.cardReply === conv) state.cardReply = null;
    snackbar(`会话已在源站删除，不再跟踪：${name}`);
    render();
    return;
  }
  if (b.event_type === 'conversation.status') {
    const prev = state.lastStatus.get(conv);
    const now = b.payload.status;
    state.lastStatus.set(conv, now);
    if (now !== prev && now === 'error') {
      const label = '出错';
      snackbar(`${label}：${name}${b.payload.detail ? ' — ' + b.payload.detail : ''}`, 'err');
    }
  }
  if (b.event_type === 'generation.finished') {
    const secs = b.payload.duration_ms != null ? `用时 ${duration(b.payload.duration_ms)}` : '';
    onAnswerFinished(c, conv, name, secs);
  }
  scheduleRefresh(b.event_type === 'message.updated' ? 1500 : 300);
}

// ------------------------------------------------------------------ 渲染：列表

function filtered() {
  const q = state.search.trim().toLowerCase();
  let list = state.conversations.filter((c) => {
    if (state.source !== 'all' && c.source !== state.source) return false;
    // 页面已关的会话只在“页面已关”里显示
    if (c.status === 'closed' && state.filter !== 'closed') return false;
    if (state.filter === 'pinned' && !c.pinned) return false;
    if (state.filter === 'favorite' && !c.favorite_count) return false;
    if (STATUS[state.filter] && c.status !== state.filter) return false;
    if (!q) return true;
    return [titleOf(c), c.conversation_id, c.first_user_text, c.last_message?.text, c.model, c.status_detail]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });
  // 置顶的永远在前
  list = [...list].sort((a, b) => (b.pinned - a.pinned) || (b.last_seen_at - a.last_seen_at));
  return list;
}

function renderChips() {
  const inSource = state.conversations.filter((c) => state.source === 'all' || c.source === state.source);
  const counts = { all: 0, pinned: 0, favorite: 0 };
  for (const c of inSource) {
    counts[c.status] = (counts[c.status] || 0) + 1;
    if (c.status === 'closed') continue;
    counts.all++;
    if (c.pinned) counts.pinned++;
    if (c.favorite_count) counts.favorite++;
  }
  const sources = [...new Set(state.conversations.map((c) => c.source))];
  const chip = (on, label, n, onclick) => el('button', { class: `chip ${on ? 'on' : ''}`, onclick },
    on ? el('span', { html: '<svg class="i s18" viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' }) : null,
    label, n != null ? el('span', { class: 'n' }, n) : null);
  const pick = (key) => () => { state.filter = state.filter === key ? 'all' : key; save('filter', state.filter); render(); };
  const group = (items) => items.length ? el('div', { class: 'cg' }, ...items) : null;
  const statusChips = STATUS_FILTERS.filter(([k]) => !['all', 'favorite'].includes(k))
    .map(([key, label]) => chip(state.filter === key, label, counts[key] || 0, pick(key)));
  // 来源筛选上显示当前开着的标签页数量
  const tabsOf = (key) => state.conversations.filter((c) => key === 'all' || c.source === key).reduce((n, c) => n + (c.open_tabs || 0), 0);
  const sourceChips = sources.length > 1
    ? [['all', '全部来源'], ...sources.map((x) => [x, sourceInfo(x).label])]
      .map(([key, label]) => {
        const b = chip(state.source === key, label, tabsOf(key), () => { state.source = key; save('source', key); render(); });
        b.title = `${label}：${tabsOf(key)} 个标签页开着`;
        return b;
      })
    : [];
  const groups = [group(statusChips), group(sourceChips)].filter(Boolean);
  $('chips').replaceChildren(...groups.flatMap((g, i) => i ? [el('span', { class: 'sep' }), g] : [g]));
  const favOn = state.filter === 'favorite';
  $('favBtn').classList.toggle('on', favOn);
  $('favBtn').setAttribute('aria-pressed', String(favOn));
  $('favBtn').innerHTML = favOn ? SVG.starOn.replace('i s18', 'i') : SVG.star.replace('i s18', 'i');
  $('favBtn').title = favOn ? `收藏会话（${counts.favorite}）· 再点返回全部` : `查看收藏会话（${counts.favorite}）`;
}

function card(c) {
  const id = c.conversation_id;
  const src = sourceInfo(c.source);
  const busy = convBusy(id);
  const online = canControlConv(c);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  const offlineTip = c.open_tabs ? '' : '需要有标签页开着这个会话';

  const node = el('article', {
    class: `card s-${c.status} src-${avatarClass(c.source)} ${c.pinned ? 'pinned' : ''}`,
    'data-conv': id, tabindex: '0', role: 'button', title: c.status === 'closed' ? '页面已关：点击重新打开并跳转' : '点击查看详情',
    onclick: () => activateCard(c),
    onkeydown: (e) => { if (e.target === node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activateCard(c); } }
  },
    el('div', { class: 'head' },
      el('div', { class: `avatar ${avatarClass(c.source)}`, title: src.label }, src.short),
      el('div', { class: 'tt' },
        el('div', { class: 'title', title: titleOf(c) },
          c.pinned ? el('span', { html: SVG.pin, title: '已置顶', style: 'display:inline-flex' }) : null,
          el('span', { class: 'tx' }, titleOf(c))),
        el('div', { class: 'sub' },
          el('span', {}, src.label),
          c.model ? el('span', {}, c.model) : null)),
      el('div', { class: 'side' },
        el('span', { class: `badge b-${c.status}` }, STATUS[c.status]?.label || c.status),
        el('span', { class: 'time', title: new Date(c.last_seen_at).toLocaleString() }, ago(c.last_seen_at)))
    ),
    el('div', { class: 'tags' },
      el('span', { class: 'tag' }, `${c.user_count} 问 · ${c.assistant_count} 答`),
      c.last_duration_ms != null ? el('span', { class: 'tag' }, `上次回答 ${duration(c.last_duration_ms)}`) : null,
      c.favorite_count ? el('span', { class: 'tag' }, `${c.favorite_count} 条收藏`) : null,
    ),
    c.last_message ? el('div', { class: 'preview' },
      el('b', {}, c.last_message.role === 'user' ? '我：' : `${src.label}：`), c.last_message.text) : null,
    el('div', { class: 'actions' },
      el('button', { class: `btn ${c.pinned ? 'filled' : 'outlined'} s`, 'data-act': 'pin', 'aria-pressed': String(!!c.pinned), title: c.pinned ? '已置顶，点击取消' : '置顶', onclick: stop(() => togglePin(c)) },
        el('span', { html: SVG.pin, style: 'display:inline-flex' }), c.pinned ? '已置顶' : '置顶'),
      el('button', {
        class: 'btn outlined s', 'data-act': 'copy', title: c.assistant_count ? '复制最后一个回答' : '还没有回答',
        disabled: !c.assistant_count, onclick: stop(() => copyLastAnswer(c))
      }, el('span', { html: SVG.copy, style: 'display:inline-flex' }), '复制'),
      el('button', {
        class: 'btn outlined s', 'data-act': 'close', title: c.open_tabs ? '关闭开着这个会话的标签页' : offlineTip,
        disabled: !online || busy, onclick: stop(() => closePage(c))
      }, el('span', { html: SVG.closeTab, style: 'display:inline-flex' }), '关闭'),
      el('button', {
        class: `btn ${state.cardReply === id ? 'tonal' : 'outlined'} s`, 'data-act': 'reply', 'aria-expanded': String(state.cardReply === id),
        title: offlineTip, onclick: stop(() => toggleCardReply(id))
      }, el('span', { html: SVG.reply, style: 'display:inline-flex' }), '回复')
    ),
    state.cardReply === id ? cardReplyPanel(c, online, busy) : null
  );
  return node;
}

/** 点卡片：页面已关 → 重新打开该页面并跳转；否则打开详情（有收藏的滚到收藏处） */
function activateCard(c) {
  if (c.status === 'closed') { openUrl(c.url); return; }
  openDetail(c.conversation_id, { toFavorite: c.favorite_count > 0 });
}

/** 关闭页面：让插件关掉开着这个会话的标签页，会话随后进入“页面已关” */
function closePage(c) {
  if (!sendCommand(c.conversation_id, 'close')) snackbar('实时连接未建立，无法关闭页面', 'err');
}

/** 一键启动：让插件在后台打开网站列表里的所有网址 */
async function launchAll() {
  try {
    const r = await api('/api/sites/launch', { method: 'POST', body: '{}' });
    snackbar(`正在后台打开还没开着的网站（列表共 ${r.count} 个）`, 'ok');
  } catch (e) { snackbar(`一键启动失败：${e.message}`, 'err'); }
}

// ------------------------------------------------------------------ 卡片：快速回复栏

function toggleCardReply(id) {
  if (state.cardReply) state.drafts.set(state.cardReply, document.querySelector('.creply textarea')?.value ?? state.drafts.get(state.cardReply) ?? '');
  state.cardReply = state.cardReply === id ? null : id;
  if (state.cardReply) state.drafts.delete(state.cardReply);   // 每次展开都从空白开始
  render();
  if (state.cardReply) document.querySelector('.creply textarea')?.focus();
}

function cardReplyPanel(c, online, busy) {
  const id = c.conversation_id;
  const ta = el('textarea', { class: 'field', placeholder: '发到这个会话，Enter 发送，Shift+Enter 换行', 'aria-label': '快速回复' });
  // 展开时已清空草稿；之后看板刷新（会话有更新时整张卡片重建）要保留正在输入的内容
  ta.value = state.drafts.get(id) || '';
  const send = (preset) => {
    const text = (typeof preset === 'string' ? preset : ta.value).trim();
    if (!text) return snackbar('回复内容不能为空', 'err');
    if (!sendCommand(id, 'reply', text)) return snackbar('实时连接未建立，无法发送', 'err');
    // 发出后自动收起
    state.drafts.delete(id);
    if (state.cardReply === id) { state.cardReply = null; render(); }
  };
  ta.addEventListener('input', () => state.drafts.set(id, ta.value));
  // 焦点离开回复栏自动收起（看板刷新重建卡片引起的失焦不算）
  ta.addEventListener('blur', () => setTimeout(() => {
    if (state.rendering || state.cardReply !== id) return;
    if (document.activeElement?.closest?.('.creply')) return;
    toggleCardReply(id);
  }, 150));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); toggleCardReply(id); }
  });
  const quick = settings.quickReplies.filter((t) => t && t.trim()).map((t) => el('button', {
    type: 'button', title: t, disabled: !online || busy, onclick: () => send(t)   // 点击常见回答直接发送
  }, t));
  return el('div', { class: 'creply', onclick: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation() },
    ta,
    quick.length ? el('div', { class: 'qr' }, ...quick) : null,
    el('div', { class: 'row' },
      el('span', { class: 'hint' }, !online ? '需要有标签页开着这个会话' : c.status === 'generating' ? '正在回答中，发送会被拒绝' : ''),
      el('button', { class: 'btn filled s', type: 'button', 'data-act': 'send', disabled: !online || busy, onclick: send }, busy ? '发送中…' : '发送')));
}

/*
 * 卡片按会话复用：卡片用到的数据（会话本身、标题、来源、是否在发送、能否操作、回复栏）都没变时沿用原来的 DOM
 * （焦点、正在输入的回复、选区都不受影响），只更新相对时间和“窗口正显示”高亮；有变化的卡片才重建。
 */
const cardCache = new Map();   // conversation_id → { sig, node }

/** 让 parent 的子节点依次为 nodes：只移动位置不对的节点，去掉多余的（没变的节点不动，焦点和滚动位置保留） */
function placeChildren(parent, nodes) {
  let ref = parent.firstChild;
  for (const node of nodes) {
    if (ref === node) { ref = ref.nextSibling; continue; }
    parent.insertBefore(node, ref);
  }
  while (ref) { const next = ref.nextSibling; ref.remove(); ref = next; }
}
function cardSig(c) {
  const id = c.conversation_id;
  const reply = state.cardReply === id;
  return JSON.stringify([c, titleOf(c), sourceInfo(c.source), convBusy(id), canControlConv(c), reply, reply ? settings.quickReplies : 0]);
}
function renderGrid(grid, list) {
  const active = activeConvs();
  const nodes = list.map((c) => {
    const id = c.conversation_id;
    const sig = cardSig(c);
    let hit = cardCache.get(id);
    if (!hit || hit.sig !== sig) {
      hit = { sig, node: card(c) };
      cardCache.set(id, hit);
    } else {
      const t = hit.node.querySelector('.time');
      const text = ago(c.last_seen_at);
      if (t && t.textContent !== text) t.textContent = text;
    }
    hit.node.classList.toggle('active-page', active.has(id));
    return hit.node;
  });
  placeChildren(grid, nodes);
  // 缓存只留还在列表里的会话（被筛选掉的也留着，切换筛选时直接复用）
  if (cardCache.size > state.conversations.length) {
    const ids = new Set(state.conversations.map((c) => c.conversation_id));
    for (const id of cardCache.keys()) if (!ids.has(id)) cardCache.delete(id);
  }
}

function render() {
  const grid = $('grid');
  if (state.wsState === 'open' && $('connText').textContent !== connLabel()) setConn('on', connLabel());
  renderChips();
  const list = filtered();
  const focusedConv = document.activeElement?.closest?.('.card')?.dataset.conv || null;
  const replyFocus = document.activeElement?.closest?.('.creply') && document.activeElement.tagName === 'TEXTAREA'
    ? { s: document.activeElement.selectionStart, e: document.activeElement.selectionEnd } : null;
  if (!state.conversations.length) {
    grid.replaceChildren(el('div', { class: 'empty' }, state.wsState === 'open'
      ? '还没有会话。打开网站列表（右上角地球图标）里任一网站的一个对话试试。'
      : '点右上角的设置，填入 observer token 并连接。'));
  } else if (!list.length) {
    grid.replaceChildren(el('div', { class: 'empty' }, { favorite: '还没有收藏的会话', closed: '没有已关闭的页面' }[state.filter] || '没有符合条件的会话'));
  } else {
    state.rendering = true;
    try { renderGrid(grid, list); } finally { setTimeout(() => { state.rendering = false; }, 0); }
  }
  if (replyFocus) {
    const ta = grid.querySelector('.creply textarea');
    if (ta) { ta.focus(); ta.setSelectionRange?.(replyFocus.s, replyFocus.e); }
  } else if (focusedConv) [...grid.querySelectorAll('.card')].find((n) => n.dataset.conv === focusedConv)?.focus();
  if (state.selected) { renderDetailHead(); renderComposer(); }
}

// ------------------------------------------------------------------ 网站下拉：已适配网址 + 添加网站

const PROBE_POLL_MS = window.__probePollMs || 1000;

async function loadSites() {
  try {
    const r = await api('/api/sites');
    state.sites = r.sites || [];
    state.missingDefaults = r.missing_defaults || [];
    for (const x of state.sites) {
      SOURCES[x.key] = {
        label: x.name || x.key,
        short: (x.name || x.key).slice(0, 1).toUpperCase(),
        regenerate: !!(x.config && x.config.actions && typeof x.config.actions.regenerate_button === 'string' && x.config.actions.regenerate_button.trim()),
        enabled: x.enabled !== false
      };
    }
    renderSitesMenu();
    if (state.conversations.length) render();
    if (state.selected) renderDetail();
  } catch { /* 旧后端没有 /api/sites */ }
}

function toggleSitesMenu(open) {
  const m = $('sitesMenu');
  const next = open ?? !m.classList.contains('open');
  m.classList.toggle('open', next);
  $('sitesBtn').setAttribute('aria-expanded', String(next));
  if (next) renderSitesMenu();
}

const EDIT_SVG = '<svg class="i s18" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const DEL_SVG = '<svg class="i s18" viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

const CFG_SVG = '<svg class="i s18" viewBox="0 0 24 24"><path d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.9 2.4h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.67 8.88a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.49.42h3.84c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/></svg>';

/** 网站下拉：所有网站一视同仁（包括默认的 ChatGPT / Duck.ai / Hark），都可编辑名称 / 网址、配置（DOM、启用、域名）或删除 */
function renderSitesMenu() {
  const items = state.sites.map((x) => state.editingSite === x.key ? siteEditRow(x) : el('button', {
    class: `mi ${x.enabled === false ? 'off' : ''}`, role: 'menuitem', 'data-site': x.key, title: x.url,
    onclick: () => { toggleSitesMenu(false); window.open(x.url, '_blank', 'noopener'); }
  },
    el('span', { class: `avatar ${avatarClass(x.key)}` }, (x.name || x.key).slice(0, 1).toUpperCase()),
    el('span', { class: 'nm' }, x.name, el('small', {}, x.url)),
    x.enabled === false ? el('span', { class: 'off-tag' }, '已停用') : null,
    el('span', { class: 'icon-btn ed', title: '编辑名称和网址', role: 'button', 'data-act': 'edit', html: EDIT_SVG,
      onclick: (e) => { e.stopPropagation(); state.editingSite = x.key; renderSitesMenu(); $('sitesMenu').querySelector('.editing input')?.focus(); } }),
    el('span', { class: 'icon-btn cfg', title: '网站配置：启用 / 停用、域名、DOM 选择器、会话 ID 规则', role: 'button', 'data-act': 'config', html: CFG_SVG,
      onclick: (e) => { e.stopPropagation(); toggleSitesMenu(false); openSiteConfig(x); } }),
    el('span', { class: 'icon-btn del', title: '删除这个网站', role: 'button', 'data-act': 'delete', html: DEL_SVG,
      onclick: (e) => { e.stopPropagation(); removeSite(x); } })));
  if (state.missingDefaults?.length) {
    items.push(el('button', { class: 'mi restore', role: 'menuitem', 'data-site': 'restore', onclick: (e) => { e.stopPropagation(); restoreDefaultSites(); } },
      el('span', { class: 'plus' }, '↺'), el('span', { class: 'nm' }, '恢复默认网站', el('small', {}, `加回删掉的默认网站（${state.missingDefaults.length} 个）`))));
  }
  items.push(el('button', { class: 'mi add', role: 'menuitem', 'data-site': '+', onclick: () => { toggleSitesMenu(false); openAddSite(); } },
    el('span', { class: 'plus' }, '+'), el('span', { class: 'nm' }, '添加网站', el('small', {}, '打开网址，获取 DOM 并分析'))));
  $('sitesMenu').replaceChildren(...items);
}

async function restoreDefaultSites() {
  try {
    const r = await api('/api/sites/defaults', { method: 'POST', body: '{}' });
    snackbar(r.added?.length ? `已恢复 ${r.added.length} 个默认网站` : '默认网站都在列表里', 'ok');
    await loadSites();
  } catch (e) { snackbar(`恢复失败：${e.message}`, 'err'); }
}

function siteEditRow(x) {
  const name = el('input', { class: 'input', 'aria-label': '名称', maxlength: '40' });
  const url = el('input', { class: 'input', 'aria-label': '网址', placeholder: 'https://' });
  name.value = x.name; url.value = x.url;
  const cancel = () => { state.editingSite = null; renderSitesMenu(); };
  const saveIt = async () => {
    try {
      await api(`/api/sites/${encodeURIComponent(x.key)}`, { method: 'PATCH', body: JSON.stringify({ name: name.value, url: url.value }) });
      state.editingSite = null;
      snackbar('已保存', 'ok');
      await loadSites();
    } catch (e) { snackbar(`保存失败：${e.message}`, 'err'); }
  };
  const keys = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); saveIt(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
  name.addEventListener('keydown', keys); url.addEventListener('keydown', keys);
  return el('div', { class: 'mi editing', 'data-site': x.key, onclick: (e) => e.stopPropagation() }, name, url,
    el('div', { class: 'row' },
      el('button', { class: 'btn text s', type: 'button', onclick: cancel }, '取消'),
      el('button', { class: 'btn filled s', type: 'button', 'data-act': 'save', onclick: saveIt }, '保存')));
}

// ------------------------------------------------------------------ 网站配置弹窗

// 常用配置项（和下面的完整 JSON 双向同步）：[路径, 说明]
const CFG_FIELDS = [
  ['message.selector', '消息节点选择器'],
  ['text.user', '用户正文选择器（留空 = 整个消息节点）'],
  ['text.assistant', '回答正文选择器（留空 = 整个消息节点）'],
  ['text.exclude', '正文中排除的部分（按钮、工具栏等）'],
  ['conversation.url_pattern', '会话 ID：网址正则（第 1 个捕获组）'],
  ['conversation.fallback_id', '会话 ID：网址取不到时的固定 ID'],
  ['conversation.prefix', '会话 ID 前缀'],
  ['generating.selector', '“正在生成”标志选择器'],
  ['actions.composer', '输入框选择器'],
  ['actions.send_button', '发送按钮选择器'],
  ['actions.regenerate_button', '重新生成按钮（留空 = 不支持重新回答）']
];
const getPath = (o, p) => p.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; }
  cur[ks.at(-1)] = v;
}

function openSiteConfig(x) {
  state.cfgSite = x.key;
  $('siteCfgTitle').textContent = `网站配置 · ${x.name}`;
  $('siteCfgEnabled').setAttribute('aria-checked', String(x.enabled !== false));
  $('siteCfgHosts').value = (x.hosts || []).join(', ');
  $('siteCfgJson').value = JSON.stringify(x.config || {}, null, 2);
  $('siteCfgErr').textContent = '';
  $('siteCfgReset').hidden = !x.has_default;
  const cfg = x.config || {};
  $('siteCfgFields').replaceChildren(...CFG_FIELDS.map(([path, label]) => {
    const v = getPath(cfg, path);
    const input = el('input', { class: 'input', 'data-path': path, spellcheck: 'false' });
    input.value = v == null ? '' : String(v);
    input.addEventListener('input', () => {
      let c;
      try { c = JSON.parse($('siteCfgJson').value || '{}'); } catch { $('siteCfgErr').textContent = '完整配置不是有效的 JSON，先修正它'; return; }
      // 会话规则里空字符串 = 不用（null）
      setPath(c, path, input.value === '' && path.startsWith('conversation.') && path !== 'conversation.prefix' ? null : input.value);
      $('siteCfgJson').value = JSON.stringify(c, null, 2);
      $('siteCfgErr').textContent = '';
    });
    return el('label', {}, el('span', { class: 'lbl' }, label), input);
  }));
  $('siteCfgScrim').classList.add('open');
}
function syncCfgFields() {
  let c;
  try { c = JSON.parse($('siteCfgJson').value || '{}'); } catch { $('siteCfgErr').textContent = 'JSON 格式有误'; return; }
  $('siteCfgErr').textContent = '';
  for (const input of $('siteCfgFields').querySelectorAll('input[data-path]')) {
    const v = getPath(c, input.dataset.path);
    input.value = v == null ? '' : String(v);
  }
}
function closeSiteConfig() { $('siteCfgScrim').classList.remove('open'); state.cfgSite = null; }
async function saveSiteConfig() {
  const key = state.cfgSite;
  if (!key) return;
  let config;
  try { config = JSON.parse($('siteCfgJson').value || '{}'); } catch (e) { $('siteCfgErr').textContent = `JSON 格式有误：${e.message}`; return; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) { $('siteCfgErr').textContent = 'DOM 配置必须是 JSON 对象'; return; }
  const hosts = $('siteCfgHosts').value.split(/[,，\s]+/).map((h) => h.trim()).filter(Boolean);
  const enabled = $('siteCfgEnabled').getAttribute('aria-checked') === 'true';
  try {
    await api(`/api/sites/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ enabled, hosts, config }) });
    closeSiteConfig();
    snackbar('网站配置已保存，插件会立即同步（已开的页面按新配置观察）', 'ok');
    await loadSites();
  } catch (e) { $('siteCfgErr').textContent = `保存失败：${e.message}`; }
}
async function resetSiteConfig() {
  const key = state.cfgSite;
  if (!key || !window.confirm('把这个网站的 DOM 配置和域名恢复为默认？')) return;
  try {
    const r = await api(`/api/sites/${encodeURIComponent(key)}/reset`, { method: 'POST', body: '{}' });
    snackbar('已恢复默认配置', 'ok');
    await loadSites();
    openSiteConfig(r.site);
  } catch (e) { $('siteCfgErr').textContent = `恢复失败：${e.message}`; }
}

async function removeSite(x) {
  if (!window.confirm(`删除“${x.name}”？已记录的会话会保留。`)) return;
  try { await api(`/api/sites/${encodeURIComponent(x.key)}`, { method: 'DELETE' }); snackbar(`已删除 ${x.name}`, 'ok'); loadSites(); }
  catch (e) { snackbar(`删除失败：${e.message}`, 'err'); }
}

function openAddSite() {
  state.probe = null;
  $('siteUrl').value = '';
  $('siteStatus').textContent = '';
  $('siteStatus').className = 'probe-st';
  $('siteResult').classList.remove('open');
  $('siteConfirm').disabled = true;
  $('siteProbe').disabled = false;
  $('siteScrim').classList.add('open');
  $('siteUrl').focus();
}
function closeAddSite() {
  state.probe = null;
  $('siteScrim').classList.remove('open');
}

function probeStatus(text, err = false) {
  $('siteStatus').textContent = text;
  $('siteStatus').className = `probe-st ${err ? 'err' : ''}`;
}

async function startProbe() {
  const url = $('siteUrl').value.trim();
  if (!/^https:\/\/[^\s/]+/.test(url)) return probeStatus('请填写 https:// 开头的网址', true);
  $('siteProbe').disabled = true;
  $('siteConfirm').disabled = true;
  $('siteResult').classList.remove('open');
  probeStatus('插件正在后台打开网址并获取 DOM……');
  let id;
  try { id = (await api('/api/sites/probe', { method: 'POST', body: JSON.stringify({ url }) })).probe_id; }
  catch (e) { $('siteProbe').disabled = false; return probeStatus(`获取失败：${e.message}`, true); }
  state.probe = id;
  const started = Date.now();
  while (state.probe === id) {
    await new Promise((r) => setTimeout(r, PROBE_POLL_MS));
    if (state.probe !== id) return;
    let r;
    try { r = await api(`/api/sites/probe/${id}`); } catch (e) { r = { status: 'error', error: e.message }; }
    if (r.status === 'pending') { probeStatus(`插件正在获取 DOM……${Math.round((Date.now() - started) / 1000)} 秒`); continue; }
    $('siteProbe').disabled = false;
    if (r.status === 'error' || !r.report || r.report.error) return probeStatus(`分析失败：${r.error || r.report?.hint || r.report?.error || '未知错误'}`, true);
    return showProbeResult(r);
  }
}

function showProbeResult(r) {
  const rep = r.report;
  probeStatus(r.exists ? '分析完成：这个网站已添加过，确认后会覆盖。' : '分析完成，确认无误后添加。');
  const roles = Object.entries(rep.roles || {}).map(([k, v]) => `${k === 'user' ? '用户' : k === 'assistant' ? '助手' : k} ${v}`).join('，');
  $('siteKv').replaceChildren(...[
    ['网站', rep.host], ['识别方式', rep.strategy], ['消息', `${rep.message_count} 条（${roles}）`],
    ['会话 ID', rep.conversation_id || '未识别'], ['输入框', rep.composer || '-']
  ].flatMap(([k, v]) => [el('span', {}, k), el('span', {}, String(v ?? '-'))]));
  $('siteSamples').replaceChildren(...(rep.samples || []).map((m) =>
    el('div', {}, el('b', {}, m.role === 'user' ? '我：' : '助手：'), m.text)));
  $('siteWarn').textContent = (rep.warnings || []).join('；');
  $('siteName').value = r.suggested_name || rep.host;
  $('siteResult').classList.add('open');
  $('siteConfirm').disabled = false;
}

async function confirmAddSite() {
  if (!state.probe) return;
  $('siteConfirm').disabled = true;
  try {
    const r = await api('/api/sites', { method: 'POST', body: JSON.stringify({ probe_id: state.probe, name: $('siteName').value.trim() }) });
    snackbar(`已添加 ${r.site.name}：刷新该网站的页面后开始记录`, 'ok');
    closeAddSite();
    loadSites();
  } catch (e) {
    $('siteConfirm').disabled = false;
    probeStatus(`添加失败：${e.message}`, true);
  }
}

// ------------------------------------------------------------------ 渲染：详情

const DL_SVG = '<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>';
const safeUrl = (u) => /^https?:\/\//i.test(u) ? u : null;

/** 段落内：`行内代码`、![图片](url)、[下载](url "download")；全部用 DOM 写入，不解析 HTML */
function renderInline(p, para) {
  const re = /(`[^`\n]+`)|!\[([^\]\n]*)\]\((\S+?)\)|\[([^\]\n]+)\]\((\S+?)(?: "download")?\)/g;
  let last = 0, m;
  while ((m = re.exec(para))) {
    if (m.index > last) p.append(para.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) { p.append(el('code', { class: 'inl' }, m[1].slice(1, -1))); continue; }
    if (m[3] != null) {
      const u = safeUrl(m[3]);
      if (u) p.append(imageBlock(u, m[2]));
      else p.append(m[0]);
      continue;
    }
    const u = safeUrl(m[5]);
    if (u) p.append(fileChip(m[4], u, true));
    else p.append(m[0]);
  }
  if (last < para.length) p.append(para.slice(last));
}

/** 轻量 Markdown：``` 代码块（带语言）、空行分段、`行内代码`、图片、下载链接 */
function renderText(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text || '').split(/^```([^\n`]*)\n?/m);
  // split 带捕获组（每个 ``` 行都捕获一次）：[正文, 开始行语言, 代码, 结束行, 正文, 开始行语言, 代码, 结束行, ...]
  for (let i = 0; i < parts.length; i += 4) {
    for (const para of parts[i].split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = el('p');
      renderInline(p, para);
      frag.append(p);
    }
    if (i + 2 < parts.length) frag.append(codeBlock(parts[i + 2].replace(/\n$/, ''), parts[i + 1].trim()));
  }
  return frag;
}

// ---------------------------------------------------------------- 富文本（html）：再净化一次后按原格式显示

const FILE_SVG = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>';
// 允许的标签 → 允许的属性；其余元素只保留内容，RICH_DROP 里的整个丢掉
const RICH_TAGS = {
  p: [], br: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], ul: [], ol: ['start'], li: [], blockquote: [],
  pre: [], code: ['class'], table: [], thead: [], tbody: [], tfoot: [], tr: [], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
  strong: [], em: [], b: [], i: [], del: [], s: [], sup: [], sub: [], hr: [], a: ['href', 'download', 'data-file'], img: ['src', 'alt'], span: ['data-file']
};
const RICH_DROP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'textarea', 'select',
  'option', 'button', 'svg', 'math', 'canvas', 'video', 'audio', 'source', 'link', 'meta', 'base', 'dialog', 'head', 'title']);
const linkUrl = (u) => (/^(https?:|blob:)/i.test(u) || /^data:/i.test(u) ? u : null);
const imgUrl = (u) => (/^https?:\/\//i.test(u) || /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,/i.test(u) ? u : null);
const LANG_EXT = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', mjs: 'js', node: 'js', typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx',
  json: 'json', html: 'html', xml: 'xml', css: 'css', scss: 'scss', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', powershell: 'ps1', ps1: 'ps1',
  java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', go: 'go', golang: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', rb: 'rb',
  php: 'php', sql: 'sql', yaml: 'yml', yml: 'yml', toml: 'toml', ini: 'ini', markdown: 'md', md: 'md', kotlin: 'kt', kt: 'kt', swift: 'swift',
  r: 'r', lua: 'lua', perl: 'pl', dart: 'dart', scala: 'scala', vue: 'vue', dockerfile: 'dockerfile', makefile: 'mk', diff: 'diff', csv: 'csv'
};
const extOfLang = (lang) => LANG_EXT[String(lang || '').toLowerCase()] || 'txt';

/** 代码块：语言标签 + 复制 + 下载（按钮用 data-act，由 #detailMsgs 统一处理，超长折叠复制出的节点也能用） */
function codeBlock(code, lang) {
  const l = /^[A-Za-z0-9+#._-]{1,30}$/.test(lang || '') ? lang.toLowerCase() : '';
  return el('div', { class: 'codeblock', 'data-lang': l },
    el('div', { class: 'cbh' },
      el('span', { class: 'lang' }, l || '代码'),
      el('button', { class: 'cbtn', type: 'button', 'data-act': 'code-copy', title: '复制代码' }, el('span', { html: SVG.copy, class: 'ic' }), '复制'),
      el('button', { class: 'cbtn', type: 'button', 'data-act': 'code-download', title: `下载为 .${extOfLang(l)} 文件` }, el('span', { html: DL_SVG, class: 'ic' }), '下载')),
    el('pre', {}, el('code', l ? { class: `language-${l}` } : {}, code)));
}

/** 图片：原图内联（最大宽度 100%），点击打开原图；下载按钮（跨域图片浏览器可能改为打开） */
function imageBlock(src, alt) {
  const name = (() => { try { const seg = decodeURIComponent(new URL(src).pathname.split('/').pop() || ''); return /\.[A-Za-z0-9]{2,5}$/.test(seg) ? seg : ''; } catch { return ''; } })() || 'image.png';
  return el('span', { class: 'imgblock' },
    el('img', { class: 'rich', src, alt: alt || '图片', loading: 'lazy', referrerpolicy: 'no-referrer', 'data-act': 'img-open', title: '点击打开原图' }),
    el('a', { class: 'imgdl', href: src, download: name, target: '_blank', rel: 'noopener noreferrer', title: '下载图片' }, el('span', { html: DL_SVG, class: 'ic' }), '下载'));
}

/** 文件卡片：有网址 → 可下载 / 打开；没有网址 → 只显示文件名 */
function fileChip(name, href, download = true) {
  const label = String(name || '').trim() || '文件';
  if (!href) return el('span', { class: 'filechip nolink', title: '原页面没有提供下载地址' }, el('span', { html: FILE_SVG, class: 'ic' }), el('span', { class: 'fn' }, label));
  return el('a', { class: 'filechip dl', href, target: '_blank', rel: 'noopener noreferrer', ...(download ? { download: label } : {}), title: `下载 / 打开 ${label}` },
    el('span', { html: FILE_SVG, class: 'ic' }), el('span', { class: 'fn' }, label), el('span', { html: DL_SVG, class: 'ic' }));
}

/**
 * 把消息的 html 解析成惰性文档（DOMParser：不执行脚本、不加载图片），按白名单逐个节点重建到看板页面：
 * 不复制任何事件属性 / style / class（code 只保留 language-*），链接只允许 http(s) / data / blob，图片只允许 http(s) / data:image。
 * 从不把 html 直接写进页面。
 */
function renderRich(html) {
  const frag = document.createDocumentFragment();
  let src;
  try { src = new DOMParser().parseFromString(`<!doctype html><body>${String(html || '')}</body>`, 'text/html').body; } catch { return renderText(''); }
  const build = (node, parent) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { parent.append(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (RICH_DROP.has(tag)) continue;
      if (tag === 'pre') {
        const codeEl = n.querySelector('code');
        const lang = /(?:^|\s)language-([A-Za-z0-9+#._-]{1,30})/.exec(codeEl?.getAttribute('class') || '')?.[1] || '';
        parent.append(codeBlock((codeEl || n).textContent.replace(/\n$/, ''), lang));
        continue;
      }
      if (tag === 'img') {
        const u = imgUrl(String(n.getAttribute('src') || '').trim());
        if (u) parent.append(imageBlock(u, n.getAttribute('alt') || ''));
        continue;
      }
      if (tag === 'a') {
        const u = linkUrl(String(n.getAttribute('href') || '').trim());
        const fileName = n.getAttribute('data-file');
        if (u && (fileName != null || n.hasAttribute('download'))) { parent.append(fileChip(fileName || n.getAttribute('download') || n.textContent, u, true)); continue; }
        if (!u) { build(n, parent); continue; }
        const a = el('a', { href: u, target: '_blank', rel: 'noopener noreferrer' });
        build(n, a);
        parent.append(a);
        continue;
      }
      if (tag === 'span' && n.getAttribute('data-file') != null) { parent.append(fileChip(n.getAttribute('data-file') || n.textContent, null)); continue; }
      const allowed = RICH_TAGS[tag];
      if (!allowed || tag === 'span') { build(n, parent); continue; }
      const out = document.createElement(tag);
      for (const name of allowed) {
        const v = n.getAttribute(name);
        if (v == null) continue;
        if (name === 'class') { const lang = /(?:^|\s)(language-[A-Za-z0-9+#._-]{1,30})/.exec(v)?.[1]; if (lang) out.className = lang; }
        else if (/^\d{1,3}$/.test(v)) out.setAttribute(name, v);
      }
      if (tag === 'code') out.classList.add('inl');
      build(n, out);
      parent.append(tag === 'table' ? el('div', { class: 'tablewrap' }, out) : out);
    }
  };
  build(src, frag);
  return frag;
}

/** 消息正文：有 html 用富文本，否则轻量 Markdown */
function renderBody(m) {
  if (m.html) {
    const frag = renderRich(m.html);
    if (frag.childNodes.length) return frag;
  }
  return renderText(m.text);
}

/** 下载文字为文件（Blob；不支持时用 data: 网址） */
function downloadText(text, filename) {
  let href;
  let revoke = null;
  try {
    href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    revoke = () => URL.revokeObjectURL(href);
  } catch { href = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`; }
  const a = el('a', { href, download: filename, style: 'display:none' });
  document.body.append(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(revoke, 10000);
}

// 详情里代码块 / 图片的按钮统一在这里处理（超长消息折叠时尾部是复制出来的节点，不能依赖各自的监听器）
$('detailMsgs').addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-act="code-copy"], [data-act="code-download"], [data-act="img-open"]');
  if (!t || !$('detailMsgs').contains(t)) return;
  e.stopPropagation();
  if (t.dataset.act === 'img-open') { window.open(t.getAttribute('src'), '_blank', 'noopener'); return; }
  const block = t.closest('.codeblock');
  const code = block?.querySelector('pre code')?.textContent ?? '';
  if (t.dataset.act === 'code-copy') { copyText(code, '代码'); return; }
  const blocks = [...$('detailMsgs').querySelectorAll('.codeblock')];
  const n = blocks.indexOf(block) + 1;
  downloadText(code, `code${n > 1 ? '-' + n : ''}.${extOfLang(block?.dataset.lang)}`);
});

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
  );
}

function canControlConv(c) {
  return !!c && c.open_tabs > 0 && state.wsState === 'open' && state.canControl;
}
function convBusy(id) {
  return [...state.pendingCommands.values()].some((p) => p.conversation_id === id && p.action !== 'focus');
}

/** 快速回复时把对话固定在底部（最后一个回复）；回复栏展开、图片加载、窗口变化导致高度变化时保持在底部 */
function scrollDetailBottom() {
  const body = $('detailBody');
  state.stickBottom = true;
  body.scrollTop = body.scrollHeight;
  requestAnimationFrame?.(() => { body.scrollTop = body.scrollHeight; });
}
(() => {
  const body = $('detailBody');
  body.addEventListener('scroll', () => {
    state.stickBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  }, { passive: true });
  const keep = () => { if (state.selected && state.stickBottom) body.scrollTop = body.scrollHeight; };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(keep);
    ro.observe(body);
    ro.observe($('detailMsgs'));
  }
  $('detailMsgs').addEventListener('load', keep, true);   // 图片加载完成（load 不冒泡，用捕获）
  $('composer').addEventListener('transitionend', keep);
})();

const msgCache = new Map();   // 详情：message_id → { sig, node }（打开另一个会话时清空）
function renderDetail(scrollToEnd = false, forceBottom = false) {
  const body = $('detailBody');
  const nearBottom = forceBottom || state.composerOpen || body.scrollHeight - body.scrollTop - body.clientHeight < 120;
  // 相邻两条角色和内容完全相同的消息只显示一条（旧版插件把同一条发送重复记录过）
  const msgs = [...state.messages.entries()].sort((a, b) => a[1].index - b[1].index)
    .filter(([, m], i, arr) => !i || arr[i - 1][1].role !== m.role || arr[i - 1][1].text !== m.text || !m.text);
  const c = convById(state.selected);
  const src = sourceInfo(c?.source);
  const answers = msgs.filter(([, m]) => m.role === 'assistant').map(([id]) => id);
  const canRegen = src.regenerate && canControlConv(c) && !convBusy(state.selected) && c.status !== 'generating';
  const iconBtn = (svg, title, onclick, { on = false, disabled = false, act } = {}) =>
    el('button', { class: `icon-btn ${on ? 'on' : ''}`, title, 'aria-label': title, 'data-act': act, disabled, html: svg,
      onclick: (e) => { e.stopPropagation(); onclick(); } });

  const ctrl = canControlConv(c);
  const dh = Math.round(dialogHeight());
  const build = (id, m) => {
    const isAnswer = m.role === 'assistant';
    const collapsed = state.collapsed.has(id);
    const streaming = state.streaming.has(id);
    const ai = answers.indexOf(id);
    const isLast = ai === answers.length - 1;
    const regenTip = !src.regenerate ? '这个站点不支持重新回答'
      : !ctrl ? '需要有标签页开着这个会话'
        : !isLast ? '重新回答这条（页面上每条回答都有“重新生成”时可用）' : '重新回答';
    return el('div', { class: `msg ${m.role} ${streaming ? 'streaming' : ''} ${collapsed ? 'collapsed' : ''} ${m.favorite ? 'fav' : ''}`, 'data-mid': id },
      el('div', { class: 'meta' },
        el('span', {}, m.role === 'user' ? '我' : isAnswer ? src.label : m.role),
        el('span', {}, `${m.text.length} 字`),
        m.favorite ? el('span', {}, '已收藏') : null),
      el('div', { class: `body ${m.html ? 'rich' : ''}` }, renderBody(m)),
      el('div', { class: 'fold' }, m.text.split('\n').find((l) => l.trim()) || ''),
      isAnswer ? el('div', { class: 'mact' },
        iconBtn(SVG.copy, '复制回答', () => copyText(m.text), { act: 'copy' }),
        iconBtn(m.favorite ? SVG.starOn : SVG.star, m.favorite ? '取消收藏' : '收藏回答', () => toggleFavorite(state.selected, id), { on: m.favorite, act: 'favorite' }),
        src.regenerate ? iconBtn(SVG.redo, regenTip, () => regenerateAnswer(ai, answers.length), { disabled: !canRegen || streaming, act: 'regenerate' }) : null,
        iconBtn(collapsed ? SVG.unfold : SVG.fold, collapsed ? '展开回答' : '折叠回答', () => {
          collapsed ? state.collapsed.delete(id) : state.collapsed.add(id);
          renderDetail();
        }, { act: 'fold' })
      ) : null);
  };
  if (!msgs.length) $('detailMsgs').replaceChildren(el('div', { class: 'empty' }, '暂无消息'));
  else {
    // 按消息复用：流式输出时只重建正在变化的那条（富文本解析、代码块渲染都不再每次全部重做）
    const keep = new Set();
    placeChildren($('detailMsgs'), msgs.map(([id, m]) => {
      keep.add(id);
      const ai = answers.indexOf(id);
      const sig = JSON.stringify([m.role, m.text, m.html, !!m.favorite, state.collapsed.has(id), state.streaming.has(id), state.longOpen.has(id),
        ai, answers.length, canRegen, ctrl, src.label, src.regenerate, dh]);
      let hit = msgCache.get(id);
      if (!hit || hit.sig !== sig) { hit = { sig, node: build(id, m) }; msgCache.set(id, hit); }
      return hit.node;
    }));
    for (const id of msgCache.keys()) if (!keep.has(id)) msgCache.delete(id);
  }
  applyLongFold();
  if ((scrollToEnd || state.composerOpen) && nearBottom) body.scrollTop = body.scrollHeight;
}

/**
 * 超长消息自动折叠：单条消息正文高于弹窗高度的 2/3 时，只显示开头和结尾（合计弹窗高度的 1/2），
 * 中间放“展开全文”；展开后末尾有“收起”。手动折叠（只显示首行）的消息不处理。
 */
function dialogHeight() {
  const dlg = $('detailScrim')?.querySelector('.dialog');
  const h = dlg ? dlg.getBoundingClientRect().height : 0;
  return h > 0 ? h : (window.innerHeight || 0) * 0.88;
}
let longFoldResizeTimer = null;
window.addEventListener?.('resize', () => {
  clearTimeout(longFoldResizeTimer);
  longFoldResizeTimer = setTimeout(() => { if (state.selected) renderDetail(); }, 200);
});
function applyLongFold() {
  const dh = dialogHeight();
  if (!(dh > 0)) return;
  for (const msg of $('detailMsgs').querySelectorAll('.msg[data-mid]')) {
    // 已处理过的（复用的节点上已有“展开全文 / 收起”）不再重复处理
    if (msg.classList.contains('collapsed') || msg.querySelector(':scope > .longbtn, :scope > .longfold')) continue;
    const id = msg.dataset.mid;
    const body = msg.querySelector(':scope > .body');
    if (!body) continue;
    const h = body.getBoundingClientRect().height;
    if (!(h > dh * 2 / 3)) continue;
    const fold = el('button', { class: 'longbtn', 'data-act': 'longfold', type: 'button' });
    if (state.longOpen.has(id)) {
      fold.textContent = '收起';
      fold.onclick = (e) => { e.stopPropagation(); state.longOpen.delete(id); renderDetail(); };
      body.after(fold);
      continue;
    }
    const part = Math.round(dh / 4);   // 首、尾各占 1/4，合计 1/2 弹窗高度
    const head = el('div', { class: 'lhead', style: `height:${part}px` });
    const tail = el('div', { class: 'ltail', style: `height:${part}px` });
    body.replaceWith(el('div', { class: 'longfold' }, head, fold, tail));
    head.append(body);
    tail.append(body.cloneNode(true));
    fold.textContent = '展开全文';
    fold.title = '中间部分已折叠';
    fold.onclick = (e) => { e.stopPropagation(); state.longOpen.add(id); renderDetail(); };
    msg.classList.add('long');
  }
}

function regenerateAnswer(index, total) {
  const id = state.selected;
  if (!id) return;
  if (!sendCommand(id, 'regenerate', null, { extra: { answer_index: index, answer_total: total } })) snackbar('实时连接未建立，无法重新回答', 'err');
}

// ------------------------------------------------------------------ 详情：快速回复

function renderComposer() {
  const c = convById(state.selected);
  const busy = convBusy(state.selected);
  const ok = canControlConv(c);
  $('composer').classList.toggle('open', state.composerOpen);
  $('detailPin').classList.toggle('on', !!c?.pinned);
  $('detailPin').setAttribute('aria-pressed', String(!!c?.pinned));
  $('detailPin').title = c?.pinned ? '已置顶，点击取消' : '置顶';
  $('quickSend').disabled = !ok || busy;
  $('quickSend').textContent = busy ? '发送中…' : '发送';
  $('quickHint').textContent = !c ? '' : !ok ? '需要有标签页开着这个会话' : c.status === 'generating' ? '正在回答中，发送会被拒绝' : '在开着这个会话的标签页里发送';
}

function toggleComposer(open = !state.composerOpen) {
  state.composerOpen = open;
  renderComposer();
  if (open) { $('quickText').focus(); openCands(); scrollDetailBottom(); } else closeCands();
}

function candidates() {
  const q = $('quickText').value.trim().toLowerCase();
  const list = settings.quickReplies.filter((t) => t && t.trim());
  if (!q) return list;
  return list.filter((t) => t.toLowerCase().includes(q) && t.trim().toLowerCase() !== q);
}

function openCands() {
  const list = candidates();
  const box = $('quickCands');
  if (!list.length) { closeCands(); return; }
  if (state.candIndex >= list.length) state.candIndex = list.length - 1;
  box.replaceChildren(el('div', { class: 'ch' }, '常见回答（点击或 ↑↓ 选择后 Enter 直接发送，Esc 关闭）'),
    ...list.map((t, i) => el('button', {
      class: `cand ${i === state.candIndex ? 'on' : ''}`, role: 'option', title: t, type: 'button',
      onmousedown: (e) => e.preventDefault(),   // 不让输入框失焦
      onclick: () => pickCand(t)
    }, t)));
  box.classList.add('open');
}
function closeCands() { $('quickCands').classList.remove('open'); state.candIndex = -1; }
/** 选中常见回答 → 直接发送 */
function pickCand(t) {
  $('quickText').value = t;
  closeCands();
  sendQuick();
}

function sendQuick() {
  const id = state.selected;
  const text = $('quickText').value.trim();
  if (!id) return;
  if (!text) return snackbar('回复内容不能为空', 'err');
  closeCands();
  if (!sendCommand(id, 'reply', text)) return snackbar('实时连接未建立，无法发送', 'err');
  // 发出后关闭弹窗；结果通过提示条反馈
  $('quickText').value = '';
  state.drafts.delete(id);
  closeDetail();
}

// ------------------------------------------------------------------ 设置：常见回答

function saveQuickReplies() { save('quickReplies', settings.quickReplies); }

function renderQuickReplySettings() {
  const list = settings.quickReplies;
  $('qrList').replaceChildren(...(list.length ? list.map((t, i) => {
    const input = el('input', { class: 'input', maxlength: '2000', 'aria-label': `常见回答 ${i + 1}` });
    input.value = t;
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v) settings.quickReplies[i] = v; else settings.quickReplies.splice(i, 1);
      saveQuickReplies();
      renderQuickReplySettings();
    });
    const move = (d) => {
      const j = i + d;
      [list[i], list[j]] = [list[j], list[i]];
      saveQuickReplies();
      renderQuickReplySettings();
    };
    return el('div', { class: 'qr-item' }, input,
      el('button', { class: 'icon-btn', title: '上移', html: SVG.up, disabled: i === 0, onclick: () => move(-1) }),
      el('button', { class: 'icon-btn', title: '下移', html: SVG.down, disabled: i === list.length - 1, onclick: () => move(1) }),
      el('button', { class: 'icon-btn', title: '删除', html: SVG.del, onclick: () => { list.splice(i, 1); saveQuickReplies(); renderQuickReplySettings(); } }));
  }) : [el('div', { class: 'lbl' }, '还没有常见回答')]));
}

function addQuickReply() {
  const v = $('qrNew').value.trim();
  if (!v) return;
  if (settings.quickReplies.includes(v)) { snackbar('已经有这条了', 'err'); return; }
  settings.quickReplies.push(v);
  saveQuickReplies();
  $('qrNew').value = '';
  renderQuickReplySettings();
}

// ------------------------------------------------------------------ 设置

function openSettings() {
  $('token').value = settings.token;
  renderNotifySettings();
  renderQuickReplySettings();
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
  try { new Notification('AI-Chat-Room', { body: '这是一条测试通知' }); } catch (e) { snackbar(`通知失败：${e.message}`, 'err'); }
};
$('serverRefresh').onclick = loadServerInfo;
$('search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
function setSearchOpen(open) {
  $('searchBox').classList.toggle('open', open);
  $('searchBtn').setAttribute('aria-expanded', String(open));
  if (open) $('search').focus();
}
$('favBtn').onclick = () => { state.filter = state.filter === 'favorite' ? 'all' : 'favorite'; save('filter', state.filter); render(); };
$('launchBtn').onclick = launchAll;
$('searchBtn').onclick = (e) => { e.preventDefault(); setSearchOpen(!$('searchBox').classList.contains('open') || !!state.search); };
$('search').addEventListener('blur', () => { if (!state.search) setSearchOpen(false); });
$('search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('search').value = ''; state.search = ''; render(); setSearchOpen(false); $('searchBtn').focus(); } });
$('sitesBtn').onclick = (e) => { e.stopPropagation(); toggleSitesMenu(); };
document.addEventListener('click', (e) => { if (!e.target.closest?.('.sitemenu')) toggleSitesMenu(false); });
$('siteCancel').onclick = closeAddSite;
$('siteScrim').addEventListener('click', (e) => { if (e.target === $('siteScrim')) closeAddSite(); });
$('siteProbe').onclick = startProbe;
$('siteUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startProbe(); } });
$('siteConfirm').onclick = confirmAddSite;
$('siteCfgCancel').onclick = closeSiteConfig;
$('siteCfgSave').onclick = saveSiteConfig;
$('siteCfgReset').onclick = resetSiteConfig;
$('siteCfgScrim').addEventListener('click', (e) => { if (e.target === $('siteCfgScrim')) closeSiteConfig(); });
$('siteCfgJson').addEventListener('change', syncCfgFields);
$('siteCfgEnabled').onclick = () => $('siteCfgEnabled').setAttribute('aria-checked', String($('siteCfgEnabled').getAttribute('aria-checked') !== 'true'));
$('detailClose').onclick = closeDetail;
$('detailScrim').addEventListener('click', (e) => { if (e.target === $('detailScrim')) closeDetail(); });
$('detailJump').onclick = () => { const c = convById(state.selected); if (c) jumpTo(c); };
$('detailPin').onclick = () => { const c = convById(state.selected); if (c) togglePin(c); };
$('quickCancel').onclick = () => toggleComposer(false);
$('quickSend').onclick = sendQuick;
const qt = $('quickText');
qt.addEventListener('input', () => { state.drafts.set(state.selected, qt.value); state.candIndex = -1; openCands(); });
qt.addEventListener('focus', openCands);
qt.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== qt) closeCands(); }, 150));
qt.addEventListener('keydown', (e) => {
  const open = $('quickCands').classList.contains('open');
  const list = open ? candidates() : [];
  const plainEnter = e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;   // 输入法选字时的 Enter 不发送
  if (open && list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    state.candIndex = (state.candIndex + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    openCands();
  } else if (plainEnter && open && state.candIndex >= 0 && list[state.candIndex]) {
    e.preventDefault();
    pickCand(list[state.candIndex]);
  } else if (plainEnter) {
    e.preventDefault();
    sendQuick();
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    e.stopPropagation();
    closeCands();
  }
});
$('alertClose').onclick = closePopup;
$('alertOpen').onclick = () => { const id = state.alertConv; closePopup(); if (id) openDetail(id); };
$('alertScrim').addEventListener('click', (e) => { if (e.target === $('alertScrim')) closePopup(); });
$('soundTest').onclick = () => { if (!playSound(false)) snackbar('当前浏览器不支持音效', 'err'); };
$('popupTest').onclick = () => { playSound(true); showPopup(null, '置顶会话回答完成', '这是一个测试弹窗'); };
$('qrAdd').onclick = addQuickReply;
$('qrNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addQuickReply(); } });
$('qrReset').onclick = () => { settings.quickReplies = [...DEFAULT_QUICK_REPLIES]; saveQuickReplies(); renderQuickReplySettings(); };
// 浏览器要求用户操作后才能播放声音：第一次点击时解锁
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('alertScrim').classList.contains('open')) closePopup();
  else if ($('siteCfgScrim').classList.contains('open')) closeSiteConfig();
  else if ($('settingsScrim').classList.contains('open')) closeSettings();
  else if (state.selected) closeDetail();
});

applyTheme();
render();
if (settings.token) connect(); else setConn('off', '未设置 token');
// 相对时间、标签页状态等每 15 秒刷新一次
setInterval(() => { if (state.wsState === 'open') loadConversations(); }, 15000);
