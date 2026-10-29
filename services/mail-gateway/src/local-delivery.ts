// Local delivery of internal (own-domain) recipients after a successful send.
//
// Internal copies used to reach Dub only via provider -> MX -> Email Routing -> email().
// Resend suppresses any address that once hard-bounced (e.g. before its routing rule
// existed), so those copies silently never arrived. We now ingest them directly from the
// exact MIME we sent, one handleInbound() per internal envelope recipient. The provider
// still delivers them too; that later email() copy is a no-op (Message-ID dedup + delivery
// INSERT OR IGNORE). Never throws: a send that the provider accepted stays a success.
import { publishAudit } from "@dub/events";
import { nowIso } from "@dub/db";
import { consoleSink } from "@dub/observability";
import type { mail } from "@dub/types";
import { INBOUND_RAW_READ_BYTES, SERVICE_NAME } from "./config";
import { handleInbound } from "./inbound";
import type { RawInbound } from "./mime";
import type { InboundDeps } from "./types";

export interface LocalDeliveryDeps {
  inbound: InboundDeps;
  /** Own mail domain (CF_EMAIL_ROUTING_ZONE_NAME); recipients here are delivered locally. */
  domain: string;
}

/** Unfolded, lowercased header block of an RFC822 message (what CF exposes as .headers). */
export function mimeHeaderMap(mime: string): Record<string, string> {
  const end = mime.search(/\r?\n\r?\n/);
  const block = (end < 0 ? mime : mime.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

/** Envelope recipients on `domain`, lowercased + deduped, in envelope order. */
export function internalRecipients(envelope: readonly mail.MailAddress[], domain: string): string[] {
  const d = domain.trim().toLowerCase();
  const all = envelope.map((a) => a.email.trim().toLowerCase()).filter((e) => e.split("@")[1] === d);
  return [...new Set(all)];
}

export async function deliverLocally(
  deps: LocalDeliveryDeps,
  sent: { from: string; mime: string; envelope: readonly mail.MailAddress[]; messageId: string },
): Promise<{ delivered: string[]; failed: string[] }> {
  const rcpts = internalRecipients(sent.envelope, deps.domain);
  const delivered: string[] = [];
  const failed: string[] = [];
  if (rcpts.length === 0) return { delivered, failed };
  const headers = mimeHeaderMap(sent.mime);
  const bytes = new TextEncoder().encode(sent.mime);
  const withBlobs = Boolean(deps.inbound.blobs);
  for (const to of rcpts) {
    const raw: RawInbound = {
      from: sent.from,
      to,
      headers,
      rawText: new TextDecoder().decode(bytes.subarray(0, INBOUND_RAW_READ_BYTES)),
      rawSize: bytes.byteLength,
      ...(withBlobs ? { rawFull: sent.mime, rawBytes: bytes } : {}),
    };
    try {
      await handleInbound(deps.inbound, raw, { local: true });
      delivered.push(to);
    } catch (err) {
      failed.push(to);
      const error = err instanceof Error ? err.message : String(err);
      consoleSink({
        level: "error",
        message: "mail-gateway: local delivery failed",
        service: SERVICE_NAME,
        requestId: deps.inbound.ctx.requestId,
        fields: { messageId: sent.messageId, error },
      });
      await auditFailure(deps.inbound, sent.messageId, error);
    }
  }
  return { delivered, failed };
}

async function auditFailure(deps: InboundDeps, messageId: string, error: string): Promise<void> {
  try {
    await publishAudit(deps.audit, {
      action: "mail.message.local_delivery",
      actorId: deps.ctx.userId ?? null,
      orgId: deps.orgId,
      result: "failure",
      resourceType: "mail_message",
      resourceId: messageId,
      details: { error },
      requestId: deps.ctx.requestId,
      occurredAt: nowIso(),
    });
  } catch {
    // audit is best-effort; the console record above already captured the failure.
  }
}
