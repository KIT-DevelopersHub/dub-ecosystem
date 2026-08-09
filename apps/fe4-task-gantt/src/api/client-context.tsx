import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "../contracts/spa-shell";

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): ApiClient {
  const c = useContext(ApiClientContext);
  if (!c) throw new Error("ApiClientProvider missing");
  return c;
}
