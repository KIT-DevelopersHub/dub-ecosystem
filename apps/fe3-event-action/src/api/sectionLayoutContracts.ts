// FE3-local contract for the shared (event/org-scoped, NOT per-user) section
// layout store. Mirrors the event-service service-local shapes
// (services/event-service/src/types.ts). Kept out of the frozen @dub/types event
// contract on purpose (additive, service-owned), same treatment as detailsContracts.ts.
//
// Unlike FE2's Home dashboard layout (per-viewer, localStorage), this layout is ONE
// document per event that every viewer sees the same way — only event:write roles
// (admin/organizer/maintainer) can change it; everyone else renders it read-only.
import type { common } from "@dub/types";

export interface EventSectionLayoutData {
  /** Full preferred order of section ids. Ids absent fall back to catalog order. */
  order: string[];
  /** Section ids currently hidden from the resting (non-edit) view. */
  hidden: string[];
}

// Wire response: version 0 + updatedAt null => never saved yet (catalog default).
export interface EventSectionLayout {
  eventId: common.EventId;
  data: EventSectionLayoutData;
  version: number;
  updatedAt: common.ISODateTime | null;
}

export interface SaveEventSectionLayoutRequest {
  data: EventSectionLayoutData;
  version: number;
}

export const EMPTY_EVENT_SECTION_LAYOUT_DATA: EventSectionLayoutData = { order: [], hidden: [] };

export function emptyEventSectionLayout(eventId: common.EventId): EventSectionLayout {
  return { eventId, data: { ...EMPTY_EVENT_SECTION_LAYOUT_DATA }, version: 0, updatedAt: null };
}
