// useGanttRealtime — wires the GanttRoom WebSocket into the workspace: it tracks who is
// present (presence avatars), exposes intent setters (setEditing / notifyChange), and
// turns a peer's `data.changed` into a single, DEFERRED authoritative refetch.
//
// Merge policy (server-is-truth, last-write-wins): the socket never mutates rows directly.
// A remote change schedules `onRemoteChange` (the caller refetches the real rows from the
// API). The refetch is debounced (coalesces bursts) AND deferred while the local user is
// mid-interaction — `shouldDefer()` true ⇒ we wait — so a peer's push can never yank a bar
// the user is dragging or a field they're editing out from under them. A reconnect also
// fires `onRemoteChange` once to backfill anything missed while disconnected.
import { useCallback, useEffect, useRef, useState } from "react";
import type { common, gantt } from "@dub/types";
import { useApiClient } from "../api/client-context";
import { getGanttWsTicket } from "../api/endpoints";
import { GanttRtClient, type RealtimeStatus } from "./gantt-rt-client";

const REFRESH_DEBOUNCE_MS = 400;

export interface UseGanttRealtimeOptions {
  enabled?: boolean;
  /** Refetch the authoritative rows (called for a peer's change and once per reconnect). */
  onRemoteChange: (change: gantt.GanttChangeKind | string, taskId?: common.TaskId | null) => void;
  /** Return true while the local user is mid-edit (dragging / detail panel dirty) so the
   *  remote refetch is held until they finish — protects in-flight local edits. */
  shouldDefer?: () => boolean;
}

export interface GanttRealtime {
  presence: gantt.GanttPresenceUser[];
  status: RealtimeStatus;
  selfUserId: common.UserId | null;
  setEditing: (editing: boolean, taskId?: common.TaskId | null) => void;
  notifyChange: (change: gantt.GanttChangeKind, taskId?: common.TaskId | null) => void;
}

export function useGanttRealtime(eventId: common.EventId, options: UseGanttRealtimeOptions): GanttRealtime {
  const client = useApiClient();
  // Realtime is a progressive enhancement: only engage when explicitly enabled AND a
  // WebSocket implementation exists (so jsdom/SSR render the workspace inertly — no
  // sockets, no reconnect timers — and the feature simply lights up in a real browser).
  const enabled = (options.enabled ?? true) && typeof WebSocket !== "undefined";

  const [presence, setPresence] = useState<gantt.GanttPresenceUser[]>([]);
  const [status, setStatus] = useState<RealtimeStatus>("closed");
  const [selfUserId, setSelfUserId] = useState<common.UserId | null>(null);

  const clientRef = useRef<GanttRtClient | null>(null);
  // Keep the latest callbacks in refs so the socket effect subscribes ONCE per event.
  const onRemoteChangeRef = useRef(options.onRemoteChange);
  const shouldDeferRef = useRef(options.shouldDefer);
  onRemoteChangeRef.current = options.onRemoteChange;
  shouldDeferRef.current = options.shouldDefer;

  // Debounced + deferred refetch trigger (coalesces bursts; waits out local edits).
  const flushTimer = useRef<number | null>(null);
  const pending = useRef<{ change: gantt.GanttChangeKind | string; taskId?: common.TaskId | null } | null>(null);
  const scheduleRefetch = useCallback((change: gantt.GanttChangeKind | string, taskId?: common.TaskId | null) => {
    pending.current = { change, taskId: taskId ?? null };
    if (flushTimer.current !== null) return;
    const tick = () => {
      flushTimer.current = null;
      if (shouldDeferRef.current?.()) {
        // still mid-edit — try again shortly without dropping the pending change
        flushTimer.current = globalThis.setTimeout(tick, REFRESH_DEBOUNCE_MS) as unknown as number;
        return;
      }
      const p = pending.current;
      pending.current = null;
      if (p) onRemoteChangeRef.current(p.change, p.taskId ?? null);
    };
    flushTimer.current = globalThis.setTimeout(tick, REFRESH_DEBOUNCE_MS) as unknown as number;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let selfCaptured: common.UserId | null = null;
    const rt = new GanttRtClient({
      getTicket: async () => {
        const t = await getGanttWsTicket(client, eventId);
        if (t.self?.userId && t.self.userId !== selfCaptured) {
          selfCaptured = t.self.userId;
          setSelfUserId(t.self.userId);
        }
        return t;
      },
    });
    clientRef.current = rt;

    const offEvent = rt.onEvent((e) => {
      if (e.kind === "presence") setPresence(e.users);
      else if (e.kind === "data.changed") {
        // ignore our own echo (the DO already excludes the author, but guard anyway)
        if (e.actorId && e.actorId === selfCaptured) return;
        scheduleRefetch(e.change, e.taskId ?? null);
      }
    });
    const offStatus = rt.onStatusChange(setStatus);
    const offOpen = rt.onOpen((reconnect) => {
      if (reconnect) scheduleRefetch("reconnect");
    });
    rt.connect();

    return () => {
      offEvent();
      offStatus();
      offOpen();
      rt.disconnect();
      clientRef.current = null;
      if (flushTimer.current !== null) {
        globalThis.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      pending.current = null;
      setPresence([]);
      setStatus("closed");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, enabled, client]);

  const setEditing = useCallback((editing: boolean, taskId?: common.TaskId | null) => {
    clientRef.current?.setEditing(editing, taskId ?? null);
  }, []);
  const notifyChange = useCallback((change: gantt.GanttChangeKind, taskId?: common.TaskId | null) => {
    clientRef.current?.notifyChange(change, taskId ?? null);
  }, []);

  return { presence, status, selfUserId, setEditing, notifyChange };
}
