// CI invariant: the canonical app registry (APP_MANIFEST) is the single source of
// truth for the launcher app set, and EVERY app is backed by real RBAC permission
// key(s). This is the mechanism that stops a new app from shipping without a
// per-app permission (the historical 抜け漏れ). The compile-time `PermissionKey`
// union already rejects unknown keys; these runtime assertions make the invariant
// explicit and catch JS-level drift.
import { describe, it, expect } from "vitest";
import { identity, appRegistry } from "../src/index";

const catalogKeys = new Set(identity.PERMISSION_CATALOG.map((e) => e.key));
const catalogDomains = new Set(identity.PERMISSION_CATALOG.map((e) => e.domain));

describe("APP_MANIFEST — canonical app ↔ RBAC coverage", () => {
  it("every app declares at least one per-app permission key", () => {
    for (const app of appRegistry.APP_MANIFEST) {
      expect(app.permissions.length, `app '${app.id}' has no permission key`).toBeGreaterThanOrEqual(1);
    }
  });

  it("every app's permission keys exist in PERMISSION_CATALOG (no phantom keys)", () => {
    for (const app of appRegistry.APP_MANIFEST) {
      for (const key of app.permissions) {
        expect(catalogKeys.has(key), `app '${app.id}' references non-catalog permission '${key}'`).toBe(true);
      }
    }
  });

  it("every app's backing domain exists in PERMISSION_CATALOG", () => {
    for (const app of appRegistry.APP_MANIFEST) {
      expect(catalogDomains.has(app.domain), `app '${app.id}' domain '${app.domain}' is not a catalog domain`).toBe(true);
    }
  });

  it("app ids are unique and non-empty; nav paths are absolute", () => {
    const ids = appRegistry.APP_MANIFEST.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const app of appRegistry.APP_MANIFEST) {
      expect(app.id.length).toBeGreaterThan(0);
      expect(app.label.length).toBeGreaterThan(0);
      expect(app.navPath.startsWith("/"), `app '${app.id}' navPath must be absolute`).toBe(true);
    }
  });

  it("helpers agree with the manifest", () => {
    expect(appRegistry.APP_IDS).toEqual(appRegistry.APP_MANIFEST.map((a) => a.id));
    expect(appRegistry.isCanonicalAppId("usage")).toBe(true);
    expect(appRegistry.isCanonicalAppId("not-an-app")).toBe(false);
    expect(appRegistry.getApp("usage")?.permissions).toContain("usage:view");
    for (const key of appRegistry.manifestPermissionKeys()) {
      expect(catalogKeys.has(key)).toBe(true);
    }
  });

  // ── per-app access tier (view/edit) — the toggle-every-app invariant ──────────
  const appDomainKeys = new Set(
    identity.PERMISSION_CATALOG.filter((e) => e.domain === "app").map((e) => e.key),
  );

  it("every app declares BOTH a view and an edit access key", () => {
    for (const app of appRegistry.APP_MANIFEST) {
      expect(app.access, `app '${app.id}' has no access binding`).toBeDefined();
      expect(app.access.view.length, `app '${app.id}' missing access.view`).toBeGreaterThan(0);
      expect(app.access.edit.length, `app '${app.id}' missing access.edit`).toBeGreaterThan(0);
      expect(app.access.view, `app '${app.id}' view/edit must differ`).not.toBe(app.access.edit);
    }
  });

  it("every access key exists in PERMISSION_CATALOG under domain 'app'", () => {
    for (const app of appRegistry.APP_MANIFEST) {
      for (const key of [app.access.view, app.access.edit]) {
        expect(catalogKeys.has(key), `access key '${key}' (app '${app.id}') not in catalog`).toBe(true);
        expect(appDomainKeys.has(key), `access key '${key}' must be domain 'app'`).toBe(true);
      }
    }
  });

  it("access keys are unique across apps (no two apps share a per-app toggle)", () => {
    const all = appRegistry.allAppAccessKeys();
    expect(new Set(all).size, "duplicate per-app access key across apps").toBe(all.length);
    // exactly 2 per app (view+edit), covering every app
    expect(all.length).toBe(appRegistry.APP_MANIFEST.length * 2);
  });

  it("no orphan app:* catalog key — every domain-'app' key is claimed by exactly one app", () => {
    const claimed = new Set(appRegistry.allAppAccessKeys());
    for (const key of appDomainKeys) {
      expect(claimed.has(key), `catalog key '${key}' is in domain 'app' but no APP_MANIFEST entry claims it`).toBe(true);
    }
    expect(appDomainKeys.size).toBe(claimed.size);
  });

  it("access-key helpers agree with the manifest", () => {
    expect(appRegistry.appViewKey("gantt")).toBe("app:gantt:view");
    expect(appRegistry.appEditKey("participation")).toBe("app:participation:edit");
    expect(appRegistry.appViewKey("not-an-app")).toBeUndefined();
    expect(appRegistry.appAccessKeys("mail")).toEqual({ view: "app:mail:view", edit: "app:mail:edit" });
  });
});

describe("withRequiredAppDomainKeys — per-app grant carries its domain read key(s)", () => {
  it("granting app:members:edit bundles app:members:view + identity:read (edit ⇒ view)", () => {
    const out = new Set(appRegistry.withRequiredAppDomainKeys(["app:members:edit"]));
    expect(out.has("app:members:edit")).toBe(true);
    expect(out.has("app:members:view")).toBe(true); // edit ⇒ view
    expect(out.has("identity:read")).toBe(true); // domain read key so the toggle is EFFECTIVE
  });

  it("does NOT escalate to a domain write/admin key (minimal escalation)", () => {
    const out = new Set(appRegistry.withRequiredAppDomainKeys(["app:members:edit"]));
    expect(out.has("identity:admin")).toBe(false); // never grants org-admin
  });

  it("granting app:members:view bundles identity:read but not edit", () => {
    const out = new Set(appRegistry.withRequiredAppDomainKeys(["app:members:view"]));
    expect(out.has("identity:read")).toBe(true);
    expect(out.has("app:members:edit")).toBe(false);
  });

  it("bundles the correct domain key per app (events → event:read)", () => {
    const out = new Set(appRegistry.withRequiredAppDomainKeys(["app:events:view"]));
    expect(out.has("event:read")).toBe(true);
    expect(out.has("identity:read")).toBe(false);
  });

  it("is idempotent and leaves non-app keys untouched", () => {
    const once = appRegistry.withRequiredAppDomainKeys(["app:members:edit", "task:read"]);
    const twice = appRegistry.withRequiredAppDomainKeys(once);
    expect(twice).toEqual(once);
    expect(once).toContain("task:read");
  });

  it("a set with no per-app keys is returned unchanged (sorted)", () => {
    expect(appRegistry.withRequiredAppDomainKeys(["event:read", "event:write"])).toEqual(["event:read", "event:write"]);
  });
});
