import { describe, it, expect } from "vitest";
import { makeHarness } from "./helpers";

describe("SessionService", () => {
  it("create -> verify returns valid with frozen SessionInfo shape", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "web");
    const res = await h.deps.sessions.verify(created.token);
    expect(res.valid).toBe(true);
    expect(res.userId).toBe("usr_1");
    expect(res.reason).toBeNull();
    expect(res.session).toEqual({
      userId: "usr_1",
      client: "web",
      sessionExpiresAt: created.session.sessionExpiresAt,
    });
    // epoch-ms exception (theme10)
    expect(typeof res.session!.sessionExpiresAt).toBe("number");
  });

  it("classifies junk tokens as malformed", async () => {
    const h = makeHarness();
    const res = await h.deps.sessions.verify("!!!not-a-token!!!");
    expect(res).toEqual({ valid: false, userId: null, session: null, reason: "malformed" });
  });

  it("returns expired once access TTL passes (still refreshable)", async () => {
    const h = makeHarness();
    const base = Date.parse("2026-08-09T12:00:00Z");
    h.setNow(base);
    const created = await h.deps.sessions.create("usr_1", "web");
    h.setNow(base + 3600_000 + 1000); // > 1h access
    const res = await h.deps.sessions.verify(created.token);
    expect(res.reason).toBe("expired");
  });

  it("returns revoked past the absolute deadline", async () => {
    const h = makeHarness();
    const base = Date.parse("2026-08-09T12:00:00Z");
    h.setNow(base);
    const created = await h.deps.sessions.create("usr_1", "web");
    h.setNow(base + 2592000_000 + 1000); // > 30d web absolute
    const res = await h.deps.sessions.verify(created.token);
    expect(res.reason).toBe("revoked");
  });

  it("logout makes the token verify as revoked", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "web");
    await h.deps.sessions.logout(created.token);
    const res = await h.deps.sessions.verify(created.token);
    expect(res.reason).toBe("revoked");
  });

  it("revokeUser force-invalidates existing sessions", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_9", "web");
    await h.deps.sessions.revokeUser("usr_9");
    const res = await h.deps.sessions.verify(created.token);
    expect(res.reason).toBe("revoked");
  });

  it("refresh rotates the token and kills the old one (reuse => revoked)", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "mobile");
    const refreshed = await h.deps.sessions.refresh(created.token);
    expect("token" in refreshed).toBe(true);
    if (!("token" in refreshed)) throw new Error("expected rotation");
    expect(refreshed.token).not.toBe(created.token);
    // new token valid
    expect((await h.deps.sessions.verify(refreshed.token)).valid).toBe(true);
    // old token now revoked (reuse detection)
    expect((await h.deps.sessions.verify(created.token)).reason).toBe("revoked");
  });

  it("refresh preserves the absolute deadline (mobile 180d)", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "mobile");
    const refreshed = await h.deps.sessions.refresh(created.token);
    if (!("token" in refreshed)) throw new Error("expected rotation");
    expect(refreshed.absoluteExpiresAt).toBe(created.absoluteExpiresAt);
  });

  it("refresh rejects malformed and force-revoked tokens", async () => {
    const h = makeHarness();
    expect(await h.deps.sessions.refresh("###")).toEqual({ error: "malformed" });
    const created = await h.deps.sessions.create("usr_5", "web");
    await h.deps.sessions.revokeUser("usr_5");
    expect(await h.deps.sessions.refresh(created.token)).toEqual({ error: "revoked" });
  });

  it("refresh allows an access-expired (but not absolute-expired) token", async () => {
    const h = makeHarness();
    const base = Date.parse("2026-08-09T12:00:00Z");
    h.setNow(base);
    const created = await h.deps.sessions.create("usr_1", "web");
    h.setNow(base + 3600_000 + 1000); // access expired
    const refreshed = await h.deps.sessions.refresh(created.token);
    expect("token" in refreshed).toBe(true);
  });
});
