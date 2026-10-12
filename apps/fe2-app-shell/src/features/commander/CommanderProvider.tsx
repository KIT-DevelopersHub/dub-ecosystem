// Hands the shell's session-wired api-client to the Commander screen, which needs it for one
// call: minting the relay ticket (POST /api/v1/commander/relay/ticket).
import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";

const CommanderApiCtx = createContext<ApiClient | null>(null);

export function CommanderProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  return <CommanderApiCtx.Provider value={api}>{children}</CommanderApiCtx.Provider>;
}

export function useCommanderShellApi(): ApiClient | null {
  return useContext(CommanderApiCtx);
}
