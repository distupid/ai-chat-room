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

    CREATE TABLE IF NOT EXISTS favorites (
      conversation_id TEXT NOT NULL,
      message_id      TEXT NOT NULL,
      role            TEXT,
      text            TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      first_seen_at   INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      last_url        TEXT
    );
  `);

  // 幂等迁移：conversation_marks 增加 置顶 / 归档 列；旧的“标记完成”(done) 迁移为归档
  const markCols = new Set(db.prepare('PRAGMA table_info(conversation_marks)').all().map((c) => c.name));
  const addCol = (name, ddl) => { if (!markCols.has(name)) db.exec(`ALTER TABLE conversation_marks ADD COLUMN ${name} ${ddl}`); };
  const hadArchived = markCols.has('archived');
  addCol('archived', 'INTEGER NOT NULL DEFAULT 0');
  addCol('archived_at', 'INTEGER');
  addCol('pinned', 'INTEGER NOT NULL DEFAULT 0');
  addCol('pinned_at', 'INTEGER');
  if (!hadArchived) db.exec('UPDATE conversation_marks SET archived = done, archived_at = done_at WHERE done = 1');
  // 幂等迁移：messages 增加 html（净化后的富文本，可为空）
  const msgCols = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
  if (!msgCols.has('html')) db.exec('ALTER TABLE messages ADD COLUMN html TEXT');

  // 看板会话列表 / 指令路由的热路径索引（幂等）：
  //   按会话 + 事件类型取最近一条（标题、状态、生成、用时），避免在长对话的大量 message.updated 里倒序扫描；
  //   每个标签页最近一次页面级事件（部分索引，只含页面级事件）；消息按序号 / 角色查找
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_conv_type_seq ON events(conversation_id, event_type, seq);
    CREATE INDEX IF NOT EXISTS idx_events_tab_page ON events(client_id, tab_id, seq)
      WHERE tab_id IS NOT NULL AND event_type IN ('page.opened', 'page.closed', 'conversation.changed');
    CREATE INDEX IF NOT EXISTS idx_messages_conv_index ON messages(conversation_id, msg_index);
    CREATE INDEX IF NOT EXISTS idx_messages_conv_role ON messages(conversation_id, role, msg_index);
    CREATE INDEX IF NOT EXISTS idx_conversations_last_seen ON conversations(last_seen_at);
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (event_id, client_id, event_type, conversation_id, tab_id, occurred_at, received_at, payload_json)
    VALUES (@event_id, @client_id, @event_type, @conversation_id, @tab_id, @occurred_at, @received_at, @payload_json)
    ON CONFLICT(event_id) DO NOTHING`);
  const findSeq = db.prepare('SELECT seq FROM events WHERE event_id = ?');
  const upsertMessage = db.prepare(`
    INSERT INTO messages (conversation_id, message_id, role, msg_index, text, html, updated_seq, updated_at)
    VALUES (@conversation_id, @message_id, @role, @msg_index, @text, @html, @seq, @now)
    ON CONFLICT(conversation_id, message_id) DO UPDATE SET
      role = excluded.role, text = excluded.text, html = excluded.html,   -- 序号以第一次记录为准，不被之后的更新覆盖（长对话里页面只渲染一部分，序号会变）
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
          html: typeof ev.payload.html === 'string' ? ev.payload.html : null,
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
      -- 最近一次生成事件：先在 (会话, 类型, seq) 索引上取 MAX(seq) 再回表，不在长对话的大量 message.updated 里倒序扫描
      (SELECT event_type FROM events WHERE seq = (SELECT MAX(seq) FROM events e WHERE e.conversation_id = c.conversation_id
         AND event_type IN ('generation.started', 'generation.finished'))) AS last_generation_event,
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
      (SELECT COUNT(*) FROM favorites f WHERE f.conversation_id = c.conversation_id) AS favorite_count,
      mk.archived AS archived, mk.archived_at AS archived_at, mk.pinned AS pinned, mk.pinned_at AS pinned_at
    FROM conversations c LEFT JOIN conversation_marks mk ON mk.conversation_id = c.conversation_id
    ORDER BY c.last_seen_at DESC LIMIT ?`);
  const ensureMarkStmt = db.prepare(`
    INSERT INTO conversation_marks (conversation_id, updated_at) VALUES (?, ?) ON CONFLICT(conversation_id) DO NOTHING`);
  const setArchivedStmt = db.prepare(`
    UPDATE conversation_marks SET archived = ?, archived_at = ?, done = ?, done_at = ?, updated_at = ? WHERE conversation_id = ?`);
  const setPinnedStmt = db.prepare(`
    UPDATE conversation_marks SET pinned = ?, pinned_at = ?, updated_at = ? WHERE conversation_id = ?`);
  const addFavoriteStmt = db.prepare(`
    INSERT INTO favorites (conversation_id, message_id, role, text, created_at)
    SELECT conversation_id, message_id, role, text, ? FROM messages WHERE conversation_id = ? AND message_id = ?
    ON CONFLICT(conversation_id, message_id) DO UPDATE SET text = excluded.text`);
  const removeFavoriteStmt = db.prepare('DELETE FROM favorites WHERE conversation_id = ? AND message_id = ?');
  const favoriteIdsStmt = db.prepare('SELECT message_id FROM favorites WHERE conversation_id = ?');
  const listFavoritesStmt = db.prepare(`
    SELECT conversation_id, message_id, role, text, created_at FROM favorites ORDER BY created_at DESC LIMIT ?`);
  // 每个标签页（client_id + tab_id）最近一次页面级事件：用来算“当前有几个标签页开着这个会话”
  const latestTabEventsStmt = db.prepare(`
    SELECT e.conversation_id, e.event_type, e.received_at, e.client_id, e.tab_id, e.seq,
      json_extract(e.payload_json, '$.url') AS url FROM events e
    JOIN (SELECT client_id, tab_id, MAX(seq) AS s FROM events
          WHERE tab_id IS NOT NULL AND event_type IN ('page.opened', 'page.closed', 'conversation.changed')
          GROUP BY client_id, tab_id) x ON e.seq = x.s`);
  const listMessagesStmt = db.prepare(`
    SELECT message_id, role, msg_index, text, html, updated_seq, updated_at FROM messages
    WHERE conversation_id = ? ORDER BY msg_index, updated_seq`);
  const recentEventsStmt = db.prepare('SELECT * FROM events WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?');
  const countEventsStmt = db.prepare('SELECT COUNT(*) AS n FROM events');
  const maxSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events');
  const getEventStmt = db.prepare('SELECT * FROM events WHERE event_id = ?');
  const getMessageStmt = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?');
  const conversationUrlStmt = db.prepare('SELECT last_url FROM conversations WHERE conversation_id = ?');
  // 回放指定会话：按会话个数缓存预编译语句（占位符个数不同）
  const sinceConvStmts = new Map();
  const sinceConvStmt = (n) => {
    let st = sinceConvStmts.get(n);
    if (!st) {
      st = db.prepare(`SELECT * FROM events WHERE seq > ? AND conversation_id IN (${Array(n).fill('?').join(',')}) ORDER BY seq LIMIT ?`);
      sinceConvStmts.set(n, st);
    }
    return st;
  };

  let sourceResolver = sourceFromUrl;
  return {
    raw: db,
    /** 网址 → 来源标识（后端按网站列表匹配域名）；没有页面上报的 conversation.status 时用 */
    setSourceResolver(fn) { sourceResolver = typeof fn === 'function' ? fn : sourceFromUrl; },
    /** 删除单个会话的全部数据 */
    deleteConversation(conversationId) {
      const removed = {};
      db.exec('BEGIN');
      try {
        for (const t of ['messages', 'favorites', 'conversation_marks', 'conversations', 'events']) {
          removed[t] = Number(db.prepare(`DELETE FROM ${t} WHERE conversation_id = ?`).run(conversationId).changes);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return removed;
    },
    /** 重置：清空所有会话数据（网站列表在 sites.json，不受影响）；事件 seq 继续递增（AUTOINCREMENT），订阅游标不会倒退 */
    resetAll() {
      const removed = {};
      db.exec('BEGIN');
      try {
        for (const t of ['messages', 'favorites', 'conversation_marks', 'conversations', 'events']) {
          removed[t] = Number(db.prepare(`DELETE FROM ${t}`).run().changes);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return removed;
    },
    persistEvent(clientId, ev, now = Date.now()) {
      return persist(clientId, ev, now);
    },
    /** 回放：只返回指定会话（或 "*"）中 seq > sinceSeq 的事件 */
    eventsSince(sinceSeq, conversations, limit) {
      if (conversations.includes('*')) return sinceAll.all(sinceSeq, limit).map(rowToEvent);
      if (!conversations.length) return [];
      return sinceConvStmt(conversations.length).all(sinceSeq, ...conversations, limit).map(rowToEvent);
    },
    countEvents() { return Number(countEventsStmt.get().n); },
    maxSeq() { return Number(maxSeqStmt.get().n); },
    /** 会话最近一次记录的页面地址（没有返回 null） */
    conversationUrl(conversationId) { return conversationUrlStmt.get(conversationId)?.last_url ?? null; },

    /** 看板：会话列表（最近活动在前），附带消息数、首条用户消息、最后一条消息预览、生成状态、标签页状态 */
    listConversations(limit = 200, now = Date.now()) {
      const openTabs = new Map();
      for (const t of latestTabEventsStmt.all()) {
        if (t.event_type === 'page.closed' || !t.conversation_id) continue;
        if (now - t.received_at > TAB_STALE_MS) continue;   // 浏览器崩溃等没来得及上报关闭的标签页
        openTabs.set(t.conversation_id, (openTabs.get(t.conversation_id) || 0) + 1);
      }
      // 源站已删除的会话（最近一次 conversation.status 为 deleted）不再跟踪；之后若再上报 ok 会自动恢复
      return listConversationsStmt.all(limit).map((r) => deriveConversation(r, openTabs.get(r.conversation_id) || 0, sourceResolver))
        .filter((c) => c.page_status !== 'deleted')
        // 标签页会话（页面开着但还没进入具体会话）：页面关掉 / 进入真正的会话后就不再显示
        .filter((c) => !(c.pending && c.open_tabs === 0));
    },
    /** 某个插件每个标签页最近一次页面级事件（含已关闭），用于和插件上报的真实标签页对账 */
    tabStatesForClient(clientId) {
      return latestTabEventsStmt.all().filter((t) => t.client_id === clientId)
        .map((t) => ({ tab_id: Number(t.tab_id), conversation_id: t.conversation_id, event_type: t.event_type, received_at: t.received_at, url: t.url || '' }));
    },
    /** 当前开着该会话的标签页（最近活动在前），用于把看板指令路由到对应插件 */
    openTabsFor(conversationId, now = Date.now()) {
      return latestTabEventsStmt.all()
        .filter((t) => t.conversation_id === conversationId && t.event_type !== 'page.closed' && now - t.received_at <= TAB_STALE_MS)
        .sort((a, b) => Number(b.seq) - Number(a.seq))
        .map((t) => ({ client_id: t.client_id, tab_id: Number(t.tab_id) }));
    },
    /** 归档 / 取消归档（旧接口 done 视为归档） */
    setArchived(conversationId, archived, now = Date.now()) {
      ensureMarkStmt.run(conversationId, now);
      const v = archived ? 1 : 0;
      const at = archived ? now : null;
      setArchivedStmt.run(v, at, v, at, now, conversationId);
    },
    setDone(conversationId, done, now = Date.now()) { this.setArchived(conversationId, done, now); },
    /** 置顶 / 取消置顶 */
    setPinned(conversationId, pinned, now = Date.now()) {
      ensureMarkStmt.run(conversationId, now);
      setPinnedStmt.run(pinned ? 1 : 0, pinned ? now : null, now, conversationId);
    },
    /** 收藏回答（保存当时的正文快照）；消息不存在返回 false */
    setFavorite(conversationId, messageId, favorite, now = Date.now()) {
      if (!favorite) { removeFavoriteStmt.run(conversationId, messageId); return true; }
      return addFavoriteStmt.run(now, conversationId, messageId).changes > 0;
    },
    listFavorites(limit = 200) {
      return listFavoritesStmt.all(limit).map((r) => ({ ...r }));
    },
    /** 看板：某个会话的当前消息（每条消息的最新版本） */
    listMessages(conversationId) {
      const fav = new Set(favoriteIdsStmt.all(conversationId).map((r) => r.message_id));
      return listMessagesStmt.all(conversationId).map((r) => ({ ...r, updated_seq: Number(r.updated_seq), favorite: fav.has(r.message_id) }));
    },
    /** 看板：某个会话最近的事件（不含正文，只保留长度） */
    recentEvents(conversationId, limit = 100) {
      return recentEventsStmt.all(conversationId, limit).map(rowToEvent).reverse().map(stripText);
    },
    getEvent(eventId) {
      const row = getEventStmt.get(eventId);
      return row ? rowToEvent(row) : null;
    },
    getMessage(conversationId, messageId) {
      const row = getMessageStmt.get(conversationId, messageId);
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
  if (typeof ev.payload?.text !== 'string' && typeof ev.payload?.html !== 'string') return ev;
  const { text, html, ...rest } = ev.payload;
  return { ...ev, payload: rest };
}

const TAB_STALE_MS = 12 * 60 * 60 * 1000;

/** 默认的来源解析（后端会用网站列表替换，见 setSourceResolver）：取主域名 */
function sourceFromUrl(url) {
  try {
    const parts = new URL(url).hostname.split('.');
    return (parts.length >= 2 ? parts[parts.length - 2] : parts[0]) || 'unknown';
  } catch { return 'unknown'; }
}

/**
 * 会话实体：
 *   status 优先级：closed（没有标签页开着）> limit_reached > error > generating > idle
 *   页面关掉后 status_detail 仍保留最后一次的限额/报错提示
 */
function deriveConversation(r, openTabs, resolveSource = sourceFromUrl) {
  let st = null;
  try { st = r.status_json ? JSON.parse(r.status_json) : null; } catch { st = null; }
  const generating = r.last_generation_event === 'generation.started';
  const pageStatus = st?.status || 'ok';
  let status;
  if (openTabs === 0) status = 'closed';
  else if (pageStatus === 'error') status = 'error';
  else if (generating) status = 'generating';
  else status = 'idle';
  return {
    conversation_id: r.conversation_id,
    pending: String(r.conversation_id).startsWith('tab-'),   // 标签页会话：开着网站但还没有具体会话
    source: st?.source || resolveSource(r.last_url),
    title: r.title || null,
    url: r.last_url,
    model: st?.model || null,
    composer: st?.composer || null,   // 输入框能力（上传按钮样式 / accept），页面关掉后保留最后一次
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
    favorite_count: Number(r.favorite_count || 0),
    pinned: !!r.pinned,
    pinned_at: r.pinned_at ?? null,
    archived: !!r.archived,
    archived_at: r.archived_at ?? null,
    // 归档之后又有新动态（新消息、新状态）
    activity_after_archive: !!r.archived && r.archived_at != null && r.last_seen_at > r.archived_at
  };
}
