/*
 * ChatGPT 页面 DOM 观察器（经典脚本，作为 content script 注入；测试中在 jsdom 里执行）。
 *
 * 通过 MutationObserver + 轮询兜底观察真实 DOM 变化，产出业务事件：
 *   page.opened / page.closed / conversation.changed
 *   message.added / message.updated
 *   generation.started / generation.finished
 *
 * event_id 规则（与后端 UNIQUE 去重配合）：
 *   - message.added   = hash(类型, 会话, 消息键)          → 页面刷新后重新观察到同一条消息，event_id 不变，不会重复广播
 *   - message.updated = hash(类型, 会话, 消息键, 内容哈希) → 同一内容只上报一次
 *   - 页面级事件（opened/closed/conversation.changed/generation.*）带上 loadId + 序号，
 *     每次真实发生都是新事件，不会被误判为重复
 * payload 字段必须与 shared/protocol.js 的 EVENT_PAYLOAD_SCHEMAS 一致，否则后台会拒收。
 */
(function (global) {
  'use strict';

  /*
   * DOM 配置（DomConfig v1）。与后端 POST /api/dom-config/analyze 返回的 config 同一格式，
   * 插件从网站列表（chrome.storage.local.siteList）按域名选出，列表变化时内容脚本调用 observer.setConfig() 立即生效。
   * 只包含选择器/属性名/正则字符串，不含任何可执行代码。
   */
  var DEFAULT_CONFIG = {
    config_version: 1,
    source: 'default:chatgpt',
    site: 'chatgpt',
    // 会话 ID：先按 url_pattern（第 1 个捕获组）从 URL 取；取不到再按 dom 从页面元素取；再取不到用 fallback_id
    conversation: {
      url_pattern: '/c/([A-Za-z0-9-]{8,128})(?:[/?#]|$)',
      dom: null,
      fallback_id: null,
      fallback_path: null,
      prefix: ''
    },
    message: {
      // 两代结构都支持：旧版 data-message-author-role；新版（2026-10 实测）data-chatgpt-search-unit-key
      selector: '[data-message-author-role], [data-chatgpt-search-unit-key]',
      // 依次尝试，取第一个能得到角色的来源；pattern 的第 1 个捕获组是角色，省略则属性值本身就是角色
      role_sources: [
        { attr: 'data-message-author-role' },
        { attr: 'data-chatgpt-search-unit-key', pattern: ':(user|assistant|system|tool)$' }
      ],
      // 依次尝试，取属性值中第一个空白分隔的 token
      id_attrs: ['data-message-id', 'data-chatgpt-search-message-ids'],
      // 节点本身没有 ID 时，从第一个匹配的后代节点读取
      id_inner: { selector: '[data-dil-message-id]', attr: 'data-dil-message-id' }
    },
    // 消息正文（避开“复制/编辑”等按钮）；为空字符串 = 使用整个消息节点
    text: {
      user: '[data-user-message-bubble] .whitespace-pre-wrap, [data-user-message-bubble]',
      assistant: '[data-dil-message-id], .markdown',
      // 正文中要去掉的部分：代码块工具栏（“复制代码 / 启用自动换行”）、按钮、读屏专用文字
      exclude: '[data-markdown-copy="exclude"], button, .sr-only'
    },
    generating: {
      selector:
        '[data-testid="stop-button"],' +
        'form[data-chatgpt-composer] button[aria-label*="停止"],' +
        'form[data-chatgpt-composer] button[aria-label*="Stop"],' +
        'button[aria-label="Stop generating"],' +
        'button[aria-label="Stop streaming"],' +
        '.result-streaming',
      // 没有显式生成标志时：助手文本在这段时间内有变化就算“正在生成”；0 = 关闭活动检测
      activity_idle_ms: 1500
    },
    /*
     * 会话状态（conversation.status）：在“消息正文以外”的页面文字中匹配提示语。
     * 正文（text.user / text.assistant 命中的节点）、输入框、脚本都会被跳过，所以对话内容里出现“限额”不会误报。
     * 正则不区分大小写。注意不要匹配页脚“ChatGPT 可能会出错”这类常驻文字。
     */
    status: {
      // 会话在源站被删除 / 不存在（只在页面上没有任何消息时才判定）
      deleted_patterns: [
        'unable to load conversation',
        'conversation not found',
        'this conversation (?:has been|was) deleted',
        '(?:conversation|chat) (?:does not|doesn(?:\'|\u2019)t) exist',
        '\u627e\u4e0d\u5230(?:\u8be5|\u8fd9\u4e2a)?(?:\u5bf9\u8bdd|\u4f1a\u8bdd|\u804a\u5929)',
        '\u65e0\u6cd5\u52a0\u8f7d(?:\u8be5|\u8fd9\u4e2a)?(?:\u5bf9\u8bdd|\u4f1a\u8bdd)',
        '(?:\u5bf9\u8bdd|\u4f1a\u8bdd)(?:\u5df2\u88ab|\u5df2)?\u5220\u9664',
        '(?:\u5bf9\u8bdd|\u4f1a\u8bdd)\u4e0d\u5b58\u5728'
      ],
      error_patterns: [
        'something went wrong',
        'an error occurred',
        'there was an error generating',
        'network error',
        '\u51fa\u9519\u4e86',
        '\u51fa\u73b0(?:\u4e86)?(?:\u4e00\u4e2a)?\u9519\u8bef',
        '\u751f\u6210[^\u3002]{0,8}\u65f6\u51fa\u9519',
        '\u7f51\u7edc\u9519\u8bef'
      ],
      model_selector: '[data-testid="model-switcher-dropdown-button"]',
      // true = 检测时跳过整个消息节点（而不只是正文）
      exclude_messages: false,
      // 状态检查最多每隔这么久做一次（需要遍历页面文字）
      check_interval_ms: 1000
    },
    // 看板指令用到的页面元素（见 page-actions.js）；regenerate_button 为空 = 该站点不支持重新回答
    actions: {
      composer: 'form[data-chatgpt-composer] [contenteditable="true"], #prompt-textarea, form textarea',
      send_button: '[data-testid="send-button"], form[data-chatgpt-composer] button[aria-label*="发送"], button[aria-label*="Send"]',
      regenerate_button: 'button[aria-label="重新生成回复"], button[aria-label*="重新生成"], button[aria-label*="Regenerate"], [data-testid="regenerate-turn-action-button"]',
      regenerate_menu_item: '[role="menuitem"]',
      regenerate_menu_text: '重试|再试一次|重新生成|Try again|Regenerate|Retry'
    }
  };

  /*
   * 其他站点的默认适配（2026-10 按真实页面编写）。字段与 DomConfig 相同。
   * 只作为“默认种子”：后端第一次启动时写进网站列表，之后和看板添加的网站一样可编辑 / 停用 / 删除；
   * 插件只在还没拿到网站列表（例如第一次离线启动）时才直接用这里的种子。
   */
  var SITE_PROFILES = {
    chatgpt: DEFAULT_CONFIG,

    // duck.ai：URL 里没有会话 ID，从助手消息元素的 id（<会话uuid>-assistant-message-<n>-<m>）取
    duckai: {
      config_version: 1,
      source: 'default:duckai',
      site: 'duckai',
      conversation: {
        url_pattern: null,
        dom: { selector: '[id*="-assistant-message-"]:not([id^="heading-"])', attr: 'id', pattern: '^([0-9A-Fa-f-]{36})-assistant-message' },
        fallback_id: null,
        fallback_path: null,
        prefix: 'duck-'
      },
      message: {
        selector: '[data-testid="user-message"], [id*="-assistant-message-"]:not([id^="heading-"])',
        role_sources: [],
        role_rules: [
          { selector: '[data-testid="user-message"]', role: 'user', scope: 'self' },
          { selector: '[id*="-assistant-message-"]', role: 'assistant', scope: 'self' }
        ],
        id_attrs: ['id'],
        id_inner: null
      },
      text: {
        user: '',
        assistant: '',
        exclude: 'h3[data-response-heading], h3[style*="clip"], [id^="heading-"], [data-message-actions], ' +
          '[data-streamdown="code-block-header"], [data-streamdown="code-block-actions"], button, [aria-hidden="true"]'
      },
      generating: {
        selector: 'button[aria-label="停止生成"]:not([disabled]), button[aria-label="Stop generating"]:not([disabled])',
        activity_idle_ms: 1500
      },
      status: {
        model_selector: '[id^="heading-"] > div > span, [data-testid="model-picker-button"]',
        exclude_messages: true,
        check_interval_ms: 1000
      },
      actions: {
        composer: 'textarea[name="user-prompt"], form[data-chat-footer] textarea',
        send_button: 'form[data-chat-footer] button[type="submit"]',
        regenerate_button: ''
      }
    },

    // hark.com：/chat 是一条长对话；/projects/<id> 是项目对话。角色没有属性标记：
    // 文件卡片看 data-align（end=用户），助手正文是 Markdown（含 <p>）、卡片（data-artifact-card），其余为用户
    hark: {
      config_version: 1,
      source: 'default:hark',
      site: 'hark',
      conversation: {
        url_pattern: '/projects/([A-Za-z0-9_-]{4,100})',
        dom: null,
        fallback_id: 'main',
        fallback_path: '^/chat(?:[/?#]|$)',
        prefix: 'hark-'
      },
      message: {
        selector: '[data-entry-kind="message"][data-message-id]',
        role_sources: [],
        role_rules: [
          { selector: '[data-align="end"]', role: 'user' },
          { selector: '[data-align="start"]', role: 'assistant' },
          { selector: '[data-artifact-card]', role: 'assistant' },
          { selector: '[data-testid="message-bubble"] [data-testid="message-text"] p, [data-testid="message-bubble"] [data-testid="message-text"] .whitespace-normal', role: 'assistant' },
          { selector: '[data-testid="message-bubble"] [data-testid="message-text"]', role: 'user' }
        ],
        id_attrs: ['data-message-id'],
        id_inner: null
      },
      text: {
        user: '[data-testid="message-bubble"] [data-testid="message-text"], [data-align]',
        assistant: '[data-testid="message-bubble"] [data-testid="message-text"], [data-artifact-card], [data-align]',
        exclude: '[aria-hidden="true"], time, [data-reply-parent], [data-testid="card-disclosure"], button[aria-label="折叠"]'
      },
      generating: { selector: '', activity_idle_ms: 2000 },
      status: { error_patterns: [], model_selector: '', exclude_messages: true, check_interval_ms: 2000 },
      actions: {
        composer: 'textarea[data-testid="chat-input"]',
        send_button: 'button[data-testid="send-button"]',
        regenerate_button: ''
      }
    }
  };

  /*
   * 默认网站种子（后端网站列表的初始内容；“恢复默认”也用它）。
   * host：主域名；hosts：同一网站的其他域名（都按“本域名或其子域名”匹配，www. 忽略）。
   */
  var SEED_SITES = [
    { key: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', host: 'chatgpt.com', hosts: ['chatgpt.com', 'chat.openai.com'], enabled: true, config: DEFAULT_CONFIG },
    { key: 'duckai', name: 'Duck.ai', url: 'https://duck.ai/', host: 'duck.ai', hosts: ['duck.ai'], enabled: true, config: SITE_PROFILES.duckai },
    { key: 'hark', name: 'Hark', url: 'https://www.hark.com/chat', host: 'www.hark.com', hosts: ['hark.com'], enabled: true, config: SITE_PROFILES.hark }
  ];

  function normHost(h) { return String(h || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, ''); }

  /** 网站的全部域名（去掉 www.、去重） */
  function siteHosts(site) {
    var out = [];
    var list = [site && site.host].concat(site && Array.isArray(site.hosts) ? site.hosts : []);
    for (var i = 0; i < list.length; i++) {
      var h = normHost(list[i]);
      if (h && /^[a-z0-9.-]+$/.test(h) && out.indexOf(h) < 0) out.push(h);
    }
    return out;
  }

  /**
   * 按域名在网站列表里找网站（本域名或其子域名，匹配最长的那个）；list 省略 = 默认种子。
   * 返回网站条目（含 key / config / enabled）或 null。
   */
  function findSite(host, list) {
    host = normHost(host);
    if (!host) return null;
    var sites = Array.isArray(list) ? list : SEED_SITES;
    var best = null, bestLen = -1;
    for (var i = 0; i < sites.length; i++) {
      var hs = siteHosts(sites[i]);
      for (var j = 0; j < hs.length; j++) {
        var h = hs[j];
        if ((host === h || host.slice(-(h.length + 1)) === '.' + h) && h.length > bestLen) { best = sites[i]; bestLen = h.length; }
      }
    }
    return best;
  }

  function seedByKey(key) {
    for (var i = 0; i < SEED_SITES.length; i++) if (SEED_SITES[i].key === key) return SEED_SITES[i];
    return null;
  }

  /** 按域名选择站点标识（list 省略 = 默认种子）；找不到返回 null */
  function siteForHost(host, list) {
    var s = findSite(host, list);
    return s ? s.key : null;
  }

  function str(v, max) { return typeof v === 'string' && v.length <= (max || 2000) ? v : null; }

  function validSelector(doc, sel) {
    if (!sel) return false;
    try { doc.querySelector(sel); return true; } catch (_) { return false; }
  }

  /**
   * 把外部配置规整为内部使用的结构；任何字段无效都回退到内置默认值，并记录 warnings。
   */
  function resolveConfig(cfg, doc, base) {
    var d = base && typeof base === 'object' ? base : DEFAULT_CONFIG;
    var warnings = [];
    cfg = cfg && typeof cfg === 'object' ? cfg : {};
    function sec(o, k) { return o && o[k] && typeof o[k] === 'object' ? o[k] : {}; }
    var dm = sec(d, 'message'), dt = sec(d, 'text'), dg = sec(d, 'generating'), ds = sec(d, 'status');
    var dc = sec(d, 'conversation'), da = sec(d, 'actions');
    var D = DEFAULT_CONFIG;
    var m = cfg.message && typeof cfg.message === 'object' ? cfg.message : {};
    var t = cfg.text && typeof cfg.text === 'object' ? cfg.text : {};
    var g = cfg.generating && typeof cfg.generating === 'object' ? cfg.generating : {};

    function pickSel(v, dv, name, allowEmpty) {
      if (v === '' && allowEmpty) return '';
      var sv = str(v);
      if (sv == null) return dv;
      if (validSelector(doc, sv)) return sv;
      warnings.push('invalid selector for ' + name + ', using default');
      return dv;
    }

    var roleSources = [];
    var rs = Array.isArray(m.role_sources) ? m.role_sources : (Array.isArray(dm.role_sources) ? dm.role_sources : D.message.role_sources);
    for (var i = 0; i < rs.length && i < 8; i++) {
      var attr = str(rs[i] && rs[i].attr, 200);
      if (!attr) continue;
      var re = null;
      if (rs[i].pattern != null) {
        try { re = new RegExp(String(rs[i].pattern).slice(0, 200)); }
        catch (_) { warnings.push('invalid role pattern for ' + attr); continue; }
      }
      roleSources.push({ attr: attr, re: re });
    }
    // 选择器规则：节点本身匹配（scope=self）或包含匹配的后代 → 该角色；在 role_sources 之后依次尝试
    var roleRules = [];
    var rr = Array.isArray(m.role_rules) ? m.role_rules : (Array.isArray(dm.role_rules) ? dm.role_rules : []);
    for (var ri = 0; ri < rr.length && ri < 16; ri++) {
      var rsel = str(rr[ri] && rr[ri].selector);
      var rrole = str(rr[ri] && rr[ri].role, 20);
      if (!rsel || !rrole || !validSelector(doc, rsel)) { warnings.push('invalid role rule #' + ri); continue; }
      roleRules.push({ selector: rsel, role: rrole, self: rr[ri].scope === 'self' });
    }
    if (!roleSources.length && !roleRules.length) roleSources = resolveConfig(D, doc).roleSources;

    var idAttrs = (Array.isArray(m.id_attrs) ? m.id_attrs : (Array.isArray(dm.id_attrs) ? dm.id_attrs : D.message.id_attrs))
      .map(function (a) { return str(a, 200); }).filter(Boolean).slice(0, 8);
    var inner = m.id_inner === null ? null : (m.id_inner && typeof m.id_inner === 'object' ? m.id_inner : ('id_inner' in dm ? dm.id_inner : D.message.id_inner));
    var idInner = inner && str(inner.attr, 200) && validSelector(doc, str(inner.selector))
      ? { selector: inner.selector, attr: inner.attr } : null;

    var idle = Number(g.activity_idle_ms);
    var st = cfg.status && typeof cfg.status === 'object' ? cfg.status : {};
    var cv = cfg.conversation && typeof cfg.conversation === 'object' ? cfg.conversation : {};
    function pickRe(v, dv, name) {
      var src = v === undefined ? dv : v;
      if (src == null || src === '') return null;
      try { return new RegExp(String(src).slice(0, 300)); } catch (_) {
        warnings.push('invalid regex for ' + name);
        try { return dv ? new RegExp(dv) : null; } catch (_2) { return null; }
      }
    }
    var convDomSrc = cv.dom === undefined ? dc.dom : cv.dom;
    var convDom = null;
    if (convDomSrc && typeof convDomSrc === 'object' && validSelector(doc, str(convDomSrc.selector)) && str(convDomSrc.attr, 200)) {
      convDom = { selector: convDomSrc.selector, attr: convDomSrc.attr, re: pickRe(convDomSrc.pattern, null, 'conversation.dom.pattern') };
    }
    var actions = {};
    var ca = cfg.actions && typeof cfg.actions === 'object' ? cfg.actions : {};
    ['composer', 'send_button', 'regenerate_button', 'regenerate_menu_item', 'regenerate_menu_text'].forEach(function (k) {
      var v = typeof ca[k] === 'string' ? ca[k] : (typeof da[k] === 'string' ? da[k] : D.actions[k]);
      actions[k] = String(v).slice(0, 2000);
    });
    function patterns(list, dflt, name) {
      var src = Array.isArray(list) ? list : dflt;
      var out = [];
      for (var k = 0; k < src.length && k < 32; k++) {
        var ps = str(src[k], 300);
        if (!ps) continue;
        try { out.push(new RegExp(ps, 'i')); } catch (_) { warnings.push('invalid ' + name + ' pattern: ' + ps.slice(0, 40)); }
      }
      return out;
    }
    var interval = Number(st.check_interval_ms);
    return {
      raw: cfg,
      source: str(cfg.source, 100) || (Object.keys(cfg).length ? 'custom' : (str(d.source, 100) || 'builtin')),
      site: str(cfg.site, 40) || str(d.site, 40) || 'chatgpt',
      convUrlRe: pickRe(cv.url_pattern, dc.url_pattern, 'conversation.url_pattern'),
      convDom: convDom,
      convFallback: str(cv.fallback_id === undefined ? dc.fallback_id : cv.fallback_id, 100),
      convFallbackPath: pickRe(cv.fallback_path, dc.fallback_path, 'conversation.fallback_path'),
      convPrefix: str(cv.prefix === undefined ? dc.prefix : cv.prefix, 20) || '',
      messageSelector: pickSel(m.selector, dm.selector || D.message.selector, 'message.selector'),
      roleSources: roleSources,
      roleRules: roleRules,
      idAttrs: idAttrs,
      idInner: idInner,
      userText: pickSel(t.user, 'user' in dt ? dt.user : D.text.user, 'text.user', true),
      assistantText: pickSel(t.assistant, 'assistant' in dt ? dt.assistant : D.text.assistant, 'text.assistant', true),
      textExclude: pickSel(t.exclude, 'exclude' in dt ? dt.exclude : D.text.exclude, 'text.exclude', true),
      generating: pickSel(g.selector, 'selector' in dg ? dg.selector : D.generating.selector, 'generating.selector', true),
      activityIdleMs: isFinite(idle) && idle >= 0 && idle <= 60000 ? idle
        : (dg.activity_idle_ms != null ? dg.activity_idle_ms : D.generating.activity_idle_ms),
      deletedPatterns: patterns(st.deleted_patterns, Array.isArray(ds.deleted_patterns) ? ds.deleted_patterns : D.status.deleted_patterns, 'status.deleted'),
      errorPatterns: patterns(st.error_patterns, Array.isArray(ds.error_patterns) ? ds.error_patterns : D.status.error_patterns, 'status.error'),
      modelSelector: pickSel(st.model_selector, 'model_selector' in ds ? ds.model_selector : D.status.model_selector, 'status.model_selector', true),
      statusExcludeMessages: typeof st.exclude_messages === 'boolean' ? st.exclude_messages : !!ds.exclude_messages,
      statusIntervalMs: isFinite(interval) && interval >= 100 && interval <= 60000 ? interval
        : (ds.check_interval_ms || D.status.check_interval_ms),
      actions: actions,
      warnings: warnings
    };
  }

  var MAX_TEXT = 60000;
  var DEFAULT_DEBOUNCE_MS = 200;
  var DEFAULT_THROTTLE_MS = 800;
  var DEFAULT_POLL_MS = 1000;
  // 生成（流式输出）期间：每 100ms 扫描一次，同一条消息的 message.updated 最多每 100ms 一条
  var DEFAULT_STREAM_THROTTLE_MS = 100;
  var DEFAULT_STREAM_POLL_MS = 100;

  function fnv1a64(str) {
    var h1 = 0x811c9dc5 | 0;
    var h2 = 0xcbf29ce4 | 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 7);
    }
    return ('0000000' + (h1 >>> 0).toString(16)).slice(-8) +
      ('0000000' + (h2 >>> 0).toString(16)).slice(-8);
  }

  // 与 shared/protocol.js 的 stableEventId 算法一致（测试中校验）
  function stableEventId(type, conversationId, discriminator) {
    return type.replace(/[^a-z]/g, '').slice(0, 6) + ':' +
      fnv1a64(type + '|' + (conversationId == null ? '' : conversationId) + '|' +
        String(discriminator == null ? '' : discriminator));
  }

  function conversationIdFromUrl(href) {
    var m = /\/c\/([A-Za-z0-9-]{8,128})(?:[/?#]|$)/.exec(href || '');
    return m ? m[1] : null;
  }

  /** 按站点配置得到会话 ID：URL → 页面元素 → 固定 ID（加站点前缀，避免不同站点撞号） */
  function conversationIdFor(href, doc, c) {
    var id = null;
    if (c.convUrlRe) {
      var m = c.convUrlRe.exec(href || '');
      if (m) id = m[1] || m[0];
    }
    if (!id && c.convDom && doc) {
      var el = doc.querySelector(c.convDom.selector);
      var v = el && (el.getAttribute(c.convDom.attr) || '').trim();
      if (v) {
        if (c.convDom.re) { var dm = c.convDom.re.exec(v); id = dm ? (dm[1] || dm[0]) : null; } else id = v;
      }
    }
    if (!id && c.convFallback) {
      var path = '';
      try { path = new URL(href).pathname; } catch (_) { path = ''; }
      if (!c.convFallbackPath || c.convFallbackPath.test(path)) id = c.convFallback;
    }
    if (!id) return null;
    id = String(id).replace(/[^A-Za-z0-9_-]/g, '');
    return id ? (c.convPrefix + id).slice(0, 128) : null;
  }

  function roleOf(el, c) {
    for (var i = 0; i < c.roleSources.length; i++) {
      var src = c.roleSources[i];
      var v = el.getAttribute(src.attr);
      if (!v) continue;
      if (!src.re) return v;
      var m = src.re.exec(v);
      if (m) return m[1] || m[0];
    }
    var rules = c.roleRules || [];
    for (var j = 0; j < rules.length; j++) {
      var r = rules[j];
      if ((el.matches && el.matches(r.selector)) || (!r.self && el.querySelector && el.querySelector(r.selector))) return r.role;
    }
    return null;
  }

  function rawMessageIdOf(el, c) {
    for (var i = 0; i < c.idAttrs.length; i++) {
      var v = (el.getAttribute(c.idAttrs[i]) || '').trim();
      if (v) return v.split(/\s+/)[0];
    }
    if (c.idInner && el.querySelector) {
      var inner = el.querySelector(c.idInner.selector);
      var iv = inner && (inner.getAttribute(c.idInner.attr) || '').trim();
      if (iv) return iv.split(/\s+/)[0];
    }
    return null;
  }

  function normalizeRole(role) {
    return ['user', 'assistant', 'system', 'tool'].indexOf(role) >= 0 ? role : 'unknown';
  }

  function rawText(el) {
    var text = (typeof el.innerText === 'string' && el.innerText) ? el.innerText : (el.textContent || '');
    return text.replace(/\u00a0/g, ' ').trim();
  }

  var BLOCK_TAGS = {
    P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, PRE: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, TABLE: 1, TR: 1,
    BLOCKQUOTE: 1, SECTION: 1, ARTICLE: 1, HR: 1, FIGURE: 1, HEADER: 1, FOOTER: 1, DL: 1, DT: 1, DD: 1
  };
  var SKIP_TEXT_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, svg: 1, BUTTON: 0 };

  /** 取文字并跳过 exclude 命中的子树；块级元素之间换行，代码块保留原样 */
  function extractText(root, exclude) {
    if (!exclude) return rawText(root);
    var out = [];
    (function walk(node) {
      if (node.nodeType === 3) { out.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (SKIP_TEXT_TAGS[tag]) return;
      if (node !== root && node.matches && node.matches(exclude)) return;
      if (tag === 'BR') { out.push('\n'); return; }
      // 图片 → ![alt](url)；下载 / 文件链接 → [文字](url "download")：看板按原样式显示
      if (tag === 'IMG') {
        var src = node.currentSrc || node.src || node.getAttribute('src') || '';
        if (/^https?:\/\//i.test(src) && !(node.width && node.width < 32 && node.height && node.height < 32)) {
          out.push('\n\n![' + String(node.getAttribute('alt') || '').replace(/[\[\]\n]/g, ' ').trim() + '](' + src.replace(/[\s)]/g, encodeURIComponent) + ')\n\n');
        }
        return;
      }
      if (tag === 'A' && isDownloadLink(node)) {
        var label = (node.textContent || '').replace(/\s+/g, ' ').replace(/[\[\]]/g, '').trim() || '下载文件';
        out.push('[' + label + '](' + node.href.replace(/[\s)]/g, encodeURIComponent) + ' "download")');
        return;
      }
      var block = BLOCK_TAGS[tag];
      if (block) out.push('\n');
      else if (tag === 'TD' || tag === 'TH') out.push('\t');
      // 代码高亮器（duck.ai 的 shiki）把每行放进一个 <span>、行间没有换行符：按行补换行
      var lineSpans = tag === 'CODE' && (node.textContent || '').indexOf('\n') < 0 && node.children.length > 1;
      for (var ch = node.firstChild; ch; ch = ch.nextSibling) {
        walk(ch);
        if (lineSpans && ch.nodeType === 1) out.push('\n');
      }
      if (block) out.push('\n');
    })(root);
    return out.join('')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  var FILE_EXT_RE = /\.(pdf|zip|rar|7z|tar|gz|csv|xlsx?|docx?|pptx?|txt|json|md|png|jpe?g|gif|webp|svg|mp3|mp4|wav|mov|py|js|ts|html?)(?:[?#]|$)/i;
  /** 纯文本里的下载链接：只认 http(s) 网址（规则同 isFileLink） */
  function isDownloadLink(a) {
    var href = a.href || '';
    return /^https?:\/\//i.test(href) && isFileLink(a, href);
  }

  /*
   * 富文本：把消息正文转成净化后的 HTML（与 text 同一个节点、同样的 exclude 规则）。
   * 逐个节点重建字符串，不复制页面上的任何属性 / 事件，只输出白名单：
   *   p br h1-h6 ul ol li blockquote pre code(language-*) table thead tbody tfoot tr th td
   *   strong em b i del s sup sub a[href http(s)/data/blob] img[src http(s)/data:image] hr
   * span / div 等其他元素只保留内容（div 只有行内内容时变成 <p>）；script / style / iframe / form / button / svg 等整个丢掉。
   * 文件：带 download 或文件扩展名的链接输出 <a data-file="文件名">；没有网址的文件卡片（按钮 / 元素文字就是文件名）输出 <span data-file="文件名">。
   */
  var MAX_HTML = 200000;
  var HTML_KEEP = {
    P: 'p', BR: 'br', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6', UL: 'ul', OL: 'ol', LI: 'li',
    BLOCKQUOTE: 'blockquote', TABLE: 'table', THEAD: 'thead', TBODY: 'tbody', TFOOT: 'tfoot', TR: 'tr', TH: 'th', TD: 'td',
    STRONG: 'strong', EM: 'em', B: 'b', I: 'i', DEL: 'del', S: 's', SUP: 'sup', SUB: 'sub', HR: 'hr', CODE: 'code'
  };
  var HTML_VOID = { br: 1, hr: 1 };
  var HTML_DROP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, svg: 1, IFRAME: 1, FRAME: 1, OBJECT: 1, EMBED: 1, FORM: 1,
    INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1, SOURCE: 1, LINK: 1, META: 1, MATH: 1, math: 1, DIALOG: 1
  };
  var FILE_NAME_RE = /^[^\s\\/:*?"<>|]{1,120}\.[A-Za-z0-9]{1,8}$/;
  var BLOCK_CHILD_SEL = 'p, div, ul, ol, li, pre, table, blockquote, h1, h2, h3, h4, h5, h6, hr, section, article, figure';

  function escHtml(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function safeHref(u) {
    u = String(u || '').trim();
    return /^(https?:|blob:)/i.test(u) || /^data:/i.test(u) ? u.slice(0, 8000) : null;
  }
  function safeImgSrc(u) {
    u = String(u || '').trim();
    if (/^https?:\/\//i.test(u)) return u.slice(0, 8000);
    if (/^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(u)) return u.replace(/\s+/g, '');
    return null;
  }
  function langOf(code, root) {
    var cls = String(code && code.getAttribute && code.getAttribute('class') || '');
    var m = /(?:^|\s)(?:language|lang)-([A-Za-z0-9+#._-]{1,30})/.exec(cls);
    if (m) return m[1].toLowerCase();
    var holder = code && code.closest ? code.closest('[data-language]') : null;
    if (holder && root && root.contains(holder)) {
      var dl = String(holder.getAttribute('data-language') || '').trim();
      if (/^[A-Za-z0-9+#._-]{1,30}$/.test(dl)) return dl.toLowerCase();
    }
    return '';
  }
  function fileNameOfUrl(href) {
    try {
      var seg = decodeURIComponent(new URL(href).pathname.split('/').pop() || '');
      return FILE_NAME_RE.test(seg) ? seg : '';
    } catch (_) { return ''; }
  }
  function isFileLink(a, href) {
    if (a.hasAttribute('download')) return true;
    if (/^(data|blob):/i.test(href)) return true;
    var path = '';
    try { path = new URL(href).pathname; } catch (_) { return false; }
    return FILE_EXT_RE.test(path) || /\/(download|files?)\//i.test(path);
  }

  /** 代码块文字：跳过 exclude（代码块工具栏），高亮器“每行一个 span、没有换行符”时按行补换行 */
  function codeText(node, exclude, root) {
    var out = [];
    (function walk(n) {
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1 || HTML_DROP[n.tagName] || SKIP_TEXT_TAGS[n.tagName]) return;
      if (n !== root && exclude && n.matches && n.matches(exclude)) return;
      if (n.tagName === 'BR') { out.push('\n'); return; }
      var lineSpans = n.tagName === 'CODE' && (n.textContent || '').indexOf('\n') < 0 && n.children.length > 1;
      for (var ch = n.firstChild; ch; ch = ch.nextSibling) {
        walk(ch);
        if (lineSpans && ch.nodeType === 1) out.push('\n');
      }
    })(node);
    return out.join('').replace(/\u00a0/g, ' ').replace(/\n+$/, '');
  }

  function extractHtml(root, exclude) {
    var out = [];
    function skip(n) { return n !== root && exclude && n.matches && n.matches(exclude); }
    function hasBlockChild(n) {
      for (var ch = n.firstElementChild; ch; ch = ch.nextElementSibling) {
        if (HTML_DROP[ch.tagName] || skip(ch)) continue;
        if (ch.matches && ch.matches(BLOCK_CHILD_SEL)) return true;
        if (hasBlockChild(ch)) return true;
      }
      return false;
    }
    function children(n) { for (var ch = n.firstChild; ch; ch = ch.nextSibling) walk(ch); }
    function walk(n) {
      if (n.nodeType === 3) {
        var t = n.nodeValue.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
        if (t) out.push(escHtml(t));
        return;
      }
      if (n.nodeType !== 1) return;
      var tag = n.tagName;
      if (HTML_DROP[tag] || SKIP_TEXT_TAGS[tag] || skip(n)) return;
      // 代码块：整块取文字，带语言
      if (tag === 'PRE' || (tag === 'CODE' && n.parentElement && n.parentElement.tagName === 'PRE')) {
        var code = tag === 'PRE' ? (n.querySelector('code') || n) : n;
        var lang = langOf(code, root);
        out.push('<pre><code' + (lang ? ' class="language-' + escHtml(lang) + '"' : '') + '>' + escHtml(codeText(n, exclude, n)) + '</code></pre>');
        return;
      }
      if (tag === 'IMG') {
        var src = safeImgSrc(n.currentSrc || n.getAttribute('src') || n.src || '');
        if (src && !(n.width && n.width < 32 && n.height && n.height < 32)) {
          out.push('<img src="' + escHtml(src) + '" alt="' + escHtml(String(n.getAttribute('alt') || '').slice(0, 300)) + '">');
        }
        return;
      }
      if (tag === 'A') {
        var href = safeHref(n.getAttribute('href') ? (n.href || n.getAttribute('href')) : '');
        if (!href) { children(n); return; }
        var label = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (isFileLink(n, href)) {
          var dl = String(n.getAttribute('download') || '').trim();
          var name = (FILE_NAME_RE.test(dl) ? dl : '') || fileNameOfUrl(href) || (FILE_NAME_RE.test(label) ? label : '') || label.slice(0, 120) || '下载文件';
          out.push('<a href="' + escHtml(href) + '" data-file="' + escHtml(name) + '"' + (n.hasAttribute('download') ? ' download="' + escHtml(FILE_NAME_RE.test(dl) ? dl : name) + '"' : '') + '>');
          children(n);
          out.push('</a>');
          return;
        }
        out.push('<a href="' + escHtml(href) + '">');
        children(n);
        out.push('</a>');
        return;
      }
      // 没有网址的文件卡片：按钮（或 role=button）的文字就是文件名
      if (tag === 'BUTTON' || (n.getAttribute && n.getAttribute('role') === 'button')) {
        var bt = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (FILE_NAME_RE.test(bt)) out.push('<span data-file="' + escHtml(bt) + '">' + escHtml(bt) + '</span>');
        return;
      }
      var keep = HTML_KEEP[tag];
      if (keep) {
        if (HTML_VOID[keep]) { out.push('<' + keep + '>'); return; }
        out.push('<' + keep + '>');
        children(n);
        out.push('</' + keep + '>');
        return;
      }
      // div 等块：只有行内内容时变成段落，否则只保留内容
      if (BLOCK_TAGS[tag] && n !== root && !hasBlockChild(n) && (n.textContent || '').trim()) {
        out.push('<p>');
        children(n);
        out.push('</p>');
        return;
      }
      children(n);
    }
    walk(root);
    return out.join('').replace(/<p>\s*<\/p>/g, '').trim();
  }

  /** 估算 JSON 编码后的 UTF-8 字节数（引号 / 反斜杠按转义后 2 字节算） */
  function jsonBytes(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 34 || c === 92) n += 2;
      else if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  // text + html 合计不超过这个字节数（整条 WebSocket 消息上限 256KB，留出信封和转义余量）
  var MAX_RICH_BYTES = 200 * 1024;

  /** 消息的富文本：只有 p / br 时与纯文本等价，不发送；超过上限时不发送（看板退回 text） */
  function getNodeHtml(el, role, c, text) {
    var sel = role === 'user' ? c.userText : role === 'assistant' ? c.assistantText : null;
    var body = sel && el.querySelector ? el.querySelector(sel) : null;
    var html;
    try { html = extractHtml(body || el, c.textExclude); } catch (_) { return null; }
    if (!html || !/<(?!\/?(?:p|br)>)[a-z]/i.test(html)) return null;
    if (html.length > MAX_HTML || jsonBytes(html) + jsonBytes(text || '') > MAX_RICH_BYTES) return null;
    return html;
  }

  // 只取正文，避免把“复制/编辑”等按钮区域算进去；找不到正文节点时退回整个消息节点
  function getNodeText(el, role, c) {
    var sel = role === 'user' ? c.userText : role === 'assistant' ? c.assistantText : null;
    var body = sel && el.querySelector ? el.querySelector(sel) : null;
    return extractText(body || el, c.textExclude);
  }

  /** 来源：网站列表（省略 = 默认种子）里匹配的网站标识；都不匹配时取主域名 */
  function sourceFromUrl(href, list) {
    var host = '';
    try { host = new URL(href).hostname; } catch (_) { return 'unknown'; }
    var key = siteForHost(host, list);
    if (key) return key;
    var parts = host.split('.');
    var name = (parts.length >= 2 ? parts[parts.length - 2] : host).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return name.slice(0, 32) || 'unknown';
  }

  var SKIP_STATUS_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, TEMPLATE: 1 };

  /**
   * 在消息正文以外的文字中检测“已到限额 / 出错”，并读取当前模型。
   * 返回 { status, detail, model }。
   */
  function detectStatus(doc, c) {
    var body = doc.body;
    var result = { status: 'ok', detail: null, model: null };
    if (c.modelSelector) {
      var mbs = doc.querySelectorAll(c.modelSelector);
      var mb = mbs.length ? mbs[mbs.length - 1] : null;   // 取最后一个（duck.ai 每条回答都标了模型）
      var mt = mb ? rawText(mb).replace(/\s+/g, ' ') : '';
      if (mt) result.model = mt.slice(0, 100);
    }
    if (!body || !doc.createTreeWalker) return result;
    var exclude = [c.userText, c.assistantText].filter(Boolean).join(', ');
    // 页面上一条消息都没有时，才检查“会话已删除 / 不存在”
    var noMessages = !!c.messageSelector && !doc.querySelector(c.messageSelector);
    // 整棵跳过消息节点 / 正文 / 输入框（长对话里正文很大，逐个文字节点检查会拖慢页面）
    var skipSel = [exclude, c.statusExcludeMessages ? c.messageSelector : '', '[contenteditable="true"], [contenteditable=""]'].filter(Boolean).join(', ');
    var walker = doc.createTreeWalker(body, 1 | 4 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          if (SKIP_STATUS_TAGS[n.tagName]) return 2;   // FILTER_REJECT：跳过整个子树
          try { if (skipSel && n.matches(skipSel)) return 2; } catch (_) { /* 选择器无效 */ }
          return 3;                                    // FILTER_SKIP：不返回元素本身，继续看子节点
        }
        return 1;
      }
    });
    var errorHit = null;
    var node;
    var visited = 0;
    while ((node = walker.nextNode()) && visited < 20000) {
      visited++;
      var t = node.nodeValue;
      if (!t || t.length < 4 || t.length > 600) continue;
      var parent = node.parentElement;
      if (!parent || SKIP_STATUS_TAGS[parent.tagName]) continue;
      var i;
      if (noMessages && c.deletedPatterns && c.deletedPatterns.length) {
        for (i = 0; i < c.deletedPatterns.length; i++) {
          if (c.deletedPatterns[i].test(t) && !parent.closest('[contenteditable="true"], [contenteditable=""]')) {
            result.status = 'deleted';
            result.detail = t.trim().slice(0, 300);
            return result;
          }
        }
      }
      var errorMatch = false;
      if (!errorHit) {
        for (i = 0; i < c.errorPatterns.length; i++) if (c.errorPatterns[i].test(t)) { errorMatch = true; break; }
      }
      if (!errorMatch) continue;
      // 过滤：对话正文、可编辑区域（输入框草稿）
      if (exclude && parent.closest(exclude)) continue;
      if (c.statusExcludeMessages && parent.closest(c.messageSelector)) continue;
      if (parent.closest('[contenteditable="true"], [contenteditable=""]')) continue;
      var block = parent.closest('p, div, section, li, [role="alert"], [role="status"]') || parent;
      var detail = rawText(block).replace(/\s+/g, ' ').slice(0, 300) || t.trim().slice(0, 300);
      errorHit = detail;
    }
    if (errorHit) { result.status = 'error'; result.detail = errorHit; }
    return result;
  }

  function randomTag() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function createChatGPTObserver(options) {
    options = options || {};

    var doc = options.document || global.document;
    var win = options.window || global.window || global;
    var emit = typeof options.emit === 'function' ? options.emit : function () {};
    var now = options.now || function () { return Date.now(); };
    var debounceMs = options.debounceMs == null ? DEFAULT_DEBOUNCE_MS : options.debounceMs;
    var throttleMs = options.updateThrottleMs == null ? DEFAULT_THROTTLE_MS : options.updateThrottleMs;
    var pollMs = options.pollMs == null ? DEFAULT_POLL_MS : options.pollMs;
    var streamThrottleMs = options.streamThrottleMs == null ? DEFAULT_STREAM_THROTTLE_MS : options.streamThrottleMs;
    var streamPollMs = options.streamPollMs == null ? DEFAULT_STREAM_POLL_MS : options.streamPollMs;
    var tickMs = Math.max(10, Math.min(pollMs, streamPollMs));
    var idleTicks = 0;
    // 站点配置：options.baseConfig（插件从网站列表里按域名选出的配置）→ 默认种子（按 options.site 或域名）→ 通用默认
    // options.config 是叠加在上面的覆盖配置（测试 / 调试用），可省略
    var seed = options.site ? seedByKey(options.site) : findSite(win.location && win.location.hostname);
    var base = options.baseConfig && typeof options.baseConfig === 'object' ? options.baseConfig : (seed ? seed.config : DEFAULT_CONFIG);
    var site = options.site || (base && base !== DEFAULT_CONFIG && base.site) || (seed && seed.key) || sourceFromUrl(win.location && win.location.href);
    var cfg = resolveConfig(options.config, doc, base);
    if (site && !str(options.config && options.config.site, 40)) cfg.site = site;
    function convId(href) { return conversationIdFor(href, doc, cfg); }

    // 每次内容脚本加载唯一；页面级事件用它区分“这一次”与“上一次页面加载”
    var loadId = randomTag();

    var state = {
      started: false,
      maxIndex: null,                                   // 已分配的最大消息序号
      indexBase: Math.floor(Date.now() / 1000) * 1000,  // 本页面第一次分配序号的基数
      url: win.location.href,
      conversationId: null,
      messages: Object.create(null),
      generating: false,
      generationStartedAt: 0,
      generationMessageId: null,
      generationSequence: 0,
      lastAssistantChangeAt: 0,
      startSequence: 0,
      routeSequence: 0,
      statusKey: null,
      statusSequence: 0,
      lastStatusCheckAt: 0
    };

    var observer = null;
    var debounceTimer = null;
    var pollTimer = null;
    var listeners = [];
    var stats = { mutations: 0, scans: 0, extractions: 0, emitted: 0, errors: 0 };

    function safeEmit(event) {
      stats.emitted++;
      try {
        emit(event);
      } catch (error) {
        stats.errors++;
        if (options.onError) options.onError(error);
      }
    }

    function send(type, conversationId, payload, discriminator) {
      safeEmit({
        event_id: stableEventId(type, conversationId, discriminator),
        event_type: type,
        occurred_at: now(),
        conversation_id: conversationId || null,
        payload: payload || {}
      });
    }

    function addListener(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(function () { target.removeEventListener(type, handler); });
    }

    /**
     * 稳定的消息序号：已见过的消息保持原序号；新消息按它在已知消息之间的位置插入
     * （追加在后面 → 比已知最大值大；长对话向上加载的历史 → 比后面那条小）。
     * 新页面第一次扫描以当前时间为基数，保证本次看到的最新消息排在以前记录的消息之后。
     */
    var STEP = 1000;
    function assignIndexes(items) {
      var n = items.length;
      var j;
      for (j = 0; j < n; j++) { var kn = state.messages[items[j].id]; if (kn) items[j].index = kn.index; }
      j = 0;
      while (j < n) {
        if (items[j].index != null) { j++; continue; }
        var a = j;
        while (j < n && items[j].index == null) j++;
        var len = j - a;
        var prev = a > 0 ? items[a - 1].index : null;
        var next = j < n ? items[j].index : null;
        for (var q = 0; q < len; q++) {
          var idx;
          if (prev == null && next == null) {
            idx = (state.maxIndex != null ? state.maxIndex : state.indexBase - STEP) + (q + 1) * STEP;
          } else if (next == null) {
            idx = Math.max(prev, state.maxIndex != null ? state.maxIndex : prev) + (q + 1) * STEP;
          } else if (prev == null) {
            idx = Math.max(0, next - (len - q) * STEP);
          } else {
            var stepIn = (next - prev) / (len + 1);
            idx = stepIn >= 1 ? prev + Math.floor(stepIn * (q + 1)) : prev + q + 1;
          }
          items[a + q].index = idx;
        }
      }
      for (j = 0; j < n; j++) if (state.maxIndex == null || items[j].index > state.maxIndex) state.maxIndex = items[j].index;
    }

    /*
     * 消息节点 → 提取结果缓存 {role, rawId, text, html, hash}。
     * 正文提取（extractText + extractHtml + 哈希）是扫描里最贵的部分：流式输出时每 100ms 扫描一次，
     * 长对话里绝大多数消息没有变化。MutationObserver 记录到某个消息节点内部有变化时才删掉它的缓存；
     * 没有 MutationObserver 时不缓存。兜底：每 FULL_REFRESH_MS 和强制刷新（生成结束、切换配置）时全部重新提取，
     * 防止属性过滤之外的变化被漏掉。
     */
    var FULL_REFRESH_MS = 10000;
    var cache = new WeakMap();
    var lastFullAt = 0;
    function resetCache() { cache = new WeakMap(); lastFullAt = now(); }

    function extractItem(el) {
      var c = cache.get(el);
      if (c) return c;
      stats.extractions++;
      var role = normalizeRole(roleOf(el, cfg));
      var text = getNodeText(el, role, cfg);
      var html = getNodeHtml(el, role, cfg, text.slice(0, MAX_TEXT));
      c = {
        role: role,
        rawId: rawMessageIdOf(el, cfg),
        text: text,
        html: html,
        // 内容哈希含富文本：只有图片 / 格式变化（文字不变）也会上报 message.updated
        hash: html ? fnv1a64(text + '\u0000' + html) : fnv1a64(text)
      };
      if (observer) cache.set(el, c);
      return c;
    }

    function isNested(el, inResult) {
      if (!inResult) return !!(el.parentElement && el.parentElement.closest && el.parentElement.closest(cfg.messageSelector));
      for (var p = el.parentElement; p; p = p.parentElement) if (inResult.has(p)) return true;
      return false;
    }

    function scanMessages(conversationId, force, fresh) {
      if (fresh || !observer || now() - lastFullAt >= FULL_REFRESH_MS) resetCache();
      var nodes = doc.querySelectorAll(cfg.messageSelector); // querySelectorAll 结果本身不含重复节点
      var lastAssistantId = null;

      // 第一遍：收集当前渲染出来的消息（长对话里页面只渲染一部分，DOM 位置不能当作消息序号）
      var items = [];
      var seen = Object.create(null);
      // 嵌套的消息节点（两种选择器同时命中父子）只处理最外层：沿父节点查是否在本次结果里（比逐个 closest(选择器) 快）
      var inResult = typeof Set === 'function' ? new Set(nodes) : null;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (isNested(el, inResult)) continue;
        var x = extractItem(el);
        // 空节点且没有 ID：多半是正在创建的占位节点
        if (!x.rawId && !x.text) continue;
        // 键：消息 ID；缺少时回退为 角色 + 位置（不能用文本哈希，否则流式输出时每次扫描都会变成一条“新消息”）
        var key = x.rawId ? x.rawId.slice(0, 128) : 'fallback:' + x.role + ':' + i;
        // 同一条消息拆成多行（文字气泡 + 卡片共用一个 message-id）时分开记录，避免互相覆盖
        if (seen[key]) key = (key + '#' + (++seen[key])).slice(0, 128); else seen[key] = 1;
        items.push({ id: key, x: x });
      }
      assignIndexes(items);

      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        var id = it.id;
        var role = it.x.role;
        var hash = it.x.hash;
        if (role === 'assistant') lastAssistantId = id;
        var known = state.messages[id];
        if (known && known.hash === hash) continue;

        var text = it.x.text;
        var payload = {
          message_id: id,
          role: role,
          index: it.index,
          text: text.slice(0, MAX_TEXT),
          text_length: text.length,
          truncated: text.length > MAX_TEXT
        };
        if (it.x.html) payload.html = it.x.html;

        if (!known) {
          state.messages[id] = { hash: hash, lastEmit: now(), role: role, index: it.index };
          // 不带内容哈希：页面刷新后再次观察到同一条消息时 event_id 相同，后端按重复处理
          send('message.added', conversationId, payload, id);
          continue;
        }

        if (role === 'assistant') state.lastAssistantChangeAt = now();

        var elapsed = now() - known.lastEmit;
        var limit = state.generating ? streamThrottleMs : throttleMs;
        if (force || elapsed >= limit) {
          known.hash = hash;
          known.lastEmit = now();
          send('message.updated', conversationId, payload, id + '|' + hash);
        } else {
          // 不保存新 hash，下次扫描仍会发现这次未上报的变化
          schedule(Math.max(0, limit - elapsed));
        }
      }
      return lastAssistantId;
    }

    /** URL 变化，或（URL 不带会话 ID 的站点）页面上的会话标识变化 → conversation.changed */
    function checkUrl() {
      var href = win.location.href;
      var previousId = state.conversationId;
      var nextId = convId(href);
      if (href === state.url && nextId === previousId) return false;
      state.url = href;
      state.conversationId = nextId;
      if (nextId === previousId) return false;

      // 路由变了：旧会话的消息状态和生成状态都不带过去
      state.messages = Object.create(null);
      state.maxIndex = null;
      state.generating = false;
      state.generationStartedAt = 0;
      state.generationMessageId = null;
      state.lastAssistantChangeAt = 0;
      state.statusKey = null;
      state.lastStatusCheckAt = 0;
      statusDirty = true;
      resetCache();
      state.routeSequence++;

      send('conversation.changed', nextId,
        { url: href.slice(0, 2048), previous_conversation_id: previousId },
        loadId + '|' + state.routeSequence + '|' + previousId + '|' + nextId);
      return true;
    }

    // 状态检测要遍历页面文字：上次检测后页面（输入框以外）没有任何变化时跳过，最多 FULL_REFRESH_MS 强制检测一次
    var statusDirty = true;
    var lastStatusFullAt = 0;
    function checkStatus(force) {
      var t = now();
      if (!force && state.lastStatusCheckAt && t - state.lastStatusCheckAt < cfg.statusIntervalMs) return;
      if (!force && observer && !statusDirty && t - lastStatusFullAt < FULL_REFRESH_MS) return;
      state.lastStatusCheckAt = t;
      lastStatusFullAt = t;
      statusDirty = false;
      var s;
      try { s = detectStatus(doc, cfg); } catch (e) { stats.errors++; return; }
      var key = (state.conversationId || '') + '|' + s.status + '|' + (s.detail || '') + '|' + (s.model || '');
      if (key === state.statusKey) return;
      state.statusKey = key;
      state.statusSequence++;
      send('conversation.status', state.conversationId,
        { source: cfg.site || sourceFromUrl(win.location.href), status: s.status, detail: s.detail, model: s.model },
        loadId + '|status|' + state.statusSequence);
    }

    function scan(force) {
      if (!state.started) return;
      stats.scans++;

      // 路由变化时等下一次扫描，减少旧 DOM 被归到新会话的风险
      if (checkUrl()) { schedule(debounceMs); return; }

      var conversationId = state.conversationId;
      var lastAssistantId = scanMessages(conversationId, !!force);
      var explicit = !!(cfg.generating && doc.querySelector(cfg.generating));
      var active = cfg.activityIdleMs > 0 && state.lastAssistantChangeAt > 0 &&
        (now() - state.lastAssistantChangeAt) < cfg.activityIdleMs;
      var isGenerating = explicit || active;

      if (isGenerating && !state.generating) {
        state.generating = true;
        state.generationStartedAt = now();
        state.generationMessageId = lastAssistantId;
        state.generationSequence++;
        send('generation.started', conversationId,
          { message_id: lastAssistantId, generation_sequence: state.generationSequence },
          loadId + '|' + state.generationSequence);
      } else if (!isGenerating && state.generating) {
        // 结束前强制扫描一次（绕过节流），补齐最后一段流式文本
        var finalAssistantId = scanMessages(conversationId, true, true);
        state.generating = false;
        send('generation.finished', conversationId,
          {
            message_id: finalAssistantId || state.generationMessageId,
            duration_ms: Math.max(0, now() - state.generationStartedAt)
          },
          loadId + '|' + state.generationSequence);
        state.generationStartedAt = 0;
        state.generationMessageId = null;
        state.lastAssistantChangeAt = 0;
        checkStatus(true);   // 回答结束（或被限额打断）时立即检查一次状态
        return;
      }
      checkStatus(!!force);
    }

    function schedule(delay) {
      if (!state.started) return;
      // 流式输出时 DOM 每几十毫秒就变一次，若每次都重置计时器，扫描会被一直推迟到输出结束。
      // 所以已有待执行的扫描时不重置（节流而不是防抖）；只有要求更早执行时才替换。
      if (debounceTimer !== null) {
        if (delay == null || delay >= debounceMs) return;
        win.clearTimeout(debounceTimer);
      }
      debounceTimer = win.setTimeout(function () {
        debounceTimer = null;
        scan(false);
      }, Math.max(0, delay == null ? debounceMs : delay));
    }

    // 属性变化只关心可能影响识别 / 正文的属性：固定几项 + 配置里选择器 / 属性名用到的
    var BASE_ATTRS = ['data-message-id', 'data-message-author-role', 'data-testid', 'class', 'id', 'src', 'href', 'download', 'data-language', 'contenteditable'];
    function attributeFilter() {
      var out = BASE_ATTRS.slice();
      function add(a) { if (a && /^[A-Za-z_][\w.:-]*$/.test(a) && out.indexOf(a) < 0 && out.length < 64) out.push(a); }
      [cfg.messageSelector, cfg.userText, cfg.assistantText, cfg.textExclude, cfg.generating, cfg.modelSelector,
        cfg.idInner && cfg.idInner.selector, cfg.convDom && cfg.convDom.selector]
        .concat(cfg.roleRules.map(function (r) { return r.selector; }))
        .forEach(function (sel) {
          var re = /\[\s*([A-Za-z_][\w-]*)/g, m;
          while (sel && (m = re.exec(sel))) add(m[1]);
        });
      cfg.idAttrs.forEach(add);
      cfg.roleSources.forEach(function (r) { add(r.attr); });
      if (cfg.idInner) add(cfg.idInner.attr);
      if (cfg.convDom) add(cfg.convDom.attr);
      return out;
    }
    function observeRoot() {
      var root = doc.documentElement || doc.body;
      if (!observer || !root) return;
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributeFilter() });
    }

    // 输入框（看板快速回复写入 / 用户打字）里的变化与消息、状态无关，不触发扫描
    function composerSelector() {
      var sel = '[contenteditable="true"], [contenteditable=""]';
      var a = cfg.actions && cfg.actions.composer;
      return a && validSelector(doc, a) ? a + ', ' + sel : sel;
    }
    var composerSel = composerSelector();

    /** 变化所在的消息节点（含嵌套的外层）删掉缓存；全是输入框里的变化时不扫描 */
    function onMutations(records) {
      stats.mutations += records.length;
      var relevant = false;
      if (records.length > 500) { cache = new WeakMap(); relevant = true; }
      else {
        for (var i = 0; i < records.length; i++) {
          var t = records[i].target;
          var el = t && t.nodeType === 1 ? t : t && t.parentElement;
          if (!el || !el.closest) { relevant = true; continue; }
          try { if (el.closest(composerSel)) continue; } catch (_) { /* ignore */ }
          relevant = true;
          var m = el.closest(cfg.messageSelector);
          while (m) {
            cache.delete(m);
            m = m.parentElement ? m.parentElement.closest(cfg.messageSelector) : null;
          }
        }
      }
      if (!relevant) return;
      statusDirty = true;
      schedule();
    }

    function onPopState() { schedule(0); }
    function onPageHide() { stop('pagehide'); }
    function onPageShow(e) { if (e && e.persisted) start(); } // 从 bfcache 恢复时重新开始观察

    function start() {
      if (state.started) return api;
      state.started = true;
      state.startSequence++;
      state.url = win.location.href;
      state.conversationId = convId(state.url);

      send('page.opened', state.conversationId,
        { url: state.url.slice(0, 2048), title: String(doc.title || '').slice(0, 512) },
        loadId + '|' + state.startSequence);

      if (typeof win.MutationObserver === 'function') {
        observer = new win.MutationObserver(onMutations);
        observeRoot();
      }

      addListener(win, 'popstate', onPopState);
      addListener(win, 'pagehide', onPageHide);

      // 兜底：SPA 只改 URL，或状态变化没有触发预期的 DOM 变动。
      // 生成期间每个 tick（100ms）都扫描；空闲时每 pollMs 扫描一次。
      idleTicks = 0;
      pollTimer = win.setInterval(function () {
        if (win.location.href !== state.url) { schedule(0); return; }
        idleTicks += tickMs;
        if (state.generating || idleTicks >= pollMs) {
          idleTicks = 0;
          scan(false);
        }
      }, tickMs);

      // 捕捉页面加载时已存在的历史消息
      scan(true);
      return api;
    }

    function stop(reason) {
      if (!state.started) return api;
      state.started = false;
      if (observer) { observer.disconnect(); observer = null; }
      if (debounceTimer !== null) { win.clearTimeout(debounceTimer); debounceTimer = null; }
      if (pollTimer !== null) { win.clearInterval(pollTimer); pollTimer = null; }
      while (listeners.length) {
        try { listeners.pop()(); } catch (_) { /* ignore */ }
      }
      reason = reason || 'manual';
      send('page.closed', state.conversationId,
        { url: state.url.slice(0, 2048), reason: reason },
        loadId + '|' + state.startSequence + '|' + reason);
      return api;
    }

    // pageshow 监听在 stop() 之后也要保留，所以不放进 listeners
    win.addEventListener('pageshow', onPageShow);

    /** 运行时切换 DOM 配置：重置消息状态并立即重新扫描（同一条消息的 message.added event_id 不变，后端会去重） */
    function setConfig(next, nextBase) {
      if (nextBase && typeof nextBase === 'object') base = nextBase;
      cfg = resolveConfig(next, doc, base);
      if (site && !str(next && next.site, 40)) cfg.site = str(base && base.site, 40) || site;
      state.messages = Object.create(null);
      state.maxIndex = null;
      state.lastStatusCheckAt = 0;
      state.lastAssistantChangeAt = 0;
      statusDirty = true;
      composerSel = composerSelector();
      resetCache();
      if (observer) { observer.disconnect(); observeRoot(); }
      if (state.started) scan(true);
      return cfg.warnings;
    }

    var api = {
      start: start,
      stop: stop,
      setConfig: setConfig,
      getConfig: function () {
        return { source: cfg.source, site: cfg.site, warnings: cfg.warnings.slice(), config: cfg.raw, actions: cfg.actions };
      },
      /** 页面当前是否在生成（供快速回复 / 重新回答判断忙碌） */
      isGenerating: function () { return state.generating || !!(cfg.generating && doc.querySelector(cfg.generating)); },
      getConversationId: function () { return convId(win.location.href); },
      scanNow: function () { scan(true); },
      state: state,
      stats: stats
    };
    return api;
  }

  global.ChatGPTBridgeObserver = {
    createChatGPTObserver: createChatGPTObserver,
    stableEventId: stableEventId,
    fnv1a64: fnv1a64,
    conversationIdFromUrl: conversationIdFromUrl,
    conversationIdFor: conversationIdFor,
    extractText: extractText,
    extractHtml: extractHtml,
    siteForHost: siteForHost,
    findSite: findSite,
    siteHosts: siteHosts,
    SEED_SITES: SEED_SITES,
    SITE_PROFILES: SITE_PROFILES,
    resolveConfig: resolveConfig,
    detectStatus: detectStatus,
    sourceFromUrl: sourceFromUrl,
    DEFAULT_CONFIG: DEFAULT_CONFIG
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
