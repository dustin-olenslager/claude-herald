import http from 'node:http';
import crypto from 'node:crypto';

const TIMEOUT_MS = (Number(process.env.APPROVAL_TIMEOUT_SECONDS) || 300) * 1000;
const PORT = Number(process.env.APPROVAL_PORT) || 7788;

const pending = new Map(); // requestId -> { resolve, chatId, ts, timer }

// Called by hook script (HTTP). Returns 200 (approved) or 403 (denied) after user tap or timeout.
// Body: { chatId, sessionId, toolName, command, cwd, mode }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

let onApprovalRequest = null; // injected by bot.mjs — fn({requestId, ...payload}) → sends Telegram message

export function setApprovalHandler(fn) {
  onApprovalRequest = fn;
}

export function start() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/approve') {
      res.writeHead(404).end('not found');
      return;
    }
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
    pending.set(requestId, {
      resolve: settle,
      chatId,
      ts: Date.now(),
      timer,
      command,
      toolName,
    });
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

export function getPending(requestId) {
  return pending.get(requestId);
}

export function listPendingByChat(chatId) {
  return Array.from(pending.entries())
    .filter(([, rec]) => rec.chatId === chatId)
    .map(([id, rec]) => ({ id, ...rec }));
}
