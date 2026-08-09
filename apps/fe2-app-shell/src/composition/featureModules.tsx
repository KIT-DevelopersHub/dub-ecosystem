// Composition · assemble FE3–FE7 into the shell FeatureModule array (W7a).
//
// FE3–FE7 each define a FeatureModule against their OWN local shell contract
// (routes shaped as eager `Component`, lazy `component`, `nestedRoutes`, single
// or array `nav`, per-feature icon strings). This module adapts every one of
// them onto FE2's canonical FeatureModule (../modules/types.tsx) and wraps each
// route's element in that feature's runtime Provider (moduleProviders.tsx), all
// fed by the ONE shell api-client. The result is the array FE2's
// registerFeatureModules() consumes — nothing imports it yet (W7a is
// independently mergeable; main.tsx wiring is a later step and is NOT edited).
import { createElement, type ComponentType, type ReactNode } from "react";
import type { identity } from "@dub/types";
import { eventFeatureModule } from "@dub/fe3-event-action";
import { taskModule } from "@dub/fe4-task-gantt/src/features/task-gantt/public";
import { notificationsModule } from "@dub/fe5-notification-inbox";
import { chatFeature } from "@dub/fe6-chat/src/feature";
import { adminModule } from "@dub/admin-roster";
import type { ApiClient } from "../lib/api-client.tsx";
import type { FeatureModule, FeatureRoute, NavEntry } from "../modules/types.tsx";
import type { IconName } from "../stubs/icons.tsx";
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

const asPath = (p: string): `/${string}` => (p.startsWith("/") ? (p as `/${string}`) : (`/${p}` as `/${string}`));

/** Map each feature's free-form icon string onto the shell's closed IconName
 *  union (FE1 contract). Unknown icons degrade to a neutral glyph, never crash. */
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

/** lazy() for an already-loaded component (FE3/FE7 expose eager Components). */
function eagerLazy(Component: ComponentType, wrap: ElementWrapper): FeatureRoute["lazy"] {
  return () => Promise.resolve({ Component: () => wrap(createElement(Component)) });
}

/** lazy() for a code-split loader (FE5/FE6 expose `() => Promise<{default}>`). */
function loaderLazy(
  loader: () => Promise<{ default: ComponentType }>,
  wrap: ElementWrapper,
): FeatureRoute["lazy"] {
  return () => loader().then((m) => ({ Component: () => wrap(createElement(m.default)) }));
}

/** lazy() for a route whose body is not yet published (FE4 ships null loaders);
 *  the Provider still mounts so the wiring is real and forward-compatible. */
function placeholderLazy(wrap: ElementWrapper): FeatureRoute["lazy"] {
  return () => Promise.resolve({ Component: () => wrap(null) });
}

/** Carry a feature's MODULE-LEVEL requiredPermissions onto the shell module.
 *  registry.flatten() merges these onto every route (AND semantics), so dropping
 *  them here would SILENTLY weaken each route's authz gate. FE5 declares
 *  module-level perms today; every adapter copies them uniformly so any feature
 *  that adds module-level perms later is honoured without another shell change.
 *  Source contracts type these as string[] but they are PermissionKey by contract. */
function withModulePerms(
  source: { id: string; requiredPermissions?: readonly string[] },
  module: FeatureModule,
): FeatureModule {
  if (source.requiredPermissions && source.requiredPermissions.length > 0) {
    module.requiredPermissions = [...source.requiredPermissions] as PermissionKey[];
  }
  return module;
}

// ── events (FE3) + delegated tasks (FE4 nested) ──────────────────────────────
function fe4NestedTaskRoutes(wrap: ElementWrapper): FeatureRoute[] {
  const nested = taskModule.nestedRoutes;
  if (!nested) return [];
  return nested.routes.map((rd) => ({
    path: asPath(`/events/:eventId/${rd.path}`),
    lazy: placeholderLazy(wrap),
    auth: "required",
    requiredPermissions: rd.requiredPermissions ?? [],
  }));
}

function adaptFe3Route(
  r: (typeof eventFeatureModule.routes)[number],
  wEvent: ElementWrapper,
  wEventTask: ElementWrapper,
): FeatureRoute {
  const route: FeatureRoute = {
    path: asPath(r.path),
    lazy: eagerLazy(r.Component, wEvent),
    auth: "required",
    requiredPermissions: r.requiredPermissions,
  };
  const kids: FeatureRoute[] = [];
  for (const c of r.children ?? []) {
    if (c.delegated) continue; // FE3 exposes an empty slot; FE4 owns the body
    kids.push(adaptFe3Route(c, wEvent, wEventTask));
  }
  if ((r.children ?? []).some((c) => c.delegated)) {
    kids.push(...fe4NestedTaskRoutes(wEventTask)); // splice in FE4's real nest
  }
  if (kids.length > 0) route.children = kids;
  return route;
}

function adaptEvents(api: ApiClient): FeatureModule {
  const wEvent = providerWrapper(EventProviders, api);
  const wTask = providerWrapper(TaskProviders, api);
  const wEventTask: ElementWrapper = (node) => wEvent(wTask(node));
  return withModulePerms(eventFeatureModule, {
    id: "events",
    routes: eventFeatureModule.routes.map((r) => adaptFe3Route(r, wEvent, wEventTask)),
    // FE3 declares no nav (events is the shell's primary section); the shell owns
    // top-level nav ordering, so it supplies the entry here.
    nav: [{ label: "イベント", path: "/events", icon: "calendar", order: 10 }],
  });
}

// ── tasks (FE4 top-level /me/tasks) ──────────────────────────────────────────
function adaptTasks(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(TaskProviders, api);
  const routes: FeatureRoute[] = taskModule.routes.map((rd) => ({
    path: asPath(rd.path),
    lazy: placeholderLazy(wrap), // FE4 public routes are null loaders (see note)
    auth: "required",
    requiredPermissions: rd.requiredPermissions ?? [],
  }));
  const nav: NavEntry[] = (taskModule.nav ?? []).map((n, i) => ({
    label: n.label,
    path: n.to,
    icon: toIcon(n.icon),
    order: 20 + i,
  }));
  return withModulePerms(taskModule, { id: "tasks", routes, nav });
}

// ── notifications (FE5) ──────────────────────────────────────────────────────
function adaptNotifications(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(NotificationProviders, api);
  const routes: FeatureRoute[] = notificationsModule.routes.map((r) => ({
    path: asPath(r.path),
    lazy: loaderLazy(r.component, wrap),
    auth: "required",
    // FE5 typed perms as string[]; they are PermissionKey values by contract.
    requiredPermissions: r.requiredPermissions as PermissionKey[],
  }));
  const nav: NavEntry[] = notificationsModule.nav.map((n, i) => ({
    label: n.label,
    path: n.to,
    icon: toIcon(n.icon),
    order: 30 + i,
    ...(n.badgeSource ? { badgeSource: n.badgeSource } : {}),
  }));
  const module: FeatureModule = { id: "notifications", routes, nav };
  if (notificationsModule.headerWidget) {
    const Bell = notificationsModule.headerWidget;
    module.headerWidget = () => wrap(createElement(Bell));
  }
  return withModulePerms(notificationsModule, module);
}

// ── chat (FE6) ───────────────────────────────────────────────────────────────
function adaptChat(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(ChatProviders, api);
  const routes: FeatureRoute[] = chatFeature.routes.map((r) => ({
    path: asPath(r.path),
    lazy: loaderLazy(r.component, wrap),
    auth: "required",
    requiredPermissions: r.requiredPermissions ?? [],
  }));
  const n = chatFeature.nav; // FE6 declares a single nav object
  const nav: NavEntry[] = [
    {
      label: n.label,
      path: n.to,
      icon: toIcon(n.icon),
      order: 40,
      ...(n.badgeSource ? { badgeSource: n.badgeSource } : {}),
    },
  ];
  return withModulePerms(chatFeature, { id: "chat", routes, nav });
}

// ── admin (FE7) ──────────────────────────────────────────────────────────────
function adaptAdmin(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(RosterProviders, api);
  const routes: FeatureRoute[] = adminModule.routes.map((r) => ({
    path: asPath(r.path),
    lazy: eagerLazy(r.component, wrap),
    auth: "required",
    requiredPermissions: r.requiredPermissions,
  }));
  const nav: NavEntry[] = adminModule.nav.map((n, i) => ({
    label: n.label,
    path: n.path,
    icon: toIcon(n.icon),
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
