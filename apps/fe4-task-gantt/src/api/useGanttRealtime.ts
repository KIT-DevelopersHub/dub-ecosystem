// Realtime gantt sync (Durable Object + WebSocket). Opens a DO-direct WS to the event's
// GanttRoom (gateway-bypassing) using a short-lived ws-ticket, and applies inbound deltas
// to the react-query cache so every viewer's timeline updates live:
//   - row.moved         → apply the moved window straight to the cache (no refetch)
//   - chart.invalidated → debounce-refetch the fresh chart ONCE (a structural change may
//                         have shifted the CPM-derived bars, so a delta can't express it)
// This mirrors chat-service's FE6 client. The socket is best-effort: if the ticket/WS
// fails the chart still works from its normal GET + optimistic writes — RT is a delivery
// optimisation, never the source of truth. Idle sockets cost $0 (DO Hibernation); we send
// a keepalive ping so a dropped link is detected and reconnected with backoff.
import { useEffect, useRef, useState } from "react";
import type { gantt, common } from "@dub/types";
import { useApiClient } from "./client-context";
import { getGanttWsTicket } from "./endpoints";

/** Connection state surfaced to the presence bar (Docs-style status dot). */
export type RealtimeStatus = "connecting" | "open" | "reconnecting" | "closed";

/** The cache-mutating actions the realtime layer drives. Supplied by the caller
 *  (TaskWorkspacePage wires these to useGanttData's optimistic setters / refetch). */
export interface GanttRealtimeActions {
  /** Move a bar in the cache the same tick a peer's move arrives (delta apply). */
  applyMove: (
    taskId: common.TaskId,
    startsAt: common.ISODateTime | null,
    endsAt: common.ISODateTime | null,
  ) => void;
  /** Refetch the fresh chart (called debounced after chart.invalidated hints). */
  invalidate: () => void;
}

/** Live presence view returned by the hook, for the Google-Docs-style avatar cluster.
 *  All view-only: the component just paints what the DO fans out. */
export interface GanttRealtimeState {
  /** Everyone currently viewing this event's gantt (deduped by userId by the DO). */
  presence: readonly gantt.GanttPresenceUser[];
  /** Socket connection state (drives the status dot / label). */
  status: RealtimeStatus;
  /** The caller's own id (from the ws-ticket), so the bar can mark "（あなた）". */
  selfUserId: common.UserId | null;
}

/** Pure application of one realtime event onto the cache actions. Exported so the
 *  delta→cache mapping is unit-testable without a live WebSocket. */
export function applyGanttRealtimeEvent(ev: gantt.GanttRealtimeEvent, actions: GanttRealtimeActions): void {
  switch (ev.kind) {
    case "row.moved":
      actions.applyMove(ev.taskId, ev.startsAt, ev.endsAt);
      return;
    case "chart.invalidated":
      actions.invalidate();
      return;
  }
}

const PING_INTERVAL_MS = 25_000; // keepalive; under the DO/edge idle timeout
const INVALIDATE_DEBOUNCE_MS = 300; // coalesce a burst of structural hints into one refetch
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Subscribe the current gantt view to realtime deltas + presence for `eventId`. Manages
 * the whole socket lifecycle (ticket fetch → connect → apply → keepalive → backoff
 * reconnect → teardown) and returns the live presence roster + connection status for the
 * Docs-style avatar cluster. No-op transport when WebSocket is unavailable (SSR/tests) or
 * eventId is empty — the returned state then stays empty/closed and the chart still works.
 */
export function useGanttRealtime(eventId: common.EventId, actions: GanttRealtimeActions): GanttRealtimeState {
  const client = useApiClient();
  // Keep the latest actions in a ref so the socket effect doesn't reconnect on each render.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const [presence, setPresence] = useState<readonly gantt.GanttPresenceUser[]>([]);
  const [status, setStatus] = useState<RealtimeStatus>("closed");
  const [selfUserId, setSelfUserId] = useState<common.UserId | null>(null);

  useEffect(() => {
    if (!eventId || typeof WebSocket === "undefined") return;

    let disposed = false;
    setStatus("connecting");
    let socket: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const clearPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const scheduleInvalidate = () => {
      if (invalidateTimer) return; // already coalescing this burst
      invalidateTimer = setTimeout(() => {
        invalidateTimer = null;
        actionsRef.current.invalidate();
      }, INVALIDATE_DEBOUNCE_MS);
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      setStatus("reconnecting");
      setPresence([]); // avatars are only meaningful while the socket is live
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      let ticket: gantt.GanttWsTicketResponse;
      try {
        ticket = await getGanttWsTicket(client, eventId);
      } catch {
        scheduleReconnect(); // ticket issuance failed (offline / transient) — back off & retry
        return;
      }
      if (disposed) return;
      // Remember who "I" am (from the signed ticket) so the bar can mark "（あなた）".
      if (ticket.self?.userId) setSelfUserId(ticket.self.userId);
      // Empty doUrl ⇒ realtime intentionally unavailable (mock/demo, or a backend without
      // the GanttRoom DO bound). Do not connect and do not reconnect — the chart works
      // fine over plain GET + optimistic writes; the presence bar reads "オフライン".
      if (!ticket.doUrl) {
        setStatus("closed");
        return;
      }

      const url = `${ticket.doUrl}${ticket.doUrl.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket.ticket)}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;

      ws.onopen = () => {
        attempt = 0; // reset backoff on a clean connect
        setStatus("open");
        // Ask the DO for the current roster immediately (a just-joined tab shouldn't wait
        // for the next join/leave to populate its avatars).
        try {
          ws.send(JSON.stringify({ t: "hello" }));
        } catch {
          /* closing socket — the close handler will reconnect */
        }
        clearPing();
        pingTimer = setInterval(() => {
          try {
            ws.send("ping");
          } catch {
            /* send on a closing socket — the close handler will reconnect */
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (e) => {
        if (typeof e.data !== "string" || e.data === "pong") return;
        let ev: gantt.GanttRealtimeEvent;
        try {
          ev = JSON.parse(e.data) as gantt.GanttRealtimeEvent;
        } catch {
          return; // ignore non-JSON frames
        }
        // Ignore anything for another event (defensive; a DO only fans out its own).
        if (ev.eventId !== eventId) return;
        if (ev.kind === "presence") setPresence(ev.users);
        else if (ev.kind === "chart.invalidated") scheduleInvalidate();
        else applyGanttRealtimeEvent(ev, actionsRef.current);
      };

      ws.onclose = () => {
        clearPing();
        if (socket === ws) socket = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose fires after onerror and drives the reconnect; just close defensively.
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      };
    };

    void connect();

    return () => {
      disposed = true;
      clearPing();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (invalidateTimer) clearTimeout(invalidateTimer);
      if (socket) {
        socket.onclose = null; // don't reconnect on an intentional teardown
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      }
      setStatus("closed");
      setPresence([]);
    };
  }, [client, eventId]);

  return { presence, status, selfUserId };
}
