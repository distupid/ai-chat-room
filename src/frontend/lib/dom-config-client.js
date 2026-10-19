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

/** ArrayBuffer → base64（分段拼接，避免大文件时参数过多） */
export function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const MAX_TAB_FILE_BYTES = 40 * 1024 * 1024;   // 一次交给页面的文件总量（扩展消息有大小上限）

/**
 * 快速回复带文件：用插件 token 从后端取回看板上传的文件，转成 base64 交给内容脚本。
 * @returns {Promise<{ok:true, files:{name,type,data}[]} | {ok:false, code, detail}>}
 */
export async function fetchAttachments({ fetchImpl = fetch, serverUrl, token, attachments }) {
  const files = [];
  let total = 0;
  for (const a of attachments || []) {
    let res;
    try { res = await fetchImpl(wsToHttp(serverUrl) + a.url, { headers: { authorization: `Bearer ${token}` } }); }
    catch (e) { return { ok: false, code: 'attachment_fetch_failed', detail: `取文件失败：${a.name}（${e?.message || e}）` }; }
    if (!res.ok) return { ok: false, code: res.status === 404 ? 'attachment_expired' : 'attachment_fetch_failed', detail: `取文件失败：${a.name}（HTTP ${res.status}）` };
    const buf = await res.arrayBuffer();
    total += buf.byteLength;
    if (total > MAX_TAB_FILE_BYTES) return { ok: false, code: 'attachments_too_large', detail: `文件总大小超过 ${MAX_TAB_FILE_BYTES / 1048576} MB` };
    files.push({ name: a.name, type: a.type || res.headers.get('content-type') || 'application/octet-stream', data: bufferToBase64(buf) });
  }
  return { ok: true, files };
}

/**
 * 插件上传页面里观察到的文件到后端（MVP 文件上传：上传文件 → 后端 → 看板文件卡片）。
 * POST /api/attachments：body = 文件原始字节，x-file-name = encodeURIComponent(文件名)。
 * 需要 control 或 publish 权限的 token（插件用自己的 extension token）。
 * @param {object} o
 * @param {Uint8Array|string} o.data 文件内容（string 按 base64 解码；浏览器里用 Uint8Array）
 * @returns {Promise<{ok:true, attachment:{id,name,type,size}} | {ok:false, code, detail}>}
 */
export async function uploadAttachment({ fetchImpl = fetch, serverUrl, token, name, type, data }) {
  let body;
  if (typeof data === 'string') {
    const bin = atob(data);
    body = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) body[i] = bin.charCodeAt(i);
  } else if (data instanceof Uint8Array) {
    body = data;
  } else {
    return { ok: false, code: 'bad_argument', detail: 'data 必须是 base64 字符串或 Uint8Array' };
  }
  let res;
  try {
    res = await fetchImpl(wsToHttp(serverUrl) + '/api/attachments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-file-name': encodeURIComponent(String(name || 'file')),
        'content-type': String(type || 'application/octet-stream')
      },
      body
    });
  } catch (e) {
    return { ok: false, code: 'upload_failed', detail: `上传失败：${e?.message || e}` };
  }
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok || !json || json.ok !== true) {
    return {
      ok: false,
      code: res.status === 403 ? 'forbidden' : res.status === 413 ? 'too_large' : 'upload_failed',
      detail: (json && json.error) || `HTTP ${res.status}`
    };
  }
  return { ok: true, attachment: json.attachment };
}
