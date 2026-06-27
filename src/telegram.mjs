import fs from 'node:fs';
import crypto from 'node:crypto';
import { log } from './log.mjs';

const FETCH_TIMEOUT_MS = Number(process.env.TG_FETCH_TIMEOUT_MS) || 30000;
const FETCH_ATTEMPTS = Number(process.env.TG_FETCH_ATTEMPTS) || 3;

// fetch with an AbortController timeout and a small retry. Retries on network
// errors/timeouts and HTTP 429 (honoring Telegram's retry_after), and on 5xx.
// Throws after the last attempt so callers can decide what to do.
async function fetchWithRetry(url, opts = {}, { attempts = FETCH_ATTEMPTS, label = 'fetch' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if ((r.status === 429 || r.status >= 500) && i < attempts) {
        let wait = 2 ** i; // seconds
        if (r.status === 429) {
          const j = await r.clone().json().catch(() => null);
          const ra = j?.parameters?.retry_after;
          if (ra) wait = Number(ra);
        }
        log.warn({ label, attempt: i, status: r.status, waitS: wait, msg: 'tg fetch retry' });
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      return r;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < attempts) {
        const wait = 2 ** i;
        log.warn({ label, attempt: i, err: String(e?.message || e), waitS: wait, msg: 'tg fetch error retry' });
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
    }
  }
  throw lastErr || new Error(`${label} failed after ${attempts} attempts`);
}

// Telegram Bot API surface, bound once to a token at the composition root.
// `state` and the container-copy helper are injected so this module has no
// reach into app state or docker directly.
export function makeTelegram({ token, state, copyFileToContainer }) {
  const API = `https://api.telegram.org/bot${token}`;

  async function tg(method, body) {
    const r = await fetchWithRetry(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { label: `tg:${method}` });
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
  // own thread. Caches the id; caches 0 when the chat is not a forum so we fall back to
  // flat and never retry. Returns a message_thread_id, or undefined to send flat.
  async function topicFor(chatId, name) {
    if (!name) return undefined;
    const cached = state.getTopic(chatId, name);
    if (cached !== undefined) return cached || undefined; // 0 -> flat
    const r = await tg('createForumTopic', { chat_id: chatId, name: String(name).slice(0, 128) }).catch(() => null);
    const id = (r && r.ok && r.result && r.result.message_thread_id) || 0;
    state.setTopic(chatId, name, id); // 0 = flat (not a forum / no rights)
    return id || undefined;
  }

  async function downloadTgFile(fileId, ext = '.bin') {
    const gf = await tg('getFile', { file_id: fileId });
    if (!gf.ok) return { error: gf.description || 'getFile failed' };
    const tgPath = gf.result.file_path;
    const url = `https://api.telegram.org/file/bot${token}/${tgPath}`;
    let res;
    try { res = await fetchWithRetry(url, {}, { label: 'tg:download' }); }
    catch (e) { return { error: `download failed: ${String(e?.message || e).slice(0, 200)}` }; }
    if (!res.ok) return { error: `download ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const stem = `herald-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const localPath = `/tmp/${stem}`;
    fs.writeFileSync(localPath, buf);
    try {
      await copyFileToContainer(localPath);
    } catch (e) {
      return { error: `copy to target failed: ${String(e.message).slice(0, 200)}` };
    } finally {
      try { fs.unlinkSync(localPath); } catch {}
    }
    return { path: localPath, bytes: buf.length };
  }

  return { tg, sendChunked, topicFor, downloadTgFile };
}

// ── Pure keyboard builders ────────────────────────────────────────
// These depend only on per-sk flags the caller passes in, so they stay pure and
// share callback-data shapes with the codec.

export function defaultKeyboard({ hasSession, running, hasDetails }) {
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

export function questionKeyboard(base) {
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

export function approvalKeyboard(requestId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `appr:y:${requestId}` },
        { text: '❌ Deny', callback_data: `appr:n:${requestId}` },
      ],
    ],
  };
}

export function notifyKeyboard(token) {
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
