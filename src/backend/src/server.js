import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  ErrorCode, EventType, MessageType, PROTOCOL_VERSION, Scope, validateMessage, makeEnvelope, randomId, Limits
} from '../../../contracts/protocol.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { TokenBucket } from './ratelimit.js';
import { analyzeDom, analyzeNewSite } from './dom-analyzer.js';
import { seedSites, seedByKey, SEED_KEYS, siteHosts, sourceForUrl } from './site-seeds.js';
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
    if (path === '/api/conversations' || path.startsWith('/api/conversations/') || path === '/api/favorites') {
      handleDashboardApi(req, res, path).catch((err) => {
        log.error('[dashboard]', err);
        if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      });
      return;
    }
    if (path === '/api/sites' || path.startsWith('/api/sites/') || path === '/api/admin/reset-db') {
      handleSitesApi(req, res, path).catch((err) => {
        log.error('[sites]', err);
        if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      });
      return;
    }
    if (path === '/api/attachments' || path.startsWith('/api/attachments/')) {
      handleAttachments(req, res, path).catch((err) => {
        log.error('[attachments]', err);
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
      'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-ancestors 'none'"
    });
    res.end(body);
  }

  // ------------------------------------------------------------- 快速回复附件
  // 看板先把文件上传到这里（只在内存里保留一段时间），快速回复指令带上附件 ID；
  // 插件收到指令后用自己的 token 取回文件，再交给源站页面自己的上传控件（和在网页上点上传按钮一样）。
  const MAX_ATTACHMENT_BYTES = opts.maxAttachmentBytes ?? Limits.MAX_ATTACHMENT_BYTES;
  const ATTACHMENT_TTL_MS = opts.attachmentTtlMs ?? 30 * 60 * 1000;
  const MAX_ATTACHMENT_TOTAL = opts.maxAttachmentTotalBytes ?? 200 * 1024 * 1024;
  const attachments = new Map();   // id → { buf, name, type, size, expires }
  function pruneAttachments() {
    const t = Date.now();
    for (const [id, a] of attachments) if (a.expires <= t) attachments.delete(id);
    let total = [...attachments.values()].reduce((n, a) => n + a.size, 0);
    for (const [id, a] of attachments) {   // Map 按插入顺序：超过总量时先删最早的
      if (total <= MAX_ATTACHMENT_TOTAL) break;
      attachments.delete(id); total -= a.size;
    }
  }
  /**
   *   POST /api/attachments   body = 文件原始内容；header x-file-name = encodeURIComponent(文件名)，
   *        content-type = 文件类型 → {ok, attachment:{id,name,type,size}}
   *        鉴权：control（看板发快速回复附件）或 publish（插件上传页面里观察到的文件）
   *   GET  /api/attachments/:id → 文件内容
   *        鉴权：publish（插件取快速回复附件）或 read_content（看板看插件上传的文件）
   */
  async function handleAttachments(req, res, path) {
    if (!originAllowed(req.headers.origin, req.headers.host)) return json(res, 403, { ok: false, error: 'forbidden origin' });
    const client = clientFromRequest(req);
    if (!client) return json(res, 401, { ok: false, error: 'unauthorized' });
    pruneAttachments();
    if (path === '/api/attachments' && req.method === 'POST') {
      if (!client.scopes.includes(Scope.CONTROL) && !client.scopes.includes(Scope.PUBLISH)) {
        return json(res, 403, { ok: false, error: 'control or publish scope required' });
      }
      let name = 'file';
      try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { /* 保持默认 */ }
      name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 255) || 'file';
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ct) && ct.length <= 128 ? ct : 'application/octet-stream';
      let buf;
      try { buf = await readBody(req, MAX_ATTACHMENT_BYTES, true); }
      catch (e) { return json(res, e.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: e.code === 'TOO_LARGE' ? `文件超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)} MB` : 'read failed' }); }
      const id = randomId('att').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      attachments.set(id, { buf, name, type, size: buf.length, expires: Date.now() + ATTACHMENT_TTL_MS });
      pruneAttachments();
      return json(res, 201, { ok: true, attachment: { id, name, type, size: buf.length } });
    }
    const one = /^\/api\/attachments\/([A-Za-z0-9_-]{8,64})$/.exec(path);
    if (one && req.method === 'GET') {
      if (!client.scopes.includes(Scope.PUBLISH) && !client.scopes.includes(Scope.READ_CONTENT)) {
        return json(res, 403, { ok: false, error: 'publish or read_content scope required' });
      }
      const a = attachments.get(one[1]);
      if (!a) return json(res, 404, { ok: false, error: '附件不存在或已过期' });
      res.writeHead(200, {
        'content-type': a.type, 'content-length': a.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`
      });
      return res.end(a.buf);
    }
    return json(res, 405, { ok: false, error: 'method not allowed' });
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
   *   POST /api/conversations/:id/mark  {archived?: bool, pinned?: bool}  归档 / 置顶（旧字段 done 等同 archived）
   *   POST /api/conversations/:id/messages/:mid/favorite  {favorite: bool}  收藏 / 取消收藏回答
   *   POST /api/conversations/:id/reopen               页面已关的会话：插件在后台标签页重新打开
   *   DELETE /api/conversations/:id                      删除页面已关的会话（消息 / 收藏 / 标记 / 事件）
   *   GET  /api/favorites?limit=200                      收藏的回答（正文快照）
   */
  async function handleDashboardApi(req, res, path) {
    if (!originAllowed(req.headers.origin, req.headers.host)) return json(res, 403, { ok: false, error: 'forbidden origin' });
    const client = clientFromRequest(req);
    if (!client) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (!client.scopes.includes(Scope.SUBSCRIBE_ALL) || !client.scopes.includes(Scope.READ_CONTENT)) {
      return json(res, 403, { ok: false, error: 'subscribe_all + read_content scope required' });
    }
    const params = new URL(req.url, 'http://x').searchParams;
    const reopen = /^\/api\/conversations\/([A-Za-z0-9_-]{1,128})\/reopen$/.exec(path);
    if (reopen && req.method === 'POST') {
      // 页面已关的会话：让插件在后台标签页重新打开（不抢焦点），页面上报后卡片状态自动更新
      if (!client.scopes.includes(Scope.CONTROL)) return json(res, 403, { ok: false, error: 'control scope required' });
      const url = db.conversationUrl(reopen[1]);
      if (typeof url !== 'string' || !/^https:\/\//.test(url)) return json(res, 404, { ok: false, error: '这个会话没有记录页面地址' });
      const target = onlineExtensions()[0];
      if (!target) return json(res, 409, { ok: false, error: '没有在线的浏览器插件', url });
      sendTo(target, makeEnvelope(MessageType.COMMAND, { command_id: randomId('reopen').slice(0, 40), action: 'new_chat', conversation_id: 'sites', text: url.slice(0, 2048) }));
      return json(res, 202, { ok: true, url });
    }
    const del = /^\/api\/conversations\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (del && req.method === 'DELETE') {
      // 删除会话（只允许页面已关的会话）：从数据库移除它的消息、收藏、标记和事件
      if (db.openTabsFor(del[1]).length) return json(res, 409, { ok: false, error: '页面还开着，先关闭页面再删除' });
      return json(res, 200, { ok: true, conversation_id: del[1], removed: db.deleteConversation(del[1]) });
    }
    const mark = /^\/api\/conversations\/([A-Za-z0-9_-]{1,128})\/mark$/.exec(path);
    if (mark && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req, 4096)) || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      const out = { ok: true, conversation_id: mark[1] };
      const archived = typeof body.archived === 'boolean' ? body.archived : typeof body.done === 'boolean' ? body.done : undefined;
      if (archived !== undefined) { db.setArchived(mark[1], archived); out.archived = archived; }
      if (typeof body.pinned === 'boolean') { db.setPinned(mark[1], body.pinned); out.pinned = body.pinned; }
      if (archived === undefined && out.pinned === undefined) return json(res, 400, { ok: false, error: 'archived or pinned required' });
      return json(res, 200, out);
    }
    const fav = /^\/api\/conversations\/([A-Za-z0-9_-]{1,128})\/messages\/([^/]{1,400})\/favorite$/.exec(path);
    if (fav && req.method === 'POST') {
      try { fav[2] = decodeURIComponent(fav[2]); } catch { return json(res, 400, { ok: false, error: 'invalid message id' }); }
      if (!fav[2] || fav[2].length > 128) return json(res, 400, { ok: false, error: 'invalid message id' });
      let body = {};
      try { body = JSON.parse((await readBody(req, 4096)) || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      const favorite = body.favorite !== false;
      if (!db.setFavorite(fav[1], fav[2], favorite)) return json(res, 404, { ok: false, error: 'message not found' });
      return json(res, 200, { ok: true, conversation_id: fav[1], message_id: fav[2], favorite });
    }
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
    if (path === '/api/favorites') {
      return json(res, 200, { ok: true, favorites: db.listFavorites(clampInt(params.get('limit'), 1, 1000, 200)) });
    }
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

  // ------------------------------------------------------------- 已适配网站
  // 网站列表（data/sites.json）：没有“内置”网站。首次启动用默认种子（ChatGPT / Duck.ai / Hark，含 DOM 配置）初始化，
  // 之后全部网站一样：可编辑名称 / 网址 / 域名 / DOM 配置、停用、删除；插件按这份列表注册内容脚本、按域名选配置。
  // 默认网站删除后不会自动回来，可在看板“恢复默认网站”加回；某个默认网站的配置可“恢复默认”。
  const MAX_SITE_CONFIG_BYTES = 128 * 1024;
  const sitesPath = opts.sitesPath ?? (opts.configPath ? join(dirname(opts.configPath), 'sites.json') : null);
  let customSites = null;
  if (sitesPath && existsSync(sitesPath)) {
    try { const v = JSON.parse(readFileSync(sitesPath, 'utf8')); if (Array.isArray(v)) customSites = v.filter((x) => x && typeof x === 'object' && x.key); } catch { customSites = null; }
  }
  let sitesDirty = false;
  if (!customSites) { customSites = seedSites(); sitesDirty = true; }
  else {
    // 旧版 sites.json 只存“添加的网站”：补上默认网站（只补一次，之后删除了就不再出现）
    if (!customSites.some((x) => x.seeded) && !SEED_KEYS.every((k) => customSites.some((x) => x.key === k))) {
      customSites = [...seedSites().filter((d) => !customSites.some((x) => x.key === d.key)), ...customSites];
      sitesDirty = true;
    }
    // 旧版默认网站没有 DOM 配置（适配写在插件里）：补上种子配置和域名
    for (const x of customSites) {
      const seed = SEED_KEYS.includes(x.key) ? seedByKey(x.key) : null;
      if (seed && !x.config) { x.config = seed.config; sitesDirty = true; }
      if (seed && !Array.isArray(x.hosts)) { x.hosts = seed.hosts; sitesDirty = true; }
    }
  }
  for (const x of customSites) {
    delete x.builtin;
    x.seeded = true;
    if (typeof x.enabled !== 'boolean') x.enabled = true;
    if (!Array.isArray(x.hosts)) x.hosts = [];
  }
  /** 对外的网站条目：去掉内部标记；has_default = 有默认种子，可“恢复默认” */
  const siteOut = ({ seeded, ...x }) => ({ ...x, has_default: SEED_KEYS.includes(x.key) });
  const missingDefaults = () => seedSites().filter((d) => !customSites.some((x) => x.key === d.key || siteHosts(x).some((h) => siteHosts(d).includes(h))));
  db.setSourceResolver?.((url) => sourceForUrl(url, customSites));
  function saveSites() {
    if (!sitesPath) return;
    mkdirSync(dirname(sitesPath), { recursive: true });
    writeFileSync(sitesPath, JSON.stringify(customSites, null, 2) + '\n');
  }
  if (sitesDirty) saveSites();
  // probe_id → { status: pending|done|error, url, target, requester, result, error, at }
  const probes = new Map();
  const PROBE_TTL_MS = 10 * 60 * 1000;
  function prune() { const now = Date.now(); for (const [k, v] of probes) if (now - v.at > PROBE_TTL_MS) probes.delete(k); }
  function onlineExtensions() {
    return [...broadcaster.clients.values()].filter((r) => r.scopes.has(Scope.PUBLISH) && r.ws.readyState === 1);
  }
  /** 通知所有在线插件：网站列表变了，重新拉取并注册内容脚本 */
  function notifySitesChanged() {
    for (const rec of onlineExtensions()) {
      sendTo(rec, makeEnvelope(MessageType.COMMAND, { command_id: randomId('sync'), action: 'sync_sites', conversation_id: 'sites' }));
    }
  }

  /**
   * GET    /api/sites                     网站列表（含 DOM 配置、enabled、hosts、has_default）+ missing_defaults；observer 或 extension token
   * POST   /api/sites/probe {url}         看板：让插件打开网址抓取 DOM 并分析；返回 {probe_id}（control）
   * GET    /api/sites/probe/:id           看板轮询分析结果（control）
   * POST   /api/sites/probe/:id/dom       插件上传抓到的页面 {html, url, title}（publish，且必须是被指派的插件）
   * POST   /api/sites {probe_id, name}    看板确认添加（control）
   * PATCH  /api/sites/:key {name?, url?, hosts?, enabled?, config?}  编辑网站（control）
   * POST   /api/sites/:key/reset          默认网站的 DOM 配置 / 域名恢复默认（control）
   * POST   /api/sites/defaults            把删掉的默认网站加回来（control）
   * DELETE /api/sites/:key                删除网站（control）
   * POST   /api/sites/launch              一键启动：让插件在后台打开所有网站（control）
   */
  async function handleSitesApi(req, res, path) {
    if (!originAllowed(req.headers.origin, req.headers.host)) return json(res, 403, { ok: false, error: 'forbidden origin' });
    const client = clientFromRequest(req);
    if (!client) return json(res, 401, { ok: false, error: 'unauthorized' });
    const can = (sc) => client.scopes.includes(sc);
    const body = async (max = 8192) => {
      try { return JSON.parse((await readBody(req, max)) || '{}'); } catch (e) { const err = new Error(e.code === 'TOO_LARGE' ? 'payload too large' : 'invalid json'); err.status = e.code === 'TOO_LARGE' ? 413 : 400; throw err; }
    };
    try {
      if (path === '/api/sites' && req.method === 'GET') {
        if (!can(Scope.READ_CONTENT) && !can(Scope.PUBLISH)) return json(res, 403, { ok: false, error: 'forbidden' });
        return json(res, 200, { ok: true, sites: customSites.map(siteOut), missing_defaults: missingDefaults().map((x) => x.key) });
      }
      const dom = /^\/api\/sites\/probe\/([A-Za-z0-9_-]{8,64})\/dom$/.exec(path);
      if (dom && req.method === 'POST') {
        if (!can(Scope.PUBLISH)) return json(res, 403, { ok: false, error: 'publish scope required' });
        const p = probes.get(dom[1]);
        if (!p || p.targetName !== client.name || p.status !== 'pending') return json(res, 404, { ok: false, error: 'probe not found' });
        const b = await body(MAX_DOM_UPLOAD_BYTES);
        if (typeof b.html !== 'string') return json(res, 400, { ok: false, error: 'html required' });
        const result = analyzeNewSite(b.html, { url: typeof b.url === 'string' && /^https:\/\//.test(b.url) ? b.url : p.url, title: b.title });
        Object.assign(p, { status: result.ok ? 'done' : 'error', result, error: result.ok ? null : (result.report.hint || result.report.error), title: String(b.title || '').slice(0, 200) });
        log.info(`[sites] probe ${dom[1]} ${p.url}: ${result.ok ? result.report.strategy + ' messages=' + result.report.message_count : result.report.error}`);
        return json(res, 200, { ok: true });
      }
      if (!can(Scope.CONTROL)) return json(res, 403, { ok: false, error: 'control scope required' });
      if (path === '/api/admin/reset-db' && req.method === 'POST') {
        // 重置数据库：清空会话 / 消息 / 收藏 / 置顶归档 / 事件，网站列表和设置保留；随后让插件把开着的页面重新上报一遍
        const b = await body();
        if (b.confirm !== 'RESET') return json(res, 400, { ok: false, error: 'confirm required' });
        const removed = db.resetAll();
        for (const rec of onlineExtensions()) sendTo(rec, makeEnvelope(MessageType.COMMAND, { command_id: randomId('resync').slice(0, 40), action: 'resync', conversation_id: 'sites' }));
        log.info(`[admin] database reset by ${client.name}: ${JSON.stringify(removed)}`);
        return json(res, 200, { ok: true, removed });
      }
      if (path === '/api/sites/launch' && req.method === 'POST') {
        const target = onlineExtensions()[0];
        if (!target) return json(res, 409, { ok: false, error: '没有在线的浏览器插件' });
        // 一键打开：遍历默认站点（四个种类），每个站点：
        //   1) 已有关闭的会话 → 把它们全部重新打开；
        //   2) 没有已关闭会话（无数据）→ 为它新建一个（打开站点首页）；
        //   3) 该站点已有标签页开着 → 跳过，不重复打开。
        const openHosts = db.openTabHosts();
        const seeds = seedSites();
        // 已关闭会话按站点 key 分组（source 对不上时按 host 兜底）
        const closedBySite = new Map();
        for (const c of db.listConversations(500)) {
          if (c.status !== 'closed' || !c.url || !/^https:\/\//.test(c.url)) continue;
          let key = c.source;
          if (!seeds.some((s) => s.key === key)) {
            try {
              const h = new URL(c.url).hostname.replace(/^www\./, '');
              const s = seeds.find((x) => siteHosts(x).some((sh) => h === sh || h.endsWith('.' + sh)));
              key = s ? s.key : null;
            } catch { key = null; }
          }
          if (!key) continue;
          if (!closedBySite.has(key)) closedBySite.set(key, []);
          closedBySite.get(key).push(c.url);
        }
        const toOpen = [];
        let reopened = 0, created = 0;
        for (const s of seeds) {
          const hosts = siteHosts(s);
          if (hosts.some((h) => openHosts.has(h))) continue;   // 已有同站标签页，跳过
          const closed = closedBySite.get(s.key) || [];
          if (closed.length) { toOpen.push(...closed); reopened += closed.length; }
          else if (/^https:\/\//.test(s.url)) { toOpen.push(s.url); created++; }   // 无数据才新建
        }
        if (!toOpen.length) return json(res, 200, { ok: true, count: 0, reopened: 0, created: 0 });
        sendTo(target, makeEnvelope(MessageType.COMMAND, { command_id: randomId('launch').slice(0, 40), action: 'open_sites', conversation_id: 'sites', text: toOpen.join('\n').slice(0, 20000) }));
        log.info(`[sites] launch reopened=${reopened} created=${created} via ${target.clientId}`);
        return json(res, 202, { ok: true, count: toOpen.length, reopened, created });
      }
      const nc = path.match(/^\/api\/sites\/([^/]+)\/new-chat$/);
      if (nc && req.method === 'POST') {
        // 卡片“新建”：让插件在后台打开这个网站的新空白会话（不切换到该标签页）
        const site = customSites.find((x) => x.key === decodeURIComponent(nc[1]));
        if (!site) return json(res, 404, { ok: false, error: '网站列表里没有这个网站' });
        const url = typeof site.config?.new_chat_url === 'string' && /^https:\/\//.test(site.config.new_chat_url) ? site.config.new_chat_url : site.url;
        if (!/^https:\/\//.test(url || '')) return json(res, 400, { ok: false, error: '这个网站没有可用的网址' });
        const target = onlineExtensions()[0];
        if (!target) return json(res, 409, { ok: false, error: '没有在线的浏览器插件' });
        sendTo(target, makeEnvelope(MessageType.COMMAND, { command_id: randomId('newchat').slice(0, 40), action: 'new_chat', conversation_id: 'sites', text: url.slice(0, 2048) }));
        log.info(`[sites] new chat ${site.key} via ${target.clientId}`);
        return json(res, 202, { ok: true, url });
      }
      if (path === '/api/sites/probe' && req.method === 'POST') {
        const b = await body();
        let u;
        try { u = new URL(String(b.url || '')); } catch { return json(res, 400, { ok: false, error: '网址无效' }); }
        if (u.protocol !== 'https:') return json(res, 400, { ok: false, error: '只支持 https 网址' });
        const target = onlineExtensions()[0];
        if (!target) return json(res, 409, { ok: false, error: '没有在线的浏览器插件' });
        prune();
        const id = randomId('probe').slice(0, 40);
        probes.set(id, { status: 'pending', url: u.toString(), target: target.clientId, targetName: target.name, at: Date.now(), result: null, error: null });
        sendTo(target, makeEnvelope(MessageType.COMMAND, { command_id: id, action: 'probe_site', conversation_id: 'probe', text: u.toString().slice(0, 2048) }));
        return json(res, 202, { ok: true, probe_id: id });
      }
      const pr = /^\/api\/sites\/probe\/([A-Za-z0-9_-]{8,64})$/.exec(path);
      if (pr && req.method === 'GET') {
        const p = probes.get(pr[1]);
        if (!p) return json(res, 404, { ok: false, error: 'probe not found' });
        if (p.status === 'pending' && Date.now() - p.at > 90000) Object.assign(p, { status: 'error', error: '插件没有在 90 秒内返回页面' });
        const host = new URL(p.url).hostname;
        return json(res, 200, {
          ok: true, status: p.status, url: p.url, error: p.error,
          report: p.result?.report ?? null,
          suggested_name: (p.title || '').split(/[|\-–·]/)[0].trim().slice(0, 40) || host,
          exists: customSites.some((x) => siteHosts(x).includes(host.replace(/^www\./, '')))
        });
      }
      if (path === '/api/sites' && req.method === 'POST') {
        const b = await body();
        const p = probes.get(String(b.probe_id || ''));
        if (!p || p.status !== 'done' || !p.result?.ok) return json(res, 400, { ok: false, error: '没有可添加的分析结果' });
        const host = new URL(p.url).hostname;
        const same = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '');
        if (customSites.some((x) => SEED_KEYS.includes(x.key) && siteHosts(x).some((h) => same(h, host)))) return json(res, 409, { ok: false, error: '这个网站已经在列表里了，可以直接编辑它的配置' });
        const name = String(b.name || '').trim().slice(0, 40) || host;
        const site = { key: p.result.config.site, name, url: p.url, host, hosts: [], enabled: true, config: p.result.config, added_at: Date.now(), updated_at: Date.now(), seeded: true };
        customSites = [...customSites.filter((x) => x.host !== host && x.key !== site.key), site];
        saveSites();
        probes.delete(String(b.probe_id));
        notifySitesChanged();
        log.info(`[sites] added ${site.key} ${host}`);
        return json(res, 200, { ok: true, site: siteOut(site) });
      }
      if (path === '/api/sites/defaults' && req.method === 'POST') {
        const add = missingDefaults().map((x) => ({ ...x, updated_at: Date.now(), seeded: true }));
        if (add.length) { customSites = [...add, ...customSites]; saveSites(); notifySitesChanged(); }
        return json(res, 200, { ok: true, added: add.map((x) => x.key), sites: customSites.map(siteOut) });
      }
      const reset = /^\/api\/sites\/([a-z0-9_-]{1,32})\/reset$/.exec(path);
      if (reset && req.method === 'POST') {
        const site = customSites.find((x) => x.key === reset[1]);
        if (!site) return json(res, 404, { ok: false, error: 'site not found' });
        const seed = seedByKey(site.key);
        if (!seed) return json(res, 400, { ok: false, error: '这个网站没有默认配置' });
        Object.assign(site, { config: seed.config, hosts: seed.hosts, updated_at: Date.now() });
        saveSites();
        notifySitesChanged();
        return json(res, 200, { ok: true, site: siteOut(site) });
      }
      const del = /^\/api\/sites\/([a-z0-9_-]{1,32})$/.exec(path);
      if (del && req.method === 'PATCH') {
        const site = customSites.find((x) => x.key === del[1]);
        if (!site) return json(res, 404, { ok: false, error: 'site not found' });
        const b = await body(MAX_SITE_CONFIG_BYTES + 8192);
        const patch = {};
        if (b.name != null) {
          const name = String(b.name).trim().slice(0, 40);
          if (!name) return json(res, 400, { ok: false, error: '名称不能为空' });
          patch.name = name;
        }
        const others = customSites.filter((x) => x !== site);
        const taken = (h) => others.some((x) => siteHosts(x).includes(String(h).replace(/^www\./, '')));
        if (b.url != null) {
          let u;
          try { u = new URL(String(b.url).trim()); } catch { return json(res, 400, { ok: false, error: '网址无效' }); }
          if (u.protocol !== 'https:') return json(res, 400, { ok: false, error: '只支持 https 网址' });
          if (taken(u.hostname)) return json(res, 409, { ok: false, error: '另一个网站已经用了这个域名' });
          patch.url = u.toString();
          patch.host = u.hostname;
        }
        if (b.hosts != null) {
          if (!Array.isArray(b.hosts) || b.hosts.length > 10) return json(res, 400, { ok: false, error: '域名列表无效（最多 10 个）' });
          const hosts = [...new Set(b.hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean))];
          if (hosts.some((h) => !/^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h))) return json(res, 400, { ok: false, error: '域名无效（只写域名，例如 chat.example.com）' });
          if (hosts.some(taken)) return json(res, 409, { ok: false, error: '另一个网站已经用了这个域名' });
          patch.hosts = hosts;
        }
        if (b.enabled != null) {
          if (typeof b.enabled !== 'boolean') return json(res, 400, { ok: false, error: 'enabled 必须是 true / false' });
          patch.enabled = b.enabled;
        }
        if (b.config !== undefined) {
          const c = b.config;
          if (!c || typeof c !== 'object' || Array.isArray(c)) return json(res, 400, { ok: false, error: 'DOM 配置必须是 JSON 对象' });
          if (Buffer.byteLength(JSON.stringify(c)) > MAX_SITE_CONFIG_BYTES) return json(res, 413, { ok: false, error: 'DOM 配置太大' });
          if (c.message != null && (typeof c.message !== 'object' || Array.isArray(c.message))) return json(res, 400, { ok: false, error: 'config.message 必须是对象' });
          patch.config = { ...c, config_version: c.config_version || 1, site: site.key };
        }
        const behaviorChanged = ['host', 'hosts', 'enabled', 'config'].some((k) => k in patch &&
          JSON.stringify(patch[k]) !== JSON.stringify(site[k]));
        Object.assign(site, patch);
        if (behaviorChanged) site.updated_at = Date.now();
        saveSites();
        if (behaviorChanged) notifySitesChanged();
        return json(res, 200, { ok: true, site: siteOut(site) });
      }
      if (del && req.method === 'DELETE') {
        const before = customSites.length;
        customSites = customSites.filter((x) => x.key !== del[1]);
        if (customSites.length === before) return json(res, 404, { ok: false, error: 'site not found' });
        saveSites();
        notifySitesChanged();
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { ok: false, error: 'method not allowed' });
    } catch (e) {
      if (e.status) return json(res, e.status, { ok: false, error: e.message });
      throw e;
    }
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
  const ATTACH_COMMAND_TIMEOUT_MS = opts.attachCommandTimeoutMs ?? 120000;

  function sendTo(rec, msg) {
    if (!rec || rec.ws.readyState !== 1) return false;
    try { rec.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  function commandResult(commandId, ok, code, detail) {
    return makeEnvelope(MessageType.COMMAND_RESULT, {
      command_id: commandId, ok, ...(code ? { code } : {}), detail: detail == null ? null : String(detail).slice(0, 500)
    });
  }

  /** close：把这个插件里开着该会话的所有标签页 + 会话地址一起发过去（PWA 窗口里的标签页也能关掉） */
  function closeExtras(conversationId, clientId) {
    const tabIds = [...new Set(db.openTabsFor(conversationId).filter((t) => t.client_id === clientId).map((t) => t.tab_id))].slice(0, 50);
    const url = db.conversationUrl(conversationId);
    return { tab_ids: tabIds, ...(typeof url === 'string' && /^https:\/\//.test(url) ? { url: url.slice(0, 2048) } : {}) };
  }

  /** 看板（control 权限）→ 找到开着该会话的插件标签页 → 转发指令 */
  function onCommand(conn, msg) {
    if (!conn.rec.scopes.has(Scope.CONTROL)) {
      return sendError(conn, msg.id, ErrorCode.FORBIDDEN, 'token lacks control scope', false);
    }
    counters.commands_received++;
    if (['probe_site', 'sync_sites', 'open_sites', 'new_chat', 'resync'].includes(msg.action)) return reply(conn, commandResult(msg.command_id, false, 'forbidden_action', '该指令只能由后端发出'));
    let files = [];
    if (msg.action === 'reply' && Array.isArray(msg.attachments) && msg.attachments.length) {
      pruneAttachments();
      for (const x of msg.attachments) {
        const a = attachments.get(x.id);
        if (!a) return reply(conn, commandResult(msg.command_id, false, 'attachment_expired', `附件已过期，请重新选择：${x.name}`));
        files.push({ id: x.id, name: a.name, type: a.type, size: a.size, url: `/api/attachments/${x.id}` });
      }
    }
    if (msg.action === 'reply' && !msg.text?.trim() && !files.length) return reply(conn, commandResult(msg.command_id, false, 'text_required', '回复内容不能为空'));
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
    }, files.length ? ATTACH_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS);   // 带文件时页面要先上传，给更长时间
    timer.unref?.();
    pendingCommands.set(msg.command_id, { requester: conn.rec, target: target.clientId, timer });
    sendTo(target, makeEnvelope(MessageType.COMMAND, {
      command_id: msg.command_id,
      action: msg.action,
      conversation_id: msg.conversation_id,
      ...(msg.action === 'reply' && msg.text?.trim() ? { text: msg.text } : {}),
      ...(files.length ? { attachments: files } : {}),
      ...(msg.action === 'regenerate' && msg.answer_index != null ? { answer_index: msg.answer_index, answer_total: msg.answer_total } : {}),
      ...(msg.action === 'close' ? closeExtras(msg.conversation_id, target.clientId) : {}),
      tab_id: tabId,
      requested_by: conn.rec.clientId
    }));
    log.info(`[cmd] ${msg.action} conv=${msg.conversation_id} from ${conn.rec.clientId} → ${target.clientId} tab=${tabId}`);
  }

  /** 插件 → 看板：只接受被转发对象自己返回的结果 */
  function onCommandResult(conn, msg) {
    const probe = probes.get(msg.command_id);
    if (probe && probe.target === conn.rec.clientId && !msg.ok && probe.status === 'pending') {
      Object.assign(probe, { status: 'error', error: msg.detail || msg.code || '插件抓取页面失败' });
      return undefined;
    }
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
    if (ev.event_type === EventType.TABS_SNAPSHOT) {
      reconcileTabs(conn, ev.payload.tabs || []);
      // 只把“哪个标签页在哪个会话、是否是窗口当前标签页”广播给看板（用于高亮对应卡片），不带网址和标题
      const slim = { ...ev, payload: { tabs: (ev.payload.tabs || []).map((t) => ({ tab_id: t.tab_id, host: t.host, conversation_id: t.conversation_id, active: !!t.active })) } };
      return broadcastStored(conn, slim, result.seq);
    }
    broadcastStored(conn, ev, result.seq);
  }

  function broadcastStored(conn, ev, seq) {
    if (!policy.broadcast_event_types.includes(ev.event_type)) return;
    const stored = { ...ev, seq, client_id: conn.rec.clientId };
    broadcaster.broadcast(
      (rec) => toBroadcast(stored, rec, false),
      (rec) => (policy.echo_to_sender || rec.clientId !== conn.rec.clientId) && subscribedTo(rec, ev.conversation_id)
    );
  }

  /**
   * 用插件上报的“浏览器里真实开着的标签页”对账（不广播快照本身）：
   * - 后端认为开着、但快照里没有（或已换了网站 / 会话）的标签页 → 补一条 page.closed（reason: reconciled）
   * - 快照里开着某个会话、但后端认为已关闭 / 不存在 / 在别的会话 → 补一条 page.opened
   */
  function reconcileTabs(conn, snapshot, now = Date.now()) {
    const clientId = conn.rec.clientId;
    const snap = new Map(snapshot.map((t) => [t.tab_id, t]));
    const states = db.tabStatesForClient(clientId);
    const latest = new Map(states.map((s) => [s.tab_id, s]));
    const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
    const synth = (type, tabId, conversationId, payload) => {
      const ev = {
        type: MessageType.EVENT, event_id: `sync:${tabId}:${now.toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
        event_type: type, occurred_at: now, conversation_id: conversationId, tab_id: tabId, payload
      };
      try {
        const r = db.persistEvent(clientId, ev, now);
        if (!r.duplicate) { counters.events_reconciled = (counters.events_reconciled || 0) + 1; broadcastStored(conn, ev, r.seq); }
      } catch (err) { log.error('[db] reconcile persist failed', err); }
    };
    for (const s of states) {
      if (s.event_type === EventType.PAGE_CLOSED || !s.conversation_id) continue;
      const t = snap.get(s.tab_id);
      const gone = !t
        || (s.url && t.host && hostOf(s.url) && hostOf(s.url) !== t.host)
        || (t.conversation_id && t.conversation_id !== s.conversation_id);
      if (gone) synth(EventType.PAGE_CLOSED, s.tab_id, s.conversation_id, { url: s.url.slice(0, 2048), reason: 'reconciled' });
    }
    for (const t of snapshot) {
      if (!t.conversation_id) continue;
      const s = latest.get(t.tab_id);
      const known = s && s.event_type !== EventType.PAGE_CLOSED && s.conversation_id === t.conversation_id;
      if (!known) synth(EventType.PAGE_OPENED, t.tab_id, t.conversation_id, { url: (t.url || '').slice(0, 2048), title: (t.title || '').slice(0, 512) });
    }
  }

  function subscribedTo(rec, conversationId) {
    if (rec.subscriptions.has('*')) return true;
    return conversationId != null && rec.subscriptions.has(conversationId);
  }

  /** 构造广播消息；无 read_content 权限时去掉消息正文（text 和 html） */
  function toBroadcast(stored, rec, replay) {
    const canRead = rec.scopes.has(Scope.READ_CONTENT);
    let payload = stored.payload;
    let redacted = false;
    if (!canRead && (typeof payload.text === 'string' || typeof payload.html === 'string')) {
      const { text, html, ...rest } = payload;
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

function readBody(req, limit, raw = false) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c); // 超限后继续读完但丢弃，以便返回 413
    });
    req.on('end', () => {
      if (size > limit) { const err = new Error('too large'); err.code = 'TOO_LARGE'; return reject(err); }
      const buf = Buffer.concat(chunks);
      resolve(raw ? buf : buf.toString('utf8'));
    });
    req.on('error', reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}
