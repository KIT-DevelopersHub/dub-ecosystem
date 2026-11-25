// Cron BACKSTOP for the freeq-drain alarm loop. freeq-drain drains every freeq outbox from a
// self-rescheduling Durable Object alarm; if that alarm is ever dropped nothing re-arms it
// (2026-09-21: the loop died and ~11k outbox rows sat pending for two months). The Workers
// FREE plan's 5-cron account cap is full, so instead of a new trigger this existing */5 cron
// pokes POST /internal/drain/kick, which is idempotent: it re-arms a missing/wedged alarm
// and is a no-op while the loop is healthy. Best-effort: NEVER throws, short timeout, and has
// no effect on mail processing when the binding is absent or freeq-drain is down.
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import type { Env } from "./env";

export const FREEQ_KICK_URL = "https://freeq-drain/internal/drain/kick";
export const FREEQ_KICK_TIMEOUT_MS = 5_000;

export type FreeqKickResult = "kicked" | "no_binding" | "failed";

export async function kickFreeqDrain(env: Pick<Env, "SVC_FREEQ_DRAIN">): Promise<FreeqKickResult> {
  const svc = env.SVC_FREEQ_DRAIN;
  if (!svc) return "no_binding";
  try {
    const res = await svc.fetch(FREEQ_KICK_URL, {
      method: "POST",
      headers: { [HDR_INTERNAL]: INTERNAL_HEADER_VALUE },
      signal: AbortSignal.timeout(FREEQ_KICK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`freeq-drain kick returned ${res.status}`);
      return "failed";
    }
    return "kicked";
  } catch (err) {
    console.warn(`freeq-drain kick failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}
