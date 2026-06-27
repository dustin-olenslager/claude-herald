import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

// All docker exec/cp against the single target container live here, with the
// container/user pinned at construction. Nothing else in the app should reach
// for `docker` directly. `spawn` (streaming claude run) stays in runner.mjs.
export function makeContainerExec({ container, user }) {
  // Only targets matching herald-tmux.sh's scheme (<session>:0.0) may receive
  // send-keys, so a rogue /notify caller can't aim keystrokes at an arbitrary pane.
  const TMUX_TARGET_RE = /^[A-Za-z0-9_.-]+:0\.0$/;

  // Copy a host file into the target container at the same path and make it readable.
  async function copyFileToContainer(localPath) {
    await execFileP('docker', ['cp', localPath, `${container}:${localPath}`]);
    await execFileP('docker', ['exec', '-u', 'root', container, 'chmod', '644', localPath]);
  }

  async function copyAndChmod(src, dst) {
    await execFileP('docker', ['cp', src, `${container}:${dst}`]);
    await execFileP('docker', ['exec', '-u', 'root', container, 'chmod', '+x', dst]);
  }

  // Send keystrokes into an interactive Claude session running in tmux. `text` is
  // appended with Enter unless it's the literal sentinel 'ESC' (sent as Escape key).
  // The container is PINNED here — a client-supplied container is never trusted — and
  // the target is validated against the known herald-tmux scheme before injection.
  async function sendTmuxKeys(_clientContainer, target, text) {
    if (!TMUX_TARGET_RE.test(String(target || ''))) {
      throw new Error(`refusing send-keys to unknown tmux target: ${target}`);
    }
    const args = ['exec', '-u', user, container, 'tmux', 'send-keys', '-t', target];
    if (text === 'ESC') args.push('Escape');
    else args.push(text, 'Enter');
    await execFileP('docker', args);
  }

  // True if cwd/TASKS.md has at least one open "- [ ]" item in the target container.
  async function repoHasOpenTasks(cwd) {
    try {
      await execFileP('docker', ['exec', '-u', user, container,
        'bash', '-c', 'grep -Eq "^[[:space:]]*-[[:space:]]*\\[ \\]" "$1"/TASKS.md', '_', cwd]);
      return true;            // grep -q exit 0 = an open task remains
    } catch { return false; } // exit 1 (no open tasks) or no TASKS.md
  }

  // True if `dir` is an existing directory in the target container. `dir` is passed
  // as an argv element (never interpolated into the shell) so a hostile path can't
  // break out of the `test -d` check.
  async function dirExists(dir) {
    try {
      await execFileP('docker', ['exec', '-u', user, container, 'test', '-d', dir]);
      return true;
    } catch { return false; }
  }

  // Repo candidates for forum auto-detect: git repos under /workspace (depth<=2)
  // in the target container plus any paths listed in ~/.claude/.phalanx-repos.
  // Static script (no interpolation); trailing '/.git' is stripped by the caller.
  async function listRepoCandidates() {
    const script =
      'find /workspace -maxdepth 2 -type d -name .git 2>/dev/null | sed "s:/.git$::"; ' +
      'f="$HOME/.claude/.phalanx-repos"; [ -f "$f" ] && sed "s/#.*//" "$f" | tr -d "[:blank:]" | grep . || true';
    try {
      const { stdout } = await execFileP('docker', ['exec', '-u', user, container, 'bash', '-lc', script]);
      return [...new Set(
        stdout.split('\n').map((s) => s.trim().replace(/\/\.git$/, '')).filter(Boolean),
      )];
    } catch { return []; }
  }

  return { container, user, copyFileToContainer, copyAndChmod, sendTmuxKeys, repoHasOpenTasks, dirExists, listRepoCandidates, execFileP };
}
