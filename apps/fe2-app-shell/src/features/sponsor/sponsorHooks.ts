// スポンサー (名刺) のデータフック。書き込みはすべて楽観的 UI (先に一覧キャッシュへ反映 → 失敗で戻す +
// エラートースト)。登録は POST → PUT image の 2 段で、写真だけ失敗したら名刺は残して「写真を再送」を出す。
// 登録・写真送信は撮影画面を離れた後に終わるので、useMutation の呼び出し側コールバックではなく
// qc / pendingStore / toast (いずれもアプリ寿命) だけを触る素の async 関数で書く。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { sponsor } from "@dub/types";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { useSponsorApi, useSponsorPending } from "./SponsorProvider.tsx";
import { usePendingState } from "./pendingStore.ts";
import { groupCompanies } from "./companies.ts";

export const SPONSOR_LIST_KEY = queryKeys.feature("sponsor", "cards");
export const SPONSOR_IMAGE_KEY = (id: string) => queryKeys.feature("sponsor", "image", id);

/** 楽観的に足した (まだサーバに無い) 名刺の id 接頭辞。 */
export const TEMP_PREFIX = "tmp_";
export const isTempCard = (c: Pick<sponsor.BusinessCard, "id">): boolean => c.id.startsWith(TEMP_PREFIX);

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

type List = sponsor.ListCardsResponse;

function patchList(qc: QueryClient, fn: (cards: sponsor.BusinessCard[]) => sponsor.BusinessCard[]): void {
  qc.setQueryData<List>(SPONSOR_LIST_KEY, (prev) => (prev ? { cards: fn(prev.cards) } : prev));
}
const replaceCard = (qc: QueryClient, id: string, next: sponsor.BusinessCard) =>
  patchList(qc, (cards) => cards.map((c) => (c.id === id ? next : c)));

export function useCards() {
  const api = useSponsorApi();
  return useQuery({ queryKey: SPONSOR_LIST_KEY, queryFn: () => api.list(), staleTime: 15_000 });
}

/** 名刺を企業ごとにまとめたもの (一覧と同じクエリから作る)。 */
export function useCompanies() {
  const list = useCards();
  const grouped = useMemo(() => groupCompanies(list.data?.cards ?? []), [list.data]);
  return { list, ...grouped };
}

/** blob → object URL。差し替え・アンマウントで revoke する。 */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== "function") {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export type CardImageState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; url: string; pending: PendingImageView };
export type PendingImageView = "uploading" | "failed" | null;

/** 名刺の写真。送信待ちの手元の写真があればそれを優先 (撮った直後から一覧に出る)。 */
export function useCardImage(card: sponsor.BusinessCard): CardImageState {
  const api = useSponsorApi();
  const pending = usePendingState(useSponsorPending()).images[card.id];
  const remote = useQuery({
    queryKey: SPONSOR_IMAGE_KEY(card.id),
    queryFn: () => api.image(card.id),
    enabled: card.hasImage && !pending && !isTempCard(card),
    staleTime: Infinity,
    retry: 1,
  });
  const blob = pending?.blob ?? (card.hasImage ? remote.data : undefined);
  const url = useObjectUrl(blob);
  if (url) return { kind: "ready", url, pending: pending?.status ?? null };
  if (pending || (card.hasImage && remote.isLoading)) return { kind: "loading" };
  if (card.hasImage && remote.isError) return { kind: "error" };
  return card.hasImage ? { kind: "loading" } : { kind: "none" };
}

/** 写真の送信 (新規登録の 2 段目・撮り直し・再送で共通)。成功で true。 */
export function useUploadImage(): (cardId: string, image: Blob) => Promise<boolean> {
  const api = useSponsorApi();
  const pending = useSponsorPending();
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    async (cardId, image) => {
      pending.setImage(cardId, { blob: image, status: "uploading" });
      try {
        const next = await api.uploadImage(cardId, image);
        qc.setQueryData(SPONSOR_IMAGE_KEY(cardId), image);
        replaceCard(qc, cardId, next);
        pending.clearImage(cardId);
        return true;
      } catch (err) {
        pending.setImage(cardId, { blob: image, status: "failed" });
        toast.show({ kind: "error", title: "写真を送信できませんでした", description: messageFor(err, "「写真を再送」からもう一度送れます。") });
        return false;
      }
    },
    [api, pending, qc, toast],
  );
}

const nullIfBlank = (v: string | null | undefined): string | null => {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
};

export function normalizeFields(f: sponsor.CardFields): Required<sponsor.CardFields> {
  return {
    companyName: nullIfBlank(f.companyName),
    personName: nullIfBlank(f.personName),
    department: nullIfBlank(f.department),
    title: nullIfBlank(f.title),
    email: nullIfBlank(f.email),
    phone: nullIfBlank(f.phone),
    note: nullIfBlank(f.note),
  };
}

let tempSeq = 0;

/**
 * 名刺の登録 (楽観的)。一覧の先頭に仮の名刺を足して即座に戻れるようにし、裏で POST → PUT image。
 * POST が失敗したら仮の名刺を消し、入力は下書きに残す (撮影画面を開くと復元)。
 */
export function useSaveCard(): (fields: sponsor.CardFields, image: Blob | null) => Promise<void> {
  const api = useSponsorApi();
  const pending = useSponsorPending();
  const qc = useQueryClient();
  const toast = useToast();
  const auth = useAuth();
  const upload = useUploadImage();
  const me = auth.status === "authenticated" ? auth.me.user : null;
  return useCallback(
    async (input, image) => {
      const fields = normalizeFields(input);
      const now = new Date().toISOString();
      const tempId = `${TEMP_PREFIX}${Date.now()}_${++tempSeq}`;
      const temp: sponsor.BusinessCard = {
        id: tempId, ...fields, hasImage: image !== null, version: 0,
        createdBy: (me?.id ?? "") as sponsor.BusinessCard["createdBy"], createdByName: me?.displayName ?? null,
        createdAt: now, updatedAt: now,
      };
      await qc.cancelQueries({ queryKey: SPONSOR_LIST_KEY, exact: true });
      patchList(qc, (cards) => [temp, ...cards]);
      if (image) pending.setImage(tempId, { blob: image, status: "uploading" });
      pending.setDraft(null);
      let created: sponsor.BusinessCard;
      try {
        created = await api.create(fields);
      } catch (err) {
        patchList(qc, (cards) => cards.filter((c) => c.id !== tempId));
        pending.clearImage(tempId);
        pending.setDraft({ fields, image });
        toast.show({
          kind: "error",
          title: "名刺を保存できませんでした",
          description: `${messageFor(err, "通信を確認してください。")}「名刺をスキャン」を開くと入力内容を復元できます。`,
        });
        return;
      }
      // 一覧を一度も読んでいない (撮影画面へ直接来た) なら、戻った時に読み直させる。
      if (!qc.getQueryData(SPONSOR_LIST_KEY)) void qc.invalidateQueries({ queryKey: SPONSOR_LIST_KEY });
      // 写真の有無はサーバの応答 (まだ false) ではなく送信待ちの写真で表す。
      if (image) pending.moveImage(tempId, created.id);
      replaceCard(qc, tempId, { ...created, hasImage: false });
      if (image) await upload(created.id, image);
    },
    [api, pending, qc, toast, upload, me?.id, me?.displayName],
  );
}

type ListCtx = { prev: List | undefined };

/** 項目の更新 (楽観的)。409 は他の人の更新 → 最新を読み直して知らせる。 */
export function useUpdateCard() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<sponsor.BusinessCard, unknown, { card: sponsor.BusinessCard; fields: sponsor.CardFields }, ListCtx>({
    mutationFn: ({ card, fields }) => api.update(card.id, { ...normalizeFields(fields), expectedVersion: card.version }),
    onMutate: async ({ card, fields }) => {
      await qc.cancelQueries({ queryKey: SPONSOR_LIST_KEY, exact: true });
      const prev = qc.getQueryData<List>(SPONSOR_LIST_KEY);
      replaceCard(qc, card.id, { ...card, ...normalizeFields(fields) });
      return { prev };
    },
    onError: (err, { card }, ctx) => {
      if (ctx?.prev) qc.setQueryData(SPONSOR_LIST_KEY, ctx.prev);
      if (ApiError.isApiError(err) && err.status === 409) {
        toast.show({ kind: "error", title: "他の人が更新しました", description: "最新の内容を読み込みました。確認してからもう一度編集してください。" });
        void api.get(card.id).then(
          (fresh) => replaceCard(qc, card.id, fresh),
          () => void qc.invalidateQueries({ queryKey: SPONSOR_LIST_KEY }),
        );
        return;
      }
      toast.show({ kind: "error", title: messageFor(err, "保存できませんでした") });
    },
    onSuccess: (next) => replaceCard(qc, next.id, next),
  });
}

/** 削除 (確認ダイアログの後に楽観的に一覧から消す・失敗で復活)。 */
export function useRemoveCard() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<void, unknown, sponsor.BusinessCard, ListCtx>({
    mutationFn: (card) => api.remove(card.id),
    onMutate: async (card) => {
      await qc.cancelQueries({ queryKey: SPONSOR_LIST_KEY, exact: true });
      const prev = qc.getQueryData<List>(SPONSOR_LIST_KEY);
      patchList(qc, (cards) => cards.filter((c) => c.id !== card.id));
      return { prev };
    },
    onError: (err, _card, ctx) => {
      if (ctx?.prev) qc.setQueryData(SPONSOR_LIST_KEY, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "削除できませんでした") });
    },
    onSuccess: (_r, card) => qc.removeQueries({ queryKey: SPONSOR_IMAGE_KEY(card.id) }),
  });
}
