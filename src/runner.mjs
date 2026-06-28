import { spawn } from 'node:child_process';
import { TLDR_INSTRUCTION, splitTldr, costFooter } from './tldr.mjs';
import { ASK_INSTRUCTION, CONTINUE_INSTRUCTION, parseAsk, stripAsk, detectYesNo, askKeyboard, nextAfterAnswer, hardStopAsk, runHardStopAsk, hasContinue, stripContinue } from './ask-flow.mjs';
import { log } from './log.mjs';

// Phalanx PreToolUse safety gates installed in the target container's ~/.claude.
// Herald's `--settings` REPLACES the container's hook set, so unless we re-list these
// the migration/merge (loop-integrity 5c/5d), secret, pipeline and arch guards silently
// vanish for Telegram-driven agents. Deny wins across hooks, so they still block even in
// yolo mode. Override via deps.PHALANX_GATE_FILES (e.g. [] in tests).
const PHALANX_GATE_FILES = ['pipeline-gate.js', 'effect-ca-gate.js', 'secret-gate.js', 'loop-integrity-gate.js'];

// True when a `claude -p --resume <id>` failed because the session no longer
// exists — the signal to drop the stored session and start fresh instead of erroring.
export function isStaleSessionError(message) {
  return /No conversation found with session ID/i.test(String(message || ''));
}

// Owns the docker-exec `claude -p` pass plus the run-lifecycle Maps:
//   runningProcs  — sk -> { child, startedAt, stopRequested }
//   askQueues     — sk -> { items, answers, idx }
//   askPendingOther — sk -> idx awaiting a typed custom answer
// Exposed via accessors so the dispatch layer can check/advance without owning them.
export function makeRunner({ exec, state, tg, supervisor, keyboards, ensureHook, deps }) {
  const { TARGET_CONTAINER } = deps;
  const { defaultKeyboard, questionKeyboard } = keyboards;

  const runningProcs = new Map();
  const askQueues = new Map();
  const askPendingOther = new Map();

  function isRunning(sk) { return runningProcs.has(sk); }
  function getProc(sk) { return runningProcs.get(sk); }
  function deleteProc(sk) { runningProcs.delete(sk); }
  function runningEntries() { return [...runningProcs.entries()]; }

  function getAsk(sk) { return askQueues.get(sk); }
  function hasPendingOther(sk) { return askPendingOther.has(sk); }
  function takePendingOther(sk) { const i = askPendingOther.get(sk); askPendingOther.delete(sk); return i; }
  function setPendingOther(sk, idx) { askPendingOther.set(sk, idx); }

  async function presentAsk(chatId, sk, threadId) {
    const q = askQueues.get(sk);
    if (!q) return;
    const item = q.items[q.idx];
    await tg.sendChunked(chatId, `❓ Q${q.idx + 1}/${q.items.length}: ${item.q}`, { threadId, markup: askKeyboard(q.items, q.idx) });
  }

  function startAskQueue(chatId, sk, threadId, items) {
    askQueues.set(sk, { items, answers: [], idx: 0 });
    return presentAsk(chatId, sk, threadId);
  }

  async function advanceAsk(chatId, sk, threadId) {
    const q = askQueues.get(sk);
    if (!q) return;
    const decision = nextAfterAnswer(q);
    if (decision.kind === 'present') {
      q.idx = decision.idx;
      return presentAsk(chatId, sk, threadId);
    }
    askQueues.delete(sk);
    await tg.sendChunked(chatId, `Got it:\n${decision.compiled}`, { threadId });
    return runAndSend(chatId, `My decisions:\n${decision.compiled}`, sk, threadId);
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
        '--append-system-prompt', `${TLDR_INSTRUCTION}\n\n${ASK_INSTRUCTION}\n\n${CONTINUE_INSTRUCTION}`,
      ];
      if (sessionId) claudeArgs.push('--resume', sessionId);

      const phalanxGates = (deps.PHALANX_GATE_FILES ?? PHALANX_GATE_FILES)
        .map((f) => ({ type: 'command', command: `node "$HOME/.claude/${f}"` }));
      const hookSettings = {
        hooks: {
          PreToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: deps.HOOK_PATH }] },
            // Re-attach the phalanx gates Herald's --settings would otherwise drop, on
            // their own matcher. Without this, Telegram-driven agents bypass 5c/5d and can
            // merge migration branches / leak secrets unguarded.
            ...(phalanxGates.length
              ? [{ matcher: 'Skill|Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: phalanxGates }]
              : []),
          ],
        },
      };
      claudeArgs.push('--settings', JSON.stringify(hookSettings));
      // Always bypass CC's built-in prompts so OUR PreToolUse hook is the sole gate.
      claudeArgs.push('--permission-mode', 'bypassPermissions');

      const dockerArgs = [
        'exec', '-i',
        '-u', exec.user,
        '-w', cwd,
        '-e', `HERALD_CHAT_ID=${chatId}`,
        '-e', `HERALD_THREAD_ID=${threadId || ''}`,
        '-e', `HERALD_MODE=${mode}`,
        '-e', `HERALD_URL=${deps.BOT_URL_FOR_HOOK}`,
        '-e', `HERALD_HOOK_SECRET=${deps.HOOK_SECRET}`,
        '-e', `APPROVAL_TIMEOUT_SECONDS=${process.env.APPROVAL_TIMEOUT_SECONDS || 300}`,
        '-e', 'PATH=/home/cc/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
        '-e', `API_TIMEOUT_MS=${deps.API_TIMEOUT_MS}`,
        '-e', `BASH_DEFAULT_TIMEOUT_MS=${deps.BASH_DEFAULT_TIMEOUT_MS}`,
        '-e', `BASH_MAX_TIMEOUT_MS=${deps.BASH_MAX_TIMEOUT_MS}`,
        exec.container,
        'claude', ...claudeArgs,
      ];

      const child = spawn('docker', dockerArgs);
      const rec = runningProcs.get(sk) || {};
      rec.child = child;
      rec.startedAt = rec.startedAt || Date.now();
      runningProcs.set(sk, rec);
      child.stdin.on('error', () => {});
      try { child.stdin.write(prompt); child.stdin.end(); } catch {}

      let out = '', err = '';
      let timedOut = false;
      const CLAUDE_TIMEOUT_MS = deps.CLAUDE_TIMEOUT_MS;
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
    // Reserve the slot SYNCHRONOUSLY before any await — two rapid messages could both
    // pass an upstream runningProcs.has() check otherwise (awaits in runClaude widen the
    // TOCTOU window). runClaude attaches the child to this placeholder; every exit path
    // deletes it (success/error/stopped).
    if (runningProcs.has(sk)) {
      return tg.sendChunked(chatId, '⏳ Task running — message NOT sent. Stop first.', { markup: defaultKeyboard(sk), threadId });
    }
    runningProcs.set(sk, { startedAt: Date.now() });
    await ensureHook();
    askQueues.delete(sk); askPendingOther.delete(sk);
    await tg.tg('sendChatAction', { chat_id: chatId, message_thread_id: threadId || undefined, action: 'typing' });
    const heartbeat = setInterval(() => {
      tg.tg('sendChatAction', { chat_id: chatId, message_thread_id: threadId || undefined, action: 'typing' }).catch(() => {});
    }, 4000);
    try {
      let result;
      try {
        result = await runClaude(prompt, chatId, sk, threadId);
      } catch (e) {
        // A stale/expired --resume id hard-fails with "No conversation found with
        // session ID". Don't error the user out of the topic — drop the dead session
        // and retry once as a FRESH session (no --resume).
        if (isStaleSessionError(e?.message) && state.getSession(sk)) {
          log.warn({ sk, chatId, msg: 'stale session id — clearing, retrying fresh' });
          state.clearSession(sk);
          await tg.sendChunked(chatId, '↻ Previous session expired — starting fresh.', { threadId }).catch(() => {});
          result = await runClaude(prompt, chatId, sk, threadId);
        } else {
          throw e;
        }
      }
      state.setSession(sk, result.session_id);
      const body = result.result ?? JSON.stringify(result, null, 2);
      const { tldr, details } = splitTldr(body);
      state.setLastResponse(sk, { tldr, details, model: state.getModel(sk) });
      const ask = parseAsk(body);
      if (ask && ask.length) {
        const preface = stripAsk(tldr);
        if (preface) await tg.sendChunked(chatId, preface, { threadId });
        return startAskQueue(chatId, sk, threadId, ask);
      }
      // Hard stop reported in prose without an explicit <<ASK>> (BLOCKED / gate deny /
      // sign-off): the operator must ALWAYS get a selectable decision, never a text wall.
      const hs = hardStopAsk(body);
      if (hs) {
        await tg.sendChunked(chatId, tldr, { threadId });
        return startAskQueue(chatId, sk, threadId, hs);
      }
      // Agent signalled more work + not blocked (<<CONTINUE>>) → drive the rest
      // autonomously instead of asking "Next?". Falls back to a manual Continue if the
      // supervisor is disabled or fails to launch.
      if (hasContinue(body)) {
        const clean = stripContinue(tldr);
        if (clean) await tg.sendChunked(chatId, clean, { threadId });
        if (await supervisor.continueAutonomously(chatId, sk, threadId, defaultKeyboard)) return;
        return tg.sendChunked(chatId, '↪️ Tap Continue to keep going.', { markup: defaultKeyboard(sk), threadId });
      }
      const markup = detectYesNo(tldr) ? questionKeyboard(sk) : defaultKeyboard(sk);
      await tg.sendChunked(chatId, tldr + costFooter(result, state.getModel(sk)), { markup, threadId });
      // No success-path escalation: a normal completed turn must NOT hand the repo to the
      // supervisor just because TASKS.md has unrelated open items. Only genuinely
      // unfinished runs (timeout/limit) escalate — see the timed-out branch below.
    } catch (e) {
      if (e.message === 'stopped') {
        await tg.sendChunked(chatId, '🛑 Stopped.', { markup: defaultKeyboard(sk), threadId });
      } else {
        log.error({ sk, chatId, err: String(e?.message || e).slice(0, 500), msg: 'claude run errored' });
        const full = e.message;
        const containerDown = /container .* is not running|No such container/.test(full);
        const isTimeout = full.includes('timed out');
        let summary;
        if (containerDown) summary = `⚠️ ${TARGET_CONTAINER} not running.`;
        else if (isTimeout) summary = `⏱️ Timed out after ${Math.round(deps.CLAUDE_TIMEOUT_MS / 60000)} min.`;
        else summary = `⚠️ Claude errored. Tap 📖 Details for full trace.`;
        state.setLastResponse(sk, { tldr: summary, details: full, model: state.getModel(sk) });
        await tg.sendChunked(chatId, summary, { threadId });
        // Timeout = unfinished work, not a decision → auto-continue via the supervisor.
        // Error = a real failure → selectable decision. Timeout falls back to the question
        // if auto-continue is disabled or the launch fails.
        if (isTimeout && await supervisor.continueAutonomously(chatId, sk, threadId, defaultKeyboard)) return;
        return startAskQueue(chatId, sk, threadId, runHardStopAsk(isTimeout ? 'timeout' : 'error'));
      }
    } finally {
      clearInterval(heartbeat);
      // Defensive: ensure no placeholder is left if runClaude bailed before spawn.
      runningProcs.delete(sk);
    }
  }

  function handleStop(chatId, sk, threadId) {
    const rec = runningProcs.get(sk);
    if (!rec) return tg.sendChunked(chatId, 'Nothing running.', { markup: defaultKeyboard(sk), threadId });
    rec.stopRequested = true;
    if (!rec.child) { runningProcs.delete(sk); return tg.sendChunked(chatId, '🛑 Stopped (was starting).', { markup: defaultKeyboard(sk), threadId }); }
    rec.child.kill('SIGTERM');
    setTimeout(() => { try { rec.child.kill('SIGKILL'); } catch {} }, 3000);
    return tg.sendChunked(chatId, '🛑 Stop sent.', { threadId });
  }

  return {
    runAndSend, handleStop,
    startAskQueue, advanceAsk,
    isRunning, getProc, deleteProc, runningEntries,
    getAsk, hasPendingOther, takePendingOther, setPendingOther,
  };
}
