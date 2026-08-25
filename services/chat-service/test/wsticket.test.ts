import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";
import { signWsTicket, verifyWsTicket, ticketExpiryMs } from "../src/wsticket";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("ws-ticket HMAC (issuer + DO verifier contract)", () => {
  it("round-trips valid claims", async () => {
    const secret = "s3cr3t";
    const exp = ticketExpiryMs();
    const ticket = await signWsTicket(secret, { channelId: "chan_1", userId: "user_a", expEpochMs: exp });
    const claims = await verifyWsTicket(secret, ticket);
    expect(claims).toEqual({ channelId: "chan_1", userId: "user_a", expEpochMs: exp });
  });

  it("rejects an expired ticket", async () => {
    const secret = "s3cr3t";
    const ticket = await signWsTicket(secret, { channelId: "chan_1", userId: "user_a", expEpochMs: Date.now() - 1000 });
    expect(await verifyWsTicket(secret, ticket)).toBeNull();
  });

  it("rejects a tampered signature and a wrong secret", async () => {
    const ticket = await signWsTicket("right", { channelId: "chan_1", userId: "user_a", expEpochMs: ticketExpiryMs() });
    expect(await verifyWsTicket("wrong", ticket)).toBeNull();
    expect(await verifyWsTicket("right", ticket.slice(0, -2) + "xy")).toBeNull();
  });
});

describe("GET /channels/:id/ws-ticket", () => {
  it("member gets a verifiable ticket + absolute doUrl", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "GET", `/chat/channels/${c.json.id}/ws-ticket`);
    expect(res.status).toBe(200);
    expect(res.json.doUrl).toBe(`wss://chat-rt.test/ws/${c.json.id}`);
    expect(typeof res.json.expiresAt).toBe("string");
    const claims = await verifyWsTicket(deps.wsTicketSecret, res.json.ticket);
    expect(claims?.channelId).toBe(c.json.id);
    expect(claims?.userId).toBe("user_caller");
  });

  it("non-member CAN get a ws-ticket on a public channel -> 200 (public subscribe without join)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "GET", `/chat/channels/${c.json.id}/ws-ticket`, { userId: "user_stranger" });
    expect(res.status).toBe(200);
    expect(typeof res.json.ticket).toBe("string");
  });

  it("non-member cannot get a ws-ticket on a PRIVATE channel -> 404 (hidden)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    const res = await call(app, "GET", `/chat/channels/${c.json.id}/ws-ticket`, { userId: "user_stranger" });
    expect(res.status).toBe(404);
  });
});
