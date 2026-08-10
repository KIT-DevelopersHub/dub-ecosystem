// Real-wiring tests for the actual mail-gateway client (src/gateway.ts). Every other
// suite injects a fake MailGatewayClient; this one exercises createMailGatewayClient
// itself against a fake Fetcher (Service Binding stand-in) to verify the on-the-wire
// contract: paths, query, x-dub-* headers, idempotency header, JSON body + parse, and
// upstream-error restoration. mail-gateway is a STUB service until 9-B, but the client
// seam that will call it is real and must be verified without a live upstream.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { mail } from "@dub/types";
import type { RequestContext } from "@dub/http";
import { DubError } from "@dub/errors";
import { createMailGatewayClient } from "../src/gateway";
import type { InboundMail } from "../src/types";

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Fake Service Binding: records each Request and replies with a scripted Response. */
function fakeFetcher(reply: (req: CapturedRequest) => Response): { binding: Fetcher; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const binding = {
    async fetch(req: Request): Promise<Response> {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers,
        body: req.body ? await req.text() : null,
      };
      calls.push(captured);
      return reply(captured);
    },
  } as unknown as Fetcher;
  return { binding, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ctx: RequestContext = { requestId: "req_test_1", userId: "user_actor_1" };

const sampleMessage: InboundMail = {
  id: "gwmsg_1",
  messageId: "<abc@mail.example.com>",
  threadId: "thread_1",
  from: { email: "sender@example.com", name: "Alex" },
  to: [{ email: "cfp@developershub.jp" }],
  subject: "CFP: my talk",
  snippet: "Here is my proposal",
  receivedAt: "2026-08-10T00:00:00.000Z",
  mailbox: "cfp",
};

describe("createMailGatewayClient — getMessage", () => {
  it("issues GET /messages/:id with x-dub-* headers and parses the body", async () => {
    const { binding, calls } = fakeFetcher(() => jsonResponse(sampleMessage));
    const client = createMailGatewayClient(binding);

    const got = await client.getMessage(ctx, "gwmsg_1");

    expect(got).toEqual(sampleMessage);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/messages/gwmsg_1");
    expect(new URL(req.url).searchParams.has("mailbox")).toBe(false);
    // request-context headers stamped by the @dub/http client
    expect(req.headers["x-dub-request-id"]).toBe("req_test_1");
    expect(req.headers["x-dub-caller"]).toBe("mail-automation");
    expect(req.headers["x-dub-internal"]).toBe("1");
    expect(req.headers["x-dub-user-id"]).toBe("user_actor_1");
  });

  it("appends ?mailbox= when a mailbox is supplied", async () => {
    const { binding, calls } = fakeFetcher(() => jsonResponse(sampleMessage));
    const client = createMailGatewayClient(binding);

    await client.getMessage(ctx, "gwmsg_1", "cfp");

    expect(new URL(calls[0]!.url).searchParams.get("mailbox")).toBe("cfp");
  });

  it("url-encodes a message id containing reserved characters", async () => {
    const { binding, calls } = fakeFetcher(() => jsonResponse(sampleMessage));
    const client = createMailGatewayClient(binding);

    await client.getMessage(ctx, "msg/with space");

    // encodeURIComponent -> %2F is not decoded into a path separator
    expect(new URL(calls[0]!.url).pathname).toBe("/messages/msg%2Fwith%20space");
  });

  it("restores an upstream business error (code passthrough, not a generic 502)", async () => {
    const errBody = {
      error: {
        code: "MAILGW_MESSAGE_NOT_FOUND",
        message: "no such message",
        details: null,
        requestId: "req_test_1",
        service: "mail-gateway",
        retryable: false,
      },
    };
    const { binding } = fakeFetcher(() => jsonResponse(errBody, 404));
    const client = createMailGatewayClient(binding);

    await expect(client.getMessage(ctx, "missing")).rejects.toMatchObject({ code: "MAILGW_MESSAGE_NOT_FOUND" });
  });
});

describe("createMailGatewayClient — send", () => {
  const sendReq: mail.SendMailRequest = {
    to: [{ email: "sender@example.com", name: "Alex" }],
    subject: "Re: CFP: my talk",
    textBody: "Hi Alex, thanks!",
    inReplyTo: "<abc@mail.example.com>",
    loopHeaders: { "auto-submitted": "auto-replied", "x-dub-mail-loop": "mailauto_dec_1" },
  };
  const sendRes: mail.SendMailResponse = {
    messageId: "sent_1",
    provider: "ses",
    acceptedAt: "2026-08-10T00:00:01.000Z",
  };

  it("issues POST /send with idempotency header, mailbox query, and JSON body", async () => {
    const { binding, calls } = fakeFetcher(() => jsonResponse(sendRes));
    const client = createMailGatewayClient(binding);

    const res = await client.send(ctx, sendReq, { idempotencyKey: "mailauto:mailauto_dec_1", mailbox: "cfp" });

    expect(res).toEqual(sendRes);
    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(new URL(req.url).pathname).toBe("/send");
    expect(new URL(req.url).searchParams.get("mailbox")).toBe("cfp");
    expect(req.headers["x-dub-idempotency-key"]).toBe("mailauto:mailauto_dec_1");
    expect(req.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(req.body!)).toEqual(sendReq);
  });

  it("omits the mailbox query when no mailbox is given", async () => {
    const { binding, calls } = fakeFetcher(() => jsonResponse(sendRes));
    const client = createMailGatewayClient(binding);

    await client.send(ctx, sendReq, { idempotencyKey: "mailauto:mailauto_dec_2" });

    expect(new URL(calls[0]!.url).searchParams.has("mailbox")).toBe(false);
    expect(calls[0]!.headers["x-dub-idempotency-key"]).toBe("mailauto:mailauto_dec_2");
  });

  it("propagates an upstream send failure as a DubError", async () => {
    const errBody = {
      error: {
        code: "MAILGW_PROVIDER_REJECTED",
        message: "provider rejected",
        details: null,
        requestId: "req_test_1",
        service: "mail-gateway",
        retryable: false,
      },
    };
    const { binding } = fakeFetcher(() => jsonResponse(errBody, 400));
    const client = createMailGatewayClient(binding);

    await expect(
      client.send(ctx, sendReq, { idempotencyKey: "mailauto:mailauto_dec_3" }),
    ).rejects.toBeInstanceOf(DubError);
  });
});
