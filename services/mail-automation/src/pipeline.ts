// The decision pipeline — the heart of mail-automation. Ordered guards
// (kill switch -> duplicate -> loop headers -> self-sender -> thread depth ->
// rule eval -> [reply: rate -> render -> send]). Every finalized decision is
// persisted (idempotency + trail), emits mail.automation.decided, and writes one
// audit summary. mail-gateway is called only to send a reply.
import type { auditLog, mail } from "@dub/types";
import { isDubError } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { MailGatewayClient } from "./gateway";
import type { AuditSink, EventPublisher, RunContext } from "./publisher";
import type { MailAutoRepo } from "./repo";
import type {
  AutomationRule,
  DecisionOutcome,
  DecisionRecord,
  DryRunResponse,
  InboundMail,
  ProcessResponse,
} from "./types";
import { evaluateRules } from "./rules";
import { renderTemplate, type RenderedTemplate } from "./templates";
import { headerLoopReason, selfSenderReason } from "./loop-guard";

export interface EventInfoClient {
  getEvent(ctx: RequestContext, id: string): Promise<{ title: string } | null>;
}

export interface PipelineDeps {
  repo: MailAutoRepo;
  gateway: MailGatewayClient;
  publisher: EventPublisher;
  audit: AuditSink;
  eventClient?: EventInfoClient;
  now: () => string;
  mintDecisionId: () => string;
  selfAddresses: string[];
  selfDomains: string[];
  orgId: string;
}

function reqCtx(run: RunContext): RequestContext {
  return { requestId: run.requestId, ...(run.actorId ? { userId: run.actorId } : {}) };
}

function mailboxOf(mail: InboundMail): string | undefined {
  return mail.mailbox ?? mail.to[0]?.email;
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

async function templateContext(
  deps: PipelineDeps,
  rule: AutomationRule,
  mail: InboundMail,
  run: RunContext,
): Promise<Record<string, string>> {
  const ctx: Record<string, string> = {
    sender_name: mail.from.name ?? localPart(mail.from.email),
    sender_email: mail.from.email,
    subject: mail.subject,
  };
  if (rule.eventId) {
    ctx.event_id = rule.eventId;
    if (deps.eventClient) {
      const ev = await deps.eventClient.getEvent(reqCtx(run), rule.eventId);
      if (ev) ctx.event_name = ev.title;
    }
  }
  return ctx;
}

interface Verdict {
  outcome: DecisionOutcome;
  matchedRule: AutomationRule | null;
  sentMessageId: string | null;
  suppressReasons: string[];
  rendered: RenderedTemplate | null;
}

/**
 * Pure-ish evaluation (no persistence, no event emission). Performs at most one
 * mail-gateway send when `send=true`. Shared by processInbound and (with send=false)
 * dry-run.
 */
async function evaluate(
  deps: PipelineDeps,
  mail: InboundMail,
  decisionId: string,
  run: RunContext,
  send: boolean,
): Promise<Verdict> {
  const settings = await deps.repo.getSettings();

  // 1. global kill switch
  if (!settings.automationEnabled) {
    return { outcome: "suppressed_disabled", matchedRule: null, sentMessageId: null, suppressReasons: ["automation_disabled"], rendered: null };
  }

  // 3. loop-prevention headers (RFC 3834 + bulk markers)
  const headerReason = headerLoopReason(mail);
  if (headerReason) {
    return { outcome: "suppressed_loop", matchedRule: null, sentMessageId: null, suppressReasons: [headerReason], rendered: null };
  }

  // 4. self-sender (reply to our own auto-reply)
  const selfReason = selfSenderReason(mail, deps.selfAddresses, deps.selfDomains);
  if (selfReason) {
    return { outcome: "suppressed_loop", matchedRule: null, sentMessageId: null, suppressReasons: [selfReason], rendered: null };
  }

  // 5. thread round-trip depth
  const threadCount = await deps.repo.getThreadAutoReplyCount(mail.threadId);
  if (threadCount >= settings.maxRepliesPerThread) {
    return { outcome: "suppressed_loop", matchedRule: null, sentMessageId: null, suppressReasons: ["thread_max_replies"], rendered: null };
  }

  // 6. rule evaluation (priority asc, first match). May throw MAILAUTO_INVALID_RULE.
  const rules = await deps.repo.listRules({ enabled: true });
  const matched = evaluateRules(rules, mail);
  if (!matched) {
    return { outcome: "ignored_no_match", matchedRule: null, sentMessageId: null, suppressReasons: [], rendered: null };
  }

  const action = matched.action;
  if (action.type === "route" || action.type === "label" || action.type === "ignore") {
    const outcome: DecisionOutcome = action.type === "route" ? "routed" : action.type === "label" ? "labeled" : "ignored_no_match";
    return { outcome, matchedRule: matched, sentMessageId: null, suppressReasons: [], rendered: null };
  }

  // --- reply path ---
  // 7. per-recipient daily rate (rule cap vs global default, smaller wins; a cap of
  //    0 is disabled-equivalent per types.ts — used >= 0 always suppresses, never replies)
  const recipient = mail.from.email;
  const day = deps.now().slice(0, 10);
  const cap =
    matched.rateLimitPerRecipientPerDay === 0
      ? 0
      : Math.min(matched.rateLimitPerRecipientPerDay, settings.defaultRatePerRecipientPerDay);
  const used = await deps.repo.getRateCount(recipient, day);
  if (used >= cap) {
    return { outcome: "suppressed_rate", matchedRule: matched, sentMessageId: null, suppressReasons: ["rate_limited"], rendered: null };
  }

  // template load + render (missing template / unresolved var => error, no send)
  const template = await deps.repo.getTemplate(action.templateId);
  if (!template) {
    return { outcome: "error", matchedRule: matched, sentMessageId: null, suppressReasons: ["missing_template"], rendered: null };
  }
  let rendered: RenderedTemplate;
  try {
    rendered = renderTemplate(template, await templateContext(deps, matched, mail, run));
  } catch (err) {
    const reason = isDubError(err) ? err.code : "template_render_failed";
    return { outcome: "error", matchedRule: matched, sentMessageId: null, suppressReasons: [reason], rendered: null };
  }

  if (!send) {
    return { outcome: "replied", matchedRule: matched, sentMessageId: null, suppressReasons: [], rendered };
  }

  // send via mail-gateway (idempotent; loop headers stamped)
  const sendReq: mail.SendMailRequest = {
    to: [mail.from],
    subject: rendered.subject,
    textBody: rendered.body,
    inReplyTo: mail.messageId,
    loopHeaders: { "auto-submitted": "auto-replied", "x-dub-mail-loop": decisionId },
  };
  try {
    const res = await deps.gateway.send(reqCtx(run), sendReq, {
      idempotencyKey: `mailauto:${decisionId}`,
      ...(mailboxOf(mail) ? { mailbox: mailboxOf(mail)! } : {}),
    });
    await deps.repo.incrementRateCount(recipient, day);
    await deps.repo.incrementThreadAutoReply(mail.threadId, deps.now());
    return { outcome: "replied", matchedRule: matched, sentMessageId: res.messageId, suppressReasons: [], rendered };
  } catch (err) {
    const reason = isDubError(err) ? err.code : "gateway_error";
    return { outcome: "error", matchedRule: matched, sentMessageId: null, suppressReasons: [reason], rendered };
  }
}

export interface ProcessOptions {
  force?: boolean;
}

/** Full pipeline with persistence + event emission + audit. */
export async function processInbound(
  deps: PipelineDeps,
  mail: InboundMail,
  opts: ProcessOptions,
  run: RunContext,
): Promise<ProcessResponse> {
  // 2. business idempotency (same gateway messageId already decided) — unless force
  const existing = await deps.repo.findDecisionByGatewayMessageId(mail.id);
  if (existing && !opts.force) {
    return { decisionId: existing.id, outcome: "suppressed_duplicate", matchedRuleId: null, sentMessageId: null };
  }

  const decisionId = deps.mintDecisionId();
  const verdict = await evaluate(deps, mail, decisionId, run, true);
  const decidedAt = deps.now();

  const record: DecisionRecord = {
    id: decisionId,
    gatewayMessageId: mail.id,
    threadId: mail.threadId,
    fromAddr: mail.from.email,
    outcome: verdict.outcome,
    matchedRuleId: verdict.matchedRule?.id ?? null,
    sentMessageId: verdict.sentMessageId,
    suppressReasons: verdict.suppressReasons,
    decidedAt,
  };
  await deps.repo.upsertDecision(record);

  // emit the fact (every outcome, incl. suppressed/error) -> notification lane A
  await deps.publisher.decided({ ruleId: record.matchedRuleId, decision: record.outcome }, run);
  if (verdict.outcome === "routed") {
    await deps.publisher.routed({ messageId: mail.id }, run);
  }

  // one audit summary per decision (no body/subject)
  const auditInput: auditLog.AuditRecordInput = {
    action: "mail.automation.decide",
    actorId: run.actorId,
    orgId: deps.orgId,
    result: verdict.outcome === "error" ? "failure" : "success",
    resourceType: "mail_message",
    resourceId: mail.id,
    details: {
      outcome: record.outcome,
      matchedRuleId: record.matchedRuleId,
      suppressReasons: record.suppressReasons,
      ...(verdict.matchedRule?.action.type === "route" ? { assigneeUserId: verdict.matchedRule.action.assigneeUserId } : {}),
    },
    requestId: run.requestId,
    occurredAt: decidedAt,
  };
  await deps.audit.record(auditInput);

  return {
    decisionId,
    outcome: verdict.outcome,
    matchedRuleId: record.matchedRuleId,
    sentMessageId: record.sentMessageId,
  };
}

/** Dry-run: evaluate without persistence, event emission, audit, or send. */
export async function dryRun(deps: PipelineDeps, mail: InboundMail, run: RunContext): Promise<DryRunResponse> {
  const verdict = await evaluate(deps, mail, "dryrun", run, false);
  return {
    wouldMatch: verdict.matchedRule,
    wouldOutcome: verdict.outcome,
    renderedReply: verdict.rendered,
    suppressReasons: verdict.suppressReasons,
  };
}
