// App-access catalog: the launcher tiles (apps/features) a role can turn on/off.
//
// Each app is gated by the permission(s) the shell requires to open its launcher
// tile (apps/fe2-app-shell nav requiredPermissions). Turning an app ON for a role
// grants ALL of its `requiredPermissions`; turning it OFF removes them. So "app
// access" is a coarse, human-readable view over the same role permission bundle the
// PermissionMatrix edits in detail — no separate storage, no migration.
//
// LIMITATION (Option A): only apps that HAVE a gating permission can actually be
// toggled. Apps with `requiredPermissions: []` are visible to any signed-in user and
// show here as 常時利用可（権限制御なし） — they cannot be turned off per-role without a
// dedicated per-role app-enablement flag (Option B: migration + MeResponse contract).
//
// This list mirrors the shell's launcher nav; keep it in sync when apps are added.
import type { identity } from "@dub/types";

export interface AppCatalogEntry {
  /** Stable app id (for testids / keys). */
  id: string;
  /** Launcher tile label (matches the shell nav). */
  label: string;
  /** Permissions the role must hold for the app's tile to be active. Empty = 常時利用可. */
  requiredPermissions: identity.PermissionKey[];
  /** One-line plain-Japanese purpose, shown under the toggle. */
  description: string;
}

export const APP_CATALOG: readonly AppCatalogEntry[] = [
  { id: "events", label: "イベント", requiredPermissions: [], description: "カンファレンス/ハッカソン等のイベント運営。" },
  { id: "tasks", label: "マイタスク", requiredPermissions: [], description: "自分に割り当てられたタスク一覧。" },
  { id: "gantt", label: "ガントチャート", requiredPermissions: ["task:read"], description: "イベントのタスクをガントで俯瞰。" },
  { id: "notifications", label: "通知", requiredPermissions: [], description: "自分宛ての通知インボックス。" },
  { id: "chat", label: "チャット", requiredPermissions: [], description: "運営チャット。" },
  { id: "mail", label: "メール", requiredPermissions: [], description: "@developershub.jp のメール。" },
  { id: "usage", label: "利用状況", requiredPermissions: [], description: "無料枠の利用状況ダッシュボード。" },
  { id: "members", label: "運営メンバー", requiredPermissions: [], description: "運営メンバー/招待状況の管理。" },
  { id: "driveshare", label: "ドライブ共有", requiredPermissions: [], description: "Hackit Drive の共有管理。" },
  { id: "admin-users", label: "ユーザー名簿", requiredPermissions: ["identity:read"], description: "ユーザー一覧とロール付与。" },
  { id: "admin-roles", label: "ロール管理", requiredPermissions: ["identity:read"], description: "ロールと権限・アプリアクセスの管理。" },
  { id: "admin-email", label: "メールアドレス管理", requiredPermissions: ["mail:admin"], description: "Email Routing のアドレス管理。" },
  { id: "admin-history", label: "変更履歴", requiredPermissions: ["audit:read"], description: "管理操作の監査ログ。" },
];

/** True if `key` gates at least one app in the catalog (used to detect app-driven perms). */
export function isAppGatingPermission(key: identity.PermissionKey): boolean {
  return APP_CATALOG.some((a) => a.requiredPermissions.includes(key));
}
