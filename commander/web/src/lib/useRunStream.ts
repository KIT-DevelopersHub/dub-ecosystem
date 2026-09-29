// Per-run event stream hook. Replaces CommanderConsole's single `busy`/`unsubRef` lock
// (which allowed only ONE live run) with an isolated stream per runId, so many runs can
// be observed at once (P0-3). Each mounted instance:
//   1. seeds its log + status from the persisted run (history.getRun) — this is what
//      survives a daemon/web/service restart (the daemon forgets in-memory runs);
//   2. opens a live SSE stream ONLY while the run is not yet terminal, folding live
//      events on top of the replay.
// Terminal runs never open a socket, so the board can mount many cards cheaply.
import { useEffect, useRef, useState } from "react";
import { formatEvent, type CommanderClient, type DaemonRunEvent } from "./client.ts";
import type { RunHistoryApi, RunStatus } from "./commanderApi.ts";

export interface RunStreamState {
  status: RunStatus | "idle";
  log: string[];
  /** Last non-empty log line — for a card's compact "latest output" row. */
  lastLine: string;
  /** True while a live SSE socket is open. */
  live: boolean;
}

const TERMINAL = new Set<RunStatus>(["succeeded", "failed"]);

export function useRunStream(
  runId: string | null,
  deps: { client: CommanderClient; history: RunHistoryApi },
): RunStreamState {
  const { client, history } = deps;
  const [state, setState] = useState<RunStreamState>({
    status: "idle",
    log: [],
    lastLine: "",
    live: false,
  });
  // Keep latest deps without re-subscribing on every render.
  const clientRef = useRef(client);
  const historyRef = useRef(history);
  clientRef.current = client;
  historyRef.current = history;

  useEffect(() => {
    if (!runId) {
      setState({ status: "idle", log: [], lastLine: "", live: false });
      return;
    }
    let cancelled = false;
    let unsub: (() => void) | null = null;

    const push = (line: string) =>
      setState((prev) => ({
        ...prev,
        log: [...prev.log, line],
        lastLine: line.trim() ? line : prev.lastLine,
      }));

    void (async () => {
      // 1) Seed from the persisted run (survives restarts; also the source of truth for
      //    a run the daemon no longer holds in memory).
      let seededStatus: RunStatus | "idle" = "idle";
      try {
        const detail = await historyRef.current.getRun(runId);
        if (cancelled) return;
        if (detail) {
          seededStatus = detail.run.status;
          const lines = detail.events.map((e) =>
            formatEvent({ type: e.type, ...e.payload } as DaemonRunEvent),
          );
          const last = [...lines].reverse().find((l) => l.trim()) ?? "";
          setState({ status: detail.run.status, log: lines, lastLine: last, live: false });
        }
      } catch {
        /* service down → fall through to a bare live attempt */
      }
      if (cancelled) return;

      // 2) Open a live stream only if the run may still be producing events.
      if (seededStatus === "idle" || !TERMINAL.has(seededStatus)) {
        setState((prev) => ({ ...prev, live: true }));
        unsub = clientRef.current.streamEvents(
          runId,
          (ev: DaemonRunEvent) => {
            if (ev.type === "status" && ev.status) {
              setState((prev) => ({ ...prev, status: ev.status! }));
            }
            push(formatEvent(ev));
          },
          () => setState((prev) => ({ ...prev, live: false })),
        );
      }
    })();

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [runId]);

  return state;
}
