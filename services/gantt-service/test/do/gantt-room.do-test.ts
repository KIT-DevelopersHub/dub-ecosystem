// GanttRoom Durable Object — real-runtime tests (workerd via miniflare).
// Covers: ws-ticket verification at connect, Origin allow-listing, the public-exposure
// guard (subdomain = WS-only), WS delivery / per-event fanout isolation, and the
// DoRealtimePublisher wiring (row.moved delta + chart.invalidated hint). This is the
// behavioral proof of the live 2-tab sync that mock demos cannot show: two sockets on the
// same event both receive a published delta; a socket on another event does not.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import { signWsTicket, ticketExpiryMs } from "../../src/wsticket";
import { DoRealtimePublisher } from "../../src/realtime";

const SECRET = "test-secret"; // matches WS_TICKET_SECRET binding in vitest.workers.config.ts
const ALLOWED_ORIGIN = "https://app.developershub.jp";
// GANTT_ROOM is optional on Env (Noop fallback in local/preview) but always bound here.
const GANTT_ROOM = env.GANTT_ROOM!;

async function ticketFor(eventId: string, userId: string, opts: { exp?: number } = {}): Promise<string> {
  return signWsTicket(SECRET, { eventId, userId, expEpochMs: opts.exp ?? ticketExpiryMs() });
}

/** Open a WS through the worker's /ws routing (index.ts -> GanttRoom DO). */
async function connect(
  eventId: string,
  ticket: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`https://gantt-rt.test/ws/${encodeURIComponent(eventId)}?ticket=${encodeURIComponent(ticket)}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
}

/** True for a `presence` snapshot frame (auto-pushed on any join/leave). Tests that
 *  assert a specific delta/pong skip these so the new presence traffic is transparent. */
function isPresenceFrame(data: unknown): boolean {
  return typeof data === "string" && data.includes('"kind":"presence"');
}

/** Resolve with the next NON-presence message, or reject after `ms`. Presence snapshots
 *  are transparent to these delivery assertions (see isPresenceFrame). */
function nextMessage(ws: WebSocket, ms = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
    const onMsg = (e: MessageEvent) => {
      if (isPresenceFrame(e.data)) return; // skip; keep listening
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg as EventListener);
      resolve(e.data as string);
    };
    ws.addEventListener("message", onMsg as EventListener);
  });
}

/** Wait for a `presence` frame whose roster has exactly `want` users; resolve its list. */
function nextPresence(ws: WebSocket, want: number, ms = 1500): Promise<gantt.GanttPresenceUser[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for presence(${want})`)), ms);
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      let ev: gantt.GanttRealtimeEvent;
      try {
        ev = JSON.parse(e.data) as gantt.GanttRealtimeEvent;
      } catch {
        return;
      }
      if (ev.kind !== "presence" || ev.users.length !== want) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg as EventListener);
      resolve(ev.users);
    };
    ws.addEventListener("message", onMsg as EventListener);
  });
}

/** Assert NO non-presence message arrives within `ms` (presence frames are ignored). */
function expectSilence(ws: WebSocket, ms = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (isPresenceFrame(e.data)) return;
      reject(new Error("unexpected message"));
    };
    ws.addEventListener("message", onMsg as EventListener);
    setTimeout(() => {
      ws.removeEventListener("message", onMsg as EventListener);
      resolve();
    }, ms);
  });
}

const moveEvent = (eventId: string): gantt.GanttRealtimeEvent => ({
  kind: "row.moved",
  eventId,
  taskId: "task_1",
  startsAt: "2026-08-01T00:00:00.000Z",
  endsAt: "2026-08-05T00:00:00.000Z",
  at: "2026-08-09T00:00:00.000Z",
});

describe("GanttRoom DO — ws-ticket verification at connect", () => {
  it("accepts a valid ticket (101 upgrade)", async () => {
    const ev = "event_ok";
    const res = await connect(ev, await ticketFor(ev, "user_a"));
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("rejects a missing ticket (401, no upgrade)", async () => {
    const res = await SELF.fetch("https://gantt-rt.test/ws/event_x", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeFalsy();
  });

  it("rejects a ticket signed with the wrong secret (401)", async () => {
    const ev = "event_wrongsecret";
    const bad = await signWsTicket("not-the-secret", { eventId: ev, userId: "user_a", expEpochMs: ticketExpiryMs() });
    const res = await connect(ev, bad);
    expect(res.status).toBe(401);
  });

  it("rejects an expired ticket (401)", async () => {
    const ev = "event_expired";
    const res = await connect(ev, await ticketFor(ev, "user_a", { exp: Date.now() - 1000 }));
    expect(res.status).toBe(401);
  });

  it("rejects a ticket whose event differs from the URL (403)", async () => {
    const other = await ticketFor("event_other", "user_a");
    const res = await connect("event_target", other);
    expect(res.status).toBe(403);
  });

  it("requires the websocket upgrade header (not a 101)", async () => {
    const ev = "event_noupgrade";
    const res = await SELF.fetch(`https://gantt-rt.test/ws/${ev}?ticket=${await ticketFor(ev, "user_a")}`);
    expect(res.status).not.toBe(101);
  });
});

describe("GanttRoom DO — Origin allow-listing", () => {
  it("accepts the allowed SPA origin", async () => {
    const ev = "event_origin_ok";
    const res = await connect(ev, await ticketFor(ev, "user_a"), { Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("accepts the fe2 app-shell workers.dev delivery origin", async () => {
    const ev = "event_origin_wd";
    const res = await connect(ev, await ticketFor(ev, "user_a"), {
      Origin: "https://dub-fe2-app-shell.developershub-site.workers.dev",
    });
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("rejects a disallowed browser origin (403)", async () => {
    const ev = "event_origin_bad";
    const res = await connect(ev, await ticketFor(ev, "user_a"), { Origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("allows a native client with no Origin header", async () => {
    const ev = "event_no_origin";
    const res = await connect(ev, await ticketFor(ev, "user_a"));
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });
});

describe("public-exposure guard (workers.dev subdomain = WS-only)", () => {
  const PUBLIC = "https://dub-gantt-service.developershub-site.workers.dev";
  const SVC = "https://svc";

  it("blocks the header-trusting HTTP API from a public (non-svc) host -> 404", async () => {
    // A public caller must NOT reach /gantt/* and spoof x-dub-user-id over the subdomain.
    const res = await SELF.fetch(`${PUBLIC}/gantt?eventId=event_1`, { headers: { "x-dub-user-id": "user_attacker" } });
    expect(res.status).toBe(404);
  });

  it("allows /health publicly (uptime probe)", async () => {
    const res = await SELF.fetch(`${PUBLIC}/health`);
    expect(res.status).toBe(200);
  });

  it('lets the api-gateway service binding (host "svc") through to the app', async () => {
    const res = await SELF.fetch(`${SVC}/health`);
    expect(res.status).toBe(200);
  });
});

describe("GanttRoom DO — delivery & fanout (the live 2-tab sync)", () => {
  it("fans a published delta out to every connected socket in the event room", async () => {
    const ev = "event_fanout";
    const a = await connect(ev, await ticketFor(ev, "user_a"));
    const b = await connect(ev, await ticketFor(ev, "user_b"));
    a.webSocket!.accept();
    b.webSocket!.accept();
    const gotA = nextMessage(a.webSocket!);
    const gotB = nextMessage(b.webSocket!);

    const delivered = await GANTT_ROOM.getByName(ev).publish(moveEvent(ev));
    expect(delivered).toBe(2);

    const [ma, mb] = await Promise.all([gotA, gotB]);
    expect(JSON.parse(ma)).toMatchObject({ kind: "row.moved", eventId: ev, taskId: "task_1" });
    expect(JSON.parse(mb)).toMatchObject({ kind: "row.moved", eventId: ev });
    a.webSocket!.close();
    b.webSocket!.close();
  });

  it("does NOT deliver an event's delta to a different event's sockets", async () => {
    const ev1 = "event_isolated_1";
    const ev2 = "event_isolated_2";
    const s1 = await connect(ev1, await ticketFor(ev1, "user_a"));
    const s2 = await connect(ev2, await ticketFor(ev2, "user_b"));
    s1.webSocket!.accept();
    s2.webSocket!.accept();

    const heard = nextMessage(s1.webSocket!);
    const silence = expectSilence(s2.webSocket!);

    await GANTT_ROOM.getByName(ev1).publish(moveEvent(ev1));

    expect(JSON.parse(await heard)).toMatchObject({ eventId: ev1 });
    await expect(silence).resolves.toBeUndefined();
    s1.webSocket!.close();
    s2.webSocket!.close();
  });

  it("publish to an empty room delivers to nobody", async () => {
    const delivered = await GANTT_ROOM.getByName("event_empty").publish(moveEvent("event_empty"));
    expect(delivered).toBe(0);
  });

  it("reports presence (connected socket count)", async () => {
    const ev = "event_presence";
    const stub = GANTT_ROOM.getByName(ev);
    expect(await stub.presence()).toBe(0);
    const s = await connect(ev, await ticketFor(ev, "user_a"));
    s.webSocket!.accept();
    expect(await stub.presence()).toBe(1);
    s.webSocket!.close();
  });

  it("answers a keepalive ping with pong", async () => {
    const ev = "event_ping";
    const s = await connect(ev, await ticketFor(ev, "user_a"));
    s.webSocket!.accept();
    const pong = nextMessage(s.webSocket!);
    s.webSocket!.send("ping");
    expect(await pong).toBe("pong");
    s.webSocket!.close();
  });
});

describe("DoRealtimePublisher — real RT wiring (read model -> DO)", () => {
  it("publishRowMoved reaches connected sockets as a row.moved delta", async () => {
    const ev = "event_pub_move";
    const publisher = new DoRealtimePublisher(GANTT_ROOM);
    const s = await connect(ev, await ticketFor(ev, "user_a"));
    s.webSocket!.accept();
    const got = nextMessage(s.webSocket!);

    await publisher.publishRowMoved(ev, {
      taskId: "task_9",
      startsAt: "2026-08-02T00:00:00.000Z",
      endsAt: "2026-08-06T00:00:00.000Z",
    });

    expect(JSON.parse(await got)).toMatchObject({
      kind: "row.moved",
      eventId: ev,
      taskId: "task_9",
      startsAt: "2026-08-02T00:00:00.000Z",
      endsAt: "2026-08-06T00:00:00.000Z",
    });
    s.webSocket!.close();
  });

  it("publishInvalidated reaches connected sockets as a chart.invalidated hint", async () => {
    const ev = "event_pub_inval";
    const publisher = new DoRealtimePublisher(GANTT_ROOM);
    const s = await connect(ev, await ticketFor(ev, "user_a"));
    s.webSocket!.accept();
    const got = nextMessage(s.webSocket!);

    await publisher.publishInvalidated(ev, "task.created");

    expect(JSON.parse(await got)).toMatchObject({ kind: "chart.invalidated", eventId: ev, reason: "task.created" });
    s.webSocket!.close();
  });
});

describe("GanttRoom DO — presence (who is viewing this gantt, live)", () => {
  it("pushes a presence snapshot to a viewer when they join", async () => {
    const ev = "event_presence_join";
    const a = await connect(ev, await ticketFor(ev, "user_a"));
    a.webSocket!.accept();
    const users = await nextPresence(a.webSocket!, 1);
    expect(users.map((u) => u.userId)).toEqual(["user_a"]);
    a.webSocket!.close();
  });

  it("fans the updated roster out to existing peers when another viewer joins", async () => {
    const ev = "event_presence_second";
    const a = await connect(ev, await ticketFor(ev, "user_a"));
    a.webSocket!.accept();
    await nextPresence(a.webSocket!, 1); // a alone

    const seenTwo = nextPresence(a.webSocket!, 2); // a should learn about b
    const b = await connect(ev, await ticketFor(ev, "user_b"));
    b.webSocket!.accept();

    const users = await seenTwo;
    expect(users.map((u) => u.userId).sort()).toEqual(["user_a", "user_b"]);
    a.webSocket!.close();
    b.webSocket!.close();
  });

  it("dedupes one user's multiple tabs into a single avatar", async () => {
    const ev = "event_presence_dedupe";
    const t1 = await connect(ev, await ticketFor(ev, "user_dup"));
    t1.webSocket!.accept();
    await nextPresence(t1.webSocket!, 1);

    // Second tab, SAME user → roster must still show exactly one user.
    const stillOne = nextPresence(t1.webSocket!, 1);
    const t2 = await connect(ev, await ticketFor(ev, "user_dup"));
    t2.webSocket!.accept();
    const users = await stillOne;
    expect(users.map((u) => u.userId)).toEqual(["user_dup"]);
    t1.webSocket!.close();
    t2.webSocket!.close();
  });

  it("removes a viewer from the roster when their socket closes", async () => {
    const ev = "event_presence_leave";
    const a = await connect(ev, await ticketFor(ev, "user_a"));
    const b = await connect(ev, await ticketFor(ev, "user_b"));
    a.webSocket!.accept();
    b.webSocket!.accept();
    await nextPresence(a.webSocket!, 2); // both present

    const backToOne = nextPresence(a.webSocket!, 1); // a should see b leave
    b.webSocket!.close();
    const users = await backToOne;
    expect(users.map((u) => u.userId)).toEqual(["user_a"]);
    a.webSocket!.close();
  });

  it("answers `hello` with the current snapshot (unicast)", async () => {
    const ev = "event_presence_hello";
    const a = await connect(ev, await ticketFor(ev, "user_a"));
    a.webSocket!.accept();
    await nextPresence(a.webSocket!, 1); // drain the join broadcast

    const replied = nextPresence(a.webSocket!, 1);
    a.webSocket!.send("hello");
    const users = await replied;
    expect(users.map((u) => u.userId)).toEqual(["user_a"]);
    a.webSocket!.close();
  });
});
