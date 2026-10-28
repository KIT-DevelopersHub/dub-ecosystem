// Inbound normalization + ingest (design §1/§7). Source = Cloudflare Email Routing ->
// this Worker's email() handler (9-B pivot; no Gmail watch). Guarantees 受信取りこぼし
// ゼロ + no double-processing: message_id (RFC Message-Id) is the dedup key, an
// Email-Routing redelivery is a no-op, and only a first-seen message publishes
// mail.message.received (mail-automation). Loop-prevention headers are passed through
// untouched — the decision is mail-automation's, not ours.
import { createEvent, publishEvent } from "@dub/events";
import { ulid } from "@dub/db";
import { consoleSink } from "@dub/observability";
import type { mail } from "@dub/types";
import { SERVICE_NAME } from "./config";
import {
  decodeHeaderWord,
  extractAttachmentsDetailed,
  extractBody,
  extractSnippet,
  parseAddress,
  parseAddressList,
} from "./mime";
import { claimInboundOwnerIfUnset, findInboundByMessageId, insertDelivery, insertInbound, newInboundId, resolveThreadId } from "./repo";
import { persistAttachments, persistDroppedAttachments, type DroppedReason } from "./attachments";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES, MAX_ATTACHMENT_BYTES } from "./config";
import { resolveInboundOwner } from "./owner";
import { archiveRawEml } from "./raw-eml";
import type { InboundDeps, OwnerAddressPolicy, ParsedInbound } from "./types";
import type { RawInbound } from "./mime";

function stripAngle(id: string): string {
  return id.trim().replace(/^<|>$/g, "").trim();
}
function firstRef(value: string | undefined): string | null {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value);
  if (m && m[1]) return m[1].trim();
  const token = value.split(/\s+/)[0];
  return token ? stripAngle(token) || null : null;
}
/** All Message-Ids in a References/In-Reply-To header value, in order (angle-bracketed
 *  tokens preferred; falls back to whitespace-split bare tokens). */
function allRefs(value: string | undefined): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim()).filter(Boolean);
  if (bracketed.length > 0) return bracketed;
  return value
    .split(/\s+/)
    .map((t) => stripAngle(t))
    .filter(Boolean);
}
function domainOf(email: string): string | undefined {
  const d = email.split("@")[1]?.trim().toLowerCase();
  return d ? d : undefined;
}

// Only Email Routing's own verdict is trusted: a sender can add any header it likes, but
// Cloudflare prepends its ARC-Authentication-Results, so its value comes first in the
// combined (", "-joined) header and is cut at the next "i=N;" instance.
const CF_AUTHSERV = /^\s*i=\d+;\s*mx\.cloudflare\.net;/i;

/** DKIM signing domain that PASSED per Cloudflare's ARC-Authentication-Results. */
export function dkimSignedBy(arcAuthResults: string | undefined): string | undefined {
  if (!arcAuthResults || !CF_AUTHSERV.test(arcAuthResults)) return undefined;
  const own = arcAuthResults.replace(CF_AUTHSERV, "").split(/,\s*i=\d+;/)[0] ?? "";
  for (const clause of own.split(";")) {
    if (!/^\s*dkim=pass\b/i.test(clause)) continue;
    const d = /header\.d=([^\s;]+)/i.exec(clause)?.[1] ?? /header\.i=[^\s@;]*@([^\s;]+)/i.exec(clause)?.[1];
    if (d) return d.toLowerCase();
  }
  return undefined;
}

/** TLS on the hop into Cloudflare: the topmost Received (written by the receiving MX, not
 *  the sender) names the protocol in its "with" clause, before the ";" date. */
export function receivedOverTls(received: string | undefined): boolean | undefined {
  if (!received) return undefined;
  const hop = received.split(";")[0] ?? "";
  const proto = /\bwith\s+([A-Z0-9]+)/i.exec(hop)?.[1];
  if (/\bTLS/i.test(hop)) return true;
  if (!proto) return undefined;
  return /SMTPSA?$/i.test(proto); // ESMTPS / ESMTPSA / UTF8SMTPS (RFC 3848)
}

function headerMetaFor(raw: RawInbound): mail.MailHeaderMeta {
  const h = raw.headers;
  const meta: mail.MailHeaderMeta = {};
  const replyTo = parseAddressList(h["reply-to"]);
  if (replyTo.length > 0) meta.replyTo = replyTo;
  const deliveredTo = parseAddress(raw.to).email.trim().toLowerCase();
  if (deliveredTo) meta.deliveredTo = deliveredTo;
  const mailedBy = domainOf(parseAddress(raw.from).email);
  if (mailedBy) meta.mailedBy = mailedBy;
  const signedBy = dkimSignedBy(h["arc-authentication-results"]);
  if (signedBy) meta.signedBy = signedBy;
  const tls = receivedOverTls(h["received"]);
  if (tls !== undefined) meta.tls = tls;
  return meta;
}

function localPart(address: string): string | null {
  const email = parseAddress(address).email;
  const lp = email.split("@")[0];
  return lp ?? null;
}

/**
 * Normalize a raw RFC822 message into the frozen MailMessage DTO. Pure/synchronous so
 * it is unit-testable without the Worker runtime. threadId = first References token,
 * else In-Reply-To, else the message's own Message-Id (a new thread).
 */
export function parseInbound(raw: RawInbound, policy: OwnerAddressPolicy = {}): ParsedInbound {
  const h = raw.headers;
  const messageId = firstRef(h["message-id"]) ?? `nomsgid-${ulid()}`;
  const threadId = firstRef(h["references"]) ?? firstRef(h["in-reply-to"]) ?? messageId;
  const subject = decodeHeaderWord(h["subject"] ?? "");
  const from = parseAddress(h["from"] ?? raw.from);
  const to = parseAddressList(h["to"] ?? raw.to);
  const cc = parseAddressList(h["cc"]);
  const receivedAt = h["date"] ? new Date(h["date"]).toISOString() : new Date().toISOString();

  const message: mail.MailMessage = {
    id: newInboundId(),
    messageId,
    threadId,
    from,
    to: to.length > 0 ? to : parseAddressList(raw.to),
    subject,
    snippet: extractSnippet(raw.rawText),
    receivedAt: isNaN(Date.parse(receivedAt)) ? new Date().toISOString() : receivedAt,
  };

  const loop: mail.MailLoopHeaders = {};
  if (h["auto-submitted"]) loop["auto-submitted"] = h["auto-submitted"];
  if (h["x-dub-mail-loop"]) loop["x-dub-mail-loop"] = h["x-dub-mail-loop"];

  // Ancestral Message-Ids (References first, then In-Reply-To) used to normalize the
  // thread id against messages we already have on record (改善#3).
  const references = [...allRefs(h["references"]), ...allRefs(h["in-reply-to"])];

  // Body is persisted for the inbox detail view (frozen MailMessage still carries only
  // the snippet). Email Routing hands us the raw RFC822 as text; we keep the plain-text
  // body. HTML-part extraction is out of this slice's scope → htmlBody stays null.
  return {
    message,
    loop,
    mailbox: localPart(raw.to),
    bodyText: extractBody(raw.rawText),
    htmlBody: null,
    cc,
    headerMeta: headerMetaFor(raw),
    references,
    ownerCandidates: ownerCandidatesFor(parseAddress(raw.to), message.to, policy),
  };
}

function normAddr(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v ? v : null;
}

/**
 * Build the ordered owner-resolution candidate list (see OwnerAddressPolicy and owner.ts).
 *
 *   1. the envelope recipient — UNLESS it is the archive or the shared system address
 *   2. the To: header addresses, in order — the archive address filtered out
 *   3. the envelope recipient when it IS the shared system address (last resort)
 *
 * The archive address never appears, and an archive@ COPY gets no candidates at all: the
 * auto-copy of every outbound send is delivered there, and it is read_all-only oversight
 * material, not an owned inbox. Each other recipient gets their own envelope copy (and
 * their own delivery row), so the archive copy never needs to stand in for one.
 */
function ownerCandidatesFor(
  envelope: mail.MailAddress,
  headerTo: readonly mail.MailAddress[],
  policy: OwnerAddressPolicy,
): mail.MailAddress[] {
  const archive = normAddr(policy.archiveAddress);
  const shared = normAddr(policy.sharedAddress);
  const envelopeEmail = normAddr(envelope.email);
  const isArchive = !!archive && envelopeEmail === archive;
  const isShared = !!shared && envelopeEmail === shared;

  const candidates: mail.MailAddress[] = [];
  if (isArchive) return candidates;
  if (envelopeEmail && !isShared) candidates.push(envelope);
  for (const a of headerTo) {
    if (archive && normAddr(a.email) === archive) continue;
    candidates.push(a);
  }
  // A shared alias IS a real inbox, so it may own a message — but only after the To:
  // header, so mail addressed to an individual is never hijacked by the shared account.
  if (isShared) candidates.push(envelope);
  return candidates;
}

/**
 * Ingest one envelope copy of an inbound message. The body row is stored once per
 * Message-Id; EVERY copy (one Email Routing call per RCPT TO — To, Cc, Bcc, archive@)
 * records its own delivery so each internal recipient sees it in their inbox. Attachments,
 * the raw .eml archive and mail.message.received happen only for the first copy.
 * `processed` = this call stored the body row (the first copy).
 */
export async function handleInbound(deps: InboundDeps, raw: RawInbound): Promise<{ processed: boolean; message: mail.MailMessage }> {
  const parsed = parseInbound(raw, {
    archiveAddress: deps.archiveAddress ?? null,
    sharedAddress: deps.sharedAddress ?? null,
  });
  const { message, loop, mailbox, bodyText, htmlBody, cc, headerMeta, references, ownerCandidates } = parsed;

  // Normalize the thread id against messages we already have (改善#3): if any referenced
  // ancestor is a known inbound/sent message, adopt ITS thread so a trimmed References
  // chain (or a reply to our own send) still joins the root conversation instead of
  // forking a new thread. Falls back to parseInbound's firstRef when nothing is known.
  const resolvedThread = await resolveThreadId(deps.db, references);
  if (resolvedThread) message.threadId = resolvedThread;

  // Per-account Inbox scope: resolve the owning roster user of THIS copy from its delivery
  // address(es), envelope recipient first (see parseInbound). null when no roster user
  // matches, or for the archive@ copy (fail-closed: visible to mail:read_all only).
  const ownerUserId = await resolveInboundOwner(deps.identity, deps.ctx, ownerCandidates);
  const envelopeTo = parseAddress(raw.to).email.trim().toLowerCase();

  const changes = await insertInbound(deps.db, message, {
    mailbox,
    autoSubmitted: loop["auto-submitted"] ?? null,
    loopMarker: loop["x-dub-mail-loop"] ?? null,
    bodyText,
    htmlBody,
    cc,
    headerMeta,
    ownerUserId,
  });
  if (changes === 0) {
    // Body already stored: another recipient's copy, or a redelivery. Record this copy's
    // delivery (a redelivery of the same copy is an INSERT OR IGNORE no-op), never re-publish.
    const existing = await findInboundByMessageId(deps.db, message.messageId);
    if (!existing) return { processed: false, message };
    message.id = existing.id;
    message.threadId = existing.thread_id;
    await insertDelivery(deps.db, { inboundId: existing.id, ownerUserId, envelopeTo });
    if (ownerUserId) await claimInboundOwnerIfUnset(deps.db, existing.id, ownerUserId);
    return { processed: false, message };
  }
  await insertDelivery(deps.db, { inboundId: message.id, ownerUserId, envelopeTo });

  // Raw .eml archive (データ保全): the untruncated original, so a parser bug or data loss
  // can be repaired later. Best-effort — archiveRawEml logs and never throws.
  if (deps.blobs && raw.rawBytes) {
    await archiveRawEml({ db: deps.db, blobs: deps.blobs, ctx: deps.ctx }, message.id, raw.rawBytes);
  }

  // Attachments: extract from the full raw MIME (buffered by the email() handler when R2
  // is bound) and persist bytes->R2 + metadata->D1, keyed to this inbound message row.
  // Best-effort (persistAttachments logs per-file failures); ingest already succeeded.
  if (deps.blobs && raw.rawFull) {
    const { attachments: extracted, dropped } = extractAttachmentsDetailed(raw.rawFull, {
      maxCount: MAX_ATTACHMENTS_PER_MESSAGE,
      maxBytesPerFile: MAX_ATTACHMENT_BYTES,
      maxTotalBytes: MAX_ATTACHMENTS_TOTAL_BYTES,
    });
    if (extracted.length > 0) {
      await persistAttachments(
        { db: deps.db, blobs: deps.blobs, orgId: deps.orgId, ctx: deps.ctx },
        "inbound",
        message.id,
        extracted,
      );
    }
    // 改善#2: make unstorable attachments VISIBLE instead of silently dropping them.
    //  - parts over the per-file / per-message ceiling -> dropped_too_large stubs
    //  - a message larger than our read buffer (tail cut off) -> one dropped_truncated stub
    const stubs: { filename: string; contentType: string; sizeBytes: number; reason: DroppedReason }[] = dropped.map(
      (d) => ({ filename: d.filename, contentType: d.contentType, sizeBytes: d.sizeBytes, reason: d.reason }),
    );
    if (raw.truncated) {
      stubs.push({ filename: "添付ファイル（サイズ超過）", contentType: "application/octet-stream", sizeBytes: raw.rawSize, reason: "dropped_truncated" });
    }
    if (stubs.length > 0) {
      await persistDroppedAttachments({ db: deps.db, ctx: deps.ctx }, "inbound", message.id, stubs);
    }
  }

  const event = createEvent(
    "mail.message.received",
    { messageId: message.messageId, threadId: message.threadId },
    { requestId: deps.ctx.requestId, actorId: null }, // inbound = system origin
  );
  try {
    await publishEvent(deps.events, event);
  } catch (err) {
    consoleSink({
      level: "error",
      message: "mail-gateway: failed to publish mail.message.received",
      service: SERVICE_NAME,
      requestId: deps.ctx.requestId,
      fields: { messageId: message.messageId, error: err instanceof Error ? err.message : String(err) },
    });
    throw err; // let the caller (email handler) surface it so Email Routing can retry
  }
  return { processed: true, message };
}
