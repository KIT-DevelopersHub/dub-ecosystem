// Documented cross-unit wiring gaps discovered by the integration suite. These
// are NOT test failures — they codify real gateway<->service path-contract
// mismatches (integration-e2e §8 未決/要調整) so a regression that "fixes" them
// flips the assertion and forces the catalog to be updated. Each references the
// finding reported back to the orchestrator.
import { describe, it, expect } from "vitest";
import { createHarness } from "../lib/harness";

describe("GAP-1: gateway /me composition calls identity /users/:id, which identity mounts under /identity", () => {
  it("GET /api/v1/me currently fails (identity has no top-level /users/:id route)", async () => {
    const h = await createHarness();
    const token = await h.login("organizer");
    const me = await h.gw("GET", "/api/v1/me", { token });
    // me.ts calls svc.identity.get("/users/:id"); identity.app mounts ext under
    // "/identity", so the master-user fetch 404s and the gateway surfaces 502.
    // FIX: gateway should call "/identity/users/:id" OR identity should expose an
    // internal "/internal/users/:id" master read. When fixed, change to toBe(200).
    expect(me.status).not.toBe(200);
    expect([404, 502]).toContain(me.status);
  });
});

describe("GAP-2: notification service mounts inbox at /inbox, gateway forwards /notifications/inbox", () => {
  it("documented: external /api/v1/notifications/inbox strips to /notifications/inbox, but the real service serves /inbox", async () => {
    // The harness notification STUB normalises both prefixes so gateway routing is
    // still validated (see S5). The REAL notification-service (services/notification
    // /src/app.ts) registers "/inbox/*" WITHOUT the "/notifications" segment, so the
    // proxied external path would 404 against the real Worker. FIX: mount the real
    // routes under "/notifications" (matching event-service's "/events" convention)
    // OR add a gateway strip rule. This assertion just anchors the finding.
    const h = await createHarness();
    const member = await h.login("member");
    const res = await h.gw("GET", "/api/v1/notifications/inbox", { token: member });
    expect(res.status).toBe(200); // passes only because the STUB accepts both prefixes
  });
});

describe("harness self-tests (ハーネスの信頼性)", () => {
  it("login is repeatable and issues distinct tokens per call", async () => {
    const h = await createHarness();
    const a = await h.login("admin");
    const b = await h.login("admin");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b); // each test-login mints a fresh session token
  });

  it("stores are isolated between harness instances", async () => {
    const h1 = await createHarness();
    const org1 = await h1.login("organizer");
    await h1.gw("POST", "/api/v1/events", { token: org1, body: { title: "only-in-h1" } });

    const h2 = await createHarness();
    const org2 = await h2.login("organizer");
    const events2 = await h2.gw("GET", "/api/v1/events", { token: org2 });
    expect(events2.json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});
