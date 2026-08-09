// Composition · per-module runtime Providers (W7a).
//
// Each feature exposes a DI Provider that the shell (FE2) is meant to supply.
// These wrappers build every feature's dependencies from the ONE shell
// api-client (appClients.tsx) plus the shell's own auth / toast / navigation,
// so a feature's routes render inside a fully-wired runtime context. They read
// live shell state via hooks (auth, toast, router) rather than props, so a
// single wrapper instance stays correct as the session/route changes.
import { useMemo, type ReactNode } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { gateway } from "@dub/types";
import { EventApiProvider, RegistryProvider, actionTypeRegistry } from "@dub/fe3-event-action";
import { ApiClientProvider as TaskApiClientProvider } from "@dub/fe4-task-gantt/src/api/client-context";
import { NotificationProvider, type NotificationDeps } from "@dub/fe5-notification-inbox";
import { ChatRuntimeProvider, type ChatRuntime } from "@dub/fe6-chat/src/feature";
import { WsChatClient } from "@dub/fe6-chat/src/realtime/ws-client";
import { NavigationProvider, RosterProvider } from "@dub/admin-roster";
import type { ApiClient } from "../lib/api-client.tsx";
import { useAuth, usePermissions } from "../auth/AuthProvider.tsx";
import { useToast } from "@dub/ui";
import {
  createChatApiClient,
  createEventApi,
  createGatewayResourceClient,
  createNotificationClient,
  createTaskApiClient,
} from "./appClients.tsx";

function useMe(): gateway.MeResponse | null {
  const auth = useAuth();
  return auth.status === "authenticated" ? auth.me : null;
}

/** FE3 events: EventApi injection + the app-global ActionTypeRegistry. */
export function EventProviders({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const eventApi = useMemo(() => createEventApi(api), [api]);
  return (
    <EventApiProvider api={eventApi}>
      <RegistryProvider registry={actionTypeRegistry}>{children}</RegistryProvider>
    </EventApiProvider>
  );
}

/** FE4 tasks: the request-object ApiClient FE4's hooks read via useApiClient. */
export function TaskProviders({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const client = useMemo(() => createTaskApiClient(api), [api]);
  return <TaskApiClientProvider client={client}>{children}</TaskApiClientProvider>;
}

/** FE5 notifications: api + shell navigate + shell toast (kinds line up). */
export function NotificationProviders({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const deps = useMemo<NotificationDeps>(
    () => ({
      api: createNotificationClient(api),
      navigate: (path: string) => {
        void navigate({ to: path });
      },
      toast: {
        show: (kind, message) => toast.show({ kind, title: message }),
      },
    }),
    [api, navigate, toast],
  );
  return <NotificationProvider deps={deps}>{children}</NotificationProvider>;
}

/** FE6 chat: ChatRuntime (api over the shell transport, can(), current user, DO
 *  realtime factory that re-fetches a fresh WS ticket per (re)connect). */
export function ChatProviders({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const { can } = usePermissions();
  const me = useMe();
  const runtime = useMemo<ChatRuntime>(() => {
    const chatApi = createChatApiClient(api);
    return {
      api: chatApi,
      can,
      currentUserId: me?.user.id ?? ("" as gateway.MeResponse["user"]["id"]),
      createRealtimeClient: () => new WsChatClient({ getTicket: (channelId) => chatApi.getWsTicket(channelId) }),
    };
  }, [api, can, me]);
  return <ChatRuntimeProvider value={runtime}>{children}</ChatRuntimeProvider>;
}

/** FE7 admin: FE7's RosterProvider builds its own RosterApi from a
 *  ResourceClient, so hand it the shell gateway client + the current MeResponse
 *  (null while auth loads → FE7 guards fail closed). */
export function RosterProviders({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const me = useMe();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as Record<string, string>;
  const client = useMemo(() => createGatewayResourceClient(api), [api]);
  // FE7 route components read navigation (params + navigate) via its own context;
  // feed it from the shell router so /admin/users/:userId etc. resolve.
  const navigation = useMemo(
    () => ({
      params,
      navigate: (path: string) => {
        void navigate({ to: path });
      },
    }),
    [params, navigate],
  );
  return (
    <NavigationProvider value={navigation}>
      <RosterProvider client={client} me={me}>
        {children}
      </RosterProvider>
    </NavigationProvider>
  );
}
