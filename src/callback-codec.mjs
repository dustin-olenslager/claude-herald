// Single source of truth for callback_data wire strings shared by the keyboard
// producers and the router. Keep encode/decode in lock-step so a refactor can't
// drift the two apart. PURE — no I/O.

export function decode(data) {
  const s = data || '';
  if (s === 'details' || s === 'continue' || s === 'new' || s === 'stop' ||
      s === 'settings' || s === 'menu:close' || s === 'noop') {
    return { kind: s };
  }
  if (s.startsWith('confirm:')) return { kind: 'confirm', answer: s.slice(8) === 'y' ? 'Yes' : 'No' };
  if (s.startsWith('ask:')) {
    const [, idxStr, pick] = s.split(':');
    return { kind: 'ask', idx: Number(idxStr), pick };
  }
  if (s.startsWith('mode:')) return { kind: 'mode', value: s.slice(5) };
  if (s.startsWith('model:')) return { kind: 'model', value: s.slice(6) };
  if (s.startsWith('appr:')) {
    const [, verdict, requestId] = s.split(':');
    return { kind: 'appr', ok: verdict === 'y', requestId };
  }
  if (s.startsWith('notif:')) {
    const parts = s.split(':');
    return { kind: 'notif', verb: parts[1], key: parts[2], token: parts[parts.length - 1] };
  }
  if (s.startsWith('pr:')) {
    const [, verb, num] = s.split(':');
    return { kind: 'pr', verb, num };
  }
  if (s.startsWith('repopick:')) return { kind: 'repopick', idx: Number(s.split(':')[1]) };
  return { kind: 'unknown', raw: s };
}

export const enc = {
  confirm: (yes) => `confirm:${yes ? 'y' : 'n'}`,
  ask: (idx, pick) => `ask:${idx}:${pick}`,
  appr: (yes, id) => `appr:${yes ? 'y' : 'n'}:${id}`,
  notifKey: (key, token) => `notif:k:${key}:${token}`,
  notifReply: (token) => `notif:reply:${token}`,
  notifEsc: (token) => `notif:esc:${token}`,
  mode: (m) => `mode:${m}`,
  model: (m) => `model:${m}`,
  prView: (num) => `pr:view:${num}`,
  prReview: (num) => `pr:review:${num}`,
  prApprove: (num) => `pr:approve:${num}`,
  prMerge: (num) => `pr:merge:${num}`,
  repoPick: (i) => `repopick:${i}`,
};
