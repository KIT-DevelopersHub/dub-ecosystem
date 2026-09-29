// CI invariant: the canonical app registry (APP_MANIFEST) is the single source of
// truth for the launcher app set, and EVERY app is backed by real RBAC permission
// key(s). This is the mechanism that stops a new app from shipping without a
// per-app permission (the historical 抜け漏れ). The compile-time `PermissionKey`
// union already rejects unknown keys; these runtime assertions make the invariant
// explicit and catch JS-level drift.
import { describe, it, expect } from "vitest";
import { identity, appRegistry, policy } from "../src/index";

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
  const appDomainKeys = new Set<string>(
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
    const claimed = new Set<string>(appRegistry.allAppAccessKeys());
    for (const key of appDomainKeys) {
      expect(claimed.has(key), `catalog key '${key}' is in domain 'app' but no APP_MANIFEST entry claims it`).toBe(true);
    }
    expect(appDomainKeys.size).toBe(claimed.size);
  });

  // ── 詳細設定 scope (detailPermissions) — the partition invariant ───────────────
  // Every app declares which fine-grained keys its 詳細設定 dialog owns; the keys nobody
  // claims are, by definition, the 「その他」 block. These assertions are what makes a NEW
  // catalog key impossible to lose: it is either claimed by one app or it is その他.
  it("every app declares a detailPermissions scope ([] is an explicit answer)", () => {
    for (const app of appRegistry.APP_MANIFEST) {
      expect(Array.isArray(app.detailPermissions), `app '${app.id}' has no detailPermissions`).toBe(true);
    }
  });

  it("detail keys exist in the catalog and are never per-app (domain 'app') keys", () => {
    for (const app of appRegistry.APP_MANIFEST) {
      for (const key of app.detailPermissions) {
        expect(catalogKeys.has(key), `app '${app.id}' detail key '${key}' not in catalog`).toBe(true);
        expect(appDomainKeys.has(key), `app '${app.id}' must not claim graded key '${key}'`).toBe(false);
      }
    }
  });

  it("no catalog key is claimed by two apps (no key shown in two 詳細 dialogs)", () => {
    const owner = new Map<string, string>();
    for (const app of appRegistry.APP_MANIFEST) {
      for (const key of app.detailPermissions) {
        const prev = owner.get(key);
        expect(prev, `'${key}' claimed by both '${prev}' and '${app.id}'`).toBeUndefined();
        owner.set(key, app.id);
      }
    }
  });

  it("app detail keys + その他 partition the catalog exactly (nothing unreachable)", () => {
    const claimed = new Set(policy.claimedDetailKeys());
    const other = new Set(policy.otherPermissions().map((e) => e.key));
    const graded = new Set(policy.appAccessCatalogKeys());
    for (const entry of identity.PERMISSION_CATALOG) {
      const buckets = [claimed.has(entry.key), other.has(entry.key), graded.has(entry.key)].filter(Boolean).length;
      expect(buckets, `'${entry.key}' must live in exactly one bucket (app 詳細 / その他 / 段階), got ${buckets}`).toBe(1);
    }
    expect(claimed.size + other.size + graded.size).toBe(identity.PERMISSION_CATALOG.length);
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
