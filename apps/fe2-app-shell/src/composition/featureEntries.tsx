// Composition · unstable feature deep-import boundary.
//
// FE3, FE5 and FE7 publish a package-root public entry (`@dub/fe3-event-action`,
// `@dub/fe5-notification-inbox`, `@dub/admin-roster`), so the shell imports them
// by package name. FE4 and FE6 do NOT yet declare `exports` maps, so their
// public surface is only reachable through deep `src/...` paths that bypass the
// package boundary and would break the moment those packages add an export map.
//
// This module is the ONE place the shell reaches into those deep paths. Every
// other shell file imports the FE4/FE6 surface from here, so when fe4-task-gantt
// and fe6-chat ship real export maps (cross-PR: fe4, fe6) only this file changes
// — swap the `src/...` specifiers for the package roots and delete this note.
//
// Keep this list minimal: re-export exactly what the shell consumes, nothing more.

// ── FE4 (@dub/fe4-task-gantt) ────────────────────────────────────────────────
export { taskModule, eventTaskRoutes, registerTaskActionPlugin } from "@dub/fe4-task-gantt/src/features/task-gantt/public";
export { ApiClientProvider as TaskApiClientProvider } from "@dub/fe4-task-gantt/src/api/client-context";
export { TaskRouteProvider } from "@dub/fe4-task-gantt/src/routes/taskRoutes";
export type { TaskRouteContextValue } from "@dub/fe4-task-gantt/src/routes/taskRoutes";
export type { ApiClient as Fe4ApiClient } from "@dub/fe4-task-gantt/src/contracts/spa-shell";

// ── FE6 (@dub/fe6-chat) ──────────────────────────────────────────────────────
export { ChatRuntimeProvider, chatFeature } from "@dub/fe6-chat/src/feature";
export type { ChatRuntime } from "@dub/fe6-chat/src/feature";
export { WsChatClient } from "@dub/fe6-chat/src/realtime/ws-client";
export type { ChatApiClient } from "@dub/fe6-chat/src/api/client";
export type {
  Channel,
  ChannelMember,
  CreateChannelRequest,
  EditMessageRequest,
  GetChannelResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  Message,
  PostMessageRequest,
  PostMessageResponse,
  Reaction,
  ReactionToggleRequest,
  ReactionToggleResponse,
  ReadStateUpdateRequest,
  SearchHit,
  SearchMessagesRequest,
  UnreadSummary,
  UpdateChannelRequest,
  WsTicketResponse,
} from "@dub/fe6-chat/src/api/contract";
