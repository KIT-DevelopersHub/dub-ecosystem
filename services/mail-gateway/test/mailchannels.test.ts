import { describe, it, expect, vi } from "vitest";
import { DubError } from "@dub/errors";
import { MailChannelsMailProvider, mailchannelsConfigFromEnv } from "../src/mailchannels";
import { buildProvider } from "../src/provider";
import type { OutboundMail } from "../src/provider";
import type { Env } from "../src/env";

const MIME = ["From: info@developershub.jp", "To: alice@example.com", "Subject: Hello", "", "Body", ""].join("\r\n");

function outbound(over: Partial<OutboundMail> = {}): OutboundMail {
  return {
    from: "DevelopersHub <info@developershub.jp>",
    to: [{ email: "alice@example.com", name: "Alice" }],
    cc: [],
    subject: "Hello",
    textBody: "Body — 日本語も含む",
    htmlBody: null,
    messageId: "maillog_1@developershub.jp",
    inReplyTo: null,
    mime: MIME,
    ...over,
  };
}

function okFetch(payload: unknown = { request_id: "req-1", message_ids: ["mc-msg-1"] }, status = 202) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status }));
}

describe("MailChannelsMailProvider — request shape", () => {
  it("POSTs a structured payload with the API key header and returns the first message id", async () => {
    const fetchImpl = okFetch();
    const provider = new MailChannelsMailProvider({ apiKey: "mc-key", fetchImpl });
    const { providerMessageId } = await provider.send(outbound());

    expect(providerMessageId).toBe("mc-msg-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.mailchannels.net/tx/v1/send");
    expect(init!.method).toBe("POST");
    const headers = init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBe("mc-key");

    const payload = JSON.parse(init!.body as string) as {
      personalizations: Array<{ to: Array<{ email: string; name?: string }>; cc?: unknown }>;
      from: { email: string; name?: string };
      subject: string;
      content: Array<{ type: string; value: string }>;
      headers?: Record<string, string>;
    };
    expect(payload.from).toEqual({ email: "info@developershub.jp", name: "DevelopersHub" });
    expect(payload.personalizations[0]!.to).toEqual([{ email: "alice@example.com", name: "Alice" }]);
    expect(payload.personalizations[0]!.cc).toBeUndefined();
    expect(payload.subject).toBe("Hello");
    expect(payload.content).toEqual([{ type: "text/plain", value: "Body — 日本語も含む" }]);
    // Our minted Message-ID always rides along so replies thread back (parity with SES).
    expect(payload.headers).toEqual({ "Message-ID": "<maillog_1@developershub.jp>" });
  });

  it("stamps our minted Message-ID so replies thread back (parity with SES raw MIME)", async () => {
    const fetchImpl = okFetch();
    const provider = new MailChannelsMailProvider({ apiKey: "mc-key", fetchImpl });
    await provider.send(outbound({ messageId: "maillog_42@developershub.jp" }));
    const payload = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(payload.headers["Message-ID"]).toBe("<maillog_42@developershub.jp>");
  });

  it("includes cc, an html content part, and threading headers when present", async () => {
    const fetchImpl = okFetch();
    const provider = new MailChannelsMailProvider({ apiKey: "mc-key", fetchImpl });
    await provider.send(
      outbound({ cc: [{ email: "bob@example.com" }], htmlBody: "<p>hi</p>", inReplyTo: "orig@example.com" }),
    );
    const payload = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(payload.personalizations[0].cc).toEqual([{ email: "bob@example.com" }]);
    expect(payload.content).toEqual([
      { type: "text/plain", value: "Body — 日本語も含む" },
      { type: "text/html", value: "<p>hi</p>" },
    ]);
    expect(payload.headers["In-Reply-To"]).toBe("<orig@example.com>");
    expect(payload.headers.References).toBe("<orig@example.com>");
    // Message-ID rides alongside the threading headers on a reply too.
    expect(payload.headers["Message-ID"]).toBe("<maillog_1@developershub.jp>");
  });

  it("falls back to request_id then our Message-Id when message_ids is absent", async () => {
    const p1 = new MailChannelsMailProvider({ apiKey: "k", fetchImpl: okFetch({ request_id: "req-9" }) });
    expect((await p1.send(outbound())).providerMessageId).toBe("req-9");
    const p2 = new MailChannelsMailProvider({ apiKey: "k", fetchImpl: okFetch({}) });
    expect((await p2.send(outbound())).providerMessageId).toBe("maillog_1@developershub.jp");
  });
});

describe("MailChannelsMailProvider — failure handling (safe side)", () => {
  it("throws MAIL_PROVIDER_UNAVAILABLE 502 with detail on a non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ errors: ["domain not verified"] }), { status: 401 }),
    );
    const provider = new MailChannelsMailProvider({ apiKey: "k", fetchImpl });
    await expect(provider.send(outbound())).rejects.toMatchObject({
      code: "MAIL_PROVIDER_UNAVAILABLE",
      status: 502,
    });
    await expect(provider.send(outbound())).rejects.toThrow(/domain not verified/);
  });

  it("throws MAIL_PROVIDER_UNAVAILABLE 502 on a network/transport error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const provider = new MailChannelsMailProvider({ apiKey: "k", fetchImpl });
    await expect(provider.send(outbound())).rejects.toBeInstanceOf(DubError);
    await expect(provider.send(outbound())).rejects.toMatchObject({ status: 502 });
  });
});

describe("mailchannelsConfigFromEnv + buildProvider selection", () => {
  const baseEnv = { MAIL_OUTBOUND_PROVIDER: "mailchannels" } as unknown as Env;

  it("returns null when the API key is absent", () => {
    expect(mailchannelsConfigFromEnv(baseEnv)).toBeNull();
  });

  it("buildProvider('mailchannels') returns a real client when the key is present", () => {
    const env = { ...baseEnv, MAILCHANNELS_API_KEY: "mc-key" } as unknown as Env;
    expect(buildProvider(env)).toBeInstanceOf(MailChannelsMailProvider);
  });

  it("buildProvider('mailchannels') without a key returns a loud stub that throws on send", async () => {
    const provider = buildProvider(baseEnv);
    expect(provider).not.toBeInstanceOf(MailChannelsMailProvider);
    expect(provider.name).toBe("mailchannels");
    await expect(provider.send(outbound())).rejects.toMatchObject({ code: "MAIL_PROVIDER_UNAVAILABLE" });
  });
});
