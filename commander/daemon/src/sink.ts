// Optional run persistence sink. The daemon is a local (loopback) Node process and
// cannot reach the shared dub-core D1 directly (ADR 0004), so it persists runs by
// POSTing them to commander-service, which owns the D1 binding. Best-effort: a failed
// persist is logged and swallowed — it never fails or blocks the actual run.
import type { Run, RunEvent } from "./types.ts";

export interface RunSink {
  /** Persist a newly created run row (commander_runs). */
  runStarted(run: Run): void;
  /** Persist one run event (commander_run_events) + fold status/exit into the run row. */
  runEvent(runId: string, event: RunEvent): void;
}

/** No-op sink used when no commander-service URL is configured. */
export const nullSink: RunSink = {
  runStarted() {},
  runEvent() {},
};

export class HttpRunSink implements RunSink {
  // NB: explicit fields (not TS "parameter properties"), so the daemon runs under
  // `node --experimental-strip-types` — strip-only mode rejects parameter properties.
  private baseUrl: string;
  private token?: string;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h["x-commander-token"] = this.token;
    return h;
  }

  private post(path: string, body: unknown): void {
    // Fire-and-forget; swallow every failure (persistence is best-effort).
    void fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    }).catch((err: unknown) => {
      console.warn(`[commander-daemon] persist ${path} failed:`, (err as Error).message);
    });
  }

  runStarted(run: Run): void {
    this.post("/runs", {
      id: run.id,
      prompt: run.prompt,
      cwd: run.cwd,
      status: run.status,
    });
  }

  runEvent(runId: string, event: RunEvent): void {
    // type/at are columns; everything else on the event becomes the JSON payload.
    const { type, at, ...rest } = event as RunEvent & { at: string };
    this.post(`/runs/${runId}/events`, { type, at, payload: rest });
  }
}
