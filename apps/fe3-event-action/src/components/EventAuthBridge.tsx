// EventAuthBridge — syncs the shell's authenticated session into FE3's local auth
// store so event-scoped permission gating (EventContext.derivePermissions) matches
// the shell. Without it, the shell mounts FE3 pages but never populates FE3's
// zustand auth store, so `me` stays null and every write control (編集 / 設定 /
// phase transitions / action add) fails closed and is hidden — even for admins.
// The standalone dev harness (main.tsx) sets the store itself; the shell renders
// this bridge inside EventProviders instead. Server remains the real enforcer.
import { useEffect } from "react";
import type { gateway } from "@dub/types";
import { useAuthStore } from "../contracts/fe2";

export interface EventAuthBridgeProps {
  /** The shell's authenticated user, or null while loading / unauthenticated. */
  me: gateway.MeResponse | null;
  /** True while the shell's /me is still loading (fail-closed until resolved). */
  loading: boolean;
}

export function EventAuthBridge({ me, loading }: EventAuthBridgeProps): null {
  useEffect(() => {
    const store = useAuthStore.getState();
    if (loading) store.setLoading(true);
    else store.setMe(me); // setMe also clears loading
  }, [me, loading]);
  return null;
}
