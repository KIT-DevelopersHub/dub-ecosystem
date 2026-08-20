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
import { insertInbound, newInboundId, resolveThreadId, seenInbound } from "./repo";
import { persistAttachments, persistDroppedAttachments, type DroppedReason } from "./attachments";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES, MAX_ATTACHMENT_BYTES } from "./config";
import { resolveInboundOwner } from "./owner";
import type { InboundDeps, ParsedInbound } from "./types";
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
export function parseInbound(raw: RawInbound): ParsedInbound {
  const h = raw.headers;
  const messageId = firstRef(h["message-id"]) ?? `nomsgid-${ulid()}`;
  const threadId = firstRef(h["references"]) ?? firstRef(h["in-reply-to"]) ?? messageId;
  const subject = decodeHeaderWord(h["subject"] ?? "");
  const from = parseAddress(h["from"] ?? raw.from);
  const to = parseAddressList(h["to"] ?? raw.to);
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
  return { message, loop, mailbox: localPart(raw.to), bodyText: extractBody(raw.rawText), htmlBody: null, references };
}

/**
 * Ingest one inbound message: dedup by Message-Id, persist the normalized row, then
 * publish mail.message.received. Returns whether it was newly processed.
 */
export async function handleInbound(deps: InboundDeps, raw: RawInbound): Promise<{ processed: boolean; message: mail.MailMessage }> {
  const parsed = parseInbound(raw);
  const { message, loop, mailbox, bodyText, htmlBody, references } = parsed;

  // Normalize the thread id against messages we already have (改善#3): if any referenced
  // ancestor is a known inbound/sent message, adopt ITS thread so a trimmed References
  // chain (or a reply to our own send) still joins the root conversation instead of
  // forking a new thread. Falls back to parseInbound's firstRef when nothing is known.
  const resolvedThread = await resolveThreadId(deps.db, references);
  if (resolvedThread) message.threadId = resolvedThread;

  if (await seenInbound(deps.db, message.messageId)) {
    return { processed: false, message };
  }

  // Per-account Inbox scope: resolve the owning roster user from the recipient
  // address(es). null when no roster user matches (fail-closed: invisible to all).
  const ownerUserId = await resolveInboundOwner(deps.identity, deps.ctx, message.to);

  const changes = await insertInbound(deps.db, message, {
    mailbox,
    autoSubmitted: loop["auto-submitted"] ?? null,
    loopMarker: loop["x-dub-mail-loop"] ?? null,
    bodyText,
    htmlBody,
    ownerUserId,
  });
  if (changes === 0) {
    // lost the race with a concurrent redelivery — already persisted, do not re-publish.
    return { processed: false, message };
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
