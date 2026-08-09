import { describe, expect, it } from "vitest";
import { notificationsModule } from "../src/module";
import { useUnreadStore, getUnreadCount } from "../src/store/unread-store";
import { PERM_INBOX, PERM_PREFS, ROUTE_INBOX, ROUTE_PREFERENCES } from "../src/lib/routes";

describe("notificationsModule (FeatureModule contract)", () => {
  it("declares id, both routes with permissions, nav, and the header widget", () => {
    expect(notificationsModule.id).toBe("notifications");
    const paths = notificationsModule.routes.map((r) => r.path);
    expect(paths).toEqual([ROUTE_INBOX, ROUTE_PREFERENCES]);
    const inbox = notificationsModule.routes.find((r) => r.path === ROUTE_INBOX)!;
    expect(inbox.requiredPermissions).toEqual([PERM_INBOX]);
    const prefs = notificationsModule.routes.find((r) => r.path === ROUTE_PREFERENCES)!;
    expect(prefs.requiredPermissions).toEqual([PERM_PREFS]);
    expect(notificationsModule.headerWidget).toBeDefined();
    expect(notificationsModule.nav[0]!.badgeSource).toBeDefined();
  });

  it("routes are lazy loaders that resolve to a default component", async () => {
    const mod = await notificationsModule.routes[0]!.component();
    expect(typeof mod.default).toBe("function");
  });

  it("nav badgeSource reads the shared unread store (single source of truth)", () => {
    useUnreadStore.setState({ count: 5, initialized: true });
    expect(notificationsModule.nav[0]!.badgeSource!()).toBe(5);
    expect(getUnreadCount()).toBe(5);
  });
});
