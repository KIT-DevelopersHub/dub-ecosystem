// FE3-local contract for the free-form per-event detail store. Mirrors the
// event-service service-local shapes (services/event-service/src/types.ts). Kept
// out of the frozen @dub/types event contract on purpose (additive, service-owned).
import type { common } from "@dub/types";

export interface EventDetailLink {
  label: string;
  url: string;
}
export interface EventDetailContact {
  label: string;
  value: string;
}
export interface EventDetailsData {
  overview: string;
  memo: string;
  venue: string;
  links: EventDetailLink[];
  contacts: EventDetailContact[];
}

// Wire response: version 0 + updatedAt null => never saved yet (defaults).
export interface EventDetails {
  eventId: common.EventId;
  data: EventDetailsData;
  version: number;
  updatedAt: common.ISODateTime | null;
}

export interface SaveEventDetailsRequest {
  data: EventDetailsData;
  version: number;
}

export const EMPTY_EVENT_DETAILS_DATA: EventDetailsData = {
  overview: "",
  memo: "",
  venue: "",
  links: [],
  contacts: [],
};

export function emptyEventDetails(eventId: common.EventId): EventDetails {
  return { eventId, data: { ...EMPTY_EVENT_DETAILS_DATA }, version: 0, updatedAt: null };
}
