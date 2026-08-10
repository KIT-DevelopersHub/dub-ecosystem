// AppShellLayout (design 2-2). Composes @dub/ui AppShell/Sidebar/PageHeader and wires
// nav aggregation, auth-driven user menu, badge injection, headerWidget slots and
// the routed content. FE2 does composition & wiring only — the visuals are FE1's.
import type { ComponentType, ReactNode } from "react";
import { AppShell, Sidebar, PageHeader, Button, IconButton, Icon } from "@dub/ui";
import type { SidebarItem } from "@dub/ui";
import type { NavEntry } from "../modules/types.tsx";
import { useUiStore } from "../store/uiStore.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";

export interface AppShellLayoutProps {
  navEntries: NavEntry[];
  headerWidgets?: ComponentType[];
  onNavigate?: (path: string) => void;
  onLogout?: () => void;
  title?: string;
  children: ReactNode; // routed <Outlet/>
}

// NavEntry[] -> @dub/ui SidebarItem[]: id keyed by path, badgeSource() hook injected
// as badgeCount (FE5 useUnreadCount / FE6 useChatUnreadTotal), sorted by order.
function toSidebarItems(navEntries: NavEntry[]): SidebarItem[] {
  return [...navEntries]
    .sort((a, b) => a.order - b.order)
    .map((entry) => {
      const badge = entry.badgeSource?.();
      const item: SidebarItem = {
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
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const auth = useAuth();

  // @dub/ui Sidebar is router-free; renderLink lets FE2 intercept navigation so the
  // host router (not a full page load) handles it. FE1 renders the <a href> node.
  const renderLink = onNavigate
    ? (item: SidebarItem, node: ReactNode): ReactNode => (
        <span
          data-testid={`fe2-nav-${item.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(item.href ?? item.id);
          }}
        >
          {node}
        </span>
      )
    : undefined;

  const displayName = auth.status === "authenticated" ? auth.me.user.displayName : "";
  const initial = displayName.trim().charAt(0).toUpperCase() || "U";

  const sidebar = (
    <>
      <div className="fe2-brand">
        <span className="fe2-brand-mark" aria-hidden="true">
          D
        </span>
        {sidebarOpen ? (
          <span className="fe2-brand-text">
            <span className="fe2-brand-title">DevHub</span>
            <span className="fe2-brand-sub">管理コンソール</span>
          </span>
        ) : null}
      </div>
      <Sidebar
        items={toSidebarItems(navEntries)}
        collapsed={!sidebarOpen}
        testId="fe2-shell-sidebar"
        {...(renderLink ? { renderLink } : {})}
      />
    </>
  );

  const header = (
    <PageHeader
      testId="fe2-shell-header"
      title={title}
      actions={
        <>
          <IconButton
            testId="fe2-sidebar-toggle"
            name="menu"
            variant="ghost"
            aria-label="サイドバーを開閉"
            onClick={toggleSidebar}
          />
          {headerWidgets.map((Widget, i) => (
            <Widget key={i} />
          ))}
          {auth.status === "authenticated" ? (
            <span className="fe2-header-user" data-testid="fe2-shell-user">
              <span className="fe2-avatar" aria-hidden="true">
                {initial}
              </span>
              {displayName}
            </span>
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

  return (
    <AppShell sidebar={sidebar} header={header} testId="fe2-shell">
      {children}
    </AppShell>
  );
}
