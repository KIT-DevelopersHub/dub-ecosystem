# ADR-0003: Event payload versioning & compatibility policy

- Status: Accepted
- Date: 2026-08-10
- Deciders: DevHub (Dub) core
- Related: `@dub/events` catalog (frozen, theme#1 decision 1), E1 (requestId)

## Context

Services communicate asynchronously through Cloudflare Queues using a single canonical
event envelope defined in `@dub/events` (`packages/events/src/catalog.ts`). Producers and
consumers are deployed independently, so an event a consumer reads may have been produced
by an older or newer version of the producer. We need one explicit rule for how the
envelope and payloads evolve without a coordinated big-bang redeploy.

The canonical envelope is already frozen:

```ts
interface DubEventEnvelope<N extends DubEventName = DubEventName> {
  name: N;              // catalog key, e.g. "task.created"
  version: number;      // starts at 1; bump per name on breaking change
  id: string;           // ULID, producer-assigned; consumer idempotency key
  occurredAt: string;   // ISO 8601 UTC
  requestId: string;    // from x-dub-request-id
  actorId: string | null; // null = system (cron/webhook)
  payload: DubEventPayloadMap[N];
}
```

Notable existing choices:

- The event **name has no `.v1` suffix**; the numeric `version` field carries the version
  instead (`createEvent()` stamps `version: 1`).
- `id` is a producer-assigned ULID and is the **consumer idempotency key**.
- A **malformed envelope is a hard error** (`EVENTS_ENVELOPE_INVALID`, status 500) —
  the consumer wrapper validates `name` + basic shape before dispatch.
- The webhook channel has its own envelope `WebhookEventEnvelopeV1` (owned by
  `webhook-ingest` in `@dub/types`, `version: 1` literal), re-exported by `@dub/events`.

## Decision

1. **Version lives in the envelope's numeric `version` field, per event name.** The name
   stays stable (no `.v1` in the string); `version` starts at `1` and is bumped only on a
   **breaking** change to that name's payload.
2. **Additive changes do not bump the version.** Adding a new optional field to a payload is
   backward-compatible and keeps `version` unchanged.
3. **Consumers must be tolerant readers.** They read the fields they know and **ignore
   unknown fields** (forward compatibility). A consumer must never reject an event solely
   because it carries extra fields.
4. **A breaking change (rename/remove/retype a required field, or change required semantics)
   bumps `version` for that name.** During migration the producer may emit the old and new
   versions in parallel, or consumers branch on `version`, until all consumers have moved.
5. **Idempotency is mandatory** on the consumer side, keyed by envelope `id` (ULID). Queue
   delivery is at-least-once, so handlers must be safe to run twice.
6. **A structurally malformed envelope fails loud** (`EVENTS_ENVELOPE_INVALID`) rather than
   being silently dropped — it routes to the DLQ per the catalog's queue topology.
7. **`payload` shapes are owned by the producing namespace** and typed in
   `@dub/types` / `@dub/events` payloads; the catalog (`DubEventPayloadMap`) is the single
   source of truth for name → payload mapping.

## Consequences

- Positive: producers and consumers deploy independently; additive evolution is the common
  case and needs no coordination.
- Positive: replays and retries are safe because idempotency is keyed on a producer-minted
  ULID, not on delivery.
- Negative: the tolerant-reader rule is a discipline consumers must uphold in code (a strict
  schema validator that rejects unknown fields would violate this ADR). Reviews must guard it.
- Negative: parallel-emit during a version bump adds temporary producer complexity; kept rare
  by preferring additive changes.
- **(要確認)** `CONTRACT_VERSION` for the HTTP/type contracts is `1.0.0` and is a separate
  axis from per-event `version`; this ADR governs Queue events only, not HTTP contract SemVer.

## Alternatives considered

| Option | Why not |
|---|---|
| Version in the event name (`task.created.v2`) | Doubles the catalog surface and routing/subscription tables on every bump; the numeric field keeps one stable name. |
| Strict consumer schema (reject unknown fields) | Breaks forward compatibility — an additive producer change would start failing older consumers. Tolerant reader chosen instead. |
| No versioning (mutate payloads freely) | Silent breakage across independently-deployed services; unacceptable for at-least-once queues. |
| Exactly-once delivery | Not offered by the platform; idempotency-by-`id` is the pragmatic equivalent. |
