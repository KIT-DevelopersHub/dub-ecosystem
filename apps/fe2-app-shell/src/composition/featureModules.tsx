// Composition · assemble FE3–FE7 into the shell FeatureModule array (W7a/W7b).
//
// Every feature (FE3–FE7) now exports a FeatureModule already shaped against
// FE2's canonical contract (../modules/types.tsx): route `lazy` loaders that
// resolve to `{ Component }`, `nav` entries keyed by `path`, and closed
// `IconName` icons. This module's remaining job is integration, not shape
// translation:
//   1. wrap each feature's route element in that feature's runtime Provider
//      (moduleProviders.tsx), all fed by the ONE shell api-client;
//   2. splice FE4's event-scoped task routes under FE3's `/events/:eventId`;
//   3. impose the shell-owned nav ordering (events < tasks < notifications <
//      chat < admin);
//   4. carry each feature's module-level requiredPermissions so registry
//      flatten() ANDs them onto every route (fail-closed authz).
// The result is the array FE2's registerFeatureModules() consumes (main.tsx).
import { createElement, type ComponentType, type ReactNode } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { eventFeatureModule, routePaths } from "@dub/fe3-event-action";
import { taskModule, eventTaskRoutes } from "@dub/fe4-task-gantt/src/features/task-gantt/public";
import { notificationsModule } from "@dub/fe5-notification-inbox";
import { chatFeature } from "@dub/fe6-chat/src/feature";
import { adminModule } from "@dub/admin-roster";
import type { ApiClient } from "../lib/api-client.tsx";
import type { FeatureModule, FeatureRoute, NavEntry } from "../modules/types.tsx";
import {
  ChatProviders,
  EventProviders,
  NotificationProviders,
  RosterProviders,
  TaskProviders,
} from "./moduleProviders.tsx";

type PermissionKey = identity.PermissionKey;
type ProviderComponent = ComponentType<{ api: ApiClient; children: ReactNode }>;
type ElementWrapper = (node: ReactNode) => JSX.Element;

/** A feature's route as authored against its own (canonical) shell contract. */
interface SourceRoute {
  path: string;
  lazy: FeatureRoute["lazy"];
  auth: "required" | "public";
  requiredPermissions?: readonly string[];
  children?: readonly SourceRoute[];
}
/** A feature's nav entry as authored against its own shell contract. */
interface SourceNav {
  label: string;
  path: string;
  icon: string;
  order: number;
  badgeSource?: () => number;
}

const asPath = (p: string): `/${string}` => (p.startsWith("/") ? (p as `/${string}`) : (`/${p}` as `/${string}`));

/** Map a free-form icon string onto the shell's closed IconName union (FE1
 *  contract). Retained for callers passing legacy icon aliases; every feature's
 *  own nav already ships a valid IconName, so those pass through untouched.
 *  Unknown icons degrade to a neutral glyph, never crash. */
const ICON_ALIASES: Record<string, IconName> = {
  home: "home",
  calendar: "calendar",
  event: "calendar",
  list: "check-square",
  task: "check-square",
  "check-square": "check-square",
  bell: "bell",
  notifications: "bell",
  chat: "message-square",
  message: "message-square",
  "message-square": "message-square",
  users: "users",
  user: "users",
  shield: "shield",
  settings: "settings",
  history: "file",
  file: "file",
  key: "shield",
};
function toIcon(raw: string | undefined): IconName {
  return (raw && ICON_ALIASES[raw]) || "file";
}

/** Wrap a route element in a feature Provider bound to the shell api-client. */
function providerWrapper(Provider: ProviderComponent, api: ApiClient): ElementWrapper {
  return (node) => createElement(Provider, { api, children: node });
}

/** Wrap a canonical `lazy` loader so the resolved Component mounts inside `wrap`. */
function wrapLazy(lazy: FeatureRoute["lazy"], wrap: ElementWrapper): FeatureRoute["lazy"] {
  return () => lazy().then(({ Component }) => ({ Component: () => wrap(createElement(Component)) }));
}

/** Convert a feature's SourceRoute to a shell FeatureRoute wrapped in `wrap`.
 *  requiredPermissions are cast to PermissionKey[]: FE3/FE4/FE6/FE7 already type
 *  them so; FE5 types them as string[] but the values are catalog keys by
 *  contract (notif:inbox:self / notif:prefs:self, now in PERMISSION_CATALOG). */
function wrapRoute(r: SourceRoute, wrap: ElementWrapper): FeatureRoute {
  const out: FeatureRoute = { path: asPath(r.path), lazy: wrapLazy(r.lazy, wrap), auth: r.auth };
  if (r.requiredPermissions) out.requiredPermissions = [...r.requiredPermissions] as PermissionKey[];
  return out;
}

/** Copy a feature's MODULE-LEVEL requiredPermissions onto the shell module.
 *  registry.flatten() ANDs these onto every route, so dropping them would
 *  SILENTLY weaken each route's authz gate. */
function withModulePerms(source: { requiredPermissions?: readonly string[] }, module: FeatureModule): FeatureModule {
  if (source.requiredPermissions && source.requiredPermissions.length > 0) {
    module.requiredPermissions = [...source.requiredPermissions] as PermissionKey[];
  }
  return module;
}

// ── events (FE3) + delegated tasks (FE4 nested under /events/:eventId) ─────────
function adaptEvents(api: ApiClient): FeatureModule {
  const wEvent = providerWrapper(EventProviders, api);
  const wTask = providerWrapper(TaskProviders, api);
  const wEventTask: ElementWrapper = (node) => wEvent(wTask(node));
  const src = eventFeatureModule.routes as readonly SourceRoute[];
  const routes: FeatureRoute[] = src.map((r) => {
    const route = wrapRoute(r, wEvent);
    // Splice FE4's real event-scoped task nest under FE3's event detail route.
    // FE4 owns these paths; FE3 declares no tasks body, so no duplicate results.
    if (r.path === routePaths.detail) {
      route.children = (eventTaskRoutes as readonly SourceRoute[]).map((tr) => wrapRoute(tr, wEventTask));
    }
    return route;
  });
  // FE3 declares its own /events nav (order 20); the shell owns top-level nav
  // ordering and pins events first (order 10).
  const nav: NavEntry[] = [{ label: "イベント", path: routePaths.list, icon: "calendar", order: 10 }];
  return withModulePerms(eventFeatureModule, { id: "events", routes, nav });
}

// ── tasks (FE4 top-level /me/tasks) ───────────────────────────────────────────
function adaptTasks(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(TaskProviders, api);
  const routes = (taskModule.routes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = (taskModule.nav as readonly SourceNav[]).map((n, i) => ({
    label: n.label,
    path: n.path,
    icon: n.icon as IconName,
    order: 20 + i,
  }));
  return withModulePerms(taskModule, { id: "tasks", routes, nav });
}

// ── notifications (FE5) ───────────────────────────────────────────────────────
function adaptNotifications(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(NotificationProviders, api);
  const routes = (notificationsModule.routes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = (notificationsModule.nav as readonly SourceNav[]).map((n, i) => {
    const e: NavEntry = { label: n.label, path: n.path, icon: n.icon as IconName, order: 30 + i };
    if (n.badgeSource) e.badgeSource = n.badgeSource;
    return e;
  });
  const module: FeatureModule = { id: "notifications", routes, nav };
  // FE5's routes are per-route gated (inbox / prefs); every notifications route
  // additionally requires the self-service inbox scope. FE5 does not declare a
  // module-level perm, so the shell imposes it here (registry.flatten ANDs it
  // onto both routes) — the frozen self-service authz gate.
  module.requiredPermissions = ["notif:inbox:self"];
  if (notificationsModule.headerWidget) {
    const Bell = notificationsModule.headerWidget;
    module.headerWidget = () => wrap(createElement(Bell));
  }
  return module;
}

// ── chat (FE6) ────────────────────────────────────────────────────────────────
function adaptChat(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(ChatProviders, api);
  const routes = (chatFeature.routes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = (chatFeature.nav as readonly SourceNav[]).map((n) => {
    const e: NavEntry = { label: n.label, path: n.path, icon: n.icon as IconName, order: 40 };
    if (n.badgeSource) e.badgeSource = n.badgeSource;
    return e;
  });
  return withModulePerms(chatFeature, { id: "chat", routes, nav });
}

// ── admin (FE7) ───────────────────────────────────────────────────────────────
function adaptAdmin(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(RosterProviders, api);
  const routes = (adminModule.routes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = (adminModule.nav as readonly SourceNav[]).map((n, i) => ({
    label: n.label,
    path: n.path,
    icon: n.icon as IconName,
    order: 50 + i, // admin section sits after the primary features
  }));
  return withModulePerms(adminModule, { id: "admin", routes, nav });
}

/**
 * The assembled shell FeatureModule array, ordered [events, tasks,
 * notifications, chat, admin]. Each module's routes are wrapped in its runtime
 * Provider fed by `api` (src/lib/api-client.tsx). Hand this to
 * registerFeatureModules() in main.tsx.
 */
export function assembleFeatureModules(api: ApiClient): FeatureModule[] {
  return [adaptEvents(api), adaptTasks(api), adaptNotifications(api), adaptChat(api), adaptAdmin(api)];
}

export { adaptEvents, adaptTasks, adaptNotifications, adaptChat, adaptAdmin, toIcon };
