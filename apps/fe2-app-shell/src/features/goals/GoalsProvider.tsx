// 目標管理 runtime provider。シェルの api-client 1 本から GoalsApi を作って配る。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createGoalsApi, type GoalsApi } from "./goalsApi.tsx";

const Ctx = createContext<GoalsApi | null>(null);

export function GoalsProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const value = useMemo(() => createGoalsApi(api), [api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** テスト用: GoalsApi を直接注入する。 */
export function GoalsApiProvider({ value, children }: { value: GoalsApi; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGoalsApi(): GoalsApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGoalsApi must be used within <GoalsProvider>");
  return ctx;
}
