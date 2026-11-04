// 公開設定のデータフック。
//  - 下書きの自動保存: 先にキャッシュへ反映（楽観的）→ 保存は直列キューで 1 件ずつ送る（revision は送る直前の値）。
//    失敗したら保存前の下書きへ戻してトースト。409（他の操作で更新済み）は最新を読み直してトースト。
//  - 本番反映: 確認ダイアログの後に楽観的に本番の値を差し替え → 失敗でロールバック。成功後は
//    チケット・募集・公開版のキャッシュも読み直す（本番の値はそれらのテーブルが正本）。
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useLpApi } from "./LpProvider.tsx";
import type { LpSiteConfig, LpSiteConfigState } from "./lpApi.tsx";
import { lpPublishKey } from "./lpHooks.ts";
import { lpTicketsKey } from "./lpTicketsHooks.ts";
import { lpProposalsKey } from "./lpProposalsHooks.ts";

export const STALE_MESSAGE = "他の操作で公開設定が更新されていたため、最新の内容を読み込みました";

export function lpSiteConfigKey() {
  return queryKeys.feature("lp", "site-config");
}

const isConflict = (err: unknown): boolean => ApiError.isApiError(err) && err.status === 409;
const messageFor = (err: unknown, fallback: string): string =>
  ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;

export function useLpSiteConfig() {
  const api = useLpApi();
  return useQuery({ queryKey: lpSiteConfigKey(), queryFn: () => api.getSiteConfig() });
}

/** 下書きの自動保存。`save(next)` は即座にキャッシュへ反映し、裏で順番に PUT する。 */
export function useDraftAutosave(): { save: (next: LpSiteConfig) => void; saving: boolean } {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpSiteConfigKey();
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const [saving, setSaving] = useState(false);

  const save = (next: LpSiteConfig): void => {
    const before = qc.getQueryData<LpSiteConfigState>(key);
    if (!before) return;
    qc.setQueryData<LpSiteConfigState>(key, { ...before, draft: next });
    pending.current += 1;
    setSaving(true);
    chain.current = chain.current.then(async () => {
      try {
        const cur = qc.getQueryData<LpSiteConfigState>(key) ?? before;
        const res = await api.saveSiteConfigDraft({ config: next, revision: cur.revision });
        // まだ後ろに保存が控えていれば、画面の下書き（より新しい楽観値）は残して revision だけ進める。
        const latest = qc.getQueryData<LpSiteConfigState>(key);
        qc.setQueryData<LpSiteConfigState>(key, pending.current > 1 && latest ? { ...res, draft: latest.draft } : res);
      } catch (err) {
        if (isConflict(err)) {
          toast.show({ kind: "error", title: STALE_MESSAGE });
        } else {
          const latest = qc.getQueryData<LpSiteConfigState>(key);
          qc.setQueryData<LpSiteConfigState>(key, { ...(latest ?? before), draft: before.draft });
          toast.show({ kind: "error", title: messageFor(err, "下書きを保存できませんでした") });
        }
        await qc.invalidateQueries({ queryKey: key });
      } finally {
        pending.current -= 1;
        if (pending.current === 0) setSaving(false);
      }
    });
  };

  return { save, saving };
}

/** 下書きを本番の内容に戻す。 */
export function useResetDraft() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpSiteConfigKey();
  return useMutation<LpSiteConfigState, unknown, void, { prev: LpSiteConfigState | undefined }>({
    mutationFn: () => api.resetSiteConfigDraft({ revision: qc.getQueryData<LpSiteConfigState>(key)?.revision }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<LpSiteConfigState>(key);
      if (prev) qc.setQueryData<LpSiteConfigState>(key, { ...prev, draft: structuredClone(prev.published) });
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (isConflict(err)) toast.show({ kind: "error", title: STALE_MESSAGE });
      else {
        if (ctx?.prev) qc.setQueryData(key, ctx.prev);
        toast.show({ kind: "error", title: messageFor(err, "下書きを戻せませんでした") });
      }
      void qc.invalidateQueries({ queryKey: key });
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.show({ kind: "success", title: "下書きを本番の内容に戻しました" });
    },
  });
}

/** 本番に反映。呼び出し側が確認ダイアログを済ませてから mutate する。 */
export function usePublishSiteConfig() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpSiteConfigKey();
  return useMutation<LpSiteConfigState, unknown, { config: LpSiteConfig }, { prev: LpSiteConfigState | undefined }>({
    mutationFn: ({ config }) =>
      api.publishSiteConfig({ config, revision: qc.getQueryData<LpSiteConfigState>(key)?.revision ?? 0 }),
    onMutate: async ({ config }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<LpSiteConfigState>(key);
      if (prev) qc.setQueryData<LpSiteConfigState>(key, { ...prev, published: config });
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: isConflict(err) ? STALE_MESSAGE : messageFor(err, "本番に反映できませんでした") });
      void qc.invalidateQueries({ queryKey: key });
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.show({ kind: "success", title: "本番に反映しました（LP に出るまで最大 1 分ほどかかります）" });
      void qc.invalidateQueries({ queryKey: lpPublishKey() });
      void qc.invalidateQueries({ queryKey: lpTicketsKey() });
      void qc.invalidateQueries({ queryKey: lpProposalsKey() });
    },
  });
}
