/// <reference lib="dom" />
// Composer draft persistence (design §3). sessionStorage is the default (avoid
// plaintext message bodies in localStorage; FE2 "UI settings only, no PII").
// Cleared on send/discard; capped in length. Only the last-opened channelId is
// allowed in localStorage.
import type { common } from "@dub/types";

export const DRAFT_MAX_LEN = 4000;
const DRAFT_PREFIX = "fe6.chat.draft.";
const LAST_CHANNEL_KEY = "fe6.chat.lastChannel";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function session(): StorageLike | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // storage disabled / SSR
  }
}
function local(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadDraft(channelId: common.ChannelId, store: StorageLike | null = session()): string {
  return store?.getItem(DRAFT_PREFIX + channelId) ?? "";
}

/** Save a draft, truncated to DRAFT_MAX_LEN. Empty body removes the key. */
export function saveDraft(channelId: common.ChannelId, body: string, store: StorageLike | null = session()): void {
  if (!store) return;
  if (body.length === 0) {
    store.removeItem(DRAFT_PREFIX + channelId);
    return;
  }
  store.setItem(DRAFT_PREFIX + channelId, body.slice(0, DRAFT_MAX_LEN));
}

export function clearDraft(channelId: common.ChannelId, store: StorageLike | null = session()): void {
  store?.removeItem(DRAFT_PREFIX + channelId);
}

export function getLastChannel(store: StorageLike | null = local()): common.ChannelId | null {
  return store?.getItem(LAST_CHANNEL_KEY) ?? null;
}

export function setLastChannel(channelId: common.ChannelId, store: StorageLike | null = local()): void {
  store?.setItem(LAST_CHANNEL_KEY, channelId);
}
