// event — event-service namespace. "Event > Action" hierarchy is absolute.
import type { EventId, ActionId, OrgId, ISODateTime, Versioned, Paginated, CursorQuery } from "./common";
import { APP_IDS, isCanonicalAppId, type AppId } from "./app-registry";

// EventPhase: closed union (D6). Change = contract-change process.
export type EventPhase = "planning" | "preparing" | "open" | "live" | "wrapup" | "closed";

// Phase transition table (server validation + FE3 PhaseTransitionControl single source).
// Forward (next adjacent) = event:write; wrapup->closed and back-transitions = event:admin.
// No transition out of closed (no reopen).
export const EVENT_PHASE_TRANSITIONS: Record<EventPhase, readonly EventPhase[]> = {
  planning: ["preparing"],
  preparing: ["open", "planning"],
  open: ["live", "preparing"],
  live: ["wrapup", "open"],
  wrapup: ["closed", "live"],
  closed: [],
};

export interface DubEvent extends Versioned {
  id: EventId;
  orgId: OrgId;
  title: string;
  description: string | null;
  phase: EventPhase;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  /** 会場 — the structured venue (source of truth; AI digests only read it). Additive. */
  venue?: string | null;
  /** 定員 — capacity in people (integer, 0..EVENT_CAPACITY_MAX). Additive. */
  capacity?: number | null;
  archivedAt: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Bounds for the structured venue / capacity fields (server validation + FE form). */
export const EVENT_VENUE_MAX_LENGTH = 200;
export const EVENT_CAPACITY_MAX = 100_000;

export interface DubAction extends Versioned {
  id: ActionId;
  eventId: EventId;
  kind: string; // action type (open registry; new types allowed freely)
  title: string;
  sortOrder: number;
  archivedAt: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// Summary/Detail owned here (D9); gateway/MO3 compose only.
export interface EventSummary {
  id: EventId;
  title: string;
  phase: EventPhase;
  startsAt: ISODateTime | null;
}
export interface EventDetail extends DubEvent {
  actions: ActionSummary[];
  /** Apps enabled for this event (resolved: a legacy event with no setting = every app). Additive. */
  enabledApps?: AppId[];
}
export interface ActionSummary {
  id: ActionId;
  eventId: EventId;
  kind: string;
  title: string;
}

export interface CreateEventRequest {
  title: string;
  description?: string;
  startsAt?: ISODateTime;
  endsAt?: ISODateTime;
  venue?: string | null;
  capacity?: number | null;
  /** Apps to enable for the new event. Omitted => EVENT_DEFAULT_ENABLED_APPS. */
  enabledApps?: AppId[];
}
export interface UpdateEventRequest extends Versioned {
  title?: string;
  description?: string | null;
  phase?: EventPhase; // validated against EVENT_PHASE_TRANSITIONS
  startsAt?: ISODateTime | null;
  endsAt?: ISODateTime | null;
  venue?: string | null;
  capacity?: number | null;
}
export interface ListEventsQuery extends CursorQuery {
  phase?: EventPhase;
  startsAfter?: ISODateTime;
  sort?: "startsAt";
  includeArchived?: boolean;
}
export type ListEventsResponse = Paginated<EventSummary>;
export type GetEventResponse = EventDetail;

// Action list contract (migrated here from fe3 actionContracts.ts per its GAP NOTE, so
// the query keys have a canonical SoT the wire contract below can bind to).
export interface ListActionsQuery extends CursorQuery {
  kind?: string;
  includeArchived?: boolean; // event-service reads it (q.includeArchived); additive.
}
export type ListActionsResponse = Paginated<DubAction>;

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* each event-service read
// endpoint puts on the wire. The FE client (apps/fe3 eventApi.ts), the server
// (event-service app.ts) and the OpenAPI spec (docs/openapi/event-service.yaml) all
// derive from — and are reconciled against — this one map in CI (see @dub/e2e-smoke
// wire-params.test.ts). Renaming a key here is the ONLY legitimate way to change a wire
// param; any side that disagrees turns a contract-conformance test red (unmergeable).
// `path` is the gateway path AFTER the /api/v1 prefix strip. See
// docs/api-contracts/_wire-contract-enforcement.md — do not hand-map keys elsewhere.
export const EVENT_WIRE = {
  listEvents: {
    method: "GET",
    path: "/events",
    query: ["cursor", "limit", "phase", "startsAfter", "sort", "includeArchived"],
  },
  listActions: {
    method: "GET",
    path: "/events/{id}/actions",
    query: ["cursor", "limit", "kind", "includeArchived"],
  },
} as const;

// Compile-time tie between the runtime descriptor and the typed query interfaces: every
// query key each endpoint lists must be a real key of its query type, so the descriptor
// and the hand-written types can never silently drift from each other.
type _EventWireKeysAreTyped =
  (typeof EVENT_WIRE.listEvents.query)[number] extends keyof ListEventsQuery
    ? (typeof EVENT_WIRE.listActions.query)[number] extends keyof ListActionsQuery
      ? true
      : never
    : never;
const _eventWireKeyGuard: _EventWireKeysAreTyped = true;
void _eventWireKeyGuard;

// ── AI digest + Q&A (#879) ───────────────────────────────────────────────────
// SINGLE source of truth for the digest wire shapes; event-service returns them and
// fe3 reads them. The digest is READ-ONLY over other apps: it never writes back, and
// the event's own fields (startsAt / venue / capacity) stay the source of truth — a
// mismatch is reported as a discrepancy, never "fixed" by the AI.

/** Where a digest line came from. Closed set: adding a source = contract change. */
export type EventDigestSourceKind =
  | "event"
  | "actions"
  | "tasks"
  | "tickets"
  | "lp"
  | "sponsors"
  | "meetings"
  | "chat"
  | "mail"
  | "drive";

export const EVENT_DIGEST_SOURCE_KINDS: readonly EventDigestSourceKind[] = [
  "event",
  "actions",
  "tasks",
  "tickets",
  "lp",
  "sponsors",
  "meetings",
  "chat",
  "mail",
  "drive",
];

/** One digest sentence. `link` is mandatory: a line without a source is never shown. */
export interface EventDigestLine {
  text: string;
  source: EventDigestSourceKind;
  /** In-app path (`/tasks/<id>`, `/chat?eventId=…`) or an absolute https URL. */
  link: string;
}

/** The event's own value disagrees with what a source says (e.g. LP date ≠ startsAt). */
export interface EventDigestDiscrepancy {
  field: "startsAt" | "venue" | "capacity";
  eventValue: string;
  sourceValue: string;
  source: EventDigestSourceKind;
  link: string;
}

export interface EventDigest {
  eventId: EventId;
  lines: EventDigestLine[];
  discrepancies: EventDigestDiscrepancy[];
  /** Provider/model id that wrote the text (e.g. "fake", "local:inkling-2-mini"). */
  model: string;
  trigger: "manual" | "schedule";
  generatedAt: ISODateTime;
}

/** disabled = feature flag off; offline = provider (Mac mini) not connected. */
export type EventAiProviderStatus = "disabled" | "offline" | "online";

/**
 * What can be shown without any LLM while the digest is OFF: the event's own facts and
 * actions as cited lines, plus deterministic 食い違い. Built on read, never stored.
 */
export interface EventDigestPreview {
  lines: EventDigestLine[];
  discrepancies: EventDigestDiscrepancy[];
  collectedAt: ISODateTime;
}

export interface GetEventDigestResponse {
  enabled: boolean;
  provider: { id: string; status: EventAiProviderStatus };
  digest: EventDigest | null;
  /** Present while enabled=false (no LLM involved). Absent/null otherwise. */
  preview?: EventDigestPreview | null;
}

export interface RunEventDigestResponse {
  /** false when nothing changed since the last run (no LLM call, no D1 write). */
  ran: boolean;
  changedSources: EventDigestSourceKind[];
  digest: EventDigest | null;
}

export interface AskEventRequest {
  question: string;
}
export const EVENT_ASK_QUESTION_MAX = 500;

export interface AskEventResponse {
  status: "answered" | "offline" | "disabled";
  answer: string | null;
  /** Every answer carries its sources; empty when not answered. */
  sources: { label: string; link: string }[];
}

// ── Per-event enabled apps ───────────────────────────────────────────────────
// Each event chooses which launcher apps it uses. SINGLE source of truth for the
// wire shapes, the default set and the normalizer; event-service validates with
// normalizeEnabledApps (via @dub/validation) and fe2/fe3 read the same helpers.
//
// Backward compatibility: an event with NO stored setting (every event created
// before this feature) resolves to EVERY app enabled — today's behaviour. Only a
// NEW event is created with EVENT_DEFAULT_ENABLED_APPS.

/** Apps a newly created event starts with: イベント・ガントチャート・ロール管理. */
export const EVENT_DEFAULT_ENABLED_APPS: readonly AppId[] = ["events", "gantt", "admin"];

/** Apps that cannot be turned off: イベント holds this very setting. */
export const EVENT_ALWAYS_ENABLED_APPS: readonly AppId[] = ["events"];

/**
 * Canonicalize a stored/requested app list: drop unknown ids and duplicates, add the
 * always-on apps, and return it in launcher order. `null`/`undefined` (no setting)
 * resolves to every app — the legacy "all enabled" state.
 */
export function resolveEnabledApps(apps: readonly string[] | null | undefined): AppId[] {
  if (apps === null || apps === undefined) return [...APP_IDS];
  const set = new Set<string>([...apps, ...EVENT_ALWAYS_ENABLED_APPS]);
  return APP_IDS.filter((id) => set.has(id));
}

/** True iff every entry is a canonical app id (the strict check a write applies). */
export function isEnabledAppList(v: unknown): v is AppId[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && isCanonicalAppId(x));
}

/** GET /events/{id}/apps and PUT /events/{id}/apps response. */
export interface EventAppsResponse {
  eventId: EventId;
  /** Resolved enabled set, in launcher order (always includes EVENT_ALWAYS_ENABLED_APPS). */
  enabledApps: AppId[];
  /** false = never configured (legacy event: every app enabled). */
  customized: boolean;
  updatedAt: ISODateTime | null;
}

/** PUT /events/{id}/apps body: the FULL enabled set (replace, not patch). */
export interface SaveEventAppsRequest {
  enabledApps: AppId[];
}
