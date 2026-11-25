// スポンサーのメール連携のデータフック: メールの相手を担当者メールに登録 (楽観的)・自動更新の履歴・既存メールからの一括補完。
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { sponsor } from "@dub/types";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useSponsorApi } from "./SponsorProvider.tsx";
import { LEADS_KEY } from "./leadHooks.ts";
import type { SponsorApi } from "./sponsorApi.tsx";

export const activityKey = (leadId: string) => queryKeys.feature("sponsor", "activity", leadId);

const messageFor = (err: unknown, fallback: string): string => (ApiError.isApiError(err) ? toDisplayableError(err).message : fallback);

export function useLeadActivity(leadId: string | null) {
  const api = useSponsorApi();
  return useQuery({
    queryKey: activityKey(leadId ?? ""),
    queryFn: () => api.listLeadActivity(leadId!),
    enabled: leadId !== null,
    staleTime: 15_000,
  });
}

/** 変わった項目を短い日本語に (トースト用)。 */
export function describeChanges(changes: readonly sponsor.LeadFieldChange[]): string {
  const label: Record<sponsor.MailSyncField, string> = { status: "ステータス", firstContactOn: "初回連絡日", lastContactOn: "最終接触日" };
  return changes.map((c) => `${label[c.field]}: ${c.from ?? "—"} → ${c.to ?? "—"}`).join("、");
}

function patchLead(qc: QueryClient, id: string, fn: (l: sponsor.SponsorLead) => sponsor.SponsorLead): void {
  qc.setQueryData<sponsor.ListLeadsResponse>(LEADS_KEY, (prev) => (prev ? { leads: prev.leads.map((l) => (l.id === id ? fn(l) : l)) } : prev));
}

/**
 * メールの相手を営業先の担当者メールに登録する (楽観的: 先に一覧の担当者メールへ足す → 失敗で戻す)。
 * 成功したら営業先の最新 (既存メールから入った日付) を一覧に反映する。
 */
export function useRegisterContactEmail() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<sponsor.RegisterContactEmailResponse, unknown, { lead: sponsor.SponsorLead; address: string }, { prev: sponsor.SponsorLead }>({
    mutationFn: ({ lead, address }) => api.registerContactEmail(lead.id, { address }),
    onMutate: async ({ lead, address }) => {
      await qc.cancelQueries({ queryKey: LEADS_KEY, exact: true });
      const a = address.toLowerCase();
      patchLead(qc, lead.id, (l) => ({ ...l, contactEmail: l.contactEmail ? `${l.contactEmail}／${a}` : a }));
      return { prev: lead };
    },
    onError: (err, _vars, ctx) => {
      if (ctx) patchLead(qc, ctx.prev.id, () => ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "登録できませんでした") });
    },
    onSuccess: ({ lead }, vars) => {
      patchLead(qc, lead.id, () => lead);
      void qc.invalidateQueries({ queryKey: activityKey(lead.id) });
      const dated = lead.firstContactOn !== vars.lead.firstContactOn || lead.lastContactOn !== vars.lead.lastContactOn;
      toast.show({
        kind: "success",
        title: `「${lead.companyName}」の担当者メールに登録しました`,
        description: dated ? "このアドレスとのメールから日付を入れました。" : "以後このアドレスとのメールで日付が自動で入ります。",
      });
    },
  });
}

/** 営業先を最後まで 1 ページずつ (1 回の呼び出しをサーバの上限内に収める)。 */
export async function runMailBackfill(
  api: SponsorApi,
  dryRun: boolean,
  onPage?: (done: number, total: number) => void,
): Promise<sponsor.MailBackfillProposal[]> {
  const out: sponsor.MailBackfillProposal[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: sponsor.MailBackfillResponse = await api.mailBackfill({ dryRun, offset });
    out.push(...page.proposals);
    onPage?.(page.nextOffset ?? page.total, page.total);
    offset = page.nextOffset;
  }
  return out;
}

/** 一括補完の確認 (dryRun) と反映。反映後は一覧を読み直す (件数が多く、結果はサーバで決まるので楽観表示しない)。 */
export function useMailBackfill() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  return useMutation<sponsor.MailBackfillProposal[], unknown, { dryRun: boolean; onPage?: (done: number, total: number) => void }>({
    mutationFn: ({ dryRun, onPage }) => runMailBackfill(api, dryRun, onPage),
    onSuccess: (_res, { dryRun }) => {
      if (!dryRun) {
        void qc.invalidateQueries({ queryKey: LEADS_KEY });
        void qc.invalidateQueries({ queryKey: queryKeys.feature("sponsor", "activity") });
      }
    },
  });
}
