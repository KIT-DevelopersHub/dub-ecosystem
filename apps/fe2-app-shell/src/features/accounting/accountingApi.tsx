// 会計 feature の api アダプタ。/api/v1/members/accounting/{issuer,privacy-policy} → gateway → member-service。契約型は @dub/types `accounting`。
import type { accounting } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

export interface AccountingApi {
  getIssuer(): Promise<accounting.GetIssuerResponse>;
  putIssuer(body: accounting.PutIssuerRequest): Promise<accounting.PutIssuerResponse>;
  getPrivacyPolicy(): Promise<accounting.GetPrivacyPolicyResponse>;
  putPrivacyPolicy(body: accounting.PutPrivacyPolicyRequest): Promise<accounting.PutPrivacyPolicyResponse>;
}

const ISSUER = "/api/v1/members/accounting/issuer";
const PRIVACY_POLICY = "/api/v1/members/accounting/privacy-policy";

export function createAccountingApi(api: ApiClient): AccountingApi {
  return {
    getIssuer: () => api.request<accounting.GetIssuerResponse>({ method: "GET", path: ISSUER }),
    putIssuer: (body) => api.request<accounting.PutIssuerResponse, accounting.PutIssuerRequest>({ method: "PUT", path: ISSUER, body }),
    getPrivacyPolicy: () => api.request<accounting.GetPrivacyPolicyResponse>({ method: "GET", path: PRIVACY_POLICY }),
    putPrivacyPolicy: (body) =>
      api.request<accounting.PutPrivacyPolicyResponse, accounting.PutPrivacyPolicyRequest>({ method: "PUT", path: PRIVACY_POLICY, body }),
  };
}
