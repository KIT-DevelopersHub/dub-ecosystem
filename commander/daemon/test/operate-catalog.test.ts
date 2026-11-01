// Guards the operate allow-list against drift from the services it calls: every catalog
// entry must still exist in the owning service's policy table with exactly the keys the
// catalog claims; every route in scope must be decided (catalog / excluded with a reason /
// pending); and irreversible effects stay out unless the owner opened them by name.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AREAS,
  CATALOG,
  EXCLUDED,
  OWNER_OPENED_IRREVERSIBLE,
  SCOPE,
  findEntry,
  pathParams,
  requiredPermissionKeys,
} from "../src/operate/catalog.ts";
import { extractAppGuardRoutes, extractPolicyRoutes, type PolicyRoute } from "../src/operate/policy-extract.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tables = new Map<string, PolicyRoute[]>();
function tableOf(service: string): PolicyRoute[] {
  let t = tables.get(service);
  if (!t) {
    // lp-analytics has no policy-table.ts yet; its gate is requireAppAccess in app.ts.
    // commander-service is gated by its own protection-table.ts (OPERATOR / OPEN).
    t =
      service === "lp-analytics"
        ? extractAppGuardRoutes(readFileSync(`${repoRoot}services/${service}/src/app.ts`, "utf8"))
        : service === "commander-service"
          ? extractPolicyRoutes(readFileSync(`${repoRoot}services/${service}/src/protection-table.ts`, "utf8"))
          : extractPolicyRoutes(readFileSync(`${repoRoot}services/${service}/src/policy-table.ts`, "utf8"));
    tables.set(service, t);
  }
  return t;
}
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const PENDING = AREAS.flatMap((a) => a.pending);

describe("extractPolicyRoutes", () => {
  it("resolves named constants, appLevel tiers and comments", () => {
    const routes = extractPolicyRoutes(`
      const MANAGE = appLevel("notifications", "edit", "notif:broadcast_publish");
      const READ = ["identity:read"] as const;
      export const POLICY_TABLE = definePolicyTable({
        // "GET /commented": PUBLIC,
        "GET /health": INTERNAL,
        "POST /n/:id/unpublish": MANAGE,
        "GET /users": READ,
        "PATCH /events/:id": appLevel("events", "edit", "event:write"),
      });`);
    expect(routes.map(key)).toEqual(["GET /health", "POST /n/:id/unpublish", "GET /users", "PATCH /events/:id"]);
    expect(routes[0]!.kind).toBe("INTERNAL");
    expect(routes[1]).toMatchObject({ kind: "keys", keys: ["notif:broadcast_publish"], appLevel: { app: "notifications", level: "edit" } });
    expect(routes[2]).toMatchObject({ keys: ["identity:read"] });
    expect(routes[2]!.appLevel).toBeUndefined();
  });

  it("reads commander-service's OPERATOR / OPEN protection markers", () => {
    const routes = extractPolicyRoutes(`
      export const OPERATOR = "operator" as const;
      export const OPEN = "open" as const;
      export const PROTECTION_TABLE = defineProtectionTable({
        "GET /health": OPEN,
        "POST /features/:id/transition": OPERATOR,
      });`);
    expect(routes.map((r) => [key(r), r.kind, r.keys])).toEqual([
      ["GET /health", "OPEN", []],
      ["POST /features/:id/transition", "OPERATOR", []],
    ]);
  });

  it("reads requireAppAccess guards from an app.ts without a table", () => {
    const routes = extractAppGuardRoutes(`
      const view = deps.authz.requireAppAccess("lp", "view");
      const edit = deps.authz.requireAppAccess("lp", "edit");
      app.get("/health", (c) => c.json({}));
      app.get("/lp/stats", view, async (c) => c.json({}));
      app.patch("/lp/links/:id", edit, async (c) =>
        c.json({}));`);
    expect(routes.map((r) => [key(r), r.appLevel])).toEqual([
      ["GET /lp/stats", { app: "lp", level: "view" }],
      ["PATCH /lp/links/:id", { app: "lp", level: "edit" }],
    ]);
  });

  it("reads the { permission } option as a key and throws on a guard it cannot read", () => {
    const routes = extractAppGuardRoutes(`
      const publish = deps.authz.requireAppAccess("lp", "edit", { permission: "lp:publish" });
      app.post("/lp/publish", publish, async (c) => c.json({}));`);
    expect(routes).toMatchObject([{ method: "POST", path: "/lp/publish", keys: ["lp:publish"], appLevel: { app: "lp", level: "edit" } }]);
    expect(() =>
      extractAppGuardRoutes(`const owner = deps.authz.requireOwner();
      app.post("/lp/x", owner, async (c) => c.json({}));`),
    ).toThrow(/owner/);
  });
});

describe("operate catalog", () => {
  it.each(CATALOG.map((e) => [e.id, e] as const))("%s matches its service policy table", (_id, entry) => {
    const route = tableOf(entry.service).find((r) => key(r) === key(entry));
    expect(route, `${key(entry)} missing from ${entry.service}`).toBeDefined();
    // AUTHENTICATED (no key) is acceptable only when the catalog claims no key either;
    // OPERATOR (commander-service's operator token) only for entries that call that service.
    expect(
      route!.kind === "keys" ||
        (route!.kind === "AUTHENTICATED" && entry.requires.keys.length === 0) ||
        (route!.kind === "OPERATOR" && entry.target === "commander" && entry.requires.keys.length === 0),
      entry.id,
    ).toBe(true);
    expect(entry.target === "commander", entry.id).toBe(entry.service === "commander-service");
    expect([...route!.keys].sort()).toEqual([...entry.requires.keys].sort());
    expect(route!.appLevel).toEqual(entry.requires.appLevel);
  });

  it("decides every in-scope route exactly once: catalog, excluded (with a reason) or pending", () => {
    const decided = new Map<string, string>();
    const mark = (service: string, route: string, as: string) => {
      const k = `${service} ${route}`;
      expect(decided.get(k), `${k} is both ${decided.get(k)} and ${as}`).toBeUndefined();
      decided.set(k, as);
    };
    for (const e of CATALOG) mark(e.service, key(e), "catalog");
    for (const x of EXCLUDED) mark(x.service, x.route, "excluded");
    for (const p of PENDING) mark(p.service, p.route, "pending");

    const inScope: string[] = [];
    for (const [service, prefixes] of Object.entries(SCOPE)) {
      for (const r of tableOf(service)) {
        if (r.kind === "INTERNAL" || r.kind === "internalWithKeys" || r.kind === "PUBLIC" || r.kind === "OPEN") continue;
        if (!prefixes.some((p) => r.path.startsWith(p))) continue;
        inScope.push(`${service} ${key(r)}`);
      }
    }
    expect(inScope.filter((k) => !decided.has(k)), "routes nobody decided on").toEqual([]);
    expect([...decided.keys()].filter((k) => !inScope.includes(k)), "decisions on routes that do not exist").toEqual([]);
    for (const x of EXCLUDED) expect(x.reason, x.route).toMatch(/[ぁ-んァ-ン一-龥]/);
  });

  it("has unique ids and declares body rules only for mutations", () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
    for (const e of CATALOG) {
      if (e.kind === "read") {
        expect(e.method, e.id).toBe("GET");
        expect(e.body, e.id).toBeUndefined();
        expect(e.risk, e.id).toBe("low");
      } else {
        expect(e.method, e.id).not.toBe("GET");
        // Exactly one of: a read-back, or the stated reason it cannot be read back.
        expect(Boolean(e.verify) !== Boolean(e.unverifiable), `${e.id} needs verify xor unverifiable`).toBe(true);
      }
      for (const req of e.body?.required ?? []) expect(e.body!.allowed).toContain(req);
    }
  });

  it("verifies every write through a catalog read that addresses the target", () => {
    for (const e of CATALOG.filter((x) => x.verify)) {
      const read = findEntry(e.verify!.read);
      expect(read?.kind, e.id).toBe("read");
      for (const p of pathParams(read!.path)) expect(e.verify!.params?.[p], `${e.id}:${p}`).toBeDefined();
      expect(Boolean(e.verify!.findIn) === Boolean(e.verify!.findBy), e.id).toBe(true);
      // The read-back goes through the same API as the write.
      expect(read!.target, e.id).toBe(e.target);
    }
  });

  it("keeps irreversible effects out unless the owner opened them by name", () => {
    const irreversible = CATALOG.filter((e) => !e.reversible).map((e) => e.id).sort();
    expect(irreversible).toEqual(Object.keys(OWNER_OPENED_IRREVERSIBLE).sort());
    for (const e of CATALOG) expect(e.path, e.id).not.toMatch(/batch|bulk/i);
  });

  it("gives every entry Japanese copy and keeps deletes at high risk", () => {
    for (const e of CATALOG) {
      expect(e.impact.length, e.id).toBeGreaterThan(0);
      expect(e.description, e.id).toMatch(/[ぁ-んァ-ン一-龥]/);
      // Operator copy stays plain: field names / status codes belong in the planner hint.
      expect(e.description, e.id).not.toMatch(/version|localPart|items\[|params\.|body\.|events\.get|\b\d{3}\b/);
      if (e.kind === "delete") expect(e.risk, e.id).toBe("high");
    }
  });

  it("lists the permission keys a commander bot role needs, never a delete/admin-only key", () => {
    const keys = requiredPermissionKeys();
    expect(keys).toContain("event:read");
    expect(keys).toContain("app:events:edit");
    // Slack import is admin-only by default: the bot role has to be granted these on purpose.
    expect(keys).toEqual(expect.arrayContaining(["chat:slack_import", "chat:emoji_import"]));
    for (const k of ["event:admin", "task:delete", "chat:delete", "chat:moderate", "file:admin"]) expect(keys).not.toContain(k);
  });
});
