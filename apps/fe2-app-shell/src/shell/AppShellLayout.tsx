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
import { isAppPublished, isPrivilegedViewer, UNPUBLISHED_TILE_REASON } from "../lib/releaseGate.ts";

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

// Header brand label: the signed-in user's email once /me resolves, else the
// fallback brand (shown while loading or unauthenticated — never a blank title).
function headerLabel(auth: ReturnType<typeof useAuth>, fallback: string): string {
  if (auth.status === "authenticated" && auth.me.user.email) return truncateEmail(auth.me.user.email);
  return fallback;
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
// injected as badgeCount (FE5 useUnreadCount / FE6 useChatUnreadTotal), sorted by
// order. Member release-gating (社長決定 2026-08-14, see lib/releaseGate): every tile
// is ALWAYS rendered (消さない — apps are never removed from the launcher, per
// [[dub-never-hide-or-reduce-apps]]); an app the current viewer may not open yet is
// greyed-out + disabled instead. Admins/maintainers (isPrivilegedViewer) bypass the
// gate and see every app active for testing/development; a general member sees only
// member-published apps active (メールのみ as of 2026-08-14) and the rest greyed with
// a "準備中" tooltip. Route guards (router.tsx) enforce the same on direct navigation.
function toLauncherItems(navEntries: NavEntry[], can: Can): AppLauncherItem[] {
  const privileged = isPrivilegedViewer(can);
  return [...navEntries]
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
      // Greyed for a general member when the owning app is not member-published.
      if (!privileged && !isAppPublished(entry.appId)) {
        item.disabled = true;
        item.disabledReason = UNPUBLISHED_TILE_REASON;
      }
      return item;
    });
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

  const header = (
    <PageHeader
      testId="fe2-shell-header"
      title={headerLabel(auth, title)}
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
