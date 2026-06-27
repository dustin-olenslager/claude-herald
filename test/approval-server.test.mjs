import { test } from 'node:test';
import assert from 'node:assert/strict';

// Bind a deterministic port BEFORE importing the module (PORT is read at load).
const PORT = 7799;
process.env.APPROVAL_PORT = String(PORT);
const approval = await import('../src/approval-server.mjs');

const SECRET = 'test-secret-xyz';
const URL_BASE = `http://127.0.0.1:${PORT}`;
const server = approval.start(SECRET);
await new Promise((r) => setTimeout(r, 50)); // let listen settle

function post(path, body, { secret = SECRET } = {}) {
  return fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-herald-secret': secret },
    body: JSON.stringify(body),
  });
}

test('/approve forwards the originating thread to the handler', async () => {
  let captured;
  approval.setApprovalHandler(async (payload) => {
    captured = payload;
    approval.respondTo(payload.requestId, true); // settle so the request returns 200
  });
  const r = await post('/approve', { chatId: 555, thread: 42, toolName: 'Bash', command: 'git push', mode: 'guided' });
  assert.equal(r.status, 200);
  assert.equal(captured.chatId, 555);
  assert.equal(captured.thread, 42);
});

test('/approve rejects a wrong secret with 401', async () => {
  const r = await post('/approve', { chatId: 1, toolName: 'Bash' }, { secret: 'nope' });
  assert.equal(r.status, 401);
});

test('/event carries chatId + thread from the query string', async () => {
  let captured;
  approval.setEventHandler(async (p) => { captured = p; });
  const r = await post(`/event?chatId=99&thread=42`, { event: 'progress', repo: '/workspace/frame-forge' });
  assert.equal(r.status, 202);
  await new Promise((res) => setTimeout(res, 20)); // handler is fire-and-forget
  assert.equal(captured.chatId, 99);
  assert.equal(Number(captured.thread), 42);
});

test('/event with no thread leaves it empty (cron/cold-start name-creates)', async () => {
  let captured;
  approval.setEventHandler(async (p) => { captured = p; });
  const r = await post('/event', { chatId: 99, event: 'done', repo: '/workspace/fonto' });
  assert.equal(r.status, 202);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(captured.thread, '');
  assert.equal(captured.repo, '/workspace/fonto');
});

test.after(() => server.close());
