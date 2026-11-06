// スポンサーのメール連携のデータフック: メールアドレスの紐付け (楽観的)・自動更新の履歴・既存メールからの一括補完。
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { sponsor } from "@dub/types";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { useSponsorApi } from "./SponsorProvider.tsx";
import { LEADS_KEY } from "./leadHooks.ts";
import type { SponsorApi } from "./sponsorApi.tsx";

export const MAIL_LINKS_KEY = queryKeys.feature("sponsor", "mailLinks");
export const activityKey = (leadId: string) => queryKeys.feature("sponsor", "activity", leadId);

type Link = sponsor.SponsorMailLink;

const messageFor = (err: unknown, fallback: string): string => (ApiError.isApiError(err) ? toDisplayableError(err).message : fallback);

function patchLinks(qc: QueryClient, fn: (links: Link[]) => Link[]): void {
  qc.setQueryData<sponsor.ListMailLinksResponse>(MAIL_LINKS_KEY, (prev) => (prev ? { links: fn(prev.links) } : prev));
}

export function useMailLinks(enabled = true) {
  const api = useSponsorApi();
  return useQuery({ queryKey: MAIL_LINKS_KEY, queryFn: () => api.listMailLinks(), staleTime: 60_000, enabled });
}

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

/**
 * メールアドレスを営業先に紐付ける (楽観的: 先に紐付け一覧へ足す → 失敗で戻す)。
 * 成功したら営業先の最新 (担当者メールの補完・既存メールからの日付) を一覧に反映する。
 */
export function useLinkMail() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  const auth = useAuth();
  const me = auth.status === "authenticated" ? auth.me.user : null;
  return useMutation<sponsor.CreateMailLinkResponse, unknown, { lead: sponsor.SponsorLead; address: string; threadId?: string | null }, { prev: Link[] | undefined }>({
    mutationFn: ({ lead, address, threadId }) => api.createMailLink(lead.id, { address, threadId: threadId ?? null }),
    onMutate: async ({ lead, address, threadId }) => {
      await qc.cancelQueries({ queryKey: MAIL_LINKS_KEY, exact: true });
      const prev = qc.getQueryData<sponsor.ListMailLinksResponse>(MAIL_LINKS_KEY)?.links;
      const temp: Link = {
        id: `tmp_link_${Date.now()}`, leadId: lead.id, address: address.toLowerCase(), threadId: threadId ?? null,
        createdBy: (me?.id ?? "") as Link["createdBy"], createdByName: me?.displayName ?? null, createdAt: new Date().toISOString(),
      };
      patchLinks(qc, (links) => [temp, ...links.filter((l) => l.address !== temp.address)]);
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData<sponsor.ListMailLinksResponse>(MAIL_LINKS_KEY, { links: ctx.prev });
      toast.show({ kind: "error", title: messageFor(err, "紐付けられませんでした") });
    },
    onSuccess: ({ link, lead }, vars) => {
      patchLinks(qc, (links) => [link, ...links.filter((l) => l.address !== link.address)]);
      qc.setQueryData<sponsor.ListLeadsResponse>(LEADS_KEY, (prev) => (prev ? { leads: prev.leads.map((l) => (l.id === lead.id ? lead : l)) } : prev));
      void qc.invalidateQueries({ queryKey: activityKey(lead.id) });
      const moved = lead.version !== vars.lead.version;
      toast.show({
        kind: "success",
        title: `「${lead.companyName}」に紐付けました`,
        description: moved ? "このアドレスとのメールから日付を入れました。" : "以後このアドレスとのメールで日付が自動で入ります。",
      });
    },
  });
}

export function useRemoveMailLink() {
  const api = useSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<void, unknown, Link, { prev: Link[] | undefined }>({
    mutationFn: (link) => api.removeMailLink(link.id),
    onMutate: async (link) => {
      await qc.cancelQueries({ queryKey: MAIL_LINKS_KEY, exact: true });
      const prev = qc.getQueryData<sponsor.ListMailLinksResponse>(MAIL_LINKS_KEY)?.links;
      patchLinks(qc, (links) => links.filter((l) => l.id !== link.id));
      return { prev };
    },
    onError: (err, _link, ctx) => {
      if (ctx?.prev) qc.setQueryData<sponsor.ListMailLinksResponse>(MAIL_LINKS_KEY, { links: ctx.prev });
      toast.show({ kind: "error", title: messageFor(err, "紐付けを外せませんでした") });
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
