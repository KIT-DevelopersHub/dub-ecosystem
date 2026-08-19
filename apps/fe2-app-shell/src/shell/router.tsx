// Shell router (design 2-2 / 2-5). Builds a TanStack Router from the shell's own
// four screens plus the routes aggregated from registered FeatureModules. Route
// paths use the design's `:param` form and are converted to TanStack's `$param`.
// Each feature route is wrapped with the auth/permission guard before mounting.
import { Suspense, lazy } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import type { ApiClient } from "../lib/api-client.tsx";
import type { Registry, ResolvedRoute } from "../modules/types.tsx";
import { RequireAuth, RequirePermission, usePermissions } from "../auth/AuthProvider.tsx";
import { isReleaseGatedFor } from "../lib/releaseGate.ts";
import type { FeatureModuleId } from "../modules/types.tsx";
import { AppShellLayout } from "./AppShellLayout.tsx";
import { RouteLoadingBar } from "./RouteLoadingBar.tsx";
import { LoginScreen } from "./screens/LoginScreen.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { PublicParticipationPage, PUBLIC_PARTICIPATION_PATH } from "../features/participation/index.tsx";
import { openNotificationDialog } from "@dub/fe5-notification-inbox";
import { NotFoundScreen } from "./screens/NotFoundScreen.tsx";
import { PermissionDeniedScreen } from "./screens/PermissionDeniedScreen.tsx";
import { RouteErrorScreen } from "./screens/RouteErrorScreen.tsx";
import { isChunkLoadError, reloadForStaleChunk } from "../lib/chunkReload.ts";

/** Wrap a lazy route factory so a failed dynamic import (stale hashed chunk after
 *  a deploy) auto-recovers with a one-time reload instead of surfacing a bare
 *  "Something went wrong!" — the 通知 / 名簿 が開けない incident. On a chunk-load
 *  error we reload once to fetch the fresh index.html; the returned never-settling
 *  promise keeps React in Suspense until the navigation happens. If the loop guard
 *  suppresses the reload, the original error is rethrown so RouteErrorScreen shows. */
function lazyRoute(load: () => Promise<{ Component: ComponentType }>): ComponentType {
  return lazy(() =>
    load()
      .then((m) => ({ default: m.Component }))
      .catch((err: unknown) => {
        if (isChunkLoadError(err) && reloadForStaleChunk()) {
          return new Promise<{ default: ComponentType }>(() => {});
        }
        throw err;
      }),
  );
}

/** Convert design `:param` segments to TanStack Router `$param`. */
export function toTanstackPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "$$$1").replace(/\/\*$/, "/$");
}

// Member release-gating on direct navigation (defense in depth for the launcher
// grey-out, see lib/releaseGate). A general member who deep-links to an app that is
// not yet member-published gets the permission-denied screen instead of the working
// page; only full admins (isPrivilegedViewer = identity:admin) bypass it, matching the launcher.
function RequirePublished({ moduleId, children }: { moduleId: FeatureModuleId; children: JSX.Element }): JSX.Element {
  const { can } = usePermissions();
  // Parity with the launcher (AppShellLayout): an explicit per-app grant (app:<id>:view)
  // OR admin OR member-publish releases the app; only an unannounced+ungranted app 403s.
  if (!isReleaseGatedFor(moduleId, can)) return children;
  return <PermissionDeniedScreen />;
}

function guard(route: ResolvedRoute, Body: ComponentType): () => JSX.Element {
  return function Guarded(): JSX.Element {
    let node: JSX.Element = <Body />;
    for (const perm of route.requiredPermissions) {
      // Missing permission on an authenticated user is a 403 (not a 404): the page
      // exists, the user just isn't authorized. Show the permission-denied screen so
      // they know to ask an admin, instead of the misleading "page not found".
      node = (
        <RequirePermission permission={perm} fallback={<PermissionDeniedScreen />}>
          {node}
        </RequirePermission>
      );
    }
    if (route.auth === "required") {
      // Member release gate wraps the permission gate: an unpublished app is denied
      // to general members regardless of their per-route permissions. Scoped to
      // authenticated routes (public pages are never member-gated).
      node = <RequirePublished moduleId={route.moduleId}>{node}</RequirePublished>;
      return <RequireAuth loadingFallback={<RouteLoadingBar active />}>{node}</RequireAuth>;
    }
    return node;
  };
}

export function createShellRouter(
  api: ApiClient,
  registry: Registry,
  opts?: { onNavigate?: (p: string) => void; onLogout?: () => void },
) {
  const rootRoute = createRootRoute({ component: Outlet });

  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: () => <LoginScreen api={api} />,
  });

  // PUBLIC 参加届 form — a sibling of /login, deliberately OUTSIDE the shellRoute (which
  // wraps everything in RequireAuth). Anonymous participants can reach and submit it
  // without a session; only the form submit is opened (management stays 運営-only).
  const publicParticipationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: PUBLIC_PARTICIPATION_PATH,
    component: () => <PublicParticipationPage api={api} />,
  });

  // Authenticated shell layout wraps the home screen and all feature routes.
  const shellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "shell",
    component: () => (
      <AppShellLayout
        navEntries={registry.nav}
        headerWidgets={registry.headerWidgets}
        leadingHeaderWidgets={registry.leadingHeaderWidgets}
        api={api}
        {...(opts?.onNavigate ? { onNavigate: opts.onNavigate } : {})}
        {...(opts?.onLogout ? { onLogout: opts.onLogout } : {})}
      >
        <RequireAuth loadingFallback={<RouteLoadingBar active />}>
          <Suspense fallback={<RouteLoadingBar active />}>
            <Outlet />
          </Suspense>
        </RequireAuth>
      </AppShellLayout>
    ),
  });

  const homeRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/",
    component: () => (
      <HomeScreen
        api={api}
        homeWidgets={registry.homeWidgets}
        onOpenNotifications={openNotificationDialog}
        {...(opts?.onNavigate ? { onNavigate: opts.onNavigate } : {})}
      />
    ),
  });

  const featureRoutes = registry.routes.map((r) => {
    const Body = lazyRoute(() => r.lazy());
    const Guarded = guard(r, Body);
    return createRoute({
      getParentRoute: () => shellRoute,
      path: toTanstackPath(r.path),
      component: Guarded,
    });
  });

  const routeTree = rootRoute.addChildren([
    loginRoute,
    publicParticipationRoute,
    shellRoute.addChildren([homeRoute, ...featureRoutes]),
  ]);

  return createRouter({
    routeTree,
    defaultNotFoundComponent: NotFoundScreen,
    // Replace TanStack's bare "Something went wrong!" with a screen that, for a
    // stale-chunk failure, auto-reloads once (and always offers a manual reload).
    defaultErrorComponent: RouteErrorScreen,
  });
}
