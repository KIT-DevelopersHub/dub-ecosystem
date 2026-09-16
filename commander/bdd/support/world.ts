// Shared scenario state ("World"). One fresh instance per scenario; holds the running
// servers + last HTTP results and knows how to tear everything down.
import type { Running, SseEvent } from "./harness.ts";

export class World {
  daemon?: Running;
  service?: Running;

  /** token the daemon was started with (auth scenarios). */
  daemonToken?: string;
  /** token the service was started with (auth scenarios). */
  serviceToken?: string;

  /** last generic HTTP status / json seen by a When step. */
  lastStatus = 0;
  lastJson: unknown;

  /** daemon run under test. */
  runId?: string;
  events: SseEvent[] = [];

  /** commander-service feature under test. */
  featureId?: string;
  featurePhase?: string;

  /** launcher: the viewer's permission check. */
  can: (p: string) => boolean = () => false;

  private cleanups: Array<() => Promise<void>> = [];

  track(r: Running): Running {
    this.cleanups.push(r.close);
    return r;
  }

  async teardown(): Promise<void> {
    for (const c of this.cleanups.reverse()) {
      try {
        await c();
      } catch {
        /* best-effort */
      }
    }
    this.cleanups = [];
  }
}
