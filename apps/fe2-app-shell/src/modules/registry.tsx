// FeatureModule registry (design 2-3 / 2-5). Aggregates FE3-FE7 modules into the
// shell: flattens routes (nested children included), merges module-level required
// permissions onto each route, sorts nav by order, collects headerWidgets. Segment
// ownership is enforced: a duplicate route path is a STARTUP error (design 2-5).
import type { identity } from "@dub/types";
import type { ComponentType } from "react";
import type { FeatureModule, FeatureRoute, HomeWidget, NavEntry, Registry, ResolvedRoute } from "./types.tsx";

type PermissionKey = identity.PermissionKey;

function flatten(
  routes: FeatureRoute[],
  moduleId: FeatureModule["id"],
  modulePerms: PermissionKey[],
  acc: ResolvedRoute[],
): void {
  for (const r of routes) {
    acc.push({
      path: r.path,
      lazy: r.lazy,
      auth: r.auth,
      requiredPermissions: [...modulePerms, ...(r.requiredPermissions ?? [])],
      moduleId,
    });
    if (r.children && r.children.length > 0) {
      flatten(r.children, moduleId, modulePerms, acc);
    }
  }
}

export function buildRegistry(modules: FeatureModule[]): Registry {
  const seenModuleIds = new Set<string>();
  const routes: ResolvedRoute[] = [];
  const nav: NavEntry[] = [];
  const headerWidgets: ComponentType[] = [];
  const leadingHeaderWidgets: ComponentType[] = [];
  const homeWidgets: HomeWidget[] = [];

  for (const m of modules) {
    if (seenModuleIds.has(m.id)) {
      throw new Error(`FeatureModule id duplicated at startup: "${m.id}"`);
    }
    seenModuleIds.add(m.id);
    flatten(m.routes, m.id, m.requiredPermissions ?? [], routes);
    nav.push(...m.nav);
    if (m.headerWidget) {
      (m.headerWidgetPlacement === "leading" ? leadingHeaderWidgets : headerWidgets).push(m.headerWidget);
    }
    if (m.homeWidget) homeWidgets.push(m.homeWidget);
  }

  // Segment ownership: duplicate route path across modules is a startup error.
  const seenPaths = new Map<string, FeatureModule["id"]>();
  for (const r of routes) {
    const owner = seenPaths.get(r.path);
    if (owner !== undefined) {
      throw new Error(`Route segment "${r.path}" claimed by both "${owner}" and "${r.moduleId}" (duplicate ownership)`);
    }
    seenPaths.set(r.path, r.moduleId);
  }

  nav.sort((a, b) => a.order - b.order);
  return { modules: [...modules], nav, routes, headerWidgets, leadingHeaderWidgets, homeWidgets };
}

let current: Registry | null = null;

/** Aggregate and register FE3-FE7 modules into the shell (design 2-3). */
export function registerFeatureModules(modules: FeatureModule[]): Registry {
  current = buildRegistry(modules);
  return current;
}

export function getRegistry(): Registry {
  if (!current) throw new Error("registerFeatureModules() has not been called");
  return current;
}

/** Test-only reset of the module-level singleton. */
export function __resetRegistry(): void {
  current = null;
}
