// Tiny navigation abstraction. In production FE2 mounts the FeatureRoutes into its
// TanStack Router and supplies params/navigate via router hooks; FE7 route
// components read them through this context so they stay router-agnostic and unit
// testable. The dev harness provides a minimal in-memory implementation.
import { createContext, useContext } from "react";

export interface Navigation {
  params: Record<string, string>;
  navigate: (path: string) => void;
}

const NavigationContext = createContext<Navigation>({ params: {}, navigate: () => {} });

export const NavigationProvider = NavigationContext.Provider;

export function useNavigation(): Navigation {
  return useContext(NavigationContext);
}
