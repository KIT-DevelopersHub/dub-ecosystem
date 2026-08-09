// Frozen demo fixtures (P0b). Fixed prefix-ULID ids give the minimal / conference-demo
// scenarios a deterministic base that #29 E2E and every service test can import.
//
// Reconciliation notes (design §2-5 vs the frozen sibling contracts):
//  - primary org id = common.DUB_DEFAULT_ORG_ID ("org_devhub"): identity's migration
//    seeds the default org + the 3 system roles there, and seed only references them.
//    (The design's placeholder org_01SEED…DUB0 is superseded to keep FK integrity.)
//  - roleIds map to identity's system-role rows (role_sys_*) so role_assignments FK
//    resolve without seed re-creating reference data (demo users must not leak to prod).
//  - googleSub is published for the auth-service dev-login contract (POST /auth/test-login
//    maps dev:<email>); identity_users has no google_sub column, so seed does NOT write
//    it to D1 — it lives here as the login contract only.
import { common } from "@dub/types";

export const SEED = {
  orgs: {
    primary: { id: common.DUB_DEFAULT_ORG_ID, slug: "devhub", name: "DevelopersHub" },
    outsider: { id: "org_01SEED00000000000000OTHER", slug: "other-org", name: "Other Org" }, // rbac-matrix only
  },
  roleKeys: ["admin", "organizer", "member"] as const,
  roleIds: { admin: "role_sys_admin", organizer: "role_sys_organizer", member: "role_sys_member" } as const,
  // outsider org needs its own member role (system roles are scoped to the primary org).
  outsiderRoleId: "role_other_member",
  users: {
    admin: { id: "user_01SEED000000000000000ADMIN", email: "demo-admin@dev.developershub.jp", googleSub: "dev:demo-admin@dev.developershub.jp", displayName: "Demo Admin", org: "primary", role: "admin" },
    organizer: { id: "user_01SEED00000000000000ORGNZ", email: "demo-organizer@dev.developershub.jp", googleSub: "dev:demo-organizer@dev.developershub.jp", displayName: "Demo Organizer", org: "primary", role: "organizer" },
    member: { id: "user_01SEED00000000000000MEMBER", email: "demo-member@dev.developershub.jp", googleSub: "dev:demo-member@dev.developershub.jp", displayName: "Demo Member", org: "primary", role: "member" },
    outsider: { id: "user_01SEED0000000000000OUTSDR", email: "demo-outsider@dev.developershub.jp", googleSub: "dev:demo-outsider@dev.developershub.jp", displayName: "Demo Outsider", org: "outsider", role: "member" },
  },
  event: { id: "event_01SEED000000000000000CONF0", slug: "hokuriku-it-conf-2026", name: "Hokuriku IT Conference 2026" },
  actions: { venue: "action_01SEED00000000000000VENUE", sponsor: "action_01SEED0000000000000SPNSR" },
  tasks: { root: "task_01SEED0000000000000000ROOT", blocked: "task_01SEED00000000000000BLOCK" },
  channel: { general: "chan_01SEED000000000000000GENRL" },
} as const;

export type TestUserKey = "admin" | "organizer" | "member" | "outsider";

// Deterministic timestamps keep re-seeds byte-identical (idempotency via fixed ids).
export const SEED_TS = "2026-02-01T00:00:00.000Z";
// Audit rows are backdated beyond the retention window so cleanup() may DELETE them
// (audit_logs' append-only DELETE trigger only blocks rows inside the window).
export const SEED_AUDIT_TS = "2020-01-01T00:00:00.000Z";

/** Stable hash of the fixture surface — recorded per seed run for drift visibility. */
export function fixtureHash(): string {
  const json = JSON.stringify(SEED);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
