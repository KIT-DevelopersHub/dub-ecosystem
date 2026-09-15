import { useCallback, useRef, useState } from "react";
import {
  HttpCommanderClient,
  formatEvent,
  type CommanderClient,
  type DaemonRunEvent,
} from "./lib/client.ts";
import { FeatureBoard } from "./FeatureBoard.tsx";
import type { CommanderApi } from "./lib/commanderApi.ts";

interface AppProps {
  client?: CommanderClient;
  /** Phase-gate API (commander-service). Omit to use the default HTTP client. */
  api?: CommanderApi;
}

const defaultClient = new HttpCommanderClient();

export function App({ client = defaultClient, api }: AppProps) {
  const [prompt, setPrompt] = useState("Reply with the single word: PONG");
  const [status, setStatus] = useState<string>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setLog([]);
    setStatus("starting");
    try {
      const { runId } = await client.startRun(prompt);
      setStatus("running");
      unsubRef.current = client.streamEvents(
        runId,
        (ev: DaemonRunEvent) => {
          if (ev.type === "status" && ev.status) setStatus(ev.status);
          append(formatEvent(ev));
        },
        () => setBusy(false),
      );
    } catch (err) {
      setStatus("error");
      append(`error: ${(err as Error).message}`);
      setBusy(false);
    }
  }, [client, prompt, append]);

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        color: "var(--color-text, #e6e6e6)",
        background: "var(--color-bg, #0f1115)",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Commander</h1>
      <p style={{ opacity: 0.7, marginTop: 0, fontSize: 13 }}>
        ローカル Claude Code を Web から駆動する司令コンソール（基盤 PoC）
      </p>

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
      <div style={{ marginTop: 8 }}>
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
        <span style={{ marginLeft: 12, fontWeight: 600 }} data-testid="status">
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

      <FeatureBoard api={api} />
    </div>
  );
}
