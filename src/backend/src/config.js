import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { EventType, Limits, Scope } from '../../../contracts/protocol.js';

/**
 * 广播与访问策略（默认值）。所有项都可在 data/config.json 的 "policy" 里覆盖。
 */
export const DEFAULT_POLICY = Object.freeze({
  // 是否把事件回显给发送者本人。默认 false：发送者只收到 ack，不收到自己的广播。
  echo_to_sender: false,
  // 允许广播的业务事件类型（不在列表里的事件只持久化、不广播）
  broadcast_event_types: Object.values(EventType),
  // 单条 WS 消息上限（入站和出站广播都受限）
  max_message_bytes: Limits.MAX_MESSAGE_BYTES,
  // 订阅时 since_seq 回放的最大条数（需要 history scope）
  history_limit: 200,
  // 服务端协议层 ping 间隔；超时未 pong 的连接会被 terminate
  heartbeat_ms: 30000,
  // 握手超时：连接后必须在此时间内发送 hello
  hello_timeout_ms: 5000,
  // 最大并发连接数
  max_connections: 32,
  // 每个连接的入站速率限制（令牌桶）
  rate_limit: { capacity: 200, refill_per_sec: 100 },
  // 单个客户端发送缓冲超过此值视为慢消费者：跳过本次广播并计数，持续超限则断开
  max_buffered_bytes: 4 * 1024 * 1024,
  slow_consumer_strikes: 20
});

/**
 * 读取/生成配置文件。首次运行时自动生成两个随机 token：
 * - extension：插件使用（publish + subscribe + read_content）
 * - observer ：本机观察/测试客户端（subscribe_all + read_content + history）
 */
export function loadConfig(configPath, overrides = {}) {
  let file = {};
  if (configPath) {
    if (!existsSync(configPath)) {
      mkdirSync(dirname(configPath), { recursive: true });
      file = {
        clients: [
          { name: 'extension', token: randomBytes(24).toString('hex'), kind: 'extension',
            scopes: [Scope.PUBLISH, Scope.SUBSCRIBE, Scope.READ_CONTENT] },
          { name: 'observer', token: randomBytes(24).toString('hex'), kind: 'observer',
            scopes: [Scope.SUBSCRIBE, Scope.SUBSCRIBE_ALL, Scope.READ_CONTENT, Scope.HISTORY, Scope.CONTROL] }
        ],
        // 允许的插件 Origin（chrome-extension://<id>）。空数组 = 允许任何 chrome-extension:// 来源。
        allowed_extension_origins: [],
        policy: {}
      };
      writeFileSync(configPath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    } else {
      file = JSON.parse(readFileSync(configPath, 'utf8'));
    }
  }
  const merged = {
    host: overrides.host ?? process.env.BRIDGE_HOST ?? '127.0.0.1',
    port: overrides.port ?? Number(process.env.BRIDGE_PORT ?? 8787),
    dbPath: overrides.dbPath ?? process.env.BRIDGE_DB,
    allowRemote: overrides.allowRemote ?? process.env.BRIDGE_ALLOW_REMOTE === '1',
    clients: migrateClients(overrides.clients ?? file.clients ?? []),
    allowedExtensionOrigins: overrides.allowedExtensionOrigins ?? file.allowed_extension_origins ?? [],
    policy: { ...DEFAULT_POLICY, ...(file.policy || {}), ...(overrides.policy || {}) }
  };
  if (!merged.allowRemote && !isLoopback(merged.host)) {
    throw new Error(`Refusing to bind non-loopback host ${merged.host}. Set BRIDGE_ALLOW_REMOTE=1 if you really mean it.`);
  }
  return merged;
}

export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * 旧版 config.json 里的 observer token 没有 control 权限：
 * 能读取全部会话正文（subscribe_all + read_content）的 observer 自动获得 control，供看板的“快速回复 / 重新回答”使用。
 * 只在内存中补充，不改写文件；如需禁止，给该 client 加上 "no_control": true。
 */
function migrateClients(clients) {
  return clients.map((c) => {
    const scopes = c.scopes || [];
    if (c.kind === 'observer' && !c.no_control && scopes.includes(Scope.SUBSCRIBE_ALL) &&
        scopes.includes(Scope.READ_CONTENT) && !scopes.includes(Scope.CONTROL)) {
      return { ...c, scopes: [...scopes, Scope.CONTROL] };
    }
    return c;
  });
}
