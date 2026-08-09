// Feature-level context. In production FE2 supplies these via its shell; here the
// standalone dev harness (and tests) inject a ResourceClient + MeResponse.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { gateway } from "@dub/types";
import type { ResourceClient } from "../shell/contract";
import { createRosterApi, type RosterApi } from "../api/rosterApi";

export interface RosterContextValue {
  api: RosterApi;
  me: gateway.MeResponse | null; // null while loading -> fail-closed guards
}

const RosterContext = createContext<RosterContextValue | null>(null);

export interface RosterProviderProps {
  client: ResourceClient;
  me: gateway.MeResponse | null;
  children: ReactNode;
}

export function RosterProvider({ client, me, children }: RosterProviderProps) {
  const value = useMemo<RosterContextValue>(() => ({ api: createRosterApi(client), me }), [client, me]);
  return <RosterContext.Provider value={value}>{children}</RosterContext.Provider>;
}

export function useRosterContext(): RosterContextValue {
  const ctx = useContext(RosterContext);
  if (!ctx) throw new Error("useRosterContext must be used within <RosterProvider>");
  return ctx;
}
