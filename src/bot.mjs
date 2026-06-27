import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import crypto from 'node:crypto';
const execFileP = promisify(execFile);
import * as state from './state.mjs';
import * as settings from './settings.mjs';
import * as approval from './approval-server.mjs';
import * as gh from './github.mjs';
import { TLDR_INSTRUCTION, splitTldr, costFooter } from './tldr.mjs';

const TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USERNAME = (process.env.ALLOWED_USERNAME || '').replace(/^@/, '');
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? Number(process.env.ALLOWED_USER_ID) : null;
const TARGET_CONTAINER = process.env.TARGET_CONTAINER || 'claude-code-rc';
const TARGET_USER = process.env.TARGET_USER || 'cc';
const TARGET_WORKDIR = process.env.TARGET_WORKDIR || '/workspace';
const CLAUDE_TIMEOUT_MS = process.env.CLAUDE_TIMEOUT_MS != null ? Number(process.env.CLAUDE_TIMEOUT_MS) : 600000;
// Claude Code's own default API request timeout is 600000ms (10 min). A non-login
// `docker exec` does NOT inherit the target container's interactive-shell env, so these
// must be passed through explicitly or long turns get killed at 10 min.
const API_TIMEOUT_MS = process.env.CLAUDE_API_TIMEOUT_MS || '3600000';
const BASH_DEFAULT_TIMEOUT_MS = process.env.CLAUDE_BASH_DEFAULT_TIMEOUT_MS || '300000';
const BASH_MAX_TIMEOUT_MS = process.env.CLAUDE_BASH_MAX_TIMEOUT_MS || '3600000';
const APPROVAL_PORT = Number(process.env.APPROVAL_PORT) || 7788;
const HOOK_SRC = process.env.HOOK_SRC || '/app/hooks/pretooluse-gate.sh';
const HOOK_PATH = process.env.HOOK_PATH || '/usr/local/bin/herald-pretooluse-gate.sh';
const NOTIFY_HOOK_SRC = process.env.NOTIFY_HOOK_SRC || '/app/hooks/notify-tg.sh';
const NOTIFY_HOOK_PATH = process.env.NOTIFY_HOOK_PATH || '/usr/local/bin/herald-notify-tg.sh';
const TMUX_LAUNCHER_SRC = process.env.TMUX_LAUNCHER_SRC || '/app/hooks/herald-tmux.sh';
const TMUX_LAUNCHER_PATH = process.env.TMUX_LAUNCHER_PATH || '/usr/local/bin/herald-tmux';
const BOT_URL_FOR_HOOK = process.env.BOT_URL_FOR_HOOK || `http://herald:${APPROVAL_PORT}`;
// Phalanx no-babysit: when an inline run leaves work unfinished, hand the repo to the
// detached supervisor to finish across fresh sessions. Disable with PHALANX_AUTOESCALATE=0.
const AUTO_ESCALATE = process.env.PHALANX_AUTOESCALATE !== '0';
const SUPERVISORD_PATH = process.env.SUPERVISORD_PATH || '/home/cc/.claude/supervisord.sh';

if (!TOKEN) { console.error('BOT_TOKEN required'); process.exit(1); }
if (!ALLOWED_USERNAME && !ALLOWED_USER_ID) { console.error('ALLOWED_USERNAME or ALLOWED_USER_ID required'); process.exit(1); }

const API = `https://api.telegram.org/bot${TOKEN}`;

// Shared HTTP-boundary secret (persisted in state.json; readable by the host cron).
const HOOK_SECRET = state.ensureHookSecret();

const runningProcs = new Map(); // sk -> { child, startedAt }

// Only targets matching herald-tmux.sh's scheme (<session>:0.0) may receive
// send-keys, so a rogue /notify caller can't aim keystrokes at an arbitrary pane.
const TMUX_TARGET_RE = /^[A-Za-z0-9_.-]+:0\.0$/;

// Scope key: each forum topic (message_thread_id) is its own independent session.
// Non-forum / General topic (no threadId) keeps today's flat per-chat scope.
function topicKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

// ── Telegram helpers ──────────────────────────────────────────────

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function sendChunked(chatId, text, { code = false, markup, threadId } = {}) {
  if (!text) text = '(empty)';
  const wrap = code ? (s) => '```\n' + s + '\n```' : (s) => s;
  const limit = code ? 3900 : 4000;
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await tg('sendMessage', {
      chat_id: chatId,
      message_thread_id: threadId || undefined,
      text: wrap(chunks[i]),
      parse_mode: code ? 'MarkdownV2' : undefined,
      disable_web_page_preview: true,
      reply_markup: isLast && markup ? markup : undefined,
    });
  }
}

// Auto-create (once) a forum topic per job name so each repo's reports land in their
// own thread instead of one blurred feed. Caches the id; caches 0 when the chat is not
// a forum (no rights / not a supergroup-with-topics) so we fall back to flat and never
// retry. Returns a message_thread_id, or undefined to send flat (today's behavior).
async function topicFor(chatId, name) {
  if (!name) return undefined;
  const cached = state.getTopic(chatId, name);
  if (cached !== undefined) return cached || undefined; // 0 -> flat
  const r = await tg('createForumTopic', { chat_id: chatId, name: String(name).slice(0, 128) }).catch(() => null);
  const id = (r && r.ok && r.result && r.result.message_thread_id) || 0;
  state.setTopic(chatId, name, id); // 0 = flat (not a forum / no rights)
  return id || undefined;
}

// ── Image/file handling ───────────────────────────────────────────

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

async function downloadTgFile(fileId, ext = '.bin') {
  const gf = await tg('getFile', { file_id: fileId });
  if (!gf.ok) return { error: gf.description || 'getFile failed' };
  const tgPath = gf.result.file_path;
  const url = `https://api.telegram.org/file/bot${TOKEN}/${tgPath}`;
  const res = await fetch(url);
  if (!res.ok) return { error: `download ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const stem = `herald-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const localPath = `/tmp/${stem}`;
  fs.writeFileSync(localPath, buf);
  // Copy into target container at the same path so claude can Read it.
  try {
    await execFileP('docker', ['cp', localPath, `${TARGET_CONTAINER}:${localPath}`]);
    await execFileP('docker', ['exec', '-u', 'root', TARGET_CONTAINER, 'chmod', '644', localPath]);
  } catch (e) {
    return { error: `copy to target failed: ${String(e.message).slice(0, 200)}` };
  } finally {
    try { fs.unlinkSync(localPath); } catch {}
  }
  return { path: localPath, bytes: buf.length };
}

async function handleImageMessage(msg, fileId, mime, captionOverride) {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const sk = topicKey(chatId, threadId);
  if (runningProcs.has(sk)) {
    return sendChunked(chatId, '⏳ Task running — image NOT sent. Stop first.', { markup: defaultKeyboard(sk), threadId });
  }
  await tg('sendChatAction', { chat_id: chatId, message_thread_id: threadId || undefined, action: 'upload_photo' });
  const ext = EXT_BY_MIME[mime] || '.jpg';
  const { path, bytes, error } = await downloadTgFile(fileId, ext);
  if (error) return sendChunked(chatId, `⚠️ Image failed: ${error}`, { threadId });
  const caption = (captionOverride || msg.caption || '').trim();
  const userText = caption || 'What do you see in this image? Describe and suggest any action.';
  const prompt = `[User attached an image. It is available in the target container at ${path} (${bytes} bytes, ${mime}). Use the Read tool on that path to view it.]\n\n${userText}`;
  await runAndSend(chatId, prompt, sk, threadId);
}

function authorized(from) {
  if (!from) return false;
  if (ALLOWED_USER_ID && from.id === ALLOWED_USER_ID) return true;
  if (ALLOWED_USERNAME && from.username && from.username.toLowerCase() === ALLOWED_USERNAME.toLowerCase()) return true;
  return false;
}

// ── Keyboards ─────────────────────────────────────────────────────

function defaultKeyboard(sk) {
  const hasSession = !!state.getSession(sk);
  const running = runningProcs.has(sk);
  const hasDetails = !!state.getLastResponse(sk)?.details;
  const row1 = [];
  if (hasDetails) row1.push({ text: '📖 Details', callback_data: 'details' });
  if (hasSession && !running) row1.push({ text: '➡️ Continue', callback_data: 'continue' });
  const row2 = [];
  if (running) row2.push({ text: '🛑 Stop', callback_data: 'stop' });
  if (hasSession && !running) row2.push({ text: '🆕 New', callback_data: 'new' });
  row2.push({ text: '⚙️ Settings', callback_data: 'settings' });
  const rows = [];
  if (row1.length) rows.push(row1);
  if (row2.length) rows.push(row2);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// True when a reply ends in a yes/no-style question (not a wh- question), so we offer
// one-tap ✅/❌ instead of making the operator type back.
function detectYesNo(text) {
  const tail = text.slice(-600);
  const m = tail.match(/([^\n.!?]*\?)\s*(?:\[.*?\])?\s*$/);
  if (!m) return false;
  const q = m[1].trim().toLowerCase();
  return !/^(which|what|how|when|where|who|why)\b/.test(q);
}

// Yes/No row prepended above the normal controls. Scoped per sk like defaultKeyboard.
function questionKeyboard(sk) {
  const base = defaultKeyboard(sk);
  const baseRows = base?.inline_keyboard ?? [];
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes', callback_data: 'confirm:y' },
        { text: '❌ No', callback_data: 'confirm:n' },
      ],
      ...baseRows,
    ],
  };
}

function approvalKeyboard(requestId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `appr:y:${requestId}` },
        { text: '❌ Deny', callback_data: `appr:n:${requestId}` },
      ],
      [
        { text: '⏱ Allow this session', callback_data: `appr:s:${requestId}` },
      ],
    ],
  };
}

function notifyKeyboard(token) {
  return {
    inline_keyboard: [
      [
        { text: '1', callback_data: `notif:k:1:${token}` },
        { text: '2', callback_data: `notif:k:2:${token}` },
        { text: '3', callback_data: `notif:k:3:${token}` },
      ],
      [
        { text: '✏️ Reply', callback_data: `notif:reply:${token}` },
        { text: '⛔ Esc', callback_data: `notif:esc:${token}` },
      ],
    ],
  };
}

// ── Blocking-decision (ASK) queue ─────────────────────────────────
// The agent emits <<ASK>>[{q,opts[]}]<<END>> when blocked on the operator; we ask
// one question at a time with numbered buttons, collect, then resume the session.
const ASK_INSTRUCTION = `When you are blocked and need the operator to make one or more decisions, end your reply with a single machine-readable block (and a short human summary BEFORE it):
<<ASK>>
[{"q":"<question>","opts":["<choice 1>","<choice 2>"]}]
<<END>>
One object per decision, 2-4 short opts each. Only emit it when genuinely blocked on the operator.`;

const askQueues = new Map();       // sk -> { items:[{q,opts}], answers:[], idx }
const askPendingOther = new Map(); // sk -> idx awaiting a typed custom answer

function parseAsk(text) {
  const m = (text || '').match(/<<ASK>>\s*([\s\S]*?)\s*<<END>>/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return null;
    return arr
      .filter((x) => x && x.q && Array.isArray(x.opts) && x.opts.length)
      .map((x) => ({ q: String(x.q), opts: x.opts.slice(0, 4).map(String) }));
  } catch { return null; }
}
function stripAsk(text) { return (text || '').replace(/<<ASK>>[\s\S]*?<<END>>/g, '').trim(); }

function askKeyboard(items, idx) {
  const rows = items[idx].opts.map((o, i) => [{ text: `${i + 1} · ${o}`.slice(0, 60), callback_data: `ask:${idx}:${i}` }]);
  rows.push([{ text: '✏️ Other', callback_data: `ask:${idx}:x` }]);
  return { inline_keyboard: rows };
}
async function presentAsk(chatId, sk, threadId) {
  const q = askQueues.get(sk);
  if (!q) return;
  const item = q.items[q.idx];
  await sendChunked(chatId, `❓ Q${q.idx + 1}/${q.items.length}: ${item.q}`, { threadId, markup: askKeyboard(q.items, q.idx) });
}
function startAskQueue(chatId, sk, threadId, items) {
  askQueues.set(sk, { items, answers: [], idx: 0 });
  return presentAsk(chatId, sk, threadId);
}
async function advanceAsk(chatId, sk, threadId) {
  const q = askQueues.get(sk);
  if (!q) return;
  q.idx += 1;
  if (q.idx < q.items.length) return presentAsk(chatId, sk, threadId);
  askQueues.delete(sk);
  const compiled = q.items.map((it, i) => `${i + 1}. ${it.q} → ${q.answers[i]}`).join('\n');
  await sendChunked(chatId, `Got it:\n${compiled}`, { threadId });
  return runAndSend(chatId, `My decisions:\n${compiled}`, sk, threadId);
}

// Send keystrokes into an interactive Claude session running in tmux inside a container.
// `text` is appended with Enter unless it's the literal sentinel 'ESC' (sent as Escape key).
async function sendTmuxKeys(container, target, text) {
  // Pin the container — never trust a client-supplied one — and validate the
  // target against the known herald-tmux scheme before injecting keystrokes.
  if (!TMUX_TARGET_RE.test(String(target || ''))) {
    throw new Error(`refusing send-keys to unknown tmux target: ${target}`);
  }
  const args = ['exec', '-u', TARGET_USER, TARGET_CONTAINER, 'tmux', 'send-keys', '-t', target];
  if (text === 'ESC') {
    args.push('Escape');
  } else {
    args.push(text, 'Enter');
  }
  await execFileP('docker', args);
}

// ── Claude invocation ─────────────────────────────────────────────

// ── Autonomous supervisor hand-off (Phalanx no-babysit) ───────────

// True if cwd/TASKS.md has at least one open "- [ ]" item in the target container.
async function repoHasOpenTasks(cwd) {
  try {
    await execFileP('docker', ['exec', '-u', TARGET_USER, TARGET_CONTAINER,
      'bash', '-c', 'grep -Eq "^[[:space:]]*-[[:space:]]*\\[ \\]" "$1"/TASKS.md', '_', cwd]);
    return true;            // grep -q exit 0 = an open task remains
  } catch { return false; } // exit 1 (no open tasks) or no TASKS.md
}

// Launch the detached supervisor in the target container; it relaunches fresh
// `claude -p "/work"` passes until the backlog is done/BLOCKED, posting status to
// our /event endpoint (-> Telegram). Idempotent: supervisord refuses a second one.
async function launchSupervisor(cwd, chatId) {
  const notifyUrl = `${BOT_URL_FOR_HOOK}/event${chatId ? `?chatId=${chatId}` : ''}`;
  await execFileP('docker', ['exec', '-u', TARGET_USER,
    '-e', `PHALANX_NOTIFY_URL=${notifyUrl}`,
    '-e', `PHALANX_NOTIFY_SECRET=${HOOK_SECRET}`,
    '-e', 'PATH=/home/cc/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
    TARGET_CONTAINER, 'bash', SUPERVISORD_PATH, 'start', '-r', cwd]);
}

// After an inline run, if work is unfinished (open tasks remain, or it timed out),
// hand the repo to the supervisor and tell the user. No-op when nothing's pending.
async function maybeEscalate(chatId, sk, threadId, reason) {
  if (!AUTO_ESCALATE) return false;
  const cwd = state.getRepo(sk);
  if (!(await repoHasOpenTasks(cwd))) return false;
  try { await launchSupervisor(cwd, chatId); }
  catch (e) { console.error('supervisor launch failed:', e); return false; }
  await sendChunked(chatId,
    `🤖 Didn't finish in one pass (${reason}). Handed to the autonomous supervisor — ` +
    `it'll drive it to done across fresh sessions and message you on progress / done / blocked.`,
    { markup: defaultKeyboard(sk), threadId });
  return true;
}

function runClaude(prompt, chatId, sk, threadId) {
  const sessionId = state.getSession(sk);
  const model = state.getModel(sk);
  const mode = state.getMode(sk);
  const cwd = state.getRepo(sk);

  return new Promise((resolve, reject) => {
    const claudeArgs = [
      '-p',
      '--output-format', 'json',
      '--model', model,
      '--append-system-prompt', `${TLDR_INSTRUCTION}\n\n${ASK_INSTRUCTION}`,
    ];
    if (sessionId) claudeArgs.push('--resume', sessionId);

    // Inject our PreToolUse hook via --settings JSON
    const hookSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: HOOK_PATH }],
          },
        ],
      },
    };
    claudeArgs.push('--settings', JSON.stringify(hookSettings));

    // Permission posture: yolo bypasses CC's own prompts; strict/guided let hook do the gating.
    if (mode === 'yolo') {
      claudeArgs.push('--permission-mode', 'bypassPermissions');
    } else {
      claudeArgs.push('--permission-mode', 'bypassPermissions');
      // ^ we still bypass CC's built-in prompts so OUR hook is the only gate. Cleaner UX.
    }

    const dockerArgs = [
      'exec', '-i',
      '-u', TARGET_USER,
      '-w', cwd,
      '-e', `HERALD_CHAT_ID=${chatId}`,
      '-e', `HERALD_MODE=${mode}`,
      '-e', `HERALD_URL=${BOT_URL_FOR_HOOK}`,
      '-e', `HERALD_HOOK_SECRET=${HOOK_SECRET}`,
      '-e', `APPROVAL_TIMEOUT_SECONDS=${process.env.APPROVAL_TIMEOUT_SECONDS || 300}`,
      '-e', 'PATH=/home/cc/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
      '-e', `API_TIMEOUT_MS=${API_TIMEOUT_MS}`,
      '-e', `BASH_DEFAULT_TIMEOUT_MS=${BASH_DEFAULT_TIMEOUT_MS}`,
      '-e', `BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS}`,
      TARGET_CONTAINER,
      'claude', ...claudeArgs,
    ];

    const child = spawn('docker', dockerArgs);
    runningProcs.set(sk, { child, startedAt: Date.now() });
    child.stdin.write(prompt);
    child.stdin.end();

    let out = '', err = '';
    let timedOut = false;
    const killTimer = CLAUDE_TIMEOUT_MS > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS) : null;

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(killTimer); runningProcs.delete(sk); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const wasStopped = runningProcs.get(sk)?.stopRequested;
      runningProcs.delete(sk);
      if (timedOut) return;
      if (wasStopped || signal === 'SIGTERM' || signal === 'SIGKILL' || code === 137 || code === 143) {
        return reject(new Error('stopped'));
      }
      if (code !== 0) {
        return reject(new Error(`claude exit ${code}\nstderr: ${err.slice(0, 2000)}\nstdout: ${out.slice(0, 500)}`));
      }
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`json parse failed: ${e.message}\nfirst 1k: ${out.slice(0, 1000)}`)); }
    });
  });
}

async function runAndSend(chatId, prompt, sk, threadId) {
  await ensureHook();
  askQueues.delete(sk); askPendingOther.delete(sk);
  await tg('sendChatAction', { chat_id: chatId, message_thread_id: threadId || undefined, action: 'typing' });
  const heartbeat = setInterval(() => {
    tg('sendChatAction', { chat_id: chatId, message_thread_id: threadId || undefined, action: 'typing' }).catch(() => {});
  }, 4000);
  try {
    const result = await runClaude(prompt, chatId, sk, threadId);
    state.setSession(sk, result.session_id);
    const body = result.result ?? JSON.stringify(result, null, 2);
    const { tldr, details } = splitTldr(body);
    state.setLastResponse(sk, { tldr, details, model: state.getModel(sk) });
    const ask = parseAsk(body);
    if (ask && ask.length) {
      const preface = stripAsk(tldr);
      if (preface) await sendChunked(chatId, preface, { threadId });
      return startAskQueue(chatId, sk, threadId, ask);
    }
    const markup = detectYesNo(tldr) ? questionKeyboard(sk) : defaultKeyboard(sk);
    await sendChunked(chatId, tldr + costFooter(result, state.getModel(sk)), { markup, threadId });
    await maybeEscalate(chatId, sk, threadId, "reached this pass's context limit");
  } catch (e) {
    if (e.message === 'stopped') {
      await sendChunked(chatId, '🛑 Stopped.', { markup: defaultKeyboard(sk), threadId });
    } else {
      console.error('claude error:', e);
      const full = e.message;
      const containerDown = /container .* is not running|No such container/.test(full);
      let summary;
      if (containerDown) summary = `⚠️ ${TARGET_CONTAINER} not running.`;
      else if (full.includes('timed out')) summary = `⏱️ Timed out after ${Math.round(CLAUDE_TIMEOUT_MS / 60000)} min.`;
      else summary = `⚠️ Claude errored. Tap 📖 Details for full trace.`;
      state.setLastResponse(sk, { tldr: summary, details: full, model: state.getModel(sk) });
      await sendChunked(chatId, summary, { markup: defaultKeyboard(sk), threadId });
      if (full.includes('timed out')) await maybeEscalate(chatId, sk, threadId, 'timed out');
    }
  } finally {
    clearInterval(heartbeat);
  }
}

// ── Approval flow ─────────────────────────────────────────────────

// sk -> { token, container, target, msgId } — set when user taps ✏️ Reply; next msg goes to tmux.
const replyPending = new Map();

approval.setChatIdResolver(() => state.get().knownUserId);

// Phalanx supervisor status events -> plain Telegram message (no Reply button).
approval.setEventHandler(async ({ chatId, event, message, repo, thread }) => {
  const icon = { start: '🚀', progress: '⏳', done: '✅', blocked: '⛔' }[event] || '🤖';
  // Per-job routing key from the notify port: prefer the explicit thread, else the
  // repo basename. Each job's reports land in their own forum topic (flat fallback).
  const name = (thread || (repo ? repo.split('/').pop() : '') || '').trim();
  const threadId = await topicFor(chatId, name).catch(() => undefined);
  await tg('sendMessage', {
    chat_id: chatId,
    message_thread_id: threadId || undefined,
    text: `${icon} ${name ? name + ' — ' : ''}Supervisor: ${event}\n${(message || '').slice(0, 3500)}`,
    disable_web_page_preview: true,
  });
});

approval.setNotifyHandler(async ({ token, chatId, message, container, tmuxTarget, cwd }) => {
  // The hook may have reported its container's hostname (which often != docker container name).
  // Single-target bot owns the source-of-truth: rewrite token's container to TARGET_CONTAINER so
  // downstream send-keys hits the right place regardless of what the hook guessed.
  if (container !== TARGET_CONTAINER) {
    approval.rewriteNotifyContainer(token, TARGET_CONTAINER);
  }
  const text = [
    '🔔 Claude needs you',
    cwd ? `· ${cwd}` : null,
    '',
    (message || '(no message)').slice(0, 3500),
  ].filter(Boolean).join('\n');
  await tg('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: notifyKeyboard(token),
    disable_web_page_preview: true,
  });
});

approval.setApprovalHandler(async ({ requestId, chatId, toolName, command, cwd, mode }) => {
  const lines = [
    `⚠️ Approval needed (${settings.MODE_LABELS[mode] || mode})`,
    '',
    `Tool: ${toolName}`,
    cwd ? `Cwd: ${cwd}` : null,
    '',
    '```',
    (command || '(no command)').slice(0, 1200),
    '```',
  ].filter(Boolean).join('\n');
  await tg('sendMessage', {
    chat_id: chatId,
    text: lines,
    parse_mode: 'Markdown',
    reply_markup: approvalKeyboard(requestId),
  });
});

const sessionAllowAlls = new Map(); // sk -> { allow: true, until: ts }

// ── Commands ──────────────────────────────────────────────────────

function handleStop(chatId, sk, threadId) {
  const rec = runningProcs.get(sk);
  if (!rec) return sendChunked(chatId, 'Nothing running.', { markup: defaultKeyboard(sk), threadId });
  rec.stopRequested = true;
  rec.child.kill('SIGTERM');
  setTimeout(() => { try { rec.child.kill('SIGKILL'); } catch {} }, 3000);
  return sendChunked(chatId, '🛑 Stop sent.', { threadId });
}

async function handleSettings(chatId, sk, threadId) {
  const { text, markup } = settings.settingsMenu(sk);
  return sendChunked(chatId, text, { markup, threadId });
}

async function handlePr(chatId, num, sk, threadId) {
  if (!num || !/^\d+$/.test(num)) return sendChunked(chatId, 'Usage: /pr <number>', { threadId });
  await tg('sendChatAction', { chat_id: chatId, message_thread_id: threadId || undefined, action: 'typing' });
  const cwd = state.getRepo(sk);
  const { pr, error } = await gh.viewPr(cwd, num);
  if (error) return sendChunked(chatId, `gh error: ${error.slice(0, 500)}`, { threadId });
  return sendChunked(chatId, gh.summarizePr(pr), { markup: gh.prKeyboard(pr.number, pr.url), threadId });
}

async function handlePrs(chatId, sk, threadId) {
  await tg('sendChatAction', { chat_id: chatId, message_thread_id: threadId || undefined, action: 'typing' });
  const cwd = state.getRepo(sk);
  const { prs, error } = await gh.listPrs(cwd);
  if (error) return sendChunked(chatId, `gh error: ${error.slice(0, 500)}`, { threadId });
  if (!prs.length) return sendChunked(chatId, 'No open PRs assigned to you.', { threadId });
  const text = prs.map((p) => `#${p.number} ${p.title}\n  ${p.headRefName}`).join('\n\n');
  const markup = {
    inline_keyboard: prs.slice(0, 10).map((p) => [
      { text: `#${p.number} ${p.title.slice(0, 50)}`, callback_data: `pr:view:${p.number}` },
    ]),
  };
  return sendChunked(chatId, text, { markup, threadId });
}

async function handleRepo(chatId, arg, sk, threadId) {
  if (!arg) return sendChunked(chatId, `Current: ${state.getRepo(sk)}\nUsage: /repo <path>`, { threadId });
  state.setRepo(sk, arg);
  return sendChunked(chatId, `Repo → ${arg}`, { markup: defaultKeyboard(sk), threadId });
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const sk = topicKey(chatId, threadId);
  const kinds = Object.keys(msg).filter((k) => !['message_id','from','chat','date','message_thread_id'].includes(k)).join(',');
  console.log(`msg from @${msg.from?.username || '?'} chat=${chatId} thread=${threadId ?? '-'} kinds=[${kinds}]`);
  if (!authorized(msg.from)) {
    console.log(`unauth: @${msg.from?.username || '?'} id=${msg.from?.id}`);
    return;
  }
  if (!state.get().knownUserId && msg.from?.id) {
    state.get().knownUserId = msg.from.id;
    state.save();
  }
  // Remember the forum group's chat id so cold-start supervisors can route to topics.
  if (msg.message_thread_id) state.setForumChatId(chatId);

  // Photo: Telegram sends array of resized variants; last is the largest.
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return handleImageMessage(msg, largest.file_id, 'image/jpeg');
  }
  // Document w/ image mime: user sent image as "file" for full quality.
  if (msg.document && (msg.document.mime_type || '').startsWith('image/')) {
    return handleImageMessage(msg, msg.document.file_id, msg.document.mime_type);
  }
  // Generic (non-image) document: download, copy into target container, hand to Claude.
  if (msg.document) {
    if (runningProcs.has(sk)) {
      return sendChunked(chatId, '⏳ Task running — file NOT sent. Stop first.', { markup: defaultKeyboard(sk), threadId });
    }
    const doc = msg.document;
    const mime = doc.mime_type || 'application/octet-stream';
    const origName = doc.file_name || 'file';
    const ext = origName.includes('.') ? origName.slice(origName.lastIndexOf('.')) : '';
    const { path, bytes, error } = await downloadTgFile(doc.file_id, ext);
    if (error) return sendChunked(chatId, `⚠️ File download failed: ${error}`, { threadId });
    const caption = (msg.caption || '').trim();
    const userText = caption || 'File received. Use it as needed.';
    const prompt = `[User sent a file. It is available in the target container at ${path} (${bytes} bytes, ${mime}, original name: ${origName}). Use the Read tool or Bash to access it.]\n\n${userText}`;
    return runAndSend(chatId, prompt, sk, threadId);
  }
  // Sticker as image (static webp).
  if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
    return handleImageMessage(msg, msg.sticker.file_id, 'image/webp', 'What is this sticker?');
  }

  const text = (msg.text || '').trim();
  if (!text) return;
  // ASK 'Other': a typed answer for a pending custom decision.
  if (askPendingOther.has(sk)) {
    const i = askPendingOther.get(sk); askPendingOther.delete(sk);
    const q = askQueues.get(sk);
    if (q) { q.answers[i] = text; return advanceAsk(chatId, sk, threadId); }
  }

  if (text === '/start' || text === '/help') {
    return sendChunked(chatId,
      'Claude Code Herald\n\n' +
      'Send any message → runs as `claude -p` in target container. Reply is summary + 📖 Details button.\n\n' +
      'Commands:\n' +
      '/settings — mode (strict/guided/yolo) + model\n' +
      '/pr <num> — view PR, approve, merge\n' +
      '/prs — open PRs assigned to you\n' +
      '/repo <path> — change working dir\n' +
      '/new — fresh session\n' +
      '/continue — resume session\n' +
      '/stop — kill running task\n' +
      '/status — session + mode + model\n' +
      '/ping — liveness',
      { markup: defaultKeyboard(sk), threadId }
    );
  }
  if (text === '/ping') return sendChunked(chatId, 'pong', { threadId });
  if (text === '/whoami') return sendChunked(chatId, `user_id=${msg.from?.id}\nusername=@${msg.from?.username}`, { threadId });
  if (text === '/settings' || text === '/menu') return handleSettings(chatId, sk, threadId);
  if (text === '/new') {
    state.clearSession(sk);
    return sendChunked(chatId, '🆕 New session.', { markup: defaultKeyboard(sk), threadId });
  }
  if (text === '/stop') return handleStop(chatId, sk, threadId);
  if (text === '/continue') {
    if (runningProcs.has(sk)) return sendChunked(chatId, '⏳ Already running.', { threadId });
    if (!state.getSession(sk)) return sendChunked(chatId, 'No session. Send a message to start.', { threadId });
    return runAndSend(chatId, 'continue', sk, threadId);
  }
  if (text === '/status') {
    const running = runningProcs.has(sk);
    return sendChunked(chatId,
      `mode: ${settings.MODE_LABELS[state.getMode(sk)]}\n` +
      `model: ${state.getModel(sk)}\n` +
      `repo: ${state.getRepo(sk)}\n` +
      `session: ${state.getSession(sk) || '(none)'}\n` +
      `state: ${running ? 'running' : 'idle'}`,
      { markup: defaultKeyboard(sk), threadId }
    );
  }
  if (text.startsWith('/pr ')) return handlePr(chatId, text.slice(4).trim(), sk, threadId);
  if (text === '/prs') return handlePrs(chatId, sk, threadId);
  if (text.startsWith('/repo')) return handleRepo(chatId, text.slice(5).trim(), sk, threadId);

  // If a notify-reply is pending, route this message into the tmux session instead of starting a new claude run.
  const pendingReply = replyPending.get(sk);
  if (pendingReply) {
    if (text === '/cancel') {
      replyPending.delete(sk);
      return sendChunked(chatId, '↩️ Reply cancelled.', { markup: defaultKeyboard(sk), threadId });
    }
    replyPending.delete(sk);
    try {
      await sendTmuxKeys(pendingReply.container, pendingReply.target, text);
      approval.deleteNotifyToken(pendingReply.token);
      return sendChunked(chatId, `✉️ Sent → ${pendingReply.target}`, { markup: defaultKeyboard(sk), threadId });
    } catch (e) {
      return sendChunked(chatId, `⚠️ send-keys failed: ${String(e.message).slice(0, 300)}`, { threadId });
    }
  }

  if (runningProcs.has(sk)) {
    return sendChunked(chatId, '⏳ Task running — message NOT sent. Stop first.', { markup: defaultKeyboard(sk), threadId });
  }
  await runAndSend(chatId, text, sk, threadId);
}

// ── Callback queries ──────────────────────────────────────────────

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  if (!chatId) return;
  // Scope the tap to the topic its message lives in, so a button in topic X acts on X.
  const threadId = cb.message?.message_thread_id;
  const sk = topicKey(chatId, threadId);
  if (!authorized(cb.from)) {
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unauthorized', show_alert: true });
  }
  const data = cb.data || '';
  await tg('answerCallbackQuery', { callback_query_id: cb.id });

  if (data === 'details') {
    const last = state.getLastResponse(sk);
    if (!last?.details) return sendChunked(chatId, '(no details)', { threadId });
    return sendChunked(chatId, last.details, { markup: defaultKeyboard(sk), threadId });
  }
  if (data.startsWith('confirm:')) {
    if (runningProcs.has(sk)) return sendChunked(chatId, '⏳ Already running.', { threadId });
    const answer = data === 'confirm:y' ? 'Yes' : 'No';
    await tg('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: data === 'confirm:y' ? '✅ Yes' : '❌ No', callback_data: 'noop' }]] },
    });
    return runAndSend(chatId, answer, sk, threadId);
  }
  if (data.startsWith('ask:')) {
    const q = askQueues.get(sk);
    if (!q) return;
    const [, idxStr, pick] = data.split(':');
    const idx = Number(idxStr);
    if (idx !== q.idx) return;
    if (pick === 'x') {
      askPendingOther.set(sk, idx);
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: '✏️ type your answer…', callback_data: 'noop' }]] } });
      return sendChunked(chatId, `Type your answer for Q${idx + 1}.`, { threadId });
    }
    const chosen = q.items[idx].opts[Number(pick)];
    if (chosen == null) return;
    q.answers[idx] = chosen;
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: `✅ ${chosen}`.slice(0, 60), callback_data: 'noop' }]] } });
    return advanceAsk(chatId, sk, threadId);
  }
  if (data === 'continue') {
    if (runningProcs.has(sk)) return sendChunked(chatId, '⏳ Already running.', { threadId });
    if (!state.getSession(sk)) return sendChunked(chatId, 'No session.', { threadId });
    return runAndSend(chatId, 'continue', sk, threadId);
  }
  if (data === 'new') {
    state.clearSession(sk);
    return sendChunked(chatId, '🆕 New session.', { markup: defaultKeyboard(sk), threadId });
  }
  if (data === 'stop') return handleStop(chatId, sk, threadId);
  if (data === 'settings') return handleSettings(chatId, sk, threadId);
  if (data === 'menu:close') {
    return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  if (data.startsWith('mode:')) {
    const m = data.slice(5);
    if (!settings.MODES.includes(m)) return;
    state.setMode(sk, m);
    const { text, markup } = settings.settingsMenu(sk);
    return tg('editMessageText', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text,
      reply_markup: markup,
    });
  }
  if (data.startsWith('model:')) {
    const m = data.slice(6);
    if (!settings.MODELS.includes(m)) return;
    state.setModel(sk, m);
    const { text, markup } = settings.settingsMenu(sk);
    return tg('editMessageText', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text,
      reply_markup: markup,
    });
  }
  if (data.startsWith('appr:')) {
    const [, verdict, requestId] = data.split(':');
    const ok = verdict === 'y' || verdict === 's';
    const handled = approval.respondTo(requestId, ok, ok ? null : 'denied by user');
    const status = ok ? '✅ Approved' : '❌ Denied';
    await tg('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: `${status} — request closed`, callback_data: 'noop' }]] },
    });
    if (verdict === 's') {
      sessionAllowAlls.set(sk, { allow: true, until: Date.now() + 30 * 60 * 1000 });
      await sendChunked(chatId, '⏱ Allowing similar ops for 30 min.', { threadId });
    }
    if (!handled) await sendChunked(chatId, '(request already closed or timed out)', { threadId });
    return;
  }
  if (data.startsWith('notif:')) {
    const parts = data.split(':');
    const verb = parts[1];
    const token = parts[parts.length - 1];
    const rec = approval.getNotifyToken(token);
    if (!rec) {
      await tg('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '(expired)', callback_data: 'noop' }]] },
      });
      return;
    }
    if (verb === 'k') {
      const key = parts[2];
      try {
        await sendTmuxKeys(rec.container, rec.target, key);
        approval.deleteNotifyToken(token);
        await tg('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: `↳ sent "${key}"`, callback_data: 'noop' }]] },
        });
      } catch (e) {
        await sendChunked(chatId, `⚠️ send-keys failed: ${String(e.message).slice(0, 300)}`, { threadId });
      }
      return;
    }
    if (verb === 'esc') {
      try {
        await sendTmuxKeys(rec.container, rec.target, 'ESC');
        approval.deleteNotifyToken(token);
        await tg('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: '↳ sent Esc', callback_data: 'noop' }]] },
        });
      } catch (e) {
        await sendChunked(chatId, `⚠️ send-keys failed: ${String(e.message).slice(0, 300)}`, { threadId });
      }
      return;
    }
    if (verb === 'reply') {
      replyPending.set(sk, { token, container: rec.container, target: rec.target });
      await tg('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '✏️ waiting for your reply…  /cancel to abort', callback_data: 'noop' }]] },
      });
      return;
    }
    return;
  }
  if (data.startsWith('pr:view:')) {
    const num = data.split(':')[2];
    return handlePr(chatId, num, sk, threadId);
  }
  if (data.startsWith('pr:review:')) {
    const num = data.split(':')[2];
    return runAndSend(chatId, `/review ${num}`, sk, threadId);
  }
  if (data.startsWith('pr:approve:')) {
    const num = data.split(':')[2];
    const cwd = state.getRepo(sk);
    const { ok, err } = await gh.approvePr(cwd, num);
    return sendChunked(chatId, ok ? `✅ Approved PR #${num}` : `Failed: ${err.slice(0, 300)}`, { threadId });
  }
  if (data.startsWith('pr:merge:')) {
    const num = data.split(':')[2];
    const cwd = state.getRepo(sk);
    const { ok, err } = await gh.mergePr(cwd, num);
    return sendChunked(chatId, ok ? `🔀 Merged PR #${num}` : `Failed: ${err.slice(0, 300)}`, { threadId });
  }
}

// ── Boot ──────────────────────────────────────────────────────────

async function registerCommands() {
  await tg('setMyCommands', {
    commands: [
      { command: 'settings', description: 'Mode + model picker' },
      { command: 'pr', description: 'View PR <num>' },
      { command: 'prs', description: 'Open PRs assigned to you' },
      { command: 'repo', description: 'Set working dir' },
      { command: 'new', description: 'Start fresh session' },
      { command: 'continue', description: 'Resume session' },
      { command: 'stop', description: 'Kill running task' },
      { command: 'status', description: 'Session + mode + model' },
      { command: 'help', description: 'Show help' },
      { command: 'ping', description: 'Liveness' },
    ],
  }).catch((e) => console.error('setMyCommands failed:', e));
}

async function copyAndChmod(src, dst) {
  await execFileP('docker', ['cp', src, `${TARGET_CONTAINER}:${dst}`]);
  await execFileP('docker', ['exec', '-u', 'root', TARGET_CONTAINER, 'chmod', '+x', dst]);
}

async function installHook() {
  let ok = true;
  try {
    await copyAndChmod(HOOK_SRC, HOOK_PATH);
    console.log(`hook installed: ${TARGET_CONTAINER}:${HOOK_PATH}`);
  } catch (e) {
    console.warn(`pretooluse hook install failed: ${String(e.message).slice(0, 200)}`);
    ok = false;
  }
  // Notification hook + tmux launcher are best-effort — interactive-session feature only.
  try {
    await copyAndChmod(NOTIFY_HOOK_SRC, NOTIFY_HOOK_PATH);
    console.log(`notify hook installed: ${TARGET_CONTAINER}:${NOTIFY_HOOK_PATH}`);
  } catch (e) {
    console.warn(`notify hook install failed: ${String(e.message).slice(0, 200)}`);
  }
  try {
    await copyAndChmod(TMUX_LAUNCHER_SRC, TMUX_LAUNCHER_PATH);
    console.log(`tmux launcher installed: ${TARGET_CONTAINER}:${TMUX_LAUNCHER_PATH}`);
  } catch (e) {
    console.warn(`tmux launcher install failed: ${String(e.message).slice(0, 200)}`);
  }
  return ok;
}

let hookInstalled = false;
async function ensureHook() {
  if (hookInstalled) return;
  hookInstalled = await installHook();
}

let offset = 0;
async function pollLoop() {
  console.log(`herald up; allowed=@${ALLOWED_USERNAME || ALLOWED_USER_ID} target=${TARGET_CONTAINER} (user=${TARGET_USER})`);
  registerCommands();
  approval.start(HOOK_SECRET);
  ensureHook();
  const allowed = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
  while (true) {
    try {
      const r = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${allowed}`);
      const j = await r.json();
      if (j.ok) {
        for (const u of j.result) {
          offset = u.update_id + 1;
          if (u.message) handleMessage(u.message).catch((e) => console.error('handler:', e));
          else if (u.callback_query) handleCallback(u.callback_query).catch((e) => console.error('callback:', e));
        }
      } else {
        console.error('getUpdates not ok:', j);
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

pollLoop();
