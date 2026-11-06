// The header's account label next to the DevHub brand. Three shapes:
//   - ordinary member: the plain email (unchanged)
//   - holder of identity:impersonate: the email becomes a SEARCHABLE dropdown of members
//     (name + email); choosing one opens the same confirm dialog as the roster pane and
//     starts 「このメンバーとして表示」. Ineligible members stay listed, disabled, with the
//     reason — the shared rule (@dub/types auth.impersonationRefusal), same as the server.
//   - while impersonating: the SUBJECT, with a menu offering 「自分に戻る」 (the banner stays).
// Members come from the roster's existing identity list (GET /identity/users + /roles),
// loaded only when the dropdown is first opened.
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Menu, useToast } from "@dub/ui";
import { ImpersonateConfirmDialog, SearchableMenu, type SearchableMenuItem } from "@dub/app-ui";
import { auth as authRules, type common, type identity } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { ApiError } from "../lib/api-client.tsx";
import { useAuth, usePermissions } from "../auth/AuthProvider.tsx";

const PAGE_LIMIT = 200;
const MAX_PAGES = 5;
const MINUTES = Math.round(authRules.IMPERSONATION_DEFAULT_TTL_SEC / 60);

type Api = Pick<ApiClient, "auth" | "identity">;

function defaultReload(path: string): void {
  window.location.assign(path);
}

async function loadMembers(api: Api): Promise<identity.IdentityUser[]> {
  const out: identity.IdentityUser[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await api.identity.get<common.Paginated<identity.IdentityUser>>("/users", {
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

const STATUS_ORDER: Record<string, number> = { active: 0, invited: 1, disabled: 2, rejected: 3 };

/** Roster users → menu items, eligibility applied (active first, then name). Exported for tests. */
export function toSwitcherItems(
  users: readonly identity.IdentityUser[],
  roles: readonly identity.Role[],
  actorId: string,
): SearchableMenuItem[] {
  const holders = new Set(roles.filter((r) => r.permissions.includes(authRules.IMPERSONATE_PERMISSION)).map((r) => r.id));
  return [...users]
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.displayName.localeCompare(b.displayName, "ja"))
    .map((u) => {
      const refusal = authRules.impersonationRefusal({
        actorId,
        target: { id: u.id, status: u.status, roleIds: u.roleIds, holdsImpersonate: u.roleIds.some((r) => holders.has(r)) },
      });
      return {
        id: u.id,
        label: u.displayName,
        description: u.email,
        ...(refusal ? { disabledReason: authRules.IMPERSONATION_REFUSAL_LABEL[refusal] } : {}),
        testId: `fe2-impersonate-option-${u.id}`,
      };
    });
}

function refusalMessage(err: unknown): string {
  const reason = err instanceof ApiError ? (err.details as { reason?: string } | undefined)?.reason : undefined;
  if (reason && reason in authRules.IMPERSONATION_REFUSAL_LABEL) {
    return authRules.IMPERSONATION_REFUSAL_LABEL[reason as authRules.ImpersonationRefusal];
  }
  return err instanceof Error ? err.message : "時間をおいて再試行してください";
}

export function HeaderAccountSwitcher({
  api,
  email,
  reload = defaultReload,
}: {
  api: Api;
  /** The (already truncated) email shown today. */
  email: string;
  reload?: (path: string) => void;
}): JSX.Element {
  const state = useAuth();
  const { can } = usePermissions();
  const toast = useToast();
  const me = state.status === "authenticated" ? state.me : null;
  const impersonation = me?.impersonation ?? null;
  const canImpersonate = can(authRules.IMPERSONATE_PERMISSION) && !impersonation;
  const [opened, setOpened] = useState(false);
  const [target, setTarget] = useState<SearchableMenuItem | null>(null);

  const users = useQuery({
    queryKey: ["header-switcher", "users"],
    queryFn: () => loadMembers(api),
    enabled: canImpersonate && opened,
    staleTime: 60_000,
  });
  const roles = useQuery({
    queryKey: ["header-switcher", "roles"],
    queryFn: () => api.identity.get<common.Paginated<identity.Role>>("/roles", { limit: PAGE_LIMIT }),
    enabled: canImpersonate && opened,
    staleTime: 60_000,
  });
  const items = useMemo(
    () => (users.data && roles.data && me ? toSwitcherItems(users.data, roles.data.items, me.user.id) : []),
    [users.data, roles.data, me],
  );

  const returnToSelf = useCallback(async () => {
    try {
      await api.auth.stopImpersonation();
    } catch {
      // already ended / own session died: the reload shows whatever the cookie now is
    }
    reload("/");
  }, [api, reload]);

  const start = useCallback(async () => {
    if (!target) return;
    try {
      await api.auth.startImpersonation(target.id);
      setTarget(null);
      reload("/");
    } catch (err) {
      setTarget(null);
      toast.show({ kind: "error", title: "代理表示を開始できませんでした", description: refusalMessage(err) });
    }
  }, [api, reload, target, toast]);

  const plain = (
    <span className="fe2-brandline-account" data-testid="fe2-header-account" title={email}>
      {email}
    </span>
  );

  if (!me) return plain;

  if (impersonation) {
    return (
      <Menu
        testId="fe2-header-impersonating"
        label={`${me.user.displayName}（代理表示中）`}
        menuLabel="代理表示"
        align="start"
        items={[
          {
            id: "return",
            label: `自分に戻る（${impersonation.actor.displayName}）`,
            icon: "log-out",
            onSelect: () => void returnToSelf(),
            testId: "fe2-header-impersonation-return",
          },
        ]}
      />
    );
  }

  if (!canImpersonate) return plain;

  return (
    <>
      <SearchableMenu
        testId="fe2-header-switcher"
        label="メンバーとして表示"
        heading="このメンバーとして表示"
        searchPlaceholder="名前・メールで検索"
        emptyText="該当するメンバーがいません"
        trigger={plain}
        items={items}
        loading={opened && (users.isPending || roles.isPending)}
        onOpenChange={(o) => o && setOpened(true)}
        onSelect={setTarget}
      />
      <ImpersonateConfirmDialog
        open={target !== null}
        displayName={target?.label ?? null}
        minutes={MINUTES}
        onConfirm={start}
        onCancel={() => setTarget(null)}
        testId="fe2-header-impersonate-confirm"
      />
    </>
  );
}
