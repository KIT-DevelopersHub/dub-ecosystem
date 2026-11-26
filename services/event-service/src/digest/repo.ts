// Digest storage (event_ai_digests / event_ai_digest_sources, migration 0006).
// One run writes ONE digest row + one mark per CHANGED source — a dozen rows at most.
import type { DbClient } from "@dub/db";
import type { event } from "@dub/types";
import type { DigestRepo } from "./types";

interface DigestDbRow {
  event_id: string;
  data: string;
  model: string;
  trigger_kind: string;
  updated_at: string;
}

function parseDigest(r: DigestDbRow): event.EventDigest | null {
  try {
    const d = JSON.parse(r.data) as Partial<event.EventDigest>;
    return {
      eventId: r.event_id,
      lines: Array.isArray(d.lines) ? d.lines : [],
      discrepancies: Array.isArray(d.discrepancies) ? d.discrepancies : [],
      model: r.model,
      trigger: r.trigger_kind === "schedule" ? "schedule" : "manual",
      generatedAt: r.updated_at,
    };
  } catch {
    return null;
  }
}

export function createD1DigestRepo(db: DbClient): DigestRepo {
  return {
    async getDigest(eventId) {
      const r = await db.first<DigestDbRow>(`SELECT * FROM event_ai_digests WHERE event_id = ?`, eventId);
      return r ? parseDigest(r) : null;
    },
    async saveDigest(d, now) {
      await db.run(
        `INSERT INTO event_ai_digests (event_id, data, model, trigger_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET data = excluded.data, model = excluded.model,
           trigger_kind = excluded.trigger_kind, updated_at = excluded.updated_at`,
        d.eventId, JSON.stringify({ lines: d.lines, discrepancies: d.discrepancies }), d.model, d.trigger, now, d.generatedAt,
      );
    },
    async getSourceHashes(eventId) {
      const rows = await db.all<{ source: string; hash: string }>(
        `SELECT source, hash FROM event_ai_digest_sources WHERE event_id = ?`,
        eventId,
      );
      return Object.fromEntries(rows.map((r) => [r.source, r.hash]));
    },
    async saveSourceHashes(eventId, hashes, now) {
      for (const [source, hash] of Object.entries(hashes)) {
        await db.run(
          `INSERT INTO event_ai_digest_sources (event_id, source, hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(event_id, source) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at`,
          eventId, source, hash, now, now,
        );
      }
    },
  };
}

export class InMemoryDigestRepo implements DigestRepo {
  digests = new Map<string, event.EventDigest>();
  hashes = new Map<string, Record<string, string>>();
  writes = 0;
  async getDigest(eventId: string) {
    const d = this.digests.get(eventId);
    return d ? structuredClone(d) : null;
  }
  async saveDigest(d: event.EventDigest) {
    this.writes++;
    this.digests.set(d.eventId, structuredClone(d));
  }
  async getSourceHashes(eventId: string) {
    return { ...(this.hashes.get(eventId) ?? {}) };
  }
  async saveSourceHashes(eventId: string, h: Record<string, string>) {
    this.writes += Object.keys(h).length;
    this.hashes.set(eventId, { ...(this.hashes.get(eventId) ?? {}), ...h });
  }
}
