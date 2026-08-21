// Composition · per-module runtime Providers (W7a).
//
// Each feature exposes a DI Provider that the shell (FE2) is meant to supply.
// These wrappers build every feature's dependencies from the ONE shell
// api-client (appClients.tsx) plus the shell's own auth / toast / navigation,
// so a feature's routes render inside a fully-wired runtime context. They read
// live shell state via hooks (auth, toast, router) rather than props, so a
// single wrapper instance stays correct as the session/route changes.
import { useMemo, useEffect, type ReactNode } from "react";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import type { gateway } from "@dub/types";
import {
  EventApiProvider,
  RegistryProvider,
  actionTypeRegistry,
  useAuthStore,
  NavigationProvider as EventNavigationProvider,
  useCurrentEventStore,
  type NavigationApi as EventNavigationApi,
} from "@dub/fe3-event-action";
import { loadSelectedEvent, saveSelectedEvent } from "../features/gantt/selectedEventStore.ts";
import { NotificationProvider, type NotificationDeps } from "@dub/fe5-notification-inbox";
import { NavigationProvider, RosterProvider } from "@dub/admin-roster";
// FE4/FE6 deep-import surface via the single boundary (featureEntries.tsx).
import { TaskApiClientProvider, TaskRouteProvider, ChatRuntimeProvider, WsChatClient, type ChatRuntime, type TaskRouteContextValue } from "./featureEntries.tsx";
import type { ApiClient } from "../lib/api-client.tsx";
import { isDemoEnabled } from "../lib/demo-seed.tsx";
import { DemoChatRealtimeClient } from "../lib/demo-drivers.tsx";
import { useBffHome } from "../bff/useBffHome.tsx";
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

/** FE3 events: EventApi injection + the app-global ActionTypeRegistry + the FE3
 *  NavigationProvider (fed from the shell router) + the current-event bridge. */
export function EventProviders({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const eventApi = useMemo(() => createEventApi(api), [api]);
  // Bridge the shell's resolved /me into FE3's auth store so its event-scoped
  // permissions (EventContext → EventDetailsPanel 編集 gate) reflect the real session.
  // Without this FE3 fails closed (read-only) and the イベント詳細 store can't be edited.
  const me = useMe();
  useEffect(() => {
    useAuthStore.getState().setMe(me);
  }, [me]);

  // FE3 owns no router — it navigates through its NavigationProvider contract. The
  // shell must feed that from its TanStack Router or FE3's pages fall back to the
  // no-op shim: the hub's アクション/タスク/チャット buttons and the /events list
  // filters (setSearch) silently do nothing, and detail/settings routes read empty
  // params. (Only FE7 got this wiring before; FE3 was missing it.)
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as Record<string, string>;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const navigation = useMemo<EventNavigationApi>(
    () => ({
      navigate: (to: string) => {
        void navigate({ to });
      },
      params,
      search: (searchStr ?? "").replace(/^\?/, ""),
      setSearch: (query: string) => {
        void navigate({ to: `${pathname}${query ? `?${query}` : ""}` });
      },
    }),
    [navigate, params, pathname, searchStr],
  );

  // Bridge the globally-selected event (the shell header switcher's memory,
  // localStorage key `dub:selected-event`) into FE3's current-event store so the
  // 詳細ハブ opens on the event shown as selected in the header instead of an empty
  // "イベントを選択してください" prompt. Two-way so the header label follows an
  // in-hub pick too: seed FE3 from the global memory when FE3 has none, and mirror
  // FE3's selection back to the global memory whenever it changes.
  const currentEventId = useCurrentEventStore((s) => s.eventId);
  const setCurrentEventId = useCurrentEventStore((s) => s.setEventId);
  useEffect(() => {
    if (!currentEventId) {
      const globalSelected = loadSelectedEvent();
      if (globalSelected) setCurrentEventId(globalSelected as typeof currentEventId);
    }
  }, [currentEventId, setCurrentEventId]);
  useEffect(() => {
    if (currentEventId) saveSelectedEvent(currentEventId);
  }, [currentEventId]);

  return (
    <EventApiProvider api={eventApi}>
      <RegistryProvider registry={actionTypeRegistry}>
        <EventNavigationProvider value={navigation}>{children}</EventNavigationProvider>
      </RegistryProvider>
    </EventApiProvider>
  );
}

/** FE4 tasks: the request-object ApiClient FE4's hooks read via useApiClient, plus
 *  the TaskRouteContext (currentUserId + effectivePermissions from the shell's /me).
 *  Without the latter the standalone マイタスク route (`/me/tasks`) has no current
 *  user and renders its "ユーザー情報を読み込んでいます…" banner forever — the route
 *  is dead until the shell supplies it (see taskRoutes.tsx cross-PR seam note). */
export function TaskProviders({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const client = useMemo(() => createTaskApiClient(api), [api]);
  const me = useMe();
  const routeValue = useMemo<TaskRouteContextValue>(
    () => ({ currentUserId: me?.user.id ?? null, permissions: me?.permissions ?? null }),
    [me],
  );
  return (
    <TaskApiClientProvider client={client}>
      <TaskRouteProvider value={routeValue}>{children}</TaskRouteProvider>
    </TaskApiClientProvider>
  );
}

/** FE5 notifications: api + shell navigate + shell toast (kinds line up).
 *  Seeds the unread badge from the SAME /bff/home aggregate the Home screen shows,
 *  so the header bell + launcher badge match Home immediately on load (no waiting
 *  on the first poll, and no header/Home mismatch). react-query dedupes this with
 *  Home's own useBffHome (shared queryKey). */
export function NotificationProviders({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const { data } = useBffHome(api);
  const initialUnreadHint = data?.unreadCount;
  const deps = useMemo<NotificationDeps>(
    () => ({
      api: createNotificationClient(api),
      navigate: (path: string) => {
        void navigate({ to: path });
      },
      toast: {
        show: (kind, message) => toast.show({ kind, title: message }),
      },
      ...(typeof initialUnreadHint === "number" ? { initialUnreadHint } : {}),
    }),
    [api, navigate, toast, initialUnreadHint],
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
    // A05: demo builds have no chat-service DO, so the real WS never delivers.
    // Swap in a demo realtime client that fabricates a fresh inbound message
    // every 30s (→ 新着入場 animation). Production keeps the real WsChatClient.
    const demo = isDemoEnabled(import.meta.env as { VITE_DEMO?: string });
    return {
      api: chatApi,
      can,
      currentUserId: me?.user.id ?? ("" as gateway.MeResponse["user"]["id"]),
      createRealtimeClient: () =>
        demo
          ? new DemoChatRealtimeClient()
          : new WsChatClient({ getTicket: (channelId) => chatApi.getWsTicket(channelId) }),
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
