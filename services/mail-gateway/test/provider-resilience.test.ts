import { describe, it, expect, vi } from "vitest";
import { ResendMailProvider, resendConfigFromEnv } from "../src/resend";
import { SesMailProvider, sesConfigFromEnv } from "../src/ses";
import { MailChannelsMailProvider, mailchannelsConfigFromEnv } from "../src/mailchannels";
import { retryableStatus } from "../src/provider-error";
import type { OutboundMail } from "../src/provider";
import type { Env } from "../src/env";

const MIME = ["From: info@developershub.jp", "To: a@x.com", "Subject: Hi", "", "Body", ""].join("\r\n");
function outbound(): OutboundMail {
  return {
    from: "info@developershub.jp",
    to: [{ email: "a@x.com" }],
    cc: [],
    subject: "Hi",
    textBody: "Body",
    htmlBody: null,
    messageId: "maillog_1@developershub.jp",
    inReplyTo: null,
    mime: MIME,
  };
}
const status = (code: number, body = "{}") => vi.fn<typeof fetch>(async () => new Response(body, { status: code }));
const boom = () =>
  vi.fn<typeof fetch>(async () => {
    throw new Error("ECONNRESET");
  });

describe("retryableStatus", () => {
  it("429 and 5xx are retryable; 4xx (except 429) and 2xx are not", () => {
    expect(retryableStatus(429)).toBe(true);
    expect(retryableStatus(500)).toBe(true);
    expect(retryableStatus(503)).toBe(true);
    expect(retryableStatus(400)).toBe(false);
    expect(retryableStatus(422)).toBe(false);
    expect(retryableStatus(200)).toBe(false);
  });
});

// Every managed provider must classify transient vs deterministic failures identically so
// the send-core retry loop behaves the same regardless of which ESP is selected.
const providers = [
  { name: "resend", make: (f: typeof fetch) => new ResendMailProvider({ apiKey: "k", fetchImpl: f }) },
  { name: "mailchannels", make: (f: typeof fetch) => new MailChannelsMailProvider({ apiKey: "k", fetchImpl: f }) },
  {
    name: "ses",
    make: (f: typeof fetch) => new SesMailProvider({ region: "ap-northeast-1", accessKeyId: "AKIA", secretAccessKey: "sk", fetchImpl: f }),
  },
] as const;

describe.each(providers)("$name — retryable classification", ({ make }) => {
  it("network/transport error is retryable", async () => {
    await expect(make(boom()).send(outbound())).rejects.toMatchObject({ retryable: true, status: 502 });
  });
  it("429 is retryable", async () => {
    await expect(make(status(429)).send(outbound())).rejects.toMatchObject({ retryable: true });
  });
  it("500 is retryable", async () => {
    await expect(make(status(500)).send(outbound())).rejects.toMatchObject({ retryable: true });
  });
  it("4xx validation error is NOT retryable", async () => {
    await expect(make(status(422, JSON.stringify({ message: "unverified domain" }))).send(outbound())).rejects.toMatchObject({ retryable: false });
  });
});

describe("timeout config plumbing (configFromEnv reads MAIL_SEND_TIMEOUT_MS)", () => {
  const asEnv = (o: Record<string, unknown>): Env => o as unknown as Env;
  it("resend/mailchannels/ses config carry the tuned timeout", () => {
    const env = asEnv({ RESEND_API_KEY: "re", MAILCHANNELS_API_KEY: "mc", SES_ACCESS_KEY_ID: "AKIA", SES_SECRET_ACCESS_KEY: "sk", MAIL_SEND_TIMEOUT_MS: "9000" });
    expect(resendConfigFromEnv(env)?.timeoutMs).toBe(9000);
    expect(mailchannelsConfigFromEnv(env)?.timeoutMs).toBe(9000);
    expect(sesConfigFromEnv(env)?.timeoutMs).toBe(9000);
  });
  it("defaults to 15000 when unset", () => {
    expect(resendConfigFromEnv(asEnv({ RESEND_API_KEY: "re" }))?.timeoutMs).toBe(15000);
  });
});
