// Pure logic for the PER-APP access tier of the permission matrix (domain "app").
//
// The catalog groups per-app keys under domain "app" as a flat list of view/edit
// toggles. This module folds those flat keys into the product UX the coordinator
// specified: ONE "有効化" toggle per app that, when on, reveals a nested level
// selector 「閲覧まで / 編集・作成まで」. It maps 1 app ⇄ its {view,edit} key pair
// (APP_MANIFEST is the single source of truth) so gantt and 参加届 each get their OWN
// toggle instead of riding a shared domain key. No React here → exhaustively unit-testable.
import type { identity } from "@dub/types";
import { appRegistry } from "@dub/types";

export type PermissionKey = identity.PermissionKey;

/** 無効 / 閲覧まで / 編集・作成まで. */
export type AppAccessLevel = "off" | "view" | "edit";

export interface AppAccessRow {
  id: string;
  label: string;
  view: PermissionKey;
  edit: PermissionKey;
  /** Launcher tile is open to any authenticated user (usage / 参加届 / Drive共有). */
  openToAll: boolean;
}

/** The per-app rows to render, in launcher order (APP_MANIFEST). */
export function appAccessRows(): AppAccessRow[] {
  return appRegistry.APP_MANIFEST.map((a) => ({
    id: a.id,
    label: a.label,
    view: a.access.view,
    edit: a.access.edit,
    openToAll: (a as { openToAllAuthenticated?: boolean }).openToAllAuthenticated === true,
  }));
}

/** Current level for one app given the selected key set (edit ⇒ view). */
export function appAccessLevel(selected: readonly PermissionKey[], row: AppAccessRow): AppAccessLevel {
  const set = new Set(selected);
  if (set.has(row.edit)) return "edit"; // edit implies view even if view key absent
  if (set.has(row.view)) return "view";
  return "off";
}

/**
 * Return a NEW sorted key set with `row` set to `level`. edit always co-carries view
 * (edit ⇒ view) so the resolved permission set is self-consistent regardless of how the
 * matrix persists it. off removes both keys.
 */
export function setAppAccessLevel(
  selected: readonly PermissionKey[],
  row: AppAccessRow,
  level: AppAccessLevel,
): PermissionKey[] {
  const set = new Set(selected);
  set.delete(row.view);
  set.delete(row.edit);
  if (level === "view") set.add(row.view);
  else if (level === "edit") {
    set.add(row.view);
    set.add(row.edit);
  }
  return [...set].sort();
}

/** Enable/disable an app (the top-level 有効化 toggle). Enabling defaults to 閲覧まで;
 *  disabling clears both keys. Preserves 編集・作成 when re-enabling is NOT wanted — the
 *  toggle only flips off↔view; the level selector moves between view↔edit. */
export function toggleAppEnabled(
  selected: readonly PermissionKey[],
  row: AppAccessRow,
  enabled: boolean,
): PermissionKey[] {
  return setAppAccessLevel(selected, row, enabled ? "view" : "off");
}

export interface AppAccessSummary {
  enabled: number; // apps with view or edit
  total: number;
}

/** Header count for the "アプリのアクセス権" group. */
export function appAccessSummary(selected: readonly PermissionKey[]): AppAccessSummary {
  const rows = appAccessRows();
  const enabled = rows.reduce((n, r) => n + (appAccessLevel(selected, r) === "off" ? 0 : 1), 0);
  return { enabled, total: rows.length };
}
