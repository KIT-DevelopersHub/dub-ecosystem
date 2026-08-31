// Shared test scaffolding: in-memory D1 env, fake queue, fake downstream ports, and
// a fake MessageBatch. Keeps each test focused on behaviour, not wiring.
import { createDbClient, type DbClient } from "@dub/db";
import type { RequestContext } from "@dub/http";
import type { AuditRecordEnvelopeV1, DubEventEnvelope } from "@dub/events";
import type { Queue, MessageBatch, Fetcher } from "@cloudflare/workers-types";
import type { Env } from "../src/env";
import type {
  ChatPort,
  ChatSystemMessage,
  EventPort,
  IdentityPort,
  MailPort,
  PushDispatch,
  PushPort,
} from "../src/clients";
import { makeD1 } from "./d1";

export interface FakeQueue {
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>;
  sends: AuditRecordEnvelopeV1[];
}

export function fakeAuditQueue(): FakeQueue {
  const sends: AuditRecordEnvelopeV1[] = [];
  const q = {
    async send(msg: AuditRecordEnvelopeV1) {
      sends.push(msg);
    },
    async sendBatch() {},
  } as unknown as Queue<AuditRecordEnvelopeV1>;
  return { AUDIT_QUEUE: q, sends };
}

// A Fetcher that must never actually be called in a given test (direct-recipient /
// header-auth paths do not touch the network).
export const inertFetcher = {
  async fetch() {
    throw new Error("unexpected downstream fetch");
  },
} as unknown as Fetcher;

export interface TestEnvHandle {
  env: Env;
  db: DbClient;
  audit: FakeQueue;
  raw: ReturnType<typeof makeD1>["raw"];
}

export function makeTestEnv(overrides: Partial<Env> = {}): TestEnvHandle {
  const { d1, raw } = makeD1();
  const audit = fakeAuditQueue();
  const env: Env = {
    DB: d1,
    AUDIT_QUEUE: audit.AUDIT_QUEUE,
    SVC_IDENTITY: inertFetcher,
    SVC_EVENT: inertFetcher,
    ...overrides,
  };
  const db = createDbClient(d1, { namespace: "notif" });
  return { env, db, audit, raw };
}

export function ctx(requestId = "req_test", userId?: string): RequestContext {
  return { requestId, caller: "test", ...(userId ? { userId } : {}) };
}

// ---- fake downstream ports ----
export function fakeIdentity(opts: {
  byRole?: Record<string, string[]>;
  emails?: Record<string, string>;
  displayNames?: Record<string, string>;
  allUsers?: string[];
}): IdentityPort & { roleCalls: string[]; emailCalls: string[]; nameCalls: string[]; allCalls: number } {
  const roleCalls: string[] = [];
  const emailCalls: string[] = [];
  const nameCalls: string[] = [];
  const state = { allCalls: 0 };
  return {
    roleCalls,
    emailCalls,
    nameCalls,
    get allCalls() {
      return state.allCalls;
    },
    async listUserIdsByRole(roleKey) {
      roleCalls.push(roleKey);
      return opts.byRole?.[roleKey] ?? [];
    },
    async listAllUserIds() {
      state.allCalls++;
      return opts.allUsers ?? [];
    },
    async getEmail(userId) {
      emailCalls.push(userId);
      return opts.emails?.[userId] ?? null;
    },
    async getDisplayName(userId) {
      nameCalls.push(userId);
      return opts.displayNames?.[userId] ?? null;
    },
  };
}

export function fakeEvent(participants: Record<string, string[]>): EventPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listParticipantIds(eventId) {
      calls.push(eventId);
      return participants[eventId] ?? [];
    },
  };
}

export interface RecordingMail extends MailPort {
  calls: { req: unknown; idempotencyKey: string }[];
}
export function fakeMail(behavior: "ok" | "throw" = "ok"): RecordingMail {
  const calls: { req: unknown; idempotencyKey: string }[] = [];
  return {
    calls,
    async send(req, idempotencyKey) {
      calls.push({ req, idempotencyKey });
      if (behavior === "throw") throw new Error("mail send failed");
    },
  };
}

export interface RecordingChat extends ChatPort {
  calls: ChatSystemMessage[];
}
export function fakeChat(behavior: "ok" | "throw" = "ok"): RecordingChat {
  const calls: ChatSystemMessage[] = [];
  return {
    calls,
    async postSystemMessage(msg) {
      calls.push(msg);
      if (behavior === "throw") throw new Error("chat post failed");
    },
  };
}

export interface RecordingPush extends PushPort {
  calls: PushDispatch[];
}
export function fakePush(behavior: "ok" | "throw" = "ok"): RecordingPush {
  const calls: PushDispatch[] = [];
  return {
    calls,
    async dispatch(req) {
      calls.push(req);
      if (behavior === "throw") throw new Error("push dispatch failed");
    },
  };
}

// ---- fake queue MessageBatch ----
export interface FakeMessage<T> {
  body: T;
  acked: boolean;
  retried: boolean;
}
export function fakeBatch(envelopes: DubEventEnvelope[]): {
  batch: MessageBatch<DubEventEnvelope>;
  messages: FakeMessage<DubEventEnvelope>[];
} {
  const messages: FakeMessage<DubEventEnvelope>[] = envelopes.map((body) => ({ body, acked: false, retried: false }));
  const batch = {
    queue: "dub-q-evt-notification",
    messages: messages.map((m) => ({
      body: m.body,
      id: m.body.id,
      timestamp: new Date(),
      attempts: 1,
      ack() {
        m.acked = true;
      },
      retry() {
        m.retried = true;
      },
    })),
  } as unknown as MessageBatch<DubEventEnvelope>;
  return { batch, messages };
}

export function envelope<N extends DubEventEnvelope["name"]>(
  name: N,
  payload: unknown,
  over: Partial<DubEventEnvelope> = {},
): DubEventEnvelope {
  return {
    name,
    version: 1,
    id: over.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    occurredAt: new Date().toISOString(),
    requestId: over.requestId ?? "req_evt",
    actorId: over.actorId ?? null,
    payload,
  } as DubEventEnvelope;
}
