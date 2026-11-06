// スポンサー runtime provider (HrProvider と同じ形)。シェルの api-client 1本から SponsorApi を作って配る。
// 送信待ちの写真 (pendingStore) は api-client 単位で持つ = ルートを移っても消えない。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createSponsorApi, type SponsorApi } from "./sponsorApi.tsx";
import { pendingStoreFor, type PendingStore } from "./pendingStore.ts";

interface SponsorCtx {
  api: SponsorApi;
  pending: PendingStore;
}

const Ctx = createContext<SponsorCtx | null>(null);

export function SponsorProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const value = useMemo(() => ({ api: createSponsorApi(api), pending: pendingStoreFor(api) }), [api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** テスト用: SponsorApi を直接注入する。 */
export function SponsorApiProvider({ value, children }: { value: SponsorApi; children: ReactNode }): JSX.Element {
  const ctx = useMemo(() => ({ api: value, pending: pendingStoreFor(value) }), [value]);
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

function useCtx(): SponsorCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSponsorApi must be used within <SponsorProvider>");
  return ctx;
}

export function useSponsorApi(): SponsorApi {
  return useCtx().api;
}

/** Provider の外 (メール画面の飾り) では null。 */
export function useOptionalSponsorApi(): SponsorApi | null {
  return useContext(Ctx)?.api ?? null;
}

export function useSponsorPending(): PendingStore {
  return useCtx().pending;
}
