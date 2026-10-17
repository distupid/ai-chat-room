import {
  MessageType, NON_RETRYABLE_ERRORS, ErrorCode, PROTOCOL_VERSION,
  validateMessage, makeEnvelope, randomId
} from '../shared/protocol.js';

/**
 * 插件端 WebSocket 客户端（运行在 MV3 Service Worker；也可在 Node 中注入 ws 做测试）。
 *
 * 职责：
 *  - 连接管理、hello 握手、指数退避 + 抖动自动重连
 *  - 有界发送队列：事件在收到 ack 前一直保留；断线时缓存，重连后按原顺序重发
 *    （后端以 event_id 去重，所以重发是幂等的）
 *  - 入站消息全部按共享协议校验，并严格按 type 分流：
 *      ack       → 从队列移除
 *      error     → 记录；不可重试的错误丢弃对应事件；致命错误停止重连（如 token 无效）
 *      broadcast → 去重（seq / origin_event_id）；自己发出的回显被识别并忽略
 *      ping/pong → 心跳
 *    入站消息永远不会进入“页面事件”路径，从而不会被重新上报形成循环。
 *  - 诊断信息：状态、队列、计数、最近错误、最近接收
 */
export class BridgeConnection {
  /**
   * @param {object} o
   * @param {string} o.url
   * @param {string} o.token
   * @param {string} o.clientId
   * @param {typeof WebSocket} o.WebSocketImpl
   * @param {{get():Promise<any>, set(v:any):Promise<void>}} [o.queueStore] 队列持久化（SW 被回收后可恢复）
   * @param {(b:object)=>void} [o.onBroadcast]
   * @param {(s:string)=>void} [o.onStateChange]
   * @param {string[]} [o.subscriptions] 连接后订阅的会话
   */
  constructor(o) {
    this.url = o.url;
    this.token = o.token;
    this.clientId = o.clientId;
    this.clientKind = o.clientKind || 'extension';
    this.clientVersion = o.clientVersion || '1.0.0';
    this.WS = o.WebSocketImpl;
    this.queueStore = o.queueStore || null;
    this.onBroadcast = o.onBroadcast || (() => {});
    // 后端转发来的看板指令（快速回复 / 重新回答）；返回 Promise<{ok, code?, detail?}>
    this.onCommand = o.onCommand || null;
    this.onStateChange = o.onStateChange || (() => {});
    this.backoff = { baseMs: 500, maxMs: 30000, factor: 2, jitter: 0.5, ...(o.backoff || {}) };
    this.maxQueue = o.maxQueue ?? 500;
    this.heartbeatMs = o.heartbeatMs ?? 20000;   // < 30s，保持 MV3 SW 活跃
    this.pongTimeoutMs = o.pongTimeoutMs ?? 10000;
    this.helloTimeoutMs = o.helloTimeoutMs ?? 5000;
    this.subscriptions = new Set(o.subscriptions || []);
    this.random = o.random || Math.random;

    this.ws = null;
    this.state = 'idle';
    this.attempt = 0;
    this.stopped = true;
    this.session = null;
    this.queue = [];                  // 待确认事件（按发送顺序）
    this.queued = new Set();          // 队列中的 event_id
    this.recentAcked = new LruSet(2000);
    this.seenBroadcastSeq = new LruSet(2000);
    this.seenBroadcastEvent = new LruSet(2000);
    this.timers = {};
    this.stats = {
      connects: 0, reconnects: 0, disconnects: 0, sent: 0, resent: 0, acked: 0, ack_duplicate: 0,
      dropped_overflow: 0, dropped_rejected: 0, skipped_local_duplicate: 0,
      received: { ack: 0, error: 0, broadcast: 0, welcome: 0, subscribed: 0, ping: 0, pong: 0, command: 0, invalid: 0 },
      commands_ok: 0, commands_failed: 0,
      broadcast_delivered: 0, broadcast_duplicate: 0, broadcast_self_echo: 0
    };
    this.errors = [];
    this.recentInbound = [];
    this.lastCloseInfo = null;
    this.nextRetryAt = null;
  }

  // ---------------------------------------------------------------- 生命周期

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.queueStore) {
      try {
        const saved = await this.queueStore.get();
        if (Array.isArray(saved)) for (const ev of saved) this.#enqueue(ev, false);
      } catch (err) { this.#error('queue-restore', err); }
    }
    this.#connect();
  }

  stop() {
    this.stopped = true;
    this.#clearTimers();
    if (this.ws) { try { this.ws.close(1000, 'client stop'); } catch { /* ignore */ } }
    this.ws = null;
    this.#setState('idle');
  }

  /** 设置变更后（URL/token）重新连接 */
  reconfigure({ url, token }) {
    if (url) this.url = url;
    if (token) this.token = token;
    this.attempt = 0;
    if (this.ws) { try { this.ws.close(1000, 'reconfigure'); } catch { /* ignore */ } }
    else if (!this.stopped) this.#connect();
  }

  /** 立即尝试重连（例如 SW 被唤醒的 alarm） */
  poke() {
    if (this.stopped) return;
    if (this.state === 'waiting' || this.state === 'idle') {
      clearTimeout(this.timers.retry);
      this.#connect();
    }
  }

  #connect() {
    if (this.stopped) return;
    this.#clearTimers();
    this.#setState('connecting');
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch (err) {
      this.#error('connect', err);
      return this.#scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.#setState('handshaking');
      this.#rawSend(makeEnvelope(MessageType.HELLO, {
        client_id: this.clientId, client_kind: this.clientKind, client_version: this.clientVersion, token: this.token
      }));
      this.timers.hello = setTimeout(() => {
        this.#error('handshake', new Error('welcome timeout'));
        try { ws.close(4100, 'welcome timeout'); } catch { /* ignore */ }
      }, this.helloTimeoutMs);
    };
    ws.onmessage = (e) => { if (this.ws === ws) this.#onRaw(e.data); };
    ws.onerror = () => { /* close 事件随后到来，统一在 onclose 处理 */ };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.session = null;
      this.stats.disconnects++;
      this.lastCloseInfo = { code: e?.code, reason: e?.reason || '', at: Date.now() };
      this.#clearTimers();
      if (this.stopped) return this.#setState('idle');
      if (this.state === 'auth_failed') return undefined;
      this.#scheduleReconnect();
    };
  }

  /** 指数退避 + 抖动：delay = min(max, base * factor^attempt) * (1 - jitter*rand) */
  computeBackoff(attempt) {
    const raw = Math.min(this.backoff.maxMs, this.backoff.baseMs * this.backoff.factor ** attempt);
    return Math.round(raw * (1 - this.backoff.jitter * this.random()));
  }

  #scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.computeBackoff(this.attempt);
    this.attempt++;
    this.stats.reconnects++;
    this.nextRetryAt = Date.now() + delay;
    this.#setState('waiting');
    this.timers.retry = setTimeout(() => { this.nextRetryAt = null; this.#connect(); }, delay);
  }

  // ---------------------------------------------------------------- 发送

  /**
   * 发送一条业务事件（已组装好的 event 信封）。
   * @returns {'sent'|'queued'|'duplicate'|'invalid'}
   */
  sendEvent(ev) {
    const res = validateMessage(ev, { direction: 'c2s' });
    if (!res.ok || ev.type !== MessageType.EVENT) {
      this.#error('outbound-schema', new Error((res.errors || ['not an event']).join('; ')));
      return 'invalid';
    }
    if (this.queued.has(ev.event_id) || this.recentAcked.has(ev.event_id)) {
      this.stats.skipped_local_duplicate++;
      return 'duplicate';
    }
    this.#enqueue(ev, true);
    if (this.state === 'open') { this.#rawSend(ev); this.stats.sent++; ev.__sentOnce = true; return 'sent'; }
    return 'queued';
  }

  #enqueue(ev, persist) {
    if (this.queued.has(ev.event_id)) return;
    this.queue.push(ev);
    this.queued.add(ev.event_id);
    while (this.queue.length > this.maxQueue) {
      const dropped = this.queue.shift();
      this.queued.delete(dropped.event_id);
      this.stats.dropped_overflow++;
    }
    if (persist) this.#persistQueue();
  }

  #dequeue(eventId) {
    if (!this.queued.delete(eventId)) return false;
    const i = this.queue.findIndex((e) => e.event_id === eventId);
    if (i >= 0) this.queue.splice(i, 1);
    this.#persistQueue();
    return true;
  }

  #persistQueue() {
    if (!this.queueStore) return;
    clearTimeout(this.timers.persist);
    this.timers.persist = setTimeout(() => {
      const clean = this.queue.map(({ __sentOnce, ...e }) => e);
      Promise.resolve(this.queueStore.set(clean)).catch((err) => this.#error('queue-persist', err));
    }, 200);
  }

  subscribe(conversations) {
    const fresh = conversations.filter((c) => c && !this.subscriptions.has(c));
    for (const c of fresh) this.subscriptions.add(c);
    if (fresh.length && this.state === 'open') {
      this.#rawSend(makeEnvelope(MessageType.SUBSCRIBE, { conversations: fresh }));
    }
  }

  unsubscribe(conversations) {
    const gone = conversations.filter((c) => this.subscriptions.delete(c));
    if (gone.length && this.state === 'open') {
      this.#rawSend(makeEnvelope(MessageType.UNSUBSCRIBE, { conversations: gone }));
    }
  }

  #rawSend(msg) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      const { __sentOnce, ...clean } = msg;
      this.ws.send(JSON.stringify(clean));
      return true;
    } catch (err) {
      this.#error('send', err);
      return false;
    }
  }

  #flush() {
    for (const ev of this.queue) {
      if (!this.#rawSend(ev)) break;
      if (ev.__sentOnce) this.stats.resent++; else this.stats.sent++;
      ev.__sentOnce = true;
    }
  }

  // ---------------------------------------------------------------- 接收

  #onRaw(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); } catch (err) {
      this.stats.received.invalid++;
      return this.#error('inbound-json', err);
    }
    const res = validateMessage(msg, { direction: 's2c' });
    if (!res.ok) {
      this.stats.received.invalid++;
      return this.#error('inbound-schema', new Error(`${msg?.type}: ${res.errors.slice(0, 3).join('; ')}`));
    }
    if (this.stats.received[msg.type] != null) this.stats.received[msg.type]++;
    this.recentInbound.push({ at: Date.now(), type: msg.type, ref: msg.ref_id || msg.origin_event_id || msg.nonce || null });
    if (this.recentInbound.length > 30) this.recentInbound.shift();

    switch (msg.type) {
      case MessageType.WELCOME: return this.#onWelcome(msg);
      case MessageType.ACK: return this.#onAck(msg);
      case MessageType.ERROR: return this.#onError(msg);
      case MessageType.BROADCAST: return this.#onBroadcastMsg(msg);
      case MessageType.SUBSCRIBED: return undefined;
      case MessageType.PING: return this.#rawSend(makeEnvelope(MessageType.PONG, { nonce: msg.nonce }));
      case MessageType.PONG: clearTimeout(this.timers.pong); return undefined;
      case MessageType.COMMAND: return this.#onCommandMsg(msg);
      default: return undefined;
    }
  }

  #onWelcome(msg) {
    clearTimeout(this.timers.hello);
    this.session = { id: msg.session_id, scopes: msg.scopes, policy: msg.policy, at: Date.now() };
    this.stats.connects++;
    this.attempt = 0;
    this.#setState('open');
    if (this.subscriptions.size) {
      this.#rawSend(makeEnvelope(MessageType.SUBSCRIBE, { conversations: [...this.subscriptions].slice(0, 100) }));
    }
    this.#flush();
    this.#startHeartbeat();
  }

  #onAck(msg) {
    if (msg.status === 'duplicate') this.stats.ack_duplicate++;
    this.stats.acked++;
    this.recentAcked.add(msg.ref_id);
    this.#dequeue(msg.ref_id);
  }

  #onError(msg) {
    this.#error(`server:${msg.code}`, new Error(msg.message), msg.ref_id);
    if (msg.code === ErrorCode.UNAUTHORIZED) {
      // token 错误：重连无意义，停止并等待用户修改设置
      this.#setState('auth_failed');
      return;
    }
    if (msg.ref_id && NON_RETRYABLE_ERRORS.includes(msg.code) && this.#dequeue(msg.ref_id)) {
      this.stats.dropped_rejected++;
    }
  }

  async #onCommandMsg(msg) {
    let result;
    try {
      result = this.onCommand ? await this.onCommand(msg) : { ok: false, code: 'unsupported', detail: 'no command handler' };
    } catch (err) {
      result = { ok: false, code: 'exception', detail: String(err?.message || err) };
    }
    result = result || { ok: false, code: 'no_result' };
    if (result.ok) this.stats.commands_ok++; else this.stats.commands_failed++;
    this.#rawSend(makeEnvelope(MessageType.COMMAND_RESULT, {
      command_id: msg.command_id,
      ok: !!result.ok,
      ...(result.code ? { code: String(result.code).slice(0, 64) } : {}),
      detail: result.detail == null ? null : String(result.detail).slice(0, 500)
    }));
  }

  #onBroadcastMsg(msg) {
    if (this.seenBroadcastSeq.has(msg.seq) || this.seenBroadcastEvent.has(msg.origin_event_id)) {
      this.stats.broadcast_duplicate++;
      return;
    }
    this.seenBroadcastSeq.add(msg.seq);
    this.seenBroadcastEvent.add(msg.origin_event_id);
    if (msg.origin_client_id === this.clientId) {
      // 后端开启 echo_to_sender 时的自身回显：已通过 ack 确认，不再处理
      this.stats.broadcast_self_echo++;
      return;
    }
    this.stats.broadcast_delivered++;
    try { this.onBroadcast(msg); } catch (err) { this.#error('onBroadcast', err); }
  }

  #startHeartbeat() {
    clearInterval(this.timers.heartbeat);
    this.timers.heartbeat = setInterval(() => {
      const nonce = randomId('n').slice(0, 24);
      if (!this.#rawSend(makeEnvelope(MessageType.PING, { nonce }))) return;
      clearTimeout(this.timers.pong);
      this.timers.pong = setTimeout(() => {
        this.#error('heartbeat', new Error('pong timeout'));
        try { this.ws?.close(4101, 'pong timeout'); } catch { /* ignore */ }
      }, this.pongTimeoutMs);
    }, this.heartbeatMs);
  }

  // ---------------------------------------------------------------- 工具

  #clearTimers() {
    clearTimeout(this.timers.retry);
    clearTimeout(this.timers.hello);
    clearTimeout(this.timers.pong);
    clearInterval(this.timers.heartbeat);
  }

  #setState(s) {
    if (this.state === s) return;
    this.state = s;
    try { this.onStateChange(s); } catch { /* ignore */ }
  }

  #error(stage, err, ref = null) {
    this.errors.push({ at: Date.now(), stage, message: String(err?.message || err), ref });
    if (this.errors.length > 30) this.errors.shift();
  }

  diagnostics() {
    return {
      protocol: PROTOCOL_VERSION,
      url: this.url,
      client_id: this.clientId,
      state: this.state,
      session: this.session,
      attempt: this.attempt,
      next_retry_at: this.nextRetryAt,
      last_close: this.lastCloseInfo,
      queue: { size: this.queue.length, max: this.maxQueue, head: this.queue.slice(0, 5).map((e) => ({ event_id: e.event_id, event_type: e.event_type })) },
      subscriptions: [...this.subscriptions],
      stats: JSON.parse(JSON.stringify(this.stats)),
      recent_inbound: this.recentInbound.slice(-15),
      errors: this.errors.slice(-15)
    };
  }
}

/** 有界 LRU 集合，用于去重 */
export class LruSet {
  constructor(max) { this.max = max; this.map = new Map(); }
  has(k) { return this.map.has(k); }
  add(k) {
    this.map.delete(k);
    this.map.set(k, true);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}
