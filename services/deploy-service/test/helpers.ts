// Test doubles: in-memory repo, fake CF client, capturing audit/event gateways,
// and a fake identity Service Binding so the REAL @dub/auth-client authz path runs.
import { vi } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { createAuthClient } from "@dub/auth-client";
import { newId, nowIso } from "@dub/db";
import type { identity } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type {
  DeployRepo,
  SiteRow,
  DeploymentRow,
  AllowedZoneRow,
  DnsChangeInput,
  ListDeploymentsArgs,
} from "../src/repo";
import type { CfClient } from "../src/cf-client";
import type { AuditGateway, IntentInput, ResultInput } from "../src/audit";
import type { EventBus } from "../src/events";
import type { Deps } from "../src/deps";
import { SERVICE_NAME } from "../src/deps";
import type { DeployJobMessage } from "../src/jobs";
import type { Env } from "../src/env";

// ---- in-memory repo ----
export function createInMemoryRepo(): DeployRepo & {
  sites: SiteRow[];
  deployments: DeploymentRow[];
  allowedZones: AllowedZoneRow[];
  dnsChanges: DnsChangeInput[];
} {
  const sites: SiteRow[] = [];
  const deployments: DeploymentRow[] = [];
  const allowedZones: AllowedZoneRow[] = [];
  const dnsChanges: DnsChangeInput[] = [];

  function cmpDesc(a: DeploymentRow, b: DeploymentRow): number {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  }

  return {
    sites,
    deployments,
    allowedZones,
    dnsChanges,
    async createSite(input) {
      const now = nowIso();
      const row: SiteRow = { id: newId("site"), ...input, createdAt: now, updatedAt: now };
      sites.push(row);
      return row;
    },
    async getSite(id) {
      return sites.find((s) => s.id === id) ?? null;
    },
    async getSiteByName(name) {
      return sites.find((s) => s.name === name) ?? null;
    },
    async listSites() {
      return [...sites];
    },
    async createDeployment(input) {
      const now = nowIso();
      const row: DeploymentRow = {
        id: newId("dep"),
        siteId: input.siteId,
        cfDeploymentId: null,
        status: "queued",
        branch: input.branch,
        commitSha: input.commitSha,
        url: null,
        requestedBy: input.requestedBy,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      };
      deployments.push(row);
      return row;
    },
    async getDeployment(id) {
      return deployments.find((d) => d.id === id) ?? null;
    },
    async listDeployments(args: ListDeploymentsArgs) {
      let rows = [...deployments].sort(cmpDesc);
      if (args.siteId) rows = rows.filter((d) => d.siteId === args.siteId);
      if (args.status) rows = rows.filter((d) => d.status === args.status);
      if (args.cursor) {
        const decoded = Buffer.from(args.cursor, "base64url").toString("utf8").split("|");
        const [ca, id] = decoded;
        rows = rows.filter((d) => d.createdAt < ca! || (d.createdAt === ca && d.id < id!));
      }
      const page = rows.slice(0, args.limit);
      const hasMore = rows.length > args.limit;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? Buffer.from(`${last.createdAt}|${last.id}`, "utf8").toString("base64url") : null;
      return { rows: page, nextCursor };
    },
    async hasActiveDeployment(siteId) {
      return deployments.some((d) => d.siteId === siteId && (d.status === "queued" || d.status === "building"));
    },
    async updateDeployment(id, patch) {
      const row = deployments.find((d) => d.id === id);
      if (!row) return;
      Object.assign(row, patch, { updatedAt: nowIso() });
    },
    async isZoneAllowed(zone) {
      return allowedZones.some((z) => z.zoneId === zone || z.zoneName === zone);
    },
    async listAllowedZones() {
      return [...allowedZones];
    },
    async recordDnsChange(input) {
      dnsChanges.push(input);
    },
  };
}

// ---- fake CF client ----
export interface FakeCfOptions {
  pagesResult?: { cfDeploymentId: string; status: "queued" | "building" | "live" | "failed"; url: string | null };
  pagesThrows?: Error;
  dnsThrows?: Error;
  zones?: Array<{ zoneId: string; zoneName: string; status: "active" | "pending" | "moved"; registrarManaged: boolean }>;
}
export function createFakeCf(opts: FakeCfOptions = {}): CfClient & {
  createPagesDeployment: ReturnType<typeof vi.fn>;
  getPagesDeployment: ReturnType<typeof vi.fn>;
  createDnsRecord: ReturnType<typeof vi.fn>;
  listZones: ReturnType<typeof vi.fn>;
} {
  const createPagesDeployment = vi.fn(async () => {
    if (opts.pagesThrows) throw opts.pagesThrows;
    return opts.pagesResult ?? { cfDeploymentId: "cfdep_1", status: "live" as const, url: "https://x.pages.dev" };
  });
  const getPagesDeployment = vi.fn(async () => {
    return opts.pagesResult ?? { cfDeploymentId: "cfdep_1", status: "live" as const, url: "https://x.pages.dev" };
  });
  const createDnsRecord = vi.fn(async (input: { zone: string; type: string; name: string; content: string }) => {
    if (opts.dnsThrows) throw opts.dnsThrows;
    return { id: "cfrec_1", zone: input.zone, type: input.type, name: input.name, content: input.content };
  });
  const listZones = vi.fn(async () => opts.zones ?? []);
  return { createPagesDeployment, getPagesDeployment, createDnsRecord, listZones };
}

// ---- capturing audit gateway ----
export interface CapturedIntent extends IntentInput {
  ctx: RequestContext;
}
export interface CapturedResult extends ResultInput {
  ctx: RequestContext;
}
export function createFakeAudit(opts: { intentThrows?: Error; intentId?: string } = {}): AuditGateway & {
  intents: CapturedIntent[];
  results: CapturedResult[];
  recordIntent: ReturnType<typeof vi.fn>;
  recordResult: ReturnType<typeof vi.fn>;
} {
  const intents: CapturedIntent[] = [];
  const results: CapturedResult[] = [];
  const recordIntent = vi.fn(async (ctx: RequestContext, input: IntentInput) => {
    if (opts.intentThrows) throw opts.intentThrows;
    intents.push({ ctx, ...input });
    return opts.intentId ?? "aud_intent_1";
  });
  const recordResult = vi.fn(async (ctx: RequestContext, input: ResultInput) => {
    results.push({ ctx, ...input });
  });
  return { intents, results, recordIntent, recordResult };
}

// ---- capturing event bus ----
export interface CapturedEvent {
  kind: "deployment" | "dns";
  ctx: { requestId: string; actorId: string | null };
  payload: Record<string, unknown>;
}
export function createFakeEvents(): EventBus & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    async deploymentStatusChanged(ctx, payload) {
      events.push({ kind: "deployment", ctx, payload });
    },
    async dnsRecordChanged(ctx, payload) {
      events.push({ kind: "dns", ctx, payload });
    },
  };
}

// ---- fake identity Service Binding (drives the REAL auth-client authz path) ----
export function createFakeIdentityBinding(permsByUser: Record<string, string[]>): {
  binding: Fetcher;
  calls: identity.AuthzCheckRequest[];
} {
  const calls: identity.AuthzCheckRequest[] = [];
  const binding = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname !== "/authz/check") return new Response("not found", { status: 404 });
      const body = (await req.json()) as identity.AuthzCheckRequest;
      calls.push(body);
      const granted = new Set(permsByUser[body.subjectUserId] ?? []);
      const decisions: identity.AuthzDecision[] = body.checks.map((q) => ({
        allowed: granted.has(q.permission),
        evaluatedAt: nowIso(),
        ttlSeconds: 60,
      }));
      return new Response(JSON.stringify({ decisions } satisfies identity.AuthzCheckResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Fetcher;
  return { binding, calls };
}

// ---- deps assembly ----
export interface TestDeps extends Deps {
  repo: ReturnType<typeof createInMemoryRepo>;
  cf: ReturnType<typeof createFakeCf>;
  audit: ReturnType<typeof createFakeAudit>;
  events: ReturnType<typeof createFakeEvents>;
  jobs: DeployJobMessage[];
  identityCalls: identity.AuthzCheckRequest[];
}

export function makeTestDeps(config: {
  perms: Record<string, string[]>;
  cf?: FakeCfOptions;
  audit?: { intentThrows?: Error; intentId?: string };
} ): TestDeps {
  const repo = createInMemoryRepo();
  const cf = createFakeCf(config.cf);
  const audit = createFakeAudit(config.audit);
  const events = createFakeEvents();
  const jobs: DeployJobMessage[] = [];
  const { binding, calls } = createFakeIdentityBinding(config.perms);
  const auth = createAuthClient({ identityBinding: binding, serviceName: SERVICE_NAME });
  return {
    repo,
    cf,
    audit,
    events,
    auth,
    jobs,
    identityCalls: calls,
    async enqueueJob(msg) {
      jobs.push(msg);
    },
  };
}

export const DUMMY_ENV = {} as unknown as Env;

export function req(
  path: string,
  opts: { method?: string; userId?: string; requestId?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {
    "x-dub-request-id": opts.requestId ?? "req_test_1",
  };
  if (opts.userId) headers["x-dub-user-id"] = opts.userId;
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return new Request(`https://svc${path}`, init);
}

export function fakeBatch(messages: DeployJobMessage[]): {
  batch: { messages: Array<{ body: DeployJobMessage; ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }> };
  acks: number[];
  retries: number[];
} {
  const acks: number[] = [];
  const retries: number[] = [];
  const wrapped = messages.map((body, i) => ({
    body,
    ack: vi.fn(() => acks.push(i)),
    retry: vi.fn(() => retries.push(i)),
  }));
  return { batch: { messages: wrapped }, acks, retries };
}
