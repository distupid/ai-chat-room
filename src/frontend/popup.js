const $ = (id) => document.getElementById(id);

async function refresh() {
  const res = await chrome.runtime.sendMessage({ kind: 'get_diagnostics' });
  const d = res?.diagnostics;
  if (!d) return;
  $('state').textContent = d.state;
  $('diag').textContent = JSON.stringify({
    state: d.state, url: d.url, client_id: d.client_id, session: d.session,
    queue: d.queue, stats: d.stats, page_events: d.page_events, tabs: d.tabs,
    received_broadcasts: d.received_broadcasts, recent_inbound: d.recent_inbound,
    errors: d.errors, last_close: d.last_close, next_retry_at: d.next_retry_at
  }, null, 2);
}

async function showDomConfig() {
  const { domConfig, domConfigReport, domConfigs = {}, domConfigReports = {} } =
    await chrome.storage.local.get(['domConfig', 'domConfigReport', 'domConfigs', 'domConfigReports']);
  const all = { ...domConfigs };
  if (!all.chatgpt && domConfig) all.chatgpt = domConfig;
  const names = { chatgpt: 'ChatGPT', duckai: 'Duck.ai', hark: 'Hark' };
  $('cfgSource').textContent = Object.keys(names)
    .map((k) => `${names[k]}：${all[k] ? `后端分析（${all[k].strategy || '-'}）` : '内置适配'}`).join('；');
  const reports = { ...domConfigReports };
  if (!reports.chatgpt && domConfigReport) reports.chatgpt = domConfigReport;
  $('cfgReport').textContent = Object.keys(all).length
    ? JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { report: reports[k], config: v }])), null, 2)
    : '-';
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
    showDomConfig();
  }
};
$('clearCfg').onclick = async () => {
  await chrome.runtime.sendMessage({ kind: 'clear_dom_config' });
  say('已恢复内置默认配置', true);
  showDomConfig();
};

refresh();
showDomConfig();
setInterval(refresh, 2000);
