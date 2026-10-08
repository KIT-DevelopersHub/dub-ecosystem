// Test harness: builds AppDeps around the in-memory repo with injectable fakes
// for authz, publisher, audit, realtime, event-service and file-meta. Drives the
// real Hono app end-to-end without D1 / Service Bindings / Queues — including the REAL
// policyGate over the real POLICY_TABLE, since the gate's only dependency is the
// PermissionGranter `fakeAuthz` below supplies.
import { errors } from "@dub/errors";
import type { common, identity, auditLog, chat } from "@dub/types";
import type { PermissionGranter } from "@dub/policy-gate";
import type { DubEventName, DubEventPayloadMap } from "@dub/events";
import { createApp } from "../src/app";
import { InMemoryChatRepo } from "../src/memory-repo";
import type { AppDeps, EventPublisher, AuditSink, RealtimePublisher, EventClient, FileClient, MemberClient } from "../src/types";

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

/** Team -> identity users, as member-service would answer (チーム単位メンション展開). */
export class FakeMemberClient implements MemberClient {
  calls: string[][] = [];
  constructor(private readonly byTeam: Record<string, common.UserId[]> = {}) {}
  async teamMemberUserIds(_ctx: unknown, teamIds: string[]): Promise<common.UserId[]> {
    this.calls.push([...teamIds]);
    const out = new Set<common.UserId>();
    for (const t of teamIds) for (const u of this.byTeam[t] ?? []) out.add(u);
    return [...out];
  }
}

export class FakeFileClient implements FileClient {
  calls: { messageId: string; fileIds: string[] }[] = [];
  async registerLinks(_ctx: unknown, messageId: common.MessageId, fileIds: common.FileId[]): Promise<void> {
    this.calls.push({ messageId, fileIds: [...fileIds] });
  }
}

/**
 * Stub `PermissionGranter` — the one authz port the service has. It answers exactly the
 * subset of the asked keys the (every) user holds, like identity's /authz/check, so a test
 * drives the REAL policyGate and the real POLICY_TABLE rather than a test-local re-reading of
 * them. Authentication is not its job: the gate 401s on a missing x-dub-user-id itself.
 *
 * Grant the ロール管理 tier keys (`app:chat:view` / `app:chat:edit`), not just the 詳細 keys —
 * every rule in POLICY_TABLE starts from `appLevel("chat", ...)`, so a set without them models
 * a role whose チャット is 無効 and reaches nothing.
 */
export function fakeAuthz(granted: Set<identity.PermissionKey>): PermissionGranter {
  return async (_userId, _orgId, keys) => keys.filter((k) => granted.has(k));
}

/** チャット = 編集 plus both 詳細 keys: the admin/maintainer row of the role matrix. */
export const ALL_CHAT_KEYS: identity.PermissionKey[] = [
  "app:chat:view",
  "app:chat:edit",
  "chat:create",
  "chat:moderate",
];

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
  memberClient: FakeMemberClient;
} {
  const repo = new InMemoryChatRepo();
  const publisher = new FakePublisher();
  const audit = new FakeAudit();
  const realtime = new FakeRealtime();
  const fileClient = new FakeFileClient();
  const memberClient = new FakeMemberClient();
  const deps: AppDeps = {
    repo,
    authz: fakeAuthz(new Set<identity.PermissionKey>(ALL_CHAT_KEYS)),
    publisher,
    audit,
    realtime,
    eventClient: new FakeEventClient(true),
    fileClient,
    memberClient,
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
    memberClient: deps.memberClient as FakeMemberClient,
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
