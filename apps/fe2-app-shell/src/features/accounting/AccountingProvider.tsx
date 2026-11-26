// 会計 runtime provider。シェルの api-client 1 本から AccountingApi を作って配る。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createAccountingApi, type AccountingApi } from "./accountingApi.tsx";

const Ctx = createContext<AccountingApi | null>(null);

export function AccountingProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const value = useMemo(() => createAccountingApi(api), [api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** テスト用: AccountingApi を直接注入する。 */
export function AccountingApiProvider({ value, children }: { value: AccountingApi; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccountingApi(): AccountingApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAccountingApi must be used within <AccountingProvider>");
  return ctx;
}
