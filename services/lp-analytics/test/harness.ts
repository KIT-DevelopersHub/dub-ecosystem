// Test harness: drives the real Hono app over either the in-memory repo or the REAL D1
// repo on node:sqlite with every infra migration applied (so the SQL is exercised too).
import type { MiddlewareHandler } from "hono";
import { DubError, CommonErrorCodes } from "@dub/errors";
import { createDbClient } from "@dub/db";
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { memoryD1 } from "../../../infra/d1/src/node-d1";
import { applyAll } from "../../../infra/d1/src/apply";
import { createApp } from "../src/app";
import { createD1LpRepo } from "../src/d1-repo";
import { InMemoryLpRepo } from "../src/memory-repo";
import type { SiteTrafficSource } from "../src/site-traffic";
import type { AppDeps, Authz, LpRepo } from "../src/types";

export function fakeAuthz(granted: Set<identity.PermissionKey>): Authz {
  return {
    requireAuth(): MiddlewareHandler {
      return async (c, next) => {
        if (!c.req.header("x-dub-user-id")) throw new DubError("AUTH_INVALID_TOKEN", "x-dub-user-id absent", { status: 401 });
        await next();
      };
    },
    // Decide with the REAL policy module so tests share production semantics.
    requireAppAccess(app, level): MiddlewareHandler {
      return async (_c, next) => {
        const decision = policy.decide(granted, { app, level });
        if (!decision.allowed) throw new DubError(CommonErrorCodes.FORBIDDEN, policy.denyMessage(decision), { status: 403 });
        await next();
      };
    },
  };
}

export const grants = (level: policy.AppAccessLevel): Set<identity.PermissionKey> =>
  new Set(level === "none" ? [] : policy.keysForAppLevel("lp", level));

export type RepoKind = "memory" | "d1";

export async function makeRepo(kind: RepoKind): Promise<LpRepo> {
  if (kind === "memory") return new InMemoryLpRepo();
  const { db } = memoryD1();
  await applyAll(db);
  return createD1LpRepo(createDbClient(db, { namespace: "lp" }));
}

export interface Clock {
  set(iso: string): void;
}

export async function makeApp(
  kind: RepoKind,
  level: policy.AppAccessLevel = "edit",
  dailyVisitCap = 5000,
  siteTraffic: SiteTrafficSource | null = null,
) {
  let now = "2026-10-07T03:00:00.000Z";
  let seq = 0;
  // ULID-like monotonic ids so "newest first by id" holds like production.
  const id = (p: string) => `${p}_${String(seq++).padStart(8, "0")}`;
  const repo = await makeRepo(kind);
  const deps: AppDeps = {
    repo,
    authz: fakeAuthz(grants(level)),
    orgId: "org_devhub",
    lpBaseUrl: "https://hokuriku-it-conf.com",
    now: () => now,
    newLinkId: () => id("lnk"),
    newVisitId: () => id("lpv"),
    dailyVisitCap,
    siteTraffic,
  };
  const app = createApp(deps);
  const clock: Clock = { set: (iso) => (now = iso) };
  return { app, repo, clock };
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

export function ingest(body: Record<string, unknown>): Request {
  return send("POST", "/lp/internal/visits", { device: "mobile", visitorKey: "v1", ...body }, {
    "x-dub-internal": "1",
    "x-dub-user-id": "system:public-lp-visit",
  });
}
