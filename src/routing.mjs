// Pure routing decision for supervisor /event reports. Keeps the topic-vs-name
// choice unit-testable and out of the I/O handler.

// An explicit numeric thread id means the job started in a known forum topic ->
// route straight back to it. Otherwise fall back to the repo basename so a cron /
// cold-start job (no originating topic) gets its own auto-created "<repo>" topic.
// Neither -> flat (DM / General).
export function resolveEventThread({ thread, repo } = {}) {
  const t = Number(thread);
  if (Number.isInteger(t) && t > 0) return { kind: 'thread', threadId: t };
  const name = (repo ? String(repo).split('/').pop() : '').trim();
  if (name) return { kind: 'name', name };
  return { kind: 'flat' };
}
