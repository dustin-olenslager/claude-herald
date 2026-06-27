import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TOKEN = crypto.randomBytes(16).toString('hex'); // ephemeral, never persisted
let server;
let base;

before(async () => {
  process.env.APPROVAL_PORT = '0'; // ephemeral port — set before module eval
  const { start, setEventHandler } = await import('../src/approval-server.mjs');
  setEventHandler(async () => {});
  server = start(TOKEN);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); });

function postEvent(headers) {
  return fetch(`${base}/event?chatId=123`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ event: 'progress', message: 'hi' }),
  });
}

test('/event without secret → 401', async () => {
  const r = await postEvent({});
  assert.equal(r.status, 401);
});

test('/event with wrong secret → 401', async () => {
  const r = await postEvent({ 'x-herald-secret': 'nope' });
  assert.equal(r.status, 401);
});

test('/event with correct secret → 202 accepted', async () => {
  const r = await postEvent({ 'x-herald-secret': TOKEN });
  assert.equal(r.status, 202);
  const j = await r.json();
  assert.equal(j.ok, true);
});

test('/notify without secret → 401', async () => {
  const r = await fetch(`${base}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: 1, container: 'x', tmuxTarget: 'cc-main:0.0' }),
  });
  assert.equal(r.status, 401);
});
