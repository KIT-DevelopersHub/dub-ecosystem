// AppRoot (design 2-2). Mounts every cross-cutting provider in one place:
// QueryClient (server state), controlled ThemeProvider bound to UiStore (FE2 is
// theme source of truth), FE1 ToastProvider, AuthProvider, and a top-level
// ErrorBoundary rendering GlobalErrorFallback.
import { Component } from "react";
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
function resolveTheme(theme: "light" | "dark" | "system"): ThemeName {
  if (theme !== "system") return theme;
  const prefersDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  return prefersDark ? "dark" : "light";
}

function ThemeBridge({ children }: { children: ReactNode }): JSX.Element {
  const theme = useUiStore((s) => s.theme);
  return <ThemeProvider theme={resolveTheme(theme)}>{children}</ThemeProvider>;
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
