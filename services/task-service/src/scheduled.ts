// Cron: due-soon scan. Detects tasks whose due_at falls within the frozen 24h
// window (once each, via due_soon_notified_at dedup) and emits task.due_soon with
// actorId=null (cron origin).
import { newRequestId } from "@dub/http";
import { nowIso } from "@dub/db";
import { emit, type EventSpec } from "./events";
import type { Deps } from "./deps";

export async function runDueSoonScan(deps: Deps, nowMs: number = Date.now()): Promise<number> {
  const due = await deps.repo.scanDueSoon(nowMs, deps.config.dueSoonWindowMs, nowIso());
  if (due.length === 0) return 0;
  const specs: EventSpec[] = due.map((d) => ({
    name: "task.due_soon",
    payload: { taskId: d.taskId, ...(d.eventId ? { eventId: d.eventId } : {}), dueAt: d.dueAt },
  }));
  await emit(deps.events, { requestId: newRequestId(), actorId: null }, specs);
  return due.length;
}
