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
});
