import { log } from './log.mjs';

// Phalanx no-babysit hand-off: when an inline run leaves work unfinished, launch
// the detached supervisor in the target container to finish across fresh sessions.
export function makeSupervisor({ exec, state, tg, deps }) {
  const { AUTO_ESCALATE, BOT_URL_FOR_HOOK, HOOK_SECRET, SUPERVISORD_PATH } = deps;

  // Launch the detached supervisor; it relaunches fresh `claude -p "/work"` passes
  // until backlog done/BLOCKED, posting status to our /event endpoint. Idempotent:
  // supervisord refuses a second one.
  async function launchSupervisor(cwd, chatId) {
    log.info({ chatId, cwd, msg: 'launchSupervisor attempt' });
    const notifyUrl = `${BOT_URL_FOR_HOOK}/event${chatId ? `?chatId=${chatId}` : ''}`;
    await exec.execFileP('docker', ['exec', '-u', exec.user,
      '-e', `PHALANX_NOTIFY_URL=${notifyUrl}`,
      '-e', `PHALANX_NOTIFY_SECRET=${HOOK_SECRET}`,
      '-e', 'PATH=/home/cc/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
      exec.container, 'bash', SUPERVISORD_PATH, 'start', '-r', cwd]);
    log.info({ chatId, cwd, msg: 'launchSupervisor ok' });
  }

  // After an inline run, if work is unfinished (open tasks remain, or it timed out),
  // hand the repo to the supervisor and tell the user. No-op when nothing's pending.
  async function maybeEscalate(chatId, sk, threadId, reason, defaultKeyboard) {
    if (!AUTO_ESCALATE) return false;
    const cwd = state.getRepo(sk);
    if (!(await exec.repoHasOpenTasks(cwd))) return false;
    try { await launchSupervisor(cwd, chatId); }
    catch (e) {
      log.error({ chatId, cwd, reason, err: String(e?.message || e), msg: 'launchSupervisor failed' });
      await tg.sendChunked(chatId,
        `⚠️ Run didn't finish (${reason}) and the autonomous supervisor failed to launch — pick up manually with Continue.`,
        { markup: defaultKeyboard(sk), threadId }).catch(() => {});
      return false;
    }
    await tg.sendChunked(chatId,
      `🤖 Didn't finish in one pass (${reason}). Handed to the autonomous supervisor — ` +
      `it'll drive it to done across fresh sessions and message you on progress / done / blocked.`,
      { markup: defaultKeyboard(sk), threadId });
    return true;
  }

  return { launchSupervisor, maybeEscalate };
}
