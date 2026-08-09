// Offline mutation replay (POST /m/v1/mutations). A client that acted while
// offline replays its queued writes here as one batch. Each mutation carries a
// client-minted idempotencyKey and is applied to the owning master service by
// forwarding to the very same routes the transparent proxy exposes — MO3 adds no
// business logic, it only fans the batch out and reports per-mutation outcomes.
//
// Idempotency: the key is (a) deduped within the batch so a replayed batch never
// double-applies, and (b) forwarded downstream as x-dub-idempotency-key so the
// owning service dedupes/retries across separate requests. Durable cross-request
// dedup (mobile_mutations table) lands with the offline wave (#28); the header
// contract is wired now so it is transparent when that table exists.
//
// Conflict handling: an optimistic-lock 409 from a service is captured as that
// mutation's result (status "conflict") and the batch continues — one stale
// write never blocks the rest of the replay. The client reconciles conflicts
// against the fresh snapshot it gets from /sync.
import type { ServiceClient, RequestContext, CallOptions } from "@dub/http";
import { errors, isDubError } from "@dub/errors";
import { mobileErrors } from "./errors";

/** Same three services the proxy/sync surfaces route to. */
export interface MutationSinks {
  event: ServiceClient;
  task: ServiceClient;
  notification: ServiceClient;
}

/** Supported offline operations (open registry; unknown ops fail per-mutation). */
export type MutationOp = "task.update" | "action.update" | "inbox.read" | "inbox.readAll";

export interface MutationInput {
  idempotencyKey: string;
  op: MutationOp;
  id?: string; // target resource id (task/action/inbox item)
  patch?: Record<string, unknown>; // body for update ops (carries `version`)
}

export interface MutationsRequest {
  mutations: MutationInput[];
}

export type MutationStatus = "applied" | "conflict" | "duplicate" | "error";

export interface MutationResult {
  idempotencyKey: string;
  status: MutationStatus;
  resource?: unknown; // present when applied
  error?: { code: string; message: string }; // present on conflict/error
}

export interface MutationsResponse {
  results: MutationResult[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Route one mutation to its owning service; returns the service's response. */
function dispatch(sinks: MutationSinks, ctx: RequestContext, m: MutationInput, opts: CallOptions): Promise<unknown> {
  const patch = m.patch ?? {};
  switch (m.op) {
    case "task.update":
      return sinks.task.patch(ctx, `/tasks/${requireId(m)}`, patch, opts);
    case "action.update":
      return sinks.event.patch(ctx, `/actions/${requireId(m)}`, patch, opts);
    case "inbox.read":
      return sinks.notification.patch(ctx, `/inbox/${requireId(m)}/read`, {}, opts);
    case "inbox.readAll":
      return sinks.notification.post(ctx, "/inbox/read-all", {}, opts);
    default:
      throw mobileErrors.mutationUnsupportedType((m as MutationInput).op);
  }
}

function requireId(m: MutationInput): string {
  if (!isNonEmptyString(m.id)) {
    throw errors.validationFailed([{ field: "id", reason: "required" }]);
  }
  return m.id;
}

function toError(err: unknown): { code: string; message: string } {
  if (isDubError(err)) return { code: err.code, message: err.message };
  return { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Apply a batch of offline mutations. Structural problems with the envelope
 * (mutations not an array) reject the whole request; everything else — bad
 * fields, unsupported op, conflicts, upstream errors — is isolated to the single
 * mutation so the rest of the replay still lands.
 */
export async function applyMutations(
  sinks: MutationSinks,
  ctx: RequestContext,
  req: MutationsRequest,
): Promise<MutationsResponse> {
  if (!req || !Array.isArray(req.mutations)) {
    throw errors.validationFailed([{ field: "mutations", reason: "required" }]);
  }

  const results: MutationResult[] = [];
  const seen = new Map<string, MutationResult>();

  for (const m of req.mutations) {
    // Per-mutation validation: never abort the batch for one bad entry.
    if (!m || !isNonEmptyString(m.idempotencyKey) || !isNonEmptyString(m.op)) {
      results.push({
        idempotencyKey: isNonEmptyString(m?.idempotencyKey) ? m.idempotencyKey : "",
        status: "error",
        error: { code: "VALIDATION_FAILED", message: "idempotencyKey and op are required" },
      });
      continue;
    }

    // Within-batch idempotency: a replayed key reuses the first outcome, never
    // re-hitting the service.
    const prior = seen.get(m.idempotencyKey);
    if (prior) {
      results.push({ ...prior, status: "duplicate" });
      continue;
    }

    let result: MutationResult;
    try {
      const resource = await dispatch(sinks, ctx, m, { idempotencyKey: m.idempotencyKey });
      result = { idempotencyKey: m.idempotencyKey, status: "applied", resource };
    } catch (err) {
      const conflict = isDubError(err) && err.status === 409;
      result = {
        idempotencyKey: m.idempotencyKey,
        status: conflict ? "conflict" : "error",
        error: toError(err),
      };
    }

    seen.set(m.idempotencyKey, result);
    results.push(result);
  }

  return { results };
}
