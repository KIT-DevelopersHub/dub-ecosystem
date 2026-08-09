// Test doubles + builders shared across the mail-automation test suite.
import type { mail } from "@dub/types";
import type { auditLog } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type { GatewaySendOptions, MailGatewayClient } from "../src/gateway";
import type { AuditSink, EventPublisher, RunContext } from "../src/publisher";
import type { EventInfoClient, PipelineDeps } from "../src/pipeline";
import { createInMemoryRepo, type MailAutoRepo } from "../src/repo";
import type { InboundMail } from "../src/types";
import { DubError } from "@dub/errors";

export class Clock {
  constructor(public iso = "2026-08-09T10:00:00.000Z") {}
  now = (): string => this.iso;
  setDay(day: string): void {
    this.iso = `${day}T10:00:00.000Z`;
  }
}

export interface SendCall {
  req: mail.SendMailRequest;
  opts: GatewaySendOptions;
}

export function fakeGateway(opts: { failSend?: boolean; messages?: Record<string, InboundMail> } = {}) {
  const sends: SendCall[] = [];
  const client: MailGatewayClient = {
    async getMessage(_ctx: RequestContext, id: string) {
      const m = opts.messages?.[id];
      if (!m) throw new DubError("UPSTREAM_UNAVAILABLE", `no message ${id}`, { status: 502 });
      return m;
    },
    async send(_ctx, req, sendOpts) {
      sends.push({ req, opts: sendOpts });
      if (opts.failSend) throw new DubError("UPSTREAM_UNAVAILABLE", "gateway down", { status: 502, retryable: true });
      return { messageId: `gwsent_${sends.length}`, provider: "ses", acceptedAt: "2026-08-09T10:00:01.000Z" };
    },
  };
  return { client, sends };
}

export function fakePublisher() {
  const decided: { ruleId: string | null; decision: string }[] = [];
  const routed: { messageId: string }[] = [];
  const publisher: EventPublisher = {
    async decided(payload) {
      decided.push(payload);
    },
    async routed(payload) {
      routed.push(payload);
    },
  };
  return { publisher, decided, routed };
}

export function fakeAudit() {
  const records: auditLog.AuditRecordInput[] = [];
  const audit: AuditSink = {
    async record(input) {
      records.push(input);
    },
  };
  return { audit, records };
}

export function fakeEventClient(titles: Record<string, string>): EventInfoClient {
  return {
    async getEvent(_ctx, id) {
      return id in titles ? { title: titles[id]! } : null;
    },
  };
}

export interface DepsBundle {
  deps: PipelineDeps;
  repo: MailAutoRepo;
  gateway: ReturnType<typeof fakeGateway>;
  publisher: ReturnType<typeof fakePublisher>;
  audit: ReturnType<typeof fakeAudit>;
  clock: Clock;
}

export function makeDeps(over: {
  failSend?: boolean;
  messages?: Record<string, InboundMail>;
  eventTitles?: Record<string, string>;
  selfDomains?: string[];
  selfAddresses?: string[];
} = {}): DepsBundle {
  const clock = new Clock();
  let n = 0;
  const repo = createInMemoryRepo({ now: clock.now, id: (p) => `${p}_${++n}` });
  const gateway = fakeGateway({ ...(over.failSend ? { failSend: true } : {}), ...(over.messages ? { messages: over.messages } : {}) });
  const publisher = fakePublisher();
  const audit = fakeAudit();
  let dec = 0;
  const deps: PipelineDeps = {
    repo,
    gateway: gateway.client,
    publisher: publisher.publisher,
    audit: audit.audit,
    ...(over.eventTitles ? { eventClient: fakeEventClient(over.eventTitles) } : {}),
    now: clock.now,
    mintDecisionId: () => `mailauto_dec_${++dec}`,
    selfDomains: over.selfDomains ?? ["developershub.jp"],
    selfAddresses: over.selfAddresses ?? [],
    orgId: "org_devhub",
  };
  return { deps, repo, gateway, publisher, audit, clock };
}

let mailSeq = 0;
export function inbound(over: Partial<InboundMail> = {}): InboundMail {
  mailSeq++;
  return {
    id: over.id ?? `gwmsg_${mailSeq}`,
    messageId: over.messageId ?? `<msg-${mailSeq}@example.com>`,
    threadId: over.threadId ?? `thread_${mailSeq}`,
    from: over.from ?? { email: "sender@example.com", name: "Sender Example" },
    to: over.to ?? [{ email: "info@developershub.jp" }],
    subject: over.subject ?? "Hello there",
    snippet: over.snippet ?? "some body text",
    receivedAt: over.receivedAt ?? "2026-08-09T09:59:00.000Z",
    ...(over.mailbox !== undefined ? { mailbox: over.mailbox } : {}),
    ...(over.headers !== undefined ? { headers: over.headers } : {}),
    ...(over.references !== undefined ? { references: over.references } : {}),
  };
}
