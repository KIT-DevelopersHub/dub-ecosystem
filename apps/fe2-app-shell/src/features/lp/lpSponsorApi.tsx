// LP管理 → スポンサー募集の API（lp-analytics /lp/sponsor-inquiries*）。契約は @dub/types lpSponsor が正本。
// LpApi とは別の小さな口にして、LpProvider が同じ ApiClient から一緒に組み立てる。
import { createContext, useContext } from "react";
import type { lpSponsor } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

const BASE = "/api/v1/lp/sponsor-inquiries";

export interface LpSponsorApi {
  /** 公開状態・通知先・件数 (app:lp:view)。 */
  get(): Promise<lpSponsor.LpSponsorInquiriesState>;
  /** 公開/停止 (app:lp:edit + lp:publish)。 */
  setEnabled(input: { enabled: boolean }): Promise<lpSponsor.LpSponsorInquiriesState>;
  /** 追加の通知メール（スポンサーチームの共有アドレス）(app:lp:edit + lp:publish)。 */
  setNotify(input: lpSponsor.LpSponsorNotifyInput): Promise<lpSponsor.LpSponsorInquiriesState>;
  /** 資料請求の一覧・新しい順 (app:lp:edit = 個人情報)。 */
  list(query: { cursor?: string; limit?: number }): Promise<lpSponsor.LpSponsorInquiriesPage>;
  /** 対応状況を変える (app:lp:edit)。 */
  setStatus(id: string, input: { status: lpSponsor.LpSponsorInquiryStatus }): Promise<lpSponsor.LpSponsorInquiry>;
}

export function createLpSponsorApi(api: ApiClient): LpSponsorApi {
  return {
    get: () => api.request<lpSponsor.LpSponsorInquiriesState>({ method: "GET", path: BASE }),
    setEnabled: (input) =>
      api.request<lpSponsor.LpSponsorInquiriesState, { enabled: boolean }>({ method: "POST", path: `${BASE}/enabled`, body: input }),
    setNotify: (input) =>
      api.request<lpSponsor.LpSponsorInquiriesState, lpSponsor.LpSponsorNotifyInput>({
        method: "POST",
        path: `${BASE}/notify`,
        body: input,
      }),
    list: (query) => {
      const q: Record<string, string | number | boolean | undefined> = {};
      if (query.cursor !== undefined) q.cursor = query.cursor;
      if (query.limit !== undefined) q.limit = query.limit;
      return api.request<lpSponsor.LpSponsorInquiriesPage>({ method: "GET", path: `${BASE}/items`, query: q });
    },
    setStatus: (id, input) =>
      api.request<lpSponsor.LpSponsorInquiry, { status: lpSponsor.LpSponsorInquiryStatus }>({
        method: "PATCH",
        path: `${BASE}/items/${encodeURIComponent(id)}`,
        body: input,
      }),
  };
}

export const LpSponsorApiCtx = createContext<LpSponsorApi | null>(null);

export function useLpSponsorApi(): LpSponsorApi {
  const ctx = useContext(LpSponsorApiCtx);
  if (!ctx) throw new Error("useLpSponsorApi must be used within <LpProvider>");
  return ctx;
}
