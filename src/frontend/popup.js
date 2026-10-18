const $ = (id) => document.getElementById(id);

let lastDiag = '';
async function refresh() {
  const res = await chrome.runtime.sendMessage({ kind: 'get_diagnostics' });
  const d = res?.diagnostics;
  if (!d) return;
  const label = { open: '已连接', auth_failed: '认证失败', waiting: '等待重连', connecting: '连接中', handshaking: '握手中', stopped: '未连接' }[d.state] || d.state;
  $('state').textContent = label;
  $('state').className = `badge ${d.state === 'open' ? 'ok' : d.state === 'auth_failed' ? 'err' : ''}`;
  // 调试信息只在控制台输出（右键插件弹窗 → 检查 → Console），内容变化时才打印
  const diag = {
    state: d.state, url: d.url, client_id: d.client_id, session: d.session,
    queue: d.queue, stats: d.stats, page_events: d.page_events, tabs: d.tabs,
    received_broadcasts: d.received_broadcasts, recent_inbound: d.recent_inbound,
    errors: d.errors, last_close: d.last_close, next_retry_at: d.next_retry_at
  };
  const key = JSON.stringify(diag);
  if (key !== lastDiag) { lastDiag = key; console.log('[AI-Chat-Room] 诊断', diag); }
}

chrome.storage.local.get(['serverUrl', 'token']).then((s) => {
  $('url').value = s.serverUrl || 'ws://127.0.0.1:8787';
  $('token').value = s.token || '';
});
$('save').onclick = async () => {
  await chrome.runtime.sendMessage({ kind: 'save_settings', serverUrl: $('url').value.trim(), token: $('token').value.trim() });
  setTimeout(refresh, 500);
};

refresh();
setInterval(refresh, 2000);
