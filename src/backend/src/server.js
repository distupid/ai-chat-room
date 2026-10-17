import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  ErrorCode, MessageType, PROTOCOL_VERSION, Scope, validateMessage, makeEnvelope, randomId
} from '../../../contracts/protocol.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { TokenBucket } from './ratelimit.js';
import { analyzeDom } from './dom-analyzer.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 看板静态文件（白名单，不做任意路径映射）
const DASHBOARD_FILES = {
  '/dashboard': { file: join(HERE, '..', 'dashboard', 'index.html'), type: 'text/html; charset=utf-8' },
  '/dashboard/': { file: join(HERE, '..', 'dashboard', 'index.html'), type: 'text/html; charset=utf-8' },
  '/dashboard/app.js': { file: join(HERE, '..', 'dashboard', 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/dashboard/protocol.js': { file: join(HERE, '..', '..', '..', 'contracts', 'protocol.js'), type: 'text/javascript; charset=utf-8' }
};

const MAX_DOM_UPLOAD_BYTES = 16 * 1024 * 1024;

const SILENT = { info() {}, warn() {}, error() {} };

/**
 * 创建本地桥接后端。
 * @param {object} opts
 * @param {string} [opts.configPath] 配置文件路径（不存在会自动生成 token）
 * @param {string} [opts.dbPath]     SQLite 路径
 * @param {number} [opts.port]       0 = 随机端口（测试用）
 * @param {object} [opts.policy]     覆盖广播策略
 * @param {Array}  [opts.clients]    覆盖 token 配置（测试用）
 */
export function createBridgeServer(opts = {}) {
  const config = loadConfig(opts.configPath, opts);
  const policy = config.policy;
  const log = opts.logger || (opts.quiet ? SILENT : console);
  const db = openDatabase(config.dbPath || opts.dbPath || ':memory:');
  const broadcaster = new Broadcaster({ policy, logger: log });
  const counters = {
    connections_total: 0, connections_rejected: 0, events_received: 0, events_persisted: 0,
    events_duplicate: 0, events_rejected: 0, errors_sent: 0, rate_limited: 0, replayed: 0,
    commands_received: 0, commands_ok: 0, commands_failed: 0
  };

  // DOM 配置：插件上传页面 DOM → 分析 → 统一配置；保存在 data/dom-config.json，重启后仍然有效
  const domConfigPath = opts.domConfigPath ?? (opts.configPath ? join(dirname(opts.configPath), 'dom-config.json') : null);
  let domConfig = null;
  if (domConfigPath && existsSync(domConfigPath)) {
    try { domConfig = JSON.parse(readFileSync(domConfigPath, 'utf8')); } catch { domConfig = null; }
  }
  function saveDomConfig(cfg) {
    domConfig = cfg;
    if (!domConfigPath) return;
    mkdirSync(dirname(domConfigPath), { recursive: true });
    writeFileSync(domConfigPath, JSON.stringify(cfg, null, 2) + '\n');
  }

  const startedAt = Date.now();
  const httpServer = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    // 只返回统计和健康状态，不暴露任何对话内容
    if (path === '/healthz') return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION });
    if (path === '/stats') return json(res, 200, stats());
    if (DASHBOARD_FILES[path] && req.method === 'GET') return serveDashboardFile(req, res, DASHBOARD_FILES[path]);
    if (path === '/api/conversations' || path.startsWith('/api/conversations/')) {
      handleDashboardApi(req, res, path).catch((err) => {
        log.error('[dashboard]', err);
        if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      });
      return;
    }
    if (path === '/api/dom-config' || path === '/api/dom-config/analyze') {
      handleDomConfig(req, res, path).catch((err) => {
        log.error('[dom-config]', err);
        if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      });
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  function serveDashboardFile(req, res, entry) {
    // 页面本身不含任何对话数据；数据接口和 WebSocket 都需要 observer token
    let body;
    try { body = readFileSync(entry.file); } catch { return json(res, 404, { error: 'not found' }); }
    res.writeHead(200, {
      'content-type': entry.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
    });
    res.end(body);
  }

  function clientFromRequest(req) {
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return auth ? authenticate(auth[1].trim()) : null;
  }

  /**
   * 看板数据接口（需要 subscribe_all + read_content，即 observer token）：
   *   GET /api/conversations                         会话列表
   *   GET /api/conversations/:id/messages            当前消息
   *   GET /api/conversations/:id/events?limit=100    最近事件（不含正文）
   *   POST /api/conversations/:id/mark  {done: bool}  标记完成 / 取消
   */
  async function handleDashboardApi(req, res, path) {
    if (!originAllowed(req.headers.origin, req.headers.host)) return json(res, 403, { ok: false, error: 'forbidden origin' });
    const client = clientFromRequest(req);
    if (!client) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (!client.scopes.includes(Scope.SUBSCRIBE_ALL) || !client.scopes.includes(Scope.READ_CONTENT)) {
      return json(res, 403, { ok: false, error: 'subscribe_all + read_content scope required' });
    }
    const params = new URL(req.url, 'http://x').searchParams;
    const mark = /^\/api\/conversations\/([A-Za-z0-9_-]{1,128})\/mark$/.exec(path);
    if (mark && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req, 4096)) || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      db.setDone(mark[1], body.done !== false);
      return json(res, 200, { ok: true, conversation_id: mark[1], done: body.done !== false });
    }
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
    if (path === '/api/conversations') {
      return json(res, 200, { ok: true, max_seq: db.maxSeq(), now: Date.now(), conversations: db.listConversations(clampInt(params.get('limit'), 1, 1000, 200)) });
    }
    const m = /^\/api\/conversations\/([A-Za-z0-9_-]{1,128})\/(messages|events)$/.exec(path);
    if (!m) return json(res, 404, { ok: false, error: 'not found' });
    if (m[2] === 'messages') return json(res, 200, { ok: true, conversation_id: m[1], messages: db.listMessages(m[1]) });
    return json(res, 200, { ok: true, conversation_id: m[1], events: db.recentEvents(m[1], clampInt(params.get('limit'), 1, 1000, 100)) });
  }

  /**
   * GET    /api/dom-config          读取当前配置（没有则 config=null，插件使用内置默认值）
   * POST   /api/dom-config/analyze  body: {html, url, title} → 分析并保存，返回 {ok, config, report}
   * DELETE /api/dom-config          清除配置
   * 认证：Authorization: Bearer <extension token>（需要 publish 权限）；拒绝普通网页 Origin。
   */
  async function handleDomConfig(req, res, path) {
    if (!originAllowed(req.headers.origin, req.headers.host)) return json(res, 403, { ok: false, error: 'forbidden origin' });
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const client = auth ? authenticate(auth[1].trim()) : null;
    if (!client) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (!client.scopes.includes(Scope.PUBLISH)) return json(res, 403, { ok: false, error: 'publish scope required' });

    if (path === '/api/dom-config' && req.method === 'GET') return json(res, 200, { ok: true, config: domConfig });
    if (path === '/api/dom-config' && req.method === 'DELETE') {
      saveDomConfig(null);
      return json(res, 200, { ok: true, config: null });
    }
    if (path === '/api/dom-config/analyze' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req, MAX_DOM_UPLOAD_BYTES)); }
      catch (e) { return json(res, e.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: e.code === 'TOO_LARGE' ? 'payload too large' : 'invalid json' }); }
      if (!body || typeof body.html !== 'string') return json(res, 400, { ok: false, error: 'html required' });
      const result = analyzeDom(body.html, { url: body.url, title: body.title });
      if (result.ok) saveDomConfig(result.config);
      log.info(`[dom-config] analyze from ${client.name}: ${result.ok ? result.report.strategy + ' messages=' + result.report.message_count : result.report.error}`);
      return json(res, result.ok ? 200 : 422, result);
    }
    return json(res, 405, { ok: false, error: 'method not allowed' });
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: policy.max_message_bytes,
    perMessageDeflate: false
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const reject = (code, text) => {
      counters.connections_rejected++;
      log.warn(`[ws] reject upgrade: ${code} ${text} (origin=${req.headers.origin ?? '-'})`);
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!originAllowed(req.headers.origin, req.headers.host)) return reject(403, 'Forbidden origin');
    if (wss.clients.size >= policy.max_connections) return reject(503, 'Too many connections');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  /**
   * Origin 访问边界：
   * - 无 Origin（本机 Node/CLI 客户端）→ 允许（仍需 token）
   * - chrome-extension://<id> → 允许（可在配置中限定 id）
   * - 任何 http(s) 网页 Origin → 拒绝，防止任意网页连接本机端口读取对话
   */
  function originAllowed(origin, host) {
    if (!origin) return true;
    // 本后端自己提供的看板页面（同源：http://127.0.0.1:<端口>）
    if (host && isSameOriginDashboard(origin, host)) return true;
    if (origin.startsWith('chrome-extension://')) {
      return config.allowedExtensionOrigins.length === 0 || config.allowedExtensionOrigins.includes(origin);
    }
    return false;
  }

  function authenticate(token) {
    const given = Buffer.from(String(token));
    for (const c of config.clients) {
      const expected = Buffer.from(c.token);
      if (expected.length === given.length && timingSafeEqual(expected, given)) return c;
    }
    return null;
  }

  wss.on('connection', (ws, req) => {
    counters.connections_total++;
    const conn = {
      ws, rec: null, sessionId: randomId('s'),
      bucket: new TokenBucket(policy.rate_limit),
      remote: req.socket.remoteAddress, alive: true
    };
    ws.on('pong', () => { conn.alive = true; });
    const helloTimer = setTimeout(() => {
      if (!conn.rec) sendError(conn, null, ErrorCode.NOT_HELLO, 'hello timeout', true);
    }, policy.hello_timeout_ms);

    ws.on('message', (data, isBinary) => {
      try {
        handleRaw(conn, data, isBinary);
      } catch (err) {
        log.error('[ws] handler crashed', err);
        sendError(conn, null, ErrorCode.INTERNAL, 'internal error', false);
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (conn.rec) broadcaster.remove(conn.rec.clientId, ws);
    });
    ws.on('error', (err) => log.warn(`[ws] socket error: ${err.message}`));
  });

  function handleRaw(conn, data, isBinary) {
    if (isBinary) return sendError(conn, null, ErrorCode.SCHEMA_VIOLATION, 'binary frames are not supported', false);
    if (!conn.bucket.take()) {
      counters.rate_limited++;
      return sendError(conn, null, ErrorCode.RATE_LIMITED, 'rate limit exceeded', false);
    }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch {
      return sendError(conn, null, ErrorCode.INVALID_JSON, 'invalid JSON', false);
    }
    const res = validateMessage(msg, { direction: 'c2s' });
    const refId = typeof msg?.event_id === 'string' ? msg.event_id.slice(0, 128) : (typeof msg?.id === 'string' ? msg.id.slice(0, 128) : null);
    if (!res.ok) {
      if (msg?.type === MessageType.EVENT) counters.events_rejected++;
      // 客户端发来 ack/broadcast/welcome 等服务端类型 → FORBIDDEN，避免被当成新事件形成循环
      return sendError(conn, refId, res.code, res.errors.slice(0, 5).join('; '), !conn.rec && msg?.type === MessageType.HELLO);
    }
    if (!conn.rec && msg.type !== MessageType.HELLO) {
      return sendError(conn, refId, ErrorCode.NOT_HELLO, 'first message must be hello', true);
    }
    switch (msg.type) {
      case MessageType.HELLO: return onHello(conn, msg);
      case MessageType.EVENT: return onEvent(conn, msg);
      case MessageType.SUBSCRIBE: return onSubscribe(conn, msg);
      case MessageType.UNSUBSCRIBE: return onUnsubscribe(conn, msg);
      case MessageType.PING: return reply(conn, makeEnvelope(MessageType.PONG, { nonce: msg.nonce }));
      case MessageType.PONG: return undefined;
      case MessageType.COMMAND: return onCommand(conn, msg);
      case MessageType.COMMAND_RESULT: return onCommandResult(conn, msg);
      default: return undefined;
    }
  }

  // ------------------------------------------------------------- 看板指令
  // command_id → { requester, target, timer }
  const pendingCommands = new Map();
  const COMMAND_TIMEOUT_MS = opts.commandTimeoutMs ?? 20000;

  function sendTo(rec, msg) {
    if (!rec || rec.ws.readyState !== 1) return false;
    try { rec.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  function commandResult(commandId, ok, code, detail) {
    return makeEnvelope(MessageType.COMMAND_RESULT, {
      command_id: commandId, ok, ...(code ? { code } : {}), detail: detail == null ? null : String(detail).slice(0, 500)
    });
  }

  /** 看板（control 权限）→ 找到开着该会话的插件标签页 → 转发指令 */
  function onCommand(conn, msg) {
    if (!conn.rec.scopes.has(Scope.CONTROL)) {
      return sendError(conn, msg.id, ErrorCode.FORBIDDEN, 'token lacks control scope', false);
    }
    counters.commands_received++;
    if (msg.action === 'reply' && !msg.text?.trim()) return reply(conn, commandResult(msg.command_id, false, 'text_required', '回复内容不能为空'));
    if (pendingCommands.has(msg.command_id)) return reply(conn, commandResult(msg.command_id, false, 'duplicate_command', null));

    let target = null;
    let tabId = null;
    for (const t of db.openTabsFor(msg.conversation_id)) {
      const rec = broadcaster.clients.get(t.client_id);
      if (rec && rec.scopes.has(Scope.PUBLISH) && rec.ws.readyState === 1) { target = rec; tabId = t.tab_id; break; }
    }
    if (!target) {
      counters.commands_failed++;
      return reply(conn, commandResult(msg.command_id, false, 'no_open_tab', '没有在线的插件标签页打开着这个会话'));
    }
    const timer = setTimeout(() => {
      if (!pendingCommands.delete(msg.command_id)) return;
      counters.commands_failed++;
      sendTo(conn.rec, commandResult(msg.command_id, false, 'timeout', '插件没有在规定时间内返回结果'));
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    pendingCommands.set(msg.command_id, { requester: conn.rec, target: target.clientId, timer });
    sendTo(target, makeEnvelope(MessageType.COMMAND, {
      command_id: msg.command_id,
      action: msg.action,
      conversation_id: msg.conversation_id,
      ...(msg.action === 'reply' ? { text: msg.text } : {}),
      tab_id: tabId,
      requested_by: conn.rec.clientId
    }));
    log.info(`[cmd] ${msg.action} conv=${msg.conversation_id} from ${conn.rec.clientId} → ${target.clientId} tab=${tabId}`);
  }

  /** 插件 → 看板：只接受被转发对象自己返回的结果 */
  function onCommandResult(conn, msg) {
    const p = pendingCommands.get(msg.command_id);
    if (!p || p.target !== conn.rec.clientId) return undefined;
    pendingCommands.delete(msg.command_id);
    clearTimeout(p.timer);
    if (msg.ok) counters.commands_ok++; else counters.commands_failed++;
    sendTo(p.requester, commandResult(msg.command_id, msg.ok, msg.code, msg.detail));
    return undefined;
  }

  function onHello(conn, msg) {
    if (conn.rec) return sendError(conn, msg.id, ErrorCode.SCHEMA_VIOLATION, 'duplicate hello', false);
    const client = authenticate(msg.token);
    if (!client) return sendError(conn, msg.id, ErrorCode.UNAUTHORIZED, 'invalid token', true);
    if (client.kind && client.kind !== msg.client_kind) {
      return sendError(conn, msg.id, ErrorCode.UNAUTHORIZED, `token is not valid for client_kind ${msg.client_kind}`, true);
    }
    conn.rec = {
      ws: conn.ws, clientId: msg.client_id, kind: msg.client_kind, name: client.name,
      scopes: new Set(client.scopes), subscriptions: new Set(), sessionId: conn.sessionId
    };
    broadcaster.add(conn.rec);
    log.info(`[ws] hello ${msg.client_kind}:${msg.client_id} (${client.name}) from ${conn.remote}`);
    reply(conn, makeEnvelope(MessageType.WELCOME, {
      session_id: conn.sessionId,
      client_id: msg.client_id,
      scopes: [...conn.rec.scopes],
      server_time: Date.now(),
      policy: {
        echo_to_sender: policy.echo_to_sender,
        max_message_bytes: policy.max_message_bytes,
        history_limit: policy.history_limit,
        heartbeat_ms: policy.heartbeat_ms,
        broadcast_event_types: policy.broadcast_event_types
      }
    }));
  }

  function onEvent(conn, ev) {
    counters.events_received++;
    if (!conn.rec.scopes.has(Scope.PUBLISH)) {
      counters.events_rejected++;
      return sendError(conn, ev.event_id, ErrorCode.FORBIDDEN, 'token lacks publish scope', false);
    }
    let result;
    try {
      result = db.persistEvent(conn.rec.clientId, ev);
    } catch (err) {
      log.error('[db] persist failed', err);
      return sendError(conn, ev.event_id, ErrorCode.INTERNAL, 'persist failed', false);
    }
    // 先确认（持久化成功之后），再广播
    reply(conn, makeEnvelope(MessageType.ACK, {
      ref_id: ev.event_id, status: result.duplicate ? 'duplicate' : 'persisted', seq: result.seq
    }));
    if (result.duplicate) { counters.events_duplicate++; return; }
    counters.events_persisted++;
    if (!policy.broadcast_event_types.includes(ev.event_type)) return;

    const stored = { ...ev, seq: result.seq, client_id: conn.rec.clientId };
    broadcaster.broadcast(
      (rec) => toBroadcast(stored, rec, false),
      (rec) => (policy.echo_to_sender || rec.clientId !== conn.rec.clientId) && subscribedTo(rec, ev.conversation_id)
    );
  }

  function subscribedTo(rec, conversationId) {
    if (rec.subscriptions.has('*')) return true;
    return conversationId != null && rec.subscriptions.has(conversationId);
  }

  /** 构造广播消息；无 read_content 权限时去掉消息正文 */
  function toBroadcast(stored, rec, replay) {
    const canRead = rec.scopes.has(Scope.READ_CONTENT);
    let payload = stored.payload;
    let redacted = false;
    if (!canRead && typeof payload.text === 'string') {
      const { text, ...rest } = payload;
      payload = rest;
      redacted = true;
    }
    return makeEnvelope(MessageType.BROADCAST, {
      seq: stored.seq,
      origin_event_id: stored.event_id,
      origin_client_id: stored.client_id,
      event_id: stored.event_id,
      event_type: stored.event_type,
      occurred_at: stored.occurred_at,
      conversation_id: stored.conversation_id,
      payload,
      redacted,
      replay
    });
  }

  function onSubscribe(conn, msg) {
    const rec = conn.rec;
    const wantsAll = msg.conversations.includes('*');
    if (wantsAll && !rec.scopes.has(Scope.SUBSCRIBE_ALL)) {
      return sendError(conn, msg.id, ErrorCode.FORBIDDEN, 'token lacks subscribe_all scope', false);
    }
    if (!wantsAll && !rec.scopes.has(Scope.SUBSCRIBE) && !rec.scopes.has(Scope.SUBSCRIBE_ALL)) {
      return sendError(conn, msg.id, ErrorCode.FORBIDDEN, 'token lacks subscribe scope', false);
    }
    if (msg.since_seq != null && !rec.scopes.has(Scope.HISTORY)) {
      return sendError(conn, msg.id, ErrorCode.FORBIDDEN, 'token lacks history scope', false);
    }
    if (rec.subscriptions.size + msg.conversations.length > 100) {
      return sendError(conn, msg.id, ErrorCode.FORBIDDEN, 'too many subscriptions', false);
    }
    for (const c of msg.conversations) rec.subscriptions.add(c);
    let replayed = 0;
    if (msg.since_seq != null && policy.history_limit > 0) {
      const rows = db.eventsSince(msg.since_seq, msg.conversations, policy.history_limit)
        .filter((r) => policy.broadcast_event_types.includes(r.event_type));
      for (const row of rows) {
        if (broadcaster.sendTo(rec.clientId, toBroadcast(row, rec, true)) === 'ok') replayed++;
      }
      counters.replayed += replayed;
    }
    reply(conn, makeEnvelope(MessageType.SUBSCRIBED, {
      ref_id: msg.id, conversations: [...rec.subscriptions], replayed
    }));
  }

  function onUnsubscribe(conn, msg) {
    for (const c of msg.conversations) conn.rec.subscriptions.delete(c);
    reply(conn, makeEnvelope(MessageType.SUBSCRIBED, {
      ref_id: msg.id, conversations: [...conn.rec.subscriptions], replayed: 0
    }));
  }

  function reply(conn, msg) { return broadcaster.sendRaw(conn.ws, msg); }

  function sendError(conn, refId, code, message, fatal) {
    counters.errors_sent++;
    broadcaster.sendRaw(conn.ws, makeEnvelope(MessageType.ERROR, {
      ref_id: refId, code, message: String(message).slice(0, 1000), fatal
    }));
    if (fatal) setTimeout(() => { try { conn.ws.close(4000 + Math.min(999, Object.keys(ErrorCode).indexOf(code)), code); } catch { /* ignore */ } }, 10);
  }

  // 协议层心跳：清理死连接
  let heartbeat = null;

  function stats() {
    return {
      server: { started_at: startedAt, uptime_ms: Date.now() - startedAt, protocol: PROTOCOL_VERSION, pending_commands: pendingCommands.size },
      counters: { ...counters }, events_in_db: db.countEvents(), broadcast: broadcaster.stats(), policy
    };
  }

  return {
    config, db, broadcaster,
    get port() { return httpServer.address()?.port; },
    get url() { return `ws://${config.host === '::1' ? '[::1]' : config.host}:${this.port}`; },
    stats,
    start() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          heartbeat = setInterval(() => {
            for (const ws of wss.clients) {
              const c = [...broadcaster.clients.values()].find((r) => r.ws === ws);
              if (ws._bridgeAlive === false) { ws.terminate(); if (c) broadcaster.remove(c.clientId, ws); continue; }
              ws._bridgeAlive = false;
              ws.once('pong', () => { ws._bridgeAlive = true; });
              try { ws.ping(); } catch { /* ignore */ }
            }
          }, policy.heartbeat_ms);
          heartbeat.unref?.();
          log.info(`[bridge] listening on ws://${config.host}:${httpServer.address().port}`);
          resolve(this);
        });
      });
    },
    stop() {
      clearInterval(heartbeat);
      return new Promise((resolve) => {
        for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
        wss.close(() => {
          httpServer.close(() => { db.close(); resolve(); });
          httpServer.closeAllConnections?.();
        });
      });
    }
  };
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

/** Origin 必须与 Host 完全一致，且 Host 是回环地址 —— 只有本机这个端口上提供的页面能通过 */
function isSameOriginDashboard(origin, host) {
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (o.protocol !== 'http:' || o.host !== host) return false;
  const h = o.hostname.replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c); // 超限后继续读完但丢弃，以便返回 413
    });
    req.on('end', () => {
      if (size > limit) { const err = new Error('too large'); err.code = 'TOO_LARGE'; return reject(err); }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}
