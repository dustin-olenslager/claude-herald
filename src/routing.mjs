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

// Where a supervisor /event report should land, in precedence order:
//  1. explicit numeric thread — the job started in a known topic -> route there
//  2. the repo's CANONICAL topic — the one a human bound to this repo -> route there
//     (this is what stops cron/cold-start jobs spawning a duplicate "<repo>" topic)
//  3. otherwise -> create a "<repo-basename>" topic (caller binds it for next time)
//  4. nothing identifiable -> flat
export function resolveReportTopic({ thread, repo, repoTopic } = {}) {
  const t = Number(thread);
  if (Number.isInteger(t) && t > 0) return { kind: 'thread', threadId: t };
  const rt = Number(repoTopic);
  if (Number.isInteger(rt) && rt > 0) return { kind: 'existing', threadId: rt };
  const name = (repo ? String(repo).split('/').pop() : '').trim();
  if (name) return { kind: 'create', name };
  return { kind: 'flat' };
}
