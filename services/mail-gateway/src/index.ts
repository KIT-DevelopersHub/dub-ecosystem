// mail-gateway Worker entry: HTTP (fetch), inbound email() (Cloudflare Email Routing),
// scheduled Cron (daily retention purge). Deploy is out of scope for this unit.
import type { ExecutionContext, ForwardableEmailMessage, ReadableStream, ScheduledController } from "@cloudflare/workers-types";
import { newRequestId } from "@dub/http";
import { createApp } from "./app";
import { buildInboundDeps } from "./deps";
import { handleInbound } from "./inbound";
import { headersToMap, type RawInbound } from "./mime";
import { runRetentionPurge } from "./scheduled";
import { runOutboxDrain } from "./outbox";
import { INBOUND_RAW_READ_BYTES, SERVICE_NAME } from "./config";
import type { Env } from "./env";

const app = createApp();

/** Read a bounded prefix of the raw RFC822 stream (we only need headers + snippet). */
async function readRawPrefix(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
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
  const buf = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    buf.set(ch, off);
    off += ch.byteLength;
  }
  return new TextDecoder().decode(buf.subarray(0, cap));
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
    const rawText = await readRawPrefix(message.raw, INBOUND_RAW_READ_BYTES);
    const raw: RawInbound = {
      from: message.from,
      to: message.to,
      headers: headersToMap(message.headers),
      rawText,
      rawSize: message.rawSize,
    };
    await handleInbound(buildInboundDeps(env, ctx), raw);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runRetentionPurge(env);
    // Drain the freeq D1 outbox (mutation audit fan-out) — no Cloudflare Queue involved.
    await runOutboxDrain(env);
  },
};

export default handler;
export { createApp };
export type { Env };
// Reconciled cross-service inbound DTO (see types.ts); mail-automation mirrors this.
export type { InboundMailView } from "./types";
