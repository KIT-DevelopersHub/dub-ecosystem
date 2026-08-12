// Release notes — broadcast a "🎉 new feature" announcement to every active user's
// inbox. One publish path (publishRelease) is shared by the admin endpoint
// (POST /release) and the internal seed route (POST /internal/seed-releases), so
// ad-hoc and curated releases deliver identically (in_app, forced, org-wide fan-out).
import type { RequestContext } from "@dub/http";
import { ingest, type IngestDeps } from "./ingest";
import type { IngestInput, IngestResult } from "./types";
import { INITIAL_RELEASE_NOTES, RELEASE_NOTIFY_TYPE, type ReleaseNoteSeed } from "./config";

export interface ReleaseInput {
  title: string;
  body: string;
  app?: string; // target app / area (optional; shown as meta + prefixed line)
  publishedAt?: string; // ISO8601 (optional; defaults to now at ingest time)
  dedupKey?: string; // stable idempotency key; defaults to a title hash
}

// Deterministic short hash (djb2) for a default dedup key when none is supplied, so a
// double-submit of the same title/app never creates two inbox broadcasts.
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Build the broadcast IngestInput for a release note (in_app only, all active users). */
export function buildReleaseInput(input: ReleaseInput, requestId: string, actorId: string | null): IngestInput {
  const app = input.app?.trim() || undefined;
  const dedupKey = input.dedupKey ?? `release:${shortHash(`${app ?? ""}|${input.title}`)}`;
  const meta: Record<string, string> = {};
  if (app) meta.app = app;
  if (input.publishedAt) meta.publishedAt = input.publishedAt;
  return {
    type: RELEASE_NOTIFY_TYPE,
    recipients: { all: true },
    title: input.title,
    body: input.body,
    priority: "normal",
    channels: ["in_app"], // release notes live in the inbox; forced on regardless of prefs
    dedupKey,
    resourceType: "release",
    resourceId: null,
    meta,
    source: "api",
    actorId,
    requestId,
  };
}

/** Publish one release note to every active user's inbox. Idempotent via dedupKey. */
export async function publishRelease(
  deps: IngestDeps,
  ctx: RequestContext,
  input: ReleaseInput,
  actorId: string | null,
): Promise<IngestResult> {
  return ingest(deps, buildReleaseInput(input, ctx.requestId, actorId));
}

/** Convert a curated seed note into a ReleaseInput (stable dedup key from its `key`). */
export function seedToReleaseInput(note: ReleaseNoteSeed): ReleaseInput {
  return { title: note.title, body: note.body, app: note.app, dedupKey: `release:seed:${note.key}` };
}

export interface SeedReleasesResult {
  published: number; // notes that created a new broadcast
  deduplicated: number; // notes already present (idempotent re-run)
  total: number;
}

/** (Re)publish the curated back-catalog. Safe to call repeatedly — each note is keyed
 *  so an already-seeded release is reported as deduplicated, never duplicated. */
export async function seedInitialReleases(
  deps: IngestDeps,
  ctx: RequestContext,
  actorId: string | null,
  notes: ReleaseNoteSeed[] = INITIAL_RELEASE_NOTES,
): Promise<SeedReleasesResult> {
  let published = 0;
  let deduplicated = 0;
  for (const note of notes) {
    const res = await publishRelease(deps, ctx, seedToReleaseInput(note), actorId);
    if (res.deduplicated) deduplicated++;
    else published++;
  }
  return { published, deduplicated, total: notes.length };
}
