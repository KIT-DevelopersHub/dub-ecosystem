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
export interface EventScheduleItem {
  time: string;
  title: string;
  note: string;
}
export interface EventSpeaker {
  name: string;
  role: string;
  topic: string;
}
export interface EventSponsor {
  name: string;
  tier: string;
  status: string;
}
export interface EventChecklistItem {
  label: string;
  done: boolean;
}
export interface EventDetailsData {
  overview: string;
  venue: string;
  access: string;
  capacity: string;
  belongings: string;
  budget: string;
  operations: string;
  memo: string;
  schedule: EventScheduleItem[];
  speakers: EventSpeaker[];
  sponsors: EventSponsor[];
  checklist: EventChecklistItem[];
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
  venue: "",
  access: "",
  capacity: "",
  belongings: "",
  budget: "",
  operations: "",
  memo: "",
  schedule: [],
  speakers: [],
  sponsors: [],
  checklist: [],
  links: [],
  contacts: [],
};

export function emptyEventDetails(eventId: common.EventId): EventDetails {
  return { eventId, data: { ...EMPTY_EVENT_DETAILS_DATA }, version: 0, updatedAt: null };
}
