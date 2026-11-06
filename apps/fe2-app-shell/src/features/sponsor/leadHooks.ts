// 営業進捗のデータフック。書き込みは楽観的 UI (先に一覧キャッシュへ反映 → 失敗で戻す + エラートースト)。
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { sponsor } from "@dub/types";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { useSponsorApi } from "./SponsorProvider.tsx";

export const LEADS_KEY = queryKeys.feature("sponsor", "leads");
export const GOALS_KEY = queryKeys.feature("sponsor", "goals");

/** 楽観的に足した (まだサーバに無い) 行の id 接頭辞。 */
const TEMP_PREFIX = "tmp_";
export const isTempLead = (l: Pick<sponsor.SponsorLead, "id">): boolean => l.id.startsWith(TEMP_PREFIX);

type Lead = sponsor.SponsorLead;
type List = sponsor.ListLeadsResponse;

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

function patchList(qc: QueryClient, fn: (leads: Lead[]) => Lead[]): void {
  qc.setQueryData<List>(LEADS_KEY, (prev) => (prev ? { leads: fn(prev.leads) } : prev));
}
const replaceLead = (qc: QueryClient, id: string, next: Lead) => patchList(qc, (leads) => leads.map((l) => (l.id === id ? next : l)));

const cancelRefetch = (qc: QueryClient) => qc.cancelQueries({ queryKey: LEADS_KEY, exact: true });

/** 他の人が消した行 (404) は一覧を読み直して消す。 */
function refetchIfGone(qc: QueryClient, err: unknown): void {
  if (ApiError.isApiError(err) && err.status === 404) void qc.invalidateQueries({ queryKey: LEADS_KEY });
}

export function useLeads() {
  const api = useSponsorApi();
  return useQuery({ queryKey: LEADS_KEY, queryFn: () => api.listLeads(), staleTime: 15_000 });
}

let tempSeq = 0;

export function useCreateLead() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  const auth = useAuth();
  const me = auth.status === "authenticated" ? auth.me.user : null;
  return useMutation<Lead, unknown, sponsor.LeadFields, { tempId: string }>({
    mutationFn: (fields) => api.createLead(fields),
    onMutate: async (fields) => {
      await cancelRefetch(qc);
      const now = new Date().toISOString();
      const tempId = `${TEMP_PREFIX}${Date.now()}_${++tempSeq}`;
      const temp: Lead = {
        ...fields, id: tempId, version: 0, createdBy: (me?.id ?? "") as Lead["createdBy"], createdByName: me?.displayName ?? null,
        createdAt: now, updatedAt: now,
      };
      patchList(qc, (leads) => [temp, ...leads]);
      return { tempId };
    },
    onError: (err, _fields, ctx) => {
      if (ctx) patchList(qc, (leads) => leads.filter((l) => l.id !== ctx.tempId));
      toast.show({ kind: "error", title: messageFor(err, "企業を追加できませんでした") });
    },
    onSuccess: (lead, _fields, ctx) => replaceLead(qc, ctx.tempId, lead),
  });
}

/** 項目の更新 (楽観的)。409 は他の人の更新 → 最新を読み直して知らせる。 */
export function useUpdateLead() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<Lead, unknown, { lead: Lead; fields: Partial<sponsor.LeadFields> }>({
    mutationFn: ({ lead, fields }) => api.updateLead(lead.id, { ...fields, expectedVersion: lead.version }),
    onMutate: async ({ lead, fields }) => {
      await cancelRefetch(qc);
      replaceLead(qc, lead.id, { ...lead, ...fields });
    },
    onError: (err, { lead }) => {
      replaceLead(qc, lead.id, lead);
      refetchIfGone(qc, err);
      if (ApiError.isApiError(err) && err.status === 409) {
        toast.show({ kind: "error", title: "他の人が更新しました", description: "最新の内容を読み込みました。確認してからもう一度編集してください。" });
        void api.getLead(lead.id).then(
          (fresh) => replaceLead(qc, lead.id, fresh),
          () => void qc.invalidateQueries({ queryKey: LEADS_KEY }),
        );
        return;
      }
      toast.show({ kind: "error", title: messageFor(err, "保存できませんでした") });
    },
    onSuccess: (next) => replaceLead(qc, next.id, next),
  });
}

export function useRemoveLead() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<void, unknown, Lead>({
    mutationFn: (lead) => api.removeLead(lead.id),
    onMutate: async (lead) => {
      await cancelRefetch(qc);
      patchList(qc, (leads) => leads.filter((l) => l.id !== lead.id));
    },
    onError: (err, lead) => {
      patchList(qc, (leads) => [lead, ...leads]);
      refetchIfGone(qc, err);
      toast.show({ kind: "error", title: messageFor(err, "削除できませんでした") });
    },
  });
}

/** 取り込み。件数が多いので楽観表示はせず、終わったら結果を一覧へ足す。 */
export function useImportLeads() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<sponsor.ImportLeadsResponse, unknown, sponsor.CreateLeadRequest[]>({
    mutationFn: (leads) => api.importLeads({ leads }),
    onSuccess: ({ leads, skipped }) => {
      patchList(qc, (cur) => [...leads, ...cur]);
      toast.show({ kind: "success", title: `${leads.length} 社を取り込みました`, description: skipped > 0 ? `登録済みの ${skipped} 社は飛ばしました。` : undefined });
    },
    onError: (err) => toast.show({ kind: "error", title: "取り込めませんでした", description: messageFor(err, "通信を確認してもう一度お試しください。") }),
  });
}

export function useGoals() {
  const api = useSponsorApi();
  return useQuery({ queryKey: GOALS_KEY, queryFn: () => api.listGoals(), staleTime: 15_000 });
}
