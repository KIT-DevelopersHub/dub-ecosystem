import { describe, it, expect } from "vitest";
import { createComposeApp, type ComposeEnv } from "../src/compose";
import { ResendMailProvider } from "../src/resend";

const app = createComposeApp();

// A resend-configured env whose fetch is stubbed so no real network call is made.
function envWith(over: Partial<ComposeEnv> = {}): ComposeEnv {
  return {
    COMPOSE_TOKEN: "secret-token",
    MAIL_OUTBOUND_PROVIDER: "resend",
    MAIL_FROM_ADDRESS: "onboarding@resend.dev",
    RESEND_API_KEY: "re_test_key",
    ...over,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://svc/compose/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const goodBody = { to: "a@x.com", subject: "Hi", text: "Body" };

describe("GET /", () => {
  it("serves the compose HTML page", async () => {
    const res = await app.fetch(new Request("https://svc/"), envWith());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("メール送信");
    expect(html).toContain("/compose/send");
  });
});

describe("POST /compose/send auth + guard", () => {
  it("401s without a bearer token", async () => {
    const res = await app.fetch(post(goodBody), envWith());
    expect(res.status).toBe(401);
  });

  it("401s with a wrong token", async () => {
    const res = await app.fetch(post(goodBody, { authorization: "Bearer nope" }), envWith());
    expect(res.status).toBe(401);
  });

  it("500s when COMPOSE_TOKEN is unset (server refuses to be an open relay)", async () => {
    const res = await app.fetch(post(goodBody, { authorization: "Bearer x" }), envWith({ COMPOSE_TOKEN: undefined }));
    expect(res.status).toBe(500);
  });

  it("403s a cross-origin browser POST", async () => {
    const res = await app.fetch(post(goodBody, { authorization: "Bearer secret-token", origin: "https://evil.example" }), envWith());
    expect(res.status).toBe(403);
  });

  it("400s on an invalid recipient", async () => {
    const res = await app.fetch(post({ to: "not-an-email", subject: "s", text: "t" }, { authorization: "Bearer secret-token" }), envWith());
    expect(res.status).toBe(400);
  });

  it("503s when the provider API key is absent", async () => {
    const res = await app.fetch(post(goodBody, { authorization: "Bearer secret-token" }), envWith({ RESEND_API_KEY: undefined }));
    expect(res.status).toBe(503);
  });
});

describe("POST /compose/send delivery", () => {
  it("200s with a provider message id when the provider accepts", async () => {
    // Stub fetch on the real ResendMailProvider path by injecting fetchImpl via env?
    // The app builds the provider from env, so we assert against a directly-built provider
    // to prove the wiring, then exercise the route with a monkeypatched global fetch.
    const provider = new ResendMailProvider({
      apiKey: "re_test",
      fetchImpl: async () => new Response(JSON.stringify({ id: "resend-123" }), { status: 200 }),
    });
    const out = await provider.send({
      from: "onboarding@resend.dev",
      to: [{ email: "a@x.com" }],
      cc: [],
      subject: "Hi",
      textBody: "Body",
      htmlBody: null,
      messageId: "mid@resend.dev",
      inReplyTo: null,
      mime: "",
    });
    expect(out.providerMessageId).toBe("resend-123");

    // Route-level: monkeypatch global fetch so the env-built provider hits our stub.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "resend-xyz" }), { status: 200 })) as typeof fetch;
    try {
      const res = await app.fetch(post(goodBody, { authorization: "Bearer secret-token" }), envWith());
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; id: string; provider: string };
      expect(data.ok).toBe(true);
      expect(data.id).toBe("resend-xyz");
      expect(data.provider).toBe("resend");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
