import { describe, it, expect } from "vitest";
import { makeHarness, KV_MIN_TTL } from "./helpers";

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
    // Idle TTL pushed out past the absolute one so this isolates the ABSOLUTE deadline
    // (with production values the 30d idle rule would bite first — covered separately).
    const h = makeHarness({ SESSION_IDLE_TTL_SEC: "31536000" });
    const base = Date.parse("2026-08-09T12:00:00Z");
    h.setNow(base);
    const created = await h.deps.sessions.create("usr_1", "web");
    h.setNow(base + 7776000_000 + 1000); // > 90d web absolute
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

  // Mobile is deliberately NOT sliding: the bearer token is device-resident with no
  // cookie to clear, so its fixed 180d deadline is kept as the one unconditional re-auth
  // point in the system. Refresh must leave it exactly where it was.
  it("refresh preserves the absolute deadline for mobile (fixed 180d, no sliding)", async () => {
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

  // --- rotation race (session-expiry bug): a duplicate refresh with the SAME
  // pre-rotation token (multi-tab load / Promise.all 401 burst / retry sent before
  // the rotated Set-Cookie applied) must NOT hard-fail with "Invalid token". ---
  it("duplicate refresh with the pre-rotation token converges on the same successor (idempotent)", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "web");

    const first = await h.deps.sessions.refresh(created.token);
    if (!("token" in first)) throw new Error("first refresh must succeed");

    // Second refresh still carries the original token (the browser had not yet
    // applied the rotated cookie). Previously this returned { error: "revoked" }.
    const second = await h.deps.sessions.refresh(created.token);
    expect("token" in second).toBe(true);
    if (!("token" in second)) throw new Error("second refresh must not hard-fail");
    expect(second.token).toBe(first.token); // same successor — no orphaned second token
    expect(second.absoluteExpiresAt).toBe(first.absoluteExpiresAt);

    // The successor authenticates; the old token does not (reuse detection intact).
    expect((await h.deps.sessions.verify(first.token)).valid).toBe(true);
    expect((await h.deps.sessions.verify(created.token)).reason).toBe("revoked");
  });

  it("parallel refresh burst never hard-fails and every issued token is usable", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "web");
    const results = await Promise.all([
      h.deps.sessions.refresh(created.token),
      h.deps.sessions.refresh(created.token),
      h.deps.sessions.refresh(created.token),
    ]);
    for (const r of results) {
      expect("token" in r).toBe(true);
      if ("token" in r) expect((await h.deps.sessions.verify(r.token)).valid).toBe(true);
    }
  });

  // --- Workers KV expirationTtl floor (hourly-logout bug). The grace put used to ask
  // for `refreshGraceSec` (30) seconds, which real KV REJECTS, so refresh() threw and
  // the endpoint 500'd. MemoryKV now enforces the same >=60s rule as production. ---
  it("every KV write refresh() makes asks for a TTL at or above the 60s KV floor", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_ttl", "web");
    h.kv.puts.length = 0;
    const refreshed = await h.deps.sessions.refresh(created.token);
    if (!("token" in refreshed)) throw new Error("expected rotation");
    // successor record + grace pointer record
    expect(h.kv.puts).toHaveLength(2);
    for (const p of h.kv.puts) {
      expect(p.expirationTtl).toBeGreaterThanOrEqual(KV_MIN_TTL);
    }
  });

  it("refreshes with under 60s of absolute lifetime left, and the floored TTL grants no extra lifetime", async () => {
    // 1h absolute: the floor (60s) is LONGER than what actually remains, so the KV
    // record outlives the deadline. The deadline checks must still win.
    // Uses the MOBILE client on purpose — web now slides its deadline on refresh, so a
    // web session can never be left with <60s remaining after a successful refresh.
    const h = makeHarness({ SESSION_ABS_MOBILE_TTL_SEC: "3600" });
    const base = Date.parse("2026-08-09T12:00:00Z");
    h.setNow(base);
    const created = await h.deps.sessions.create("usr_edge", "mobile");
    h.setNow(base + 3_595_000); // 5s of absolute lifetime left

    const refreshed = await h.deps.sessions.refresh(created.token);
    expect("token" in refreshed).toBe(true); // no throw, no 500
    if (!("token" in refreshed)) throw new Error("expected rotation");
    expect(refreshed.absoluteExpiresAt).toBe(created.absoluteExpiresAt); // deadline untouched

    // Past the absolute deadline the floored record is still physically in KV, yet
    // neither verify() nor refresh() honours it.
    h.setNow(base + 3_600_001);
    expect(h.kv.store.has(`session:${refreshed.token}`)).toBe(true);
    expect((await h.deps.sessions.verify(refreshed.token)).reason).toBe("revoked");
    expect(await h.deps.sessions.refresh(refreshed.token)).toEqual({ error: "revoked" });
  });

  // ================= sliding absolute expiry + idle expiry (phase 2) =================
  // Time is driven purely by the injectable clock and TTLs come from config, so none of
  // these tests waits on anything real.
  const DAY = 86_400_000;
  const WEB_ABS_MS = 90 * DAY; // SESSION_ABS_WEB_TTL_SEC 7776000
  const IDLE_MS = 30 * DAY; // SESSION_IDLE_TTL_SEC 2592000
  const BASE = Date.parse("2026-08-09T12:00:00Z");

  it("refresh SLIDES the web absolute deadline forward by a full window", async () => {
    const h = makeHarness();
    h.setNow(BASE);
    const created = await h.deps.sessions.create("usr_slide", "web");
    expect(created.absoluteExpiresAt).toBe(BASE + WEB_ABS_MS);

    const t1 = BASE + 10 * DAY; // an active member, ten days in
    h.setNow(t1);
    const refreshed = await h.deps.sessions.refresh(created.token);
    if (!("token" in refreshed)) throw new Error("expected rotation");
    // Pre-phase-2 this asserted equality: the deadline never moved, so a daily user was
    // still forced back to /login on day 30.
    expect(refreshed.absoluteExpiresAt).toBe(t1 + WEB_ABS_MS);
    expect(refreshed.absoluteExpiresAt).toBeGreaterThan(created.absoluteExpiresAt);
  });

  it("refresh past the idle threshold is rejected AND revokes the record", async () => {
    const h = makeHarness();
    h.setNow(BASE);
    const created = await h.deps.sessions.create("usr_idle", "web");
    const key = `session:${created.token}`;
    expect(h.kv.store.has(key)).toBe(true);

    h.setNow(BASE + IDLE_MS + 1000); // 30d + 1s with no refresh; 90d absolute still ahead
    expect(await h.deps.sessions.refresh(created.token)).toEqual({ error: "revoked" });
    // Revoked, not merely refused: the stale token must not survive for a retry.
    expect(h.kv.store.has(key)).toBe(false);
    expect((await h.deps.sessions.verify(created.token)).reason).toBe("revoked");
  });

  it("verify rejects an idle-expired session even while absolute lifetime remains", async () => {
    const h = makeHarness();
    h.setNow(BASE);
    const created = await h.deps.sessions.create("usr_idle2", "web");
    h.setNow(BASE + IDLE_MS + 1000);
    // The record is still physically in KV (the TTL floor / eviction lag), so the deadline
    // check — not KV expiry — has to be what rejects it.
    expect(h.kv.store.has(`session:${created.token}`)).toBe(true);
    expect((await h.deps.sessions.verify(created.token)).reason).toBe("revoked");
  });

  it("refresh inside the idle window succeeds and re-arms the idle deadline", async () => {
    const h = makeHarness();
    h.setNow(BASE);
    const created = await h.deps.sessions.create("usr_active", "web");

    const t1 = BASE + IDLE_MS - 60_000; // one minute short of the idle deadline
    h.setNow(t1);
    const first = await h.deps.sessions.refresh(created.token);
    if (!("token" in first)) throw new Error("refresh inside the idle window must succeed");

    // Another near-miss 30 days later. This only works if lastSeenAt moved to t1; with a
    // fixed anchor (issuedAt) the session would already be 60d idle and dead.
    h.setNow(t1 + IDLE_MS - 60_000);
    const second = await h.deps.sessions.refresh(first.token);
    expect("token" in second).toBe(true);
  });

  it("a LEGACY record with no lastSeenAt is not rejected (issuedAt is the compat anchor)", async () => {
    const h = makeHarness();
    // Exactly what is in production KV today: no lastSeenAt field, and the old fixed 30d
    // absolute deadline. Issued 20 days ago, so under BOTH the old and new rules it is live.
    const token = "L".repeat(43);
    const issuedAt = BASE - 20 * DAY;
    h.kv.store.set(
      `session:${token}`,
      JSON.stringify({
        sessionId: "sess_legacy",
        userId: "usr_legacy",
        client: "web",
        issuedAt,
        accessExpiresAt: issuedAt + 3_600_000, // long since access-expired
        absoluteExpiresAt: issuedAt + 30 * DAY, // minted under the pre-phase-2 config
      }),
    );
    h.setNow(BASE);

    // Not force-logged-out: it refreshes, and the successor is upgraded in place — the
    // deadline slides to a full 90d and lastSeenAt starts tracking from now.
    const refreshed = await h.deps.sessions.refresh(token);
    if (!("token" in refreshed)) throw new Error("a legacy record must still refresh");
    expect(refreshed.absoluteExpiresAt).toBe(BASE + WEB_ABS_MS);
    expect((await h.deps.sessions.verify(refreshed.token)).valid).toBe(true);
    // The idle clock for the successor runs from the refresh, not from issuedAt.
    expect(refreshed.effectiveExpiresAt).toBe(BASE + IDLE_MS);
  });

  it("writes the EFFECTIVE (min) lifetime as the KV TTL, not the 90d absolute", async () => {
    const h = makeHarness();
    h.setNow(BASE);
    h.kv.puts.length = 0;
    const created = await h.deps.sessions.create("usr_kvttl", "web");
    // 90d absolute but 30d idle => 30d of real life. A 90d TTL would park dead records in
    // the free-tier namespace for two extra months.
    expect(h.kv.puts).toEqual([{ key: `session:${created.token}`, expirationTtl: IDLE_MS / 1000 }]);

    h.kv.puts.length = 0;
    const refreshed = await h.deps.sessions.refresh(created.token);
    if (!("token" in refreshed)) throw new Error("expected rotation");
    expect(h.kv.puts).toEqual([
      { key: `session:${refreshed.token}`, expirationTtl: IDLE_MS / 1000 }, // successor
      { key: `session:${created.token}`, expirationTtl: KV_MIN_TTL }, // grace pointer, at the floor
    ]);
    expect(refreshed.effectiveExpiresAt).toBe(BASE + IDLE_MS);
    // Mobile has no idle rule, so its effective lifetime IS the fixed absolute one.
    h.kv.puts.length = 0;
    const mob = await h.deps.sessions.create("usr_kvttl_m", "mobile");
    expect(h.kv.puts).toEqual([{ key: `session:${mob.token}`, expirationTtl: 180 * 86_400 }]);
    expect(mob.effectiveExpiresAt).toBe(mob.absoluteExpiresAt);
  });

  it("refresh past the grace window (old record evicted) resolves to revoked", async () => {
    const h = makeHarness();
    const created = await h.deps.sessions.create("usr_1", "web");
    const first = await h.deps.sessions.refresh(created.token);
    if (!("token" in first)) throw new Error("first refresh must succeed");
    // Simulate KV grace-TTL eviction of the old pointer record.
    h.kv.store.delete(`session:${created.token}`);
    expect(await h.deps.sessions.refresh(created.token)).toEqual({ error: "revoked" });
  });
});
