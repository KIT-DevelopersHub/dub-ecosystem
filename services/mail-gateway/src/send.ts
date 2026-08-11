// Outbound send core (design §2/§6). Guarantees 二重送信ゼロ via the idempotency-keyed
// send-log: a replay returns the first result, a same-key/different-body request 409s,
// and a UNIQUE(idempotency_key) collision collapses concurrent sends to one delivery.
// On success -> mail.message.sent (notification) + publishAudit success; on provider
// failure -> mail.message.send_failed (notification) + publishAudit failure + 502.
import { DubError } from "@dub/errors";
import { publishAudit, publishEvent, createEvent } from "@dub/events";
import { nowIso } from "@dub/db";
import { consoleSink } from "@dub/observability";
import type { auditLog, mail } from "@dub/types";
import { DEFAULT_SEND_BASE_DELAY_MS, DEFAULT_SEND_MAX_ATTEMPTS, SERVICE_NAME } from "./config";
import { assembleMime } from "./mime";
import { withRetry } from "./retry";
import {
  findSendByKey,
  insertSendClaim,
  markSendFailed,
  markSendSent,
  newSendLogId,
  type SendLogRow,
} from "./repo";
import type { OutboundMail } from "./provider";
import type { SendDeps } from "./types";

/** FNV-1a 32-bit hex over the canonical request (same key + different body -> 409). */
export function hashRequest(req: mail.SendMailRequest): string {
  const canonical = JSON.stringify({
    to: req.to,
    cc: req.cc ?? [],
    subject: req.subject,
    textBody: req.textBody,
    htmlBody: req.htmlBody ?? null,
    inReplyTo: req.inReplyTo ?? null,
    loopHeaders: req.loopHeaders ?? null,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function domainOf(fromAddress: string): string {
  return fromAddress.split("@")[1] ?? "developershub.jp";
}

/** Auto-CC the fixed archive address on every send (compliance archive). Returns a new
 *  request with the archive appended to Cc, UNLESS it is already present in To or Cc
 *  (case-insensitive) — a caller who addressed it is never double-CC'd. A null/empty
 *  archive address is a no-op (feature disabled). Applied before hashRequest so the
 *  idempotency hash, persisted ccJson, MIME and provider recipients all agree. */
export function withArchiveCc(req: mail.SendMailRequest, archiveCc: string | null | undefined): mail.SendMailRequest {
  const addr = archiveCc?.trim();
  if (!addr) return req;
  const target = addr.toLowerCase();
  const already = [...req.to, ...(req.cc ?? [])].some((a) => a.email.trim().toLowerCase() === target);
  if (already) return req;
  return { ...req, cc: [...(req.cc ?? []), { email: addr }] };
}

/** Stable RFC Message-Id reconstructed from the send-log id, so a replay reproduces
 *  the exact same messageId the first attempt returned. */
function rfcMessageId(logId: string, fromAddress: string): string {
  return `${logId}@${domainOf(fromAddress)}`;
}

function duplicateResponse(row: SendLogRow, fromAddress: string): mail.SendMailResponse {
  return {
    messageId: rfcMessageId(row.id, fromAddress),
    provider: (row.provider as mail.SendMailResponse["provider"]) ?? "ses",
    acceptedAt: row.created_at,
  };
}

export interface SendResult {
  response: mail.SendMailResponse;
  status: "sent" | "duplicate";
}

/**
 * Send one mail with idempotency. `idempotencyKey` comes from the x-dub-idempotency-key
 * header (frozen SendMailRequest carries no such field). `requester` = x-dub-caller.
 */
export async function sendMail(
  deps: SendDeps,
  rawReq: mail.SendMailRequest,
  idempotencyKey: string,
  requester: string,
): Promise<SendResult> {
  const { db, provider, fromAddress } = deps;
  // Auto-CC the archive address (compliance) on every send, deduped against To/Cc. Done
  // first so every downstream use (hash, claim, MIME, provider) sees the same recipients.
  const req = withArchiveCc(rawReq, deps.archiveCc);
  const reqHash = hashRequest(req);
  const threadId = req.inReplyTo ?? null;

  // 1) reconcile against any existing claim for this key.
  const existing = await findSendByKey(db, idempotencyKey);
  let ownedId: string;
  if (existing) {
    if (existing.req_hash !== reqHash) {
      throw new DubError("MAIL_IDEMPOTENCY_CONFLICT", "idempotency key reused with a different body", { status: 409 });
    }
    if (existing.status === "sent" || existing.status === "pending") {
      // sent -> true replay; pending -> an in-flight duplicate: return the same result
      // rather than double-send (design: 1 email only).
      return { response: duplicateResponse(existing, fromAddress), status: "duplicate" };
    }
    ownedId = existing.id; // status === "failed": re-attempt on the same row/messageId
  } else {
    const id = newSendLogId();
    const claimed = await insertSendClaim(db, {
      id,
      idempotencyKey,
      reqHash,
      requester,
      toJson: JSON.stringify(req.to),
      subject: req.subject,
      threadId,
      // Body/recipients persisted at claim time so a later status='sent' row backs the
      // Sent folder (GET /sent). Does not affect idempotency (same OR IGNORE on the key).
      textBody: req.textBody,
      htmlBody: req.htmlBody ?? null,
      ccJson: JSON.stringify(req.cc ?? []),
      fromAddress,
      // Owner = the human sender (Sent-folder account scope); null for system sends.
      ownerUserId: deps.ownerUserId ?? null,
    });
    if (claimed === 0) {
      // lost the race — another request claimed the key; re-read and dedup.
      const now = await findSendByKey(db, idempotencyKey);
      if (now) return { response: duplicateResponse(now, fromAddress), status: "duplicate" };
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "send claim lost and vanished", { status: 502 });
    }
    ownedId = id;
  }

  // 2) assemble + hand to the provider.
  const messageId = rfcMessageId(ownedId, fromAddress);
  const outbound: OutboundMail = {
    from: fromAddress,
    to: req.to,
    cc: req.cc ?? [],
    subject: req.subject,
    textBody: req.textBody,
    htmlBody: req.htmlBody ?? null,
    messageId,
    inReplyTo: req.inReplyTo ?? null,
    mime: assembleMime({
      from: fromAddress,
      to: req.to,
      cc: req.cc ?? [],
      subject: req.subject,
      textBody: req.textBody,
      htmlBody: req.htmlBody ?? null,
      messageId,
      inReplyTo: req.inReplyTo ?? null,
      ...(req.loopHeaders ? { loopHeaders: req.loopHeaders } : {}),
    }),
  };

  try {
    // Bounded retry (transient failures only): a network reset / timeout / 429 / 5xx is
    // retried with backoff+jitter; deterministic rejections (validation, unverified
    // domain, 2xx-without-id) fail on the first try. The DB claim stays 'pending' across
    // attempts, so a replay mid-retry still dedups against this same row.
    const retry = deps.retry ?? { maxAttempts: DEFAULT_SEND_MAX_ATTEMPTS, baseDelayMs: DEFAULT_SEND_BASE_DELAY_MS };
    const { providerMessageId } = await withRetry(() => provider.send(outbound), retry);
    await markSendSent(db, ownedId, provider.name, providerMessageId);
    await publishSent(deps, messageId, requester);
    await audit(deps, "success", messageId, requester, null);
    const response: mail.SendMailResponse = { messageId, provider: provider.name, acceptedAt: nowIso() };
    return { response, status: "sent" };
  } catch (err) {
    const code = err instanceof DubError ? err.code : "MAIL_PROVIDER_UNAVAILABLE";
    await markSendFailed(db, ownedId, code);
    await publishSendFailed(deps, messageId, code);
    await audit(deps, "failure", messageId, requester, code);
    throw err instanceof DubError ? err : new DubError("MAIL_PROVIDER_UNAVAILABLE", "provider send failed", { status: 502, cause: err });
  }
}

async function publishSent(deps: SendDeps, messageId: string, _requester: string): Promise<void> {
  const event = createEvent("mail.message.sent", { messageId }, { requestId: deps.ctx.requestId, actorId: deps.ctx.userId ?? null });
  await safePublish(deps, () => publishEvent(deps.events, event), "mail.message.sent");
}

async function publishSendFailed(deps: SendDeps, messageId: string, error: string): Promise<void> {
  const event = createEvent("mail.message.send_failed", { messageId, error }, { requestId: deps.ctx.requestId, actorId: deps.ctx.userId ?? null });
  await safePublish(deps, () => publishEvent(deps.events, event), "mail.message.send_failed");
}

async function audit(deps: SendDeps, result: "success" | "failure", messageId: string, requester: string, errorCode: string | null): Promise<void> {
  const input: auditLog.AuditRecordInput = {
    action: "mail.message.send",
    actorId: deps.ctx.userId ?? null,
    orgId: deps.orgId,
    result,
    resourceType: "mail_message",
    resourceId: messageId,
    details: { requester, ...(errorCode ? { errorCode } : {}) },
    requestId: deps.ctx.requestId,
    occurredAt: nowIso(),
  };
  await safePublish(deps, () => publishAudit(deps.audit, input), "audit");
}

/** Event/audit publish must never turn a completed DB action into a 500 — log and move on. */
async function safePublish(deps: SendDeps, fn: () => Promise<void>, what: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    consoleSink({
      level: "error",
      message: `mail-gateway: failed to publish ${what}`,
      service: SERVICE_NAME,
      requestId: deps.ctx.requestId,
      fields: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}
