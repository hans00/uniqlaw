// Foreground runner with hot reload: SIGHUP (or POST /api/reload) restarts the daemon
// in-process with fresh settings. stop() detaches provider sessions (claude-tmux keeps
// tmux alive), so conversations survive the reload.
import { startDaemon, loadSettings, type Daemon } from "./index.ts";

export async function runForever(projectDir: string, opts: { logToStderr?: boolean } = {}): Promise<void> {
  let daemon: Daemon = await startDaemon(projectDir, opts);
  let reloading: Promise<void> | undefined;

  const reload = () => {
    reloading ??= (async () => {
      try {
        loadSettings(projectDir); // validate first: a broken settings.json must not take the daemon down
      } catch (e) {
        console.error(`[uniqlaw] reload rejected, keeping the running config: ${e instanceof Error ? e.message : e}`);
        return;
      }
      await daemon.stop();
      try {
        daemon = await startDaemon(projectDir, opts);
        console.error("[uniqlaw] reloaded");
      } catch (e) {
        console.error(`[uniqlaw] reload failed to start: ${e instanceof Error ? e.message : e}; exiting`);
        process.exit(1);
      }
    })().finally(() => { reloading = undefined; });
    return reloading;
  };

  process.on("SIGHUP", () => void reload());
  const shutdown = async () => { await reloading; await daemon.stop(); process.exit(0); };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
