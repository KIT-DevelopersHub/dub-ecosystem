// Newly-enabled sources (google-drive, stripe) ingest end-to-end via the app, and the
// GET /hooks/:source reachability handshake answers 200 for enabled sources only.
import { describe, it, expect } from "vitest";
import type { R2Bucket, Queue } from "@cloudflare/workers-types";
import { createApp } from "../src/app";
import type { IngestDeps } from "../src/ingest";
import type { Env, WebhookEnvelope } from "../src/env";
import { hmacSha256Hex } from "../src/crypto";
import { FakeRepo, FakeQueue, FakeR2, fakeEnv } from "./helpers";

const DRIVE_TOKEN = "drive-token-1";
const STRIPE_SECRET = "whsec_test";

function harness() {
  const repo = new FakeRepo();
  const q = {
    github: new FakeQueue<WebhookEnvelope>(),
    drive: new FakeQueue<WebhookEnvelope>(),
    stripe: new FakeQueue<WebhookEnvelope>(),
  };
  const deps: IngestDeps = {
    repo,
    raw: new FakeR2() as unknown as R2Bucket,
    queues: {
      WH_GITHUB: q.github as unknown as Queue<WebhookEnvelope>,
      WH_GOOGLE_DRIVE: q.drive as unknown as Queue<WebhookEnvelope>,
      WH_STRIPE: q.stripe as unknown as Queue<WebhookEnvelope>,
    },
  };
  const app = createApp({
    buildDeps: () => deps,
    buildRepo: () => repo,
    requireWebhookRead: async (_c, next) => {
      await next();
    },
  });
  const env: Env = fakeEnv({
    DRIVE_WEBHOOK_TOKEN: DRIVE_TOKEN,
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
  });
  return { app, env, repo, q };
}

describe("google-drive ingress (enabled)", () => {
  it("accepts a valid channel notification -> 200 published to the drive queue", async () => {
    const h = harness();
    const headers = new Headers({
      "content-type": "application/json",
      "x-goog-channel-id": "chan-1",
      "x-goog-message-number": "7",
      "x-goog-channel-token": DRIVE_TOKEN,
      "x-goog-resource-state": "update",
    });
    const res = await h.app.fetch(
      new Request("https://hooks/hooks/google-drive", { method: "POST", body: "{}", headers }),
      h.env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: boolean }).accepted).toBe(true);
    expect(h.q.drive.sent).toHaveLength(1);
    expect(h.q.drive.sent[0]!.source).toBe("google-drive");
    expect(h.q.drive.sent[0]!.externalId).toBe("chan-1:7");
  });

  it("rejects a bad channel token -> 401, nothing published", async () => {
    const h = harness();
    const headers = new Headers({
      "content-type": "application/json",
      "x-goog-channel-id": "chan-1",
      "x-goog-message-number": "7",
      "x-goog-channel-token": "wrong",
      "x-goog-resource-state": "update",
    });
    const res = await h.app.fetch(
      new Request("https://hooks/hooks/google-drive", { method: "POST", body: "{}", headers }),
      h.env,
    );
    expect(res.status).toBe(401);
    expect(h.q.drive.sent).toHaveLength(0);
  });
});

describe("stripe ingress (enabled)", () => {
  it("accepts a fresh signed event -> 200 published to the stripe queue", async () => {
    const h = harness();
    const body = JSON.stringify({ id: "evt_123", type: "payment_intent.succeeded" });
    const t = Math.floor(Date.now() / 1000);
    const v1 = await hmacSha256Hex(STRIPE_SECRET, `${t}.${body}`);
    const headers = new Headers({ "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` });
    const res = await h.app.fetch(
      new Request("https://hooks/hooks/stripe", { method: "POST", body, headers }),
      h.env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: boolean }).accepted).toBe(true);
    expect(h.q.stripe.sent).toHaveLength(1);
    expect(h.q.stripe.sent[0]!.externalId).toBe("evt_123");
  });

  it("rejects a forged signature -> 401, nothing published", async () => {
    const h = harness();
    const body = JSON.stringify({ id: "evt_x", type: "charge.failed" });
    const t = Math.floor(Date.now() / 1000);
    const headers = new Headers({
      "content-type": "application/json",
      "stripe-signature": `t=${t},v1=${"0".repeat(64)}`,
    });
    const res = await h.app.fetch(
      new Request("https://hooks/hooks/stripe", { method: "POST", body, headers }),
      h.env,
    );
    expect(res.status).toBe(401);
    expect(h.q.stripe.sent).toHaveLength(0);
  });
});

describe("GET /hooks/:source handshake", () => {
  it("answers 200 for enabled sources (google-drive, stripe, github)", async () => {
    const h = harness();
    for (const source of ["github", "google-drive", "stripe"] as const) {
      const res = await h.app.fetch(new Request(`https://hooks/hooks/${source}`), h.env);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string; source: string }).source).toBe(source);
    }
  });

  it("answers 404 for a disabled known source (gmail) and an unknown source", async () => {
    const h = harness();
    const gmail = await h.app.fetch(new Request("https://hooks/hooks/gmail"), h.env);
    expect(gmail.status).toBe(404);
    const unknown = await h.app.fetch(new Request("https://hooks/hooks/telegram"), h.env);
    expect(unknown.status).toBe(404);
  });
});
