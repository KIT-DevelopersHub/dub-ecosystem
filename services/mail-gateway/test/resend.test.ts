import { describe, it, expect, vi } from "vitest";
import { DubError } from "@dub/errors";
import { ResendMailProvider, resendConfigFromEnv } from "../src/resend";
import { buildProvider } from "../src/provider";
import type { OutboundMail } from "../src/provider";
import type { Env } from "../src/env";

const MIME = ["From: info@developershub.jp", "To: alice@example.com", "Subject: Hello", "", "Body", ""].join("\r\n");

function outbound(over: Partial<OutboundMail> = {}): OutboundMail {
  return {
    from: "info@developershub.jp",
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

function okFetch(id = "resend-msg-1") {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id }), { status: 200 }));
}

describe("ResendMailProvider — request shape", () => {
  it("POSTs to the Resend API with a Bearer key and returns the id", async () => {
    const fetchImpl = okFetch();
    const provider = new ResendMailProvider({ apiKey: "re-key", fetchImpl });
    const { providerMessageId } = await provider.send(outbound());

    expect(providerMessageId).toBe("resend-msg-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init!.method).toBe("POST");
    const headers = init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer re-key");

    const payload = JSON.parse(init!.body as string) as {
      from: string;
      to: string[];
      cc?: string[];
      subject: string;
      text: string;
      html?: string;
      headers?: Record<string, string>;
    };
    expect(payload.from).toBe("info@developershub.jp");
    expect(payload.to).toEqual(["Alice <alice@example.com>"]); // "Name <email>" form
    expect(payload.cc).toBeUndefined();
    expect(payload.subject).toBe("Hello");
    expect(payload.text).toBe("Body — 日本語も含む");
    expect(payload.html).toBeUndefined();
    expect(payload.headers).toBeUndefined();
  });

  it("includes cc, html, and threading headers when present", async () => {
    const fetchImpl = okFetch();
    const provider = new ResendMailProvider({ apiKey: "re-key", fetchImpl });
    await provider.send(
      outbound({ cc: [{ email: "bob@example.com" }], htmlBody: "<p>hi</p>", inReplyTo: "orig@example.com" }),
    );
    const payload = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(payload.cc).toEqual(["bob@example.com"]); // bare email when no name
    expect(payload.html).toBe("<p>hi</p>");
    expect(payload.headers["In-Reply-To"]).toBe("<orig@example.com>");
    expect(payload.headers.References).toBe("<orig@example.com>");
  });
});

describe("ResendMailProvider — failure handling (safe side)", () => {
  it("throws MAIL_PROVIDER_UNAVAILABLE 502 with detail on a non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ name: "validation_error", message: "from is not a verified domain" }), {
          status: 422,
        }),
    );
    const provider = new ResendMailProvider({ apiKey: "k", fetchImpl });
    await expect(provider.send(outbound())).rejects.toMatchObject({
      code: "MAIL_PROVIDER_UNAVAILABLE",
      status: 502,
    });
    await expect(provider.send(outbound())).rejects.toThrow(/verified domain/);
  });

  it("throws MAIL_PROVIDER_UNAVAILABLE 502 on a network/transport error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const provider = new ResendMailProvider({ apiKey: "k", fetchImpl });
    await expect(provider.send(outbound())).rejects.toBeInstanceOf(DubError);
    await expect(provider.send(outbound())).rejects.toMatchObject({ status: 502 });
  });

  it("throws when Resend returns 2xx but no id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const provider = new ResendMailProvider({ apiKey: "k", fetchImpl });
    await expect(provider.send(outbound())).rejects.toMatchObject({
      code: "MAIL_PROVIDER_UNAVAILABLE",
      status: 502,
    });
  });
});

describe("resendConfigFromEnv + buildProvider selection", () => {
  const baseEnv = { MAIL_OUTBOUND_PROVIDER: "resend" } as unknown as Env;

  it("returns null when the API key is absent", () => {
    expect(resendConfigFromEnv(baseEnv)).toBeNull();
  });

  it("buildProvider('resend') returns a real client when the key is present", () => {
    const env = { ...baseEnv, RESEND_API_KEY: "re-key" } as unknown as Env;
    expect(buildProvider(env)).toBeInstanceOf(ResendMailProvider);
  });

  it("buildProvider('resend') without a key returns a loud stub that throws on send", async () => {
    const provider = buildProvider(baseEnv);
    expect(provider).not.toBeInstanceOf(ResendMailProvider);
    expect(provider.name).toBe("resend");
    await expect(provider.send(outbound())).rejects.toMatchObject({ code: "MAIL_PROVIDER_UNAVAILABLE" });
  });
});
