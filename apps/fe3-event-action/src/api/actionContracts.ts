// Action request/query contracts.
//
// GAP NOTE (partly resolved): the action *query* contract now lives in @dub/types
// (event.ListActionsQuery / event.ListActionsResponse) so the wire contract (event.EVENT_WIRE)
// can bind to it as the single source of truth — re-exported below for existing importers.
// The *request* types (CreateActionRequest / UpdateActionRequest) remain here until
// event-service freezes them; migrate them the same way when it does.
import type { common, event } from "@dub/types";

// Re-export the migrated action query/response contracts from the SoT so existing
// importers (eventApi.ts / mockData.ts / index.ts / hooks) keep their import paths.
export type ListActionsQuery = event.ListActionsQuery;
export type ListActionsResponse = event.ListActionsResponse;

export interface CreateActionRequest {
  kind: string; // open registry; any string allowed
  title: string;
  sortOrder?: number; // defaults to append (last + SORT_GAP)
}

export interface UpdateActionRequest extends common.Versioned {
  title?: string;
  kind?: string;
  sortOrder?: number;
  // Payload edits (plugin-specific) travel as an opaque patch until event-service
  // freezes a payload column; unused by the generic panel in P0.
  payload?: Record<string, unknown>;
}
