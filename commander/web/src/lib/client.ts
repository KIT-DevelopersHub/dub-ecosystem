// Client for the local commander-daemon exec bridge. The daemon runs on the
// operator's own machine (loopback); the Dub-hosted UI reaches it at this base.

export interface DaemonRunEvent {
  type: "status" | "claude" | "stdout" | "stderr" | "exit" | "error";
  at?: string;
  status?: "pending" | "running" | "succeeded" | "failed";
  data?: unknown;
  line?: string;
  code?: number | null;
  message?: string;
}

/** Options for starting a run: which worktree to run in, and which task it belongs to. */
export interface StartRunOptions {
  /** Working directory (target worktree) for the spawned claude. Daemon default if omitted. */
  cwd?: string;
  /** Task this run belongs to (commander_tasks.id); persisted on the run row. */
  taskId?: string;
  /**
   * Extra CLI args appended to THIS run's `claude -p` (after the daemon's global
   * extraArgs, so a per-run flag wins). Used e.g. by "Dubに聞く" to pass
   * `--max-turns` so a Q&A stays conversational instead of crawling the whole repo.
   */
  args?: string[];
}

export interface CommanderClient {
  startRun(prompt: string, opts?: StartRunOptions): Promise<{ runId: string }>;
  /** Cancel a running run (best-effort). Resolves once the daemon acknowledges. */
  cancelRun(runId: string): Promise<void>;
  /** Liveness probe (GET /health). False when the daemon is unreachable. */
  health(): Promise<boolean>;
  /** Stream a run's events. Returns an unsubscribe fn. */
  streamEvents(
    runId: string,
    onEvent: (ev: DaemonRunEvent) => void,
    onClose: () => void,
  ): () => void;
}

const DEFAULT_BASE =
  (import.meta.env?.VITE_COMMANDER_DAEMON as string | undefined) ??
  "http://127.0.0.1:4319";

const DEFAULT_TOKEN = import.meta.env?.VITE_COMMANDER_TOKEN as string | undefined;

/** Opens an SSE-like stream; returns a close fn. Swapped out by the relay transport. */
export type StreamOpener = (
  url: string,
  onData: (data: string) => void,
  onEnd: () => void,
) => () => void;

const eventSourceOpener: StreamOpener = (url, onData, onEnd) => {
  const es = new EventSource(url);
  es.onmessage = (m) => onData(m.data as string);
  es.onerror = () => {
    es.close();
    onEnd();
  };
  return () => es.close();
};

export class HttpCommanderClient implements CommanderClient {
  constructor(
    private baseUrl: string = DEFAULT_BASE,
    private token: string | undefined = DEFAULT_TOKEN,
    // Injected by the relay transport (WebSocket to the operator's PC); loopback by default.
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
    private openStream: StreamOpener = eventSourceOpener,
  ) {}

  private headers(base: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...base, authorization: `Bearer ${this.token}` } : base;
  }

  async startRun(prompt: string, opts: StartRunOptions = {}): Promise<{ runId: string }> {
    const body: Record<string, unknown> = { prompt };
    if (opts.cwd) body.cwd = opts.cwd;
    if (opts.taskId) body.taskId = opts.taskId;
    if (opts.args && opts.args.length > 0) body.args = opts.args;
    const res = await this.fetchImpl(`${this.baseUrl}/runs`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`daemon returned ${res.status}`);
    return (await res.json()) as { runId: string };
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${runId}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    // 404 = already finished/gone; treat as a no-op success (idempotent cancel).
    if (!res.ok && res.status !== 404) throw new Error(`daemon returned ${res.status}`);
  }

  streamEvents(
    runId: string,
    onEvent: (ev: DaemonRunEvent) => void,
    onClose: () => void,
  ): () => void {
    // EventSource cannot set an Authorization header, so the shared token rides a
    // query param for the SSE stream (loopback-only; the daemon accepts either).
    const q = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    let closed = false;
    let close: () => void = () => {};
    const finish = () => {
      if (closed) return;
      closed = true;
      close();
      onClose();
    };
    close = this.openStream(
      `${this.baseUrl}/runs/${runId}/events${q}`,
      (data) => {
        const ev = JSON.parse(data) as DaemonRunEvent;
        onEvent(ev);
        if (ev.type === "status" && (ev.status === "succeeded" || ev.status === "failed")) finish();
      },
      finish,
    );
    return () => {
      closed = true;
      close();
    };
  }
}

/** One-line human summary of an event for the log view. */
export function formatEvent(ev: DaemonRunEvent): string {
  switch (ev.type) {
    case "status":
      return `● status: ${ev.status}`;
    case "claude": {
      const d = ev.data as { type?: string; subtype?: string; result?: string } | undefined;
      if (d?.result) return `claude> ${d.result}`;
      return `claude> ${d?.type ?? "event"}${d?.subtype ? `/${d.subtype}` : ""}`;
    }
    case "stdout":
      return ev.line ?? "";
    case "stderr":
      return `stderr> ${ev.line ?? ""}`;
    case "exit":
      return `exit code: ${ev.code}`;
    case "error":
      return `error: ${ev.message}`;
    default:
      return JSON.stringify(ev);
  }
}
