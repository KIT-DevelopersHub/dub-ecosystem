// EventDigestHub — the one Durable Object behind the AI digest (#879). Two jobs:
//
//  1. SCHEDULER. A self-rescheduling ALARM replaces a Cron Trigger (the account's 5-cron
//     cap is full — same pattern as app-health-monitor's MonitorDO). Daily 07:00 JST;
//     every 3 hours in the final week before an event (schedule.ts). While the feature
//     flag is OFF the alarm does nothing and does NOT reschedule, so the loop is dead
//     until someone enables the flag and POSTs /ensure-alarm.
//
//  2. MAC MINI RELAY. The Mac mini dials OUT over a WebSocket (Worker entry checks its
//     bearer secret first — see index.ts), same shape as services/commander-relay, so no
//     inbound port is opened at home. /rpc forwards one summarize/ask request to it and
//     waits for the matching response. No agent connected => 503 => 「停止中」.
//
// Hibernation API: an idle connected agent is not billed for duration; its "ping"
// keepalive is answered by the runtime's auto-response without waking the object.
import type { DurableObjectState, WebSocket as CfWebSocket } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import { buildDeps, digestEnabled } from "./deps";
import { EventService } from "./service";
import { nextDigestRunAt } from "./digest/schedule";
import type { Env } from "./env";

const AGENT_TAG = "agent";
const OPEN = 1;
export const RPC_TIMEOUT_MS = 60_000;
const MAX_FRAME_CHARS = 256 * 1024;
const SERVICE = "event-service";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Agent -> DO response frame. Pure; unit-tested. */
export function parseAgentFrame(raw: unknown): { id: string; ok: boolean; body: unknown } | null {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) return null;
  try {
    const f = JSON.parse(raw) as Record<string, unknown>;
    if (f.t !== "res" || typeof f.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(f.id)) return null;
    return { id: f.id, ok: f.ok !== false, body: f.body ?? null };
  } catch {
    return null;
  }
}

interface Pending {
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EventDigestHub {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    const Pair = (globalThis as { WebSocketRequestResponsePair?: new (req: string, res: string) => unknown })
      .WebSocketRequestResponsePair;
    if (Pair) state.setWebSocketAutoResponse(new Pair("ping", "pong") as never);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") return json(200, { agentOnline: this.liveAgent() !== null });
    if (url.pathname === "/ensure-alarm" && request.method === "POST") return json(200, { alarmAt: await this.ensureAlarm() });
    if (url.pathname === "/rpc" && request.method === "POST") return this.rpc(await request.text());
    if (url.pathname === "/ws/agent") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "upgrade_required" });
      return this.acceptAgent();
    }
    return json(404, { error: "not_found" });
  }

  // ---- scheduler ----
  async ensureAlarm(): Promise<number | null> {
    if (!digestEnabled(this.env)) return null;
    const existing = await this.state.storage.getAlarm();
    if (existing !== null) return existing;
    const at = nextDigestRunAt(Date.now(), null);
    await this.state.storage.setAlarm(at);
    return at;
  }

  async alarm(): Promise<void> {
    if (!digestEnabled(this.env)) return; // flag OFF: the loop stops here (no reschedule)
    let nextStart: number | null = null;
    try {
      const userId = this.env.EVENT_AI_DIGEST_SYSTEM_USER_ID;
      const deps = buildDeps(this.env, `digest-alarm-${Date.now()}`);
      const now = new Date().toISOString();
      const upcoming = await deps.repo.listEvents({
        orgId: deps.orgId,
        startsAfter: now,
        sort: "startsAt",
        includeArchived: false,
        limit: 5,
      });
      const first = upcoming.find((e) => e.startsAt);
      nextStart = first?.startsAt ? Date.parse(first.startsAt) : null;
      if (!userId) {
        consoleSink({ level: "warn", message: "ai digest alarm skipped: EVENT_AI_DIGEST_SYSTEM_USER_ID unset", service: SERVICE });
      } else {
        const svc = new EventService(deps);
        for (const ev of upcoming) {
          if (ev.phase === "closed") continue;
          try {
            await svc.runEventDigest({ requestId: `digest-alarm-${ev.id}`, userId }, ev.id, "schedule");
          } catch (err) {
            consoleSink({ level: "warn", message: "ai digest run failed", service: SERVICE, fields: { eventId: ev.id, error: String(err) } });
          }
        }
      }
    } catch (err) {
      consoleSink({ level: "error", message: "ai digest alarm failed (loop preserved)", service: SERVICE, fields: { error: String(err) } });
    }
    await this.state.storage.setAlarm(nextDigestRunAt(Date.now(), nextStart));
  }

  // ---- Mac mini relay ----
  private liveAgent(): CfWebSocket | null {
    const open = this.state.getWebSockets(AGENT_TAG).filter((s) => s.readyState === OPEN);
    return open[open.length - 1] ?? null;
  }

  private acceptAgent(): Response {
    for (const old of this.state.getWebSockets(AGENT_TAG)) {
      try {
        old.close(4000, "replaced");
      } catch {
        /* already closing */
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server as unknown as CfWebSocket, [AGENT_TAG]);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  private async rpc(body: string): Promise<Response> {
    const agent = this.liveAgent();
    if (!agent) return json(503, { error: "agent_offline" });
    const id = crypto.randomUUID();
    let parsed: { op?: unknown; payload?: unknown };
    try {
      parsed = JSON.parse(body) as { op?: unknown; payload?: unknown };
    } catch {
      return json(400, { error: "invalid_json" });
    }
    if (parsed.op !== "summarize" && parsed.op !== "ask") return json(400, { error: "invalid_op" });
    const frame = JSON.stringify({ t: "req", id, op: parsed.op, payload: parsed.payload ?? null });
    if (frame.length > MAX_FRAME_CHARS) return json(413, { error: "too_large" });
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(json(503, { error: "agent_timeout" }));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        agent.send(frame);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(json(503, { error: "agent_offline" }));
      }
    });
  }

  async webSocketMessage(_ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    const f = parseAgentFrame(message);
    if (!f) return;
    const p = this.pending.get(f.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(f.id);
    p.resolve(json(f.ok ? 200 : 502, f.body));
  }

  async webSocketClose(ws: CfWebSocket): Promise<void> {
    try {
      ws.close(1000, "bye");
    } catch {
      /* already closed */
    }
  }
}
