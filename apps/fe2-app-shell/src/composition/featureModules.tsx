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
import { notificationsModule } from "@dub/fe5-notification-inbox";
import { adminModule } from "@dub/admin-roster";
// FE4/FE6 have no package export map yet — reached via the single deep-import
// boundary (featureEntries.tsx), never directly.
import { taskModule, eventTaskRoutes, chatFeature } from "./featureEntries.tsx";
import type { ApiClient } from "../lib/api-client.tsx";
import type { FeatureModule, FeatureRoute, NavEntry } from "../modules/types.tsx";
import { mailRoutes, mailNav } from "../features/mail/index.tsx";
import { MailProvider } from "../features/mail/MailProvider.tsx";
import { usageRoutes, usageNav } from "../features/usage/index.tsx";
import { UsageProvider } from "../features/usage/UsageProvider.tsx";
import { ganttRoutes, ganttNav } from "../features/gantt/index.tsx";
import { GanttProvider } from "../features/gantt/GanttProvider.tsx";
import { driveShareRoutes, driveShareNav } from "../features/driveshare/index.tsx";
import { DriveShareProvider } from "../features/driveshare/DriveShareProvider.tsx";
import { membersRoutes, membersNav } from "../features/members/index.tsx";
import { MembersProvider } from "../features/members/MembersProvider.tsx";
import { participationRoutes, participationNav } from "../features/participation/index.tsx";
import { ParticipationProvider } from "../features/participation/ParticipationProvider.tsx";
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
  // ordering and pins events first (order 10). イベントは誤って launcher/ナビから
  // 外れていたためユーザー承認で復活（アプリを減らさない原則）。メールアドレス管理
  // (/admin/email-routing) だけは意図的撤去のまま。
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

// ── mail (FE2-local feature module) ───────────────────────────────────────────
// Unlike FE3–FE7, mail has no separate front-end package: it lives in the shell
// (apps/fe2-app-shell/src/features/mail). It still ships a canonical FeatureModule
// so it registers, routes, and authz-gates exactly like the others. Its routes are
// wrapped in MailProvider (MailApi built from the one shell api-client); nav sits
// after chat (order 45) and before admin.
function adaptMail(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(MailProvider, api);
  const routes = (mailRoutes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = mailNav.map((n) => ({ label: n.label, path: n.path, icon: n.icon, order: 45 }));
  return { id: "mail", routes, nav };
}

// ── usage (FE2-local feature module) ──────────────────────────────────────────
// Like mail, the free-tier usage & billing-guard dashboard lives in the shell
// (apps/fe2-app-shell/src/features/usage) rather than a separate FE package. It
// ships a canonical FeatureModule so it registers, routes, and authz-gates exactly
// like the others. Its route is wrapped in UsageProvider (UsageApi built from the
// one shell api-client); nav sits after mail (order 46), before admin. The route +
// nav carry auth:"required" but no requiredPermissions, matching usage-meter's server
// gate: any signed-in user may view the (safe) free-tier numbers, so the launcher tile
// shows and the route renders for everyone logged in. (The adapter still copies through
// any requiredPermissions if a future policy adds one.)
function adaptUsage(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(UsageProvider, api);
  const routes = (usageRoutes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = usageNav.map((n) => {
    const e: NavEntry = { label: n.label, path: n.path, icon: n.icon, order: 46 };
    if (n.requiredPermissions) e.requiredPermissions = [...n.requiredPermissions] as PermissionKey[];
    return e;
  });
  return { id: "usage", routes, nav };
}

// ── gantt (FE2-local feature module) ──────────────────────────────────────────
// The task Gantt is event-scoped (`/events/:eventId/tasks/gantt`, owned by FE4),
// so there is no top-level Gantt route to point a launcher tile at. This shell-local
// feature adds a "ガントチャート" landing (`/gantt`) that lists the user's events and
// opens the chosen event's Gantt — a proper Gantt entry point in the 9-dot launcher
// without hiding or removing any existing app. nav sits right after マイタスク
// (order 21) and carries task:read so the tile shows only for users who can open a
// Gantt (matching FE4's event-scoped Gantt route gate).
function adaptGantt(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(GanttProvider, api);
  const routes = (ganttRoutes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = ganttNav.map((n) => {
    const e: NavEntry = { label: n.label, path: n.path, icon: n.icon, order: 21 };
    if (n.requiredPermissions) e.requiredPermissions = [...n.requiredPermissions] as PermissionKey[];
    return e;
  });
  return { id: "gantt", routes, nav };
}

// ── members (FE2-local feature module) ────────────────────────────────────────
// 運営メンバー管理 (invite status + team membership; the GUI replacement for the
// hand-maintained 組織図 PDF). Like mail/usage it lives in the shell (features/members)
// rather than a separate FE package. Nav sits after usage (order 47), before admin.
// Route gate = identity:read; write actions are re-authorized server-side (identity:admin).
function adaptMembers(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(MembersProvider, api);
  const routes = (membersRoutes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = membersNav.map((n) => ({ label: n.label, path: n.path, icon: n.icon, order: 47 }));
  return { id: "members", routes, nav };
}

// ── participation (FE2-local feature module) ──────────────────────────────────
// 参加届: a signed-in 運営 files their own 参加届, which member-service reflects onto
// the roster (招待中→追加済, or a new 追加済 member). Like mail/members it lives in the
// shell (features/participation) and rides the one api-client. Nav sits after members
// (order 49), before admin. No requiredPermissions — the submit endpoint is open to any
// authenticated user, so the launcher tile shows for everyone signed in; the roster
// write is re-authorized server-side by member-service.
function adaptParticipation(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(ParticipationProvider, api);
  const routes = (participationRoutes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = participationNav.map((n, i) => {
    // 参加届(提出)は全員に、回答一覧は identity:read を持つ運営だけにランチャー表示。
    const e: NavEntry = { label: n.label, path: n.path, icon: n.icon, order: 49 + i };
    if (n.requiredPermissions && n.requiredPermissions.length > 0) {
      e.requiredPermissions = [...n.requiredPermissions] as PermissionKey[];
    }
    return e;
  });
  return { id: "participation", routes, nav };
}

// ── driveshare (FE2-local feature module) ─────────────────────────────────────
// Like mail/usage, the Hackit Drive sharing manager lives in the shell
// (apps/fe2-app-shell/src/features/driveshare) rather than a separate FE package. Its
// route is wrapped in DriveShareProvider (DriveShareApi built from the one shell
// api-client); nav sits after members (order 48), before admin. The backend
// (drive-share-service) is the authoritative drive:read/drive:write gate.
function adaptDriveShare(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(DriveShareProvider, api);
  const routes = (driveShareRoutes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  const nav: NavEntry[] = driveShareNav.map((n) => ({ label: n.label, path: n.path, icon: n.icon, order: 48 }));
  return { id: "driveshare", routes, nav };
}

// ── admin (FE7) ───────────────────────────────────────────────────────────────
function adaptAdmin(api: ApiClient): FeatureModule {
  const wrap = providerWrapper(RosterProviders, api);
  const src = adminModule.routes as readonly SourceRoute[];
  const routes = src.map((r) => wrapRoute(r, wrap));
  // Map each admin route path -> its own requiredPermissions so the launcher can
  // hide the admin tools (ユーザー名簿 / ロール管理 / 変更履歴) from non-admins, matching
  // the route guard (defense in depth; a non-admin can neither see nor open them).
  // メールアドレス管理 (/admin/email-routing) のみユーザー明示承認で FE7 の routes/nav から
  // 登録解除済み（fe7-admin-roster/src/routes.tsx）。変更履歴 は誤撤去のため復活済み。
  // 残る admin ツールは権限保持者に全て表示する。
  const permByPath = new Map(src.map((r) => [r.path, r.requiredPermissions]));
  const nav: NavEntry[] = (adminModule.nav as readonly SourceNav[]).map((n, i) => {
    const perms = permByPath.get(n.path);
    const e: NavEntry = { label: n.label, path: n.path, icon: n.icon as IconName, order: 50 + i };
    if (perms && perms.length > 0) e.requiredPermissions = [...perms] as PermissionKey[];
    return e;
  });
  return withModulePerms(adminModule, { id: "admin", routes, nav });
}

/** Stamp the owning module id onto every nav entry so the launcher/route guard can
 *  look up the app's member-release status (lib/releaseGate). Done once here rather
 *  than in each adaptX so the appId can never drift from the module it belongs to. */
function withNavAppId(module: FeatureModule): FeatureModule {
  module.nav = module.nav.map((n) => ({ ...n, appId: module.id }));
  return module;
}

/**
 * The assembled shell FeatureModule array, ordered [events, tasks,
 * notifications, chat, mail, usage, members, participation, driveshare, admin]. Each module's routes are wrapped in its runtime
 * Provider fed by `api` (src/lib/api-client.tsx). Hand this to
 * registerFeatureModules() in main.tsx.
 */
export function assembleFeatureModules(api: ApiClient): FeatureModule[] {
  return [
    adaptEvents(api),
    adaptTasks(api),
    adaptGantt(api),
    adaptNotifications(api),
    adaptChat(api),
    adaptMail(api),
    adaptUsage(api),
    adaptMembers(api),
    adaptParticipation(api),
    adaptDriveShare(api),
    adaptAdmin(api),
  ].map(withNavAppId);
}

export { adaptEvents, adaptTasks, adaptGantt, adaptNotifications, adaptChat, adaptMail, adaptUsage, adaptMembers, adaptParticipation, adaptDriveShare, adaptAdmin, toIcon };
