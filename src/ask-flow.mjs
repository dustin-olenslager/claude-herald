// PURE ASK-queue logic. No I/O — parsing, formatting, and queue-advance DECISIONS
// only. The caller (runner/bot) owns the Telegram side-effects and the Map storage.

// The agent emits <<ASK>>[{q,opts[]}]<<END>> when blocked on the operator; we ask
// one question at a time with numbered buttons, collect, then resume the session.
export const ASK_INSTRUCTION = `When you need the operator to make ANY decision or choice — an approval, a which-way, a proceed-or-change, picking among paths — do NOT ask it in prose and do NOT fall back to a bare Yes/No. End your reply with a short human summary, THEN a single machine-readable block:
<<ASK>>
[{"q":"<the decision>","opts":["<specific action>","<specific action>","<specific action>"]}]
<<END>>
SMART options (this is the point): each opt is a CONCRETE, DISTINCT action labeled by what it DOES, not a generic yes/no. Cover the real branches the operator would actually pick, including their consequence. 2-4 opts per decision, one object per decision.
- Good: ["Approve all 4 ADRs — start Phase 2", "Revise ADR-0007 first", "Walk me through them before I decide"]
- Bad: ["Yes", "No"]   ← only acceptable when the choice is genuinely binary with no middle option.
If you catch yourself writing a "?" to the operator, convert that question into an <<ASK>> block with real options instead. Use it only when you genuinely need the operator to choose (otherwise emit <<CONTINUE>> and keep working).`;

// Tells the agent to KEEP GOING across phases instead of asking "Next?". When a unit of
// work finishes and a clear next step remains (and it's not blocked), it emits <<CONTINUE>>
// and the runner hands the rest to the autonomous supervisor — no per-phase babysitting.
export const CONTINUE_INSTRUCTION = `When you finish a unit of work (a phase or task) and a clear NEXT step remains in the SAME plan, and you are NOT blocked on an operator decision: do NOT ask "what's next" or stop for confirmation. End your reply with the marker <<CONTINUE>> on its own line — the system continues automatically in a fresh pass. Reserve <<ASK>> for when you genuinely need the operator to choose.`;

export function hasContinue(text) {
  return /<<CONTINUE>>/.test(text || '');
}

export function stripContinue(text) {
  return (text || '').replace(/<<CONTINUE>>/g, '').trim();
}

// An opt may arrive as a bare string (documented shape) OR as an AskUserQuestion-style
// object {label, description} — agents emit the latter from habit. Render the action
// label; never let String({}) leak "[object Object]" onto a button.
function optText(o) {
  if (o && typeof o === 'object') return String(o.label ?? o.text ?? o.title ?? JSON.stringify(o));
  return String(o);
}

export function parseAsk(text) {
  const m = (text || '').match(/<<ASK>>\s*([\s\S]*?)\s*<<END>>/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return null;
    return arr
      .filter((x) => x && x.q && Array.isArray(x.opts) && x.opts.length)
      .map((x) => ({ q: String(x.q), opts: x.opts.slice(0, 4).map(optText) }));
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
