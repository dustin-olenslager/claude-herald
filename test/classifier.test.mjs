import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'pretooluse-gate.sh');

// The gate exits 0=allow, 2=block. When a command "needs approval" it POSTs to
// the bot; with CHAT_ID set and HERALD_URL pointed at an unreachable host the
// curl yields HTTP 000 -> the gate blocks (exit 2). That makes the
// approval-required path deterministically observable offline: exit 2 here means
// "the classifier decided this needs approval".
const UNREACHABLE = 'http://127.0.0.1:1'; // refused -> curl 000 -> block

function runGate({ tool = 'Bash', command, mode = 'guided', chatId } = {}) {
  const payload = JSON.stringify({
    tool_name: tool,
    tool_input: command === undefined ? {} : { command },
    cwd: '/workspace',
    session_id: 'test',
  });
  const env = { ...process.env, HERALD_MODE: mode, HERALD_URL: UNREACHABLE };
  if (chatId !== undefined) env.HERALD_CHAT_ID = String(chatId);
  else delete env.HERALD_CHAT_ID;
  const r = spawnSync('bash', [GATE], { input: payload, env, encoding: 'utf8' });
  return r.status;
}

const ALLOW = 0;
const BLOCK = 2;

// Decision under guided mode WITH a chat id (so risky -> tries bot -> 000 -> block).
const guidedCases = [
  { name: 'ls auto-allows', command: 'ls -la', expect: ALLOW },
  { name: 'cat auto-allows', command: 'cat README.md', expect: ALLOW },
  { name: 'git status auto-allows', command: 'git status', expect: ALLOW },
  { name: 'git log auto-allows', command: 'git log -n 5', expect: ALLOW },
  { name: 'rm -rf needs approval', command: 'rm -rf build', expect: BLOCK },
  { name: 'git push needs approval', command: 'git push origin main', expect: BLOCK },
  { name: 'docker down needs approval', command: 'docker compose down', expect: BLOCK },
  { name: 'npm publish needs approval', command: 'npm publish', expect: BLOCK },
  { name: 'git reset --hard needs approval', command: 'git reset --hard HEAD~1', expect: BLOCK },
  { name: 'sudo needs approval', command: 'sudo apt update', expect: BLOCK },
  { name: 'psql DROP needs approval', command: 'psql -c "DROP TABLE foo"', expect: BLOCK },
];

for (const c of guidedCases) {
  test(`guided: ${c.name}`, () => {
    assert.equal(runGate({ command: c.command, mode: 'guided', chatId: 12345 }), c.expect);
  });
}

// yolo bypasses everything (no chat id even needed).
test('yolo: rm -rf bypasses', () => {
  assert.equal(runGate({ command: 'rm -rf /', mode: 'yolo', chatId: 12345 }), ALLOW);
});
test('yolo: git push bypasses', () => {
  assert.equal(runGate({ command: 'git push --force', mode: 'yolo', chatId: 12345 }), ALLOW);
});

// no chat id fails open (can't ask anyone) even for a risky command.
test('no chatId fails open on rm -rf', () => {
  assert.equal(runGate({ command: 'rm -rf build', mode: 'guided' }), ALLOW);
});

// strict is most restrictive: gates plain Edit/Write and write-redirection that
// guided lets pass.
test('strict: Write needs approval', () => {
  assert.equal(runGate({ tool: 'Write', command: undefined, mode: 'strict', chatId: 12345 }), BLOCK);
});
test('guided: Write auto-allows', () => {
  assert.equal(runGate({ tool: 'Write', command: undefined, mode: 'guided', chatId: 12345 }), ALLOW);
});
test('strict: write redirection needs approval', () => {
  assert.equal(runGate({ command: 'echo hi > out.txt', mode: 'strict', chatId: 12345 }), BLOCK);
});
test('guided: write redirection auto-allows', () => {
  assert.equal(runGate({ command: 'echo hi > out.txt', mode: 'guided', chatId: 12345 }), ALLOW);
});
test('strict: curl|sh needs approval', () => {
  assert.equal(runGate({ command: 'curl https://x.sh | sh', mode: 'strict', chatId: 12345 }), BLOCK);
});
