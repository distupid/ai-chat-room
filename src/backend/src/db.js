import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite 持久化。
 *
 * 持久化/确认策略：
 *   1. 事件先通过 Schema 校验；
 *   2. 在同一事务内写入 events（event_id UNIQUE）并 upsert 派生表；
 *   3. 写入成功后才发送 ack(status=persisted, seq)，然后广播；
 *   4. event_id 已存在 → ack(status=duplicate, seq=原 seq)，不再广播（防重复广播/循环）。
 * 使用 Node 内置 node:sqlite（同步 API，无需原生编译），seq 的分配顺序与广播顺序严格一致。
 */
export function openDatabase(dbPath = ':memory:') {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        TEXT    NOT NULL UNIQUE,
      client_id       TEXT    NOT NULL,
      event_type      TEXT    NOT NULL,
      conversation_id TEXT,
      tab_id          INTEGER,
      occurred_at     INTEGER NOT NULL,
      received_at     INTEGER NOT NULL,
      payload_json    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_conv_seq ON events(conversation_id, seq);

    CREATE TABLE IF NOT EXISTS messages (
      conversation_id TEXT    NOT NULL,
      message_id      TEXT    NOT NULL,
      role            TEXT    NOT NULL,
      msg_index       INTEGER NOT NULL,
      text            TEXT    NOT NULL,
      updated_seq     INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_marks (
      conversation_id TEXT PRIMARY KEY,
      done            INTEGER NOT NULL DEFAULT 0,
      done_at         INTEGER,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      first_seen_at   INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      last_url        TEXT
    );
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (event_id, client_id, event_type, conversation_id, tab_id, occurred_at, received_at, payload_json)
    VALUES (@event_id, @client_id, @event_type, @conversation_id, @tab_id, @occurred_at, @received_at, @payload_json)
    ON CONFLICT(event_id) DO NOTHING`);
  const findSeq = db.prepare('SELECT seq FROM events WHERE event_id = ?');
  const upsertMessage = db.prepare(`
    INSERT INTO messages (conversation_id, message_id, role, msg_index, text, updated_seq, updated_at)
    VALUES (@conversation_id, @message_id, @role, @msg_index, @text, @seq, @now)
    ON CONFLICT(conversation_id, message_id) DO UPDATE SET
      role = excluded.role, msg_index = excluded.msg_index, text = excluded.text,
      updated_seq = excluded.updated_seq, updated_at = excluded.updated_at
    WHERE excluded.updated_seq > messages.updated_seq`);
  const upsertConversation = db.prepare(`
    INSERT INTO conversations (conversation_id, first_seen_at, last_seen_at, last_url)
    VALUES (@conversation_id, @now, @now, @url)
    ON CONFLICT(conversation_id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
      last_url = COALESCE(excluded.last_url, conversations.last_url)`);

  const persistInner = (clientId, ev, now) => {
    const info = insertEvent.run({
      event_id: ev.event_id,
      client_id: clientId,
      event_type: ev.event_type,
      conversation_id: ev.conversation_id,
      tab_id: ev.tab_id ?? null,
      occurred_at: ev.occurred_at,
      received_at: now,
      payload_json: JSON.stringify(ev.payload)
    });
    if (info.changes === 0) {
      return { duplicate: true, seq: Number(findSeq.get(ev.event_id).seq) };
    }
    const seq = Number(info.lastInsertRowid);
    if (ev.conversation_id) {
      upsertConversation.run({ conversation_id: ev.conversation_id, now, url: ev.payload.url ?? null });
      if (ev.event_type === 'message.added' || ev.event_type === 'message.updated') {
        upsertMessage.run({
          conversation_id: ev.conversation_id,
          message_id: ev.payload.message_id,
          role: ev.payload.role,
          msg_index: ev.payload.index,
          text: ev.payload.text,
          seq, now
        });
      }
    }
    return { duplicate: false, seq };
  };
  const persist = (clientId, ev, now) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = persistInner(clientId, ev, now);
      db.exec('COMMIT');
      return r;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  };

  const sinceAll = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?');
  const listConversationsStmt = db.prepare(`
    SELECT c.conversation_id, c.first_seen_at, c.last_seen_at, c.last_url,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.conversation_id) AS message_count,
      (SELECT COUNT(*) FROM events e WHERE e.conversation_id = c.conversation_id) AS event_count,
      (SELECT substr(text, 1, 160) FROM messages m WHERE m.conversation_id = c.conversation_id AND role = 'user'
         ORDER BY msg_index LIMIT 1) AS first_user_text,
      (SELECT role FROM messages m WHERE m.conversation_id = c.conversation_id ORDER BY msg_index DESC LIMIT 1) AS last_role,
      (SELECT substr(text, -160) FROM messages m WHERE m.conversation_id = c.conversation_id ORDER BY msg_index DESC LIMIT 1) AS last_text,
      (SELECT event_type FROM events e WHERE e.conversation_id = c.conversation_id
         AND event_type IN ('generation.started', 'generation.finished') ORDER BY seq DESC LIMIT 1) AS last_generation_event,
      (SELECT event_type FROM events e WHERE e.conversation_id = c.conversation_id
         AND event_type IN ('page.opened', 'page.closed', 'conversation.changed') ORDER BY seq DESC LIMIT 1) AS last_page_event,
      (SELECT json_extract(payload_json, '$.title') FROM events e WHERE e.conversation_id = c.conversation_id
         AND event_type = 'page.opened' ORDER BY seq DESC LIMIT 1) AS title,
      (SELECT payload_json FROM events e WHERE e.conversation_id = c.conversation_id
         AND event_type = 'conversation.status' ORDER BY seq DESC LIMIT 1) AS status_json,
      (SELECT received_at FROM events e WHERE e.conversation_id = c.conversation_id
         AND event_type = 'conversation.status' ORDER BY seq DESC LIMIT 1) AS status_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.conversation_id AND role = 'user') AS user_count,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.conversation_id AND role = 'assistant') AS assistant_count,
      (SELECT COUNT(*) FROM events e WHERE e.conversation_id = c.conversation_id AND event_type = 'generation.finished') AS generation_count,
      (SELECT json_extract(payload_json, '$.duration_ms') FROM events e WHERE e.conversation_id = c.conversation_id
         AND event_type = 'generation.finished' ORDER BY seq DESC LIMIT 1) AS last_duration_ms,
      mk.done AS done, mk.done_at AS done_at
    FROM conversations c LEFT JOIN conversation_marks mk ON mk.conversation_id = c.conversation_id
    ORDER BY c.last_seen_at DESC LIMIT ?`);
  const setMarkStmt = db.prepare(`
    INSERT INTO conversation_marks (conversation_id, done, done_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET done = excluded.done, done_at = excluded.done_at, updated_at = excluded.updated_at`);
  // 每个标签页（client_id + tab_id）最近一次页面级事件：用来算“当前有几个标签页开着这个会话”
  const latestTabEventsStmt = db.prepare(`
    SELECT e.conversation_id, e.event_type, e.received_at, e.client_id, e.tab_id, e.seq FROM events e
    JOIN (SELECT client_id, tab_id, MAX(seq) AS s FROM events
          WHERE tab_id IS NOT NULL AND event_type IN ('page.opened', 'page.closed', 'conversation.changed')
          GROUP BY client_id, tab_id) x ON e.seq = x.s`);
  const listMessagesStmt = db.prepare(`
    SELECT message_id, role, msg_index, text, updated_seq, updated_at FROM messages
    WHERE conversation_id = ? ORDER BY msg_index, updated_seq`);
  const recentEventsStmt = db.prepare('SELECT * FROM events WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?');

  return {
    raw: db,
    persistEvent(clientId, ev, now = Date.now()) {
      return persist(clientId, ev, now);
    },
    /** 回放：只返回指定会话（或 "*"）中 seq > sinceSeq 的事件 */
    eventsSince(sinceSeq, conversations, limit) {
      if (conversations.includes('*')) return sinceAll.all(sinceSeq, limit).map(rowToEvent);
      const placeholders = conversations.map(() => '?').join(',');
      return db.prepare(
        `SELECT * FROM events WHERE seq > ? AND conversation_id IN (${placeholders}) ORDER BY seq LIMIT ?`
      ).all(sinceSeq, ...conversations, limit).map(rowToEvent);
    },
    countEvents() { return Number(db.prepare('SELECT COUNT(*) AS n FROM events').get().n); },
    maxSeq() { return Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events').get().n); },

    /** 看板：会话列表（最近活动在前），附带消息数、首条用户消息、最后一条消息预览、生成状态、标签页状态 */
    listConversations(limit = 200, now = Date.now()) {
      const openTabs = new Map();
      for (const t of latestTabEventsStmt.all()) {
        if (t.event_type === 'page.closed' || !t.conversation_id) continue;
        if (now - t.received_at > TAB_STALE_MS) continue;   // 浏览器崩溃等没来得及上报关闭的标签页
        openTabs.set(t.conversation_id, (openTabs.get(t.conversation_id) || 0) + 1);
      }
      return listConversationsStmt.all(limit).map((r) => deriveConversation(r, openTabs.get(r.conversation_id) || 0));
    },
    /** 当前开着该会话的标签页（最近活动在前），用于把看板指令路由到对应插件 */
    openTabsFor(conversationId, now = Date.now()) {
      return latestTabEventsStmt.all()
        .filter((t) => t.conversation_id === conversationId && t.event_type !== 'page.closed' && now - t.received_at <= TAB_STALE_MS)
        .sort((a, b) => Number(b.seq) - Number(a.seq))
        .map((t) => ({ client_id: t.client_id, tab_id: Number(t.tab_id) }));
    },
    /** 标记完成 / 取消标记 */
    setDone(conversationId, done, now = Date.now()) {
      setMarkStmt.run(conversationId, done ? 1 : 0, done ? now : null, now);
    },
    /** 看板：某个会话的当前消息（每条消息的最新版本） */
    listMessages(conversationId) {
      return listMessagesStmt.all(conversationId).map((r) => ({ ...r, updated_seq: Number(r.updated_seq) }));
    },
    /** 看板：某个会话最近的事件（不含正文，只保留长度） */
    recentEvents(conversationId, limit = 100) {
      return recentEventsStmt.all(conversationId, limit).map(rowToEvent).reverse().map(stripText);
    },
    getEvent(eventId) {
      const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId);
      return row ? rowToEvent(row) : null;
    },
    getMessage(conversationId, messageId) {
      const row = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?').get(conversationId, messageId);
      return row ? { ...row } : null;
    },
    close() { db.close(); }
  };
}

function rowToEvent(row) {
  return {
    seq: Number(row.seq),
    event_id: row.event_id,
    client_id: row.client_id,
    event_type: row.event_type,
    conversation_id: row.conversation_id,
    tab_id: row.tab_id,
    occurred_at: row.occurred_at,
    received_at: row.received_at,
    payload: JSON.parse(row.payload_json)
  };
}

function stripText(ev) {
  if (typeof ev.payload?.text !== 'string') return ev;
  const { text, ...rest } = ev.payload;
  return { ...ev, payload: rest };
}

const TAB_STALE_MS = 12 * 60 * 60 * 1000;

function sourceFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)chatgpt\.com$/.test(host) || /(^|\.)chat\.openai\.com$/.test(host)) return 'chatgpt';
    if (/(^|\.)duck\.ai$/.test(host)) return 'duckai';
    if (/(^|\.)hark\.com$/.test(host)) return 'hark';
    const parts = host.split('.');
    return (parts.length >= 2 ? parts[parts.length - 2] : host) || 'unknown';
  } catch { return 'unknown'; }
}

/**
 * 会话实体：
 *   status 优先级：closed（没有标签页开着）> limit_reached > error > generating > idle
 *   页面关掉后 status_detail 仍保留最后一次的限额/报错提示
 */
function deriveConversation(r, openTabs) {
  let st = null;
  try { st = r.status_json ? JSON.parse(r.status_json) : null; } catch { st = null; }
  const generating = r.last_generation_event === 'generation.started';
  const pageStatus = st?.status || 'ok';
  let status;
  if (openTabs === 0) status = 'closed';
  else if (pageStatus === 'limit_reached') status = 'limit_reached';
  else if (pageStatus === 'error') status = 'error';
  else if (generating) status = 'generating';
  else status = 'idle';
  return {
    conversation_id: r.conversation_id,
    source: st?.source || sourceFromUrl(r.last_url),
    title: r.title || null,
    url: r.last_url,
    model: st?.model || null,
    status,
    page_status: pageStatus,
    status_detail: st?.detail || null,
    status_at: r.status_at ?? null,
    generating: generating && openTabs > 0,
    open_tabs: openTabs,
    message_count: Number(r.message_count),
    user_count: Number(r.user_count),
    assistant_count: Number(r.assistant_count),
    first_user_text: r.first_user_text || null,
    last_message: r.last_role ? { role: r.last_role, text: r.last_text || '' } : null,
    generation_count: Number(r.generation_count),
    last_duration_ms: r.last_duration_ms == null ? null : Number(r.last_duration_ms),
    event_count: Number(r.event_count),
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    done: !!r.done,
    done_at: r.done_at ?? null,
    // 标记完成之后又有新动态（新消息、新状态）
    activity_after_done: !!r.done && r.done_at != null && r.last_seen_at > r.done_at
  };
}
