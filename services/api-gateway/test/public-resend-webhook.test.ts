import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { makeEnv, fakeBinding, execCtx } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };

describe("POST /api/v1/public/webhooks/resend", () => {
  it("is public and forwards the raw bytes + svix headers to mail-gateway's internal route", async () => {
    const mail = fakeBinding(() => new Response(JSON.stringify({ ok: true, alerted: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = '{"type":"email.bounced",  "data":{"to":["a@developershub.jp"]}}'; // odd spacing must survive
    const res = await createApp(NO_RL).fetch(
      new Request("https://x/api/v1/public/webhooks/resend", {
        method: "POST",
        headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": "1700000000", "svix-signature": "v1,abc", "x-dub-user-id": "spoof", cookie: "dub_session=x" },
        body,
      }),
      makeEnv({ SVC_MAIL_GATEWAY: mail.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alerted: true });
    const fwd = mail.requests[0]!;
    expect(new URL(fwd.url).pathname).toBe("/internal/webhooks/resend");
    expect(fwd.headers.get("x-dub-internal")).toBe("1");
    expect(fwd.headers.get("svix-id")).toBe("msg_1");
    expect(fwd.headers.get("svix-signature")).toBe("v1,abc");
    expect(fwd.headers.get("x-dub-user-id")).toBeNull();
    expect(fwd.headers.get("cookie")).toBeNull();
    expect(await fwd.text()).toBe(body);
  });

  it("passes the downstream status through (401 bad signature, 503 unconfigured)", async () => {
    for (const status of [401, 503]) {
      const mail = fakeBinding(() => new Response(JSON.stringify({ error: "x" }), { status }));
      const res = await createApp(NO_RL).fetch(
        new Request("https://x/api/v1/public/webhooks/resend", { method: "POST", body: "{}" }),
        makeEnv({ SVC_MAIL_GATEWAY: mail.fetcher }),
        execCtx,
      );
      expect(res.status).toBe(status);
    }
  });
});
