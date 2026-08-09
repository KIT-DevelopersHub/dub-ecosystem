import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { createApp } from "../src/app";
import { makeEnv, fakeIdentityFetcher } from "./helpers";

const app = createApp();

function headers(over: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-dub-request-id": "req_app", ...over };
}

const sendBody: mail.SendMailRequest = { to: [{ email: "a@x.com" }], subject: "Hi", textBody: "Body" };

describe("POST /send", () => {
  it("403s without x-dub-internal (internal-only)", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/send", { method: "POST", headers: headers(), body: JSON.stringify(sendBody) }), env);
    expect(res.status).toBe(403);
  });

  it("400s without an Idempotency-Key", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/send", { method: "POST", headers: headers({ "x-dub-internal": "1", "x-dub-caller": "notification" }), body: JSON.stringify(sendBody) }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAIL_INVALID_REQUEST");
  });

  it("sends (202) for a system-origin internal call (no user) and records the event", async () => {
    const { env, sends } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/send", {
        method: "POST",
        headers: headers({ "x-dub-internal": "1", "x-dub-caller": "notification", "x-dub-idempotency-key": "k1" }),
        body: JSON.stringify(sendBody),
      }),
      env,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as mail.SendMailResponse;
    expect(body.provider).toBe("ses");
    expect(sends.notif).toHaveLength(1);
    expect(sends.notif[0]!.name).toBe("mail.message.sent");
  });

  it("enforces mail:send when a user is present (403 when denied)", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const res = await app.fetch(
      new Request("https://svc/send", {
        method: "POST",
        headers: headers({ "x-dub-internal": "1", "x-dub-user-id": "usr_bob", "x-dub-caller": "notification", "x-dub-idempotency-key": "k2" }),
        body: JSON.stringify(sendBody),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns 200 on idempotent replay", async () => {
    const { env } = makeEnv();
    const h = headers({ "x-dub-internal": "1", "x-dub-caller": "notification", "x-dub-idempotency-key": "k3" });
    const first = await app.fetch(new Request("https://svc/send", { method: "POST", headers: h, body: JSON.stringify(sendBody) }), env);
    expect(first.status).toBe(202);
    const second = await app.fetch(new Request("https://svc/send", { method: "POST", headers: h, body: JSON.stringify(sendBody) }), env);
    expect(second.status).toBe(200);
  });

  it("400s on an invalid recipient", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/send", {
        method: "POST",
        headers: headers({ "x-dub-internal": "1", "x-dub-caller": "notification", "x-dub-idempotency-key": "k4" }),
        body: JSON.stringify({ to: [{ email: "not-an-email" }], subject: "x", textBody: "y" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("read routes", () => {
  it("401s without a trusted user header", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/messages", { headers: headers() }), env);
    expect(res.status).toBe(401);
  });

  it("lists messages (empty) with mail:read", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/messages", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: null };
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it("403s when mail:read is denied", async () => {
    const { env } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const res = await app.fetch(new Request("https://svc/messages", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(403);
  });

  it("404s for a missing message", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/messages/does-not-exist", { headers: headers({ "x-dub-user-id": "usr_alice" }) }), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAIL_MESSAGE_NOT_FOUND");
  });
});

describe("health", () => {
  it("reports ok", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/internal/health", { headers: headers() }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "mail-gateway" });
  });
});
