// Pure logic for the PER-APP access tier of the permission matrix (domain "app") —
// EXTENDED (task: "有効/無効→レベル" per app) to also fold in that app's fine-grained
// CAPABILITY keys (e.g. task:write/task:delete, mail:send/mail:admin), not just its
// own app:<id>:view / app:<id>:edit pair.
//
// Product shape: ONE "有効化" toggle per app. Off = the role cannot use the app at all
// (and every underlying key below is cleared/hidden). On reveals a LEVEL selector whose
// options vary per app ("閲覧まで" always; "編集・作成まで" always; "管理まで" only when the
// app's domain has at least one manage-tier capability key — some apps genuinely have no
// higher tier than 編集). Picking a level maps to turning ON every key at or below that
// tier and OFF every key above it — the mapping IS the single source of truth for what a
// level means; nothing is invented at render time.
//
// Where the mapping comes from: APP_MANIFEST (@dub/types) is the source of truth for
// 1 app ⇄ its {view,edit} access-key pair AND the catalog `domain` it governs. This module
// additionally buckets every OTHER catalog key in that domain into 閲覧/編集/管理 by the verb
// in its action segment (classifyCapabilityAction) — the same classification already
// agreed for the role×permission grid. A "詳細" escape hatch (rendered by
// AppAccessSection) still exposes each individual key as its own toggle, so an admin can
// diverge from the canonical level mapping when a role needs an unusual combination.
//
// DESIGN DECISION (flag for product confirm): task (tasks + gantt) and identity (members
// + participation + admin) are each governed by >1 launcher app. A shared domain's
// capability key (e.g. task:write) is the SAME underlying RBAC key no matter which app's
// row you fold it into, so capability-folding it into just one app's level would make
// that app's level silently move a SIBLING app's effective grant too — breaking the
// existing, tested guarantee that gantt/tasks and participation/members toggle
// independently. To preserve that guarantee, a row whose domain is shared
// (`sharedDomain: true`) does NOT fold in capability keys at all: it stays access-only
// (開く/編集・作成 via app:<id>:view/edit, capped at 2 levels, no 詳細). Only a domain owned
// by exactly one app (event/notif/chat/mail/usage/drive/infra today) gets the full
// off→閲覧→編集→管理 folding. If task/identity should eventually get their own per-app
// capability levels too, APP_MANIFEST's domains would need to split (e.g. a dedicated
// "gantt" domain) — that is a product/registry decision, not made here.
import type { identity } from "@dub/types";
import { appRegistry } from "@dub/types";
import type { CatalogEntry } from "./permissionMatrix";
import { permissionLabel, permissionDescription } from "./permissionLabels";

export type PermissionKey = identity.PermissionKey;

/** 無効 / 閲覧まで / 編集・作成まで / 管理まで. Not every app offers "manage" — see availableLevels. */
export type AppAccessLevel = "off" | "view" | "edit" | "manage";

type CapabilityTier = Exclude<AppAccessLevel, "off">;
const TIER_ORDER: readonly CapabilityTier[] = ["view", "edit", "manage"];

export interface LabeledKey {
  key: PermissionKey;
  label: string;
  description: string;
  dangerous: boolean;
}

export interface AppAccessRow {
  id: string;
  label: string;
  /** The PERMISSION_CATALOG `domain` this app governs (APP_MANIFEST-driven). */
  domain: string;
  view: PermissionKey;
  edit: PermissionKey;
  /** Launcher tile is open to any authenticated user (usage / 参加届 / Drive共有). */
  openToAll: boolean;
  /**
   * This app's domain CAPABILITY keys (everything in `domain` except the app-access
   * pair itself, which lives in the separate "app" domain), bucketed by operation tier.
   * `view`/`edit` above are always included in their own tier and are NOT duplicated here.
   */
  viewKeys: LabeledKey[];
  editKeys: LabeledKey[];
  manageKeys: LabeledKey[];
  /** True when another launcher app shares this row's `domain` (see module doc CAVEAT). */
  sharedDomain: boolean;
}

// Classification is by the verb in the action segment (everything after the domain's
// leading "domain:"), NOT by the catalog's `dangerous` flag, so it stays stable if a flag
// is ever flipped. Total: an unrecognized future verb falls back to 編集・作成 — a visible,
// non-privileged middle tier — so a new catalog key is always representable, never hidden.
const MANAGE_ACTIONS = new Set(["admin", "moderate", "delete", "read_all", "deploy", "dns"]);
const EDIT_ACTIONS = new Set(["write", "create", "send", "sync", "broadcast_publish"]);
const VIEW_ACTIONS = new Set(["read", "view", "inbox:self", "prefs:self"]);

export function classifyCapabilityAction(key: string): CapabilityTier {
  const action = key.slice(key.indexOf(":") + 1);
  if (MANAGE_ACTIONS.has(action)) return "manage";
  if (VIEW_ACTIONS.has(action)) return "view";
  if (EDIT_ACTIONS.has(action)) return "edit";
  return "edit";
}

/** The per-app rows to render, in launcher order (APP_MANIFEST), enriched with each
 * app's domain capability keys (bucketed 閲覧/編集/管理) from the live `catalog`. */
export function appAccessRows(catalog: readonly CatalogEntry[]): AppAccessRow[] {
  const domainAppCount = new Map<string, number>();
  for (const a of appRegistry.APP_MANIFEST) {
    domainAppCount.set(a.domain, (domainAppCount.get(a.domain) ?? 0) + 1);
  }

  return appRegistry.APP_MANIFEST.map((a) => {
    const viewKeys: LabeledKey[] = [];
    const editKeys: LabeledKey[] = [];
    const manageKeys: LabeledKey[] = [];
    const shared = (domainAppCount.get(a.domain) ?? 0) > 1;
    // Capability folding only happens for a domain owned by EXACTLY ONE app. A shared
    // domain's capability key (e.g. task:read/write/delete for tasks+gantt, identity:read/
    // admin for members/participation/admin) is the SAME key regardless of which app's row
    // you fold it into — folding it into just one app's level would make toggling that
    // app's level silently change a SIBLING app's effective grant, breaking the tested
    // "gantt/tasks and participation/members toggle independently" guarantee. Shared-domain
    // rows therefore stay access-only (view/edit via app:<id>:view/edit, no manage tier,
    // no 詳細) — identical to the pre-existing behavior for those apps.
    if (!shared) {
      for (const e of catalog) {
        if (e.domain !== a.domain) continue;
        const labeled: LabeledKey = {
          key: e.key as PermissionKey,
          label: permissionLabel(e.key, e.name),
          description: permissionDescription(e.key, e.description),
          dangerous: e.dangerous === true,
        };
        const tier = classifyCapabilityAction(e.key);
        (tier === "view" ? viewKeys : tier === "edit" ? editKeys : manageKeys).push(labeled);
      }
    }
    return {
      id: a.id,
      label: a.label,
      domain: a.domain,
      view: a.access.view,
      edit: a.access.edit,
      openToAll: (a as { openToAllAuthenticated?: boolean }).openToAllAuthenticated === true,
      viewKeys,
      editKeys,
      manageKeys,
      sharedDomain: shared,
    };
  });
}

/** Every key belonging to one operation tier of this row (app-access key included). */
function tierKeys(row: AppAccessRow, tier: CapabilityTier): PermissionKey[] {
  if (tier === "view") return [row.view, ...row.viewKeys.map((k) => k.key)];
  if (tier === "edit") return [row.edit, ...row.editKeys.map((k) => k.key)];
  return row.manageKeys.map((k) => k.key);
}

/** Every key this row can ever touch, across all tiers (for "any key on" checks etc). */
export function allRowKeys(row: AppAccessRow): PermissionKey[] {
  return TIER_ORDER.flatMap((t) => tierKeys(row, t));
}

/** The levels this app actually offers, in order. "管理" only appears when the app's
 * domain has at least one manage-tier capability key (some apps top out at 編集). */
export function availableLevels(row: AppAccessRow): AppAccessLevel[] {
  const levels: AppAccessLevel[] = ["off", "view", "edit"];
  if (row.manageKeys.length > 0) levels.push("manage");
  return levels;
}

/** Current level for one app given the selected key set — the highest tier with ANY of
 * its keys on. (edit/manage still resolve even if a lower tier's key is individually off,
 * e.g. after a 詳細 edit; the level shown is a best-effort summary, not the sole truth —
 * the underlying keys always govern actual RBAC effect.) */
export function appAccessLevel(selected: readonly PermissionKey[], row: AppAccessRow): AppAccessLevel {
  const set = new Set(selected);
  let top: AppAccessLevel = "off";
  for (const tier of TIER_ORDER) {
    if (tierKeys(row, tier).some((k) => set.has(k))) top = tier;
  }
  return top;
}

/**
 * Return a NEW sorted key set with `row` set to `level`: every key at or below that tier
 * turns ON, every key above turns OFF. `off` clears every key this row owns. This mapping
 * (レベル → 対応する権限キー群のon/off) is the single source of truth for what a level means.
 * Keys in `lockedKeys` are never turned off (self-lockout guard), even by a downgrade.
 */
export function setAppAccessLevel(
  selected: readonly PermissionKey[],
  row: AppAccessRow,
  level: AppAccessLevel,
  lockedKeys: readonly PermissionKey[] = [],
): PermissionKey[] {
  const set = new Set(selected);
  const locked = new Set(lockedKeys);
  const targetIdx = level === "off" ? -1 : TIER_ORDER.indexOf(level);
  TIER_ORDER.forEach((tier, i) => {
    for (const k of tierKeys(row, tier)) {
      if (i <= targetIdx) set.add(k);
      else if (!locked.has(k)) set.delete(k);
    }
  });
  return [...set].sort();
}

/** Enable/disable an app (the top-level 有効化 toggle). Enabling defaults to 閲覧まで;
 *  disabling clears every key this row owns (view/edit/manage). Re-enabling always starts
 *  from 閲覧 — the level selector is where 編集/管理 is chosen back. */
export function toggleAppEnabled(
  selected: readonly PermissionKey[],
  row: AppAccessRow,
  enabled: boolean,
  lockedKeys: readonly PermissionKey[] = [],
): PermissionKey[] {
  return setAppAccessLevel(selected, row, enabled ? "view" : "off", lockedKeys);
}

export interface AppAccessSummary {
  enabled: number; // apps with any level above off
  total: number;
}

/** Header count for the "アプリのアクセス権" group. */
export function appAccessSummary(selected: readonly PermissionKey[], rows: readonly AppAccessRow[]): AppAccessSummary {
  const enabled = rows.reduce((n, r) => n + (appAccessLevel(selected, r) === "off" ? 0 : 1), 0);
  return { enabled, total: rows.length };
}
