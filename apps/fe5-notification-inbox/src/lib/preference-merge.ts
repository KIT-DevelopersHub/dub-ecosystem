// Preference merge + longest-match resolution + diff (pure, framework-free).
//
// Rules (P0b frozen, FE5 §2-2 / test 11,12):
//   - A preference row is keyed by a `type` pattern: exact ("task.assigned"),
//     prefix ("task.*" or "task."), or global ("*").
//   - Effective channels for a concrete type resolve by LONGEST match:
//     exact > prefix > "*". On equal specificity, overrides win over defaults.
//   - The matrix shows one row per distinct pattern (defaults ∪ overrides);
//     an override for the same pattern replaces the default row.
//   - PATCH sends only the diff (rows whose channel set changed vs. the merged
//     baseline the user started from).

import type { NotificationChannel, PreferenceEntry } from "../contracts/notification-api";

export type PreferenceSource = "default" | "override";

export interface MergedPreference {
  type: string; // pattern/row key
  channels: NotificationChannel[];
  source: PreferenceSource;
  overridden: boolean; // an override row exists for this exact pattern
}

// Normalise a pattern to its prefix form for matching. Returns:
//   { kind:"all" } | { kind:"prefix", prefix } | { kind:"exact", value }
type ParsedPattern =
  | { kind: "all" }
  | { kind: "prefix"; prefix: string }
  | { kind: "exact"; value: string };

export function parsePattern(pattern: string): ParsedPattern {
  if (pattern === "*") return { kind: "all" };
  if (pattern.endsWith(".*")) return { kind: "prefix", prefix: pattern.slice(0, -1) }; // "task.*" -> "task."
  if (pattern.endsWith(".")) return { kind: "prefix", prefix: pattern }; // "task." -> "task."
  return { kind: "exact", value: pattern };
}

// Does `pattern` match the concrete `type`? Returns specificity (higher = more
// specific), or -1 for no match. Exact match dominates any prefix; "*" is 0.
export function matchSpecificity(pattern: string, type: string): number {
  const p = parsePattern(pattern);
  switch (p.kind) {
    case "all":
      return 0;
    case "prefix":
      return type.startsWith(p.prefix) ? p.prefix.length : -1;
    case "exact":
      // Exact wins over any prefix of the same textual length: big offset.
      return p.value === type ? p.value.length + 1_000_000 : -1;
  }
}

// Resolve the effective channels for a concrete `type` by longest match across
// defaults + overrides. Overrides win on equal specificity.
export function resolveEffectiveChannels(
  type: string,
  defaults: PreferenceEntry[],
  overrides: PreferenceEntry[],
): NotificationChannel[] {
  let best: { spec: number; fromOverride: boolean; channels: NotificationChannel[] } | null = null;
  const consider = (entry: PreferenceEntry, fromOverride: boolean): void => {
    const spec = matchSpecificity(entry.type, type);
    if (spec < 0) return;
    if (
      best === null ||
      spec > best.spec ||
      (spec === best.spec && fromOverride && !best.fromOverride)
    ) {
      best = { spec, fromOverride, channels: entry.channels };
    }
  };
  for (const d of defaults) consider(d, false);
  for (const o of overrides) consider(o, true);
  return best ? [...(best as { channels: NotificationChannel[] }).channels] : [];
}

// Build the matrix row list: one row per distinct pattern; override replaces the
// default row for the same pattern (and is flagged `overridden`).
export function mergePreferences(
  defaults: PreferenceEntry[],
  overrides: PreferenceEntry[],
): MergedPreference[] {
  const overrideByType = new Map(overrides.map((o) => [o.type, o]));
  const seen = new Set<string>();
  const rows: MergedPreference[] = [];

  for (const d of defaults) {
    seen.add(d.type);
    const ov = overrideByType.get(d.type);
    rows.push(
      ov
        ? { type: d.type, channels: [...ov.channels], source: "override", overridden: true }
        : { type: d.type, channels: [...d.channels], source: "default", overridden: false },
    );
  }
  // Overrides for patterns not present in defaults become their own rows.
  for (const o of overrides) {
    if (seen.has(o.type)) continue;
    rows.push({ type: o.type, channels: [...o.channels], source: "override", overridden: true });
  }
  return rows;
}

function sameChannelSet(a: NotificationChannel[], b: NotificationChannel[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((c) => setB.has(c));
}

// Diff the edited rows against the baseline (merged rows the user started from).
// Only changed rows are returned as PreferenceEntry (the PATCH body entries).
export function diffPreferences(
  baseline: MergedPreference[],
  edited: MergedPreference[],
): PreferenceEntry[] {
  const baseByType = new Map(baseline.map((r) => [r.type, r.channels]));
  const out: PreferenceEntry[] = [];
  for (const row of edited) {
    const before = baseByType.get(row.type);
    if (!before || !sameChannelSet(before, row.channels)) {
      out.push({ type: row.type, channels: [...row.channels] });
    }
  }
  return out;
}

// Toggle one channel on a row, returning a new row (immutable update).
export function toggleChannel(
  row: MergedPreference,
  channel: NotificationChannel,
): MergedPreference {
  const has = row.channels.includes(channel);
  const channels = has
    ? row.channels.filter((c) => c !== channel)
    : [...row.channels, channel];
  return { ...row, channels, source: "override", overridden: true };
}
