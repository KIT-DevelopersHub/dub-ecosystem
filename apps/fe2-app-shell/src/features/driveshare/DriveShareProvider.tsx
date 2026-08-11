// DriveShare runtime provider (mirrors MailProvider). Builds the DriveShareApi from
// the ONE shell api-client and exposes it via context so the screens read a live,
// session-wired client. Shaped as { api, children } so the shell's providerWrapper()
// can mount it like every other feature Provider.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createDriveShareApi, type DriveShareApi } from "./driveShareApi.tsx";

const DriveShareApiCtx = createContext<DriveShareApi | null>(null);

export function DriveShareProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const driveApi = useMemo(() => createDriveShareApi(api), [api]);
  return <DriveShareApiCtx.Provider value={driveApi}>{children}</DriveShareApiCtx.Provider>;
}

/** Test-friendly provider that injects a DriveShareApi directly (no ApiClient needed). */
export function DriveShareApiProvider({ value, children }: { value: DriveShareApi; children: ReactNode }): JSX.Element {
  return <DriveShareApiCtx.Provider value={value}>{children}</DriveShareApiCtx.Provider>;
}

export function useDriveShareApi(): DriveShareApi {
  const ctx = useContext(DriveShareApiCtx);
  if (!ctx) throw new Error("useDriveShareApi must be used within <DriveShareProvider>");
  return ctx;
}
