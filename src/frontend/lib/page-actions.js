/*
 * 页面操作（经典脚本，内容脚本中运行）：执行看板下发的指令。
 *   reply      在输入框中填入文字并发送
 *   regenerate 点击最后一条回答的“重新生成”
 * 选择器可由 DomConfig.actions 覆盖；默认值按 2026-10 实测的 ChatGPT 页面编写，同时兼容旧版。
 */
(function (global) {
  'use strict';

  var DEFAULT_ACTIONS = {
    composer: 'form[data-chatgpt-composer] [contenteditable="true"], #prompt-textarea, form textarea',
    send_button: '[data-testid="send-button"], form[data-chatgpt-composer] button[aria-label*="发送"], button[aria-label*="Send"]',
    regenerate_button: 'button[aria-label="重新生成回复"], button[aria-label*="重新生成"], button[aria-label*="Regenerate"], [data-testid="regenerate-turn-action-button"]',
    // 点“重新生成”后若弹出菜单，点其中匹配的菜单项
    regenerate_menu_item: '[role="menuitem"]',
    regenerate_menu_text: '重试|再试一次|重新生成|Try again|Regenerate|Retry'
  };

  function validSelector(doc, sel) {
    if (typeof sel !== 'string' || !sel || sel.length > 2000) return false;
    try { doc.querySelector(sel); return true; } catch (_) { return false; }
  }

  /** a = 观察器已按站点合并好的 actions（或 DomConfig 原始配置里的 actions） */
  function resolveActions(a, doc) {
    a = a && typeof a === 'object' ? a : {};
    var out = {};
    Object.keys(DEFAULT_ACTIONS).forEach(function (k) {
      if (k === 'regenerate_button' && a[k] === '') { out[k] = ''; return; }   // 该站点不支持
      if (k === 'regenerate_menu_text') {
        var t = typeof a[k] === 'string' && a[k].length <= 300 ? a[k] : DEFAULT_ACTIONS[k];
        try { out.menuText = new RegExp(t, 'i'); } catch (_) { out.menuText = new RegExp(DEFAULT_ACTIONS[k], 'i'); }
      } else {
        out[k] = validSelector(doc, a[k]) ? a[k] : DEFAULT_ACTIONS[k];
      }
    });
    return out;
  }

  function sleep(win, ms) { return new Promise(function (r) { win.setTimeout(r, ms); }); }

  async function waitUntil(win, fn, timeoutMs, stepMs) {
    var end = Date.now() + timeoutMs;
    for (;;) {
      var v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(win, stepMs || 50);
    }
  }

  function last(list) { return list.length ? list[list.length - 1] : null; }

  function isEnabled(btn) {
    return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
  }

  function composerText(el) {
    return el.tagName === 'TEXTAREA' ? el.value : (el.textContent || '');
  }

  function setComposerText(doc, win, el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      var setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      return;
    }
    // ProseMirror / contenteditable：优先用 execCommand，编辑器能正确感知输入
    var ok = false;
    try {
      if (typeof doc.execCommand === 'function') {
        doc.execCommand('selectAll', false, null);
        ok = doc.execCommand('insertText', false, text);
      }
    } catch (_) { ok = false; }
    if (!ok || composerText(el).trim() !== text.trim()) {
      while (el.firstChild) el.removeChild(el.firstChild);
      text.split('\n').forEach(function (line) {
        var p = doc.createElement('p');
        p.textContent = line;
        el.appendChild(p);
      });
      el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  function pressEnter(win, el) {
    var init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new win.KeyboardEvent('keydown', init));
    el.dispatchEvent(new win.KeyboardEvent('keyup', init));
  }

  /**
   * @param {object} ctx { document, window, config, isGenerating(): boolean, conversationId(): string|null }
   * @param {{action:string, conversation_id:string, text?:string}} command
   */
  async function execute(ctx, command) {
    var doc = ctx.document;
    var win = ctx.window;
    var sel = resolveActions(ctx.actions || (ctx.config && ctx.config.actions), doc);

    if (ctx.conversationId() !== command.conversation_id) {
      return { ok: false, code: 'tab_moved', detail: '该标签页当前不在这个会话上' };
    }
    if (ctx.isGenerating()) return { ok: false, code: 'busy', detail: '正在生成回答，稍后再试' };

    if (command.action === 'reply') {
      var text = String(command.text || '');
      if (!text.trim()) return { ok: false, code: 'text_required' };
      var input = last(doc.querySelectorAll(sel.composer));
      if (!input) return { ok: false, code: 'composer_not_found', detail: '页面上没找到输入框' };
      setComposerText(doc, win, input, text);
      var btn = await waitUntil(win, function () {
        var b = last(doc.querySelectorAll(sel.send_button));
        return isEnabled(b) ? b : null;
      }, 3000, 50);
      if (btn) btn.click(); else pressEnter(win, input);
      var sent = await waitUntil(win, function () {
        return ctx.isGenerating() || composerText(input).trim() === '';
      }, 5000, 100);
      // 等页面开始回答再返回，避免看板紧接着发第二条时页面还没进入“回答中”
      if (sent) await waitUntil(win, function () { return ctx.isGenerating(); }, 3000, 100);
      return sent
        ? { ok: true, detail: btn ? '已发送' : '已发送（回车）' }
        : { ok: false, code: 'send_not_confirmed', detail: '文字已填入输入框，但没确认发送成功' };
    }

    if (command.action === 'regenerate') {
      if (!sel.regenerate_button) return { ok: false, code: 'regenerate_unsupported', detail: '这个站点没有“重新生成”按钮' };
      var rb = last(doc.querySelectorAll(sel.regenerate_button));
      if (!rb) return { ok: false, code: 'regenerate_not_found', detail: '没找到“重新生成”按钮' };
      rb.click();
      var started = await waitUntil(win, function () { return ctx.isGenerating(); }, 600, 50);
      if (!started) {
        // 新版页面：按钮先弹出菜单
        var item = await waitUntil(win, function () {
          var items = doc.querySelectorAll(sel.regenerate_menu_item);
          for (var i = 0; i < items.length; i++) if (sel.menuText.test(items[i].textContent || '')) return items[i];
          return null;
        }, 1500, 50);
        if (item) item.click();
        started = await waitUntil(win, function () { return ctx.isGenerating(); }, 5000, 100);
      }
      return started
        ? { ok: true, detail: '已开始重新生成' }
        : { ok: false, code: 'not_confirmed', detail: '已点击重新生成，但没检测到开始生成' };
    }

    return { ok: false, code: 'unsupported_action' };
  }

  global.ChatGPTBridgeActions = { execute: execute, resolveActions: resolveActions, DEFAULT_ACTIONS: DEFAULT_ACTIONS };
})(typeof window !== 'undefined' ? window : globalThis);
