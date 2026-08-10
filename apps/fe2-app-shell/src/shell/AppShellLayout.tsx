// AppShellLayout (design 2-2, app-launcher model 凍結案 1-4-3). Composes @dub/ui
// AppShell/PageHeader/AppLauncher and wires nav aggregation, auth-driven user menu,
// badge injection, headerWidget slots and the routed content. FE2 does composition
// & wiring only — the visuals are FE1's.
//
// The persistent left sidebar is gone: tools now live behind the header AppLauncher
// (Chrome-waffle style), so mail (Gmail 3-pane) and chat (Slack) render full-width
// with no nested/double sidebar.
import type { ComponentType, ReactNode } from "react";
import { AppShell, PageHeader, AppLauncher, Button, Icon } from "@dub/ui";
import type { AppLauncherItem } from "@dub/ui";
import type { identity } from "@dub/types";
import type { NavEntry } from "../modules/types.tsx";
import type { ApiClient } from "../lib/api-client.tsx";
import { useAuth, usePermissions } from "../auth/AuthProvider.tsx";
import { FeedbackWidget } from "./feedback/FeedbackWidget.tsx";

type Can = (permission: identity.PermissionKey) => boolean;

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
// order. Entries carrying requiredPermissions are hidden unless the viewer holds
// them all (can() is fail-closed while /me loads), so the admin (ロール管理) tools
// appear for admins only — mirroring each route's own guard (defense in depth).
function toLauncherItems(navEntries: NavEntry[], can: Can): AppLauncherItem[] {
  return [...navEntries]
    .filter((entry) => (entry.requiredPermissions ?? []).every((p) => can(p)))
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

  const header = (
    <PageHeader
      testId="fe2-shell-header"
      title={title}
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
          {auth.status === "authenticated" ? (
            <span data-testid="fe2-shell-user">{auth.me.user.displayName}</span>
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
    </AppShell>
  );
}
