import { describe, it, expect } from "vitest";
import type { gateway } from "@dub/types";
import { createApp } from "../src/app";
import { makeEnv, fakeQueue, execCtx, errOf } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };

const validBody = {
  kind: "sponsor",
  name: "Bob",
  email: "bob@example.com",
  message: "We would like to sponsor.",
  turnstileToken: "tok",
};

function post(body: unknown): Request {
  return new Request("https://x/api/v1/public/inquiries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/public/inquiries", () => {
  it("[case11] turnstile ok -> 200 accepted + publishes public.inquiry.received", async () => {
    const { queue, sent } = fakeQueue();
    const env = makeEnv({ EVT_NOTIFICATION: queue });
    const app = createApp({ ...NO_RL, turnstile: async () => true });

    const res = await app.fetch(post(validBody), env, execCtx);
    expect(res.status).toBe(200);
    expect((await res.json()) as gateway.PublicInquiryResponse).toEqual({ accepted: true });

    expect(sent).toHaveLength(1);
    const evt = sent[0] as { name: string; actorId: string | null; payload: { kind: string; name: string; email: string; message: string } };
    expect(evt.name).toBe("public.inquiry.received");
    expect(evt.actorId).toBeNull();
    expect(evt.payload).toEqual({ kind: "sponsor", name: "Bob", email: "bob@example.com", message: "We would like to sponsor." });
  });

  it("[case11] turnstile fail -> 403 GATEWAY_TURNSTILE_FAILED, no publish", async () => {
    const { queue, sent } = fakeQueue();
    const env = makeEnv({ EVT_NOTIFICATION: queue });
    const app = createApp({ ...NO_RL, turnstile: async () => false });

    const res = await app.fetch(post(validBody), env, execCtx);
    expect(res.status).toBe(403);
    expect((await errOf(res)).code).toBe("GATEWAY_TURNSTILE_FAILED");
    expect(sent).toHaveLength(0);
  });

  it("[case11] invalid input -> 400 VALIDATION_FAILED before turnstile", async () => {
    const { queue, sent } = fakeQueue();
    const env = makeEnv({ EVT_NOTIFICATION: queue });
    let verifierCalled = false;
    const app = createApp({ ...NO_RL, turnstile: async () => { verifierCalled = true; return true; } });

    const res = await app.fetch(post({ kind: "unknown", email: "bad", message: "", turnstileToken: "" }), env, execCtx);
    expect(res.status).toBe(400);
    const err = (await errOf(res));
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(Array.isArray(err.details)).toBe(true);
    expect(verifierCalled).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("is public (no auth) — reachable without a token", async () => {
    const { queue } = fakeQueue();
    const env = makeEnv({ EVT_NOTIFICATION: queue });
    const app = createApp({ ...NO_RL, turnstile: async () => true });
    const res = await app.fetch(post(validBody), env, execCtx);
    expect(res.status).toBe(200);
  });
});
