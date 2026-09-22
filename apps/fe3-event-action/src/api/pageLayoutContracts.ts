// FE3-local contract for the shared (event-scoped, NOT per-user) event-page block
// layout — the "イベント編集" free block-editor doc (しおり UI). Mirrors the
// event-service service-local shapes (services/event-service/src/types.ts). Kept out
// of the frozen @dub/types event contract on purpose (additive, service-owned), same
// treatment as detailsContracts.ts / sectionLayoutContracts.ts.
//
// ONE doc per event, shared by every viewer — only event:write roles can change it;
// everyone else renders it read-only. The `data` blob is the block editor's BlockDoc
// (frontend owns the block schema; the backend stores it opaquely), so a block-type
// change never needs a backend migration.
import type { common } from "@dub/types";
import type { BlockDoc } from "../blockeditor/types";
import { emptyDoc } from "../blockeditor/storage";

export type EventPageLayoutData = BlockDoc;

// Wire response: version 0 + updatedAt null => never saved yet (empty doc).
export interface EventPageLayout {
  eventId: common.EventId;
  data: EventPageLayoutData;
  version: number;
  updatedAt: common.ISODateTime | null;
}

export interface SaveEventPageLayoutRequest {
  data: EventPageLayoutData;
  version: number;
}

export function emptyEventPageLayout(eventId: common.EventId): EventPageLayout {
  return { eventId, data: emptyDoc(), version: 0, updatedAt: null };
}
