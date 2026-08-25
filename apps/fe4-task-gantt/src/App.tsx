import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { identity } from "@dub/types";
import { ToastProvider } from "@dub/ui";
import type { ApiClient } from "./contracts/spa-shell";
import { ApiClientProvider } from "./api/client-context";
import { TaskWorkspacePage } from "./components/TaskWorkspacePage";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

export interface AppProps {
  client: ApiClient;
  eventId: string;
  permissions: readonly identity.PermissionKey[] | null;
}

export function App({ client, eventId, permissions }: AppProps) {
  return (
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        {/* The workspace shows success toasts (create) — provide the host context.
            Production mounts it under routes.tsx / DemoApp's ToastProvider too. */}
        <ToastProvider>
          <TaskWorkspacePage eventId={eventId} permissions={permissions} />
        </ToastProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
