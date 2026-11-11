// Hono app (internal paths — the gateway strips API_PREFIX, so routes start at
// /driveshare). Same contract for external (via api-gateway binding SVC_DRIVE_SHARE)
// and internal Service-Binding callers.
//
// AUTHZ: none in this file. `policyGate` is mounted first and derives both authn (the
// trusted x-dub-user-id header) and authz from POLICY_TABLE (src/policy-table.ts), which
// lists every route below. Handlers therefore assume an authorized caller and read it with
// `c.get("userId")`. Do NOT add a permission check to a route or a handler — add the route
// to the table (test/policy-table.test.ts fails if you forget).
// Deps are injected so the whole surface is unit-testable without a live Worker env.
import { Hono } from "hono";
import type { Context } from "hono";
import { errors, dubErrorHandler } from "@dub/errors";
import { policyGate, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import type { DriveShareService } from "./service";
import type { RoleGrantsService } from "./role-grants-service";
import type { GoogleAccountService } from "./google-account";
import type { MeetingsService } from "./meetings-service";
import type { AttendanceService } from "./attendance-service";
import type { GoogleLinkService } from "./google-link";
import { POLICY_TABLE } from "./policy-table";
import type {
  CompleteGoogleConnectRequest,
  CreateRoleGrantRequest,
  GrantPermissionRequest,
  SetLinkSharingRequest,
  StartGoogleConnectRequest,
  SwitchGoogleAccountRequest,
  UpdatePermissionRequest,
} from "./types";

export interface AppDeps {
  service: DriveShareService;
  /** Role-based sharing fan-out (built per request with the acting user's roster view). */
  roleGrants: RoleGrantsService;
  /** The Google accounts the service can act as + the admin add/switch flow. */
  googleAccount: GoogleAccountService;
  /** Which of the requested permission keys the caller holds (identity /authz/check). */
  authz: PermissionGranter;
  /** カレンダー > ミーティング (gateway segment /meetings). Lazy so non-meeting routes never pay
   *  for its wiring. */
  meetings: () => Promise<MeetingsService>;
  /** 定例の出席 (join from Dub, 人事 report / corrections). */
  attendance: () => AttendanceService;
  /** 「Googleと連携」 (Meet attendance matches the member automatically). */
  googleLink: () => GoogleLinkService;
}

type Vars = PolicyGateVars;

async function parseBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  app.onError(dubErrorHandler({ service: "drive-share-service" }));

  // The authorization layer. First and only — every route below is gated by POLICY_TABLE.
  app.use("*", policyGate({ service: "drive-share-service", table: POLICY_TABLE, granted: deps.authz }));

  // ---- liveness (INTERNAL in the table: reachable only over a Service Binding carrying
  // x-dub-internal, which is exactly how app-health-monitor probes it). ----
  app.get("/internal/health", (c) => c.json({ status: "ok", service: "drive-share-service" }));

  // ---- reads ----
  app.get("/driveshare/files", async (c) => {
    const q = c.req.query();
    return c.json(
      await deps.service.listFiles({
        ...(q.folderId ? { folderId: q.folderId } : {}),
        ...(q.q ? { q: q.q } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      }),
    );
  });

  app.get("/driveshare/files/:id/permissions", async (c) => {
    return c.json(await deps.service.listPermissions(c.req.param("id")));
  });

  // ---- role-based sharing reads ----
  // All grants in the org — the file list renders role chips from this.
  app.get("/driveshare/role-grants", async (c) => {
    return c.json({ items: await deps.roleGrants.listAll() });
  });

  // Grants for one file — the detail panel.
  app.get("/driveshare/files/:id/role-grants", async (c) => {
    return c.json({ items: await deps.roleGrants.listByFile(c.req.param("id")) });
  });

  // Actual sharing vs the file's role grants (shares outside the roles, wrong role, missing).
  app.get("/driveshare/files/:id/drift", async (c) => {
    return c.json(await deps.roleGrants.drift(c.req.param("id")));
  });

  // ---- writes ----
  app.post("/driveshare/files/:id/permissions", async (c) => {
    const body = await parseBody<GrantPermissionRequest>(c);
    const permission = await deps.service.grant(c.req.param("id"), body);
    return c.json({ permission }, 201);
  });

  app.patch("/driveshare/files/:id/permissions/:permId", async (c) => {
    const body = await parseBody<UpdatePermissionRequest>(c);
    const permission = await deps.service.updateRole(c.req.param("id"), c.req.param("permId"), body);
    return c.json({ permission });
  });

  app.delete("/driveshare/files/:id/permissions/:permId", async (c) => {
    await deps.service.revoke(c.req.param("id"), c.req.param("permId"));
    return c.json({ revoked: true });
  });

  // ---- role-based sharing writes ----
  // UPSERT a role→file grant, then non-destructively fan out to the role's members.
  app.post("/driveshare/files/:id/role-grants", async (c) => {
    const body = await parseBody<CreateRoleGrantRequest>(c);
    const grant = await deps.roleGrants.apply(c.req.param("id"), c.get("userId"), body.roleId, body.driveRole);
    return c.json(grant, 201);
  });

  // Revoke a role→file grant: delete only the permissions we created (guarded), drop rows.
  app.delete("/driveshare/files/:id/role-grants/:roleId", async (c) => {
    await deps.roleGrants.revoke(c.req.param("id"), c.req.param("roleId"));
    return c.body(null, 204);
  });

  // Reconcile a grant against current role membership (add new, remove departed).
  app.post("/driveshare/files/:id/role-grants/:roleId/reapply", async (c) => {
    const cursor = c.req.query("cursor");
    return c.json(await deps.roleGrants.reapply(c.req.param("id"), c.req.param("roleId"), cursor));
  });

  // ---- link sharing on/off ----
  app.put("/driveshare/files/:id/link", async (c) => {
    const body = await parseBody<SetLinkSharingRequest>(c);
    return c.json(await deps.service.setLinkSharing(c.req.param("id"), body));
  });

  // ---- Google accounts the service acts as (Drive共有 > 設定 > Google アカウント; admin only) ----
  app.get("/driveshare/google-account", async (c) => c.json(await deps.googleAccount.status()));

  app.post("/driveshare/google-account/connect", async (c) => {
    const body = await parseBody<Partial<StartGoogleConnectRequest>>(c);
    return c.json(await deps.googleAccount.startConnect(c.get("userId"), body.redirectUri, body.loginHint));
  });

  app.post("/driveshare/google-account/callback", async (c) => {
    const body = await parseBody<Partial<CompleteGoogleConnectRequest>>(c);
    return c.json(await deps.googleAccount.completeConnect(c.get("userId"), body));
  });

  app.post("/driveshare/google-account/active", async (c) => {
    const body = await parseBody<Partial<SwitchGoogleAccountRequest>>(c);
    return c.json(await deps.googleAccount.switchTo(c.get("userId"), body.accountId));
  });

  app.delete("/driveshare/google-account/accounts/:id", async (c) =>
    c.json(await deps.googleAccount.remove(c.req.param("id"))),
  );

  // ---- カレンダー > ミーティング (gateway segment /meetings; same shared Google account) ----
  app.get("/meetings", async (c) => c.json(await (await deps.meetings()).list()));

  app.get("/meetings/targets", async (c) => c.json(await (await deps.meetings()).targets(c.get("userId"))));

  app.post("/meetings", async (c) => {
    const body = await parseBody<unknown>(c);
    return c.json(await (await deps.meetings()).create(c.get("userId"), body), 201);
  });

  // Reconcile invitations / calendar shares with role membership now (the alarm does it hourly).
  app.post("/meetings/sync", async (c) => {
    const { complete: _complete, quotaPausedUntil: _paused, aclContinueMs: _continue, ...res } = await (await deps.meetings()).sync();
    return c.json(res);
  });

  app.patch("/meetings/:id", async (c) => {
    const body = await parseBody<unknown>(c);
    return c.json(await (await deps.meetings()).update(c.req.param("id"), body, c.get("userId")));
  });

  app.delete("/meetings/:id", async (c) => {
    await (await deps.meetings()).remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // Who is invited and their answers in Google Calendar (?date= one occurrence of a series).
  app.get("/meetings/:id/attendees", async (c) => c.json(await (await deps.meetings()).attendees(c.req.param("id"), c.req.query("date"))));

  // ---- 定例の出席 (same gateway segment /meetings) ----
  // The caller opens the Meet from Dub: recorded present when it is a 定例 within its window.
  app.post("/meetings/:id/join", async (c) => c.json(await deps.attendance().join(c.get("userId"), c.req.param("id"))));

  app.get("/meetings/me/regulars", async (c) => c.json(await deps.attendance().myRegulars(c.get("userId"))));

  app.get("/meetings/attendance", async (c) => {
    const q = c.req.query();
    return c.json(await deps.attendance().report({ ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) }));
  });

  // Read Meet participant records now (the scheduled job does it hourly).
  app.post("/meetings/attendance/ingest", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await deps.attendance().ingest(body));
  });

  // 人事 confirms who a Meet participant (Google account id) is — remembered for next time.
  app.put("/meetings/attendance/links/:googleUserId", async (c) => {
    const body = await parseBody<unknown>(c);
    return c.json(await deps.attendance().confirm(c.get("userId"), c.req.param("googleUserId"), body));
  });

  app.delete("/meetings/attendance/links/:googleUserId", async (c) => c.json(await deps.attendance().unlink(c.req.param("googleUserId"))));

  app.put("/meetings/attendance/settings", async (c) => {
    const body = await parseBody<unknown>(c);
    return c.json(await deps.attendance().updateSettings(c.get("userId"), body));
  });

  // 「Googleと連携」 (the caller's own Google account id).
  app.post("/meetings/me/google-link/start", async (c) => {
    const body = await parseBody<unknown>(c);
    return c.json(await deps.googleLink().start(c.get("userId"), body));
  });

  app.post("/meetings/me/google-link/callback", async (c) => {
    const body = await parseBody<unknown>(c);
    return c.json(await deps.googleLink().complete(c.get("userId"), body));
  });

  app.put("/meetings/:id/attendance/:date/:userId", async (c) => {
    const body = await parseBody<unknown>(c);
    return c.json(await deps.attendance().set(c.get("userId"), c.req.param("id"), c.req.param("date"), c.req.param("userId"), body));
  });

  return app;
}
