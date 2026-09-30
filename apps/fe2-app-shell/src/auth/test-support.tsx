// TEST/HARNESS ONLY — a stand-in <AuthProvider> for rendering ONE feature screen in
// isolation (jsdom component tests, the dev harness). Not imported by production code.
//
// Why it exists: write affordances are gated on the policy layer's capability flags
// (useAppCapability), which read the auth context. A feature test that renders just its
// screen therefore needs a subject. Passing the PERMISSION KEYS (not the flags) keeps the
// test honest: it exercises the real derivation in @dub/types `policy`, so a test can't
// accidentally assert against a hand-made capability that production would never produce.
import { useMemo } from "react";
import type { ReactNode } from "react";
import type { gateway, identity } from "@dub/types";
import { policy } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider } from "./AuthProvider.tsx";

/** A MeResponse for `permissions`, with the derived per-app level map the gateway sends. */
export function fakeMe(permissions: readonly identity.PermissionKey[]): gateway.MeResponse {
  return {
    user: { id: "usr_test", displayName: "Test User", avatarUrl: null },
    orgId: "org_devhub",
    permissions: [...permissions],
    appAccess: policy.appAccessMap(permissions),
    sessionExpiresAt: Date.now() + 3_600_000,
  };
}

/**
 * Wraps `children` in an AuthProvider resolved from `permissions`. Must sit INSIDE a
 * QueryClientProvider (AuthProvider fetches /me through react-query, same as production).
 */
export function FakeAuthProvider({
  permissions,
  children,
}: {
  permissions: readonly identity.PermissionKey[];
  children: ReactNode;
}): JSX.Element {
  const api = useMemo(() => {
    const me = fakeMe(permissions);
    return { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
  }, [permissions]);
  return <AuthProvider api={api}>{children}</AuthProvider>;
}

/** The keys a 編集 subject holds for one app (+ any extra domain keys). */
export function editorPermissions(
  appId: string,
  extra: readonly identity.PermissionKey[] = [],
): identity.PermissionKey[] {
  return [...policy.keysForAppLevel(appId, policy.AppAccessLevel.Edit), ...extra];
}

/** The keys a 閲覧 subject holds for one app (+ any extra domain keys). */
export function viewerPermissions(
  appId: string,
  extra: readonly identity.PermissionKey[] = [],
): identity.PermissionKey[] {
  return [...policy.keysForAppLevel(appId, policy.AppAccessLevel.View), ...extra];
}
