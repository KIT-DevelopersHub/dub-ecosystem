import { describe, it, expect, beforeEach } from "vitest";
import type { R2Bucket, Queue } from "@cloudflare/workers-types";
import { createApp } from "../src/app";
import type { IngestDeps } from "../src/ingest";
import type { Env, WebhookEnvelope } from "../src/env";
import { FakeRepo, FakeQueue, FakeR2, signGithub, fakeEnv } from "./helpers";

const SECRET = "app-secret";

function harness() {
  const repo = new FakeRepo();
  const queue = new FakeQueue<WebhookEnvelope>();
  const r2 = new FakeR2();
  const deps: IngestDeps = {
    repo,
    raw: r2 as unknown as R2Bucket,
    queues: { WH_GITHUB: queue as unknown as Queue<WebhookEnvelope> },
  };
  const app = createApp({
    buildDeps: () => deps,
    buildRepo: () => repo,
    // bypass identity for admin routes in tests
    requireWebhookRead: async (_c, next) => {
      await next();
    },
  });
  const env: Env = fakeEnv({ GITHUB_WEBHOOK_SECRET: SECRET });
  return { app, env, repo, queue, r2 };
}

async function postGithub(app: ReturnType<typeof harness>["app"], env: Env, body: string, headers: Headers) {
  return app.fetch(new Request("https://hooks.developershub.jp/hooks/github", { method: "POST", body, headers }), env);
}

describe("POST /hooks/github", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("accepts a valid signed push -> 200 published, 1 queue msg, 1 row (test #1)", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await postGithub(h.app, h.env, body, await signGithub(body, SECRET));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: boolean; deliveryId: string };
    expect(json.accepted).toBe(true);
    expect(json.deliveryId).toMatch(/^wh_/);
    expect(h.queue.sent).toHaveLength(1);
    expect(h.repo.rows.size).toBe(1);
  });

  it("rejects a bad signature -> 401, 0 publish, 0 rows (test #2)", async () => {
    const body = JSON.stringify({ ref: "x" });
    const res = await postGithub(h.app, h.env, body, await signGithub(body, SECRET, { badSig: true }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("UNAUTHENTICATED");
    expect(json.error.message).not.toContain("mismatch"); // reason not leaked
    expect(h.queue.sent).toHaveLength(0);
    expect(h.repo.rows.size).toBe(0);
  });

  it("dedups a repeated delivery -> 2nd is 200 accepted:false, publish total 1 (test #3)", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const sign = await signGithub(body, SECRET, { delivery: "dup-1" });
    const r1 = await postGithub(h.app, h.env, body, sign);
    const r2 = await postGithub(h.app, h.env, body, await signGithub(body, SECRET, { delivery: "dup-1" }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(((await r1.json()) as { accepted: boolean }).accepted).toBe(true);
    expect(((await r2.json()) as { accepted: boolean }).accepted).toBe(false);
    expect(h.queue.sent).toHaveLength(1);
  });

  it("returns 400 on invalid JSON with a valid signature (test #8)", async () => {
    const body = "{not json";
    const res = await postGithub(h.app, h.env, body, await signGithub(body, SECRET));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    expect(h.queue.sent).toHaveLength(0);
  });

  it("returns 404 for an unknown source (test #9)", async () => {
    const res = await h.app.fetch(new Request("https://hooks/hooks/telegram", { method: "POST", body: "{}" }), h.env);
    expect(res.status).toBe(404);
  });

  it("gmail is enabled (9-B): unauthenticated push -> 401, not 404, nothing published", async () => {
    // The gate is open, so gmail no longer 404s; the OIDC verifier rejects a bearer-less
    // request (and, here, an env with no gmail audience/SA) => 401 before any publish.
    const res = await h.app.fetch(new Request("https://hooks/hooks/gmail", { method: "POST", body: "{}" }), h.env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
    expect(h.queue.sent).toHaveLength(0);
  });

  it("returns 413 for a body over 1MB", async () => {
    const body = "x".repeat(1024 * 1024 + 10);
    const res = await postGithub(h.app, h.env, body, await signGithub(body, SECRET));
    expect(res.status).toBe(413);
  });
});

describe("GET /internal/health", () => {
  it("returns ok", async () => {
    const h = harness();
    const res = await h.app.fetch(new Request("https://hooks/internal/health"), h.env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });
});

describe("GET /api/v1/webhooks/deliveries (admin query, test #11)", () => {
  it("paginates newest-first with a coherent nextCursor and filters by source", async () => {
    const h = harness();
    // seed 3 rows with monotonically increasing ids (newest last)
    for (const [id, ext] of [["wh_a", "a"], ["wh_b", "b"], ["wh_c", "c"]] as const) {
      await h.repo.insertIfNew({
        id, source: "github", externalId: ext, eventKind: "push", status: "received",
        queue: "dub-q-wh-github", r2Key: null, bodySize: 1, receivedAt: "2026-08-09T00:00:00Z",
        processedAt: null, requestId: "r",
      });
    }
    const p1 = await h.app.fetch(new Request("https://hooks/api/v1/webhooks/deliveries?limit=2&source=github"), h.env);
    const page1 = (await p1.json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(page1.items.map((i) => i.id)).toEqual(["wh_c", "wh_b"]); // DESC
    expect(page1.nextCursor).not.toBeNull();

    const p2 = await h.app.fetch(
      new Request(`https://hooks/api/v1/webhooks/deliveries?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`),
      h.env,
    );
    const page2 = (await p2.json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(page2.items.map((i) => i.id)).toEqual(["wh_a"]);
    expect(page2.nextCursor).toBeNull(); // end of results
  });

  it("returns a single delivery and 404 for a missing id", async () => {
    const h = harness();
    await h.repo.insertIfNew({
      id: "wh_one", source: "github", externalId: "e", eventKind: "push", status: "received",
      queue: "dub-q-wh-github", r2Key: null, bodySize: 1, receivedAt: "2026-08-09T00:00:00Z",
      processedAt: null, requestId: "r",
    });
    const ok = await h.app.fetch(new Request("https://hooks/api/v1/webhooks/deliveries/wh_one"), h.env);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string }).id).toBe("wh_one");
    const miss = await h.app.fetch(new Request("https://hooks/api/v1/webhooks/deliveries/wh_missing"), h.env);
    expect(miss.status).toBe(404);
  });

  it("enforces webhook:read (403 when the authz chain denies)", async () => {
    const repo = new FakeRepo();
    const app = createApp({
      buildRepo: () => repo,
      requireWebhookRead: async () => {
        // simulate identity denial
        const { DubError } = await import("@dub/errors");
        throw new DubError("FORBIDDEN", "permission denied: webhook:read", { status: 403 });
      },
    });
    const res = await app.fetch(new Request("https://hooks/api/v1/webhooks/deliveries"), fakeEnv());
    expect(res.status).toBe(403);
  });
});
