import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 600000);
const APPROVAL_PORT = Number(process.env.APPROVAL_PORT) || 7788;
const HOOK_SRC = process.env.HOOK_SRC || '/app/hooks/pretooluse-gate.sh';
const HOOK_PATH = process.env.HOOK_PATH || '/usr/local/bin/cc-bot-pretooluse-gate.sh';
const BOT_URL_FOR_HOOK = process.env.BOT_URL_FOR_HOOK || `http://cc-bot:${APPROVAL_PORT}`;

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

async function sendChunked(chatId, text, { code = false, markup } = {}) {
  if (!text) text = '(empty)';
  const wrap = code ? (s) => '```\n' + s + '\n```' : (s) => s;
  const limit = code ? 3900 : 4000;
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await tg('sendMessage', {
      chat_id: chatId,
      text: wrap(chunks[i]),
      parse_mode: code ? 'MarkdownV2' : undefined,
      disable_web_page_preview: true,
      reply_markup: isLast && markup ? markup : undefined,
    });
  }
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

// ── Claude invocation ─────────────────────────────────────────────

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
      TARGET_CONTAINER,
      'claude', ...claudeArgs,
    ];

    const child = spawn('docker', dockerArgs);
    runningProcs.set(chatId, { child, startedAt: Date.now() });
    child.stdin.write(prompt);
    child.stdin.end();

    let out = '', err = '';
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);

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
    }
  } finally {
    clearInterval(heartbeat);
  }
}

// ── Approval flow ─────────────────────────────────────────────────

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
  if (!authorized(msg.from)) {
    console.log(`unauth: @${msg.from?.username || '?'} id=${msg.from?.id}`);
    return;
  }
  if (!state.get().knownUserId && msg.from?.id) {
    state.get().knownUserId = msg.from.id;
    state.save();
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

async function installHook() {
  try {
    await execFileP('docker', ['cp', HOOK_SRC, `${TARGET_CONTAINER}:${HOOK_PATH}`]);
    await execFileP('docker', ['exec', '-u', 'root', TARGET_CONTAINER, 'chmod', '+x', HOOK_PATH]);
    console.log(`hook installed: ${TARGET_CONTAINER}:${HOOK_PATH}`);
    return true;
  } catch (e) {
    console.warn(`hook install failed (will retry on first claude run): ${String(e.message).slice(0, 200)}`);
    return false;
  }
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
