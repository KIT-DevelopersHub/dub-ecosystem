// Service-internal types — the adapter machinery that the frozen @dub/types mail
// namespace deliberately leaves to the implementation. Public HTTP / event I/O
// ALWAYS uses @dub/types / @dub/events; nothing here is a wire type.
import type { mail } from "@dub/types";
import type { AuditRecordEnvelopeV1, DubEventEnvelope } from "@dub/events";
import type { Queue } from "@cloudflare/workers-types";
import type { DbClient } from "@dub/db";
import type { RequestContext } from "@dub/http";
import type { MailProvider } from "./provider";

// The publish targets publishEvent(env, ...) needs: keyed by the frozen queue binding
// names in @dub/events CONSUMER_QUEUE_BINDINGS. The string index signature keeps it
// assignable to @dub/events DubEventPublisherEnv (Partial<Record<string, Queue>>).
export type EventPublishEnv = Record<string, Queue<DubEventEnvelope>> & {
  EVT_MAIL_AUTOMATION: Queue<DubEventEnvelope>;
  EVT_NOTIFICATION: Queue<DubEventEnvelope>;
};
export interface AuditEnv {
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>;
}

// Everything a single send / inbound operation needs. The app builds this from the
// Worker Env; tests build it with in-memory fakes (design test — implementation交換).
export interface SendDeps {
  db: DbClient;
  provider: MailProvider;
  events: EventPublishEnv;
  audit: AuditEnv;
  orgId: string;
  fromAddress: string;
  ctx: RequestContext;
}

export interface InboundDeps {
  db: DbClient;
  events: EventPublishEnv;
  audit: AuditEnv;
  orgId: string;
  ctx: RequestContext;
}

// Normalized inbound message parsed from a raw RFC822 message (Email Routing).
export interface ParsedInbound {
  message: mail.MailMessage; // frozen DTO (no body field — snippet only)
  loop: mail.MailLoopHeaders; // loop-prevention hints (passthrough; no logic here)
  mailbox: string | null; // destination mailbox id (best-effort local-part)
}
