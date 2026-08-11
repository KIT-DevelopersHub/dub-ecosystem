// Usage runtime provider (mirrors features/mail/MailProvider.tsx). Builds the
// UsageApi from the ONE shell api-client and exposes it via context, so the usage
// screens read a live, session-wired client. Shaped { api, children } so the
// shell's providerWrapper() mounts it like every other feature Provider.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createUsageApi, type UsageApi } from "./usageApi.tsx";

const UsageApiCtx = createContext<UsageApi | null>(null);

export function UsageProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const usageApi = useMemo(() => createUsageApi(api), [api]);
  return <UsageApiCtx.Provider value={usageApi}>{children}</UsageApiCtx.Provider>;
}

/** Test-friendly provider that injects a UsageApi directly (no ApiClient needed). */
export function UsageApiProvider({ value, children }: { value: UsageApi; children: ReactNode }): JSX.Element {
  return <UsageApiCtx.Provider value={value}>{children}</UsageApiCtx.Provider>;
}

export function useUsageApi(): UsageApi {
  const ctx = useContext(UsageApiCtx);
  if (!ctx) throw new Error("useUsageApi must be used within <UsageProvider>");
  return ctx;
}
