// PURE ASK-queue logic. No I/O — parsing, formatting, and queue-advance DECISIONS
// only. The caller (runner/bot) owns the Telegram side-effects and the Map storage.

// The agent emits <<ASK>>[{q,opts[]}]<<END>> when blocked on the operator; we ask
// one question at a time with numbered buttons, collect, then resume the session.
export const ASK_INSTRUCTION = `When you are blocked and need the operator to make one or more decisions, end your reply with a single machine-readable block (and a short human summary BEFORE it):
<<ASK>>
[{"q":"<question>","opts":["<choice 1>","<choice 2>"]}]
<<END>>
One object per decision, 2-4 short opts each. Only emit it when genuinely blocked on the operator.`;

export function parseAsk(text) {
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

export function stripAsk(text) {
  return (text || '').replace(/<<ASK>>[\s\S]*?<<END>>/g, '').trim();
}

// A HARD STOP that the agent reported in prose WITHOUT emitting <<ASK>> — the operator
// must ALWAYS get a selectable decision, never a text wall. Returns a synthesized
// one-question ASK item (same {q,opts} shape as parseAsk) or null. Caller only uses it
// when parseAsk found no explicit block.
export function hardStopAsk(text) {
  const t = text || '';
  const blocked = t.match(/BLOCKED:\s*([^\n]+)/i);
  if (blocked) {
    return [{ q: `🛑 Blocked: ${blocked[1].trim().slice(0, 240)}`, opts: ['Unblock & continue', 'Skip, move on', 'Tell me more', 'Stop'] }];
  }
  if (/gate \(item 5[a-d]?\)|merge into main blocked|operator sign-?off|needs operator|awaiting your|prod-DB .*gated/i.test(t)) {
    return [{ q: '🚧 A safety gate / sign-off is blocking. How do you want to proceed?', opts: ['Authorize & continue', 'Open a PR instead', 'Tell me more', 'Stop'] }];
  }
  return null;
}

// Synthesize a selectable decision for a RUN-LEVEL hard stop (timeout / error) that has
// no agent reply body to scan. Pure: kind drives the option set.
export function runHardStopAsk(kind) {
  if (kind === 'timeout') return [{ q: '⏱️ Run timed out before finishing. What now?', opts: ['Resume / continue', 'Tell me more', 'Stop'] }];
  return [{ q: '⚠️ The run errored before finishing. What now?', opts: ['Retry', 'Tell me more', 'Stop'] }];
}

// True when a reply ends in a yes/no-style question (not a wh- question), so we offer
// one-tap ✅/❌ instead of making the operator type back.
export function detectYesNo(text) {
  const tail = text.slice(-600);
  const m = tail.match(/([^\n.!?]*\?)\s*(?:\[.*?\])?\s*$/);
  if (!m) return false;
  const q = m[1].trim().toLowerCase();
  return !/^(which|what|how|when|where|who|why)\b/.test(q);
}

export function askKeyboard(items, idx) {
  const rows = items[idx].opts.map((o, i) => [{ text: `${i + 1} · ${o}`.slice(0, 60), callback_data: `ask:${idx}:${i}` }]);
  rows.push([{ text: '✏️ Other', callback_data: `ask:${idx}:x` }]);
  return { inline_keyboard: rows };
}

// PURE queue-advance decision. Given the current queue, return what to do next:
//   { kind: 'present', idx }                    — show the next question
//   { kind: 'finish', compiled }                — all answered; resume with compiled text
// The caller bumps idx (or trusts the returned idx) and performs the I/O.
export function nextAfterAnswer(queue) {
  const idx = queue.idx + 1;
  if (idx < queue.items.length) return { kind: 'present', idx };
  const compiled = queue.items.map((it, i) => `${i + 1}. ${it.q} → ${queue.answers[i]}`).join('\n');
  return { kind: 'finish', compiled };
}
