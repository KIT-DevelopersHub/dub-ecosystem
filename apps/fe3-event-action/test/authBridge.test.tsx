import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { gateway } from "@dub/types";
import { EventAuthBridge } from "../src/components/EventAuthBridge";
import { useAuthStore } from "../src/contracts/fe2";
import { derivePermissions } from "../src/lib/permissions";

const ADMIN_ME: gateway.MeResponse = {
  user: { id: "usr_admin", displayName: "管理者", avatarUrl: null },
  orgId: "org_devhub",
  permissions: ["event:read", "event:write", "event:admin"],
  sessionExpiresAt: Date.now() + 60_000,
};

describe("EventAuthBridge — shell session sync (regression: shell write UI fail-closed)", () => {
  beforeEach(() => useAuthStore.setState({ me: null, loading: true }));

  it("bridges the shell's authenticated session so write permission is derived (not fail-closed)", () => {
    // Before the bridge mounts, FE3's store is fail-closed → no write.
    expect(derivePermissions(useAuthStore.getState().me, useAuthStore.getState().loading).write).toBe(false);

    render(<EventAuthBridge me={ADMIN_ME} loading={false} />);

    const s = useAuthStore.getState();
    expect(s.loading).toBe(false);
    expect(s.me).toEqual(ADMIN_ME);
    expect(derivePermissions(s.me, s.loading).write).toBe(true);
    expect(derivePermissions(s.me, s.loading).admin).toBe(true);
  });

  it("keeps fail-closed while the shell session is still loading", () => {
    render(<EventAuthBridge me={null} loading={true} />);
    const s = useAuthStore.getState();
    expect(s.loading).toBe(true);
    expect(derivePermissions(s.me, s.loading).write).toBe(false);
  });
});
