// "更新して再起動": pull the latest origin/main into the worktree this daemon runs from,
// then hand off to a detached relauncher that restarts the whole dev-up stack.
// The shell side lives in commander/restart.sh (see its header for the two modes).

import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** commander/daemon/src/restart.ts -> commander/restart.sh (robust to any cwd). */
const RESTART_SCRIPT = fileURLToPath(new URL("../../restart.sh", import.meta.url));

export interface UpdateResult {
  /** Short commit before / after the update (equal when already up to date). */
  from: string;
  to: string;
}

export interface Restarter {
  /** Update the worktree. Rejects with a human-readable (Japanese) message on failure. */
  update(): Promise<UpdateResult>;
  /** Start the relauncher outside this process tree; it stops and restarts the stack. */
  relaunch(): void;
}

export const scriptRestarter: Restarter = {
  update() {
    return new Promise((resolve, reject) => {
      execFile(
        "bash",
        [RESTART_SCRIPT, "update", String(process.pid)],
        { timeout: 300_000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr.trim() || err.message));
            return;
          }
          const [from = "", to = ""] = stdout.trim().split(/\s+/);
          resolve({ from, to });
        },
      );
    });
  },
  relaunch() {
    // detached => setsid: survives dev-up killing this daemon's process group.
    const child = spawn("bash", [RESTART_SCRIPT, "relaunch", String(process.pid)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  },
};
