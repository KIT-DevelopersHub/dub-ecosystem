import { describe, it, expect } from "vitest";
import { signWsTicket, verifyWsTicket, ticketExpiryMs } from "../src/wsticket";
import { buildPresenceSnapshot, presenceEqual, type SocketMeta } from "../src/presence";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import type { AppDeps, DtoCache, UpstreamPort } from "../src/ports";
import { fakeAuthClient, fakeUpstream, fakeViewRepo, fakeCache } from "./helpers";

const SECRET = "unit-secret";
const H = (extra: Record<string, string> = {}) => ({ "x-dub-request-id": "req_test", ...extra });
const AUTHED = H({ "x-dub-user-id": "user_a" });

function deps(over: { allow?: boolean } = {}): AppDeps {
  const auth = fakeAuthClient({ allow: over.allow ?? true });
  return {
    upstream: (): UpstreamPort => fakeUpstream({}),
    cache: (): DtoCache => fakeCache(),
    views: () => fakeViewRepo(),
    authClient: () => auth,
  };
}

describe("ws-ticket sign/verify (HMAC, DO handshake)", () => {
  it("round-trips valid claims", async () => {
    const exp = ticketExpiryMs();
    const t = await signWsTicket(SECRET, { eventId: "evt_1", userId: "usr_1", displayName: "高岡", expEpochMs: exp });
    const claims = await verifyWsTicket(SECRET, t);
    expect(claims).toMatchObject({ eventId: "evt_1", userId: "usr_1", displayName: "高岡" });
  });

  it("rejects a wrong secret, a tampered payload, and an expired ticket", async () => {
    const t = await signWsTicket(SECRET, { eventId: "evt_1", userId: "usr_1", expEpochMs: ticketExpiryMs() });
    expect(await verifyWsTicket("other-secret", t)).toBeNull();
    const [payload, sig] = t.split(".");
    const tampered = `${payload}x.${sig}`;
    expect(await verifyWsTicket(SECRET, tampered)).toBeNull();
    const expired = await signWsTicket(SECRET, { eventId: "evt_1", userId: "usr_1", expEpochMs: Date.now() - 1000 });
    expect(await verifyWsTicket(SECRET, expired)).toBeNull();
  });
});

describe("presence snapshot aggregation", () => {
  const meta = (o: Partial<SocketMeta> & { userId: string }): SocketMeta => ({
    userId: o.userId,
    editing: o.editing ?? false,
    lastSeen: o.lastSeen ?? Date.now(),
    ...(o.displayName ? { displayName: o.displayName } : {}),
    ...(o.editingTaskId ? { editingTaskId: o.editingTaskId } : {}),
  });

  it("dedupes a user across tabs and unions their edit state", () => {
    const snap = buildPresenceSnapshot([
      meta({ userId: "u1", displayName: "Ann" }),
      meta({ userId: "u1", editing: true, editingTaskId: "t9" }), // same user, 2nd tab editing
      meta({ userId: "u2", displayName: "Ben" }),
    ]);
    expect(snap).toHaveLength(2);
    const u1 = snap.find((u) => u.userId === "u1")!;
    expect(u1.editing).toBe(true);
    expect(u1.editingTaskIds).toEqual(["t9"]);
    expect(u1.displayName).toBe("Ann");
    expect(snap.find((u) => u.userId === "u2")!.editing).toBe(false);
  });

  it("presenceEqual detects editing/label/membership changes", () => {
    const a = buildPresenceSnapshot([meta({ userId: "u1", displayName: "Ann" })]);
    const b = buildPresenceSnapshot([meta({ userId: "u1", displayName: "Ann" })]);
    expect(presenceEqual(a, b)).toBe(true);
    const c = buildPresenceSnapshot([meta({ userId: "u1", displayName: "Ann", editing: true, editingTaskId: "t1" })]);
    expect(presenceEqual(a, c)).toBe(false);
    const d = buildPresenceSnapshot([meta({ userId: "u1" }), meta({ userId: "u2" })]);
    expect(presenceEqual(a, d)).toBe(false);
  });
});

describe("GET /gantt/ws-ticket", () => {
  it("401 without auth", async () => {
    const res = await createApp(deps()).request("/gantt/ws-ticket?eventId=evt_1", { headers: H() }, {} as Env);
    expect(res.status).toBe(401);
  });

  it("400 without eventId", async () => {
    const res = await createApp(deps()).request("/gantt/ws-ticket", { headers: AUTHED }, {} as Env);
    expect(res.status).toBe(400);
  });

  it("503 when realtime (GANTT_ROOM) is not provisioned", async () => {
    const res = await createApp(deps()).request("/gantt/ws-ticket?eventId=evt_1", { headers: AUTHED }, {} as Env);
    expect(res.status).toBe(503);
  });

  it("issues a verifiable ticket + DO URL + self identity when the DO is bound", async () => {
    const env = { GANTT_ROOM: {}, WS_TICKET_SECRET: SECRET, GANTT_RT_DO_URL_BASE: "wss://rt.example/ws/:id" } as unknown as Env;
    const res = await createApp(deps()).request("/gantt/ws-ticket?eventId=evt_42", { headers: AUTHED }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; doUrl: string; self: { userId: string } };
    expect(body.doUrl).toBe("wss://rt.example/ws/evt_42");
    expect(body.self.userId).toBe("user_a");
    const claims = await verifyWsTicket(SECRET, body.ticket);
    expect(claims).toMatchObject({ eventId: "evt_42", userId: "user_a" });
  });
});
