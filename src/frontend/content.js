/* 内容脚本（网站列表里的网站，由后台按列表动态注册）：启动 DOM 观察器，把事件交给后台 Service Worker。
 * - 站点配置：按域名从 chrome.storage.local.siteList（后台从后端同步的网站列表）里选；还没有列表时用默认种子。
 *   网站被停用 / 不在列表里时不观察。
 * - 页面事件只发送 kind: 'page_event'；内容脚本不接收任何后端消息，ack / error / broadcast 不会被当作页面事件重新上报。
 * - 网站配置在看板上修改后（siteList 变化）立即 setConfig 生效。
 * - 只响应本插件发来的消息：page_info（后台对账）、get_observer_config、bridge_command（看板指令）。 */
(function () {
  'use strict';
  if (window.__chatgptBridgeStarted) return;
  window.__chatgptBridgeStarted = true;

  var observer = null;

  function createObserver() {
    observer = ChatGPTBridgeObserver.createChatGPTObserver({
      document: document,
      window: window,
      site: SITE,
      baseConfig: SITE_ENTRY && SITE_ENTRY.config ? SITE_ENTRY.config : undefined,
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

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id || !msg) return;
    if (msg.kind === 'page_info') {
      // 后台对账用：这个标签页当前在哪个会话；顺带带上选择器健康度（命中数 + 配置警告），供诊断站点改版
      if (!observer) { sendResponse({ ok: false, code: 'not_observing' }); return; }
      sendResponse({ ok: true, conversation_id: observer.getConversationId(), url: location.href,
        selector_health: observer.getSelectorHealth ? observer.getSelectorHealth() : null });
    } else if (msg.kind === 'resync') {
      if (observer) observer.resync();
      sendResponse({ ok: !!observer });
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
      }, msg.command || {}).then(function (r) {
        if (r && r.code === 'limit_reached' && observer.setSendBlocked) observer.setSendBlocked(true);
        sendResponse(r);
      }, function (e) {
        sendResponse({ ok: false, code: 'exception', detail: String(e && e.message || e) });
      });
      return true;
    }
  });

  // 站点：按域名在 siteList（后端网站列表）里找；没有列表时用默认种子
  var SITE = null;
  var SITE_ENTRY = null;
  function resolveSite(s) {
    var list = s && Array.isArray(s.siteList) ? s.siteList : null;
    SITE_ENTRY = ChatGPTBridgeObserver.findSite(location.hostname, list);
    SITE = SITE_ENTRY ? String(SITE_ENTRY.key) : null;
    return !!SITE_ENTRY && SITE_ENTRY.enabled !== false;
  }
  var KEYS = ['siteList'];
  function apply(s) {
    var enabled = resolveSite(s);
    if (!enabled) {
      if (observer) { observer.stop('manual'); observer = null; console.info('[chatgpt-bridge] site disabled or removed:', location.hostname); }
      return;
    }
    if (!observer) { createObserver(); return; }
    var warnings = observer.setConfig(null, SITE_ENTRY.config || null);
    console.info('[chatgpt-bridge] dom config applied:', SITE, (SITE_ENTRY.config && SITE_ENTRY.config.source) || 'default', warnings);
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.siteList) return;
    chrome.storage.local.get(KEYS).then(apply);
  });

  try {
    chrome.storage.local.get(KEYS).then(apply, function () { apply({}); });
  } catch (e) {
    apply({});
  }
})();
