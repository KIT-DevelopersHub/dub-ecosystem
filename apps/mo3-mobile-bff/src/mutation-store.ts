// Durable cross-request idempotency for offline mutation replay (mobile_mutations).
// The in-batch Map in mutations.ts only dedups within a single request; if the
// client re-sends the *same* batch as a second request (flaky network, app
// relaunch) the owning services would double-apply. This store persists the
// terminal outcome of each client-minted idempotencyKey so a replay across
// separate requests returns the first result instead of re-dispatching.
//
// Only terminal, side-effecting outcomes are persisted: "applied" (the write
// landed) and "conflict" (a deterministic 409 — replaying would 409 again). A
// transient "error" (e.g. 502) is NOT persisted, so a later retry can still
// actually apply. Validation errors have no side effect and are likewise not
// persisted.
import { type DbClient, nowIso } from "@dub/db";
import type { MutationOp, MutationResult } from "./mutations";

export interface SaveMutationInput {
  idempotencyKey: string;
  userId: string;
  op: MutationOp;
  result: MutationResult; // must be status "applied" or "conflict"
}

export interface MutationStore {
  /** The prior terminal result for this key, or null if never applied. */
  get(idempotencyKey: string): Promise<MutationResult | null>;
  /** Persist a terminal result. First writer wins (idempotent on the key). */
  save(input: SaveMutationInput): Promise<void>;
}

/** D1-backed store (mobile namespace). Reads/writes only mobile_mutations. */
export class D1MutationStore implements MutationStore {
  constructor(private readonly db: DbClient) {}

  async get(idempotencyKey: string): Promise<MutationResult | null> {
    const row = await this.db.first<{ result_json: string | null }>(
      "SELECT result_json FROM mobile_mutations WHERE id = ?",
      idempotencyKey,
    );
    if (!row || !row.result_json) return null;
    try {
      return JSON.parse(row.result_json) as MutationResult;
    } catch {
      return null; // corrupt row -> treat as absent (re-dispatch is safe for the owning service's own dedup)
    }
  }

  async save({ idempotencyKey, userId, op, result }: SaveMutationInput): Promise<void> {
    // status column CHECK is ('pending','applied','rejected'); map conflict -> rejected.
    const status = result.status === "conflict" ? "rejected" : "applied";
    const now = nowIso();
    await this.db.run(
      "INSERT INTO mobile_mutations (id, user_id, device_id, kind, status, payload_json, result_json, created_at, updated_at) " +
        "VALUES (?, ?, NULL, ?, ?, '{}', ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      idempotencyKey,
      userId,
      op,
      status,
      JSON.stringify(result),
      now,
      now,
    );
  }
}
