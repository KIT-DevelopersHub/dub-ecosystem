// Members runtime provider (mirrors mail's MailProvider). Builds the MembersApi from
// the ONE shell api-client and exposes it via context, so the members screens read a
// live, session-wired client. Shaped as { api, children } for providerWrapper().
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createMembersApi, type MembersApi } from "./membersApi.tsx";

const MembersApiCtx = createContext<MembersApi | null>(null);

export function MembersProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const membersApi = useMemo(() => createMembersApi(api), [api]);
  return <MembersApiCtx.Provider value={membersApi}>{children}</MembersApiCtx.Provider>;
}

/** Test-friendly provider that injects a MembersApi directly (no ApiClient needed). */
export function MembersApiProvider({ value, children }: { value: MembersApi; children: ReactNode }): JSX.Element {
  return <MembersApiCtx.Provider value={value}>{children}</MembersApiCtx.Provider>;
}

export function useMembersApi(): MembersApi {
  const ctx = useContext(MembersApiCtx);
  if (!ctx) throw new Error("useMembersApi must be used within <MembersProvider>");
  return ctx;
}
