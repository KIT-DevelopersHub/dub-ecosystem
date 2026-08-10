// Mail runtime provider (mirrors composition/moduleProviders.tsx). Builds the
// MailApi from the ONE shell api-client and exposes it via context so the mail
// screens read a live, session-wired client. Shaped as { api, children } so the
// shell's providerWrapper() can mount it like every other feature Provider.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createMailApi, type MailApi } from "./mailApi.tsx";

const MailApiCtx = createContext<MailApi | null>(null);

export function MailProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const mailApi = useMemo(() => createMailApi(api), [api]);
  return <MailApiCtx.Provider value={mailApi}>{children}</MailApiCtx.Provider>;
}

/** Test-friendly provider that injects a MailApi directly (no ApiClient needed). */
export function MailApiProvider({ value, children }: { value: MailApi; children: ReactNode }): JSX.Element {
  return <MailApiCtx.Provider value={value}>{children}</MailApiCtx.Provider>;
}

export function useMailApi(): MailApi {
  const ctx = useContext(MailApiCtx);
  if (!ctx) throw new Error("useMailApi must be used within <MailProvider>");
  return ctx;
}
