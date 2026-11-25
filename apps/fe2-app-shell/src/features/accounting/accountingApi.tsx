// 会計 feature の api アダプタ。/api/v1/members/accounting/issuer → gateway → member-service。契約型は @dub/types `accounting`。
import type { accounting } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

export interface AccountingApi {
  getIssuer(): Promise<accounting.GetIssuerResponse>;
  putIssuer(body: accounting.PutIssuerRequest): Promise<accounting.AccountingIssuer>;
}

const ISSUER = "/api/v1/members/accounting/issuer";

export function createAccountingApi(api: ApiClient): AccountingApi {
  return {
    getIssuer: () => api.request<accounting.GetIssuerResponse>({ method: "GET", path: ISSUER }),
    putIssuer: (body) => api.request<accounting.AccountingIssuer, accounting.PutIssuerRequest>({ method: "PUT", path: ISSUER, body }),
  };
}
