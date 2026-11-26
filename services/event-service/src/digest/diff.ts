// Diff-only runs: each source's content is hashed; only sources whose hash moved since
// the last run are handed to the provider. Nothing moved => no LLM call, no D1 write.
import type { SourceSnapshot, SourceKind } from "./types";

/** Canonical JSON (sorted keys) so key order never fakes a change. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export async function hashSnapshot(s: SourceSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ items: s.items, facts: s.facts ?? null }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashAll(snaps: SourceSnapshot[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of snaps) out[s.source] = await hashSnapshot(s);
  return out;
}

/**
 * Sources whose hash differs from (or is absent in) `previous`. A source that was seen
 * before but is unavailable now is NOT a change: an upstream blip must not trigger a run.
 */
export function changedSources(previous: Record<string, string>, current: Record<string, string>): SourceKind[] {
  return Object.keys(current)
    .filter((k) => previous[k] !== current[k])
    .sort() as SourceKind[];
}
