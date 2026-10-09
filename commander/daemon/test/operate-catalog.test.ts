// Guards the operate allow-list against drift from the services it calls: every catalog
// entry must still exist in the owning service's policy-table.ts with exactly the keys the
// catalog claims, and the catalog must never grow a physical delete or a bulk endpoint.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CATALOG, findEntry, pathParams, requiredPermissionKeys } from "../src/operate/catalog.ts";
import { extractPolicyRoutes } from "../src/operate/policy-extract.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tableOf = (service: string) =>
  extractPolicyRoutes(readFileSync(`${repoRoot}services/${service}/src/policy-table.ts`, "utf8"));

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
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /health",
      "POST /n/:id/unpublish",
      "GET /users",
      "PATCH /events/:id",
    ]);
    expect(routes[0]!.kind).toBe("INTERNAL");
    expect(routes[1]).toMatchObject({ kind: "keys", keys: ["notif:broadcast_publish"], appLevel: { app: "notifications", level: "edit" } });
    expect(routes[2]).toMatchObject({ keys: ["identity:read"] });
    expect(routes[2]!.appLevel).toBeUndefined();
  });
});

describe("operate catalog", () => {
  it.each(CATALOG.map((e) => [e.id, e] as const))("%s matches its service policy table", (_id, entry) => {
    const route = tableOf(entry.service).find((r) => r.method === entry.method && r.path === entry.path);
    expect(route, `${entry.method} ${entry.path} missing from ${entry.service}`).toBeDefined();
    expect(route!.kind).toBe("keys");
    expect([...route!.keys].sort()).toEqual([...entry.requires.keys].sort());
    expect(route!.appLevel).toEqual(entry.requires.appLevel);
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
        expect(e.verify, `${e.id} needs a read-back`).toBeDefined();
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
    }
  });

  it("excludes physical deletes and bulk endpoints", () => {
    for (const e of CATALOG) {
      expect(e.method as string, e.id).not.toBe("DELETE");
      expect(e.path, e.id).not.toMatch(/batch|bulk/i);
    }
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

  it("lists the permission keys a commander bot role needs", () => {
    expect(requiredPermissionKeys()).toEqual([
      "event:read",
      "event:write",
      "identity:read",
      "mail:admin",
      "notif:broadcast_publish",
    ]);
  });
});
