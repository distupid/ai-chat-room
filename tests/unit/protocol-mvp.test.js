/**
 * MVP 三功能契约锁定（文件上传 / DOM 选择器 / 聊天同步）。
 *
 * 依据 contracts/MVP_FREEZE.md：联调期间只许加字段、不许改现有字段。
 * 本文件把冻结的取值钉死：合法信封通过、越界/未知取值拒绝。
 *
 * 注意：CommandAction.PROBE_SITE / SYNC_SITES、ConversationStatus.DELETED 常量待批（A1 统一加），
 * 本文件用字面量断言，待常量落地后测试依然成立。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnvelope, validateMessage, Limits } from '../../contracts/protocol.js';

const cmd = (action, fields = {}) =>
  makeEnvelope('command', { command_id: 'cmd-mvp-0001', action, conversation_id: 'conv-mvp-0001', ...fields });

const statusEvent = (status) =>
  makeEnvelope('event', {
    event_id: 'evt-mvp-0001', event_type: 'conversation.status', occurred_at: Date.now(),
    conversation_id: 'conv-mvp-0001', payload: { source: 'chatgpt', status, detail: null },
  });

function mustPass(env, direction, label) {
  const v = validateMessage(env, { direction });
  assert.ok(v.ok, `${label}: ${JSON.stringify(v.errors)}`);
}

function mustFail(env, direction, label) {
  const v = validateMessage(env, { direction });
  assert.ok(!v.ok, `${label}: 应当校验失败`);
}

const goodAttachment = () => ({
  id: 'att-00000001', name: '报告.pdf', type: 'application/pdf', size: 12345, url: '/api/attachments/att-00000001',
});

test('文件上传：command.reply 携带合法附件，c2s / s2c 都通过校验', () => {
  const env = cmd('reply', { text: '看下这份报告', attachments: [goodAttachment()] });
  mustPass(env, 'c2s', '看板 → 后端');
  mustPass(env, 's2c', '后端 → 插件（转发时填写 url）');
});

test('文件上传：附件超过 10 个被拒绝', () => {
  const atts = Array.from({ length: 11 }, (_, i) => ({ ...goodAttachment(), id: `att-0000${String(i).padStart(4, '0')}` }));
  mustFail(cmd('reply', { text: 'x', attachments: atts }), 'c2s', '11 个附件');
});

test('文件上传：附件字段越界被拒绝（id / name / type / size / url）', () => {
  const cases = [
    [{ ...goodAttachment(), id: 'short' }, 'id 太短（<8）'],
    [{ ...goodAttachment(), id: 'x'.repeat(65) }, 'id 太长（>64）'],
    [{ ...goodAttachment(), id: 'bad id!' }, 'id 非法字符'],
    [{ ...goodAttachment(), name: '' }, 'name 为空'],
    [{ ...goodAttachment(), name: 'x'.repeat(256) }, 'name 太长（>255）'],
    [{ ...goodAttachment(), type: 'x'.repeat(129) }, 'type 太长（>128）'],
    [{ ...goodAttachment(), size: -1 }, 'size 为负'],
    [{ ...goodAttachment(), size: 1.5 }, 'size 非整数'],
    [{ ...goodAttachment(), url: 'x'.repeat(301) }, 'url 太长（>300）'],
  ];
  for (const [att, label] of cases) mustFail(cmd('reply', { text: 'x', attachments: [att] }), 'c2s', label);
});

test('文件上传：附件缺必填字段 / 结构非法被拒绝', () => {
  mustFail(cmd('reply', { text: 'x', attachments: [{ name: 'a.pdf' }] }), 'c2s', '缺 id');
  mustFail(cmd('reply', { text: 'x', attachments: [{ id: 'att-00000002' }] }), 'c2s', '缺 name');
  mustFail(cmd('reply', { text: 'x', attachments: 'not-an-array' }), 'c2s', 'attachments 非数组');
});

test('文件上传：Limits 冻结值（附件数 / 单文件上限 / 指令文本上限）', () => {
  assert.equal(Limits.MAX_ATTACHMENTS, 10);
  assert.equal(Limits.MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024);
  assert.equal(Limits.MAX_COMMAND_TEXT, 20000);
});

test('文件上传：command.text 超过上限被拒绝', () => {
  mustFail(cmd('reply', { text: 'x'.repeat(20001) }), 'c2s', 'text 超过 MAX_COMMAND_TEXT');
});

test('DOM 选择器：probe_site 指令信封通过校验（后端 → 插件）', () => {
  mustPass(cmd('probe_site', { conversation_id: 'probe', text: 'https://chat.example.com/c/abc12345def' }), 's2c', 'probe_site');
});

test('DOM 选择器：sync_sites 指令信封通过校验（后端 → 插件）', () => {
  mustPass(cmd('sync_sites', { conversation_id: 'sites' }), 's2c', 'sync_sites');
});

test('DOM 选择器：未知的 action 被拒绝', () => {
  mustFail(cmd('launch_missiles', {}), 's2c', '未知 action');
  mustFail(cmd('probe_site', { conversation_id: '' }), 's2c', 'conversation_id 为空');
});

test('聊天同步：conversation.status 四种取值都通过校验（含 deleted）', () => {
  for (const s of ['ok', 'limit_reached', 'error', 'deleted']) mustPass(statusEvent(s), 'c2s', `status=${s}`);
});

test('聊天同步：conversation.status 未知取值被拒绝', () => {
  mustFail(statusEvent('archived'), 'c2s', '未知 status');
});
