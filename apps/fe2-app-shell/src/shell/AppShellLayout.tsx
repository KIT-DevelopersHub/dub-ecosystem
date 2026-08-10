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
import type { NavEntry } from "../modules/types.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";

export interface AppShellLayoutProps {
  navEntries: NavEntry[];
  headerWidgets?: ComponentType[];
  onNavigate?: (path: string) => void;
  onLogout?: () => void;
  title?: string;
  children: ReactNode; // routed <Outlet/>
}

// NavEntry[] -> @dub/ui AppLauncherItem[]: id keyed by path, badgeSource() hook
// injected as badgeCount (FE5 useUnreadCount / FE6 useChatUnreadTotal), sorted by
// order. Role/permission filtering already happened upstream in the registry, so
// whatever nav the shell hands us is exactly what this role may see.
function toLauncherItems(navEntries: NavEntry[]): AppLauncherItem[] {
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
      return item;
    });
}

export function AppShellLayout({
  navEntries,
  headerWidgets = [],
  onNavigate,
  onLogout,
  title = "DevHub",
  children,
}: AppShellLayoutProps): JSX.Element {
  const auth = useAuth();

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
            items={toLauncherItems(navEntries)}
            {...(onNavigate ? { onSelect: (item: AppLauncherItem) => onNavigate(item.href ?? item.id) } : {})}
          />
          {headerWidgets.map((Widget, i) => (
            <Widget key={i} />
          ))}
          {auth.status === "authenticated" ? (
            <span data-testid="fe2-shell-user">{auth.me.user.displayName}</span>
          ) : null}
          <Button testId="fe2-logout" variant="secondary" onClick={onLogout}>
            <Icon name="log-out" />
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
    </AppShell>
  );
}
