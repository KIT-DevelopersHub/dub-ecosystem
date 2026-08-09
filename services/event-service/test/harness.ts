// Test harness: builds AppDeps around the in-memory repo with injectable fakes
// for authz, publisher, audit and task-service. Lets tests drive the real Hono
// app end-to-end without D1 / Service Bindings / Queues.
import type { MiddlewareHandler, Context } from "hono";
import { DubError, CommonErrorCodes, errors } from "@dub/errors";
import type { common, identity, auditLog } from "@dub/types";
import type { DubEventName, DubEventPayloadMap } from "@dub/events";
import { createApp } from "../src/app";
import { InMemoryEventRepo } from "../src/memory-repo";
import type { AppDeps, Authz, EventPublisher, AuditSink, TaskClient } from "../src/types";

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

// Authz that grants a fixed permission set. requireAuth enforces x-dub-user-id.
export function fakeAuthz(granted: Set<identity.PermissionKey>): Authz {
  return {
    requireAuth(): MiddlewareHandler {
      return async (c, next) => {
        const userId = c.req.header("x-dub-user-id");
        if (!userId) throw new DubError("AUTH_INVALID_TOKEN", "x-dub-user-id absent", { status: 401 });
        await next();
      };
    },
    requirePermission(
      permission: identity.PermissionKey,
      _resolve?: (c: Context) => { orgId?: string; resourceType?: string; resourceId?: string },
    ): MiddlewareHandler {
      return async (_c, next) => {
        if (!granted.has(permission)) {
          throw new DubError(CommonErrorCodes.FORBIDDEN, `permission denied: ${permission}`, { status: 403 });
        }
        await next();
      };
    },
    async hasPermission(_userId, _orgId, query: identity.AuthzQuery): Promise<boolean> {
      return granted.has(query.permission);
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
    authz: fakeAuthz(new Set(["event:read", "event:write", "event:admin"])),
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
