import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { credentialsPresent, effectiveTuning, providerReadiness, validateEnv } from "../src/config-check";
import type { Env } from "../src/env";
import { makeEnv } from "./helpers";

const asEnv = (o: Record<string, unknown>): Env => o as unknown as Env;
const intHdr = { "x-dub-internal": "1", "x-dub-request-id": "req_ready" };

describe("credentialsPresent", () => {
  it("mock is always present", () => {
    expect(credentialsPresent(asEnv({}), "mock")).toBe(true);
  });
  it("ses needs both keys", () => {
    expect(credentialsPresent(asEnv({}), "ses")).toBe(false);
    expect(credentialsPresent(asEnv({ SES_ACCESS_KEY_ID: "AKIA", SES_SECRET_ACCESS_KEY: "sk" }), "ses")).toBe(true);
  });
  it("resend / mailchannels need their key", () => {
    expect(credentialsPresent(asEnv({}), "resend")).toBe(false);
    expect(credentialsPresent(asEnv({ RESEND_API_KEY: "re" }), "resend")).toBe(true);
    expect(credentialsPresent(asEnv({ MAILCHANNELS_API_KEY: "mc" }), "mailchannels")).toBe(true);
  });
});

describe("validateEnv", () => {
  it("flags an unknown provider", () => {
    const issues = validateEnv(asEnv({ MAIL_OUTBOUND_PROVIDER: "sendgrid" }));
    expect(issues.some((i) => i.includes("not one of"))).toBe(true);
  });
  it("flags a selected provider missing credentials", () => {
    const issues = validateEnv(asEnv({ MAIL_OUTBOUND_PROVIDER: "resend" }));
    expect(issues.some((i) => i.includes("credentials/secrets are absent"))).toBe(true);
  });
  it("flags an invalid From address", () => {
    const issues = validateEnv(asEnv({ MAIL_OUTBOUND_PROVIDER: "mock", MAIL_FROM_ADDRESS: "not-an-email" }));
    expect(issues.some((i) => i.includes("not a valid email"))).toBe(true);
  });
  it("is clean for a fully-configured resend env", () => {
    expect(validateEnv(asEnv({ MAIL_OUTBOUND_PROVIDER: "resend", RESEND_API_KEY: "re", MAIL_FROM_ADDRESS: "info@developershub.jp" }))).toEqual([]);
  });
  it("never includes a secret value", () => {
    const issues = validateEnv(asEnv({ MAIL_OUTBOUND_PROVIDER: "resend", RESEND_API_KEY: "SECRET-VALUE-123" }));
    expect(issues.join(" ")).not.toContain("SECRET-VALUE-123");
  });
});

describe("providerReadiness", () => {
  it("ready=true for a configured resend env, region omitted", () => {
    const r = providerReadiness(asEnv({ MAIL_OUTBOUND_PROVIDER: "resend", RESEND_API_KEY: "re" }));
    expect(r).toMatchObject({ provider: "resend", known: true, credentialsPresent: true, ready: true, issues: [] });
    expect(r.region).toBeUndefined();
  });
  it("ready=false and lists issues when ses creds are absent, includes region", () => {
    const r = providerReadiness(asEnv({ MAIL_OUTBOUND_PROVIDER: "ses" }));
    expect(r.ready).toBe(false);
    expect(r.credentialsPresent).toBe(false);
    expect(r.region).toBe("ap-northeast-1");
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("effectiveTuning", () => {
  it("defaults and honors overrides within range", () => {
    expect(effectiveTuning(asEnv({}))).toEqual({ maxAttempts: 3, timeoutMs: 15000 });
    expect(effectiveTuning(asEnv({ MAIL_SEND_MAX_ATTEMPTS: "5", MAIL_SEND_TIMEOUT_MS: "8000" }))).toEqual({ maxAttempts: 5, timeoutMs: 8000 });
  });
  it("clamps out-of-range / malformed values back to defaults", () => {
    expect(effectiveTuning(asEnv({ MAIL_SEND_MAX_ATTEMPTS: "99", MAIL_SEND_TIMEOUT_MS: "abc" }))).toEqual({ maxAttempts: 3, timeoutMs: 15000 });
  });
});

describe("GET /internal/health/ready", () => {
  const app = createApp();

  it("403s without x-dub-internal", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/internal/health/ready", { headers: { "x-dub-request-id": "r" } }), env);
    expect(res.status).toBe(403);
  });

  it("200 + ready:true for the mock provider (default test env)", async () => {
    const { env } = makeEnv(); // MAIL_OUTBOUND_PROVIDER = "mock"
    const res = await app.fetch(new Request("https://svc/internal/health/ready", { headers: intHdr }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; provider: string; tuning: unknown };
    expect(body.ready).toBe(true);
    expect(body.provider).toBe("mock");
    expect(body.tuning).toEqual({ maxAttempts: 3, timeoutMs: 15000 });
  });

  it("503 when the selected provider is unconfigured", async () => {
    const { env } = makeEnv({ MAIL_OUTBOUND_PROVIDER: "ses" });
    const res = await app.fetch(new Request("https://svc/internal/health/ready", { headers: intHdr }), env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; issues: string[] };
    expect(body.ready).toBe(false);
    expect(body.issues.length).toBeGreaterThan(0);
  });
});
