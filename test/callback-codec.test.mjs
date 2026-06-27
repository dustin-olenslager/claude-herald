import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, enc } from '../src/callback-codec.mjs';

test('decode: bare verbs', () => {
  for (const k of ['details', 'continue', 'new', 'stop', 'settings', 'menu:close', 'noop']) {
    assert.deepEqual(decode(k), { kind: k });
  }
});

test('decode: confirm yes/no', () => {
  assert.deepEqual(decode('confirm:y'), { kind: 'confirm', answer: 'Yes' });
  assert.deepEqual(decode('confirm:n'), { kind: 'confirm', answer: 'No' });
});

test('decode: ask pick + other', () => {
  assert.deepEqual(decode('ask:2:1'), { kind: 'ask', idx: 2, pick: '1' });
  assert.deepEqual(decode('ask:0:x'), { kind: 'ask', idx: 0, pick: 'x' });
});

test('decode: mode/model', () => {
  assert.deepEqual(decode('mode:yolo'), { kind: 'mode', value: 'yolo' });
  assert.deepEqual(decode('model:opus'), { kind: 'model', value: 'opus' });
});

test('decode: appr carries id + verdict', () => {
  assert.deepEqual(decode('appr:y:abcd1234'), { kind: 'appr', ok: true, requestId: 'abcd1234' });
  assert.deepEqual(decode('appr:n:deadbeef'), { kind: 'appr', ok: false, requestId: 'deadbeef' });
});

test('decode: notif key/reply/esc with token as last field', () => {
  assert.deepEqual(decode('notif:k:2:tok99'), { kind: 'notif', verb: 'k', key: '2', token: 'tok99' });
  assert.deepEqual(decode('notif:reply:tok99'), { kind: 'notif', verb: 'reply', key: 'tok99', token: 'tok99' });
  assert.deepEqual(decode('notif:esc:tok99'), { kind: 'notif', verb: 'esc', key: 'tok99', token: 'tok99' });
});

test('decode: pr verbs', () => {
  assert.deepEqual(decode('pr:view:5'), { kind: 'pr', verb: 'view', num: '5' });
  assert.deepEqual(decode('pr:merge:5'), { kind: 'pr', verb: 'merge', num: '5' });
});

test('decode: unknown falls through', () => {
  assert.deepEqual(decode('bogus:thing'), { kind: 'unknown', raw: 'bogus:thing' });
});

// Round-trip: every encoder produces a string the decoder reads back correctly.
test('round-trip: confirm', () => {
  assert.equal(decode(enc.confirm(true)).answer, 'Yes');
  assert.equal(decode(enc.confirm(false)).answer, 'No');
});

test('round-trip: ask', () => {
  const d = decode(enc.ask(3, 'x'));
  assert.equal(d.idx, 3); assert.equal(d.pick, 'x');
});

test('round-trip: appr', () => {
  const d = decode(enc.appr(true, 'ID1'));
  assert.equal(d.ok, true); assert.equal(d.requestId, 'ID1');
});

test('round-trip: notif key + reply + esc', () => {
  assert.equal(decode(enc.notifKey('1', 't')).token, 't');
  assert.equal(decode(enc.notifReply('t')).verb, 'reply');
  assert.equal(decode(enc.notifEsc('t')).verb, 'esc');
});

test('round-trip: pr encoders', () => {
  assert.equal(decode(enc.prView('7')).verb, 'view');
  assert.equal(decode(enc.prReview('7')).verb, 'review');
  assert.equal(decode(enc.prApprove('7')).verb, 'approve');
  assert.equal(decode(enc.prMerge('7')).verb, 'merge');
});

test('round-trip: mode/model', () => {
  assert.equal(decode(enc.mode('strict')).value, 'strict');
  assert.equal(decode(enc.model('haiku')).value, 'haiku');
});

// The keyboards in telegram.mjs/ask-flow.mjs emit literal wire strings; assert the
// codec agrees with those exact shapes so a producer/router drift fails here.
import { approvalKeyboard, notifyKeyboard } from '../src/telegram.mjs';
import { askKeyboard } from '../src/ask-flow.mjs';

test('producer parity: approvalKeyboard data decodes', () => {
  const data = approvalKeyboard('REQ')[Symbol.iterator] ? null : approvalKeyboard('REQ').inline_keyboard[0][0].callback_data;
  assert.deepEqual(decode(data), { kind: 'appr', ok: true, requestId: 'REQ' });
});

test('producer parity: notifyKeyboard data decodes', () => {
  const rows = notifyKeyboard('TK').inline_keyboard;
  assert.deepEqual(decode(rows[0][0].callback_data), { kind: 'notif', verb: 'k', key: '1', token: 'TK' });
  assert.deepEqual(decode(rows[1][0].callback_data), { kind: 'notif', verb: 'reply', key: 'TK', token: 'TK' });
  assert.deepEqual(decode(rows[1][1].callback_data), { kind: 'notif', verb: 'esc', key: 'TK', token: 'TK' });
});

test('producer parity: askKeyboard data decodes', () => {
  const items = [{ q: 'Q', opts: ['a', 'b'] }];
  const rows = askKeyboard(items, 0).inline_keyboard;
  assert.deepEqual(decode(rows[0][0].callback_data), { kind: 'ask', idx: 0, pick: '0' });
  assert.deepEqual(decode(rows[2][0].callback_data), { kind: 'ask', idx: 0, pick: 'x' });
});
