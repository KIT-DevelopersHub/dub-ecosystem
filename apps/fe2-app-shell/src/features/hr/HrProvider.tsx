// 人事 runtime provider (LpProvider と同じ形)。シェルの api-client 1本から HrApi を作って配る。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createHrApi, type HrApi } from "./hrApi.tsx";

const HrApiCtx = createContext<HrApi | null>(null);

export function HrProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const value = useMemo(() => createHrApi(api), [api]);
  return <HrApiCtx.Provider value={value}>{children}</HrApiCtx.Provider>;
}

/** テスト用: HrApi を直接注入する。 */
export function HrApiProvider({ value, children }: { value: HrApi; children: ReactNode }): JSX.Element {
  return <HrApiCtx.Provider value={value}>{children}</HrApiCtx.Provider>;
}

export function useHrApi(): HrApi {
  const ctx = useContext(HrApiCtx);
  if (!ctx) throw new Error("useHrApi must be used within <HrProvider>");
  return ctx;
}
