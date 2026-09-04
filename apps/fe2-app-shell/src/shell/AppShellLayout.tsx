// AppShellLayout (design 2-2, app-launcher model 凍結案 1-4-3). Composes @dub/ui
// AppShell/PageHeader/AppLauncher and wires nav aggregation, auth-driven user menu,
// badge injection, headerWidget slots and the routed content. FE2 does composition
// & wiring only — the visuals are FE1's.
//
// The persistent left sidebar is gone: tools now live behind the header AppLauncher
// (Chrome-waffle style), so mail (Gmail 3-pane) and chat (Slack) render full-width
// with no nested/double sidebar.
import { useState, type ComponentType, type ReactNode } from "react";
import { AppShell, PageHeader, AppLauncher, Menu } from "@dub/ui";
import type { AppLauncherItem, MenuItem } from "@dub/ui";
import type { identity } from "@dub/types";
import type { NavEntry } from "../modules/types.tsx";
import type { ApiClient } from "../lib/api-client.tsx";
import { useAuth, usePermissions } from "../auth/AuthProvider.tsx";
import { FeedbackWidget } from "./feedback/FeedbackWidget.tsx";
import { AccountSettingsDialog } from "./AccountSettingsDialog.tsx";
import { ColorSettingsDialog } from "./ColorSettingsDialog.tsx";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.tsx";
import { ShortcutsDialog } from "./ShortcutsDialog.tsx";
import {
  isReleaseGatedFor,
  UNPUBLISHED_TILE_REASON,
  UNAUTHORIZED_TILE_REASON,
} from "../lib/releaseGate.ts";

type Can = (permission: identity.PermissionKey) => boolean;

// Shorten a long email so the shell title never overflows the header, keeping the
// domain (the part users scan for) and eliding the local part: `abcdef…@dub.jp`.
// A pure string transform — the header stays composition-only (visuals are FE1's).
export function truncateEmail(email: string, maxLen = 30): string {
  if (email.length <= maxLen) return email;
  const at = email.lastIndexOf("@");
  if (at <= 0) return `${email.slice(0, Math.max(1, maxLen - 1))}…`;
  const domain = email.slice(at); // includes "@"
  const keep = maxLen - domain.length - 1; // room for the ellipsis
  if (keep >= 1) return `${email.slice(0, keep)}…${domain}`;
  return `${email.slice(0, Math.max(1, maxLen - 1))}…`;
}

// The signed-in account's email once /me resolves, else null. Shown small & muted
// beside the DevHub brand — enough to confirm which account is active without
// dominating the header (the brand, not the address, is the primary label now).
function accountEmail(auth: ReturnType<typeof useAuth>): string | null {
  if (auth.status === "authenticated" && auth.me.user.email) return truncateEmail(auth.me.user.email);
  return null;
}

export interface AppShellLayoutProps {
  navEntries: NavEntry[];
  headerWidgets?: ComponentType[];
  // Widgets rendered BEFORE the 9-dot AppLauncher (e.g. the gantt event switcher),
  // so a context selector sits left of the app/utility icon cluster.
  leadingHeaderWidgets?: ComponentType[];
  onNavigate?: (path: string) => void;
  onLogout?: () => void;
  title?: string;
  // Shared api-client — when provided, the floating feedback widget is mounted for
  // authenticated users. Optional so unit tests can render the shell without it.
  api?: ApiClient;
  children: ReactNode; // routed <Outlet/>
}

// NavEntry[] -> @dub/ui AppLauncherItem[]: id keyed by path, badgeSource() hook
// injected as badgeCount (FE5 useUnreadCount / FE6 useChatUnreadTotal). Every tile is
// ALWAYS rendered (消さない — apps are never removed from the launcher, per
// [[dub-never-hide-or-reduce-apps]]); an app the current viewer cannot open is
// greyed-out + disabled + tooltip instead, and greyed apps are SORTED to the bottom.
//
// "Cannot open" mirrors the route access gate (router.tsx) so the launcher and a
// deep-link stay consistent — an app greyed here 403s on direct navigation, and vice
// versa. Two gates decide it:
//   1. Member release gate (社長決定 2026-08-14, see lib/releaseGate / RequirePublished):
//      an app not member-published is greyed for general members; only full admins
//      (isPrivilegedViewer = identity:admin) bypass it — non-admin operator roles
//      (maintainer/organizer) are gated too (#255). メールのみ published as of 2026-08-14.
//   2. Permission gate (RequirePermission): an app whose requiredPermissions the viewer
//      does not hold is greyed for EVERYONE — admins included — exactly matching the
//      route's own requiredPermissions guard (e.g. a maintainer without identity:admin
//      can't open a role-admin tool, so its tile greys). No privileged bypass here, so
//      the launcher never shows an app that would 403.
// Sort order: usable apps first, greyed apps last; the existing order-based sequence is
// preserved within each group (a stable partition), and nothing is removed.
// The access gate for a nav entry, shared by the launcher and the command palette so
// a greyed app looks/behaves identically in both surfaces (and matches router.tsx).
function navGate(entry: NavEntry, can: Can): { disabled: boolean; reason?: string } {
  const releaseGated = isReleaseGatedFor(entry.appId, can);
  const lacksPermission =
    entry.requiredPermissions !== undefined &&
    entry.requiredPermissions.length > 0 &&
    !entry.requiredPermissions.every((p) => can(p));
  if (releaseGated || lacksPermission) {
    // Release gate wins the reason, matching router.tsx where RequirePublished wraps
    // the permission gate (an unpublished app denies first, regardless of perms).
    return { disabled: true, reason: releaseGated ? UNPUBLISHED_TILE_REASON : UNAUTHORIZED_TILE_REASON };
  }
  return { disabled: false };
}

function toLauncherItems(navEntries: NavEntry[], can: Can): AppLauncherItem[] {
  const items = [...navEntries]
    .sort((a, b) => a.order - b.order)
    .map((entry) => {
      const badge = entry.badgeSource?.();
      const item: AppLauncherItem = {
        id: entry.path,
        label: entry.label,
        icon: entry.icon,
        href: entry.path,
      };
      if (typeof badge === "number" && badge > 0) item.badgeCount = badge;
      const gate = navGate(entry, can);
      if (gate.disabled) {
        item.disabled = true;
        item.disabledReason = gate.reason;
      }
      return item;
    });
  // Usable first, greyed last. filter() is a stable partition, so each group keeps its
  // order-sorted sequence; no tile is dropped (消さない — greyed apps only move down).
  return [...items.filter((i) => !i.disabled), ...items.filter((i) => i.disabled)];
}

// Derive extra ASCII search terms from an entry so a Japanese label ("メール") is still
// found by typing its route/app id ("mail"). The palette matches label + these.
function navKeywords(entry: NavEntry): string[] {
  const fromPath = entry.path.split("/").filter(Boolean);
  return entry.appId ? [entry.appId, ...fromPath] : fromPath;
}

// Build the palette command list: every app (gated identically to the launcher, greyed
// apps kept — 消さない) plus the global self-service actions. Apps sort usable-first to
// match the launcher; actions follow in their own section.
export function buildPaletteCommands(
  navEntries: NavEntry[],
  can: Can,
  actions: {
    onNavigate?: (path: string) => void;
    onOpenAccount?: () => void;
    onLogout?: () => void;
  },
): PaletteCommand[] {
  const apps = [...navEntries]
    .sort((a, b) => a.order - b.order)
    .map((entry): PaletteCommand => {
      const gate = navGate(entry, can);
      const cmd: PaletteCommand = {
        id: `app:${entry.path}`,
        label: entry.label,
        group: "アプリ",
        icon: entry.icon,
        keywords: navKeywords(entry),
        run: () => actions.onNavigate?.(entry.path),
      };
      if (gate.disabled) {
        cmd.disabled = true;
        cmd.disabledReason = gate.reason;
      }
      return cmd;
    });
  const usable = apps.filter((c) => !c.disabled);
  const greyed = apps.filter((c) => c.disabled);

  const actionCmds: PaletteCommand[] = [];
  if (actions.onNavigate) {
    actionCmds.push({
      id: "action:home",
      label: "ホームへ移動",
      group: "アクション",
      icon: "home",
      keywords: ["home", "dashboard", "ホーム", "ダッシュボード"],
      run: () => actions.onNavigate?.("/"),
    });
  }
  if (actions.onOpenAccount) {
    actionCmds.push({
      id: "action:account",
      label: "アカウント設定",
      group: "アクション",
      icon: "user",
      keywords: ["account", "settings", "profile", "password", "設定", "プロフィール", "パスワード"],
      run: () => actions.onOpenAccount?.(),
    });
  }
  if (actions.onLogout) {
    actionCmds.push({
      id: "action:logout",
      label: "ログアウト",
      group: "アクション",
      icon: "log-out",
      keywords: ["logout", "signout", "ログアウト"],
      run: () => actions.onLogout?.(),
    });
  }

  return [...usable, ...greyed, ...actionCmds];
}

export function AppShellLayout({
  navEntries,
  headerWidgets = [],
  leadingHeaderWidgets = [],
  onNavigate,
  onLogout,
  title = "DevHub",
  api,
  children,
}: AppShellLayoutProps): JSX.Element {
  const auth = useAuth();
  const { can } = usePermissions();
  const [acctOpen, setAcctOpen] = useState(false);
  // カラー設定 (表示設定) dialog — theme lives inside it, not directly in the ⚙ menu.
  const [colorOpen, setColorOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Self settings导线: offered only when a shared api-client is wired and the viewer is
  // signed in (mirrors the FeedbackWidget gate). Separate from FE7's admin roster.
  const showAccount = Boolean(api) && auth.status === "authenticated";
  const authed = auth.status === "authenticated";

  // The ⚙ menu's contents — a short list of self-service行き先, each a single row that
  // either opens a dialog or fires an action:
  //   • アカウント設定 (needs the api-client) — display name / avatar / password / 参加情報.
  //   • カラー設定 (表示設定) — always available; opens the ColorSettingsDialog where テーマ
  //     (system/light/dark) is chosen. The three theme rows used to sit directly in this
  //     menu, which read oddly; folding them behind one カラー設定 row keeps the menu a tidy
  //     list of destinations and leaves room to grow (density/accent) inside the dialog.
  //     setTheme/localStorage永続/全アプリ波及/system時OS追従 are all unchanged.
  //   • ログアウト — needs only onLogout, so it stays for any signed-in viewer even with no
  //     api wired. Last, under a divider, danger-toned — a 離脱/destructive action set apart.
  const settingsItems: MenuItem[] = [];
  if (showAccount) {
    settingsItems.push({
      id: "account-settings",
      label: "アカウント設定",
      icon: "user",
      onSelect: () => setAcctOpen(true),
      testId: "fe2-account-settings-open",
    });
  }
  settingsItems.push({
    id: "color-settings",
    label: "カラー設定",
    icon: "palette",
    onSelect: () => setColorOpen(true),
    testId: "fe2-color-settings-open",
  });
  // キーボードショートカット一覧 — available to any signed-in viewer (shortcuts are global
  // and need no api). Opens the ShortcutsDialog, which also lists itself via the "?" hotkey.
  if (authed) {
    settingsItems.push({
      id: "keyboard-shortcuts",
      label: "キーボードショートカット",
      icon: "keyboard",
      onSelect: () => setShortcutsOpen(true),
      testId: "fe2-shortcuts-open",
    });
  }
  if (authed && onLogout) {
    settingsItems.push({
      id: "logout",
      label: "ログアウト",
      icon: "log-out",
      tone: "danger",
      dividerBefore: settingsItems.length > 0,
      onSelect: onLogout,
      testId: "fe2-logout",
    });
  }

  const email = accountEmail(auth);
  // Brand-first header: "DevHub" (bold, primary) is the app label AND the home导线
  // — clicking it navigates back to "/" (the ubiquitous logo=home pattern). The
  // account email rides alongside, small & muted, so it never overshadows the brand.
  const brand = (
    <span className="fe2-brandline">
      <a
        href="/"
        className="fe2-brandline-home"
        data-testid="fe2-brand-home"
        onClick={(e) => {
          if (onNavigate) {
            e.preventDefault();
            onNavigate("/");
          }
        }}
      >
        {title}
      </a>
      {email ? (
        <span className="fe2-brandline-account" data-testid="fe2-header-account" title={email}>
          {email}
        </span>
      ) : null}
    </span>
  );

  const header = (
    <PageHeader
      testId="fe2-shell-header"
      title={brand}
      actions={
        <>
          {/* Leading widgets (e.g. the gantt event switcher) sit LEFT of the 9-dot. */}
          {leadingHeaderWidgets.map((Widget, i) => (
            <Widget key={`lead-${i}`} />
          ))}
          <AppLauncher
            testId="fe2-app-launcher"
            title="アプリ"
            label="アプリ一覧"
            items={toLauncherItems(navEntries, can)}
            {...(onNavigate ? { onSelect: (item: AppLauncherItem) => onNavigate(item.href ?? item.id) } : {})}
          />
          {headerWidgets.map((Widget, i) => (
            <Widget key={i} />
          ))}
          {settingsItems.length > 0 ? (
            // Settings (⚙) dropdown — the self-service container. アカウント設定 (display
            // name / avatar / password change), テーマ切替 (system/light/dark) and ログアウト
            // all live INSIDE it, so the header is just 9-dot / bell / ⚙ (uniform icon
            // row, no bare buttons). パスワード変更 is nested within アカウント設定 (unified),
            // and the logout flow's behaviour/API/authz are unchanged.
            <Menu
              testId="fe2-settings-menu"
              label="設定"
              menuLabel="設定"
              icon="settings"
              align="end"
              iconOnly
              items={settingsItems}
            />
          ) : null}
        </>
      }
    />
  );

  // Cmd/Ctrl+K palette: apps mirror the launcher (same gating), actions mirror the ⚙
  // menu. Mounted only for authenticated viewers so the hotkey/commands match what a
  // signed-in user can actually do; the palette itself owns the open/close + shortcut.
  const paletteCommands = buildPaletteCommands(navEntries, can, {
    ...(onNavigate ? { onNavigate } : {}),
    ...(showAccount ? { onOpenAccount: () => setAcctOpen(true) } : {}),
    ...(authed && onLogout ? { onLogout } : {}),
  });

  // No `sidebar` prop -> @dub/ui AppShell renders no left rail; main spans full width.
  return (
    <AppShell header={header} testId="fe2-shell">
      {children}
      {authed ? <CommandPalette commands={paletteCommands} /> : null}
      {authed ? <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} /> : null}
      {api && auth.status === "authenticated" ? <FeedbackWidget api={api} /> : null}
      {showAccount && api ? <AccountSettingsDialog api={api} open={acctOpen} onClose={() => setAcctOpen(false)} /> : null}
      <ColorSettingsDialog open={colorOpen} onClose={() => setColorOpen(false)} />
    </AppShell>
  );
}
