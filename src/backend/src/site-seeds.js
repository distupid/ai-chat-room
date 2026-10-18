/**
 * 默认网站种子：来自插件观察器脚本（src/frontend/lib/dom-observer.js 的 SEED_SITES），前后端同一份。
 * 只在后端第一次启动（或旧版网站列表缺少默认网站的配置）时写进网站列表，之后可编辑 / 停用 / 删除；
 * “恢复默认”也从这里取。按域名找网站的规则（findSite）同样复用观察器脚本里的实现。
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OBSERVER_SRC = readFileSync(fileURLToPath(new URL('../../frontend/lib/dom-observer.js', import.meta.url)), 'utf8');
const sandbox = { URL };
vm.createContext(sandbox);
vm.runInContext(OBSERVER_SRC, sandbox, { filename: 'dom-observer.js' });
const O = sandbox.ChatGPTBridgeObserver;

const clone = (v) => JSON.parse(JSON.stringify(v));

/** 默认网站（每次返回新的深拷贝） */
export function seedSites() {
  return clone(O.SEED_SITES).map((x) => ({ ...x, config: { ...x.config, site: x.key } }));
}

export function seedByKey(key) {
  return seedSites().find((x) => x.key === key) || null;
}

export const SEED_KEYS = Object.freeze(O.SEED_SITES.map((x) => x.key));

/** 按域名在网站列表里找网站（本域名或子域名，最长匹配）；list 省略 = 默认种子 */
export function findSite(host, list) {
  return O.findSite(host, Array.isArray(list) ? list : undefined) || null;
}

/** 网站的全部域名（去掉 www.、去重） */
export function siteHosts(site) {
  return [...O.siteHosts(site)];
}

/** 网址 → 来源标识：网站列表里匹配的网站；都不匹配时取主域名 */
export function sourceForUrl(url, list) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return 'unknown'; }
  const s = findSite(host, list);
  if (s) return s.key;
  const parts = host.split('.');
  return ((parts.length >= 2 ? parts[parts.length - 2] : host) || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown';
}
