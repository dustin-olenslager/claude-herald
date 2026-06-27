import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE_FILE = process.env.STATE_FILE || '/data/state.json';

const DEFAULT_STATE = {
  sessions: {},       // chatId -> claude session_id
  models: {},         // chatId -> model name
  modes: {},          // chatId -> strict | guided | yolo
  lastResponse: {},   // chatId -> { tldr, details, ts, model }
  repos: {},          // chatId -> current working repo path
  topics: {},         // `${chatId}:${name}` -> forum topic message_thread_id (0 = flat / not a forum)
  knownUserId: null,
  hookSecret: null,   // shared secret authing the HTTP boundary (hooks/supervisor/cron)
};

let state = { ...DEFAULT_STATE };

try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state = { ...DEFAULT_STATE, ...raw };
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.warn(`state load failed (${e.message}); starting from defaults — ${STATE_FILE} NOT overwritten until next save`);
  }
}

export function get() {
  return state;
}

export function save() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

export function getMode(chatId) {
  return state.modes[chatId] || process.env.DEFAULT_MODE || 'guided';
}

export function setMode(chatId, mode) {
  state.modes[chatId] = mode;
  save();
}

export function getModel(chatId) {
  return state.models[chatId] || process.env.DEFAULT_MODEL || 'sonnet';
}

export function setModel(chatId, model) {
  state.models[chatId] = model;
  save();
}

export function getSession(chatId) {
  return state.sessions[chatId];
}

export function setSession(chatId, sessionId) {
  if (sessionId && state.sessions[chatId] !== sessionId) {
    state.sessions[chatId] = sessionId;
    save();
  }
}

export function clearSession(chatId) {
  delete state.sessions[chatId];
  delete state.lastResponse[chatId];
  save();
}

export function getLastResponse(chatId) {
  return state.lastResponse[chatId];
}

export function setLastResponse(chatId, payload) {
  state.lastResponse[chatId] = { ...payload, ts: Date.now() };
  save();
}

export function getRepo(chatId) {
  return state.repos[chatId] || process.env.TARGET_WORKDIR || '/workspace';
}

// Comma-separated allowed roots; default /workspace. Unsanitized cwd flows into
// `docker exec -w` and `supervisord -r`, so the path is validated before persist.
export function repoAllowedRoots() {
  return (process.env.HERALD_REPO_ROOTS || '/workspace')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

// Pure validator: returns { ok, path } or { ok:false, reason }. Rejects relative
// paths, '..' traversal, shell metacharacters, and anything outside an allowed root.
// Filesystem/container existence is checked separately by the caller.
export function validateRepoPath(raw, roots = repoAllowedRoots()) {
  const p = String(raw || '').trim();
  if (!p) return { ok: false, reason: 'empty path' };
  if (!p.startsWith('/')) return { ok: false, reason: 'must be an absolute path' };
  if (p.includes('..')) return { ok: false, reason: "must not contain '..'" };
  if (/[;&|`$(){}<>*?!\\\s'"\n\r]/.test(p)) return { ok: false, reason: 'contains forbidden characters' };
  const norm = path.posix.normalize(p).replace(/\/+$/, '') || '/';
  const under = roots.some((r) => {
    const root = path.posix.normalize(r).replace(/\/+$/, '') || '/';
    return norm === root || norm.startsWith(root + '/');
  });
  if (!under) return { ok: false, reason: `must be under: ${roots.join(', ')}` };
  return { ok: true, path: norm };
}

export function setRepo(chatId, repoPath) {
  const v = validateRepoPath(repoPath);
  if (!v.ok) throw new Error(`invalid repo path: ${v.reason}`);
  state.repos[chatId] = v.path;
  save();
}

// Per-job forum topic cache. undefined = never tried; a number = topic id; 0 = tried
// and the chat is not a forum (so route flat and don't retry).
export function getTopic(chatId, name) {
  return state.topics[`${chatId}:${name}`];
}

export function setTopic(chatId, name, threadId) {
  state.topics[`${chatId}:${name}`] = threadId;
  save();
}

// Shared secret authing /approve, /notify, /event and read by the host watch-cron
// from state.json. Env override wins; otherwise generate-once and persist so it
// survives restarts. crypto.timingSafeEqual is used at the boundary, not here.
export function getHookSecret() {
  return process.env.HERALD_HOOK_SECRET || state.hookSecret || null;
}

export function ensureHookSecret() {
  const existing = getHookSecret();
  if (existing) return existing;
  state.hookSecret = crypto.randomBytes(24).toString('hex');
  save();
  return state.hookSecret;
}

// The forum supergroup's chat id (negative), learned from the first topic message.
// Lets cold-start supervisors route reports to per-repo topics instead of the DM.
export function getForumChatId() { return state.forumChatId; }
export function setForumChatId(chatId) {
  if (state.forumChatId !== chatId) { state.forumChatId = chatId; save(); }
}
