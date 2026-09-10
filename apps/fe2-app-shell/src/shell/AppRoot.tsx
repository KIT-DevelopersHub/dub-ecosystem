// AppRoot (design 2-2). Mounts every cross-cutting provider in one place:
// QueryClient (server state), controlled ThemeProvider bound to UiStore (FE2 is
// theme source of truth), FE1 ToastProvider, AuthProvider, and a top-level
// ErrorBoundary rendering GlobalErrorFallback.
import { Component, useEffect, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, ToastProvider } from "@dub/ui";
import type { ThemeName } from "@dub/ui";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { useUiStore } from "../store/uiStore.tsx";
import { GlobalErrorFallback } from "./GlobalErrorFallback.tsx";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // api-client owns transport retry/refresh; Query retry stays off to avoid
        // double-retrying and to let 401 -> onUnauthenticated propagate cleanly.
        retry: false,
        staleTime: 30 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[fe2] uncaught render error", error, info);
  }
  override render(): ReactNode {
    if (this.state.error) {
      return <GlobalErrorFallback error={this.state.error} onReset={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

// @dub/ui ThemeProvider is controlled and only accepts "light"|"dark"; FE2 resolves
// "system" here against the OS preference (UiStore stays the source of truth).
function ThemeBridge({ children }: { children: ReactNode }): JSX.Element {
  const theme = useUiStore((s) => s.theme);
  // When the choice is "system", the resolved light/dark tracks the OS live: without
  // this subscription, flipping the OS appearance would only take effect on reload
  // (the previous behaviour read matchMedia once). Explicit light/dark ignore the OS.
  const [systemDark, setSystemDark] = useState<boolean>(
    () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  useEffect(() => {
    const mq = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return undefined;
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    setSystemDark(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const resolved: ThemeName = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  return <ThemeProvider theme={resolved}>{children}</ThemeProvider>;
}

export function AppRoot({
  api,
  queryClient,
  onUnauthenticated,
  children,
}: {
  api: ApiClient;
  queryClient?: QueryClient;
  onUnauthenticated?: () => void;
  children: ReactNode;
}): JSX.Element {
  const client = queryClient ?? createQueryClient();
  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <ThemeBridge>
          <ToastProvider>
            <AuthProvider api={api} {...(onUnauthenticated ? { onUnauthenticated } : {})}>
              {children}
            </AuthProvider>
          </ToastProvider>
        </ThemeBridge>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
