// Digest-internal shapes. Wire shapes live in @dub/types (event namespace).
import type { event } from "@dub/types";

export type SourceKind = event.EventDigestSourceKind;

/** One already-filtered, already-redacted fact a collector hands to the provider. */
export interface DigestItem {
  source: SourceKind;
  /** Stable within the source (task id, ticket type id, …) — used for diffing. */
  key: string;
  text: string;
  /** Where the line points. Required: lines without a link are never shown. */
  link: string;
}

/** Values a source states about the event, compared against the event's own fields. */
export interface SourceFacts {
  startsAt?: string; // YYYY-MM-DD
  venue?: string;
  capacity?: number;
}

export interface SourceSnapshot {
  source: SourceKind;
  items: DigestItem[];
  facts?: SourceFacts;
  factsLink?: string;
}

export interface CollectCtx {
  requestId: string;
  /** Whose read permission the s2s calls carry (the admin on manual runs). */
  userId: string;
  eventId: string;
  now: string;
}

export interface Collector {
  source: SourceKind;
  /** null = source unavailable (binding absent / upstream error) — skipped, not "empty". */
  collect(ctx: CollectCtx): Promise<SourceSnapshot | null>;
}

export interface DigestEventFacts {
  id: string;
  title: string;
  startsAt: string | null;
  venue: string | null;
  capacity: number | null;
}

export interface SummarizeInput {
  event: DigestEventFacts;
  /** Sources whose content changed since the last run (the provider should focus here). */
  changed: SourceSnapshot[];
  /** Every available source (unchanged ones included, for context). */
  all: SourceSnapshot[];
  previous: event.EventDigest | null;
}

export interface AskInput {
  eventId: string;
  question: string;
  /** Lazily collected (only the fake provider needs it; the Mac mini keeps its own index). */
  context: () => Promise<SourceSnapshot[]>;
}

export interface AskOutput {
  answer: string;
  sources: { label: string; link: string }[];
}

/**
 * The pluggable LLM seam. Target implementation = the Mac mini local model behind the
 * relay DO (relay-provider.ts). NO external LLM provider exists in this codebase by
 * owner decision (#879): mail bodies / chat chatter / roster / ticket buyers never
 * reach any LLM, and when the Mac mini is down the feature shows 「停止中」 (no fallback).
 */
export interface LlmProvider {
  readonly id: string;
  status(): Promise<"online" | "offline">;
  summarize(input: SummarizeInput): Promise<event.EventDigestLine[]>;
  ask(input: AskInput): Promise<AskOutput>;
}

export class ProviderOfflineError extends Error {
  constructor(message = "AI provider offline") {
    super(message);
    this.name = "ProviderOfflineError";
  }
}

/** Repo port for the digest tables (event_ai_digests / event_ai_digest_sources). */
export interface DigestRepo {
  getDigest(eventId: string): Promise<event.EventDigest | null>;
  saveDigest(d: event.EventDigest, now: string): Promise<void>;
  getSourceHashes(eventId: string): Promise<Record<string, string>>;
  saveSourceHashes(eventId: string, hashes: Record<string, string>, now: string): Promise<void>;
}

export interface DigestDeps {
  /** Feature flag (EVENT_AI_DIGEST_ENABLED). Default OFF. */
  enabled: boolean;
  provider: LlmProvider;
  collectors: Collector[];
  repo: DigestRepo;
}
