// Test doubles: in-memory DeliveryRepo, Queue, R2 bucket + github request signer.
import { hmacSha256Hex } from "../src/crypto";
import { encodeCursor, decodeCursor, type DeliveryRepo, type DeliveryRecord, type PurgeResult } from "../src/repo";
import type { Env } from "../src/env";
import type { webhook } from "@dub/types";

// ---- fake Queue ----
export class FakeQueue<T = unknown> {
  sent: T[] = [];
  failNext = false;
  async send(msg: T): Promise<void> {
    if (this.failNext) throw new Error("queue send failed");
    this.sent.push(msg);
  }
  async sendBatch(msgs: { body: T }[]): Promise<void> {
    for (const m of msgs) await this.send(m.body);
  }
}

// ---- fake R2 ----
export class FakeR2 {
  store = new Map<string, Uint8Array>();
  failNext = false;
  async put(key: string, value: Uint8Array | string): Promise<void> {
    if (this.failNext) throw new Error("r2 put failed");
    this.store.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const v = this.store.get(key);
    if (!v) return null;
    return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer };
  }
}

// ---- fake DeliveryRepo (mirrors keyset semantics of the D1 impl) ----
export class FakeRepo implements DeliveryRepo {
  rows = new Map<string, DeliveryRecord>(); // id -> record
  private byUnique = new Map<string, string>(); // source|externalId -> id

  private uk(source: string, externalId: string): string {
    return `${source}|${externalId}`;
  }

  async insertIfNew(rec: DeliveryRecord) {
    const key = this.uk(rec.source, rec.externalId);
    const existingId = this.byUnique.get(key);
    if (existingId) return { inserted: false, existingId };
    this.rows.set(rec.id, { ...rec });
    this.byUnique.set(key, rec.id);
    return { inserted: true, existingId: null };
  }

  async deleteById(id: string) {
    const rec = this.rows.get(id);
    if (rec) {
      this.rows.delete(id);
      this.byUnique.delete(this.uk(rec.source, rec.externalId));
    }
  }

  private toDelivery(rec: DeliveryRecord): webhook.WebhookDelivery {
    return {
      id: rec.id,
      source: rec.source,
      eventKind: rec.eventKind,
      status: rec.status,
      receivedAt: rec.receivedAt,
      processedAt: rec.processedAt,
    };
  }

  async getById(id: string) {
    const rec = this.rows.get(id);
    return rec ? this.toDelivery(rec) : null;
  }

  async query(q: webhook.WebhookDeliveryQuery): Promise<webhook.WebhookDeliveryPage> {
    const limit = Math.min(q.limit && q.limit > 0 ? q.limit : 50, 200);
    let recs = [...this.rows.values()]
      .filter((r) => (q.source ? r.source === q.source : true))
      .filter((r) => (q.status ? r.status === q.status : true))
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)); // id DESC
    if (q.cursor) {
      const after = decodeCursor(q.cursor);
      if (after) recs = recs.filter((r) => r.id < after);
    }
    const hasMore = recs.length > limit;
    const page = recs.slice(0, limit);
    return {
      items: page.map((r) => this.toDelivery(r)),
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.id) : null,
    };
  }

  async purgeOlderThan(cutoffIso: string): Promise<PurgeResult> {
    const stale = [...this.rows.values()].filter((r) => r.receivedAt < cutoffIso);
    for (const r of stale) await this.deleteById(r.id);
    return { deletedIds: stale.map((r) => r.id), r2Keys: stale.map((r) => r.r2Key).filter((k): k is string => k !== null) };
  }
}

// ---- github request signer ----
export async function signGithub(
  body: string,
  secret: string,
  opts: { delivery?: string; event?: string; badSig?: boolean } = {},
): Promise<Headers> {
  const hex = await hmacSha256Hex(secret, body);
  const h = new Headers();
  h.set("content-type", "application/json");
  h.set("x-github-delivery", opts.delivery ?? "11111111-2222-3333-4444-555555555555");
  h.set("x-github-event", opts.event ?? "push");
  h.set("x-hub-signature-256", `sha256=${opts.badSig ? "deadbeef".padEnd(64, "0") : hex}`);
  return h;
}

// ---- minimal env for app tests (D1/identity unused when deps/authz overridden) ----
export function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DUB_DB: null as unknown as Env["DUB_DB"],
    WEBHOOK_RAW: null as unknown as Env["WEBHOOK_RAW"],
    WH_GITHUB: null as unknown as Env["WH_GITHUB"],
    SVC_IDENTITY: null as unknown as Env["SVC_IDENTITY"],
    GITHUB_WEBHOOK_SECRET: "test-secret",
    ...overrides,
  };
}
