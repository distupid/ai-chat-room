import { MessageType, EventType, makeEnvelope, validateMessage } from '../shared/protocol.js';
import { BridgeConnection } from './connection.js';

export const DEFAULT_SETTINGS = Object.freeze({
  serverUrl: 'ws://127.0.0.1:8787',
  token: ''
});

/**
 * 后台核心逻辑（与 chrome.* 解耦，便于在 Node 中测试）。
 *
 * 内容脚本 → chrome.runtime.sendMessage({ kind: 'page_event', event }) → handleRuntimeMessage
 *   → 补全 tab_id、组装 event 信封、按共享 Schema 校验 → BridgeConnection.sendEvent
 *
 * 只有 kind === 'page_event' 的内部消息会被上报。后端发来的 ack / error / broadcast
 * 只在 BridgeConnection 内部处理，绝不会回流到这里，因此不会被误识别为页面事件。
 */
/** 标签页会话 ID 前缀（与后端 db.js 保持一致） */
export const PSEUDO_PREFIX = 'tab-';

export function createBackground({ WebSocketImpl, storage, clientId, settings, connectionOptions = {}, onBroadcast, executeCommand }) {
  const tabs = new Map(); // tabId → { url, conversation_id }
  const received = [];    // 最近收到的其他客户端广播（诊断用）
  const pageEventStats = { accepted: 0, rejected: 0, ignored_kind: 0 };

  const conn = new BridgeConnection({
    url: settings.serverUrl,
    token: settings.token,
    clientId,
    WebSocketImpl,
    queueStore: storage ? {
      get: () => storage.get('bridge_queue'),
      set: (v) => storage.set('bridge_queue', v)
    } : null,
    onBroadcast: (b) => {
      received.push({ at: Date.now(), seq: b.seq, event_type: b.event_type, conversation_id: b.conversation_id, from: b.origin_client_id });
      if (received.length > 50) received.shift();
      onBroadcast?.(b);
    },
    // 看板指令：只在后端指定的标签页、且该标签页当前就在这个会话上时执行
    onCommand: async (cmd) => {
      const tab = tabs.get(cmd.tab_id);
      // Service Worker 重启后 tabs 会丢失：此时仍交给内容脚本，由它核对当前会话
      if (tab && tab.conversation_id !== cmd.conversation_id) return { ok: false, code: 'tab_moved', detail: '该标签页已切换到其他会话' };
      if (typeof executeCommand !== 'function') return { ok: false, code: 'unsupported' };
      // 标签页会话（还没进入具体会话的页面）：内容脚本看到的会话是 null
      const pageConv = String(cmd.conversation_id || '').startsWith(PSEUDO_PREFIX) ? null : cmd.conversation_id;
      return executeCommand(cmd.tab_id, {
        command_id: cmd.command_id, action: cmd.action, conversation_id: pageConv, text: cmd.text,
        answer_index: cmd.answer_index, answer_total: cmd.answer_total, tab_ids: cmd.tab_ids, url: cmd.url
      });
    },
    ...connectionOptions
  });

  /**
   * 开着支持的网站但还没进入具体会话（如首页 / 新对话）的标签页：用“标签页会话”ID 代替 null，
   * 这样看板也会为它建卡片；进入真正的会话后该卡片自然变成页面已关并被后端隐藏。
   */
  const clientTag = String(clientId || 'c').replace(/[^A-Za-z0-9_-]/g, '').slice(-12) || 'c';
  const pseudoId = (tabId) => `${PSEUDO_PREFIX}${clientTag}-${tabId}`;
  const PSEUDO_EVENTS = new Set([EventType.PAGE_OPENED, EventType.PAGE_CLOSED, EventType.CONVERSATION_CHANGED, EventType.CONVERSATION_STATUS]);

  function refreshSubscriptions() {
    const wanted = new Set([...tabs.values()].map((t) => t.conversation_id).filter(Boolean));
    conn.subscribe([...wanted]);
    conn.unsubscribe([...conn.subscriptions].filter((c) => !wanted.has(c)));
  }

  /**
   * @param {object} message 来自内容脚本或弹窗的内部消息
   * @param {{tab?: {id:number}}} sender
   */
  function handleRuntimeMessage(message, sender = {}) {
    if (!message || typeof message !== 'object') return { ok: false, error: 'bad message' };
    switch (message.kind) {
      case 'page_event': return acceptPageEvent(message.event, sender);
      case 'get_diagnostics': return { ok: true, diagnostics: diagnostics() };
      default:
        pageEventStats.ignored_kind++;
        return { ok: false, error: `unknown kind ${message.kind}` };
    }
  }

  function acceptPageEvent(e, sender) {
    // 内容脚本只能提交业务事件字段；信封字段在这里统一生成
    if (!e || typeof e !== 'object' || !Object.values(EventType).includes(e.event_type) || e.event_type === EventType.TABS_SNAPSHOT) {
      pageEventStats.rejected++;
      return { ok: false, error: 'not a page event' };
    }
    const tabId = sender.tab?.id ?? null;
    let conversationId = e.conversation_id ?? null;
    if (conversationId == null && tabId != null && PSEUDO_EVENTS.has(e.event_type)) conversationId = pseudoId(tabId);
    e = { ...e, conversation_id: conversationId };
    const envelope = makeEnvelope(MessageType.EVENT, {
      event_id: e.event_id,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      conversation_id: conversationId,
      tab_id: tabId,
      payload: e.payload
    });
    const v = validateMessage(envelope, { direction: 'c2s' });
    if (!v.ok) {
      pageEventStats.rejected++;
      return { ok: false, error: v.errors.join('; ') };
    }
    if (tabId != null) {
      if (e.event_type === EventType.PAGE_CLOSED) tabs.delete(tabId);
      else tabs.set(tabId, { url: e.payload.url ?? tabs.get(tabId)?.url, conversation_id: e.conversation_id ?? null });
      refreshSubscriptions();
    }
    pageEventStats.accepted++;
    return { ok: true, result: conn.sendEvent(envelope) };
  }

  /** 标签页被关闭但内容脚本来不及上报时，由后台补发 page.closed */
  function onTabRemoved(tabId) {
    const t = tabs.get(tabId);
    if (!t) return;
    acceptPageEvent({
      event_id: `pclose:${tabId}:${Date.now().toString(36)}`,
      event_type: EventType.PAGE_CLOSED,
      occurred_at: Date.now(),
      conversation_id: t.conversation_id,
      payload: { url: t.url || '', reason: 'tab_removed' }
    }, { tab: { id: tabId } });
  }

  /**
   * 上报浏览器里真实开着的标签页（由 background.js 用 chrome.tabs.query 收集，含 PWA 窗口）：
   * - 内存里记着、但浏览器里已经没有的标签页 → 补发 page.closed
   * - 只在已连接时发送；内容和上次相同则最多每 5 分钟发一次
   */
  let lastSnapshotKey = '';
  let lastSnapshotAt = 0;
  function syncTabs(list, { force = false } = {}) {
    const exist = new Set(list.map((t) => t.tab_id));
    for (const id of [...tabs.keys()]) if (!exist.has(id)) onTabRemoved(id);
    if (conn.state !== 'open') return 'offline';
    const items = list.slice(0, 500).map((t) => {
      const known = tabs.get(t.tab_id);
      const conversationId = t.conversation_id ?? (t.supported ? pseudoId(t.tab_id) : known?.conversation_id) ?? null;
      const item = { tab_id: t.tab_id, host: String(t.host || '').slice(0, 255), conversation_id: conversationId, active: !!t.active };
      if (conversationId) { item.url = String(t.url || known?.url || '').slice(0, 2048); item.title = String(t.title || '').slice(0, 512); }
      return item;
    });
    const key = JSON.stringify(items.map((t) => [t.tab_id, t.host, t.conversation_id, t.active]));
    const t = Date.now();
    if (!force && key === lastSnapshotKey && t - lastSnapshotAt < 5 * 60 * 1000) return 'unchanged';
    lastSnapshotKey = key;
    lastSnapshotAt = t;
    const envelope = makeEnvelope(MessageType.EVENT, {
      event_id: `tabs:${t.toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      event_type: EventType.TABS_SNAPSHOT, occurred_at: t, conversation_id: null, tab_id: null, payload: { tabs: items }
    });
    return conn.sendEvent(envelope);
  }

  function diagnostics() {
    return {
      ...conn.diagnostics(),
      tabs: [...tabs.entries()].map(([id, t]) => ({ tab_id: id, ...t })),
      page_events: { ...pageEventStats },
      received_broadcasts: received.slice(-20)
    };
  }

  return { conn, handleRuntimeMessage, onTabRemoved, syncTabs, diagnostics, tabs };
}
