import type { ReactNode } from "react";
import type { identity } from "@dub/types";
import { usePermissions } from "../hooks/usePermissions";
import { EmptyState } from "../ui/primitives";

// UI guard: hides the route body behind a 403 when the effective permissions do
// not satisfy requiredPermissions. Fail-closed while me is loading. Server-side
// authz remains the real boundary (design §6).
export function RouteGuard({
  requiredPermissions,
  children,
}: {
  requiredPermissions: readonly identity.PermissionKey[];
  children: ReactNode;
}) {
  const { canAll, ready } = usePermissions();
  if (!ready) return <p data-testid="fe7-guard-loading">読み込み中…</p>;
  if (!canAll(requiredPermissions)) {
    return <EmptyState message="このページを表示する権限がありません（403）" testId="fe7-guard-403" />;
  }
  return <>{children}</>;
}
