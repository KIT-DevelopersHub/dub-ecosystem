// mail-gateway dependency (STUB-friendly interface). All send/receive lives in
// mail-gateway; this service only decides. Real client uses a Service Binding via
// @dub/http; the integration wave (post-9-B) wires the actual binding + endpoints.
import type { Fetcher } from "@cloudflare/workers-types";
import type { mail } from "@dub/types";
import { createServiceClient, type RequestContext } from "@dub/http";
import type { InboundMail } from "./types";

export interface GatewaySendOptions {
  idempotencyKey: string;
  mailbox?: string;
}

export interface MailGatewayClient {
  /** GET /messages/:id?mailbox= — full message (design: mail-automation holds no body). */
  getMessage(ctx: RequestContext, id: string, mailbox?: string): Promise<InboundMail>;
  /** POST /send — internal-only; idempotencyKey + mailbox required by contract. */
  send(ctx: RequestContext, req: mail.SendMailRequest, opts: GatewaySendOptions): Promise<mail.SendMailResponse>;
}

/**
 * Real client backed by the SVC_MAIL_GATEWAY Service Binding. The wire contract
 * (paths, query, x-dub-* + idempotency headers, JSON body/parse, upstream-error
 * restoration) is verified against a fake Fetcher in test/gateway.test.ts; the live
 * mail-gateway service stays a STUB until 9-B, where pipeline tests inject a fake
 * MailGatewayClient instead of this binding-backed one.
 */
export function createMailGatewayClient(binding: Fetcher): MailGatewayClient {
  const client = createServiceClient(binding, { service: "mail-gateway", caller: "mail-automation" });
  return {
    getMessage(ctx, id, mailbox) {
      return client.get<InboundMail>(ctx, `/messages/${encodeURIComponent(id)}`, mailbox ? { query: { mailbox } } : undefined);
    },
    send(ctx, req, opts) {
      return client.post<mail.SendMailResponse, mail.SendMailRequest>(ctx, "/send", req, {
        idempotencyKey: opts.idempotencyKey,
        ...(opts.mailbox ? { query: { mailbox: opts.mailbox } } : {}),
      });
    },
  };
}
