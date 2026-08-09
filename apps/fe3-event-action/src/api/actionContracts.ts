// Action request/query contracts.
//
// GAP NOTE: @dub/types event namespace (P0b) exports DubAction plus the *event*
// request types, but NOT the action request/query types (CreateActionRequest,
// UpdateActionRequest, ListActionsQuery / ListActionsResponse) that design §2-4
// references. They are defined here, shaped to DubAction, and should migrate into
// @dub/types event when event-service adds them (open item — do not re-define
// there and here permanently). Field names track DubAction (`kind`, `sortOrder`).
import type { common, event } from "@dub/types";

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

export interface ListActionsQuery extends common.CursorQuery {
  kind?: string;
}

export type ListActionsResponse = common.Paginated<event.DubAction>;
