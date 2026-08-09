import { useState } from "react";
import type { identity } from "@dub/types";
import { PageHeader, Card, Tabs, Button, TextField, ConfirmDialog, ErrorState, EmptyState, FormField } from "@dub/ui";
import { UserStatusBadge } from "./UserStatusBadge";
import { RoleAssignmentList } from "./RoleAssignmentList";
import { RoleAssignDialog } from "./RoleAssignDialog";
import { useUser, usePatchUser } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { presentError, errorMessage, displayError } from "../lib/errorDisplay";

// P0 event candidates are fetched via event-service; here we accept them as a prop
// (wired by the shell / mock). Empty = org-wide only.
export function UserDetailPage({
  userId,
  currentUserId,
  events = [],
}: {
  userId: string;
  currentUserId: string;
  events?: { id: string; name: string }[];
}) {
  const user = useUser(userId);
  const patch = usePatchUser(userId);
  const { can } = usePermissions();
  const { toast } = useToast();
  const [tab, setTab] = useState("roles");
  const [assignOpen, setAssignOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [githubLogin, setGithubLogin] = useState("");
  const [statusConfirm, setStatusConfirm] = useState<identity.UserStatus | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const canAdmin = can("identity:admin");

  if (user.isError) {
    const p = presentError(user.error);
    if (p.kind === "empty") return <EmptyState title={p.message} testId="fe7-user-notfound" />;
    return <ErrorState error={displayError(user.error)} onRetry={() => user.refetch()} testId="fe7-user-error" />;
  }
  if (!user.data) return <p>読み込み中…</p>;

  if (!hydrated) {
    setDisplayName(user.data.displayName);
    setGithubLogin(user.data.githubLogin ?? "");
    setHydrated(true);
  }

  const nextStatus: identity.UserStatus = user.data.status === "active" ? "disabled" : "active";

  function saveProfile() {
    patch.mutate(
      { displayName: displayName.trim(), githubLogin: githubLogin.trim() || null },
      { onSuccess: () => toast({ kind: "success", title: "プロフィールを更新しました" }) },
    );
  }

  function applyStatus() {
    if (!statusConfirm) return;
    patch.mutate({ status: statusConfirm }, {
      onSuccess: () => toast({ kind: "success", title: "在籍状態を変更しました" }),
      onError: (err) => toast({ kind: "error", title: "変更に失敗しました", description: errorMessage(err) }),
    });
    setStatusConfirm(null);
  }

  return (
    <div>
      <PageHeader
        title={user.data.displayName}
        testId="fe7-user-header"
        actions={<UserStatusBadge status={user.data.status} testId="fe7-user-status" />}
      />

      <Card testId="fe7-user-profile">
        <FormField label="表示名" htmlFor="fe7-user-displayName">
          <TextField id="fe7-user-displayName" value={displayName} onChange={(v) => setDisplayName(v)} disabled={!canAdmin} testId="fe7-user-displayName" />
        </FormField>
        <FormField label="GitHub Login" htmlFor="fe7-user-github">
          <TextField id="fe7-user-github" value={githubLogin} onChange={(v) => setGithubLogin(v)} disabled={!canAdmin} testId="fe7-user-github" />
        </FormField>
        {canAdmin ? (
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" onClick={saveProfile} disabled={patch.isPending} testId="fe7-user-save">保存</Button>
            <Button variant={nextStatus === "disabled" ? "danger" : "secondary"} onClick={() => setStatusConfirm(nextStatus)} testId="fe7-user-status-toggle">
              {nextStatus === "disabled" ? "利用停止" : "在籍に戻す"}
            </Button>
          </div>
        ) : null}
      </Card>

      <Tabs
        items={[{ id: "roles", label: "ロール割当" }, { id: "org", label: "組織所属" }]}
        activeId={tab}
        onChange={setTab}
        testId="fe7-user-tabs"
      />

      {tab === "roles" ? (
        <div>
          {canAdmin ? (
            <Button variant="primary" onClick={() => setAssignOpen(true)} testId="fe7-user-assign-open">ロールを付与</Button>
          ) : null}
          <RoleAssignmentList userId={userId} />
        </div>
      ) : (
        <Card>組織: {user.data.orgId}</Card>
      )}

      <RoleAssignDialog open={assignOpen} userId={userId} grantedBy={currentUserId} events={events} onClose={() => setAssignOpen(false)} />

      <ConfirmDialog
        title="在籍状態を変更"
        message={
          statusConfirm === "disabled"
            ? "このユーザーを利用停止にします。自分自身や組織内で最後の管理者の場合はサーバ側で拒否されます。"
            : "このユーザーを在籍状態に戻します。"
        }
        open={statusConfirm !== null}
        danger={statusConfirm === "disabled"}
        confirmLabel="変更する"
        onConfirm={applyStatus}
        onCancel={() => setStatusConfirm(null)}
        testId="fe7-user-status-confirm"
      />
    </div>
  );
}
