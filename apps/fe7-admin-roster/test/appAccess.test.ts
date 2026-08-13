import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { appEnabled, appControllable, toggleApp } from "../src/lib/appAccess";
import { APP_CATALOG, isAppGatingPermission, type AppCatalogEntry } from "../src/lib/appCatalog";

const gated: AppCatalogEntry = { id: "admin-history", label: "変更履歴", requiredPermissions: ["audit:read"], description: "" };
const multi: AppCatalogEntry = { id: "x", label: "X", requiredPermissions: ["identity:read", "identity:admin"], description: "" };
const ungated: AppCatalogEntry = { id: "mail", label: "メール", requiredPermissions: [], description: "" };

describe("appAccess — appEnabled", () => {
  it("a gated app is on only when ALL its required permissions are held", () => {
    expect(appEnabled(["audit:read"], gated)).toBe(true);
    expect(appEnabled([], gated)).toBe(false);
    expect(appEnabled(["identity:read"], multi)).toBe(false); // missing identity:admin
    expect(appEnabled(["identity:read", "identity:admin"], multi)).toBe(true);
  });

  it("an ungated app (常時利用可) is always on", () => {
    expect(appEnabled([], ungated)).toBe(true);
  });
});

describe("appAccess — appControllable", () => {
  it("gated apps are controllable; ungated apps are not", () => {
    expect(appControllable(gated)).toBe(true);
    expect(appControllable(ungated)).toBe(false);
  });

  it("an app whose every gating key is locked is not controllable", () => {
    expect(appControllable(gated, ["audit:read"])).toBe(false);
    expect(appControllable(multi, ["identity:admin"])).toBe(true); // identity:read still free
  });
});

describe("appAccess — toggleApp", () => {
  it("turning on adds all gating permissions (sorted, deduped)", () => {
    expect(toggleApp(["event:read"], multi, true)).toEqual(["event:read", "identity:admin", "identity:read"]);
  });

  it("turning off removes all gating permissions", () => {
    expect(toggleApp(["audit:read", "event:read"], gated, false)).toEqual(["event:read"]);
  });

  it("turning off never removes a locked key (self-lockout guard)", () => {
    expect(toggleApp(["identity:read", "identity:admin"], multi, false, ["identity:admin"])).toEqual(["identity:admin"]);
  });

  it("ungated app toggling is a no-op on the permission set", () => {
    expect(toggleApp(["mail:read"], ungated, false)).toEqual(["mail:read"]);
  });
});

describe("appCatalog", () => {
  it("every gated app's required permissions are recognized as app-gating", () => {
    for (const app of APP_CATALOG) {
      for (const p of app.requiredPermissions) expect(isAppGatingPermission(p)).toBe(true);
    }
  });

  it("includes the admin-history app gated by audit:read (used by the launcher demo)", () => {
    const hist = APP_CATALOG.find((a) => a.id === "admin-history");
    expect(hist?.requiredPermissions).toEqual(["audit:read"]);
  });
});
