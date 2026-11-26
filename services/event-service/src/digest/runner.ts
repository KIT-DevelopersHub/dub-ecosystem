// One digest run: collect (read-only) -> diff -> provider (changed sources only) ->
// keep only cited lines -> discrepancies -> store. Pure of HTTP; used by the manual
// 「今すぐ要約」 route and the DO alarm alike.
import type { event } from "@dub/types";
import { changedSources, hashAll } from "./diff";
import { findDiscrepancies } from "./discrepancy";
import { redactPii } from "./pii";
import { mapActions, mapEvent } from "./collectors";
import { ProviderOfflineError, type CollectCtx, type DigestDeps, type DigestEventFacts, type SourceSnapshot } from "./types";
import type { EventRow, ActionRow, EventDetailsData } from "../types";

export const MAX_DIGEST_LINES = 30;
const MAX_LINE_CHARS = 300;

export function eventFacts(ev: EventRow): DigestEventFacts {
  return { id: ev.id, title: ev.title, startsAt: ev.startsAt, venue: ev.venue ?? null, capacity: ev.capacity ?? null };
}

export async function collectAll(
  deps: DigestDeps,
  ev: EventRow,
  actions: ActionRow[],
  details: EventDetailsData | null,
  ctx: CollectCtx,
): Promise<SourceSnapshot[]> {
  const local = [mapEvent(ev, details), mapActions(ev.id, actions)];
  const remote = await Promise.all(deps.collectors.map((c) => c.collect(ctx).catch(() => null)));
  return [...local, ...remote.filter((s): s is SourceSnapshot => s !== null)];
}

/** Drop any line whose link is not one the collectors produced (no uncited text), re-redact, bound. */
export function sanitizeLines(lines: event.EventDigestLine[], snaps: SourceSnapshot[]): event.EventDigestLine[] {
  const known = new Set(snaps.flatMap((s) => s.items.map((i) => i.link)));
  return lines
    .filter((l) => l && typeof l.text === "string" && typeof l.link === "string" && known.has(l.link))
    .map((l) => ({ text: redactPii(l.text.slice(0, MAX_LINE_CHARS)), source: l.source, link: l.link }))
    .filter((l) => l.text.trim() !== "")
    .slice(0, MAX_DIGEST_LINES);
}

export interface RunOutcome {
  ran: boolean;
  changedSources: event.EventDigestSourceKind[];
  digest: event.EventDigest | null;
}

export async function runDigest(
  deps: DigestDeps,
  input: {
    ev: EventRow;
    actions: ActionRow[];
    details: EventDetailsData | null;
    ctx: CollectCtx;
    trigger: "manual" | "schedule";
  },
): Promise<RunOutcome> {
  const { ev, ctx } = input;
  const snaps = await collectAll(deps, ev, input.actions, input.details, ctx);
  const current = await hashAll(snaps);
  const previousHashes = await deps.repo.getSourceHashes(ev.id);
  const previous = await deps.repo.getDigest(ev.id);
  const changed = changedSources(previousHashes, current);
  if (changed.length === 0 && previous) return { ran: false, changedSources: [], digest: previous };

  if ((await deps.provider.status()) !== "online") throw new ProviderOfflineError();
  const facts = eventFacts(ev);
  const changedSet = new Set<string>(changed);
  const lines = await deps.provider.summarize({
    event: facts,
    changed: snaps.filter((s) => changedSet.has(s.source)),
    all: snaps,
    previous,
  });
  const digest: event.EventDigest = {
    eventId: ev.id,
    lines: sanitizeLines(lines, snaps),
    discrepancies: findDiscrepancies(facts, snaps),
    model: deps.provider.id,
    trigger: input.trigger,
    generatedAt: ctx.now,
  };
  await deps.repo.saveDigest(digest, ctx.now);
  const changedHashes = Object.fromEntries(changed.map((k) => [k, current[k]!]));
  await deps.repo.saveSourceHashes(ev.id, changedHashes, ctx.now);
  return { ran: true, changedSources: changed, digest };
}
