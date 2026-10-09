// Relay transport: lets the Dub-hosted /commander screen talk to the operator's LOCAL
// Commander through the commander-relay Worker instead of 127.0.0.1. The PC's relay agent
// dials out to the same Worker, so no tunnel or inbound port is involved.
//
// The rest of the app is unchanged: `fetchFor(target)` / `streamOpener()` plug into the
// existing HttpCommanderClient / HttpCommanderApi, so every call they make is carried as
// {t:"req"} / {t:"sub"} frames and answered by the agent from the real loopback services.
// Credentials: the browser holds only a 60s ticket from the gateway (session + Commander
// edit permission). The operator token never leaves the PC.
import type { StreamOpener } from "./client.ts";

export interface RelayTicket {
  ticket: string;
  wsUrl: string;
}

export type RelayTarget = "daemon" | "service";

/**
 * connecting    : opening the socket / waiting for the relay
 * online        : relay up and the PC's agent connected
 * agent_offline : relay up but the PC is not connected (agent not running / PC asleep)
 * disconnected  : relay unreachable or ticket refused; retrying
 */
export type RelayStatus = "connecting" | "online" | "agent_offline" | "disconnected";

interface Pending {
  resolve: (r: { status: number; body: string }) => void;
  reject: (e: Error) => void;
  status: number;
  parts: string[];
  timer: ReturnType<typeof setTimeout>;
}

interface Sub {
  onData: (data: string) => void;
  onEnd: () => void;
}

export interface RelayOptions {
  /** Injected in tests. */
  WebSocketCtor?: new (url: string) => WebSocket;
  requestTimeoutMs?: number;
}

const MAX_BACKOFF_MS = 30_000;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private subs = new Map<string, Sub>();
  private listeners = new Set<(s: RelayStatus) => void>();
  private openWaiters: (() => void)[] = [];
  private backoff = 1_000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  status: RelayStatus = "connecting";

  constructor(
    private readonly getTicket: () => Promise<RelayTicket>,
    private readonly opts: RelayOptions = {},
  ) {}

  onStatus(cb: (s: RelayStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => this.listeners.delete(cb);
  }

  connect(): void {
    this.closed = false;
    void this.open();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close(1000, "closed");
    this.ws = null;
    this.failAll("relay closed");
  }

  /** A fetch() that sends every call to `target` on the operator's PC. Base URL is ignored. */
  fetchFor(target: RelayTarget): typeof fetch {
    return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://relay.invalid");
      const method = (init.method ?? "GET").toUpperCase();
      const body = typeof init.body === "string" ? init.body : undefined;
      const res = await this.request(target, method, url.pathname + url.search, body);
      return new Response(res.status === 204 || res.status === 304 ? null : res.body, {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  /** An SSE opener for the daemon's run event stream, carried over the relay. */
  streamOpener(): StreamOpener {
    return (rawUrl, onData, onEnd) => {
      const url = new URL(rawUrl, "http://relay.invalid");
      // The agent authenticates to the daemon itself; never forward a token param.
      url.searchParams.delete("token");
      return this.subscribe(url.pathname + url.search, onData, onEnd);
    };
  }

  async request(target: RelayTarget, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
    await this.whenOpen();
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("relay request timed out"));
      }, this.opts.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, status: 0, parts: [], timer });
      this.send({ t: "req", id, target, method, path, ...(body !== undefined ? { body } : {}) });
    });
  }

  subscribe(path: string, onData: (data: string) => void, onEnd: () => void): () => void {
    const id = this.nextId();
    let active = true;
    this.subs.set(id, { onData, onEnd });
    void this.whenOpen().then(
      () => {
        if (active) this.send({ t: "sub", id, path });
      },
      () => {
        if (!active) return;
        this.subs.delete(id);
        onEnd();
      },
    );
    return () => {
      if (!active) return;
      active = false;
      if (this.subs.delete(id)) this.send({ t: "unsub", id });
    };
  }

  private nextId(): string {
    this.seq += 1;
    return `r${this.seq.toString(36)}`;
  }

  private setStatus(s: RelayStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.listeners) l(s);
  }

  private whenOpen(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay not connected")), 10_000);
      this.openWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private send(frame: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    this.setStatus(this.status === "online" ? "connecting" : this.status);
    let ticket: RelayTicket;
    try {
      ticket = await this.getTicket();
    } catch {
      this.setStatus("disconnected");
      this.scheduleRetry();
      return;
    }
    if (this.closed) return;
    const Ctor = this.opts.WebSocketCtor ?? WebSocket;
    const sep = ticket.wsUrl.includes("?") ? "&" : "?";
    const ws = new Ctor(`${ticket.wsUrl}${sep}ticket=${encodeURIComponent(ticket.ticket)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1_000;
      const waiters = this.openWaiters;
      this.openWaiters = [];
      for (const w of waiters) w();
    };
    ws.onmessage = (m) => this.onFrame(String(m.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failAll("relay disconnected");
      if (this.closed) return;
      this.setStatus("disconnected");
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => void this.open(), wait);
  }

  private onFrame(raw: string): void {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (f.t === "agent") {
      this.setStatus(f.online ? "online" : "agent_offline");
      return;
    }
    const id = typeof f.id === "string" ? f.id : "";
    if (f.t === "res" || f.t === "part") {
      const p = this.pending.get(id);
      if (!p) return;
      if (f.t === "res") p.status = Number(f.status) || 502;
      p.parts.push(typeof f.body === "string" ? f.body : "");
      if (f.more) return;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ status: p.status, body: p.parts.join("") });
      return;
    }
    if (f.t === "ev") {
      if (typeof f.data === "string") this.subs.get(id)?.onData(f.data);
      return;
    }
    if (f.t === "end") {
      const s = this.subs.get(id);
      if (!s) return;
      this.subs.delete(id);
      s.onEnd();
    }
  }

  private failAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
    for (const [id, s] of this.subs) {
      this.subs.delete(id);
      s.onEnd();
    }
  }
}
