// mail-gateway Worker entry: HTTP (fetch), inbound email() (Cloudflare Email Routing),
// scheduled Cron (予約送信 drain). Deploy is out of scope for this unit.
import type { ExecutionContext, ForwardableEmailMessage, ReadableStream, ScheduledController } from "@cloudflare/workers-types";
import { newRequestId } from "@dub/http";
import { createApp } from "./app";
import { buildGmailForwardDeps, buildInboundDeps } from "./deps";
import { forwardToLinkedGmail, gmailForwardEnabled } from "./gmail-forward";
import { handleInbound } from "./inbound";
import { headersToMap, type RawInbound } from "./mime";
import { runScheduledSendDrain } from "./scheduled-send";
import { INBOUND_ATTACHMENT_READ_BYTES, INBOUND_RAW_READ_BYTES, SERVICE_NAME } from "./config";
import type { Env } from "./env";

const app = createApp();

/** Read a bounded prefix of the raw RFC822 stream, returning the raw bytes. */
async function readRawBytes(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const ch of chunks) {
    if (off >= buf.length) break;
    const take = Math.min(ch.byteLength, buf.length - off);
    buf.set(ch.subarray(0, take), off);
    off += take;
  }
  return buf;
}

// Plain module handler (not typed as ExportedHandler to avoid the workers-types vs
// undici Response brand clash under the root tsconfig which omits workers-types globals).
const handler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, env, ctx as unknown as never);
  },

  // Cloudflare Email Routing entry (9-B). System-origin (no user) — actorId = null.
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const ctx = { requestId: newRequestId(), caller: SERVICE_NAME };
    // When R2 is bound, buffer more of the message so attachment parts can be extracted;
    // otherwise keep the original headers-only cap. rawText (snippet/body) stays the first
    // INBOUND_RAW_READ_BYTES so existing body/snippet extraction is byte-for-byte unchanged.
    const hasR2 = Boolean(env.R2_MAIL);
    const cap = hasR2 ? INBOUND_ATTACHMENT_READ_BYTES : INBOUND_RAW_READ_BYTES;
    const bytes = await readRawBytes(message.raw, cap);
    const decoder = new TextDecoder();
    const rawText = decoder.decode(bytes.subarray(0, INBOUND_RAW_READ_BYTES));
    // The message was larger than the buffer we read: any attachment past the cap was cut
    // off. Flag it so ingest records a visible "truncated" stub rather than losing it
    // silently (改善#2). rawSize is Email Routing's authoritative full byte size.
    const truncated = message.rawSize > cap;
    const raw: RawInbound = {
      from: message.from,
      to: message.to,
      headers: headersToMap(message.headers),
      rawText,
      rawSize: message.rawSize,
      ...(hasR2 ? { rawFull: decoder.decode(bytes) } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
    // Store first. The Gmail forward runs after the ingest attempt — also when ingest threw,
    // since that is exactly when the Gmail copy matters — and never throws itself, so it can
    // neither drop nor block storage. The ingest error is re-thrown afterwards as before.
    let ingestError: unknown = null;
    try {
      await handleInbound(buildInboundDeps(env, ctx), raw);
    } catch (err) {
      ingestError = err;
    }
    if (gmailForwardEnabled(env.MAIL_GMAIL_FORWARD)) {
      await forwardToLinkedGmail(
        buildGmailForwardDeps(env, ctx),
        { forward: (to, headers) => message.forward(to, headers as never) },
        raw,
      );
    }
    if (ingestError) throw ingestError;
  },

  // Business cron: scheduled-send drain on EVERY tick (*/5 → ~5m 予約送信 granularity).
  // $0: the schedule row is the durable timer, this cron is the ticker. Mail is kept
  // indefinitely — there is intentionally NO retention purge here.
  // The freeq outbox drain stays OUT of here (it moved to the standalone freeq-drain DO).
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runScheduledSendDrain(env);
  },
};

export default handler;
export { createApp };
export type { Env };
// Reconciled cross-service inbound DTO (see types.ts); mail-automation mirrors this.
export type { InboundMailView } from "./types";
