// Test harness: builds AppDeps around the in-memory repo with injectable fakes
// for authz, publisher, audit and task-service. Lets tests drive the real Hono
// app end-to-end without D1 / Service Bindings / Queues.
import { errors } from "@dub/errors";
import type { PermissionGranter } from "@dub/policy-gate";
import type { common, identity, auditLog } from "@dub/types";
import type { DubEventName, DubEventPayloadMap } from "@dub/events";
import { createApp } from "../src/app";
import { InMemoryEventRepo } from "../src/memory-repo";
import type { AppDeps, ScopedAuthz, EventPublisher, AuditSink, TaskClient } from "../src/types";

export interface PublishedEvent {
  name: DubEventName;
  payload: unknown;
  actorId: string | null;
}

export class FakePublisher implements EventPublisher {
  events: PublishedEvent[] = [];
  async publish<N extends DubEventName>(
    name: N,
    payload: DubEventPayloadMap[N],
    ctx: { requestId: string; actorId: string | null },
  ): Promise<void> {
    this.events.push({ name, payload, actorId: ctx.actorId });
  }
  namesFor(prefix: string): string[] {
    return this.events.map((e) => e.name).filter((n) => n.startsWith(prefix));
  }
}

export class FakeAudit implements AuditSink {
  records: auditLog.AuditRecordInput[] = [];
  async record(input: auditLog.AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

export class FakeTaskClient implements TaskClient {
  constructor(public assignees: common.UserId[] = []) {}
  async listAssigneeIds(): Promise<common.UserId[]> {
    return this.assignees;
  }
}

// ---- authorization fakes ----
// Two deps, built from ONE key set so a test swaps both in a single override:
//   makeDeps({ ...fakeAuthz(VIEWER) })
// `authz` is policy-gate's PermissionGranter (layer 1: which keys does the caller hold
// org-wide — the question POLICY_TABLE is enforced through). `scopedAuthz` is layer 2, the
// instance-level port; `scopedTo` models a grant that applies to some event ids only, which
// is what identity's resource-scoped role assignments do.

/** The ロール管理 tier keys for イベント, which every POLICY_TABLE rule now also demands. */
export const APP_VIEW: identity.PermissionKey = "app:events:view";
export const APP_EDIT: identity.PermissionKey = "app:events:edit";

/** 編集 + every event key — the shape an admin/maintainer role carries. */
export const FULL: identity.PermissionKey[] = [APP_VIEW, APP_EDIT, "event:read", "event:write", "event:admin"];
/** 閲覧 only: can read every event route, no write anywhere. */
export const VIEWER: identity.PermissionKey[] = [APP_VIEW, "event:read"];
/** 編集 without event:admin — writes yes, archive and backward phase transitions no. */
export const EDITOR: identity.PermissionKey[] = [APP_VIEW, APP_EDIT, "event:read", "event:write"];

export function fakeAuthz(
  granted: Iterable<identity.PermissionKey>,
  opts: { scopedTo?: readonly string[] } = {},
): { authz: PermissionGranter; scopedAuthz: ScopedAuthz } {
  const held = new Set(granted);
  return {
    // Exactly identity's contract: return the subset of the requested keys the caller holds.
    authz: async (_userId, _orgId, keys) => keys.filter((k) => held.has(k)),
    scopedAuthz: {
      async hasPermission(_userId, _orgId, query: identity.AuthzQuery): Promise<boolean> {
        if (!held.has(query.permission)) return false;
        if (!opts.scopedTo) return true; // org-wide grant: applies to every event
        return query.resourceId !== undefined && opts.scopedTo.includes(query.resourceId);
      },
    },
  };
}

let seq = 0;
export function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps & {
  repo: InMemoryEventRepo;
  publisher: FakePublisher;
  audit: FakeAudit;
} {
  const repo = new InMemoryEventRepo();
  const publisher = new FakePublisher();
  const audit = new FakeAudit();
  const deps: AppDeps = {
    repo,
    ...fakeAuthz(FULL),
    publisher,
    audit,
    taskClient: new FakeTaskClient(),
    orgId: "org_devhub",
    // deterministic, lexicographically increasing ids (ULID-like ordering).
    now: () => "2026-08-09T00:00:00.000Z",
    newEventId: () => `event_${String(seq++).padStart(6, "0")}`,
    newActionId: () => `action_${String(seq++).padStart(6, "0")}`,
    ...overrides,
  };
  return Object.assign(deps, { repo, publisher, audit });
}

export interface CallInit {
  userId?: string | null; // null = omit header (unauthenticated)
  body?: unknown;
  query?: Record<string, string | number | boolean>;
  /** Send x-dub-internal, i.e. arrive like a genuine Service-Binding call (INTERNAL routes). */
  internal?: boolean;
}

export async function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  init: CallInit = {},
): Promise<{ status: number; json: any }> {
  const url = new URL(`http://svc${path}`);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { "x-dub-request-id": "req_test" };
  if (init.userId !== null) headers["x-dub-user-id"] = init.userId ?? "user_caller";
  if (init.internal) headers["x-dub-internal"] = "1";
  const reqInit: RequestInit = { method, headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    reqInit.body = JSON.stringify(init.body);
  }
  const res = await app.request(url.toString(), reqInit);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

export { createApp, InMemoryEventRepo, errors };
