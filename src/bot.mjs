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
const HOOK_PATH = process.env.HOOK_PATH || '/usr/local/bin/cc-bot-pretooluse-gate.sh';
const NOTIFY_HOOK_SRC = process.env.NOTIFY_HOOK_SRC || '/app/hooks/notify-tg.sh';
const NOTIFY_HOOK_PATH = process.env.NOTIFY_HOOK_PATH || '/usr/local/bin/cc-bot-notify-tg.sh';
const TMUX_LAUNCHER_SRC = process.env.TMUX_LAUNCHER_SRC || '/app/hooks/cc-tmux.sh';
const TMUX_LAUNCHER_PATH = process.env.TMUX_LAUNCHER_PATH || '/usr/local/bin/cc-tmux';
const BOT_URL_FOR_HOOK = process.env.BOT_URL_FOR_HOOK || `http://cc-bot:${APPROVAL_PORT}`;
// Phalanx no-babysit: when an inline run leaves work unfinished, hand the repo to the
// detached supervisor to finish across fresh sessions. Disable with PHALANX_AUTOESCALATE=0.
const AUTO_ESCALATE = process.env.PHALANX_AUTOESCALATE !== '0';
const SUPERVISORD_PATH = process.env.SUPERVISORD_PATH || '/home/cc/.claude/supervisord.sh';

if (!TOKEN) { console.error('BOT_TOKEN required'); process.exit(1); }
if (!ALLOWED_USERNAME && !ALLOWED_USER_ID) { console.error('ALLOWED_USERNAME or ALLOWED_USER_ID required'); process.exit(1); }

const API = `https://api.telegram.org/bot${TOKEN}`;

const runningProcs = new Map(); // chatId -> { child, startedAt }

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
  const stem = `cc-bot-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
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
  if (runningProcs.has(chatId)) {
    return sendChunked(chatId, '⏳ Task running — image NOT sent. Stop first.', { markup: defaultKeyboard(chatId) });
  }
  await tg('sendChatAction', { chat_id: chatId, action: 'upload_photo' });
  const ext = EXT_BY_MIME[mime] || '.jpg';
  const { path, bytes, error } = await downloadTgFile(fileId, ext);
  if (error) return sendChunked(chatId, `⚠️ Image failed: ${error}`);
  const caption = (captionOverride || msg.caption || '').trim();
  const userText = caption || 'What do you see in this image? Describe and suggest any action.';
  const prompt = `[User attached an image. It is available in the target container at ${path} (${bytes} bytes, ${mime}). Use the Read tool on that path to view it.]\n\n${userText}`;
  await runAndSend(chatId, prompt);
}

function authorized(from) {
  if (!from) return false;
  if (ALLOWED_USER_ID && from.id === ALLOWED_USER_ID) return true;
  if (ALLOWED_USERNAME && from.username && from.username.toLowerCase() === ALLOWED_USERNAME.toLowerCase()) return true;
  return false;
}

// ── Keyboards ─────────────────────────────────────────────────────

function defaultKeyboard(chatId) {
  const hasSession = !!state.getSession(chatId);
  const running = runningProcs.has(chatId);
  const hasDetails = !!state.getLastResponse(chatId)?.details;
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

// Send keystrokes into an interactive Claude session running in tmux inside a container.
// `text` is appended with Enter unless it's the literal sentinel 'ESC' (sent as Escape key).
async function sendTmuxKeys(container, target, text) {
  const args = ['exec', '-u', TARGET_USER, container, 'tmux', 'send-keys', '-t', target];
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
async function launchSupervisor(cwd) {
  await execFileP('docker', ['exec', '-u', TARGET_USER,
    '-e', `PHALANX_NOTIFY_URL=${BOT_URL_FOR_HOOK}/event`,
    '-e', 'PATH=/home/cc/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
    TARGET_CONTAINER, 'bash', SUPERVISORD_PATH, 'start', '-r', cwd]);
}

// After an inline run, if work is unfinished (open tasks remain, or it timed out),
// hand the repo to the supervisor and tell the user. No-op when nothing's pending.
async function maybeEscalate(chatId, reason) {
  if (!AUTO_ESCALATE) return false;
  const cwd = state.getRepo(chatId);
  if (!(await repoHasOpenTasks(cwd))) return false;
  try { await launchSupervisor(cwd); }
  catch (e) { console.error('supervisor launch failed:', e); return false; }
  await sendChunked(chatId,
    `🤖 Didn't finish in one pass (${reason}). Handed to the autonomous supervisor — ` +
    `it'll drive it to done across fresh sessions and message you on progress / done / blocked.`,
    { markup: defaultKeyboard(chatId) });
  return true;
}

function runClaude(prompt, chatId) {
  const sessionId = state.getSession(chatId);
  const model = state.getModel(chatId);
  const mode = state.getMode(chatId);
  const cwd = state.getRepo(chatId);

  return new Promise((resolve, reject) => {
    const claudeArgs = [
      '-p',
      '--output-format', 'json',
      '--model', model,
      '--append-system-prompt', TLDR_INSTRUCTION,
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
      '-e', `CC_BOT_CHAT_ID=${chatId}`,
      '-e', `CC_BOT_MODE=${mode}`,
      '-e', `CC_BOT_URL=${BOT_URL_FOR_HOOK}`,
      '-e', `APPROVAL_TIMEOUT_SECONDS=${process.env.APPROVAL_TIMEOUT_SECONDS || 300}`,
      '-e', 'PATH=/home/cc/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
      '-e', `API_TIMEOUT_MS=${API_TIMEOUT_MS}`,
      '-e', `BASH_DEFAULT_TIMEOUT_MS=${BASH_DEFAULT_TIMEOUT_MS}`,
      '-e', `BASH_MAX_TIMEOUT_MS=${BASH_MAX_TIMEOUT_MS}`,
      TARGET_CONTAINER,
      'claude', ...claudeArgs,
    ];

    const child = spawn('docker', dockerArgs);
    runningProcs.set(chatId, { child, startedAt: Date.now() });
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
    child.on('error', (e) => { clearTimeout(killTimer); runningProcs.delete(chatId); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const wasStopped = runningProcs.get(chatId)?.stopRequested;
      runningProcs.delete(chatId);
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

async function runAndSend(chatId, prompt) {
  await ensureHook();
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const heartbeat = setInterval(() => {
    tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4000);
  try {
    const result = await runClaude(prompt, chatId);
    state.setSession(chatId, result.session_id);
    const body = result.result ?? JSON.stringify(result, null, 2);
    const { tldr, details } = splitTldr(body);
    state.setLastResponse(chatId, { tldr, details, model: state.getModel(chatId) });
    await sendChunked(chatId, tldr + costFooter(result, state.getModel(chatId)), { markup: defaultKeyboard(chatId) });
    await maybeEscalate(chatId, "reached this pass's context limit");
  } catch (e) {
    if (e.message === 'stopped') {
      await sendChunked(chatId, '🛑 Stopped.', { markup: defaultKeyboard(chatId) });
    } else {
      console.error('claude error:', e);
      const full = e.message;
      const containerDown = /container .* is not running|No such container/.test(full);
      let summary;
      if (containerDown) summary = `⚠️ ${TARGET_CONTAINER} not running.`;
      else if (full.includes('timed out')) summary = `⏱️ Timed out after ${Math.round(CLAUDE_TIMEOUT_MS / 60000)} min.`;
      else summary = `⚠️ Claude errored. Tap 📖 Details for full trace.`;
      state.setLastResponse(chatId, { tldr: summary, details: full, model: state.getModel(chatId) });
      await sendChunked(chatId, summary, { markup: defaultKeyboard(chatId) });
      if (full.includes('timed out')) await maybeEscalate(chatId, 'timed out');
    }
  } finally {
    clearInterval(heartbeat);
  }
}

// ── Approval flow ─────────────────────────────────────────────────

// chatId -> { token, container, target, msgId } — set when user taps ✏️ Reply; next msg goes to tmux.
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
  const resp = await tg('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: notifyKeyboard(token),
    disable_web_page_preview: true,
  });
  if (resp?.ok && resp.result?.message_id) {
    approval.setNotifyMsgId(token, resp.result.message_id);
  }
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

const sessionAllowAlls = new Map(); // chatId -> { allow: true, until: ts }

// ── Commands ──────────────────────────────────────────────────────

function handleStop(chatId) {
  const rec = runningProcs.get(chatId);
  if (!rec) return sendChunked(chatId, 'Nothing running.', { markup: defaultKeyboard(chatId) });
  rec.stopRequested = true;
  rec.child.kill('SIGTERM');
  setTimeout(() => { try { rec.child.kill('SIGKILL'); } catch {} }, 3000);
  return sendChunked(chatId, '🛑 Stop sent.');
}

async function handleSettings(chatId) {
  const { text, markup } = settings.settingsMenu(chatId);
  return sendChunked(chatId, text, { markup });
}

async function handlePr(chatId, num) {
  if (!num || !/^\d+$/.test(num)) return sendChunked(chatId, 'Usage: /pr <number>');
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const cwd = state.getRepo(chatId);
  const { pr, error } = await gh.viewPr(cwd, num);
  if (error) return sendChunked(chatId, `gh error: ${error.slice(0, 500)}`);
  return sendChunked(chatId, gh.summarizePr(pr), { markup: gh.prKeyboard(pr.number, pr.url) });
}

async function handlePrs(chatId) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const cwd = state.getRepo(chatId);
  const { prs, error } = await gh.listPrs(cwd);
  if (error) return sendChunked(chatId, `gh error: ${error.slice(0, 500)}`);
  if (!prs.length) return sendChunked(chatId, 'No open PRs assigned to you.');
  const text = prs.map((p) => `#${p.number} ${p.title}\n  ${p.headRefName}`).join('\n\n');
  const markup = {
    inline_keyboard: prs.slice(0, 10).map((p) => [
      { text: `#${p.number} ${p.title.slice(0, 50)}`, callback_data: `pr:view:${p.number}` },
    ]),
  };
  return sendChunked(chatId, text, { markup });
}

async function handleRepo(chatId, arg) {
  if (!arg) return sendChunked(chatId, `Current: ${state.getRepo(chatId)}\nUsage: /repo <path>`);
  state.setRepo(chatId, arg);
  return sendChunked(chatId, `Repo → ${arg}`, { markup: defaultKeyboard(chatId) });
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const kinds = Object.keys(msg).filter((k) => !['message_id','from','chat','date','message_thread_id'].includes(k)).join(',');
  console.log(`msg from @${msg.from?.username || '?'} chat=${chatId} kinds=[${kinds}]`);
  if (!authorized(msg.from)) {
    console.log(`unauth: @${msg.from?.username || '?'} id=${msg.from?.id}`);
    return;
  }
  if (!state.get().knownUserId && msg.from?.id) {
    state.get().knownUserId = msg.from.id;
    state.save();
  }

  // Photo: Telegram sends array of resized variants; last is the largest.
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return handleImageMessage(msg, largest.file_id, 'image/jpeg');
  }
  // Document w/ image mime: user sent image as "file" for full quality.
  if (msg.document && (msg.document.mime_type || '').startsWith('image/')) {
    return handleImageMessage(msg, msg.document.file_id, msg.document.mime_type);
  }
  // Sticker as image (static webp).
  if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
    return handleImageMessage(msg, msg.sticker.file_id, 'image/webp', 'What is this sticker?');
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  if (text === '/start' || text === '/help') {
    return sendChunked(chatId,
      'cc-bot — Claude Code on Telegram\n\n' +
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
      { markup: defaultKeyboard(chatId) }
    );
  }
  if (text === '/ping') return sendChunked(chatId, 'pong');
  if (text === '/whoami') return sendChunked(chatId, `user_id=${msg.from?.id}\nusername=@${msg.from?.username}`);
  if (text === '/settings' || text === '/menu') return handleSettings(chatId);
  if (text === '/new') {
    state.clearSession(chatId);
    return sendChunked(chatId, '🆕 New session.', { markup: defaultKeyboard(chatId) });
  }
  if (text === '/stop') return handleStop(chatId);
  if (text === '/continue') {
    if (runningProcs.has(chatId)) return sendChunked(chatId, '⏳ Already running.');
    if (!state.getSession(chatId)) return sendChunked(chatId, 'No session. Send a message to start.');
    return runAndSend(chatId, 'continue');
  }
  if (text === '/status') {
    const running = runningProcs.has(chatId);
    return sendChunked(chatId,
      `mode: ${settings.MODE_LABELS[state.getMode(chatId)]}\n` +
      `model: ${state.getModel(chatId)}\n` +
      `repo: ${state.getRepo(chatId)}\n` +
      `session: ${state.getSession(chatId) || '(none)'}\n` +
      `state: ${running ? 'running' : 'idle'}`,
      { markup: defaultKeyboard(chatId) }
    );
  }
  if (text.startsWith('/pr ')) return handlePr(chatId, text.slice(4).trim());
  if (text === '/prs') return handlePrs(chatId);
  if (text.startsWith('/repo')) return handleRepo(chatId, text.slice(5).trim());

  // If a notify-reply is pending, route this message into the tmux session instead of starting a new claude run.
  const pendingReply = replyPending.get(chatId);
  if (pendingReply) {
    if (text === '/cancel') {
      replyPending.delete(chatId);
      return sendChunked(chatId, '↩️ Reply cancelled.', { markup: defaultKeyboard(chatId) });
    }
    replyPending.delete(chatId);
    try {
      await sendTmuxKeys(pendingReply.container, pendingReply.target, text);
      approval.deleteNotifyToken(pendingReply.token);
      return sendChunked(chatId, `✉️ Sent → ${pendingReply.target}`, { markup: defaultKeyboard(chatId) });
    } catch (e) {
      return sendChunked(chatId, `⚠️ send-keys failed: ${String(e.message).slice(0, 300)}`);
    }
  }

  if (runningProcs.has(chatId)) {
    return sendChunked(chatId, '⏳ Task running — message NOT sent. Stop first.', { markup: defaultKeyboard(chatId) });
  }
  await runAndSend(chatId, text);
}

// ── Callback queries ──────────────────────────────────────────────

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  if (!chatId) return;
  if (!authorized(cb.from)) {
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unauthorized', show_alert: true });
  }
  const data = cb.data || '';
  await tg('answerCallbackQuery', { callback_query_id: cb.id });

  if (data === 'details') {
    const last = state.getLastResponse(chatId);
    if (!last?.details) return sendChunked(chatId, '(no details)');
    return sendChunked(chatId, last.details, { markup: defaultKeyboard(chatId) });
  }
  if (data === 'continue') {
    if (runningProcs.has(chatId)) return sendChunked(chatId, '⏳ Already running.');
    if (!state.getSession(chatId)) return sendChunked(chatId, 'No session.');
    return runAndSend(chatId, 'continue');
  }
  if (data === 'new') {
    state.clearSession(chatId);
    return sendChunked(chatId, '🆕 New session.', { markup: defaultKeyboard(chatId) });
  }
  if (data === 'stop') return handleStop(chatId);
  if (data === 'settings') return handleSettings(chatId);
  if (data === 'menu:close') {
    return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  if (data.startsWith('mode:')) {
    const m = data.slice(5);
    if (!settings.MODES.includes(m)) return;
    state.setMode(chatId, m);
    const { text, markup } = settings.settingsMenu(chatId);
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
    state.setModel(chatId, m);
    const { text, markup } = settings.settingsMenu(chatId);
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
      sessionAllowAlls.set(chatId, { allow: true, until: Date.now() + 30 * 60 * 1000 });
      await sendChunked(chatId, '⏱ Allowing similar ops for 30 min.');
    }
    if (!handled) await sendChunked(chatId, '(request already closed or timed out)');
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
        await sendChunked(chatId, `⚠️ send-keys failed: ${String(e.message).slice(0, 300)}`);
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
        await sendChunked(chatId, `⚠️ send-keys failed: ${String(e.message).slice(0, 300)}`);
      }
      return;
    }
    if (verb === 'reply') {
      replyPending.set(chatId, { token, container: rec.container, target: rec.target });
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
    return handlePr(chatId, num);
  }
  if (data.startsWith('pr:review:')) {
    const num = data.split(':')[2];
    return runAndSend(chatId, `/review ${num}`);
  }
  if (data.startsWith('pr:approve:')) {
    const num = data.split(':')[2];
    const cwd = state.getRepo(chatId);
    const { ok, err } = await gh.approvePr(cwd, num);
    return sendChunked(chatId, ok ? `✅ Approved PR #${num}` : `Failed: ${err.slice(0, 300)}`);
  }
  if (data.startsWith('pr:merge:')) {
    const num = data.split(':')[2];
    const cwd = state.getRepo(chatId);
    const { ok, err } = await gh.mergePr(cwd, num);
    return sendChunked(chatId, ok ? `🔀 Merged PR #${num}` : `Failed: ${err.slice(0, 300)}`);
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
  console.log(`cc-bot up; allowed=@${ALLOWED_USERNAME || ALLOWED_USER_ID} target=${TARGET_CONTAINER} (user=${TARGET_USER})`);
  registerCommands();
  approval.start();
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
