// Run console for the local Claude Code exec bridge (commander-daemon). Extracted
// from App.tsx so it can be embedded both standalone (App.tsx) and as a Dub app
// (apps/fe2-app-shell/src/features/commander). One Run = one `claude -p` invocation;
// events stream in over SSE. A running run can be cancelled (DELETE /runs/:id).
import { useCallback, useRef, useState } from "react";
import {
  HttpCommanderClient,
  formatEvent,
  type CommanderClient,
  type DaemonRunEvent,
} from "./lib/client.ts";

export interface CommanderConsoleProps {
  /** Exec-bridge client. Omit to use the default loopback HTTP client. */
  client?: CommanderClient;
  /** Initial prompt text. */
  initialPrompt?: string;
}

const defaultClient = new HttpCommanderClient();

export function CommanderConsole({
  client = defaultClient,
  initialPrompt = "Reply with the single word: PONG",
}: CommanderConsoleProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [status, setStatus] = useState<string>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef<string | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setLog([]);
    setStatus("starting");
    try {
      const { runId } = await client.startRun(prompt);
      runIdRef.current = runId;
      setStatus("running");
      unsubRef.current = client.streamEvents(
        runId,
        (ev: DaemonRunEvent) => {
          if (ev.type === "status" && ev.status) setStatus(ev.status);
          append(formatEvent(ev));
        },
        () => {
          setBusy(false);
          runIdRef.current = null;
        },
      );
    } catch (err) {
      setStatus("error");
      append(`error: ${(err as Error).message}`);
      setBusy(false);
      runIdRef.current = null;
    }
  }, [client, prompt, append]);

  const cancel = useCallback(async () => {
    const id = runIdRef.current;
    if (!id) return;
    setStatus("cancelling");
    try {
      await client.cancelRun(id);
      append("● cancel requested");
    } catch (err) {
      append(`error: cancel failed: ${(err as Error).message}`);
    }
  }, [client, append]);

  return (
    <div>
      <textarea
        aria-label="prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          minHeight: 80,
          padding: 10,
          borderRadius: 8,
          border: "1px solid var(--color-border, #2a2f3a)",
          background: "var(--color-surface, #1a1e27)",
          color: "inherit",
          font: "inherit",
        }}
      />
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={run}
          disabled={busy || prompt.trim() === ""}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: 0,
            background: "var(--color-primary, #3b82f6)",
            color: "#fff",
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1,
          }}
        >
          Run
        </button>
        <button
          type="button"
          data-testid="cancel"
          onClick={cancel}
          disabled={!busy}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "1px solid var(--color-border, #2a2f3a)",
            background: "transparent",
            color: "inherit",
            fontWeight: 600,
            cursor: busy ? "pointer" : "default",
            opacity: busy ? 1 : 0.4,
          }}
        >
          Cancel
        </button>
        <span style={{ fontWeight: 600 }} data-testid="status">
          status: {status}
        </span>
      </div>

      <pre
        data-testid="log"
        style={{
          marginTop: 16,
          padding: 12,
          borderRadius: 8,
          border: "1px solid var(--color-border, #2a2f3a)",
          background: "var(--color-surface, #12151c)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: "60vh",
          overflow: "auto",
        }}
      >
        {log.join("\n")}
      </pre>
    </div>
  );
}
