// Mail runtime provider (mirrors composition/moduleProviders.tsx). Builds the
// MailApi from the ONE shell api-client and exposes it via context so the mail
// screens read a live, session-wired client. Shaped as { api, children } so the
// shell's providerWrapper() can mount it like every other feature Provider.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { mail } from "@dub/types";
import { useOptionalCanEdit } from "../../auth/AuthProvider.tsx";
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

const ViewingCtx = createContext<mail.MailManagedMailbox | null>(null);

/** #942: the managed member whose mailbox is on screen (null = the signed-in user's own). */
export function MailViewingProvider({ value, children }: { value: mail.MailManagedMailbox | null; children: ReactNode }): JSX.Element {
  return <ViewingCtx.Provider value={value}>{children}</ViewingCtx.Provider>;
}

export function useMailViewing(): mail.MailManagedMailbox | null {
  return useContext(ViewingCtx);
}

/** May this viewer write mail? The gateway requires メール編集 + mail:send on every compose
 *  route, so a read-only viewer must not be offered one. Default true outside the shell. */
export function useCanCompose(): boolean {
  const viewing = useMailViewing();
  const canEdit = useOptionalCanEdit("mail", "mail:send") ?? true;
  // Another member's mailbox is read-only: never compose / reply as them.
  return viewing === null && canEdit;
}

/** Like useMailApi, but null outside a provider — for best-effort decorations (sender icons). */
export function useOptionalMailApi(): MailApi | null {
  return useContext(MailApiCtx);
}
