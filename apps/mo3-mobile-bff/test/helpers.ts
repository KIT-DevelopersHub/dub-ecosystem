// In-memory fakes for every dependency seam — no Cloudflare runtime required.
import type { RequestContext, ServiceClient, CallOptions } from "@dub/http";
import type { auth, auditLog, identity, mobile } from "@dub/types";
import type { Deps } from "../src/deps";
import type { AppConfig } from "../src/env";
import type { Authenticator, CapabilityScope } from "../src/authn";
import type { DeviceRecord, DeviceStore, UpsertDeviceInput, UpsertDeviceResult } from "../src/devices";
import type { DeliveryStatus, DeliveryStore } from "../src/deliveries";
import type { PushAdapter, SendResult } from "../src/push";
import type { ChangeLogEntry, ChangeLogReader, ChangeLogStore, DeleteTombstone } from "../src/change-log";
import type { MutationStore, SaveMutationInput } from "../src/mutation-store";
import type { MutationResult } from "../src/mutations";

export const GOOD_TOKEN = "tok_good";
export const ALICE = "usr_alice";

// ---- fake service client (records calls, routes by "METHOD path") ----
type RouteValue = unknown | Error | ((args: { path: string; body?: unknown; opts?: CallOptions }) => unknown);

export class FakeService implements ServiceClient {
  calls: { method: string; path: string; body?: unknown; opts?: CallOptions }[] = [];
  private routes = new Map<string, RouteValue>();

  on(method: string, path: string, value: RouteValue): this {
    this.routes.set(`${method} ${path}`, value);
    return this;
  }

  private async handle(method: string, path: string, body?: unknown, opts?: CallOptions): Promise<unknown> {
    this.calls.push({ method, path, body, opts });
    const key = `${method} ${path}`;
    if (this.routes.has(key)) {
      const v = this.routes.get(key);
      if (v instanceof Error) throw v;
      if (typeof v === "function") return await (v as (a: unknown) => unknown)({ path, body, opts });
      return v;
    }
    throw new Error(`FakeService: no route for ${key}`);
  }

  get<TRes>(_ctx: RequestContext, path: string, opts?: CallOptions): Promise<TRes> {
    return this.handle("GET", path, undefined, opts) as Promise<TRes>;
  }
  post<TRes>(_ctx: RequestContext, path: string, body: unknown, opts?: CallOptions): Promise<TRes> {
    return this.handle("POST", path, body, opts) as Promise<TRes>;
  }
  patch<TRes>(_ctx: RequestContext, path: string, body: unknown, opts?: CallOptions): Promise<TRes> {
    return this.handle("PATCH", path, body, opts) as Promise<TRes>;
  }
  delete<TRes>(_ctx: RequestContext, path: string, opts?: CallOptions): Promise<TRes> {
    return this.handle("DELETE", path, undefined, opts) as Promise<TRes>;
  }
}

// ---- fake authenticator ----
export class FakeAuthenticator implements Authenticator {
  verifyResult: auth.AuthVerifyResponse = {
    valid: true,
    userId: ALICE,
    session: { userId: ALICE, client: "mobile", sessionExpiresAt: Date.now() + 1_000_000 },
    reason: null,
  };
  caps: identity.PermissionKey[] = ["event:read", "task:read"];
  capabilityCalls: { userId: string; scope?: CapabilityScope }[] = [];

  async verify(): Promise<auth.AuthVerifyResponse> {
    return this.verifyResult;
  }
  async capabilities(_ctx: RequestContext, userId: string, _orgId: string, scope?: CapabilityScope): Promise<identity.PermissionKey[]> {
    this.capabilityCalls.push({ userId, scope });
    return this.caps;
  }
}

// ---- in-memory device store ----
export class MemoryDeviceStore implements DeviceStore {
  rows = new Map<string, DeviceRecord>();
  private seq = 0;

  async upsertByToken(input: UpsertDeviceInput): Promise<UpsertDeviceResult> {
    for (const rec of this.rows.values()) {
      if (rec.platform === input.platform && rec.pushToken === input.pushToken) {
        const replacedExisting = rec.userId !== input.userId;
        rec.userId = input.userId;
        rec.appVersion = input.appVersion ?? rec.appVersion;
        rec.locale = input.locale ?? rec.locale;
        rec.disabledAt = null;
        rec.lastSeenAt = new Date().toISOString();
        return { device: { ...rec }, replacedExisting };
      }
    }
    const id = `mdev_${++this.seq}`;
    const now = new Date().toISOString();
    const rec: DeviceRecord = {
      id,
      userId: input.userId,
      platform: input.platform,
      pushToken: input.pushToken,
      appVersion: input.appVersion ?? null,
      locale: input.locale ?? null,
      disabledAt: null,
      lastSeenAt: now,
      createdAt: now,
    };
    this.rows.set(id, rec);
    return { device: { ...rec }, replacedExisting: false };
  }

  async listActiveByUser(userId: string): Promise<DeviceRecord[]> {
    return [...this.rows.values()].filter((r) => r.userId === userId && r.disabledAt === null).map((r) => ({ ...r }));
  }
  async getById(id: string): Promise<DeviceRecord | null> {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async disableOwned(userId: string, id: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.userId !== userId || r.disabledAt !== null) return false;
    r.disabledAt = new Date().toISOString();
    return true;
  }
  async disableById(id: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.disabledAt = new Date().toISOString();
  }
}

// ---- in-memory delivery store ----
export class MemoryDeliveryStore implements DeliveryStore {
  records: { id: string; notificationId: string; deviceId: string; status: DeliveryStatus; attempts: number; lastError: string | null }[] = [];
  private seq = 0;

  async createQueued(notificationId: string, deviceId: string): Promise<string> {
    const existing = this.records.find((r) => r.notificationId === notificationId && r.deviceId === deviceId);
    if (existing) return existing.id;
    const id = `mdlv_${++this.seq}`;
    this.records.push({ id, notificationId, deviceId, status: "queued", attempts: 0, lastError: null });
    return id;
  }
  async markStatus(id: string, status: DeliveryStatus, attempts: number, lastError?: string | null): Promise<void> {
    const r = this.records.find((x) => x.id === id);
    if (r) {
      r.status = status;
      r.attempts = attempts;
      r.lastError = lastError ?? null;
    }
  }
}

// ---- in-memory change-log reader (differential delete feed) ----
export class MemoryChangeLogReader implements ChangeLogReader {
  tombstones: DeleteTombstone[] = []; // seed delete rows; seq should be ascending

  async headSeq(): Promise<number> {
    return this.tombstones.reduce((max, t) => Math.max(max, t.seq), 0);
  }
  async deletesSince(afterSeq: number, upToSeq: number): Promise<DeleteTombstone[]> {
    if (upToSeq <= afterSeq) return [];
    return this.tombstones.filter((t) => t.seq > afterSeq && t.seq <= upToSeq).sort((a, b) => a.seq - b.seq);
  }
}

// ---- in-memory change-log append store (writer; idempotent on eventId) ----
export class MemoryChangeLogStore implements ChangeLogStore {
  entries: ChangeLogEntry[] = [];

  async append(entry: ChangeLogEntry): Promise<void> {
    if (this.entries.some((e) => e.eventId === entry.eventId)) return; // ON CONFLICT DO NOTHING
    this.entries.push(entry);
  }
}

// ---- in-memory mutation store (durable idempotency) ----
export class MemoryMutationStore implements MutationStore {
  rows = new Map<string, { userId: string; op: string; result: MutationResult }>();

  async get(idempotencyKey: string): Promise<MutationResult | null> {
    return this.rows.get(idempotencyKey)?.result ?? null;
  }
  async save({ idempotencyKey, userId, op, result }: SaveMutationInput): Promise<void> {
    if (this.rows.has(idempotencyKey)) return; // first writer wins
    this.rows.set(idempotencyKey, { userId, op, result });
  }
}

// ---- fake push adapter ----
export class FakePushAdapter implements PushAdapter {
  result: SendResult = "sent";
  throwErr: Error | null = null;
  sends: { deviceId: string; payload: mobile.MobilePushPayload }[] = [];

  async send(device: DeviceRecord, payload: mobile.MobilePushPayload): Promise<SendResult> {
    this.sends.push({ deviceId: device.id, payload });
    if (this.throwErr) throw this.throwErr;
    return this.result;
  }
}

// ---- audit sink ----
export class AuditSink {
  records: auditLog.AuditRecordInput[] = [];
  fn = async (input: auditLog.AuditRecordInput): Promise<void> => {
    this.records.push(input);
  };
}

export interface Harness {
  deps: Deps;
  auth: FakeService;
  identity: FakeService;
  event: FakeService;
  task: FakeService;
  notification: FakeService;
  authenticator: FakeAuthenticator;
  devices: MemoryDeviceStore;
  deliveries: MemoryDeliveryStore;
  changeLog: MemoryChangeLogReader;
  changeLogStore: MemoryChangeLogStore;
  mutations: MemoryMutationStore;
  ios: FakePushAdapter;
  android: FakePushAdapter;
  audit: AuditSink;
}

export function makeHarness(): Harness {
  const config: AppConfig = {
    environment: "local",
    isProduction: false,
    defaultOrgId: "org_devhub",
    serviceName: "mobile-bff",
    pushConfigured: true,
  };
  const authService = new FakeService();
  const identity = new FakeService();
  const event = new FakeService();
  const task = new FakeService();
  const notification = new FakeService();
  const authenticator = new FakeAuthenticator();
  const devices = new MemoryDeviceStore();
  const deliveries = new MemoryDeliveryStore();
  const changeLog = new MemoryChangeLogReader();
  const changeLogStore = new MemoryChangeLogStore();
  const mutations = new MemoryMutationStore();
  const ios = new FakePushAdapter();
  const android = new FakePushAdapter();
  const audit = new AuditSink();
  let seq = 0;

  const deps: Deps = {
    config,
    authenticator,
    auth: authService,
    identity,
    event,
    task,
    notification,
    devices,
    deliveries,
    changeLog,
    changeLogStore,
    mutations,
    pushAdapters: { ios, android },
    pushRetry: { maxAttempts: 1 },
    audit: audit.fn,
    newRequestId: () => `req_${++seq}`,
  };

  return { deps, auth: authService, identity, event, task, notification, authenticator, devices, deliveries, changeLog, changeLogStore, mutations, ios, android, audit };
}

// ---- request builders ----
export function jsonInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}
export function authHeaders(token = GOOD_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
