// Test harness: builds AppDeps around the in-memory repo with injectable fakes
// for authz, publisher, audit, realtime, event-service and file-meta. Drives the
// real Hono app end-to-end without D1 / Service Bindings / Queues.
import type { MiddlewareHandler, Context } from "hono";
import { DubError, CommonErrorCodes, errors } from "@dub/errors";
import type { common, identity, auditLog, chat } from "@dub/types";
import type { DubEventName, DubEventPayloadMap } from "@dub/events";
import { createApp } from "../src/app";
import { InMemoryChatRepo } from "../src/memory-repo";
import type { AppDeps, Authz, EventPublisher, AuditSink, RealtimePublisher, EventClient, FileClient } from "../src/types";

export interface PublishedEvent {
  name: DubEventName;
  payload: unknown;
  actorId: string | null;
  requestId: string;
}

export class FakePublisher implements EventPublisher {
  events: PublishedEvent[] = [];
  async publish<N extends DubEventName>(
    name: N,
    payload: DubEventPayloadMap[N],
    ctx: { requestId: string; actorId: string | null },
  ): Promise<void> {
    this.events.push({ name, payload, actorId: ctx.actorId, requestId: ctx.requestId });
  }
  namesFor(prefix: string): string[] {
    return this.events.map((e) => e.name).filter((n) => n.startsWith(prefix));
  }
  payloadsFor(name: string): unknown[] {
    return this.events.filter((e) => e.name === name).map((e) => e.payload);
  }
}

export class FakeAudit implements AuditSink {
  records: auditLog.AuditRecordInput[] = [];
  async record(input: auditLog.AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
  actions(): string[] {
    return this.records.map((r) => r.action);
  }
}

export class FakeRealtime implements RealtimePublisher {
  events: { channelId: string; event: chat.ChatRealtimeEvent }[] = [];
  async publishToChannel(channelId: common.ChannelId, event: chat.ChatRealtimeEvent): Promise<void> {
    this.events.push({ channelId, event });
  }
  kinds(): string[] {
    return this.events.map((e) => e.event.kind);
  }
}

export class FakeEventClient implements EventClient {
  constructor(public exists = true) {}
  async eventExists(): Promise<boolean> {
    return this.exists;
  }
}

export class FakeFileClient implements FileClient {
  calls: { messageId: string; fileIds: string[] }[] = [];
  async registerLinks(_ctx: unknown, messageId: common.MessageId, fileIds: common.FileId[]): Promise<void> {
    this.calls.push({ messageId, fileIds: [...fileIds] });
  }
}

// Authz granting a fixed permission set. requireAuth enforces x-dub-user-id.
export function fakeAuthz(granted: Set<identity.PermissionKey>): Authz {
  return {
    requireAuth(): MiddlewareHandler {
      return async (c, next) => {
        if (!c.req.header("x-dub-user-id")) throw new DubError("AUTH_INVALID_TOKEN", "x-dub-user-id absent", { status: 401 });
        await next();
      };
    },
    requirePermission(permission: identity.PermissionKey): MiddlewareHandler {
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
export function resetSeq(): void {
  seq = 0;
}

export function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps & {
  repo: InMemoryChatRepo;
  publisher: FakePublisher;
  audit: FakeAudit;
  realtime: FakeRealtime;
  fileClient: FakeFileClient;
} {
  const repo = new InMemoryChatRepo();
  const publisher = new FakePublisher();
  const audit = new FakeAudit();
  const realtime = new FakeRealtime();
  const fileClient = new FakeFileClient();
  const deps: AppDeps = {
    repo,
    authz: fakeAuthz(new Set<identity.PermissionKey>(["chat:create", "chat:moderate"])),
    publisher,
    audit,
    realtime,
    eventClient: new FakeEventClient(true),
    fileClient,
    orgId: "org_devhub",
    wsTicketSecret: "test-secret",
    doUrlBase: "wss://chat-rt.test/ws/:id",
    // deterministic, lexicographically increasing ids (ULID-like ordering).
    now: () => "2026-08-09T00:00:00.000Z",
    newChannelId: () => `chan_${String(seq++).padStart(6, "0")}`,
    newMessageId: () => `msg_${String(seq++).padStart(6, "0")}`,
    ...overrides,
  };
  // Expose the concrete handles that ended up on deps (respecting overrides).
  return Object.assign(deps, {
    repo: deps.repo as InMemoryChatRepo,
    publisher: deps.publisher as FakePublisher,
    audit: deps.audit as FakeAudit,
    realtime: deps.realtime as FakeRealtime,
    fileClient: deps.fileClient as FakeFileClient,
  });
}

export interface CallInit {
  userId?: string | null; // null = omit header (unauthenticated)
  internal?: boolean; // sets x-dub-internal
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
  if (init.query) for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, String(v));
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

export { createApp, InMemoryChatRepo, errors };
