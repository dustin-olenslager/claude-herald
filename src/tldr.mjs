export const DETAILS_MARKER = '===DETAILS===';

export const TLDR_INSTRUCTION = `[Telegram-bot output format — applies to EVERY response in this session]
You are responding to a user on Telegram who reads on their phone. Follow this format strictly:

1. A 1-3 sentence summary up front: what you did, what you found, or what you'll do next. Plain text, no markdown headers, no bullet points.
2. The exact marker "${DETAILS_MARKER}" on its own line.
3. Full details after the marker — code blocks, lists, longer explanation, etc.

If your full answer is already under ~400 chars or is a single direct question/answer, OMIT the marker and details section entirely — send just the short reply.

Examples of correct summaries: "Fixed 3 auth redirects in [accounts/page.tsx:22]." · "Need clarification — do you want me to drop or rename the column?" · "Tests pass. 47 green, 0 fail."

Never start with "I'll now…", "Let me…", or restate the user's question. Just the result.`;

export function splitTldr(text) {
  const idx = text.indexOf(DETAILS_MARKER);
  if (idx !== -1) {
    const tldr = text.slice(0, idx).trim();
    const details = text.slice(idx + DETAILS_MARKER.length).trim();
    return { tldr: tldr || text, details: details || null };
  }
  if (text.length > 600) {
    const cut = text.slice(0, 500);
    const lastSpace = cut.lastIndexOf(' ');
    const tldr = (lastSpace > 300 ? cut.slice(0, lastSpace) : cut) + '…';
    return { tldr, details: text };
  }
  return { tldr: text, details: null };
}

export function fmtTok(n) {
  if (n == null) return '?';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

export function costFooter(result, model) {
  const cost = result.total_cost_usd;
  const u = result.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  const dur = result.duration_ms ? ` · ${(result.duration_ms / 1000).toFixed(1)}s` : '';
  const c = cost != null ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : '?';
  return `\n\n[${c} · ${fmtTok(inTok)}→${fmtTok(outTok)} · ${model}${dur}]`;
}
