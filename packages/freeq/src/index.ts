// @dub/freeq — free-tier mini-queue (D1 outbox). Producer INSERT + Cron/DO drain
// with at-least-once delivery, exponential backoff, and a terminal failed state.
export {
  OUTBOX_TABLE,
  OUTBOX_DDL,
  enqueue,
  drain,
  ensureOutbox,
  pruneOutbox,
  nowIso,
  type OutboxStatus,
  type OutboxRow,
  type OutboxMessage,
  type EnqueueOptions,
  type Deliver,
  type DrainOptions,
  type DrainResult,
  type PruneOptions,
  type PruneResult,
} from "./outbox";
export { backoffMs, type BackoffOptions } from "./backoff";
