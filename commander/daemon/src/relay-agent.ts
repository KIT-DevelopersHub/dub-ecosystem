// Relay agent — keeps the operator's LOCAL Commander reachable from the Dub-hosted
// /commander screen without a tunnel or an inbound port. It dials OUT to the
// commander-relay Worker (wss, bearer secret) and answers relayed requests by calling the
// loopback daemon / commander-service itself. The browser only ever names an upstream
// ("daemon" | "service") and a path; the base URLs and the operator token stay here.
//
// Frames (see services/commander-relay/src/protocol.ts for the DO side):
//   in : {t:"req", id, target, method, path, body?} | {t:"sub", id, path} | {t:"unsub", id} | {t:"gone", tag}
//   out: {t:"res", id, status, body, more?} {t:"part", id, body, more?} {t:"ev", id, data} {t:"end", id, error?}

export interface RelayAgentConfig {
  /** wss://<relay>/ws/agent */
  relayUrl: string;
  /** Shared secret the relay expects as `Authorization: Bearer`. */
  relaySecret: string;
  daemonUrl: string;
  serviceUrl: string;
  /** Operator token for the loopback daemon (Bearer) and service (x-commander-token). */
  operatorToken: string;
}

/** Minimal socket surface (Node's global WebSocket satisfies it; tests pass a fake). */
export interface AgentSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface RelayAgentDeps {
  openSocket(url: string, secret: string): AgentSocket;
  fetch: typeof fetch;
  log(msg: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Workers cap a WebSocket message at 1 MiB; stay well under it per frame. */
export const CHUNK_CHARS = 256 * 1024;
const PING_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;
const SEP = "~";

/** Same rule as the relay's isSafePath: absolute, single-host, single-line. */
export function isSafePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 2048 &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/[\s\\]/.test(path) &&
    !path.includes("://")
  );
}

/** Split a response body into relay frames under the per-message cap. */
export function chunkResponse(id: string, status: number, body: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < body.length; i += CHUNK_CHARS) parts.push(body.slice(i, i + CHUNK_CHARS));
  if (parts.length === 0) parts.push("");
  return parts.map((part, i) => {
    const more = i < parts.length - 1;
    return JSON.stringify(i === 0 ? { t: "res", id, status, body: part, more } : { t: "part", id, body: part, more });
  });
}

/** Pull complete SSE `data:` payloads out of a buffer; returns them plus the unconsumed tail. */
export function drainSse(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) events.push(data);
  }
  return { events, rest };
}

export class RelayAgent {
  private ws: AgentSocket | null = null;
  private streams = new Map<string, AbortController>();
  private backoff = 1_000;
  private pingTimer: unknown = null;
  private stopped = false;
  // Plain fields, not parameter properties: Node's --experimental-strip-types runs this file
  // directly and rejects TS-only syntax that needs a transform.
  private readonly config: RelayAgentConfig;
  private readonly deps: RelayAgentDeps;

  constructor(config: RelayAgentConfig, deps: RelayAgentDeps) {
    this.config = config;
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.abortAll();
    if (this.pingTimer) this.deps.clearTimeout(this.pingTimer);
    this.ws?.close(1000, "agent stopping");
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = this.deps.openSocket(this.config.relayUrl, this.config.relaySecret);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1_000;
      this.deps.log(`[relay-agent] connected ${this.config.relayUrl}`);
      this.schedulePing();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      void this.handle(ev.data);
    };
    ws.onerror = () => {
      /* onclose follows and handles the reconnect */
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.abortAll();
      if (this.pingTimer) this.deps.clearTimeout(this.pingTimer);
      if (this.stopped) return;
      // 4000 = replaced by a newer agent: back off long so two PCs do not flap forever.
      const wait = ev.code === 4000 ? MAX_BACKOFF_MS : this.backoff;
      this.deps.log(`[relay-agent] disconnected (${ev.code ?? "?"}) — retry in ${Math.round(wait / 1000)}s`);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.deps.setTimeout(() => this.connect(), wait);
    };
  }

  private schedulePing(): void {
    this.pingTimer = this.deps.setTimeout(() => {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send("ping");
        this.schedulePing();
      }
    }, PING_MS);
  }

  private send(frame: string): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(frame);
  }

  /** Handle one frame from the relay. Exposed for tests. */
  async handle(raw: string): Promise<void> {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (f.t === "gone" && typeof f.tag === "string") {
      for (const [id, ctrl] of this.streams) {
        if (id.startsWith(f.tag + SEP)) {
          ctrl.abort();
          this.streams.delete(id);
        }
      }
      return;
    }
    if (typeof f.id !== "string") return;
    const id = f.id;
    if (f.t === "unsub") {
      this.streams.get(id)?.abort();
      this.streams.delete(id);
      return;
    }
    if (f.t === "req") return this.request(id, f);
    if (f.t === "sub") return this.subscribe(id, f.path);
  }

  private headersFor(target: "daemon" | "service", hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = hasBody ? { "content-type": "application/json" } : {};
    if (!this.config.operatorToken) return h;
    return target === "daemon"
      ? { ...h, authorization: `Bearer ${this.config.operatorToken}` }
      : { ...h, "x-commander-token": this.config.operatorToken };
  }

  private async request(id: string, f: Record<string, unknown>): Promise<void> {
    const target = f.target === "daemon" ? "daemon" : f.target === "service" ? "service" : null;
    const method = typeof f.method === "string" && ["GET", "POST", "PATCH", "DELETE"].includes(f.method) ? f.method : null;
    if (!target || !method || !isSafePath(f.path)) {
      for (const frame of chunkResponse(id, 400, JSON.stringify({ error: "bad_request" }))) this.send(frame);
      return;
    }
    const body = typeof f.body === "string" ? f.body : undefined;
    const base = target === "daemon" ? this.config.daemonUrl : this.config.serviceUrl;
    let status: number;
    let text: string;
    try {
      const res = await this.deps.fetch(`${base}${f.path}`, {
        method,
        headers: this.headersFor(target, body !== undefined),
        ...(body !== undefined ? { body } : {}),
      });
      status = res.status;
      text = await res.text();
    } catch {
      // Local daemon/service is down: same signal the browser gets when 127.0.0.1 is down.
      status = 502;
      text = JSON.stringify({ error: `${target}_unreachable` });
    }
    for (const frame of chunkResponse(id, status, text)) this.send(frame);
  }

  private async subscribe(id: string, path: unknown): Promise<void> {
    if (!isSafePath(path)) {
      this.send(JSON.stringify({ t: "end", id, error: "bad_request" }));
      return;
    }
    const ctrl = new AbortController();
    this.streams.set(id, ctrl);
    try {
      const res = await this.deps.fetch(`${this.config.daemonUrl}${path}`, {
        headers: { ...this.headersFor("daemon", false), accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = drainSse(buffer);
        buffer = rest;
        for (const data of events) this.send(JSON.stringify({ t: "ev", id, data }));
      }
      this.send(JSON.stringify({ t: "end", id }));
    } catch (err) {
      if (!ctrl.signal.aborted) this.send(JSON.stringify({ t: "end", id, error: String(err) }));
    } finally {
      this.streams.delete(id);
    }
  }

  private abortAll(): void {
    for (const ctrl of this.streams.values()) ctrl.abort();
    this.streams.clear();
  }
}
