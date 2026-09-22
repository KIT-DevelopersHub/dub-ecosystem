// mail-gateway Worker entry: HTTP (fetch), inbound email() (Cloudflare Email Routing),
// scheduled Cron (daily retention purge). Deploy is out of scope for this unit.
import type { ExecutionContext, ForwardableEmailMessage, ReadableStream, ScheduledController } from "@cloudflare/workers-types";
import { newRequestId } from "@dub/http";
import { createApp } from "./app";
import { buildInboundDeps } from "./deps";
import { handleInbound } from "./inbound";
import { headersToMap, type RawInbound } from "./mime";
import { runRetentionPurge } from "./scheduled";
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
    await handleInbound(buildInboundDeps(env, ctx), raw);
  },

  // Business cron. Two jobs share this ONE existing trigger (the Workers Free plan caps
  // the account at 5 cron triggers, so we reuse mail-gateway's own trigger rather than
  // adding another — the same reuse pattern the retention purge already followed):
  //   1. scheduled-send drain — EVERY tick (the cron cadence is */5, giving 予約送信 a ~5m
  //      delivery granularity, ample for a "send later" feature). $0: the schedule row is
  //      the durable timer, this cron is the ticker; no paid Queue, no new trigger.
  //   2. retention purge — ONCE a day, gated to the ~03:20 UTC tick so it does not run
  //      every 5 minutes. Same 30-day window as before.
  // The freeq outbox drain stays OUT of here (it moved to the standalone freeq-drain DO).
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runScheduledSendDrain(env);
    const d = new Date(controller.scheduledTime || Date.now());
    if (d.getUTCHours() === 3 && d.getUTCMinutes() >= 15 && d.getUTCMinutes() < 25) {
      await runRetentionPurge(env);
    }
  },
};

export default handler;
export { createApp };
export type { Env };
// Reconciled cross-service inbound DTO (see types.ts); mail-automation mirrors this.
export type { InboundMailView } from "./types";
