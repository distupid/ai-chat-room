/**
 * ChatGPT WS Bridge —— 共享事件协议（唯一事实来源）
 *
 * 插件（extension/shared/ 为本目录的构建副本）与后端（server/）都只从这里
 * 读取消息类型、字段、版本和校验规则，禁止任何一端自行维护格式。
 *
 * - SCHEMA：标准 JSON Schema（draft-07），后端测试用 Ajv 编译校验，
 *   `npm run build:schema` 会导出 shared/protocol.schema.json 供文档/外部工具使用。
 * - validateMessage()：零依赖校验器，浏览器 Service Worker 与 Node 都可直接使用，
 *   按 type / event_type 分派，错误信息精确到字段路径。
 */

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_NAME = 'chatgpt-ws-bridge';

/** 信封类型 */
export const MessageType = Object.freeze({
  HELLO: 'hello',             // C→S 握手（必须是第一条）
  WELCOME: 'welcome',         // S→C 握手成功，下发策略
  EVENT: 'event',             // C→S 业务事件
  ACK: 'ack',                 // S→C 接收/持久化确认
  ERROR: 'error',             // S→C 协议或业务错误
  BROADCAST: 'broadcast',     // S→C 后端广播
  SUBSCRIBE: 'subscribe',     // C→S 按会话订阅
  UNSUBSCRIBE: 'unsubscribe', // C→S 取消订阅
  SUBSCRIBED: 'subscribed',   // S→C 订阅结果
  PING: 'ping',               // 双向 应用层心跳
  PONG: 'pong',               // 双向
  COMMAND: 'command',         // 看板→后端→插件：在页面上执行操作（快速回复 / 重新回答）
  COMMAND_RESULT: 'command_result' // 插件→后端→看板：操作结果
});

/** 每种信封允许的方向：c2s = 客户端→服务端，s2c = 服务端→客户端 */
export const Direction = Object.freeze({
  hello: ['c2s'],
  welcome: ['s2c'],
  event: ['c2s'],
  ack: ['s2c'],
  error: ['s2c'],
  broadcast: ['s2c'],
  subscribe: ['c2s'],
  unsubscribe: ['c2s'],
  subscribed: ['s2c'],
  ping: ['c2s', 's2c'],
  pong: ['c2s', 's2c'],
  command: ['c2s', 's2c'],
  command_result: ['c2s', 's2c']
});

/** 业务事件类型 */
export const EventType = Object.freeze({
  PAGE_OPENED: 'page.opened',
  PAGE_CLOSED: 'page.closed',
  CONVERSATION_CHANGED: 'conversation.changed',
  MESSAGE_ADDED: 'message.added',
  MESSAGE_UPDATED: 'message.updated',
  GENERATION_STARTED: 'generation.started',
  GENERATION_FINISHED: 'generation.finished',
  CONVERSATION_STATUS: 'conversation.status',  // 会话状态变化：正常 / 已到限额 / 出错 / 已删除，附带来源与模型
  TABS_SNAPSHOT: 'tabs.snapshot'               // 插件 → 后端：浏览器里真实开着的标签页（含 PWA 窗口），后端据此补齐 page.opened / page.closed
});

/** conversation.status 的状态取值 */
export const ConversationStatus = Object.freeze({
  OK: 'ok',
  LIMIT_REACHED: 'limit_reached',
  ERROR: 'error'
});

/** 访问范围（scope），由后端按 token 授予 */
export const Scope = Object.freeze({
  PUBLISH: 'publish',             // 可上报业务事件
  SUBSCRIBE: 'subscribe',         // 可订阅指定 conversation_id
  SUBSCRIBE_ALL: 'subscribe_all', // 可订阅 "*"（全部会话）
  READ_CONTENT: 'read_content',   // 广播中可见消息正文；否则正文被脱敏
  HISTORY: 'history',             // 订阅时可回放历史事件（since_seq）
  CONTROL: 'control'              // 可下发页面操作指令（command）
});

export const ErrorCode = Object.freeze({
  INVALID_JSON: 'INVALID_JSON',
  SCHEMA_VIOLATION: 'SCHEMA_VIOLATION',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  NOT_HELLO: 'NOT_HELLO',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  MESSAGE_TOO_LARGE: 'MESSAGE_TOO_LARGE',
  INTERNAL: 'INTERNAL'
});

/** 客户端收到这些错误后，对应事件重发也不会成功，应从发送队列移除 */
export const NON_RETRYABLE_ERRORS = Object.freeze([
  ErrorCode.SCHEMA_VIOLATION,
  ErrorCode.UNSUPPORTED_VERSION,
  ErrorCode.FORBIDDEN,
  ErrorCode.MESSAGE_TOO_LARGE
]);

/** 页面操作指令 */
export const CommandAction = Object.freeze({
  REPLY: 'reply',             // 在会话输入框中填入 text 并发送
  REGENERATE: 'regenerate',   // 点击某条回答（默认最后一条）的“重新生成”
  FOCUS: 'focus',             // 切换到开着该会话的标签页（看板点卡片）
  CLOSE: 'close'              // 关闭开着该会话的标签页（看板“关闭页面”）
});

export const Limits = Object.freeze({
  MAX_MESSAGE_BYTES: 256 * 1024,
  MAX_TEXT_CHARS: 60000,
  MAX_HTML_CHARS: 200000,      // message.* 的可选 html（净化后的富文本）上限；超过时插件不带 html，只发 text
  MAX_COMMAND_TEXT: 20000,
  MAX_SUBSCRIPTIONS: 100
});

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

const ID = { type: 'string', minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
const EVENT_ID = { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9:._-]+$' };
const TS = { type: 'integer', minimum: 0 };
const NULLABLE_STR = (max) => ({ type: ['string', 'null'], maxLength: max });
const ROLE = { type: 'string', enum: ['user', 'assistant', 'system', 'tool', 'unknown'] };
const URL_STR = { type: 'string', maxLength: 2048 };
const EVENT_TYPES = Object.values(EventType);

function envelope(type, props, required) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['v', 'type', 'id', 'ts', ...required],
    properties: {
      v: { const: PROTOCOL_VERSION },
      type: { const: type },
      id: ID,
      ts: TS,
      ...props
    }
  };
}

function obj(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, required, properties };
}

const messagePayload = obj({
  message_id: { type: 'string', minLength: 1, maxLength: 128 },
  role: ROLE,
  index: { type: 'integer', minimum: 0 },
  text: { type: 'string', maxLength: Limits.MAX_TEXT_CHARS },
  text_length: { type: 'integer', minimum: 0 },
  truncated: { type: 'boolean' },           // 可选：text 是否因超过 MAX_TEXT_CHARS 被截断
  // 可选：同一消息节点净化后的 HTML（保留段落 / 标题 / 列表 / 代码块 / 表格 / 图片 / 链接 / 文件），看板据此按原格式显示；
  // 只允许白名单标签和属性（插件和看板各净化一次），超过上限时省略，看板退回 text
  html: { type: 'string', maxLength: Limits.MAX_HTML_CHARS }
}, ['message_id', 'role', 'index', 'text', 'text_length']);

/** 每种业务事件的 payload schema */
export const EVENT_PAYLOAD_SCHEMAS = Object.freeze({
  'page.opened': obj({ url: URL_STR, title: { type: 'string', maxLength: 512 } }),
  'page.closed': obj({ url: URL_STR, reason: { type: 'string', enum: ['unload', 'pagehide', 'tab_removed', 'navigated', 'manual', 'reconciled'] } }),
  'conversation.changed': obj({ url: URL_STR, previous_conversation_id: NULLABLE_STR(128) }),
  'message.added': messagePayload,
  'message.updated': messagePayload,
  'generation.started': obj({
    message_id: NULLABLE_STR(128),
    generation_sequence: { type: 'integer', minimum: 0 }   // 可选：本页面内第几次生成
  }, ['message_id']),
  'generation.finished': obj({
    message_id: NULLABLE_STR(128),
    duration_ms: { type: ['integer', 'null'], minimum: 0 }
  }),
  'tabs.snapshot': obj({
    tabs: {
      type: 'array', maxItems: 500,
      items: obj({
        tab_id: { type: 'integer', minimum: 0 },
        host: { type: 'string', maxLength: 255 },
        conversation_id: NULLABLE_STR(128),   // 内容脚本报告的当前会话；没有内容脚本 / 不在会话里为 null
        url: URL_STR,
        title: { type: 'string', maxLength: 512 },
        active: { type: 'boolean' }            // 是否是所在窗口当前显示的标签页（看板高亮对应卡片）
      }, ['tab_id', 'host', 'conversation_id'])
    }
  }),
  'conversation.status': obj({
    source: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-z0-9_-]+$' },
    status: { type: 'string', enum: ['ok', 'limit_reached', 'error', 'deleted'] },   // deleted：源站页面显示会话已删除 / 不存在 → 后端不再跟踪
    detail: NULLABLE_STR(500),
    model: NULLABLE_STR(100)
  }, ['source', 'status', 'detail'])
});

/** 广播中被脱敏（无 read_content 权限）的消息 payload：没有 text / html 字段 */
const redactedMessagePayload = obj({
  message_id: { type: 'string', minLength: 1, maxLength: 128 },
  role: ROLE,
  index: { type: 'integer', minimum: 0 },
  text_length: { type: 'integer', minimum: 0 },
  truncated: { type: 'boolean' }
}, ['message_id', 'role', 'index', 'text_length']);

function eventVariant(eventType, payloadSchema) {
  return {
    if: { properties: { event_type: { const: eventType } }, required: ['event_type'] },
    then: { properties: { payload: payloadSchema } }
  };
}

const EVENT_COMMON = {
  event_id: EVENT_ID,
  event_type: { type: 'string', enum: EVENT_TYPES },
  occurred_at: TS,
  conversation_id: NULLABLE_STR(128),
  payload: { type: 'object' }
};

export const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://local/chatgpt-ws-bridge/protocol-v1.json',
  title: 'ChatGPT WS Bridge protocol v1',
  definitions: {
    hello: envelope('hello', {
      client_id: ID,
      client_kind: { type: 'string', enum: ['extension', 'observer'] },
      client_version: { type: 'string', maxLength: 64 },
      token: { type: 'string', minLength: 1, maxLength: 256 }
    }, ['client_id', 'client_kind', 'token']),

    welcome: envelope('welcome', {
      session_id: ID,
      client_id: ID,
      scopes: { type: 'array', maxItems: 10, items: { type: 'string', enum: Object.values(Scope) } },
      server_time: TS,
      policy: obj({
        echo_to_sender: { type: 'boolean' },
        max_message_bytes: { type: 'integer', minimum: 1024 },
        history_limit: { type: 'integer', minimum: 0 },
        heartbeat_ms: { type: 'integer', minimum: 1000 },
        broadcast_event_types: { type: 'array', items: { type: 'string', enum: EVENT_TYPES } }
      })
    }, ['session_id', 'client_id', 'scopes', 'server_time', 'policy']),

    event: {
      ...envelope('event', { ...EVENT_COMMON, tab_id: { type: ['integer', 'null'] } },
        ['event_id', 'event_type', 'occurred_at', 'conversation_id', 'payload']),
      allOf: EVENT_TYPES.map((t) => eventVariant(t, EVENT_PAYLOAD_SCHEMAS[t]))
    },

    ack: envelope('ack', {
      ref_id: EVENT_ID,
      status: { type: 'string', enum: ['persisted', 'duplicate'] },
      seq: { type: 'integer', minimum: 1 }
    }, ['ref_id', 'status', 'seq']),

    error: envelope('error', {
      ref_id: { type: ['string', 'null'], maxLength: 128 },
      code: { type: 'string', enum: Object.values(ErrorCode) },
      message: { type: 'string', maxLength: 1000 },
      fatal: { type: 'boolean' }
    }, ['ref_id', 'code', 'message', 'fatal']),

    broadcast: {
      ...envelope('broadcast', {
        seq: { type: 'integer', minimum: 1 },
        origin_event_id: EVENT_ID,
        origin_client_id: ID,
        ...EVENT_COMMON,
        redacted: { type: 'boolean' },
        replay: { type: 'boolean' }
      }, ['seq', 'origin_event_id', 'origin_client_id', 'event_type', 'occurred_at',
        'conversation_id', 'payload', 'redacted', 'replay']),
      allOf: EVENT_TYPES.map((t) => {
        const isMsg = t === 'message.added' || t === 'message.updated';
        return {
          if: { properties: { event_type: { const: t } }, required: ['event_type'] },
          then: isMsg
            ? { properties: { payload: { oneOf: [EVENT_PAYLOAD_SCHEMAS[t], redactedMessagePayload] } } }
            : { properties: { payload: EVENT_PAYLOAD_SCHEMAS[t] } }
        };
      })
    },

    subscribe: envelope('subscribe', {
      conversations: {
        type: 'array', minItems: 1, maxItems: Limits.MAX_SUBSCRIPTIONS,
        items: { type: 'string', minLength: 1, maxLength: 128 }
      },
      since_seq: { type: ['integer', 'null'], minimum: 0 }
    }, ['conversations']),

    unsubscribe: envelope('unsubscribe', {
      conversations: {
        type: 'array', minItems: 1, maxItems: Limits.MAX_SUBSCRIPTIONS,
        items: { type: 'string', minLength: 1, maxLength: 128 }
      }
    }, ['conversations']),

    subscribed: envelope('subscribed', {
      ref_id: ID,
      conversations: { type: 'array', items: { type: 'string', maxLength: 128 } },
      replayed: { type: 'integer', minimum: 0 }
    }, ['ref_id', 'conversations', 'replayed']),

    ping: envelope('ping', { nonce: { type: 'string', maxLength: 64 } }, ['nonce']),
    pong: envelope('pong', { nonce: { type: 'string', maxLength: 64 } }, ['nonce']),

    command: envelope('command', {
      command_id: ID,
      action: { type: 'string', enum: ['reply', 'regenerate', 'focus', 'close', 'probe_site', 'sync_sites', 'open_sites'] },   // probe_site / sync_sites / open_sites：后端 → 插件（添加网站 / 一键启动）
      conversation_id: { type: 'string', minLength: 1, maxLength: 128 },
      text: { type: 'string', minLength: 1, maxLength: Limits.MAX_COMMAND_TEXT },
      answer_index: { type: 'integer', minimum: 0, maximum: 100000 },   // regenerate：第几条回答（从 0 开始）；不填 = 最后一条
      answer_total: { type: 'integer', minimum: 1, maximum: 100000 },   // regenerate：看板看到的回答总数，用于和页面核对
      tab_id: { type: 'integer', minimum: 0 },          // 后端转发给插件时填写
      tab_ids: { type: 'array', maxItems: 50, items: { type: 'integer', minimum: 0 } },   // close：该插件里开着这个会话的所有标签页
      url: { type: 'string', maxLength: 2048 },           // close：会话页面地址（插件再按地址找 PWA / 其他窗口里的标签页）
      requested_by: ID                                    // 后端转发给插件时填写
    }, ['command_id', 'action', 'conversation_id']),

    command_result: envelope('command_result', {
      command_id: ID,
      ok: { type: 'boolean' },
      code: { type: 'string', maxLength: 64 },            // 失败原因代码，如 no_open_tab / busy / timeout
      detail: NULLABLE_STR(500)
    }, ['command_id', 'ok'])
  },
  oneOf: Object.keys(MessageType).map((k) => ({ $ref: `#/definitions/${MessageType[k]}` }))
};

// ---------------------------------------------------------------------------
// 零依赖校验器（支持本 Schema 用到的 JSON Schema 关键字子集）
// ---------------------------------------------------------------------------

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

const patternCache = new Map();
function re(p) {
  if (!patternCache.has(p)) patternCache.set(p, new RegExp(p));
  return patternCache.get(p);
}

function check(schema, value, path, errors) {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/definitions/', '');
    return check(SCHEMA.definitions[name], value, path, errors);
  }
  const start = errors.length;
  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
    return false;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: must be ${types.join('|')}`);
      return false;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !re(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}.${req}: is required`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) check(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: is not allowed`);
    }
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) check(sub, value, path, errors);
  }
  if (schema.if) {
    const probe = [];
    check(schema.if, value, path, probe);
    if (probe.length === 0 && schema.then) check(schema.then, value, path, errors);
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => { const e = []; check(s, value, path, e); return e; });
    const ok = results.filter((e) => e.length === 0).length;
    if (ok !== 1) {
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(ok === 0 ? `${path}: matches no allowed shape (${best[0]})` : `${path}: matches more than one shape`);
    }
  }
  return errors.length === start;
}

/**
 * 校验一条协议消息。
 * @param {unknown} msg 已 JSON.parse 的对象
 * @param {{direction?: 'c2s'|'s2c'}} [opts] 传入方向时，会拒绝不该出现在该方向的类型
 * @returns {{ok: true} | {ok: false, errors: string[], code: string}}
 */
export function validateMessage(msg, opts = {}) {
  if (typeOf(msg) !== 'object') return fail(['$: must be object']);
  if (msg.v !== PROTOCOL_VERSION) {
    return { ok: false, code: ErrorCode.UNSUPPORTED_VERSION, errors: [`$.v: unsupported protocol version ${msg.v}`] };
  }
  const def = SCHEMA.definitions[msg.type];
  if (!def || typeof msg.type !== 'string' || !Object.prototype.hasOwnProperty.call(Direction, msg.type)) {
    return fail([`$.type: unknown message type ${JSON.stringify(msg.type)}`]);
  }
  if (opts.direction && !Direction[msg.type].includes(opts.direction)) {
    return { ok: false, code: ErrorCode.FORBIDDEN, errors: [`$.type: "${msg.type}" is not allowed in direction ${opts.direction}`] };
  }
  const errors = [];
  check(def, msg, '$', errors);
  return errors.length ? fail(errors) : { ok: true };
}

function fail(errors) {
  return { ok: false, code: ErrorCode.SCHEMA_VIOLATION, errors };
}

/** 是否为业务事件信封（插件用于区分“页面事件”和 ack/error/broadcast） */
export function isBusinessEvent(msg) {
  return !!msg && msg.type === MessageType.EVENT;
}

// ---------------------------------------------------------------------------
// 构造辅助函数（两端共用，保证字段一致）
// ---------------------------------------------------------------------------

export function randomId(prefix = '') {
  const c = globalThis.crypto;
  const raw = c && c.randomUUID ? c.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 14));
  return (prefix + raw).slice(0, 64);
}

export function makeEnvelope(type, fields = {}, now = Date.now()) {
  return { v: PROTOCOL_VERSION, type, id: randomId('m'), ts: now, ...fields };
}

/** FNV-1a 64 位哈希（十六进制），用于生成稳定 event_id */
export function fnv1a64(str) {
  let h1 = 0x811c9dc5 | 0; let h2 = 0xcbf29ce4 | 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 7);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * 稳定 event_id：同一会话、同一消息、同一事件类型、同一内容 → 同一 event_id。
 * 页面重复观察/插件重连重发都会得到同一个 id，由后端 UNIQUE 约束去重。
 */
export function stableEventId(eventType, conversationId, discriminator) {
  const short = eventType.replace(/[^a-z]/g, '').slice(0, 6);
  return `${short}:${fnv1a64(`${eventType}|${conversationId ?? ''}|${discriminator}`)}`;
}
