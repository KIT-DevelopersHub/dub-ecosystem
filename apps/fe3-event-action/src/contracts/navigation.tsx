// Navigation contract shim. FE2 owns the TanStack Router instance; FE3 only needs
// "navigate" + "read the current route params/search". This abstracts that so FE3
// pages never import a concrete router, and tests can inject fixed params. On
// integration, back these with FE2's router (useNavigate/useParams/useSearch).
import * as React from "react";

export interface NavigationApi {
  navigate: (to: string) => void;
  params: Record<string, string>;
  search: string; // raw query string, e.g. "phase=open&archived=1"
  setSearch: (query: string) => void;
}

const NavContext = React.createContext<NavigationApi | null>(null);

export function NavigationProvider({
  value,
  children,
}: {
  value: NavigationApi;
  children: React.ReactNode;
}) {
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNavigation(): NavigationApi {
  const ctx = React.useContext(NavContext);
  if (!ctx) {
    // Fail-soft no-op so isolated component renders don't throw.
    return { navigate: () => {}, params: {}, search: "", setSearch: () => {} };
  }
  return ctx;
}

export function useNavigate(): (to: string) => void {
  return useNavigation().navigate;
}

export function useRouteParams(): Record<string, string> {
  return useNavigation().params;
}
