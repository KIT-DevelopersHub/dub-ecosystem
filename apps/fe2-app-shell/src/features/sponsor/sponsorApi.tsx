// スポンサー feature の api アダプタ。シェルの api-client (session cookie / 401→refresh / requestId /
// エラー正規化) に乗り、/api/v1/members/sponsor/* → gateway → member-service に届く。
// 契約型は @dub/types `sponsor` (SoT) をそのまま使う。
import type { sponsor } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

export interface SponsorApi {
  list(): Promise<sponsor.ListCardsResponse>;
  get(id: string): Promise<sponsor.BusinessCard>;
  create(body: sponsor.CreateCardRequest): Promise<sponsor.BusinessCard>;
  update(id: string, body: sponsor.UpdateCardRequest): Promise<sponsor.BusinessCard>;
  remove(id: string): Promise<void>;
  /** 写真を生バイトで送る (端末で JPEG に縮小済み)。 */
  uploadImage(id: string, image: Blob): Promise<sponsor.BusinessCard>;
  /** 写真本体 (認証付き)。表示側で object URL にする。 */
  image(id: string): Promise<Blob>;
  listLeads(): Promise<sponsor.ListLeadsResponse>;
  getLead(id: string): Promise<sponsor.SponsorLead>;
  createLead(body: sponsor.CreateLeadRequest): Promise<sponsor.SponsorLead>;
  importLeads(body: sponsor.ImportLeadsRequest): Promise<sponsor.ImportLeadsResponse>;
  updateLead(id: string, body: sponsor.UpdateLeadRequest): Promise<sponsor.SponsorLead>;
  removeLead(id: string): Promise<void>;
  listGoals(): Promise<sponsor.ListGoalsResponse>;
  putGoal(month: string, body: sponsor.PutGoalRequest): Promise<sponsor.MonthlyGoal>;
}

const BASE = "/api/v1/members/sponsor";
const enc = encodeURIComponent;

export function createSponsorApi(api: ApiClient): SponsorApi {
  const card = (id: string) => `${BASE}/cards/${enc(id)}` as const;
  const lead = (id: string) => `${BASE}/leads/${enc(id)}` as const;
  return {
    list: () => api.request<sponsor.ListCardsResponse>({ method: "GET", path: `${BASE}/cards` }),
    get: (id) => api.request<sponsor.BusinessCard>({ method: "GET", path: card(id) }),
    create: (body) => api.request<sponsor.BusinessCard, sponsor.CreateCardRequest>({ method: "POST", path: `${BASE}/cards`, body }),
    update: (id, body) => api.request<sponsor.BusinessCard, sponsor.UpdateCardRequest>({ method: "PATCH", path: card(id), body }),
    remove: async (id) => {
      await api.request<void>({ method: "DELETE", path: card(id) });
    },
    uploadImage: (id, image) =>
      api.request<sponsor.BusinessCard, Blob>({
        method: "PUT",
        path: `${card(id)}/image`,
        body: image,
        headers: { "content-type": image.type || "image/jpeg" },
      }),
    image: (id) => api.download(`${card(id)}/image`),
    listLeads: () => api.request<sponsor.ListLeadsResponse>({ method: "GET", path: `${BASE}/leads` }),
    getLead: (id) => api.request<sponsor.SponsorLead>({ method: "GET", path: lead(id) }),
    createLead: (body) => api.request<sponsor.SponsorLead, sponsor.CreateLeadRequest>({ method: "POST", path: `${BASE}/leads`, body }),
    importLeads: (body) =>
      api.request<sponsor.ImportLeadsResponse, sponsor.ImportLeadsRequest>({ method: "POST", path: `${BASE}/leads/import`, body }),
    updateLead: (id, body) => api.request<sponsor.SponsorLead, sponsor.UpdateLeadRequest>({ method: "PATCH", path: lead(id), body }),
    removeLead: async (id) => {
      await api.request<void>({ method: "DELETE", path: lead(id) });
    },
    listGoals: () => api.request<sponsor.ListGoalsResponse>({ method: "GET", path: `${BASE}/goals` }),
    putGoal: (month, body) => api.request<sponsor.MonthlyGoal, sponsor.PutGoalRequest>({ method: "PUT", path: `${BASE}/goals/${enc(month)}`, body }),
  };
}
