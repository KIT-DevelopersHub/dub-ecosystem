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
import { createElement, useMemo, type ComponentType, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { appRegistry, type identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { eventFeatureModule, routePaths } from "@dub/fe3-event-action";
import { notificationsModule } from "@dub/fe5-notification-inbox";
import { adminModule } from "@dub/admin-roster";
// FE4/FE6 have no package export map yet — reached via the single deep-import
// boundary (featureEntries.tsx), never directly.
import { taskModule, eventTaskRoutes, chatFeature, TaskRouteProvider, useTaskRoute } from "./featureEntries.tsx";
import type { TaskRouteContextValue } from "./featureEntries.tsx";
import type { ApiClient } from "../lib/api-client.tsx";
import type { FeatureModule, FeatureRoute, NavEntry } from "../modules/types.tsx";
import { mailRoutes, mailNav } from "../features/mail/index.tsx";
import { MailProvider } from "../features/mail/MailProvider.tsx";
import { usageRoutes, usageNav } from "../features/usage/index.tsx";
import { UsageProvider } from "../features/usage/UsageProvider.tsx";
import { ganttRoutes, ganttNav } from "../features/gantt/index.tsx";
import { GanttProvider } from "../features/gantt/GanttProvider.tsx";
import { GlobalEventSwitcher } from "../features/gantt/GlobalEventSwitcher.tsx";
import { driveShareRoutes, driveShareNav } from "../features/driveshare/index.tsx";
import { DriveShareProvider } from "../features/driveshare/DriveShareProvider.tsx";
import { membersRoutes, membersNav } from "../features/members/index.tsx";
import { MembersProvider } from "../features/members/MembersProvider.tsx";
import { MemberRosterNav } from "../features/members/MemberRosterNav.tsx";
import { participationRoutes } from "../features/participation/index.tsx";
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

/** 運営メンバー・名簿 統合アプリの共有サブナビ帯でセクション本体を包む（Provider の外側）。
 *  members(member-service) と admin(identity-roster) の両セクションに同じ帯を敷き、
 *  ランチャー 1 タイルの中で横断できるようにする（合体後も両ルート/Providerは維持）。 */
const rosterChromeWrapper: ElementWrapper = (node) => createElement(MemberRosterNav, { children: node });

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

/** Bridge the REACTIVE `:eventId` route param into FE4's TaskRouteContext, on top
 *  of the currentUserId/permissions TaskProviders already set. Only the event-scoped
 *  task routes carry an eventId, so the injection lives here (not in TaskProviders,
 *  which also serves the paramless マイタスク route and must stay router-context-free
 *  for its isolated unit test). A same-route param change (the header switcher
 *  navigating evt_A→evt_B) re-runs useParams here → new eventId → the gantt reloads. */
function TaskEventIdBridge({ children }: { children: ReactNode }): JSX.Element {
  const params = useParams({ strict: false }) as Record<string, string>;
  const base = useTaskRoute();
  const eventId = (params.eventId ?? null) as TaskRouteContextValue["eventId"];
  const value = useMemo<TaskRouteContextValue>(() => ({ ...base, eventId }), [base, eventId]);
  return createElement(TaskRouteProvider, { value, children });
}

// ── events (FE3) + delegated tasks (FE4 nested under /events/:eventId) ─────────
function adaptEvents(api: ApiClient): FeatureModule {
  const wEvent = providerWrapper(EventProviders, api);
  const wTask = providerWrapper(TaskProviders, api);
  // EventProviders → TaskProviders → TaskEventIdBridge(reactive eventId) → route.
  const wEventTask: ElementWrapper = (node) =>
    wEvent(wTask(createElement(TaskEventIdBridge, { children: node })));
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
  // ランチャーのイベントタイルは「イベント詳細ハブ」(routePaths.hub=/event-hub) を開く。
  // 以前は routePaths.list(/events=一覧) を指しており、④で増補した詳細ハブではなく
  // イベントカード一覧が既定表示になって「一覧に戻った」状態だった（本 fix の根因）。
  // ヘッダー(EventAppHeader / 全体スイッチャ)で選択中のイベントの詳細をハブが主表示する。
  const nav: NavEntry[] = [{ label: "イベント", path: routePaths.hub, icon: "calendar", order: 10 }];
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
  const module: FeatureModule = { id: "gantt", routes, nav };
  // Global イベント header selector (GCP-style). Wrapped in GanttProvider (for the
  // api-client) like FE5's bell; it self-gates to gantt/tasks routes and navigates
  // the event param on select. Placed "leading" = LEFT of the 9-dot AppLauncher (the
  // context selector precedes the app/utility icon cluster; the bell stays trailing).
  module.headerWidget = () => wrap(createElement(GlobalEventSwitcher));
  module.headerWidgetPlacement = "leading";
  return module;
}

// ── members (FE2-local feature module) ────────────────────────────────────────
// 運営メンバー管理 (invite status + team membership; the GUI replacement for the
// hand-maintained 組織図 PDF). Like mail/usage it lives in the shell (features/members)
// rather than a separate FE package. Nav sits after usage (order 47), before admin.
// Route gate = identity:read; write actions are re-authorized server-side (identity:admin).
function adaptMembers(api: ApiClient): FeatureModule {
  const provider = providerWrapper(MembersProvider, api);
  // chrome(サブナビ) は Provider の外側: (node) => <MemberRosterNav>{<MembersProvider>node</MembersProvider>}</MemberRosterNav>
  const wrap: ElementWrapper = (node) => rosterChromeWrapper(provider(node));
  const routes = (membersRoutes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  // 統合タイル「運営メンバー・名簿」。運営メンバー(member-service) と 名簿(FE7 /admin/users) と
  // 参加届＋回答(participation) を同じアプリとして開く。名簿/参加届/回答 の個別タイルは廃止し、この
  // タイル内の共有サブナビ(MemberRosterNav)から横断する。ロール管理(/admin/roles) だけは独立タイル
  // として adaptAdmin が別に出す（ユーザー明示指示: ロールを外に括り出す）。
  const nav: NavEntry[] = membersNav.map((n) => ({ label: "運営メンバー・名簿", path: n.path, icon: n.icon, order: 47 }));
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
  const provider = providerWrapper(ParticipationProvider, api);
  // 参加届(提出) と 参加届の回答(管理) は「運営メンバー・名簿」統合アプリのセクションに畳む。
  // 共有サブナビ(MemberRosterNav) を Provider の外側に敷き、名簿/運営メンバーと同じ帯で横断する。
  const wrap: ElementWrapper = (node) => rosterChromeWrapper(provider(node));
  const routes = (participationRoutes as readonly SourceRoute[]).map((r) => wrapRoute(r, wrap));
  // 個別ランチャータイルは廃止（nav=[]）。参加届は運営メンバー・名簿タイル内のサブナビからのみ横断する
  // （ユーザー明示指示: 参加届＋回答管理を運営メンバーにまとめる）。ルート/Provider は維持し deep-link も生存。
  const nav: NavEntry[] = [];
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
  const provider = providerWrapper(RosterProviders, api);
  // 名簿(/admin/users*) は「運営メンバー・名簿」統合タイルの一部 → 共有サブナビ(chrome)を Provider の
  // 外側に敷き、そのタブから横断する（個別タイルは出さない）。ロール管理(/admin/roles*) はユーザー明示
  // 指示で独立ランチャータイル「ロール管理」として単独で開く → chrome は敷かず単独アプリとして成立させる。
  const rosterWrap: ElementWrapper = (node) => rosterChromeWrapper(provider(node));
  const src = adminModule.routes as readonly SourceRoute[];
  const routes = src.map((r) =>
    r.path.startsWith("/admin/roles") ? wrapRoute(r, provider) : wrapRoute(r, rosterWrap),
  );
  // 独立ランチャータイルは「ロール管理」(/admin/roles) の 1 つだけ。名簿(/admin/users) は運営メンバー・
  // 名簿タイル内の共有サブナビ(MemberRosterNav)から開くので個別タイルを出さない。変更履歴(/admin/history)
  // の UI は撤去済み（ルート/コンポーネントごと削除・監査ログのデータ基盤は残置）。route ガード
  // (requiredPermissions)・headerWidget は維持。app:admin:view が名簿タブとロール管理タイルの両方をガードする。
  const nav: NavEntry[] = [{ label: "ロール管理", path: "/admin/roles", icon: "shield", order: 50 }];
  return withModulePerms(adminModule, { id: "admin", routes, nav });
}

/** Stamp the owning module id onto every nav entry so the launcher/route guard can
 *  look up the app's member-release status (lib/releaseGate). Done once here rather
 *  than in each adaptX so the appId can never drift from the module it belongs to. */
function withNavAppId(module: FeatureModule): FeatureModule {
  module.nav = module.nav.map((n) => ({ ...n, appId: module.id }));
  return module;
}

/** AND the app's per-app `app:<id>:view` access key onto the module (so registry.flatten
 *  gates every route — the deep-link 403) AND onto each nav entry (so the launcher greys
 *  the tile for a role without it). This is the ACTUAL per-app gate: turning app:<id>:view
 *  off for a role now hides+blocks exactly that one app (gantt/参加届 included), independent
 *  of the shared domain permission it historically rode. Non-breaking: an additive backfill
 *  (identity-roster) grants the key to every role that can reach the app today, so no one
 *  loses access on rollout. Fail-closed: while /me loads, can() is false → gated. */
function withAppAccessGate(module: FeatureModule): FeatureModule {
  const viewKey = appRegistry.appViewKey(module.id);
  if (!viewKey) return module; // unreachable: every module id is a canonical app
  const add = (perms: readonly PermissionKey[] | undefined): PermissionKey[] => [
    ...new Set([...(perms ?? []), viewKey]),
  ];
  module.requiredPermissions = add(module.requiredPermissions);
  module.nav = module.nav.map((n) => ({ ...n, requiredPermissions: add(n.requiredPermissions) }));
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
  ].map(withNavAppId).map(withAppAccessGate);
}

export { adaptEvents, adaptTasks, adaptGantt, adaptNotifications, adaptChat, adaptMail, adaptUsage, adaptMembers, adaptParticipation, adaptDriveShare, adaptAdmin, toIcon };
