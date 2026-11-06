// Test harness: drives the real Hono app over either the in-memory repo or the REAL D1 repo on
// node:sqlite with db/0001_init.sql + 0002_delivery.sql applied (the schema dub-tickets actually gets, so the SQL is
// exercised against it).
import { readFileSync } from "node:fs";
import { createDbClient } from "@dub/db";
import type { PermissionGranter } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { memoryD1 } from "../../../infra/d1/src/node-d1";
import { createApp } from "../src/app";
import { createD1TicketRepo } from "../src/d1-repo";
import { InMemoryLpTicketRepo } from "../src/memory-repo";
import type { AppDeps, LpTicketRepo } from "../src/types";

export const INIT_SQL = readFileSync(new URL("../db/0001_init.sql", import.meta.url), "utf8");
export const DELIVERY_SQL = readFileSync(new URL("../db/0002_delivery.sql", import.meta.url), "utf8");

export function fakeAuthz(granted: Set<identity.PermissionKey>): PermissionGranter {
  return async (_userId, _orgId, keys) => keys.filter((k) => granted.has(k));
}

export const grants = (level: policy.AppAccessLevel): Set<identity.PermissionKey> =>
  new Set(level === "none" ? [] : policy.keysForAppLevel("lp", level));

export type RepoKind = "memory" | "d1";

export async function makeRepo(kind: RepoKind): Promise<LpTicketRepo> {
  if (kind === "memory") return new InMemoryLpTicketRepo();
  const { db } = memoryD1();
  await db.exec(INIT_SQL);
  await db.exec(DELIVERY_SQL);
  return createD1TicketRepo(createDbClient(db, { namespace: "lp" }));
}

export interface Clock {
  set(iso: string): void;
}

export async function makeApp(
  kind: RepoKind,
  level: policy.AppAccessLevel = "edit",
  extraGrants: identity.PermissionKey[] = [],
  overrides: Partial<AppDeps> = {},
) {
  let now = "2026-10-07T03:00:00.000Z";
  let seq = 0;
  // ULID-like monotonic ids so "newest first by id" holds like production.
  const id = (p: string) => `${p}_${String(seq++).padStart(8, "0")}`;
  const repo = overrides.repo ?? (await makeRepo(kind));
  const deps: AppDeps = {
    repo,
    authz: fakeAuthz(new Set([...grants(level), ...extraGrants])),
    lpBaseUrl: "https://hokuriku-it-conf.com",
    now: () => now,
    newTicketTypeId: () => id("tkt"),
    newOrderId: () => id("tko"),
    newCouponId: () => id("tkc"),
    stripe: null,
    stripeWebhookSecret: null,
    armReconcile: null,
    paypayEnabled: false,
    ticketPreviewKey: null,
    mailer: { send: async () => ({ ok: true, id: "re_harness" }) },
    ticketTokenSecret: "harness-secret",
    ticketOpsEmail: null,
    ticketMailFrom: "北陸ITカンファレンス <info@example.com>",
    ticketMailDailyCap: null,
    backup: null,
    defer: null,
    sleep: async () => {},
    ...overrides,
  };
  const app = createApp(deps);
  const clock: Clock = { set: (iso) => (now = iso) };
  return { app, repo, clock, deps };
}

const USER = { "x-dub-user-id": "usr_admin", "x-dub-request-id": "req_test" };

export function get(path: string, headers: Record<string, string> = USER): Request {
  return new Request(`https://lp${path}`, { headers });
}

export function send(method: string, path: string, body: unknown, headers: Record<string, string> = USER): Request {
  return new Request(`https://lp${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
