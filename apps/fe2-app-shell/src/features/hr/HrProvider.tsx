// 人事 runtime provider (LpProvider と同じ形)。シェルの api-client 1本から HrApi を作って配る。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createHrApi, type HrApi } from "./hrApi.tsx";
import { InterviewFormProvider } from "./interviewFormApi.tsx";
import { InterviewsProvider } from "./interviewsApi.tsx";

const HrApiCtx = createContext<HrApi | null>(null);

export function HrProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const value = useMemo(() => createHrApi(api), [api]);
  // 面談申し込みフォームの api も同じ api-client から配る (応募者の詳細ドロワーが回答を読む)。
  return (
    <HrApiCtx.Provider value={value}>
      <InterviewFormProvider api={api}>
        <InterviewsProvider api={api}>{children}</InterviewsProvider>
      </InterviewFormProvider>
    </HrApiCtx.Provider>
  );
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
