import { describe, it, expect, vi } from "vitest";
import { DubError } from "@dub/errors";
import { SesMailProvider, sesConfigFromEnv, DEFAULT_SES_REGION } from "../src/ses";
import { buildProvider, MockMailProvider } from "../src/provider";
import type { OutboundMail } from "../src/provider";
import type { Env } from "../src/env";

const MIME = [
  "From: info@developershub.jp",
  "To: alice@example.com",
  "Subject: Hello",
  "Message-Id: <maillog_1@developershub.jp>",
  "In-Reply-To: <orig@example.com>",
  "",
  "Body — 日本語も含む",
  "",
].join("\r\n");

function outbound(over: Partial<OutboundMail> = {}): OutboundMail {
  return {
    from: "info@developershub.jp",
    to: [{ email: "alice@example.com", name: "Alice" }],
    cc: [],
    subject: "Hello",
    textBody: "Body — 日本語も含む",
    htmlBody: null,
    messageId: "maillog_1@developershub.jp",
    inReplyTo: "orig@example.com",
    mime: MIME,
    ...over,
  };
}

const CREDS = { region: "ap-northeast-1", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secretkeyexample" };

function okFetch(messageId = "ses-msg-123") {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ MessageId: messageId }), { status: 200 }));
}

describe("SesMailProvider — request shape + signing", () => {
  it("POSTs a SigV4-signed SES v2 SendEmail with the MIME as base64 Raw content", async () => {
    const fetchImpl = okFetch();
    const provider = new SesMailProvider({ ...CREDS, fetchImpl });
    const { providerMessageId } = await provider.send(outbound());

    expect(providerMessageId).toBe("ses-msg-123");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://email.ap-northeast-1.amazonaws.com/v2/email/outbound-emails");
    expect(init!.method).toBe("POST");

    const headers = init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.authorization).toContain("Credential=AKIAEXAMPLE/");
    expect(headers.authorization).toContain("/ap-northeast-1/ses/aws4_request");
    expect(headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-date");

    const payload = JSON.parse(init!.body as string) as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[]; CcAddresses?: string[] };
      Content: { Raw: { Data: string } };
    };
    expect(payload.FromEmailAddress).toBe("info@developershub.jp");
    expect(payload.Destination.ToAddresses).toEqual(["alice@example.com"]); // envelope = bare email
    expect(payload.Destination.CcAddresses).toBeUndefined();
    // Raw.Data is base64 of the exact MIME (threading + loop headers preserved).
    expect(Buffer.from(payload.Content.Raw.Data, "base64").toString("utf8")).toBe(MIME);
  });

  it("includes CcAddresses only when cc is non-empty", async () => {
    const fetchImpl = okFetch();
    const provider = new SesMailProvider({ ...CREDS, fetchImpl });
    await provider.send(outbound({ cc: [{ email: "bob@example.com" }] }));
    const payload = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(payload.Destination.CcAddresses).toEqual(["bob@example.com"]);
  });
});

describe("SesMailProvider — failure handling (safe side)", () => {
  it("throws MAIL_PROVIDER_UNAVAILABLE 502 with detail on a non-2xx (sandbox rejection)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Email address is not verified", __type: "MessageRejected" }), {
          status: 400,
        }),
    );
    const provider = new SesMailProvider({ ...CREDS, fetchImpl });
    await expect(provider.send(outbound())).rejects.toMatchObject({
      code: "MAIL_PROVIDER_UNAVAILABLE",
      status: 502,
    });
    await expect(provider.send(outbound())).rejects.toThrow(/not verified/);
  });

  it("throws MAIL_PROVIDER_UNAVAILABLE 502 on a network/transport error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const provider = new SesMailProvider({ ...CREDS, fetchImpl });
    await expect(provider.send(outbound())).rejects.toBeInstanceOf(DubError);
    await expect(provider.send(outbound())).rejects.toMatchObject({ status: 502 });
  });

  it("throws when SES returns 2xx but no MessageId", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const provider = new SesMailProvider({ ...CREDS, fetchImpl });
    await expect(provider.send(outbound())).rejects.toMatchObject({
      code: "MAIL_PROVIDER_UNAVAILABLE",
      status: 502,
    });
  });
});

describe("sesConfigFromEnv + buildProvider selection", () => {
  const baseEnv = { MAIL_OUTBOUND_PROVIDER: "ses" } as unknown as Env;

  it("returns null when credentials are absent", () => {
    expect(sesConfigFromEnv(baseEnv)).toBeNull();
  });

  it("defaults the region to ap-northeast-1 when SES_REGION is unset", () => {
    const cfg = sesConfigFromEnv({ ...baseEnv, SES_ACCESS_KEY_ID: "AKIA", SES_SECRET_ACCESS_KEY: "sk" } as Env);
    expect(cfg).not.toBeNull();
    expect(cfg!.region).toBe(DEFAULT_SES_REGION);
  });

  it("buildProvider('ses') returns a real SesMailProvider when creds are present", () => {
    const env = { ...baseEnv, SES_ACCESS_KEY_ID: "AKIA", SES_SECRET_ACCESS_KEY: "sk" } as Env;
    expect(buildProvider(env)).toBeInstanceOf(SesMailProvider);
  });

  it("buildProvider('ses') without creds returns a loud stub that throws on send", async () => {
    const provider = buildProvider(baseEnv);
    expect(provider).not.toBeInstanceOf(SesMailProvider);
    expect(provider.name).toBe("ses");
    await expect(provider.send(outbound())).rejects.toMatchObject({ code: "MAIL_PROVIDER_UNAVAILABLE" });
  });

  it("buildProvider('mock') stays available for local/preview", () => {
    expect(buildProvider({ MAIL_OUTBOUND_PROVIDER: "mock" } as Env)).toBeInstanceOf(MockMailProvider);
  });
});
