// policy — the RBAC POLICY LAYER: the single place that turns a role's raw permission
// key set into DECISIONS ("may this role open マイタスク? may it press 保存?").
//
// WHY this module exists (what was 雑 before it):
//   The per-app graded keys (`app:<id>:view` / `app:<id>:edit`) existed, but every
//   consumer re-derived their meaning by hand: FE7 folded them in its own lib, the
//   identity-roster seed had a SECOND hand-written app→permission table, the shell had a
//   third, and nothing checked them server-side. Same idea, four implementations, each
//   free to drift — and a newly added app was only covered where someone remembered to
//   add it.
//
// The shape:
//   - `AppAccessLevel` is the enum every layer speaks: none(無効) < view(閲覧) < edit(編集).
//   - It is DERIVED from (and normalises back to) the frozen catalog keys, so the wire
//     contract and the DB are unchanged — the level is a projection, not a new column.
//   - Everything iterates APP_MANIFEST, so a NEW APP IS AUTOMATICALLY INCLUDED: it gets a
//     row in the ロール管理 table, a capability flag, a policy requirement and a CI assertion
//     the moment it is registered. Nothing to remember, nothing to miss.
//   - Decision logic only (a PDP): pure, synchronous, no I/O. The enforcement points are
//     @dub/auth-client `requireAppAccess` (services) and the shell's `useAppCapability`
//     flags (buttons) — both call in here so they can never disagree.
import { PERMISSION_CATALOG, type PermissionCatalogEntry, type PermissionKey } from "./identity";
import { APP_MANIFEST, getApp, type AppId, type AppManifestEntry } from "./app-registry";

// ── the level enum ────────────────────────────────────────────────────────────
/**
 * Per-app access level — the 3 段階 an admin picks per app in ロール管理.
 *   none = 無効 (the app cannot be opened at all; launcher greys it, route guard 403s)
 *   view = 閲覧 (can open and read; every write affordance is disabled)
 *   edit = 編集 (can create/update inside the app; IMPLIES view)
 * Ordered: a requirement of `view` is satisfied by `edit`.
 */
export const AppAccessLevel = {
  None: "none",
  View: "view",
  Edit: "edit",
} as const;
export type AppAccessLevel = (typeof AppAccessLevel)[keyof typeof AppAccessLevel];

/** The levels in ascending order of power — the canonical order for 3-way UI selectors. */
export const APP_ACCESS_LEVELS: readonly AppAccessLevel[] = ["none", "view", "edit"];

/** Japanese labels (ロール管理 の一覧表 / バッジ). */
export const APP_ACCESS_LEVEL_LABELS: Record<AppAccessLevel, string> = {
  none: "無効",
  view: "閲覧",
  edit: "編集",
};

/** One-line explanation of each level (UI hint / dialog copy). */
export const APP_ACCESS_LEVEL_DESCRIPTIONS: Record<AppAccessLevel, string> = {
  none: "このアプリを使えません（メニューに出ず、開こうとしても拒否されます）",
  view: "開いて見ることはできますが、作成・編集・削除のボタンは押せません",
  edit: "開いて見られるうえに、作成・編集・削除ができます",
};

const LEVEL_RANK: Record<AppAccessLevel, number> = { none: 0, view: 1, edit: 2 };

/** Numeric rank for comparison (none=0 < view=1 < edit=2). */
export function levelRank(level: AppAccessLevel): number {
  return LEVEL_RANK[level];
}

/** True when `actual` is at least as powerful as `required` (edit satisfies view). */
export function levelAtLeast(actual: AppAccessLevel, required: AppAccessLevel): boolean {
  return LEVEL_RANK[actual] >= LEVEL_RANK[required];
}

/** Runtime guard for values arriving from the wire / storage. */
export function isAppAccessLevel(value: unknown): value is AppAccessLevel {
  return typeof value === "string" && value in LEVEL_RANK;
}

/**
 * The level an HTTP method demands: reads need 閲覧, anything else needs 編集. Lets a
 * service gate a whole route group with one rule instead of per-route bookkeeping.
 */
export function levelForMethod(method: string): AppAccessLevel {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? AppAccessLevel.View : AppAccessLevel.Edit;
}

// ── level ⇄ permission keys ───────────────────────────────────────────────────
/**
 * The catalog keys a role must hold to reach `level` on `appId`. `none` needs nothing;
 * `view` needs the view key; `edit` needs BOTH (edit ⇒ view is materialised, never
 * implied-only, so the stored set is self-describing and SQL/D1 queries stay trivial).
 * Unknown app id ⇒ `[]` (callers treat "no keys required" together with the unknown-app
 * decision reason below — `decide()` fails closed).
 */
export function keysForAppLevel(appId: string, level: AppAccessLevel): PermissionKey[] {
  const app = getApp(appId);
  if (!app) return [];
  if (level === AppAccessLevel.Edit) return [app.access.view, app.access.edit];
  if (level === AppAccessLevel.View) return [app.access.view];
  return [];
}

/** The level `granted` currently confers on `appId`. `edit` wins even if the view key is
 *  absent (defensive: a legacy row that holds only the edit key still means 編集). */
export function appAccessLevelOf(granted: Iterable<PermissionKey>, appId: string): AppAccessLevel {
  const app = getApp(appId);
  if (!app) return AppAccessLevel.None;
  const set = granted instanceof Set ? granted : new Set(granted);
  if (set.has(app.access.edit)) return AppAccessLevel.Edit;
  if (set.has(app.access.view)) return AppAccessLevel.View;
  return AppAccessLevel.None;
}

/**
 * A NEW sorted key set with `appId` moved to `level`. Only that app's two keys are
 * touched; every other key (fine-grained 詳細 keys included) is preserved verbatim, so the
 * 一覧表 can flip a level without silently discarding a 詳細設定.
 */
export function setAppAccessLevel(
  granted: readonly PermissionKey[],
  appId: string,
  level: AppAccessLevel,
): PermissionKey[] {
  const app = getApp(appId);
  if (!app) return [...granted].sort();
  const set = new Set(granted);
  set.delete(app.access.view);
  set.delete(app.access.edit);
  for (const k of keysForAppLevel(appId, level)) set.add(k);
  return [...set].sort();
}

/** Fine-grained toggle pairs where the change key is useless without the read key. */
const IMPLIED_DETAIL_KEYS: readonly (readonly [PermissionKey, PermissionKey])[] = [
  ["drive:settings_edit", "drive:settings_view"],
  ["calendar:meetings_edit", "calendar:meetings_view"],
  // 運営メンバーの範囲は積み上げ式。1 周で閉じるよう上位の鍵から順に並べる。
  ["members:mail_edit", "members:mail_view"],
  ["members:mail_edit", "members:roster_edit"],
  ["members:mail_view", "members:roster_view"],
  ["members:roster_edit", "members:roster_view"],
];

/**
 * Enforce the edit ⇒ view invariant across EVERY app (adds the missing view key rather
 * than dropping edit — dropping would silently downgrade a role). Idempotent; the
 * identity-roster write path runs it so no stored role can be in the inconsistent
 * "edit without view" state regardless of which client wrote it.
 */
export function normalizeAppAccessKeys(granted: readonly PermissionKey[]): PermissionKey[] {
  const set = new Set(granted);
  for (const app of APP_MANIFEST) {
    if (set.has(app.access.edit)) set.add(app.access.view);
  }
  for (const [edit, view] of IMPLIED_DETAIL_KEYS) if (set.has(edit)) set.add(view);
  return [...set].sort();
}

/** Level for EVERY registered app (no gaps — a new app appears here automatically). */
export function appAccessMap(granted: Iterable<PermissionKey>): Record<AppId, AppAccessLevel> {
  const set = granted instanceof Set ? granted : new Set(granted);
  const out = {} as Record<AppId, AppAccessLevel>;
  for (const app of APP_MANIFEST) out[app.id as AppId] = appAccessLevelOf(set, app.id);
  return out;
}

// ── 運営メンバーの範囲 ────────────────────────────────────────────────────────
/**
 * 運営メンバーアプリの中で届くタブの範囲。閲覧・編集それぞれに 1 つ選ぶ。app:members:* の 3 段階とは
 * 別の軸で、3 段階が「閲覧」なら編集範囲は効かない (サーバの表が app:members:edit も要求する)。
 *   org_chart = 運営メンバー + 組織図 (個人情報は返さない)
 *   roster    = + 運営名簿
 *   all       = + メール名簿
 */
export const MembersScope = { OrgChart: "org_chart", Roster: "roster", All: "all" } as const;
export type MembersScope = (typeof MembersScope)[keyof typeof MembersScope];
export type MembersScopeMode = "view" | "edit";

/** 狭い順。ロール管理の選択肢の並びを兼ねる。 */
export const MEMBERS_SCOPES: readonly MembersScope[] = ["org_chart", "roster", "all"];

export const MEMBERS_SCOPE_LABELS: Record<MembersScope, string> = {
  org_chart: "組織図まで",
  roster: "メール名簿以外",
  all: "全て",
};

export const MEMBERS_SCOPE_DESCRIPTIONS: Record<MembersScopeMode, Record<MembersScope, string>> = {
  view: {
    org_chart: "運営メンバーと組織図のタブだけ。このアプリでは連絡先などの本人の情報を表示しません",
    roster: "運営名簿のタブまで。本人の情報も表示します。メール名簿のタブは出ません",
    all: "メール名簿のタブまで全部",
  },
  edit: {
    org_chart: "チーム、運営での項目（担当・役職など）、メンバーの追加と削除まで。本人の情報は変更できません",
    roster: "運営名簿のタブまで。本人の情報の変更やアカウントの紐付けもできます",
    all: "メール名簿のタブまで全部",
  },
};

const MEMBERS_SCOPE_KEYS: Record<MembersScopeMode, { roster: PermissionKey; mail: PermissionKey }> = {
  view: { roster: "members:roster_view", mail: "members:mail_view" },
  edit: { roster: "members:roster_edit", mail: "members:mail_edit" },
};

/** `granted` が `mode` で届く範囲。鍵が無ければ最も狭い 組織図まで (既定で個人情報を出さない)。 */
export function membersScopeOf(granted: Iterable<PermissionKey>, mode: MembersScopeMode): MembersScope {
  const set = granted instanceof Set ? granted : new Set(granted);
  const keys = MEMBERS_SCOPE_KEYS[mode];
  if (set.has(keys.mail)) return MembersScope.All;
  if (set.has(keys.roster)) return MembersScope.Roster;
  return MembersScope.OrgChart;
}

/**
 * `mode` の範囲を `scope` にした新しい鍵集合。編集範囲は閲覧範囲を超えられないので、編集を広げると
 * 閲覧も広がり、閲覧を狭めると編集も狭まる。他の鍵には触らない。
 */
export function setMembersScope(
  granted: readonly PermissionKey[],
  mode: MembersScopeMode,
  scope: MembersScope,
): PermissionKey[] {
  const rank = MEMBERS_SCOPES.indexOf(scope);
  const current = {
    view: MEMBERS_SCOPES.indexOf(membersScopeOf(granted, "view")),
    edit: MEMBERS_SCOPES.indexOf(membersScopeOf(granted, "edit")),
  };
  const next =
    mode === "edit"
      ? { view: Math.max(current.view, rank), edit: rank }
      : { view: rank, edit: Math.min(current.edit, rank) };
  const set = new Set(granted);
  for (const m of ["view", "edit"] as const) {
    set.delete(MEMBERS_SCOPE_KEYS[m].roster);
    set.delete(MEMBERS_SCOPE_KEYS[m].mail);
    if (next[m] >= 1) set.add(MEMBERS_SCOPE_KEYS[m].roster);
    if (next[m] >= 2) set.add(MEMBERS_SCOPE_KEYS[m].mail);
  }
  return [...set].sort();
}

// ── capability flags (what the UI disables buttons with) ──────────────────────
/**
 * Resolved capability flags for one app. `readOnly` is the flag a 閲覧 user is in: the
 * screen renders, the 保存/作成/削除 affordances are disabled. Fail-closed by construction
 * (an unknown app id yields all-false), so forgetting to register an app hides its write
 * UI rather than exposing it.
 */
export interface AppCapability {
  appId: string;
  label: string;
  level: AppAccessLevel;
  /** level !== none — the app is usable at all (launcher tile enabled). */
  enabled: boolean;
  /** May open + read. */
  canView: boolean;
  /** May create/update/delete inside the app. */
  canEdit: boolean;
  /** canView && !canEdit — show the screen, disable every write control. */
  readOnly: boolean;
}

/** Capability flags for one app id (unknown id ⇒ everything false). */
export function appCapability(granted: Iterable<PermissionKey>, appId: string): AppCapability {
  const app = getApp(appId);
  const level = appAccessLevelOf(granted, appId);
  const canView = levelAtLeast(level, AppAccessLevel.View);
  const canEdit = level === AppAccessLevel.Edit;
  return {
    appId,
    label: app?.label ?? appId,
    level,
    enabled: level !== AppAccessLevel.None,
    canView,
    canEdit,
    readOnly: canView && !canEdit,
  };
}

/** Capability flags for EVERY registered app — the whole-ecosystem view a shell provider
 *  hands down, so a new app is covered without touching any consumer. */
export function appCapabilities(granted: Iterable<PermissionKey>): Record<AppId, AppCapability> {
  const set = granted instanceof Set ? granted : new Set(granted);
  const out = {} as Record<AppId, AppCapability>;
  for (const app of APP_MANIFEST) out[app.id as AppId] = appCapability(set, app.id);
  return out;
}

// ── policy decisions (the check services run) ────────────────────────────────
export type PolicyDenyReason =
  | "unknown_app" // not in APP_MANIFEST (fail closed)
  | "app_disabled" // level none — the app is off for this role
  | "read_only" // holds 閲覧 but the action needs 編集
  | "missing_permission"; // the extra fine-grained key is absent

/** What an action demands: an app + the level it needs, optionally AND a fine-grained key. */
export interface PolicyRequirement {
  app: string;
  level: AppAccessLevel;
  /** Extra 詳細 key that must ALSO be held (e.g. chat:moderate for 他人の投稿削除). */
  permission?: PermissionKey;
}

export interface PolicyDecision {
  allowed: boolean;
  /** Every key the requirement resolves to — services batch exactly these into /authz/check. */
  requiredKeys: PermissionKey[];
  /** Subset of requiredKeys the subject does NOT hold (empty when allowed). */
  missing: PermissionKey[];
  reason?: PolicyDenyReason;
  /** The subject's current level on the app (for the 403 message / UI copy). */
  level: AppAccessLevel;
}

/** Every key `req` resolves to — the exact check list an enforcement point should verify. */
export function requiredKeysFor(req: PolicyRequirement): PermissionKey[] {
  const keys = keysForAppLevel(req.app, req.level);
  if (req.permission && !keys.includes(req.permission)) keys.push(req.permission);
  return keys;
}

/**
 * Decide one action against a granted key set. Default deny; the reason distinguishes
 * 無効 (app off) from 閲覧のみ (read-only) so callers can say WHY — the difference between
 * "このアプリは使えません" and "閲覧のみの権限です" in a 403 or a disabled-button tooltip.
 */
export function decide(granted: Iterable<PermissionKey>, req: PolicyRequirement): PolicyDecision {
  const set = granted instanceof Set ? granted : new Set(granted);
  const level = appAccessLevelOf(set, req.app);
  const requiredKeys = requiredKeysFor(req);
  const missing = requiredKeys.filter((k) => !set.has(k));

  if (!getApp(req.app)) {
    return { allowed: false, requiredKeys, missing, reason: "unknown_app", level };
  }
  // The LEVEL gate owns the graded keys, and the extra key is checked separately. Keeping
  // them apart matters: `appAccessLevelOf` treats a lone `:edit` as 編集 (defensive, for a
  // legacy row), so a naive "any required key missing ⇒ deny" would reject such a role for a
  // 閲覧 request even though its level clearly satisfies it.
  if (!levelAtLeast(level, req.level)) {
    return {
      allowed: false,
      requiredKeys,
      missing,
      reason: level === AppAccessLevel.None ? "app_disabled" : "read_only",
      level,
    };
  }
  if (req.permission !== undefined && !set.has(req.permission)) {
    return { allowed: false, requiredKeys, missing: [req.permission], reason: "missing_permission", level };
  }
  return { allowed: true, requiredKeys, missing: [], level };
}

/** Human-readable deny copy (403 body / disabled-control tooltip). */
export function denyMessage(decision: PolicyDecision, appLabel?: string): string {
  const name = appLabel ?? "このアプリ";
  switch (decision.reason) {
    case "app_disabled":
      return `${name}を使う権限がありません（無効）。`;
    case "read_only":
      return `${name}は閲覧のみの権限です。編集するには編集権限が必要です。`;
    case "missing_permission":
      return `権限が足りません: ${decision.missing.join(", ")}`;
    case "unknown_app":
      return "未登録のアプリです。";
    default:
      return "許可されています。";
  }
}

// ── catalog partition: per-app 詳細 keys vs 「その他」 ────────────────────────────
const CATALOG_BY_KEY = new Map<string, PermissionCatalogEntry>(PERMISSION_CATALOG.map((e) => [e.key, e]));

function entriesOf(keys: readonly PermissionKey[]): PermissionCatalogEntry[] {
  return keys.map((k) => CATALOG_BY_KEY.get(k)).filter((e): e is PermissionCatalogEntry => e !== undefined);
}

/** Catalog entry for a key (undefined when not in the frozen catalog). */
export function catalogEntry(key: string): PermissionCatalogEntry | undefined {
  return CATALOG_BY_KEY.get(key);
}

/** The graded per-app keys (domain "app") — rendered as the 3 段階 selector, never as
 *  individual checkboxes. */
export function appAccessCatalogKeys(): PermissionKey[] {
  return PERMISSION_CATALOG.filter((e) => e.domain === "app").map((e) => e.key);
}

/** The fine-grained keys one app owns — the content of its 詳細設定 dialog. */
export function appDetailPermissions(appId: string): PermissionCatalogEntry[] {
  return entriesOf(getApp(appId)?.detailPermissions ?? []);
}

/** Every key claimed by SOME app's 詳細設定 (union over APP_MANIFEST). */
export function claimedDetailKeys(): PermissionKey[] {
  return [...new Set(APP_MANIFEST.flatMap((a) => a.detailPermissions as readonly PermissionKey[]))];
}

/**
 * Catalog keys ロール管理 never shows (neither in an app's 詳細 dialog nor in その他). The
 * catalog itself is a frozen wire contract, so a key that stopped being a meaningful toggle
 * is retired from the UI here instead of being deleted:
 *   - notif:inbox:self / notif:prefs:self — every 通知 user needs them; they ride the 通知
 *     app's 3 段階 (APP_MANIFEST `permissions`, bundled on save), so a separate toggle could
 *     only produce the broken "通知 is on but the inbox 403s" state.
 *   - notif:send — gates nothing (POST /notify is INTERNAL in the notification policy table).
 *   - members:roster_* / members:mail_* — 運営メンバーの 詳細設定で範囲の選択肢として出す (MembersScope)。
 *     個別のトグルにすると「閲覧は無いのに編集はある」状態を作れてしまう。
 * Each entry needs a reason; the partition test treats this as the 4th bucket.
 */
export const HIDDEN_PERMISSION_KEYS: readonly PermissionKey[] = [
  "notif:inbox:self",
  "notif:prefs:self",
  "notif:send",
  ...Object.values(MEMBERS_SCOPE_KEYS).flatMap((k) => [k.roster, k.mail]),
];

/**
 * 「その他」: catalog keys that belong to NO app — org-wide capabilities (インフラ/デプロイ,
 * 監査ログ, GitHub 連携, Webhook). Computed as the complement, so a catalog key
 * added later automatically shows up here instead of disappearing from ロール管理.
 */
export function otherPermissions(): PermissionCatalogEntry[] {
  const claimed = new Set<string>([...claimedDetailKeys(), ...appAccessCatalogKeys(), ...HIDDEN_PERMISSION_KEYS]);
  return PERMISSION_CATALOG.filter((e) => !claimed.has(e.key));
}

/** 「その他」 grouped by catalog domain, first-seen order (the UI renders one block each). */
export function otherPermissionGroups(): { domain: string; entries: PermissionCatalogEntry[] }[] {
  const order: string[] = [];
  const byDomain = new Map<string, PermissionCatalogEntry[]>();
  for (const e of otherPermissions()) {
    let bucket = byDomain.get(e.domain);
    if (!bucket) {
      bucket = [];
      byDomain.set(e.domain, bucket);
      order.push(e.domain);
    }
    bucket.push(e);
  }
  return order.map((domain) => ({ domain, entries: byDomain.get(domain)! }));
}

// ── rows for the ロール管理 一覧表 ─────────────────────────────────────────────────
/** One row of the app table: the app, its level for the edited role, and its 詳細 scope. */
export interface AppPolicyRow {
  app: AppManifestEntry;
  id: string;
  label: string;
  level: AppAccessLevel;
  /** Number of fine-grained keys the role holds / how many the app offers (詳細 badge). */
  detail: { granted: number; total: number };
  /** Launcher tile is open to every authenticated user (無効 to restrict it). */
  openToAll: boolean;
}

/** Table rows for the whole manifest, in launcher order — the 一覧画面's data source. */
export function appPolicyRows(granted: readonly PermissionKey[]): AppPolicyRow[] {
  const set = new Set(granted);
  return APP_MANIFEST.map((app) => {
    const detailKeys = app.detailPermissions as readonly PermissionKey[];
    return {
      app,
      id: app.id,
      label: app.label,
      level: appAccessLevelOf(set, app.id),
      detail: { granted: detailKeys.filter((k) => set.has(k)).length, total: detailKeys.length },
      // `as const` narrows each entry to its own literal shape, so the optional field is
      // absent from the union members that don't declare it — read it through the interface.
      openToAll: (app as AppManifestEntry).openToAllAuthenticated === true,
    };
  });
}

/** Header summary for the table ("12 / 13 有効"). */
export function appPolicySummary(granted: readonly PermissionKey[]): { enabled: number; total: number } {
  const rows = appPolicyRows(granted);
  return { enabled: rows.filter((r) => r.level !== AppAccessLevel.None).length, total: rows.length };
}
