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

  it("accepts the empty-body `sync` handshake POST -> 200 published with payload=null", async () => {
    // When a channel is created, Google sends a mandatory handshake POST with an EMPTY
    // body and x-goog-resource-state: sync; all state is in X-Goog-* headers. This must
    // not 400 on the JSON gate — it publishes with payload=null.
    const h = harness();
    const headers = new Headers({
      "x-goog-channel-id": "chan-9",
      "x-goog-message-number": "1",
      "x-goog-channel-token": DRIVE_TOKEN,
      "x-goog-resource-state": "sync",
    });
    const res = await h.app.fetch(
      new Request("https://hooks/hooks/google-drive", { method: "POST", body: "", headers }),
      h.env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: boolean }).accepted).toBe(true);
    expect(h.q.drive.sent).toHaveLength(1);
    expect(h.q.drive.sent[0]!.eventKind).toBe("sync");
    expect(h.q.drive.sent[0]!.externalId).toBe("chan-9:1");
    expect(h.q.drive.sent[0]!.payload).toBeNull();
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

describe("gmail ingress (enabled in 9-B)", () => {
  it("accepts an authenticated push -> 200 published to the gmail queue", async () => {
    // Drive the app-level path with an injected gmail verifier (the real OIDC verifier is
    // exercised in gmail-verify.test.ts); this proves the 9-B gate is open end-to-end.
    const repo = new FakeRepo();
    const gmailQ = new FakeQueue<WebhookEnvelope>();
    const deps: IngestDeps = {
      repo,
      raw: new FakeR2() as unknown as R2Bucket,
      queues: { WH_GMAIL: gmailQ as unknown as Queue<WebhookEnvelope> } as IngestDeps["queues"],
    };
    const app = createApp({
      buildDeps: () => deps,
      buildRepo: () => repo,
      verifiers: {
        gmail: async () => ({ ok: true, externalId: "msg-42", eventKind: "gmail.push" }),
      },
      requireWebhookRead: async (_c, next) => {
        await next();
      },
    });
    const env: Env = fakeEnv({
      GMAIL_WEBHOOK_AUDIENCE: "https://hooks.developershub.jp/hooks/gmail",
      GMAIL_PUSH_SA_EMAIL: "gmail-push@dub-project.iam.gserviceaccount.com",
    });
    const body = JSON.stringify({ message: { messageId: "msg-42" }, subscription: "s" });
    const res = await app.fetch(
      new Request("https://hooks/hooks/gmail", {
        method: "POST",
        body,
        headers: new Headers({ "content-type": "application/json", authorization: "Bearer x" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: boolean }).accepted).toBe(true);
    expect(gmailQ.sent).toHaveLength(1);
    expect(gmailQ.sent[0]!.source).toBe("gmail");
    expect(gmailQ.sent[0]!.externalId).toBe("msg-42");
  });
});

describe("GET /hooks/:source handshake", () => {
  it("answers 200 for enabled sources (github, google-drive, gmail, stripe)", async () => {
    const h = harness();
    for (const source of ["github", "google-drive", "gmail", "stripe"] as const) {
      const res = await h.app.fetch(new Request(`https://hooks/hooks/${source}`), h.env);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string; source: string }).source).toBe(source);
    }
  });

  it("answers 404 for an unknown source", async () => {
    const h = harness();
    const unknown = await h.app.fetch(new Request("https://hooks/hooks/telegram"), h.env);
    expect(unknown.status).toBe(404);
  });
});
