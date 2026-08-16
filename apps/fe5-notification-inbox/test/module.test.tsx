import { describe, expect, it } from "vitest";
import { notificationsModule } from "../src/module";
import { useUnreadStore, getUnreadCount } from "../src/store/unread-store";
import { PERM_INBOX, PERM_PREFS, PERM_BROADCAST_PUBLISH, ROUTE_INBOX, ROUTE_PREFERENCES, ROUTE_MANAGE } from "../src/lib/routes";

describe("notificationsModule (FeatureModule contract)", () => {
  it("declares id, routes (inbox / prefs / admin manage) with permissions + auth, nav, and the header widget", () => {
    expect(notificationsModule.id).toBe("notifications");
    const paths = notificationsModule.routes.map((r) => r.path);
    expect(paths).toEqual([ROUTE_INBOX, ROUTE_PREFERENCES, ROUTE_MANAGE]);
    const inbox = notificationsModule.routes.find((r) => r.path === ROUTE_INBOX)!;
    expect(inbox.requiredPermissions).toEqual([PERM_INBOX]);
    expect(inbox.auth).toBe("required");
    const prefs = notificationsModule.routes.find((r) => r.path === ROUTE_PREFERENCES)!;
    expect(prefs.requiredPermissions).toEqual([PERM_PREFS]);
    expect(prefs.auth).toBe("required");
    const manage = notificationsModule.routes.find((r) => r.path === ROUTE_MANAGE)!;
    expect(manage.requiredPermissions).toEqual([PERM_BROADCAST_PUBLISH]);
    expect(manage.auth).toBe("required");
    expect(notificationsModule.headerWidget).toBeDefined();
    const nav = notificationsModule.nav[0]!;
    expect(nav.path).toBe(ROUTE_INBOX);
    expect(nav.icon).toBe("bell");
    expect(typeof nav.order).toBe("number");
    expect(nav.badgeSource).toBeDefined();
  });

  it("routes are lazy loaders that resolve to { Component } (FE2 shell shape)", async () => {
    const mod = await notificationsModule.routes[0]!.lazy();
    expect(typeof mod.Component).toBe("function");
  });

  it("nav badgeSource reads the shared unread store (single source of truth)", () => {
    useUnreadStore.setState({ count: 5, initialized: true });
    expect(notificationsModule.nav[0]!.badgeSource!()).toBe(5);
    expect(getUnreadCount()).toBe(5);
  });
});
