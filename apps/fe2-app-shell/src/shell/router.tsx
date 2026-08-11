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
import { RequireAuth, RequirePermission } from "../auth/AuthProvider.tsx";
import { AppShellLayout } from "./AppShellLayout.tsx";
import { RouteLoadingBar } from "./RouteLoadingBar.tsx";
import { LoginScreen } from "./screens/LoginScreen.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { NotFoundScreen } from "./screens/NotFoundScreen.tsx";
import { PermissionDeniedScreen } from "./screens/PermissionDeniedScreen.tsx";

/** Convert design `:param` segments to TanStack Router `$param`. */
export function toTanstackPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "$$$1").replace(/\/\*$/, "/$");
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

  // Authenticated shell layout wraps the home screen and all feature routes.
  const shellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "shell",
    component: () => (
      <AppShellLayout
        navEntries={registry.nav}
        headerWidgets={registry.headerWidgets}
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
    component: () => <HomeScreen api={api} homeWidgets={registry.homeWidgets} />,
  });

  const featureRoutes = registry.routes.map((r) => {
    const Body = lazy(() => r.lazy().then((m) => ({ default: m.Component })));
    const Guarded = guard(r, Body);
    return createRoute({
      getParentRoute: () => shellRoute,
      path: toTanstackPath(r.path),
      component: Guarded,
    });
  });

  const routeTree = rootRoute.addChildren([
    loginRoute,
    shellRoute.addChildren([homeRoute, ...featureRoutes]),
  ]);

  return createRouter({
    routeTree,
    defaultNotFoundComponent: NotFoundScreen,
  });
}
