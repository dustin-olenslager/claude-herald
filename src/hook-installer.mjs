// Installs the PreToolUse gate, notify hook, and tmux launcher into the target
// container at boot. Idempotent at the call site via ensureHook(). Uses the
// container-exec copyAndChmod primitive — no direct docker here.
export function makeHookInstaller({ exec, paths }) {
  const { container } = exec;
  const {
    HOOK_SRC, HOOK_PATH,
    NOTIFY_HOOK_SRC, NOTIFY_HOOK_PATH,
    TMUX_LAUNCHER_SRC, TMUX_LAUNCHER_PATH,
  } = paths;

  async function installHook() {
    let ok = true;
    try {
      await exec.copyAndChmod(HOOK_SRC, HOOK_PATH);
      console.log(`hook installed: ${container}:${HOOK_PATH}`);
    } catch (e) {
      console.warn(`pretooluse hook install failed: ${String(e.message).slice(0, 200)}`);
      ok = false;
    }
    // Notification hook + tmux launcher are best-effort — interactive-session feature only.
    try {
      await exec.copyAndChmod(NOTIFY_HOOK_SRC, NOTIFY_HOOK_PATH);
      console.log(`notify hook installed: ${container}:${NOTIFY_HOOK_PATH}`);
    } catch (e) {
      console.warn(`notify hook install failed: ${String(e.message).slice(0, 200)}`);
    }
    try {
      await exec.copyAndChmod(TMUX_LAUNCHER_SRC, TMUX_LAUNCHER_PATH);
      console.log(`tmux launcher installed: ${container}:${TMUX_LAUNCHER_PATH}`);
    } catch (e) {
      console.warn(`tmux launcher install failed: ${String(e.message).slice(0, 200)}`);
    }
    return ok;
  }

  let hookInstalled = false;
  async function ensureHook() {
    if (hookInstalled) return;
    hookInstalled = await installHook();
  }

  return { installHook, ensureHook };
}
