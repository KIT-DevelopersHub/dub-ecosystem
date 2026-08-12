// Gantt feature runtime provider. Like mail/usage, the "ガントチャート" landing is a
// shell-local feature module; its route Component is mounted without props, so it
// receives the one shell api-client through this context (used to read the BFF
// /home aggregate for the event list).
import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";

const Ctx = createContext<ApiClient | null>(null);

export function GanttProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useGanttApi(): ApiClient {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGanttApi must be used within GanttProvider");
  return v;
}
