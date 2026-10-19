/*
 * 页面操作（经典脚本，内容脚本中运行）：执行看板下发的指令。
 *   reply      在输入框中填入文字（和看板选的文件）并发送；文件交给页面自己的文件选择框上传，和在网页上点上传按钮一样
 *   regenerate 点击某条回答的“重新生成”（answer_index 不填 = 最后一条）
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
    regenerate_menu_text: '重试|再试一次|重新生成|Try again|Regenerate|Retry',
    attach_button: '[data-testid="composer-plus-btn"], button[aria-label*="添加文件"], button[aria-label*="附件"], button[aria-label*="上传"], ' +
      'button[aria-label*="Attach"], button[aria-label*="attach"], button[aria-label*="Upload"], button[aria-label*="upload"], ' +
      'button[aria-label*="Add files"], button[aria-label*="Add photos"], [data-testid*="attach"], [data-testid*="upload"]',
    file_input: 'input[type="file"]',
    // 布尔开关：发送按钮超时未出现/未启用时，是否回退到回车发送；false = 直接失败（send_not_confirmed）。
    // meta.ai 的 Lexical 编辑器回车语义不可靠，设 false。
    enter_fallback: true
  };
  var UPLOAD_WAIT_MS = 90000;   // 带文件时等页面上传完成（发送按钮可用）的最长时间

  function validSelector(doc, sel) {
    if (typeof sel !== 'string' || !sel || sel.length > 2000) return false;
    try { doc.querySelector(sel); return true; } catch (_) { return false; }
  }

  /** a = 观察器已按站点合并好的 actions（或 DomConfig 原始配置里的 actions） */
  function resolveActions(a, doc) {
    a = a && typeof a === 'object' ? a : {};
    var out = {};
    Object.keys(DEFAULT_ACTIONS).forEach(function (k) {
      if ((k === 'regenerate_button' || k === 'send_button') && a[k] === '') { out[k] = ''; return; }   // 该站点不支持
      if (k === 'enter_fallback') { out[k] = a[k] === false ? false : true; return; }   // 布尔开关
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

  function toFiles(win, files) {
    return files.map(function (f) {
      var bin = win.atob(String(f.data || ''));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new win.File([bytes], String(f.name || 'file'), { type: String(f.type || 'application/octet-stream') });
    });
  }

  /** 页面自己的文件选择框：优先输入框所在表单里的那个 */
  function findFileInput(doc, sel, composer) {
    var form = composer && composer.closest ? composer.closest('form') : null;
    var list = form ? form.querySelectorAll(sel.file_input) : [];
    if (!list.length) list = doc.querySelectorAll(sel.file_input);
    return last(list);
  }

  /**
   * 把文件交给页面：有文件选择框就直接设置 files 并触发 change（页面按自己的逻辑上传）；
   * 没有时模拟把文件拖到输入框里。
   */
  function attachFiles(doc, win, sel, composer, files) {
    if (typeof win.DataTransfer !== 'function' || typeof win.File !== 'function') {
      return { ok: false, code: 'attach_unsupported', detail: '这个浏览器不支持把文件交给页面' };
    }
    var list = toFiles(win, files);
    var dt = new win.DataTransfer();
    list.forEach(function (f) { dt.items.add(f); });
    var input = findFileInput(doc, sel, composer);
    if (input) {
      if (!input.multiple && list.length > 1) return { ok: false, code: 'attach_single_only', detail: '这个网站一次只能上传一个文件' };
      input.files = dt.files;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
      return { ok: true, via: 'input' };
    }
    var target = composer || doc.body;
    try {
      ['dragenter', 'dragover', 'drop'].forEach(function (t) {
        target.dispatchEvent(new win.DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      });
      return { ok: true, via: 'drop' };
    } catch (_) {
      return { ok: false, code: 'file_input_not_found', detail: '页面上没找到上传文件的地方' };
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
      var files = Array.isArray(command.files) ? command.files : [];
      if (!text.trim() && !files.length) return { ok: false, code: 'text_required' };
      var input = last(doc.querySelectorAll(sel.composer));
      if (!input) return { ok: false, code: 'composer_not_found', detail: '页面上没找到输入框' };
      if (files.length) {
        var att = attachFiles(doc, win, sel, input, files);
        if (!att.ok) return att;
        await sleep(win, 300);   // 让页面先把文件加进输入框（很多网站上传期间会禁用发送按钮）
      }
      if (text.trim()) setComposerText(doc, win, input, text);
      // 发送前确认：文字必须真正落在输入框里。有的页面框架会回滚合成输入
      // （框里看着有字、框架内部状态却是空的），此时点发送也发不出去，
      // 而旧逻辑只看“输入框空了”就会误报 ok。按行压平后做包含检查，容忍换行差异。
      if (text.trim()) {
        var flat = function (s) { return String(s || '').replace(/\s+/g, ''); };
        if (flat(composerText(input)).indexOf(flat(text).slice(0, 60)) < 0) {
          return { ok: false, code: 'composer_fill_failed', detail: '文字没能填入输入框（页面可能回滚了输入），未点发送' };
        }
      }
      // 无发送按钮的站点（如 muse.ai）：直接回车发送，不等按钮出现
      var findSendBtn = function () { return sel.send_button ? last(doc.querySelectorAll(sel.send_button)) : null; };
      var btn = sel.send_button ? await waitUntil(win, function () {
        var b = findSendBtn();
        return isEnabled(b) ? b : null;
      }, files.length ? UPLOAD_WAIT_MS : 3000, files.length ? 200 : 50) : null;
      // 文字已填好、发送按钮仍不可用：enter_fallback=false 的站（如 meta.ai）
      // 直接判失败（按钮不启用说明文字没被编辑器识别）；否则按到达上限处理
      if (!btn && !files.length && text.trim() && findSendBtn()) {
        if (sel.enter_fallback === false) {
          return { ok: false, code: 'send_not_confirmed', detail: '发送按钮一直处于不可用状态，文字可能没被编辑器识别，未发送' };
        }
        return { ok: false, code: 'limit_reached', detail: '到达上限（发送按钮不可用）' };
      }
      if (!btn && files.length) return { ok: false, code: 'upload_not_finished', detail: '文件已交给页面，但等不到上传完成（发送按钮一直不可用）' };
      if (btn) btn.click();
      else if (sel.enter_fallback !== false) pressEnter(win, input);
      else return { ok: false, code: 'send_not_confirmed', detail: '没等到发送按钮出现，未发送' };
      // 发送确认（两阶段，防误报 ok）：
      //  1) 8 秒内等页面真正接受：进入生成中（最强信号）、或输入框被清空、或纯文件时发送按钮变不可用；
      //  2) 若靠“输入框清空”确认，再观察 1.2 秒：必须保持清空（排除页面瞬时抖动/回填），
      //     期间进入生成中则直接成功，文字重现则判失败。超时无确认一律报失败，看板可重试。
      var acceptState = await waitUntil(win, function () {
        if (ctx.isGenerating()) return 'generating';
        if (text.trim() && composerText(input).trim() === '') return 'cleared';
        if (!text.trim() && sel.send_button && !isEnabled(findSendBtn())) return 'sent_files';
        return null;
      }, 8000, 100);
      if (!acceptState) {
        return { ok: false, code: 'send_not_confirmed', detail: '点了发送，但 8 秒内页面没有反应（输入框未清空、也未开始回答）' };
      }
      if (acceptState === 'cleared') {
        var settleUntil = Date.now() + 1200;
        for (;;) {
          if (ctx.isGenerating()) break;   // 开始回答了，直接算成功
          if (composerText(input).trim() !== '') {
            return { ok: false, code: 'send_not_confirmed', detail: '输入框清空后又出现文字，消息可能没发出去' };
          }
          if (Date.now() >= settleUntil) break;
          await sleep(win, 100);
        }
      }
      // 等页面开始回答再返回，避免看板紧接着发第二条时页面还没进入“回答中”
      await waitUntil(win, function () { return ctx.isGenerating(); }, 3000, 100);
      return { ok: true, detail: btn ? '已发送' : '已发送（回车）' };
    }

    if (command.action === 'regenerate') {
      if (!sel.regenerate_button) return { ok: false, code: 'regenerate_unsupported', detail: '这个站点没有“重新生成”按钮' };
      var buttons = doc.querySelectorAll(sel.regenerate_button);
      var rb = null;
      var idx = command.answer_index;
      var total = command.answer_total;
      if (idx == null || (total != null && idx === total - 1)) {
        rb = last(buttons);
      } else if (total != null && buttons.length === total && idx >= 0 && idx < total) {
        // 页面上每条回答各有一个“重新生成”按钮，按顺序对上
        rb = buttons[idx];
      } else {
        return { ok: false, code: 'regenerate_target_not_found', detail: '页面上的回答和看板对不上，无法定位这条回答的“重新生成”' };
      }
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
