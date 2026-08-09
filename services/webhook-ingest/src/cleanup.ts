// Daily retention sweep (Cron): delete webhook_deliveries older than the window and
// their R2 objects. Window = dedup window = record-retention window (frozen 30d).
import type { R2Bucket } from "@cloudflare/workers-types";
import type { DeliveryRepo } from "./repo";

export interface CleanupDeps {
  repo: DeliveryRepo;
  raw: R2Bucket;
  now?: () => number; // epoch ms (default Date.now)
}

export interface CleanupResult {
  deletedRows: number;
  deletedObjects: number;
}

export async function cleanup(deps: CleanupDeps, retentionDays: number): Promise<CleanupResult> {
  const nowMs = (deps.now ?? Date.now)();
  const cutoffIso = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const purged = await deps.repo.purgeOlderThan(cutoffIso);
  let deletedObjects = 0;
  for (const key of purged.r2Keys) {
    try {
      await deps.raw.delete(key);
      deletedObjects++;
    } catch {
      // best-effort; an orphaned object is harmless and swept next run
    }
  }
  return { deletedRows: purged.deletedIds.length, deletedObjects };
}
