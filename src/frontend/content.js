/* 内容脚本（chatgpt.com / duck.ai / hark.com）：启动 DOM 观察器，把事件交给后台 Service Worker。
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
      var base = ChatGPTBridgeObserver.SITE_PROFILES[SITE];
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

  // 每个站点一份配置：domConfigs[site]；ChatGPT 兼容旧的 domConfig
  var SITE = ChatGPTBridgeObserver.siteForHost(location.hostname);
  function configFrom(s) {
    s = s || {};
    var map = s.domConfigs && typeof s.domConfigs === 'object' ? s.domConfigs : {};
    if (map[SITE]) return map[SITE];
    return SITE === 'chatgpt' ? (s.domConfig || null) : null;
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !observer || !(changes.domConfigs || (SITE === 'chatgpt' && changes.domConfig))) return;
    chrome.storage.local.get(['domConfigs', 'domConfig']).then(function (s) {
      var next = configFrom(s);
      var warnings = observer.setConfig(next);
      console.info('[chatgpt-bridge] dom config applied:', SITE, (next && next.source) || 'builtin', warnings);
    });
  });

  try {
    chrome.storage.local.get(['domConfigs', 'domConfig']).then(
      function (s) { createObserver(configFrom(s)); },
      function () { createObserver(null); }
    );
  } catch (e) {
    createObserver(null);
  }
})();
