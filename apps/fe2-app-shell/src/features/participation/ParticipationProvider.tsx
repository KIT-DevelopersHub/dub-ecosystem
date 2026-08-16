// 参加届 runtime provider (mirrors MembersProvider). Builds the ParticipationApi from
// the ONE shell api-client and exposes it via context. Shaped { api, children } for
// providerWrapper().
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createParticipationApi, type ParticipationApi } from "./participationApi.tsx";

const ParticipationApiCtx = createContext<ParticipationApi | null>(null);

export function ParticipationProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const value = useMemo(() => createParticipationApi(api), [api]);
  return <ParticipationApiCtx.Provider value={value}>{children}</ParticipationApiCtx.Provider>;
}

/** Test-friendly provider that injects a ParticipationApi directly. */
export function ParticipationApiProvider({ value, children }: { value: ParticipationApi; children: ReactNode }): JSX.Element {
  return <ParticipationApiCtx.Provider value={value}>{children}</ParticipationApiCtx.Provider>;
}

export function useParticipationApi(): ParticipationApi {
  const ctx = useContext(ParticipationApiCtx);
  if (!ctx) throw new Error("useParticipationApi must be used within <ParticipationProvider>");
  return ctx;
}
