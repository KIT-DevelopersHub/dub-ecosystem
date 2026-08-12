// Release notes: broadcast a "🎉 new feature" announcement to every active user's
// inbox (in_app, forced on regardless of prefs), admin-gated publish + internal seed.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { createApp } from "../src/app";
import { makeRecipientResolver } from "../src/recipients";
import { resolveAuditQueue } from "../src/outbox";
import {
  makeInAppAdapter,
  makeEmailAdapter,
  makeChatAdapter,
  makePushAdapter,
} from "../src/adapters";
import { unreadCount, upsertPreference } from "../src/repo";
import {
  publishRelease,
  buildReleaseInput,
  seedInitialReleases,
} from "../src/release";
import { INITIAL_RELEASE_NOTES } from "../src/config";
import type { IngestDeps } from "../src/ingest";
import { makeTestEnv, ctx, fakeIdentity, fakeEvent, type TestEnvHandle } from "./helpers";

// Deps whose recipient resolver is backed by a fake identity that broadcasts `allUsers`.
function broadcastDeps(h: TestEnvHandle, allUsers: string[]): IngestDeps {
  const c = ctx();
  const identity = fakeIdentity({ allUsers });
  const event = fakeEvent({});
  const resolver = makeRecipientResolver({ identity, event });
  return {
    db: h.db,
    resolver,
    adapters: {
      in_app: makeInAppAdapter(h.db),
      email: makeEmailAdapter({ identity, ctx: c }),
      chat: makeChatAdapter({ ctx: c }),
      push: makePushAdapter({ ctx: c }),
    },
    auditEnv: resolveAuditQueue(h.env),
    orgId: "org_devhub",
    ctx: c,
  };
}

// A fake identity binding answering POST /authz/check with a fixed allow/deny — drives
// the real @dub/auth-client requirePermission("notif:admin") end to end.
function fakeAuthzIdentity(allow: boolean): Fetcher {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/authz/check")) {
        const payload = { decisions: [{ allowed: allow, evaluatedAt: new Date().toISOString(), ttlSeconds: 0 }] };
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
}

function reqOf(app: ReturnType<typeof createApp>, h: TestEnvHandle) {
  return (path: string, init: RequestInit) => app.request(path, init, h.env as unknown as Record<string, unknown>);
}

describe("release notes — buildReleaseInput", () => {
  it("targets all users, in_app only, type=release, with a derived dedup key", () => {
    const input = buildReleaseInput({ title: "New thing", body: "Details", app: "メール" }, "req_1", "usr_admin");
    expect(input.type).toBe("release");
    expect(input.recipients).toEqual({ all: true });
    expect(input.channels).toEqual(["in_app"]);
    expect(input.resourceType).toBe("release");
    expect(input.actorId).toBe("usr_admin");
    expect(input.dedupKey).toMatch(/^release:/);
    expect(input.meta).toEqual({ app: "メール" });
  });

  it("honours an explicit dedupKey and publishedAt meta", () => {
    const input = buildReleaseInput(
      { title: "X", body: "Y", dedupKey: "release:custom", publishedAt: "2026-08-12" },
      "req_2",
      null,
    );
    expect(input.dedupKey).toBe("release:custom");
    expect(input.meta).toEqual({ publishedAt: "2026-08-12" });
  });
});

describe("release notes — broadcast fan-out", () => {
  it("delivers an in_app inbox row to every active user", async () => {
    const h = makeTestEnv();
    const deps = broadcastDeps(h, ["u1", "u2", "u3"]);
    const res = await publishRelease(deps, ctx(), { title: "🎉 New feature", body: "It ships." }, "usr_admin");
    expect(res.deduplicated).toBe(false);
    expect(await unreadCount(h.db, "u1")).toBe(1);
    expect(await unreadCount(h.db, "u2")).toBe(1);
    expect(await unreadCount(h.db, "u3")).toBe(1);
  });

  it("forces in_app even when the user disabled the release preference", async () => {
    const h = makeTestEnv();
    // u1 turns OFF in_app for release — the forced broadcast must still land.
    await upsertPreference(h.db, "u1", "release", "in_app", false);
    const deps = broadcastDeps(h, ["u1"]);
    await publishRelease(deps, ctx(), { title: "Forced", body: "b" }, null);
    expect(await unreadCount(h.db, "u1")).toBe(1);
  });

  it("is idempotent: re-publishing the same dedupKey creates no second inbox row", async () => {
    const h = makeTestEnv();
    const deps = broadcastDeps(h, ["u1"]);
    const one = { title: "Same", body: "b", dedupKey: "release:same" };
    const first = await publishRelease(deps, ctx(), one, null);
    const second = await publishRelease(deps, ctx(), one, null);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(await unreadCount(h.db, "u1")).toBe(1);
  });
});

describe("release notes — seed back-catalog", () => {
  it("publishes every curated note once; a re-run is fully deduplicated", async () => {
    const h = makeTestEnv();
    const deps = broadcastDeps(h, ["u1"]);
    const first = await seedInitialReleases(deps, ctx(), null);
    expect(first.total).toBe(INITIAL_RELEASE_NOTES.length);
    expect(first.published).toBe(INITIAL_RELEASE_NOTES.length);
    expect(first.deduplicated).toBe(0);
    expect(await unreadCount(h.db, "u1")).toBe(INITIAL_RELEASE_NOTES.length);

    const second = await seedInitialReleases(deps, ctx(), null);
    expect(second.published).toBe(0);
    expect(second.deduplicated).toBe(INITIAL_RELEASE_NOTES.length);
    expect(await unreadCount(h.db, "u1")).toBe(INITIAL_RELEASE_NOTES.length);
  });
});

describe("release notes — HTTP surface", () => {
  const publish = (userId = "usr_admin") => ({
    method: "POST",
    headers: { "content-type": "application/json", "x-dub-user-id": userId },
    body: JSON.stringify({ title: "🎉 New feature", body: "It ships to everyone." }),
  });

  it("POST /release: admin (notif:admin) -> 202 and fans out to all active users", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: fakeAuthzIdentity(true) });
    const app = createApp({ identity: fakeIdentity({ allUsers: ["u1", "u2"] }) });
    const res = await reqOf(app, h)("/release", publish());
    expect(res.status).toBe(202);
    const body = (await res.json()) as { notificationId: string; deduplicated: boolean };
    expect(body.deduplicated).toBe(false);
    expect(await unreadCount(h.db, "u1")).toBe(1);
    expect(await unreadCount(h.db, "u2")).toBe(1);
  });

  it("POST /release: non-admin (notif:admin denied) -> 403", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: fakeAuthzIdentity(false) });
    const app = createApp({ identity: fakeIdentity({ allUsers: ["u1"] }) });
    const res = await reqOf(app, h)("/release", publish());
    expect(res.status).toBe(403);
    expect(await unreadCount(h.db, "u1")).toBe(0);
  });

  it("POST /release: invalid body -> 400 NOTIF_VALIDATION_FAILED", async () => {
    const h = makeTestEnv({ SVC_IDENTITY: fakeAuthzIdentity(true) });
    const app = createApp({ identity: fakeIdentity({ allUsers: ["u1"] }) });
    const res = await reqOf(app, h)("/release", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dub-user-id": "usr_admin" },
      body: JSON.stringify({ title: "", body: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /internal/seed-releases: without x-dub-internal -> 403", async () => {
    const h = makeTestEnv();
    const app = createApp({ identity: fakeIdentity({ allUsers: ["u1"] }) });
    const res = await reqOf(app, h)("/internal/seed-releases", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("POST /internal/seed-releases: with x-dub-internal -> 202, publishes the catalog", async () => {
    const h = makeTestEnv();
    const app = createApp({ identity: fakeIdentity({ allUsers: ["u1"] }) });
    const res = await reqOf(app, h)("/internal/seed-releases", {
      method: "POST",
      headers: { "x-dub-internal": "1" },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { published: number; total: number };
    expect(body.total).toBe(INITIAL_RELEASE_NOTES.length);
    expect(await unreadCount(h.db, "u1")).toBe(INITIAL_RELEASE_NOTES.length);
  });
});
