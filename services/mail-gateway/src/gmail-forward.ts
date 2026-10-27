// Gmail safety-net forward: after an inbound message is ingested, also hand a copy to the
// envelope recipient's 名簿 Gmail (member_people.gmail, linked via identity_user_id) so a
// Dub-side failure can never be the only copy. Guarded by MAIL_GMAIL_FORWARD=on (default
// OFF: merging/deploying this alone forwards nothing).
//
// Scope = the ENVELOPE recipient only. Email Routing invokes email() once per envelope
// recipient, so a mail To/CC'd to two Dub users arrives twice, and each invocation forwards
// to its own recipient's Gmail exactly once. Header To/CC are never used: that would
// double-forward and could leak a BCC.
//
// Cloudflare constraint: message.forward() only reaches destinations VERIFIED in Email
// Routing (Account > Email Routing > Destination addresses). An unverified Gmail makes
// forward() reject; that is caught and recorded as `failed`, never thrown.
import type { Fetcher } from "@cloudflare/workers-types";
import { publishAudit } from "@dub/events";
import { nowIso } from "@dub/db";
import { createServiceClient, type RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import { SERVICE_NAME } from "./config";
import { parseAddress, type RawInbound } from "./mime";
import { lookupRosterUserId } from "./owner";
import type { AuditEnv } from "./types";

/** Stamped on every forwarded copy; a message already carrying it is never re-forwarded. */
export const FORWARDED_HEADER = "X-Dub-Forwarded";

/** The slice of ForwardableEmailMessage we need (keeps the module runtime-agnostic). */
export interface MailForwarder {
  forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

export interface GmailForwardDeps {
  identity?: Fetcher; // address -> roster userId
  member?: Fetcher; // userId -> 名簿 Gmail (member-service /members/internal/google-emails)
  audit: AuditEnv;
  orgId: string;
  ctx: RequestContext;
  archiveAddress?: string | null; // oversight copy: never forwarded
  internalDomain: string; // a target on our own zone would loop back into this Worker
}

export type ForwardOutcome =
  | { status: "forwarded"; userId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; userId: string; reason: string };

export function gmailForwardEnabled(flag: string | undefined): boolean {
  return flag?.trim().toLowerCase() === "on";
}

/** a***@gmail.com — logs / audit never carry a full personal address. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

const lower = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

async function linkedGmail(member: Fetcher | undefined, ctx: RequestContext, userId: string): Promise<string | null> {
  if (!member) return null;
  const client = createServiceClient(member, { service: "member-service", caller: SERVICE_NAME });
  const res = await client.post<{ items?: { userId: string; gmail: string | null }[] }, { userIds: string[] }>(
    ctx,
    "/members/internal/google-emails",
    { userIds: [userId] },
  );
  const gmail = lower(res?.items?.find((it) => it.userId === userId)?.gmail);
  return gmail.includes("@") ? gmail : null;
}

/**
 * Forward `raw` to the envelope recipient's linked Gmail. NEVER throws: every failure is
 * logged + audited and reported as an outcome, so it can't affect ingest.
 */
export async function forwardToLinkedGmail(
  deps: GmailForwardDeps,
  message: MailForwarder,
  raw: RawInbound,
): Promise<ForwardOutcome> {
  let outcome: ForwardOutcome;
  let target: string | null = null;
  try {
    outcome = await decideAndForward(deps, message, raw, (t) => (target = t));
  } catch (err) {
    outcome = { status: "skipped", reason: `lookup_error: ${err instanceof Error ? err.message : String(err)}` };
  }
  record(deps, outcome, target);
  if (outcome.status !== "skipped") await audit(deps, outcome, target);
  return outcome;
}

async function decideAndForward(
  deps: GmailForwardDeps,
  message: MailForwarder,
  raw: RawInbound,
  setTarget: (t: string) => void,
): Promise<ForwardOutcome> {
  // Loop guard 1: a copy we (or another Dub hop) already forwarded.
  if (raw.headers[FORWARDED_HEADER.toLowerCase()] !== undefined) return { status: "skipped", reason: "already_forwarded" };

  const recipient = lower(parseAddress(raw.to).email);
  if (!recipient) return { status: "skipped", reason: "no_recipient" };
  if (recipient === lower(deps.archiveAddress)) return { status: "skipped", reason: "archive" };

  const userId = await lookupRosterUserId(deps.identity, deps.ctx, recipient);
  if (!userId) return { status: "skipped", reason: "no_roster_user" };

  const gmail = await linkedGmail(deps.member, deps.ctx, userId);
  if (!gmail) return { status: "skipped", reason: "no_linked_gmail" };
  setTarget(gmail);

  // Loop guard 2: never forward back into our own zone.
  if (gmail.endsWith(`@${lower(deps.internalDomain)}`)) return { status: "skipped", reason: "internal_target" };
  // Loop guard 3: mail the user sent from that Gmail (e.g. a Gmail auto-forward rule).
  const senders = [lower(parseAddress(raw.from).email), lower(parseAddress(raw.headers["from"] ?? "").email)];
  if (senders.includes(gmail)) return { status: "skipped", reason: "from_target" };

  try {
    await message.forward(gmail, new Headers({ [FORWARDED_HEADER]: "1" }));
    return { status: "forwarded", userId };
  } catch (err) {
    return { status: "failed", userId, reason: err instanceof Error ? err.message : String(err) };
  }
}

function record(deps: GmailForwardDeps, outcome: ForwardOutcome, target: string | null): void {
  consoleSink({
    level: outcome.status === "failed" ? "error" : "info",
    message: `mail-gateway: gmail forward ${outcome.status}`,
    service: SERVICE_NAME,
    requestId: deps.ctx.requestId,
    fields: {
      ...outcome,
      ...(target ? { target: maskEmail(target) } : {}),
    },
  });
}

async function audit(deps: GmailForwardDeps, outcome: ForwardOutcome, target: string | null): Promise<void> {
  try {
    await publishAudit(deps.audit, {
      action: "mail.message.forward_gmail",
      actorId: null,
      orgId: deps.orgId,
      result: outcome.status === "forwarded" ? "success" : "failure",
      resourceType: "user",
      resourceId: "userId" in outcome ? outcome.userId : null,
      details: {
        ...(target ? { target: maskEmail(target) } : {}),
        ...(outcome.status === "failed" ? { error: outcome.reason } : {}),
      },
      requestId: deps.ctx.requestId,
      occurredAt: nowIso(),
    });
  } catch {
    // audit is best-effort; the console record above already captured the outcome.
  }
}
