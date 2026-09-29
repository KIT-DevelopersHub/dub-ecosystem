// Run console for the local Claude Code exec bridge (commander-daemon). Extracted
// from App.tsx so it can be embedded both standalone (App.tsx) and as a Dub app
// (apps/fe2-app-shell/src/features/commander). One Run = one `claude -p` invocation;
// events stream in over SSE. A running run can be cancelled (DELETE /runs/:id).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  HttpCommanderClient,
  formatEvent,
  type CommanderClient,
  type DaemonRunEvent,
} from "./lib/client.ts";
import {
  HttpCommanderApi,
  type RunHistoryApi,
  type RunStatus,
  type RunSummary,
} from "./lib/commanderApi.ts";

export interface CommanderConsoleProps {
  /** Exec-bridge client. Omit to use the default loopback HTTP client. */
  client?: CommanderClient;
  /** Persisted-run history (commander-service / D1). Omit to use the default HTTP client. */
  history?: RunHistoryApi;
  /** Initial prompt text. */
  initialPrompt?: string;
}

const defaultClient = new HttpCommanderClient();
const defaultHistory = new HttpCommanderApi();

/** Colour cue per persisted run status, for the history list badges. */
const RUN_STATUS_COLOR: Record<RunStatus, string> = {
  pending: "#9ca3af",
  running: "#3b82f6",
  succeeded: "#22c55e",
  failed: "#f87171",
};

export function CommanderConsole({
  client = defaultClient,
  history = defaultHistory,
  initialPrompt = "Reply with the single word: PONG",
}: CommanderConsoleProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [status, setStatus] = useState<string>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef<string | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  // Load persisted run history. The truth source is commander-service / D1 (on disk),
  // so this survives a daemon/web/service restart: after a reset the operator sees the
  // past runs + their final status instead of an empty "idle" console.
  const loadHistory = useCallback(async () => {
    try {
      setRuns(await history.listRuns());
    } catch {
      setRuns([]); // service down → show an empty (not broken) history panel
    }
  }, [history]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Restore a past run's full event log + final status from D1 into the console.
  const openRun = useCallback(
    async (id: string) => {
      if (busy) return; // don't clobber a live run
      try {
        const detail = await history.getRun(id);
        if (!detail) return;
        setViewingRunId(id);
        setStatus(detail.run.status);
        setLog(
          detail.events.map((e) =>
            formatEvent({ type: e.type, ...e.payload } as DaemonRunEvent),
          ),
        );
      } catch {
        /* best-effort restore; leave the console as-is on failure */
      }
    },
    [busy, history],
  );

  const run = useCallback(async () => {
    setBusy(true);
    setLog([]);
    setStatus("starting");
    setViewingRunId(null);
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
          void loadHistory(); // fold the just-finished run into the persisted history list
        },
      );
    } catch (err) {
      setStatus("error");
      append(`error: ${(err as Error).message}`);
      setBusy(false);
      runIdRef.current = null;
    }
  }, [client, prompt, append, loadHistory]);

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
        {viewingRunId && (
          <span
            data-testid="viewing-past-run"
            style={{ fontSize: 12, opacity: 0.7 }}
            title={viewingRunId}
          >
            （過去の実行を表示中 — 復元）
          </span>
        )}
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

      {/* Persisted run history — read back from commander-service / D1 (on disk). This is
          what makes a reset non-destructive: after the daemon/web/service restarts the
          operator still sees every past run and its final status, and can reopen one to
          restore its full log. */}
      <section style={{ marginTop: 20 }} data-testid="run-history">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>実行履歴（永続化）</strong>
          <span style={{ fontSize: 12, opacity: 0.6 }}>
            リセットしても消えません — クリックでログを復元
          </span>
          <button
            type="button"
            data-testid="refresh-history"
            onClick={() => void loadHistory()}
            style={{
              marginLeft: "auto",
              padding: "2px 10px",
              borderRadius: 6,
              border: "1px solid var(--color-border, #2a2f3a)",
              background: "transparent",
              color: "inherit",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            更新
          </button>
        </div>
        {runs.length === 0 ? (
          <div style={{ fontSize: 13, opacity: 0.6 }}>まだ実行履歴がありません</div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {runs.map((r) => (
              <li key={r.id} style={{ marginBottom: 6 }}>
                <button
                  type="button"
                  data-testid={`history-run-${r.id}`}
                  onClick={() => void openRun(r.id)}
                  disabled={busy}
                  aria-pressed={r.id === viewingRunId}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid var(--color-border, #2a2f3a)",
                    background: "var(--color-surface, #1a1e27)",
                    color: "inherit",
                    textAlign: "left",
                    cursor: busy ? "default" : "pointer",
                    opacity: busy ? 0.5 : 1,
                    outline:
                      r.id === viewingRunId
                        ? "2px solid var(--color-primary, #3b82f6)"
                        : "none",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: RUN_STATUS_COLOR[r.status],
                      minWidth: 76,
                    }}
                  >
                    {r.status}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 13,
                    }}
                  >
                    {r.prompt}
                  </span>
                  <span style={{ fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" }}>
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
