/// <reference lib="dom" />
// DO-direct WebSocket client for the gantt realtime layer (presence + live data sync).
// Connects to WsTicketResponse.doUrl (absolute wss:// URL of the GanttRoom DO); the
// gateway is NOT on the WS path. A fresh short-lived ticket is fetched on every
// (re)connect; reconnect uses exponential backoff with jitter. The client is transport
// only — it emits parsed GanttRealtimeEvents and forwards intent frames; all merge/
// refetch policy lives in the hook.
import type { common, gantt } from "@dub/types";

export type RealtimeStatus = "connecting" | "open" | "reconnecting" | "closed";

type WsFactory = (url: string) => WebSocket;

export interface GanttRtClientOptions {
  /** Fetch a fresh ws-ticket (tickets are ~60s; re-fetched on every open). */
  getTicket: () => Promise<gantt.WsTicketResponse>;
  wsFactory?: WsFactory;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (h: number) => void;
  heartbeatMs?: number;
  maxAttempts?: number; // 0 = unlimited
}

/** Backoff with full jitter, capped — identical policy to the chat RT client. */
export function backoffDelay(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 15000);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

function isRealtimeEvent(v: unknown): v is gantt.GanttRealtimeEvent {
  if (v === null || typeof v !== "object") return false;
  const k = (v as { kind?: unknown }).kind;
  return k === "presence" || k === "data.changed";
}

export class GanttRtClient {
  private readonly opts: Required<Omit<GanttRtClientOptions, "getTicket">> & Pick<GanttRtClientOptions, "getTicket">;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closedByUser = false;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private status: RealtimeStatus = "closed";
  private eventHandlers = new Set<(e: gantt.GanttRealtimeEvent) => void>();
  private statusHandlers = new Set<(s: RealtimeStatus) => void>();
  /** Fired after a socket opens; `reconnect` is true when it followed a drop (so the
   *  hook can do one full refetch to catch changes missed while disconnected). */
  private openHandlers = new Set<(reconnect: boolean) => void>();

  constructor(options: GanttRtClientOptions) {
    this.opts = {
      getTicket: options.getTicket,
      wsFactory: options.wsFactory ?? ((url) => new WebSocket(url)),
      setTimer: options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number),
      clearTimer: options.clearTimer ?? ((h) => globalThis.clearTimeout(h)),
      heartbeatMs: options.heartbeatMs ?? 15000,
      maxAttempts: options.maxAttempts ?? 0,
    };
  }

  connect(): void {
    this.closedByUser = false;
    this.attempt = 0;
    void this.openFresh();
  }

  private async openFresh(): Promise<void> {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let ticket: gantt.WsTicketResponse;
    try {
      ticket = await this.opts.getTicket();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.closedByUser) return;
    const wasReconnect = this.attempt > 0;
    const url = `${ticket.doUrl}${ticket.doUrl.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket.ticket)}`;
    const ws = this.opts.wsFactory(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
      this.send({ t: "hello" });
      this.startHeartbeat();
      for (const h of this.openHandlers) h(wasReconnect);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data === "pong") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (isRealtimeEvent(parsed)) for (const h of this.eventHandlers) h(parsed);
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = this.opts.setTimer(() => {
      this.send({ t: "ping" });
      this.startHeartbeat(); // re-arm
    }, this.opts.heartbeatMs);
  }
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.opts.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.ws = null;
    this.stopHeartbeat();
    if (this.closedByUser) {
      this.setStatus("closed");
      return;
    }
    if (this.opts.maxAttempts > 0 && this.attempt >= this.opts.maxAttempts) {
      this.setStatus("closed");
      return;
    }
    this.setStatus("reconnecting");
    const delay = backoffDelay(this.attempt);
    this.attempt++;
    this.reconnectTimer = this.opts.setTimer(() => void this.openFresh(), delay);
  }

  disconnect(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      this.opts.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setStatus("closed");
  }

  /** Announce this tab's viewing⇄editing state (deduped per user by the DO). */
  setEditing(editing: boolean, editingTaskId?: common.TaskId | null): void {
    this.send({ t: "state", editing, ...(editingTaskId ? { editingTaskId } : {}) });
  }

  /** Tell the room a write committed so peers refetch the authoritative rows. */
  notifyChange(change: gantt.GanttChangeKind, taskId?: common.TaskId | null): void {
    this.send({ t: "change", change, ...(taskId ? { taskId } : {}) });
  }

  private send(msg: gantt.GanttClientMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* peer gone; reconnect will re-sync */
    }
  }

  onEvent(handler: (e: gantt.GanttRealtimeEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }
  onStatusChange(handler: (s: RealtimeStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }
  onOpen(handler: (reconnect: boolean) => void): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  private setStatus(s: RealtimeStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }
}
