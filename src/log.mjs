// Tiny dependency-free structured logger: one JSON line per call to stdout/stderr.
// Usage: log.info({ sk, requestId, chatId, msg: 'something happened' }).
// Arbitrary fields are merged in; never pass secrets (e.g. HERALD_HOOK_SECRET).
function emit(level, fields) {
  const rec = (fields && typeof fields === 'object') ? fields : { msg: String(fields) };
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...rec });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  info: (fields) => emit('info', fields),
  warn: (fields) => emit('warn', fields),
  error: (fields) => emit('error', fields),
};
