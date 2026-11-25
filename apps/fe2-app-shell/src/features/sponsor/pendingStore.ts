// 送信待ち/失敗した写真と、保存に失敗した下書きの置き場。
// ルートごとに Provider が remount されるので (featureModules の wrapRoute)、SponsorApi ごとに 1 つを
// WeakMap で持ち、撮影画面 → 一覧へ戻った後も「送信中の写真」「写真を再送」を出せるようにする。
import { useSyncExternalStore } from "react";
import type { sponsor } from "@dub/types";

export type PendingImageStatus = "uploading" | "failed";
export interface PendingImage {
  blob: Blob;
  status: PendingImageStatus;
}
/** 保存 (POST) に失敗した入力。撮影画面を開き直すと復元する。 */
export interface FailedDraft {
  fields: sponsor.CardFields;
  image: Blob | null;
}

interface State {
  images: Readonly<Record<string, PendingImage>>;
  draft: FailedDraft | null;
}

export interface PendingStore {
  get(): State;
  subscribe(fn: () => void): () => void;
  setImage(cardId: string, image: PendingImage): void;
  moveImage(fromId: string, toId: string): void;
  clearImage(cardId: string): void;
  setDraft(draft: FailedDraft | null): void;
}

function createPendingStore(): PendingStore {
  let state: State = { images: {}, draft: null };
  const listeners = new Set<() => void>();
  const set = (next: State) => {
    state = next;
    for (const l of listeners) l();
  };
  const withoutImage = (id: string) => {
    const images = { ...state.images };
    delete images[id];
    return images;
  };
  return {
    get: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setImage: (id, image) => set({ ...state, images: { ...state.images, [id]: image } }),
    moveImage: (from, to) => {
      const img = state.images[from];
      if (img) set({ ...state, images: { ...withoutImage(from), [to]: img } });
    },
    clearImage: (id) => {
      if (state.images[id]) set({ ...state, images: withoutImage(id) });
    },
    setDraft: (draft) => set({ ...state, draft }),
  };
}

const stores = new WeakMap<object, PendingStore>();

export function pendingStoreFor(owner: object): PendingStore {
  let s = stores.get(owner);
  if (!s) {
    s = createPendingStore();
    stores.set(owner, s);
  }
  return s;
}

export function usePendingState(store: PendingStore): State {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
