// AppShellLayout (design 2-2, app-launcher model 凍結案 1-4-3). Composes @dub/ui
// AppShell/PageHeader/AppLauncher and wires nav aggregation, auth-driven user menu,
// badge injection, headerWidget slots and the routed content. FE2 does composition
// & wiring only — the visuals are FE1's.
//
// The persistent left sidebar is gone: tools now live behind the header AppLauncher
// (Chrome-waffle style), so mail (Gmail 3-pane) and chat (Slack) render full-width
// with no nested/double sidebar.
import { useState, type ComponentType, type ReactNode } from "react";
import { AppShell, PageHeader, AppLauncher, Button, Icon } from "@dub/ui";
import type { AppLauncherItem } from "@dub/ui";
import type { identity } from "@dub/types";
import type { NavEntry } from "../modules/types.tsx";
import type { ApiClient } from "../lib/api-client.tsx";
import { useAuth, usePermissions } from "../auth/AuthProvider.tsx";
import { FeedbackWidget } from "./feedback/FeedbackWidget.tsx";
import { ChangePasswordDialog } from "./ChangePasswordDialog.tsx";
import {
  isAppPublished,
  isPrivilegedViewer,
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
//      an app not member-published is greyed for general members; only admins
//      (identity:admin, isPrivilegedViewer) bypass it — non-admin operator roles
//      (maintainer/organizer) are gated too. メールのみ published as of 2026-08-14.
//   2. Permission gate (RequirePermission): an app whose requiredPermissions the viewer
//      does not hold is greyed for EVERYONE — admins included — exactly matching the
//      route's own requiredPermissions guard (e.g. a maintainer without identity:admin
//      can't open a role-admin tool, so its tile greys). No privileged bypass here, so
//      the launcher never shows an app that would 403.
// Sort order: usable apps first, greyed apps last; the existing order-based sequence is
// preserved within each group (a stable partition), and nothing is removed.
function toLauncherItems(navEntries: NavEntry[], can: Can): AppLauncherItem[] {
  const privileged = isPrivilegedViewer(can);
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
      const releaseGated = !privileged && !isAppPublished(entry.appId);
      const lacksPermission =
        entry.requiredPermissions !== undefined &&
        entry.requiredPermissions.length > 0 &&
        !entry.requiredPermissions.every((p) => can(p));
      if (releaseGated || lacksPermission) {
        item.disabled = true;
        // Release gate wins the tooltip, matching router.tsx where RequirePublished
        // wraps the permission gate (an unpublished app denies first, regardless of perms).
        item.disabledReason = releaseGated ? UNPUBLISHED_TILE_REASON : UNAUTHORIZED_TILE_REASON;
      }
      return item;
    });
  // Usable first, greyed last. filter() is a stable partition, so each group keeps its
  // order-sorted sequence; no tile is dropped (消さない — greyed apps only move down).
  return [...items.filter((i) => !i.disabled), ...items.filter((i) => i.disabled)];
}

export function AppShellLayout({
  navEntries,
  headerWidgets = [],
  onNavigate,
  onLogout,
  title = "DevHub",
  api,
  children,
}: AppShellLayoutProps): JSX.Element {
  const auth = useAuth();
  const { can } = usePermissions();
  const [pwOpen, setPwOpen] = useState(false);
  // Self settings导线: offered only when a shared api-client is wired and the viewer is
  // signed in (mirrors the FeedbackWidget gate). Separate from FE7's admin roster.
  const showAccount = Boolean(api) && auth.status === "authenticated";

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
          {showAccount ? (
            <Button
              testId="fe2-change-password-open"
              variant="ghost"
              iconLeft={<Icon name="settings" />}
              onClick={() => setPwOpen(true)}
            >
              パスワード変更
            </Button>
          ) : null}
          <Button
            testId="fe2-logout"
            variant="secondary"
            iconLeft={<Icon name="log-out" />}
            onClick={onLogout}
          >
            ログアウト
          </Button>
        </>
      }
    />
  );

  // No `sidebar` prop -> @dub/ui AppShell renders no left rail; main spans full width.
  return (
    <AppShell header={header} testId="fe2-shell">
      {children}
      {api && auth.status === "authenticated" ? <FeedbackWidget api={api} /> : null}
      {showAccount && api ? <ChangePasswordDialog api={api} open={pwOpen} onClose={() => setPwOpen(false)} /> : null}
    </AppShell>
  );
}
