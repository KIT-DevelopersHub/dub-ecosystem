// LP管理 runtime provider (mirrors DriveShareProvider). Builds the LpApi from the ONE
// shell api-client and exposes it via context so the screens read a live, session-wired
// client. Shaped as { api, children } so the shell's providerWrapper() can mount it like
// every other feature Provider.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createLpApi, type LpApi } from "./lpApi.tsx";
import { LpSponsorApiCtx, createLpSponsorApi } from "./lpSponsorApi.tsx";

const LpApiCtx = createContext<LpApi | null>(null);

export function LpProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const lpApi = useMemo(() => createLpApi(api), [api]);
  const sponsorApi = useMemo(() => createLpSponsorApi(api), [api]);
  return (
    <LpApiCtx.Provider value={lpApi}>
      <LpSponsorApiCtx.Provider value={sponsorApi}>{children}</LpSponsorApiCtx.Provider>
    </LpApiCtx.Provider>
  );
}

/** Test-friendly provider that injects an LpApi directly (no ApiClient needed). */
export function LpApiProvider({ value, children }: { value: LpApi; children: ReactNode }): JSX.Element {
  return <LpApiCtx.Provider value={value}>{children}</LpApiCtx.Provider>;
}

export function useLpApi(): LpApi {
  const ctx = useContext(LpApiCtx);
  if (!ctx) throw new Error("useLpApi must be used within <LpProvider>");
  return ctx;
}
