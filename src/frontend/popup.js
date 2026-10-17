const $ = (id) => document.getElementById(id);

async function refresh() {
  const res = await chrome.runtime.sendMessage({ kind: 'get_diagnostics' });
  const d = res?.diagnostics;
  if (!d) return;
  const label = { open: '已连接', auth_failed: '认证失败', waiting: '等待重连', connecting: '连接中', handshaking: '握手中', stopped: '未连接' }[d.state] || d.state;
  $('state').textContent = label;
  $('state').className = `badge ${d.state === 'open' ? 'ok' : d.state === 'auth_failed' ? 'err' : ''}`;
  $('diag').textContent = JSON.stringify({
    state: d.state, url: d.url, client_id: d.client_id, session: d.session,
    queue: d.queue, stats: d.stats, page_events: d.page_events, tabs: d.tabs,
    received_broadcasts: d.received_broadcasts, recent_inbound: d.recent_inbound,
    errors: d.errors, last_close: d.last_close, next_retry_at: d.next_retry_at
  }, null, 2);
}

function say(text, ok) {
  $('analyzeMsg').textContent = text;
  $('analyzeMsg').className = ok ? 'ok' : 'err';
}

chrome.storage.local.get(['serverUrl', 'token']).then((s) => {
  $('url').value = s.serverUrl || 'ws://127.0.0.1:8787';
  $('token').value = s.token || '';
});
$('save').onclick = async () => {
  await chrome.runtime.sendMessage({ kind: 'save_settings', serverUrl: $('url').value.trim(), token: $('token').value.trim() });
  setTimeout(refresh, 500);
};
$('refresh').onclick = refresh;

$('analyze').onclick = async () => {
  $('analyze').disabled = true;
  say('正在抓取并分析……', true);
  try {
    const r = await chrome.runtime.sendMessage({ kind: 'analyze_dom' });
    if (r?.ok) {
      const rep = r.report || {};
      say(`已应用：${rep.strategy}，识别 ${rep.message_count} 条消息（${Object.entries(rep.roles || {}).map(([k, v]) => k + ' ' + v).join('，')}）` +
        (rep.warnings?.length ? `；注意：${rep.warnings.join('；')}` : ''), true);
    } else {
      say(`失败：${r?.report?.error || r?.error || '未知错误'}${r?.report?.hint ? '（' + r.report.hint + '）' : ''}`, false);
    }
  } finally {
    $('analyze').disabled = false;
  }
};

refresh();
setInterval(refresh, 2000);
