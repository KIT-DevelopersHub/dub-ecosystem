// The poll cycle + flapping state machine. Pure `decide()` (unit-tested) computes the next
// state and whether to fire an alert; `runCheckCycle()` wires probes -> decide -> notify ->
// persist. Nothing here throws on a probe/notify failure — a target down is a normal outcome.
import { consoleSink } from "@dub/observability";
import { FAIL_THRESHOLD, SERVICE_NAME } from "./config";
import { checkFrontend } from "./frontend";
import { checkServices } from "./services";
import type { Env } from "./env";
import type { Notifier } from "./notify";
import type { MonitorRepo, StatusRow } from "./repo";
import type { CycleSummary, TargetResult, TargetState, TargetTransition } from "./types";

/** The flapping decision for one target. Pure. */
export function decide(prev: TargetState | null, result: TargetResult, nowIso: string): TargetTransition {
  if (result.status === "ok") {
    const next: TargetState = {
      targetId: result.id,
      status: "ok",
      consecutiveFails: 0,
      downSince: null,
      notified: false,
      lastError: null,
      lastCheckedAt: nowIso,
    };
    // Only clear if we had actually alerted for the current down streak.
    const fire = prev && prev.notified ? "recovery" : null;
    return { result, prev, next, fire };
  }

  const consecutiveFails = (prev?.consecutiveFails ?? 0) + 1;
  const downSince = prev && prev.status === "down" && prev.downSince ? prev.downSince : nowIso;
  let notified = prev?.notified ?? false;
  let fire: TargetTransition["fire"] = null;
  if (consecutiveFails >= FAIL_THRESHOLD && !notified) {
    fire = "down";
    notified = true;
  }
  const next: TargetState = {
    targetId: result.id,
    status: "down",
    consecutiveFails,
    downSince,
    notified,
    lastError: result.detail,
    lastCheckedAt: nowIso,
  };
  return { result, prev, next, fire };
}

export interface RunOptions {
  /** Synthetic targets appended to the real set (used by /internal/monitor/run for live proof
   *  of the down->alert->recovery pipeline without touching real deploys). */
  extraTargets?: TargetResult[];
  now?: Date;
  /** Override how the real target set is gathered (tests inject fixed results to avoid network). */
  gather?: (env: Env) => Promise<TargetResult[]>;
}

async function defaultGather(env: Env): Promise<TargetResult[]> {
  const [fe, svc] = await Promise.all([checkFrontend(env), checkServices(env)]);
  return [...fe, ...svc];
}

/** Run all probes, apply the state machine, fire alerts, persist. Returns a summary. */
export async function runCheckCycle(env: Env, repo: MonitorRepo, notifier: Notifier, opts: RunOptions = {}): Promise<CycleSummary> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  const gathered = await (opts.gather ?? defaultGather)(env);
  const results: TargetResult[] = [...gathered, ...(opts.extraTargets ?? [])];

  const states = await repo.loadStates();

  let down = 0;
  let firedDown = 0;
  let firedRecovery = 0;

  for (const result of results) {
    if (result.status === "down") down++;
    const prev = states.get(result.id) ?? null;
    const t = decide(prev, result, nowIso);

    // Fire BEFORE persisting `notified=true` so a notify crash (impossible — best-effort) can't
    // strand us as "notified" without an alert. Notifier is best-effort and never throws.
    if (t.fire === "down") {
      firedDown++;
      await notifier.down(result, t.next.downSince ?? nowIso);
      await repo.addIncident({ id: `inc_${cryptoId()}`, targetId: result.id, label: result.label, kind: "down", detail: result.detail, at: nowIso });
    } else if (t.fire === "recovery") {
      firedRecovery++;
      await notifier.recovery(result, prev?.downSince ?? nowIso);
      await repo.addIncident({ id: `inc_${cryptoId()}`, targetId: result.id, label: result.label, kind: "recovery", detail: result.detail, at: nowIso });
    }

    const row: StatusRow = { ...t.next, kind: result.kind, label: result.label };
    await repo.saveStatus(row);
  }

  const summary: CycleSummary = { checked: results.length, down, firedDown, firedRecovery, results };
  consoleSink({
    level: down > 0 ? "warn" : "info",
    message: "health poll cycle complete",
    service: SERVICE_NAME,
    fields: { checked: summary.checked, down: summary.down, firedDown, firedRecovery },
  });
  return summary;
}

function cryptoId(): string {
  // crypto.randomUUID is available in Workers + Node 24. Fallback keeps unit tests portable.
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}
