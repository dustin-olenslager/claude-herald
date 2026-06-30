import * as state from './state.mjs';
import * as settings from './settings.mjs';
import * as approval from './approval-server.mjs';
import * as gh from './github.mjs';
import * as tgkb from './telegram.mjs';
import { makeContainerExec } from './container-exec.mjs';
import { makeHookInstaller } from './hook-installer.mjs';
import { makeSupervisor } from './supervisor.mjs';
import { makeRunner } from './runner.mjs';
import { decode } from './callback-codec.mjs';
import { buildRegistry, matchRepo } from './repo-registry.mjs';
import { resolveReportTopic } from './routing.mjs';
import { log } from './log.mjs';

// ── Config ────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USERNAME = (process.env.ALLOWED_USERNAME || '').replace(/^@/, '');
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? Number(process.env.ALLOWED_USER_ID) : null;
const TARGET_CONTAINER = process.env.TARGET_CONTAINER || 'claude-code-rc';
const TARGET_USER = process.env.TARGET_USER || 'cc';
const CLAUDE_TIMEOUT_MS = process.env.CLAUDE_TIMEOUT_MS != null ? Number(process.env.CLAUDE_TIMEOUT_MS) : 600000;
// A non-login `docker exec` does NOT inherit the target's interactive-shell env, so
// these must be passed through explicitly or long turns get killed at 10 min.
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

// Scope key: each forum topic (message_thread_id) is its own independent session.
// Non-forum / General topic (no threadId) keeps today's flat per-chat scope.
function topicKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

// ── Composition root: wire the modules ────────────────────────────
const exec = makeContainerExec({ container: TARGET_CONTAINER, user: TARGET_USER });
const telegram = tgkb.makeTelegram({ token: TOKEN, state, copyFileToContainer: exec.copyFileToContainer });
const { tg, sendChunked, topicFor, downloadTgFile } = telegram;

const hookInstaller = makeHookInstaller({
  exec,
  paths: { HOOK_SRC, HOOK_PATH, NOTIFY_HOOK_SRC, NOTIFY_HOOK_PATH, TMUX_LAUNCHER_SRC, TMUX_LAUNCHER_PATH },
});

const supervisor = makeSupervisor({
  exec, state, tg: telegram,
  deps: { AUTO_ESCALATE, BOT_URL_FOR_HOOK, HOOK_SECRET, SUPERVISORD_PATH },
});

// Per-sk keyboard producers close over runner for the running flag (assigned below).
function defaultKeyboard(sk) {
  return tgkb.defaultKeyboard({
    hasSession: !!state.getSession(sk),
    running: runner.isRunning(sk),
    hasDetails: !!state.getLastResponse(sk)?.details,
  });
}
function questionKeyboard(sk) {
  return tgkb.questionKeyboard(defaultKeyboard(sk));
}

const runner = makeRunner({
  exec, state, tg: telegram, supervisor,
  keyboards: { defaultKeyboard, questionKeyboard },
  ensureHook: hookInstaller.ensureHook,
  deps: {
    TARGET_CONTAINER, HOOK_PATH, BOT_URL_FOR_HOOK, HOOK_SECRET,
    API_TIMEOUT_MS, BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, CLAUDE_TIMEOUT_MS,
  },
});
const { runAndSend, handleStop } = runner;

// sk -> { token, container, target } — set when user taps ✏️ Reply; next msg goes to tmux.
const replyPending = new Map();

// ── Forum repo auto-detect ────────────────────────────────────────
// sk -> { text, paths } — pending repo picker; the original message replays on tap.
const pendingRepoBind = new Map();
const REGISTRY_TTL_MS = Number(process.env.REPO_REGISTRY_TTL_MS) || 300000;
let _registry = null, _registryTs = 0;

async function getRegistry() {
  const now = Date.now();
  if (_registry && now - _registryTs < REGISTRY_TTL_MS) return _registry;
  const paths = await exec.listRepoCandidates().catch(() => []);
  // Only keep paths the same validator setRepo enforces would accept.
  _registry = buildRegistry(paths.filter((p) => state.validateRepoPath(p).ok));
  _registryTs = now;
  return _registry;
}

function repoPickerKeyboard(paths) {
  return { inline_keyboard: paths.slice(0, 8).map((p, i) => [{ text: p.split('/').pop(), callback_data: `repopick:${i}` }]) };
}

// Infer + bind a sticky repo from plain language. Forum topics only; the General
// flat session is never auto-bound. Returns 'await' when a picker was sent (caller
// must NOT run the message yet), else 'bound'/'skip' (caller proceeds normally).
async function maybeBindRepo(chatId, sk, threadId, text) {
  if (!threadId) return 'skip';
  const alreadySet = state.get().repos[sk] !== undefined;
  const wantsSwitch = /^\s*(switch\s+(to|repo)|use\s+repo)\b/i.test(text);
  if (alreadySet && !wantsSwitch) return 'skip';
  const res = matchRepo(text, await getRegistry());
  if (res.kind === 'none') return 'skip';
  if (res.kind === 'match') {
    try { state.setRepo(sk, res.path); } catch { return 'skip'; }
    state.bindRepoTopic(chatId, threadId, res.path);
    log.info({ sk, chatId, repo: res.path, msg: 'repo auto-bound' });
    await sendChunked(chatId, `📌 This topic → ${res.path.split('/').pop()} (${res.path})`, { threadId });
    return 'bound';
  }
  pendingRepoBind.set(sk, { text, paths: res.paths });
  await sendChunked(chatId, '📂 Which repo is this topic for?', { threadId, markup: repoPickerKeyboard(res.paths) });
  return 'await';
}

function authorized(from) {
  if (!from) return false;
  if (ALLOWED_USER_ID && from.id === ALLOWED_USER_ID) return true;
  if (ALLOWED_USERNAME && from.username && from.username.toLowerCase() === ALLOWED_USERNAME.toLowerCase()) return true;
  return false;
}

// ── Image/file handling ───────────────────────────────────────────
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

async function handleImageMessage(msg, fileId, mime, captionOverride) {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const sk = topicKey(chatId, threadId);
  if (runner.isRunning(sk)) {
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

// ── Approval-server handlers ──────────────────────────────────────
approval.setChatIdResolver(() => state.get().knownUserId);

// Phalanx supervisor status events -> plain Telegram message (no Reply button).
approval.setEventHandler(async ({ chatId, event, message, repo, thread }) => {
  const icon = { start: '🚀', progress: '⏳', done: '✅', blocked: '⛔' }[event] || '🤖';
  // A job that started in a known topic carries its numeric thread id -> route
  // straight back to it (NEVER create a second topic). Only a cron / cold-start
  // job with no originating topic name-creates a "<repo>" topic.
  // Route to: explicit originating thread > the repo's canonical topic > a freshly
  // created "<repo>" topic (which we then BIND so every later report + any human
  // message for this repo converges on the one topic).
  const route = resolveReportTopic({ thread, repo, repoTopic: state.getRepoTopic(chatId, repo) });
  const label = (repo ? repo.split('/').pop() : '').trim();
  let threadId;
  if (route.kind === 'thread' || route.kind === 'existing') threadId = route.threadId;
  else if (route.kind === 'create') {
    threadId = await topicFor(chatId, route.name).catch(() => undefined);
    if (threadId) state.bindRepoTopic(chatId, threadId, repo);
  }
  await tg('sendMessage', {
    chat_id: chatId,
    message_thread_id: threadId || undefined,
    text: `${icon} ${label ? label + ' — ' : ''}Supervisor: ${event}\n${(message || '').slice(0, 3500)}`,
    disable_web_page_preview: true,
  });
});

approval.setNotifyHandler(async ({ token, chatId, message, container, tmuxTarget, cwd }) => {
  // Single-target bot owns the source-of-truth: rewrite token's container to
  // TARGET_CONTAINER so downstream send-keys hits the right place.
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
    reply_markup: tgkb.notifyKeyboard(token),
    disable_web_page_preview: true,
  });
});

approval.setApprovalHandler(async ({ requestId, chatId, toolName, command, cwd, mode, thread }) => {
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
    message_thread_id: Number(thread) || undefined,
    text: lines,
    parse_mode: 'Markdown',
    reply_markup: tgkb.approvalKeyboard(requestId),
  });
});

// ── Command handlers ──────────────────────────────────────────────
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
  const v = state.validateRepoPath(arg);
  if (!v.ok) {
    log.warn({ sk, chatId, repo: arg, reason: v.reason, msg: 'repo path rejected' });
    return sendChunked(chatId, `⚠️ Rejected: ${v.reason}\nAllowed roots: ${state.repoAllowedRoots().join(', ')}`, { threadId });
  }
  if (!(await exec.dirExists(v.path))) {
    log.warn({ sk, chatId, repo: v.path, reason: 'not a directory in container', msg: 'repo path rejected' });
    return sendChunked(chatId, `⚠️ Not a directory in ${TARGET_CONTAINER}: ${v.path}`, { threadId });
  }
  state.setRepo(sk, v.path);
  state.bindRepoTopic(chatId, threadId, v.path);
  log.info({ sk, chatId, repo: v.path, msg: 'repo set' });
  return sendChunked(chatId, `Repo → ${v.path}`, { markup: defaultKeyboard(sk), threadId });
}

// Telegram splits a long paste into several messages that land within ~ms of each
// other. Without buffering, the first starts a run and the rest hit "task running —
// NOT sent". Debounce per topic: collect messages, dispatch ONCE after a quiet gap so
// a split paste becomes a single prompt. Commands (/...) bypass this (handled earlier).
const COALESCE_MS = Number(process.env.HERALD_COALESCE_MS ?? 2500);
const msgBuffers = new Map(); // sk -> { texts, timer, chatId, threadId }

function clearBuffer(sk) {
  const b = msgBuffers.get(sk);
  if (b?.timer) clearTimeout(b.timer);
  msgBuffers.delete(sk);
}

async function dispatchText(chatId, sk, threadId, text) {
  if (runner.isRunning(sk)) {
    return sendChunked(chatId, '⏳ Task running — message NOT sent. Stop first.', { markup: defaultKeyboard(sk), threadId });
  }
  // Forum topics: bind a sticky repo from plain language before running. 'await' means a
  // picker was shown — the original message replays once the user taps.
  if ((await maybeBindRepo(chatId, sk, threadId, text)) === 'await') return;
  await runAndSend(chatId, text, sk, threadId);
}

function coalesce(chatId, sk, threadId, text) {
  let b = msgBuffers.get(sk);
  if (!b) { b = { texts: [], timer: null }; msgBuffers.set(sk, b); }
  b.texts.push(text); b.chatId = chatId; b.threadId = threadId;
  if (b.timer) clearTimeout(b.timer);
  else tg('sendChatAction', { chat_id: chatId, message_thread_id: threadId || undefined, action: 'typing' }).catch(() => {});
  b.timer = setTimeout(() => {
    msgBuffers.delete(sk);
    dispatchText(chatId, sk, threadId, b.texts.join('\n'))
      .catch((e) => log.error({ sk, err: String(e?.message || e), msg: 'coalesced dispatch threw' }));
  }, COALESCE_MS);
}

// ── Message dispatch ──────────────────────────────────────────────
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
    if (runner.isRunning(sk)) {
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
  if (runner.hasPendingOther(sk)) {
    const i = runner.takePendingOther(sk);
    const q = runner.getAsk(sk);
    if (q) { q.answers[i] = text; return runner.advanceAsk(chatId, sk, threadId); }
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
    clearBuffer(sk);
    state.clearSession(sk);
    return sendChunked(chatId, '🆕 New session.', { markup: defaultKeyboard(sk), threadId });
  }
  if (text === '/stop') { clearBuffer(sk); return handleStop(chatId, sk, threadId); }
  if (text === '/continue') {
    if (runner.isRunning(sk)) return sendChunked(chatId, '⏳ Already running.', { threadId });
    if (!state.getSession(sk)) return sendChunked(chatId, 'No session. Send a message to start.', { threadId });
    return runAndSend(chatId, 'continue', sk, threadId);
  }
  if (text === '/status') {
    const running = runner.isRunning(sk);
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
      await exec.sendTmuxKeys(pendingReply.container, pendingReply.target, text);
      approval.deleteNotifyToken(pendingReply.token);
      return sendChunked(chatId, `✉️ Sent → ${pendingReply.target}`, { markup: defaultKeyboard(sk), threadId });
    } catch (e) {
      return sendChunked(chatId, `⚠️ send-keys failed: ${String(e.message).slice(0, 300)}`, { threadId });
    }
  }

  // Plain prose: buffer + debounce so a split paste coalesces into one run.
  return coalesce(chatId, sk, threadId, text);
}

// ── Callback dispatch ─────────────────────────────────────────────
async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  if (!chatId) return;
  // Scope the tap to the topic its message lives in, so a button in topic X acts on X.
  const threadId = cb.message?.message_thread_id;
  const sk = topicKey(chatId, threadId);
  if (!authorized(cb.from)) {
    return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unauthorized', show_alert: true });
  }
  const msgId = cb.message.message_id;
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  const ev = decode(cb.data || '');

  switch (ev.kind) {
    case 'details': {
      const last = state.getLastResponse(sk);
      if (!last?.details) return sendChunked(chatId, '(no details)', { threadId });
      return sendChunked(chatId, last.details, { markup: defaultKeyboard(sk), threadId });
    }
    case 'confirm': {
      if (runner.isRunning(sk)) return sendChunked(chatId, '⏳ Already running.', { threadId });
      await tg('editMessageReplyMarkup', {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: ev.answer === 'Yes' ? '✅ Yes' : '❌ No', callback_data: 'noop' }]] },
      });
      return runAndSend(chatId, ev.answer, sk, threadId);
    }
    case 'ask': {
      const q = runner.getAsk(sk);
      if (!q) return sendChunked(chatId, '⚠️ That question expired (the bot restarted). Re-run your request, or just type your answer.', { threadId });
      if (ev.idx !== q.idx) return sendChunked(chatId, '⚠️ That was an earlier question — answer the latest one above.', { threadId });
      if (ev.pick === 'x') {
        runner.setPendingOther(sk, ev.idx);
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '✏️ type your answer…', callback_data: 'noop' }]] } });
        return sendChunked(chatId, `Type your answer for Q${ev.idx + 1}.`, { threadId });
      }
      const chosen = q.items[ev.idx].opts[Number(ev.pick)];
      if (chosen == null) return;
      q.answers[ev.idx] = chosen;
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: `✅ ${chosen}`.slice(0, 60), callback_data: 'noop' }]] } });
      return runner.advanceAsk(chatId, sk, threadId);
    }
    case 'continue': {
      if (runner.isRunning(sk)) return sendChunked(chatId, '⏳ Already running.', { threadId });
      if (!state.getSession(sk)) return sendChunked(chatId, 'No session.', { threadId });
      return runAndSend(chatId, 'continue', sk, threadId);
    }
    case 'new': {
      state.clearSession(sk);
      return sendChunked(chatId, '🆕 New session.', { markup: defaultKeyboard(sk), threadId });
    }
    case 'stop': return handleStop(chatId, sk, threadId);
    case 'settings': return handleSettings(chatId, sk, threadId);
    case 'menu:close':
      return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    case 'mode': {
      if (!settings.MODES.includes(ev.value)) return;
      state.setMode(sk, ev.value);
      const { text, markup } = settings.settingsMenu(sk);
      return tg('editMessageText', { chat_id: chatId, message_id: msgId, text, reply_markup: markup });
    }
    case 'model': {
      if (!settings.MODELS.includes(ev.value)) return;
      state.setModel(sk, ev.value);
      const { text, markup } = settings.settingsMenu(sk);
      return tg('editMessageText', { chat_id: chatId, message_id: msgId, text, reply_markup: markup });
    }
    case 'appr': {
      const handled = approval.respondTo(ev.requestId, ev.ok, ev.ok ? null : 'denied by user');
      const status = ev.ok ? '✅ Approved' : '❌ Denied';
      await tg('editMessageReplyMarkup', {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: `${status} — request closed`, callback_data: 'noop' }]] },
      });
      if (!handled) await sendChunked(chatId, '(request already closed or timed out)', { threadId });
      return;
    }
    case 'repopick': {
      const pend = pendingRepoBind.get(sk);
      if (!pend) return;
      const chosen = pend.paths[ev.idx];
      if (!chosen) return;
      pendingRepoBind.delete(sk);
      try { state.setRepo(sk, chosen); } catch { return sendChunked(chatId, '⚠️ Invalid repo path.', { threadId }); }
      state.bindRepoTopic(chatId, threadId, chosen);
      log.info({ sk, chatId, repo: chosen, msg: 'repo picked' });
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: `📌 ${chosen.split('/').pop()}`, callback_data: 'noop' }]] } });
      if (pend.text) return runAndSend(chatId, pend.text, sk, threadId);
      return;
    }
    case 'notif': return handleNotif(ev, cb, chatId, sk, threadId, msgId);
    case 'pr': return handlePrCallback(ev, chatId, sk, threadId);
    default: return;
  }
}

async function handleNotif(ev, cb, chatId, sk, threadId, msgId) {
  const rec = approval.getNotifyToken(ev.token);
  if (!rec) {
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '(expired)', callback_data: 'noop' }]] } });
    return;
  }
  if (ev.verb === 'k') {
    try {
      await exec.sendTmuxKeys(rec.container, rec.target, ev.key);
      approval.deleteNotifyToken(ev.token);
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: `↳ sent "${ev.key}"`, callback_data: 'noop' }]] } });
    } catch (e) {
      await sendChunked(chatId, `⚠️ send-keys failed: ${String(e.message).slice(0, 300)}`, { threadId });
    }
    return;
  }
  if (ev.verb === 'esc') {
    try {
      await exec.sendTmuxKeys(rec.container, rec.target, 'ESC');
      approval.deleteNotifyToken(ev.token);
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '↳ sent Esc', callback_data: 'noop' }]] } });
    } catch (e) {
      await sendChunked(chatId, `⚠️ send-keys failed: ${String(e.message).slice(0, 300)}`, { threadId });
    }
    return;
  }
  if (ev.verb === 'reply') {
    replyPending.set(sk, { token: ev.token, container: rec.container, target: rec.target });
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '✏️ waiting for your reply…  /cancel to abort', callback_data: 'noop' }]] } });
  }
}

async function handlePrCallback(ev, chatId, sk, threadId) {
  if (ev.verb === 'view') return handlePr(chatId, ev.num, sk, threadId);
  if (ev.verb === 'review') return runAndSend(chatId, `/review ${ev.num}`, sk, threadId);
  if (ev.verb === 'approve') {
    const { ok, err } = await gh.approvePr(state.getRepo(sk), ev.num);
    return sendChunked(chatId, ok ? `✅ Approved PR #${ev.num}` : `Failed: ${err.slice(0, 300)}`, { threadId });
  }
  if (ev.verb === 'merge') {
    const { ok, err } = await gh.mergePr(state.getRepo(sk), ev.num);
    return sendChunked(chatId, ok ? `🔀 Merged PR #${ev.num}` : `Failed: ${err.slice(0, 300)}`, { threadId });
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

let offset = 0;
async function pollLoop() {
  console.log(`herald up; allowed=@${ALLOWED_USERNAME || ALLOWED_USER_ID} target=${TARGET_CONTAINER} (user=${TARGET_USER})`);
  registerCommands();
  approval.start(HOOK_SECRET);
  hookInstaller.ensureHook();
  const allowed = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
  let backoff = 0; // consecutive-failure counter for exponential backoff
  const sleepFor = () => 1000 * Math.min(60, 2 ** backoff);
  while (true) {
    try {
      const r = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${allowed}`);
      const j = await r.json();
      if (j.ok) {
        backoff = 0;
        for (const u of j.result) {
          offset = u.update_id + 1;
          if (u.message) handleMessage(u.message).catch((e) => log.error({ chatId: u.message?.chat?.id, err: String(e?.message || e), msg: 'message handler threw' }));
          else if (u.callback_query) handleCallback(u.callback_query).catch((e) => log.error({ chatId: u.callback_query?.message?.chat?.id, err: String(e?.message || e), msg: 'callback handler threw' }));
        }
      } else if (j.error_code === 409) {
        // Another poller owns this bot token — duplicate instance. Exit clean so the
        // orchestrator restarts a single fresh poller rather than fighting forever.
        console.error('getUpdates 409 conflict (another poller running) — exiting for clean restart:', j.description);
        process.exit(1);
      } else {
        console.error('getUpdates not ok:', j);
        await new Promise((r) => setTimeout(r, sleepFor()));
        backoff++;
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await new Promise((r) => setTimeout(r, sleepFor()));
      backoff++;
    }
  }
}

let shuttingDown = false;
async function gracefulExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  const affected = runner.runningEntries();
  for (const [, rec] of affected) {
    try { rec.child?.kill('SIGTERM'); } catch {}
  }
  await Promise.allSettled(affected.map(([sk]) => {
    const chatId = String(sk).split(':')[0];
    const threadId = String(sk).includes(':') ? Number(String(sk).split(':')[1]) : undefined;
    return sendChunked(chatId, '⚠️ Herald restarted — your run was interrupted, tap Continue.', { markup: defaultKeyboard(sk), threadId }).catch(() => {});
  }));
  process.exit(0);
}
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);

pollLoop();
