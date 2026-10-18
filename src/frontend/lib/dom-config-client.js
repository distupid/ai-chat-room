/**
 * 插件后台调用后端网站接口（网站列表、添加网站时上传页面）的辅助函数（纯函数，便于在 Node 测试中注入 fetch）。
 */

/** ws://127.0.0.1:8787 → http://127.0.0.1:8787；wss → https */
export function wsToHttp(wsUrl) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

async function call(fetchImpl, serverUrl, token, method, path, body) {
  const res = await fetchImpl(wsToHttp(serverUrl) + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!data) data = { ok: false, error: `HTTP ${res.status}` };
  if (!res.ok && data.ok !== false) data.ok = false;
  data.status = res.status;
  return data;
}

/** 已适配网站（内置 + 看板上添加的） */
export function getSitesFromServer({ fetchImpl = fetch, serverUrl, token }) {
  return call(fetchImpl, serverUrl, token, 'GET', '/api/sites');
}

/** 看板“添加网站”：上传插件打开该网址后抓到的页面 */
export function submitProbeDom({ fetchImpl = fetch, serverUrl, token, probeId, html, url, title }) {
  return call(fetchImpl, serverUrl, token, 'POST', `/api/sites/probe/${encodeURIComponent(probeId)}/dom`, { html, url, title });
}
