import http from 'node:http';
import crypto from 'node:crypto';

const TIMEOUT_MS = (Number(process.env.APPROVAL_TIMEOUT_SECONDS) || 300) * 1000;
const NOTIFY_TTL_MS = (Number(process.env.NOTIFY_TTL_SECONDS) || 3600) * 1000;
const PORT = Number(process.env.APPROVAL_PORT) || 7788;

const pending = new Map();   // requestId -> { resolve, chatId, ts, timer, ... }
const notifyTokens = new Map(); // token -> { chatId, container, target, sessionId, ts }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

let onApprovalRequest = null;
let onNotifyRequest = null;
let onEvent = null;
let chatIdResolver = null;

export function setApprovalHandler(fn) { onApprovalRequest = fn; }
export function setNotifyHandler(fn) { onNotifyRequest = fn; }
// Fire-and-forget status events from the autonomous supervisor (no interactive token).
export function setEventHandler(fn) { onEvent = fn; }
// Optional: fn() → chatId (number). Used when the hook caller can't supply chatId itself.
export function setChatIdResolver(fn) { chatIdResolver = fn; }

async function handleApprove(req, res) {
  let body;
  try { body = await readBody(req); } catch {
    res.writeHead(400).end('bad json');
    return;
  }
  const { chatId, toolName, command, cwd, mode, sessionId } = body;
  if (!chatId) {
    res.writeHead(400).end('chatId required');
    return;
  }
  const requestId = crypto.randomBytes(8).toString('hex');
  let settled = false;
  const settle = (approved, reason) => {
    if (settled) return;
    settled = true;
    pending.delete(requestId);
    if (approved) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ approved: true }));
    } else {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ approved: false, reason }));
    }
  };
  const timer = setTimeout(() => settle(false, 'timeout: no response from user'), TIMEOUT_MS);
  pending.set(requestId, { resolve: settle, chatId, ts: Date.now(), timer, command, toolName });
  if (onApprovalRequest) {
    onApprovalRequest({ requestId, chatId, toolName, command, cwd, mode, sessionId }).catch((e) => {
      console.error('approval handler error:', e);
      settle(false, 'bot failed to send approval prompt');
    });
  } else {
    settle(false, 'bot not ready');
  }
  req.on('close', () => {
    if (!settled) {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  });
}

async function handleNotify(req, res) {
  let body;
  try { body = await readBody(req); } catch {
    res.writeHead(400).end('bad json');
    return;
  }
  let { chatId } = body;
  const { message, sessionId, container, tmuxTarget, cwd } = body;
  if (!chatId && chatIdResolver) {
    try { chatId = await chatIdResolver(); } catch {}
  }
  if (!chatId || !container || !tmuxTarget) {
    res.writeHead(400).end('chatId (or resolver), container, tmuxTarget required');
    return;
  }
  const token = crypto.randomBytes(6).toString('hex');
  notifyTokens.set(token, {
    chatId, container, target: tmuxTarget, sessionId, cwd,
    ts: Date.now(),
  });
  // Fire-and-forget: CC's Notification hook doesn't block on response.
  res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token }));
  // Purge expired tokens lazily.
  for (const [k, v] of notifyTokens) {
    if (Date.now() - v.ts > NOTIFY_TTL_MS) notifyTokens.delete(k);
  }
  if (onNotifyRequest) {
    onNotifyRequest({ token, chatId, message, sessionId, container, tmuxTarget, cwd }).catch((e) => {
      console.error('notify handler error:', e);
    });
  }
}

// Fire-and-forget status event from the Phalanx supervisor (start/progress/done/blocked).
// Unlike /notify, this is a plain message — no interactive token/tmux Reply button.
async function handleEvent(req, res) {
  let body;
  try { body = await readBody(req); } catch { res.writeHead(400).end('bad json'); return; }
  let { chatId } = body;
  if (!chatId) { try { const qc = new URL(req.url, 'http://x').searchParams.get('chatId'); if (qc) chatId = Number(qc) || qc; } catch {} }
  const { event, message, repo, thread } = body;
  if (!chatId && chatIdResolver) { try { chatId = await chatIdResolver(); } catch {} }
  if (!chatId) { res.writeHead(400).end('chatId (or resolver) required'); return; }
  res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  if (onEvent) {
    onEvent({ chatId, event: event || 'info', message: message || '', repo: repo || '', thread: thread || '' })
      .catch((e) => console.error('event handler error:', e));
  }
}

// Constant-time secret check. Length-guard first (timingSafeEqual throws on
// length mismatch). Bound to 0.0.0.0 cross-container, so the secret IS the auth.
function authOk(req, secret) {
  const got = req.headers['x-herald-secret'];
  if (!secret || typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function start(secret) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    const path = (req.url || '').split('?')[0];
    if (path === '/approve' || path === '/notify' || path === '/event') {
      if (!authOk(req, secret)) {
        res.writeHead(401).end('unauthorized');
        return;
      }
    }
    if (path === '/approve') return handleApprove(req, res);
    if (path === '/notify') return handleNotify(req, res);
    if (path === '/event') return handleEvent(req, res);
    res.writeHead(404).end('not found');
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`approval server listening on :${PORT}`);
  });
  return server;
}

export function respondTo(requestId, approved, reason) {
  const rec = pending.get(requestId);
  if (!rec) return false;
  clearTimeout(rec.timer);
  rec.resolve(approved, reason);
  return true;
}

export function getNotifyToken(token) {
  return notifyTokens.get(token);
}

export function deleteNotifyToken(token) {
  notifyTokens.delete(token);
}

export function rewriteNotifyContainer(token, container) {
  const rec = notifyTokens.get(token);
  if (rec) rec.container = container;
}
