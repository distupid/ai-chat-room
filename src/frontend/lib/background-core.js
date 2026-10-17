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
      return executeCommand(cmd.tab_id, {
        command_id: cmd.command_id, action: cmd.action, conversation_id: cmd.conversation_id, text: cmd.text
      });
    },
    ...connectionOptions
  });

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
    if (!e || typeof e !== 'object' || !Object.values(EventType).includes(e.event_type)) {
      pageEventStats.rejected++;
      return { ok: false, error: 'not a page event' };
    }
    const tabId = sender.tab?.id ?? null;
    const envelope = makeEnvelope(MessageType.EVENT, {
      event_id: e.event_id,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      conversation_id: e.conversation_id ?? null,
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

  function diagnostics() {
    return {
      ...conn.diagnostics(),
      tabs: [...tabs.entries()].map(([id, t]) => ({ tab_id: id, ...t })),
      page_events: { ...pageEventStats },
      received_broadcasts: received.slice(-20)
    };
  }

  return { conn, handleRuntimeMessage, onTabRemoved, diagnostics, tabs };
}
