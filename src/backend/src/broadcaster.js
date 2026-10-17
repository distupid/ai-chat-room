import WebSocket from 'ws';

/**
 * 统一广播服务。
 *
 * - 维护已认证的客户端集合（client_id → ClientRecord）。
 * - broadcast(msgFactory, filter)：向所有匹配客户端发送；sendTo(clientId, msg)：定向发送。
 * - 只向 readyState === OPEN 的连接发送；已关闭/失效连接会被移除。
 * - 每个客户端的发送都单独 try/catch，单个失败不会中断整个广播。
 * - 慢消费者（bufferedAmount 超限）跳过本次并累计 strike，超过阈值后断开。
 * - 所有失败都有日志与计数，可通过 stats() 和 HTTP /stats 观察。
 */
export class Broadcaster {
  constructor({ policy, logger }) {
    this.policy = policy;
    this.log = logger;
    this.clients = new Map();
    this.counters = {
      broadcasts: 0,            // 调用 broadcast() 的次数
      deliveries: 0,            // 成功投递的消息数
      send_failures: 0,         // send 抛错或回调报错
      skipped_closed: 0,        // 连接已关闭被跳过
      skipped_slow: 0,          // 慢消费者被跳过
      skipped_oversize: 0,      // 消息超过 max_message_bytes 未发送
      slow_consumer_disconnects: 0,
      direct_sends: 0
    };
    this.lastErrors = [];
  }

  add(record) {
    const existing = this.clients.get(record.clientId);
    if (existing && existing.ws !== record.ws) {
      // 同一 client_id 重连：旧连接被替换，避免同一客户端收到两份广播
      try { existing.ws.close(4001, 'replaced by newer connection'); } catch { /* ignore */ }
    }
    this.clients.set(record.clientId, record);
  }

  remove(clientId, ws) {
    const rec = this.clients.get(clientId);
    if (rec && (!ws || rec.ws === ws)) this.clients.delete(clientId);
  }

  get size() { return this.clients.size; }

  /**
   * @param {(rec) => object|null} build  为每个接收者构造消息（可做脱敏）；返回 null 表示不发
   * @param {(rec) => boolean} filter     接收者过滤
   * @returns {{targets:number, delivered:number, failed:number, skipped:number}}
   */
  broadcast(build, filter = () => true) {
    this.counters.broadcasts++;
    const result = { targets: 0, delivered: 0, failed: 0, skipped: 0 };
    for (const rec of [...this.clients.values()]) {
      let match = false;
      try { match = filter(rec); } catch (err) { this.recordError('filter', rec, err); }
      if (!match) continue;
      result.targets++;
      let msg;
      try { msg = build(rec); } catch (err) { this.recordError('build', rec, err); result.failed++; continue; }
      if (!msg) { result.skipped++; continue; }
      const outcome = this.#send(rec, msg);
      if (outcome === 'ok') result.delivered++;
      else if (outcome === 'failed') result.failed++;
      else result.skipped++;
    }
    return result;
  }

  sendTo(clientId, msg) {
    const rec = this.clients.get(clientId);
    if (!rec) return 'missing';
    this.counters.direct_sends++;
    return this.#send(rec, msg);
  }

  /** 用于尚未完成握手的连接（错误/欢迎消息） */
  sendRaw(ws, msg) {
    if (ws.readyState !== WebSocket.OPEN) return 'closed';
    try { ws.send(JSON.stringify(msg)); return 'ok'; } catch (err) { this.recordError('sendRaw', null, err); return 'failed'; }
  }

  #send(rec, msg) {
    const { ws } = rec;
    if (ws.readyState !== WebSocket.OPEN) {
      this.counters.skipped_closed++;
      this.remove(rec.clientId, ws);
      return 'closed';
    }
    let data;
    try { data = JSON.stringify(msg); } catch (err) { this.recordError('serialize', rec, err); return 'failed'; }
    if (Buffer.byteLength(data) > this.policy.max_message_bytes) {
      this.counters.skipped_oversize++;
      this.recordError('oversize', rec, new Error(`message ${msg.type} exceeds ${this.policy.max_message_bytes} bytes`));
      return 'skipped';
    }
    if (ws.bufferedAmount > this.policy.max_buffered_bytes) {
      this.counters.skipped_slow++;
      rec.slowStrikes = (rec.slowStrikes || 0) + 1;
      if (rec.slowStrikes >= this.policy.slow_consumer_strikes) {
        this.counters.slow_consumer_disconnects++;
        this.log.warn(`[broadcast] disconnecting slow consumer ${rec.clientId}`);
        try { ws.terminate(); } catch { /* ignore */ }
        this.remove(rec.clientId, ws);
      }
      return 'skipped';
    }
    rec.slowStrikes = 0;
    try {
      ws.send(data, (err) => {
        if (err) { this.counters.send_failures++; this.recordError('send-cb', rec, err); }
      });
      this.counters.deliveries++;
      rec.sent = (rec.sent || 0) + 1;
      return 'ok';
    } catch (err) {
      this.counters.send_failures++;
      this.recordError('send', rec, err);
      return 'failed';
    }
  }

  recordError(stage, rec, err) {
    const entry = { at: Date.now(), stage, client_id: rec?.clientId ?? null, error: String(err?.message || err) };
    this.lastErrors.push(entry);
    if (this.lastErrors.length > 50) this.lastErrors.shift();
    this.log.warn(`[broadcast] ${stage} error for ${entry.client_id}: ${entry.error}`);
  }

  stats() {
    return {
      connected_clients: this.clients.size,
      clients: [...this.clients.values()].map((r) => ({
        client_id: r.clientId, kind: r.kind, subscriptions: [...r.subscriptions], sent: r.sent || 0
      })),
      counters: { ...this.counters },
      last_errors: this.lastErrors.slice(-10)
    };
  }
}
