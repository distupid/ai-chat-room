/* 内容脚本（网站列表里的网站，由后台按列表动态注册）：启动 DOM 观察器，把事件交给后台 Service Worker。
 * - 站点配置：按域名从 chrome.storage.local.siteList（后台从后端同步的网站列表）里选；还没有列表时用默认种子。
 *   网站被停用 / 不在列表里时不观察。
 * - 页面事件只发送 kind: 'page_event'；内容脚本不接收任何后端消息，ack / error / broadcast 不会被当作页面事件重新上报。
 * - DOM 配置：启动时从 chrome.storage.local.domConfig 读取；配置变化（弹窗“分析当前页面”）时立即 setConfig 生效。
 * - 只响应本插件发来的 capture_dom 请求：返回去掉 script/style/svg 等的页面 HTML，供后端分析。 */
(function () {
  'use strict';
  if (window.__chatgptBridgeStarted) return;
  window.__chatgptBridgeStarted = true;

  var observer = null;

  function createObserver(config) {
    observer = ChatGPTBridgeObserver.createChatGPTObserver({
      document: document,
      window: window,
      site: SITE,
      baseConfig: SITE_ENTRY && SITE_ENTRY.config ? SITE_ENTRY.config : undefined,
      config: config || undefined,
      emit: function (event) {
        try {
          var p = chrome.runtime.sendMessage({ kind: 'page_event', event: event });
          if (p && typeof p.catch === 'function') p.catch(function () { /* SW 正在重启，后台会从队列恢复 */ });
        } catch (e) { /* 插件被重新加载，旧内容脚本失效 */ }
      }
    });
    var cfg = observer.getConfig();
    console.info('[chatgpt-bridge] observer started, dom config =', cfg.source, cfg.warnings.length ? cfg.warnings : '');
    observer.start();
    // 启动 3 秒后打印一次诊断，不用切换 Console 上下文也能看到识别结果
    setTimeout(function () { logDiag('startup'); }, 3000);
  }

  function logDiag(tag) {
    try {
      var c = observer.getConfig();
      var sel = c.config && c.config.message && c.config.message.selector;
      var base = SITE_ENTRY && SITE_ENTRY.config;
      sel = sel || (base && base.message && base.message.selector) || '';
      var nodes = sel ? document.querySelectorAll(sel) : [];
      var ids = [];
      for (var i = 0; i < nodes.length && i < 6; i++) ids.push(nodes[i].getAttribute('data-testid') || nodes[i].id || nodes[i].tagName);
      console.info('[chatgpt-bridge] diag(' + tag + ')', {
        host: location.hostname, site: SITE, source: c.source,
        conversation: observer.getConversationId(),
        messageSelector: sel, messages: nodes.length, sample: ids,
        generating: observer.isGenerating(), warnings: c.warnings
      });
    } catch (e) { console.warn('[chatgpt-bridge] diag failed', e); }
  }

  function captureDom() {
    var root = document.documentElement.cloneNode(true);
    var drop = root.querySelectorAll('script, style, noscript, link, svg, iframe, template, img, video, canvas');
    for (var i = 0; i < drop.length; i++) drop[i].remove();
    return {
      html: '<!DOCTYPE html>\n' + root.outerHTML,
      url: location.href,
      title: document.title
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id || !msg) return;
    if (msg.kind === 'capture_dom') {
      try { sendResponse({ ok: true, page: captureDom() }); }
      catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
    } else if (msg.kind === 'page_info') {
      // 后台对账用：这个标签页当前在哪个会话
      if (!observer) { sendResponse({ ok: false, code: 'not_observing' }); return; }
      sendResponse({ ok: true, conversation_id: observer.getConversationId(), url: location.href });
    } else if (msg.kind === 'bridge_diag') {
      logDiag('manual'); sendResponse({ ok: true });
    } else if (msg.kind === 'get_observer_config') {
      sendResponse({ ok: true, config: observer ? observer.getConfig() : null });
    } else if (msg.kind === 'bridge_command') {
      // 看板指令（快速回复 / 重新回答），异步执行后回复
      if (!observer || typeof ChatGPTBridgeActions === 'undefined') {
        sendResponse({ ok: false, code: 'not_ready', detail: '内容脚本尚未就绪' });
        return;
      }
      ChatGPTBridgeActions.execute({
        document: document,
        window: window,
        config: observer.getConfig().config,
        actions: observer.getConfig().actions,
        isGenerating: function () { return observer.isGenerating(); },
        conversationId: function () { return observer.getConversationId(); }
      }, msg.command || {}).then(sendResponse, function (e) {
        sendResponse({ ok: false, code: 'exception', detail: String(e && e.message || e) });
      });
      return true;
    }
  });

  // 站点：按域名在 siteList（后端网站列表）里找；没有列表时用默认种子
  // 覆盖配置：domConfigs[site]（弹窗“分析当前页面”的结果）；ChatGPT 兼容旧的 domConfig
  var SITE = null;
  var SITE_ENTRY = null;
  function resolveSite(s) {
    var list = s && Array.isArray(s.siteList) ? s.siteList : null;
    SITE_ENTRY = ChatGPTBridgeObserver.findSite(location.hostname, list);
    SITE = SITE_ENTRY ? String(SITE_ENTRY.key) : null;
    return !!SITE_ENTRY && SITE_ENTRY.enabled !== false;
  }
  function configFrom(s) {
    s = s || {};
    var map = s.domConfigs && typeof s.domConfigs === 'object' ? s.domConfigs : {};
    if (SITE && map[SITE]) return map[SITE];
    return SITE === 'chatgpt' ? (s.domConfig || null) : null;
  }
  var KEYS = ['siteList', 'domConfigs', 'domConfig'];
  function apply(s) {
    var enabled = resolveSite(s);
    if (!enabled) {
      if (observer) { observer.stop('manual'); observer = null; console.info('[chatgpt-bridge] site disabled or removed:', location.hostname); }
      return;
    }
    var next = configFrom(s);
    if (!observer) { createObserver(next); return; }
    var warnings = observer.setConfig(next, SITE_ENTRY.config || null);
    console.info('[chatgpt-bridge] dom config applied:', SITE, (next && next.source) || (SITE_ENTRY.config && SITE_ENTRY.config.source) || 'default', warnings);
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !(changes.siteList || changes.domConfigs || changes.domConfig)) return;
    chrome.storage.local.get(KEYS).then(apply);
  });

  try {
    chrome.storage.local.get(KEYS).then(apply, function () { apply({}); });
  } catch (e) {
    apply({});
  }
})();
