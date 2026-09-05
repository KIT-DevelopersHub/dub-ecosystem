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

async function ticketFor(
  eventId: string,
  userId: string,
  opts: { exp?: number; displayName?: string } = {},
): Promise<string> {
  return signWsTicket(SECRET, {
    eventId,
    userId,
    expEpochMs: opts.exp ?? ticketExpiryMs(),
    displayName: opts.displayName,
  });
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

/** True for a presence-roster frame — informational, fanned out on every join/leave.
 *  The delta/pong assertions below skip these so a join's roster snapshot never masks the
 *  row.moved / chart.invalidated / pong they're actually waiting on. */
function isPresenceFrame(data: string): boolean {
  if (data === "pong") return false;
  try {
    return (JSON.parse(data) as { kind?: unknown }).kind === "presence";
  } catch {
    return false;
  }
}

/** Resolve with the next NON-presence message, or reject after `ms` (used to assert
 *  delivery of deltas / pong; presence-roster frames are skipped). */
function nextMessage(ws: WebSocket, ms = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
    const onMessage = (e: MessageEvent) => {
      const data = e.data as string;
      if (isPresenceFrame(data)) return; // ignore presence; keep waiting for the real frame
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage as EventListener);
      resolve(data);
    };
    ws.addEventListener("message", onMessage as EventListener);
  });
}

/** Resolve with the first presence-roster frame whose users satisfy `predicate` (robust
 *  against the join/leave frames that race around connect), or reject after `ms`. */
function awaitPresence(
  ws: WebSocket,
  predicate: (users: gantt.GanttPresenceUser[]) => boolean,
  ms = 1000,
): Promise<gantt.GanttPresenceUser[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for matching presence")), ms);
    const onMessage = (e: MessageEvent) => {
      const data = e.data as string;
      if (!isPresenceFrame(data)) return;
      const users = (JSON.parse(data) as { users: gantt.GanttPresenceUser[] }).users;
      if (!predicate(users)) return; // keep waiting for the frame we care about
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage as EventListener);
      resolve(users);
    };
    ws.addEventListener("message", onMessage as EventListener);
  });
}
const idsOf = (users: gantt.GanttPresenceUser[]): string[] => users.map((u) => u.userId).sort();

/** Assert NO delta/pong arrives within `ms` (presence frames are ignored). */
function expectSilence(ws: WebSocket, ms = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (isPresenceFrame(e.data as string)) return;
      reject(new Error("unexpected message"));
    };
    ws.addEventListener("message", onMessage as EventListener);
    setTimeout(() => {
      ws.removeEventListener("message", onMessage as EventListener);
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

describe("GanttRoom DO — presence roster (Docs-style avatars)", () => {
  it("hello returns the live roster, deduped by user across a user's tabs", async () => {
    const ev = "event_presence_hello";
    const a1 = await connect(ev, await ticketFor(ev, "user_a"));
    const a2 = await connect(ev, await ticketFor(ev, "user_a")); // same user, 2nd tab
    const b = await connect(ev, await ticketFor(ev, "user_b"));
    a1.webSocket!.accept();
    a2.webSocket!.accept();
    b.webSocket!.accept();

    const roster = awaitPresence(a1.webSocket!, (u) => u.length === 2);
    a1.webSocket!.send(JSON.stringify({ t: "hello" }));
    const users = await roster;

    expect(idsOf(users)).toEqual(["user_a", "user_b"]); // user_a's two tabs collapse to one
    for (const u of users) {
      expect(u.editing).toBe(false); // presence is view-only today
      expect(u.editingTaskIds).toEqual([]);
    }
    a1.webSocket!.close();
    a2.webSocket!.close();
    b.webSocket!.close();
  });

  it("fans a join out to existing viewers (a new avatar appears live)", async () => {
    const ev = "event_presence_join";
    const a = await connect(ev, await ticketFor(ev, "user_a"));
    a.webSocket!.accept();
    // Wait for the roster to grow to include the joiner (ignores the earlier [user_a] frame).
    const joined = awaitPresence(a.webSocket!, (u) => u.some((x) => x.userId === "user_b"));
    const b = await connect(ev, await ticketFor(ev, "user_b"));
    b.webSocket!.accept();
    expect(idsOf(await joined)).toEqual(["user_a", "user_b"]);
    a.webSocket!.close();
    b.webSocket!.close();
  });

  it("fans a leave out to remaining viewers (the avatar disappears)", async () => {
    const ev = "event_presence_leave";
    const a = await connect(ev, await ticketFor(ev, "user_a"));
    const b = await connect(ev, await ticketFor(ev, "user_b"));
    a.webSocket!.accept();
    b.webSocket!.accept();
    // The leaver must be gone from the roster the remaining socket receives.
    const afterLeave = awaitPresence(a.webSocket!, (u) => !u.some((x) => x.userId === "user_b"));
    b.webSocket!.close();
    expect(idsOf(await afterLeave)).toEqual(["user_a"]);
    a.webSocket!.close();
  });

  it("carries the ticket-signed displayName into the roster (non-spoofable label)", async () => {
    const ev = "event_presence_name";
    const s = await connect(ev, await ticketFor(ev, "user_c", { displayName: "山田 太郎" }));
    s.webSocket!.accept();
    const roster = awaitPresence(s.webSocket!, (u) => u.some((x) => x.userId === "user_c"));
    s.webSocket!.send(JSON.stringify({ t: "hello" }));
    const me = (await roster).find((u) => u.userId === "user_c");
    expect(me?.displayName).toBe("山田 太郎");
    s.webSocket!.close();
  });
});
