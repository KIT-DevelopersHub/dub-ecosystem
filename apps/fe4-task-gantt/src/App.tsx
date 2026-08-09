import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { identity } from "@dub/types";
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
        <TaskWorkspacePage eventId={eventId} permissions={permissions} />
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
