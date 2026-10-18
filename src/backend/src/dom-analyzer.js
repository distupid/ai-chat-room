/**
 * 对话页面 DOM 分析器：输入插件上传的页面 HTML，输出统一的 DomConfig v1（格式见 src/frontend/lib/dom-observer.js 的 DEFAULT_CONFIG）。
 *
 * 分析步骤：
 *   1. 依次评估已知结构（旧版 data-message-author-role、新版 data-chatgpt-search-unit-key 等）
 *   2. 已知结构都找不到“用户 + 助手”两种消息时，做通用发现：
 *      扫描所有元素的属性，找取值以 user / assistant 结尾的属性名，生成 [attr$="user"],[attr$="assistant"] 选择器
 *   3. 在选中的消息节点上找消息 ID（UUID 样式的属性，节点自身优先，其次后代节点）
 *   4. 为用户/助手分别挑选正文选择器（覆盖率 ≥ 80% 且有文字），避开按钮文字
 *   5. 生成“正在生成”选择器：内置候选 + 当前页面上实际存在的停止按钮（如果抓取时正在生成）
 *
 * 只输出选择器/属性名/正则字符串，不含可执行代码。
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findSite, SEED_KEYS } from './site-seeds.js';

// 插件的观察器脚本：duck.ai / hark.com 等默认网站直接用其种子配置在页面上试运行来验证
const OBSERVER_SRC = readFileSync(fileURLToPath(new URL('../../frontend/lib/dom-observer.js', import.meta.url)), 'utf8');

/** 网址属于哪个默认网站（按默认种子的域名匹配）；不是默认网站返回 null（走通用分析） */
function siteOfUrl(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  return findSite(host)?.key ?? null;
}

/** 新网站的站点标识：取主域名（kimi.moonshot.cn → moonshot），避开内置站点名 */
export function siteKeyForHost(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  let key = (parts.length >= 2 ? parts[parts.length - 2] : parts[0] || 'site').replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'site';
  if ([...SEED_KEYS, 'openai', 'duck', 'unknown', 'other', 'defaults', 'launch', 'probe'].includes(key)) key += '2';
  return key;
}

const USER_TOKEN = /(^|[-_])(user|human|query|question|prompt|request)(s)?([-_]|$)/i;
const ASSIST_TOKEN = /(^|[-_])(assistant|bot|ai|answer|response|reply|model|agent)(s)?([-_]|$)/i;
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_-]{0,80}$/;

/** 新网站：属性值或 class 名里带 user / assistant 一类词的元素 → 角色规则 */
function discoverRoleRules(doc) {
  const attrs = new Map();   // name → { user: Map(value→n), assistant: Map }
  const classes = { user: new Map(), assistant: new Map() };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const el of doc.body ? doc.body.querySelectorAll('*') : []) {
    if (/^(BUTTON|SCRIPT|STYLE|INPUT|TEXTAREA|SVG)$/i.test(el.tagName)) continue;
    if (!(el.textContent || '').trim()) continue;
    for (const a of el.attributes) {
      if (!/^(data-[\w-]+|role|aria-label)$/.test(a.name) || a.name === 'data-testid' && false) continue;
      const v = a.value.trim();
      if (!v || v.length > 60) continue;
      const rec = attrs.get(a.name) || { user: new Map(), assistant: new Map() };
      if (USER_TOKEN.test(v)) bump(rec.user, v); else if (ASSIST_TOKEN.test(v)) bump(rec.assistant, v);
      attrs.set(a.name, rec);
    }
    for (const c of el.classList) {
      if (!SAFE_IDENT.test(c)) continue;
      if (USER_TOKEN.test(c)) bump(classes.user, c); else if (ASSIST_TOKEN.test(c)) bump(classes.assistant, c);
    }
  }
  const top = (m) => [...m.entries()].sort((x, y) => y[1] - x[1])[0];
  const out = [];
  for (const [name, rec] of attrs) {
    const u = top(rec.user), a = top(rec.assistant);
    if (u && a) out.push({ score: u[1] + a[1] + 100, user: `[${name}="${u[0].replace(/"/g, '\\"')}"]`, assistant: `[${name}="${a[0].replace(/"/g, '\\"')}"]`, name: `attr:${name}` });
  }
  const u = top(classes.user), a = top(classes.assistant);
  if (u && a) out.push({ score: u[1] + a[1], user: `.${u[0]}`, assistant: `.${a[0]}`, name: 'class' });
  return out.sort((x, y) => y.score - x.score);
}

/** 会话 ID：URL 路径最后一个像 ID 的片段 */
function conversationFromUrl(url, key) {
  let path = '';
  try { path = new URL(url).pathname; } catch { /* ignore */ }
  const segs = path.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/^[A-Za-z0-9_-]{8,128}$/.test(segs[i]) && /\d/.test(segs[i])) {
      const prefix = segs.slice(0, i).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
      return { url_pattern: `${prefix ? '/' + prefix : ''}/([A-Za-z0-9_-]{8,128})(?:[/?#]|$)`, dom: null, fallback_id: 'main', fallback_path: null, prefix: `${key}-` };
    }
  }
  return { url_pattern: null, dom: null, fallback_id: 'main', fallback_path: null, prefix: `${key}-` };
}

function composerFor(doc) {
  if (doc.querySelector('textarea')) return 'textarea';
  if (doc.querySelector('[contenteditable="true"]')) return '[contenteditable="true"]';
  return 'textarea, [contenteditable="true"]';
}

/** 用观察器在页面上试运行一份配置，返回识别出的消息 */
function tryConfig(clean, url, site, config) {
  const dom = new JSDOM(clean, { url, runScripts: 'outside-only' });
  const win = dom.window;
  try {
    win.eval(OBSERVER_SRC);
    const events = [];
    const obs = win.ChatGPTBridgeObserver.createChatGPTObserver({ document: win.document, window: win, site, config, emit: (e) => events.push(e), pollMs: 1e9 });
    obs.start();
    obs.stop('analyze');
    return {
      msgs: events.filter((e) => e.event_type === 'message.added').map((e) => e.payload),
      conversation_id: events.find((e) => e.conversation_id)?.conversation_id ?? null
    };
  } catch { return { msgs: [], conversation_id: null }; } finally { win.close(); }
}

/**
 * 新网站（不在内置适配里）：先按通用结构分析，再试 class / 属性里的角色词；
 * 每份候选都用观察器在页面上实际跑一遍，取识别出“用户 + 助手”消息最多的那份。
 */
export function analyzeNewSite(html, meta = {}) {
  const warnings = [];
  if (typeof html !== 'string' || !html.trim()) return { ok: false, config: null, report: { error: 'empty html', warnings } };
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) return { ok: false, config: null, report: { error: 'html too large', warnings } };
  let host = '';
  try { host = new URL(meta.url).hostname; } catch { return { ok: false, config: null, report: { error: 'invalid url', warnings } }; }
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const key = meta.site || siteKeyForHost(host);
  const doc = new JSDOM(clean, { url: meta.url }).window.document;
  const common = {
    config_version: DOM_CONFIG_VERSION,
    source: 'analyzer',
    site: key,
    generated_at: new Date(meta.now ? meta.now() : Date.now()).toISOString(),
    page: { url: String(meta.url).slice(0, 2048), build: null },
    conversation: conversationFromUrl(meta.url, key),
    status: { model_selector: '', exclude_messages: true, check_interval_ms: 2000 },
    actions: {
      composer: composerFor(doc),
      send_button: 'button[type="submit"], button[aria-label*="Send"], button[aria-label*="send"], button[aria-label*="发送"], button[data-testid*="send"]',
      regenerate_button: ''
    }
  };
  const generic = { exclude: 'button, svg, [aria-hidden="true"], .sr-only, [role="toolbar"]' };
  const candidates = [];
  const base = analyzeDom(clean, {});   // 通用结构（data-*-role 等）
  if (base.ok) candidates.push({ strategy: base.config.strategy, config: { ...common, message: base.config.message, text: { ...base.config.text, ...generic }, generating: base.config.generating } });
  for (const r of discoverRoleRules(doc).slice(0, 6)) {
    candidates.push({
      strategy: `role-rules:${r.name}`,
      config: {
        ...common,
        message: { selector: `${r.user}, ${r.assistant}`, role_sources: [], role_rules: [{ selector: r.user, role: 'user', scope: 'self' }, { selector: r.assistant, role: 'assistant', scope: 'self' }], id_attrs: ['data-message-id', 'data-id', 'id'], id_inner: null },
        text: { user: '', assistant: '', ...generic },
        generating: { selector: 'button[aria-label*="Stop"], button[aria-label*="stop"], button[aria-label*="停止"], [data-testid*="stop"]', activity_idle_ms: 1500 }
      }
    });
  }
  let best = null;
  for (const c of candidates) {
    const run = tryConfig(clean, meta.url, key, c.config);
    const roles = {};
    for (const m of run.msgs) roles[m.role] = (roles[m.role] || 0) + 1;
    const score = (roles.user ? 1000 : 0) + (roles.assistant ? 1000 : 0) + run.msgs.length;
    if (run.msgs.length && (!best || score > best.score)) best = { ...c, ...run, roles, score };
  }
  if (!best) {
    return { ok: false, config: null, report: { error: 'no conversation messages found', hint: '请填写一个已经有对话消息的会话网址（需要在这个浏览器里登录过）', url: meta.url, site: key, warnings } };
  }
  if (!best.roles.user || !best.roles.assistant) warnings.push('只找到了一种角色的消息，配置可能不完整');
  if (!best.conversation_id) warnings.push('没有从网址识别出会话 ID');
  const config = { ...best.config, strategy: best.strategy };
  return {
    ok: true,
    config,
    report: {
      strategy: best.strategy,
      site: key,
      host,
      conversation_id: best.conversation_id,
      message_count: best.msgs.length,
      roles: best.roles,
      composer: config.actions.composer,
      samples: best.msgs.slice(-6).map((m) => ({ role: m.role, id: m.message_id, text: m.text.slice(0, 80) })),
      warnings
    }
  };
}

/** 非 ChatGPT 站点：用观察器的内置适配跑一遍，能识别出消息就返回该适配（附识别报告） */
function analyzeWithSiteProfile(clean, meta, site) {
  const dom = new JSDOM(clean, { url: meta.url, runScripts: 'outside-only' });
  const win = dom.window;
  try {
    win.eval(OBSERVER_SRC);
    const O = win.ChatGPTBridgeObserver;
    const events = [];
    const obs = O.createChatGPTObserver({ document: win.document, window: win, site, emit: (e) => events.push(e), pollMs: 1e9 });
    obs.start();
    obs.stop('analyze');
    const msgs = events.filter((e) => e.event_type === 'message.added').map((e) => e.payload);
    const status = events.find((e) => e.event_type === 'conversation.status');
    if (!msgs.length) {
      return { ok: false, config: null, report: { error: 'no conversation messages found', hint: '请在打开了一段有消息的对话页面上分析', url: meta.url, site, warnings: [] } };
    }
    const roles = {};
    for (const m of msgs) roles[m.role] = (roles[m.role] || 0) + 1;
    const warnings = [];
    if (!roles.user || !roles.assistant) warnings.push('只找到了一种角色的消息，配置可能不完整');
    const config = {
      ...JSON.parse(JSON.stringify(O.SITE_PROFILES[site])),
      source: 'analyzer',
      site,
      generated_at: new Date(meta.now ? meta.now() : Date.now()).toISOString(),
      strategy: `site-profile:${site}`,
      page: { url: String(meta.url).slice(0, 2048), build: null }
    };
    return {
      ok: true,
      config,
      report: {
        strategy: config.strategy,
        site,
        conversation_id: events[0]?.conversation_id ?? null,
        message_count: msgs.length,
        roles,
        model: status?.payload?.model ?? null,
        samples: msgs.slice(-6).map((m) => ({ role: m.role, id: m.message_id, text: m.text.slice(0, 60) })),
        warnings
      }
    };
  } finally {
    win.close();
  }
}

export const DOM_CONFIG_VERSION = 1;
const ROLES = ['user', 'assistant', 'system', 'tool'];
const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_HTML_BYTES = 16 * 1024 * 1024;

const KNOWN_STRUCTURES = [
  {
    name: 'legacy-author-role',
    selector: '[data-message-author-role]',
    role_sources: [{ attr: 'data-message-author-role' }]
  },
  {
    name: 'search-unit-key-2026',
    selector: '[data-chatgpt-search-unit-key]',
    role_sources: [{ attr: 'data-chatgpt-search-unit-key', pattern: ':(user|assistant|system|tool)$' }]
  },
  {
    name: 'turn-attr',
    selector: '[data-turn="user"], [data-turn="assistant"]',
    role_sources: [{ attr: 'data-turn' }]
  }
];

const TEXT_CANDIDATES = {
  user: [
    '[data-user-message-bubble] .whitespace-pre-wrap',
    '[data-user-message-bubble]',
    '.whitespace-pre-wrap',
    '[data-message-content]'
  ],
  assistant: [
    '[data-dil-message-id]',
    '.markdown',
    '[data-message-content]',
    '.prose'
  ]
};

const BASE_GENERATING = [
  '[data-testid="stop-button"]',
  'form[data-chatgpt-composer] button[aria-label*="停止"]',
  'form[data-chatgpt-composer] button[aria-label*="Stop"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop streaming"]',
  '.result-streaming'
];

// 通用发现时忽略的属性（取值不可能是角色，或数量巨大没有意义）
const SKIP_ATTRS = new Set(['class', 'style', 'href', 'src', 'd', 'viewBox', 'width', 'height', 'fill', 'xmlns', 'dir', 'id']);

function cssEscapeAttrValue(v) { return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function textOf(el) {
  return (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function roleFrom(el, sources) {
  for (const s of sources) {
    const v = el.getAttribute(s.attr);
    if (!v) continue;
    if (!s.pattern) return v;
    const m = new RegExp(s.pattern).exec(v);
    if (m) return m[1] || m[0];
  }
  return null;
}

/** 只保留最外层匹配节点（与 dom-observer 的去嵌套规则一致） */
function outermost(doc, selector) {
  const all = [...doc.querySelectorAll(selector)];
  return all.filter((el) => !(el.parentElement && el.parentElement.closest(selector)));
}

function evaluate(doc, structure) {
  let nodes;
  try { nodes = outermost(doc, structure.selector); } catch { return null; }
  const roles = {};
  for (const el of nodes) {
    const r = roleFrom(el, structure.role_sources);
    const key = ROLES.includes(r) ? r : 'unknown';
    roles[key] = (roles[key] || 0) + 1;
  }
  const both = (roles.user || 0) > 0 && (roles.assistant || 0) > 0;
  const known = nodes.length - (roles.unknown || 0);
  return { ...structure, nodes, roles, score: (both ? 1000 : 0) + known - (roles.unknown || 0) * 2 };
}

/** 通用发现：找取值以角色结尾的属性名 */
function discoverRoleAttr(doc) {
  const stats = new Map();
  const re = /(?:^|[^a-z])(user|assistant)$/i;
  for (const el of doc.body ? doc.body.querySelectorAll('*') : []) {
    for (const a of el.attributes) {
      if (SKIP_ATTRS.has(a.name) || a.name.startsWith('aria-') || a.value.length > 200) continue;
      const m = re.exec(a.value);
      if (!m) continue;
      const s = stats.get(a.name) || { user: 0, assistant: 0 };
      s[m[1].toLowerCase()]++;
      stats.set(a.name, s);
    }
  }
  const cands = [...stats.entries()]
    .filter(([, s]) => s.user > 0 && s.assistant > 0)
    .map(([attr, s]) => {
      const exact = doc.querySelector(`[${attr}="user"], [${attr}="assistant"]`) != null;
      return {
        name: `discovered:${attr}`,
        selector: `[${attr}$="user"], [${attr}$="assistant"]`,
        role_sources: [exact ? { attr } : { attr, pattern: '(user|assistant|system|tool)$' }],
        min: Math.min(s.user, s.assistant)
      };
    })
    .sort((a, b) => b.min - a.min);
  return cands;
}

function discoverIds(nodes) {
  // 统计每个属性在多少个消息节点上出现、出现了多少个不同取值。
  // 取值必须基本互不相同（会话 ID 这类所有消息都一样的属性会被排除）。
  const own = new Map();
  const inner = new Map();
  const add = (m, name, value) => {
    const s = m.get(name) || { count: 0, values: new Set() };
    s.count++; s.values.add(value.trim().split(/\s+/)[0]);
    m.set(name, s);
  };
  for (const el of nodes) {
    for (const a of el.attributes) if (UUIDISH.test(a.value)) add(own, a.name, a.value);
    const seen = new Set();
    for (const d of el.querySelectorAll('*')) {
      for (const a of d.attributes) {
        if (seen.has(a.name) || a.name === 'href' || !UUIDISH.test(a.value)) continue;
        seen.add(a.name);
        add(inner, a.name, a.value);
      }
    }
  }
  const rank = (m, minCount) => [...m.entries()]
    .filter(([, s]) => s.count >= minCount && s.values.size >= Math.max(1, s.count * 0.8))
    .sort((a, b) => (b[1].values.size - a[1].values.size) || (/message/.test(b[0]) - /message/.test(a[0])))
    .map(([k]) => k);
  const idAttrs = rank(own, Math.max(1, nodes.length * 0.5)).slice(0, 3);
  const bestInner = rank(inner, Math.max(1, nodes.length * 0.3))[0];
  const idInner = bestInner ? { selector: `[${bestInner}]`, attr: bestInner } : null;
  const summarize = (m) => Object.fromEntries([...m.entries()].map(([k, s]) => [k, { nodes: s.count, distinct: s.values.size }]));
  return { idAttrs, idInner, coverage: { own: summarize(own), inner: summarize(inner) } };
}

function pickText(nodes, candidates) {
  if (!nodes.length) return { selector: '', coverage: 0 };
  for (const sel of candidates) {
    let hit = 0;
    for (const el of nodes) {
      const b = el.querySelector(sel);
      if (b && textOf(b)) hit++;
    }
    const coverage = hit / nodes.length;
    if (coverage >= 0.8) return { selector: sel, coverage };
  }
  return { selector: '', coverage: 1 };
}

function findStopButton(doc) {
  const btns = [...doc.querySelectorAll('button')];
  for (const b of btns) {
    const label = b.getAttribute('aria-label') || '';
    const testid = b.getAttribute('data-testid') || '';
    if (/停止|stop/i.test(label) && !/停靠/.test(label)) return `button[aria-label="${cssEscapeAttrValue(label)}"]`;
    if (/stop/i.test(testid)) return `button[data-testid="${cssEscapeAttrValue(testid)}"]`;
  }
  return null;
}

/**
 * @param {string} html  页面 HTML（插件已去掉 script/style/svg）
 * @param {{url?: string, title?: string, now?: () => number}} [meta]
 * @returns {{ ok: boolean, config: object|null, report: object }}
 */
export function analyzeDom(html, meta = {}) {
  const warnings = [];
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, config: null, report: { error: 'empty html', warnings } };
  }
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
    return { ok: false, config: null, report: { error: 'html too large', warnings } };
  }
  // 不执行脚本；额外再去一遍 script，防止插件端漏删
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const site = siteOfUrl(meta.url);
  // ChatGPT 页面结构多变，走通用分析（已知结构 + 自动发现）；其他默认网站用种子配置在页面上试运行验证
  if (site && site !== 'chatgpt') return analyzeWithSiteProfile(clean, meta, site);
  const dom = new JSDOM(clean, { url: 'https://chatgpt.com/' });
  const doc = dom.window.document;

  try {
    const evaluated = KNOWN_STRUCTURES.map((s) => evaluate(doc, s)).filter(Boolean);
    let best = evaluated.sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 1000) {
      for (const cand of discoverRoleAttr(doc)) {
        const ev = evaluate(doc, cand);
        if (ev && (!best || ev.score > best.score)) best = ev;
        if (best && best.score >= 1000) break;
      }
    }

    if (!best || best.nodes.length === 0) {
      return {
        ok: false, config: null,
        report: {
          error: 'no conversation messages found',
          hint: '请在打开了一段有消息的对话页面上分析',
          url: meta.url || null,
          warnings
        }
      };
    }
    if (best.score < 1000) warnings.push('只找到了一种角色的消息，配置可能不完整');

    const ids = discoverIds(best.nodes);
    if (!ids.idAttrs.length && !ids.idInner) warnings.push('没有找到消息 ID，将使用“角色+位置”作为回退键');

    const byRole = (r) => best.nodes.filter((el) => roleFrom(el, best.role_sources) === r);
    const userNodes = byRole('user');
    const asstNodes = byRole('assistant');
    const userText = pickText(userNodes, TEXT_CANDIDATES.user);
    const asstText = pickText(asstNodes, TEXT_CANDIDATES.assistant);

    const stop = findStopButton(doc);
    const generating = stop && !BASE_GENERATING.includes(stop) ? [stop, ...BASE_GENERATING] : BASE_GENERATING;

    const config = {
      config_version: DOM_CONFIG_VERSION,
      source: 'analyzer',
      generated_at: new Date(meta.now ? meta.now() : Date.now()).toISOString(),
      strategy: best.name,
      page: {
        url: meta.url ? String(meta.url).slice(0, 2048) : null,
        build: doc.documentElement.getAttribute('data-build') || null
      },
      message: {
        selector: best.selector,
        role_sources: best.role_sources,
        id_attrs: ids.idAttrs,
        id_inner: ids.idInner
      },
      text: { user: userText.selector, assistant: asstText.selector },
      generating: { selector: generating.join(','), activity_idle_ms: 1500 }
    };

    const id = (el) => {
      for (const a of ids.idAttrs) { const v = (el.getAttribute(a) || '').trim(); if (v) return v.split(/\s+/)[0]; }
      if (ids.idInner) { const d = el.querySelector(ids.idInner.selector); if (d) return d.getAttribute(ids.idInner.attr); }
      return null;
    };
    const sample = (el, role) => {
      const sel = role === 'user' ? userText.selector : asstText.selector;
      const body = sel ? el.querySelector(sel) : null;
      return { role, id: id(el), text: textOf(body || el).slice(0, 60) };
    };

    return {
      ok: true,
      config,
      report: {
        strategy: best.name,
        message_count: best.nodes.length,
        roles: best.roles,
        id_coverage: ids.coverage,
        text_coverage: { user: userText.coverage, assistant: asstText.coverage },
        generating_now: !!stop,
        samples: best.nodes.slice(-6).map((el) => sample(el, roleFrom(el, best.role_sources))),
        warnings
      }
    };
  } finally {
    dom.window.close();
  }
}
