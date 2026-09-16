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

export interface CommanderClient {
  startRun(prompt: string): Promise<{ runId: string }>;
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

export class HttpCommanderClient implements CommanderClient {
  constructor(private baseUrl: string = DEFAULT_BASE) {}

  async startRun(prompt: string): Promise<{ runId: string }> {
    const res = await fetch(`${this.baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`daemon returned ${res.status}`);
    return (await res.json()) as { runId: string };
  }

  streamEvents(
    runId: string,
    onEvent: (ev: DaemonRunEvent) => void,
    onClose: () => void,
  ): () => void {
    const es = new EventSource(`${this.baseUrl}/runs/${runId}/events`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as DaemonRunEvent;
      onEvent(ev);
      if (ev.type === "status" && (ev.status === "succeeded" || ev.status === "failed")) {
        es.close();
        onClose();
      }
    };
    es.onerror = () => {
      es.close();
      onClose();
    };
    return () => es.close();
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
