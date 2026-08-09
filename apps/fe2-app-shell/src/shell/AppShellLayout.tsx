// AppShellLayout (design 2-2). Composes FE1 AppShell/Sidebar/PageHeader and wires
// nav aggregation, auth-driven user menu, badge injection, headerWidget slots and
// the routed content. FE2 does composition & wiring only — the visuals are FE1's.
import type { ReactNode } from "react";
import { AppShell, Sidebar, PageHeader, Button } from "../stubs/dub-ui.tsx";
import { Icon } from "../stubs/icons.tsx";
import type { NavEntry } from "../modules/types.tsx";
import type { ComponentType } from "react";
import { useUiStore } from "../store/uiStore.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";

export interface AppShellLayoutProps {
  navEntries: NavEntry[];
  headerWidgets?: ComponentType[];
  onNavigate?: (path: string) => void;
  onLogout?: () => void;
  title?: ReactNode;
  children: ReactNode; // routed <Outlet/>
}

function NavItem({ entry, onNavigate }: { entry: NavEntry; onNavigate?: (p: string) => void }): JSX.Element {
  const badge = entry.badgeSource?.();
  return (
    <a
      href={entry.path}
      data-testid={`fe2-nav-${entry.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`}
      onClick={(e) => {
        if (onNavigate) {
          e.preventDefault();
          onNavigate(entry.path);
        }
      }}
    >
      <Icon name={entry.icon} />
      <span>{entry.label}</span>
      {typeof badge === "number" && badge > 0 ? (
        <span data-slot="badge" aria-label={`${badge} 件の未読`}>
          {badge}
        </span>
      ) : null}
    </a>
  );
}

export function AppShellLayout({
  navEntries,
  headerWidgets = [],
  onNavigate,
  onLogout,
  title,
  children,
}: AppShellLayoutProps): JSX.Element {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const auth = useAuth();

  const sidebar = (
    <Sidebar open={sidebarOpen} testId="fe2-shell-sidebar">
      {[...navEntries]
        .sort((a, b) => a.order - b.order)
        .map((entry) => (
          <NavItem key={entry.path} entry={entry} onNavigate={onNavigate} />
        ))}
    </Sidebar>
  );

  const header = (
    <PageHeader
      testId="fe2-shell-header"
      title={
        <>
          <Button testId="fe2-sidebar-toggle" variant="secondary" onClick={toggleSidebar}>
            <Icon name="settings" />
          </Button>
          {title ?? "DevHub"}
        </>
      }
      actions={
        <>
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

  return (
    <AppShell sidebar={sidebar} header={header} testId="fe2-shell">
      {children}
    </AppShell>
  );
}
