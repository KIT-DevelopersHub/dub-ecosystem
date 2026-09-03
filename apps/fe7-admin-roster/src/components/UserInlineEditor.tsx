// Inline user management for a SINGLE user, rendered in place inside the roster
// (design: "1画面で完結"). This is the whole管理surface — 表示名インライン編集 /
// 在籍に戻す・利用停止 / ロール割当 — so admins never navigate to a separate
// per-user screen. The standalone UserDetailPage (deep-link / 補助) reuses this same
// component, keeping behaviour identical.
//
// Mounted only while its row is selected, so seeding local edit state directly from
// props always starts from the freshest saved state (mirrors RolePermissionsEditor).
import { useState } from "react";
import type { identity } from "@dub/types";
import { Button, TextField, ConfirmDialog, FormField, Divider } from "@dub/ui";
import { RoleAssignmentList } from "./RoleAssignmentList";
import { RoleAssignDialog } from "./RoleAssignDialog";
import { UserPasswordSection } from "./UserPasswordSection";
import { usePatchUser, useOffboardUser } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorDisplay";
import type { OffboardOutcome } from "../lib/offboard";

const sectionStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-3)" };
const actionsStyle: React.CSSProperties = { display: "flex", gap: "var(--dub-space-2)", flexWrap: "wrap" };
const metaStyle: React.CSSProperties = { color: "var(--dub-color-text-muted)", fontSize: 13, margin: 0 };
const rolesHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--dub-space-2)",
};
const rolesTitleStyle: React.CSSProperties = { fontWeight: 600, fontSize: "var(--dub-font-size-sm)" };

export function UserInlineEditor({
  user,
  currentUserId,
  events = [],
}: {
  user: identity.IdentityUser;
  currentUserId: string;
  events?: { id: string; name: string }[];
}) {
  const patch = usePatchUser(user.id);
  const offboard = useOffboardUser();
  const { can } = usePermissions();
  const { toast } = useToast();
  const canAdmin = can("identity:admin");

  const [displayName, setDisplayName] = useState(user.displayName);
  const [githubLogin, setGithubLogin] = useState(user.githubLogin ?? "");
  const [statusConfirm, setStatusConfirm] = useState<identity.UserStatus | null>(null);
  const [offboardConfirm, setOffboardConfirm] = useState(false);
  const [outcome, setOutcome] = useState<OffboardOutcome | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);

  // active -> disable; anything else (disabled / invited / rejected) -> reactivate.
  const nextStatus: identity.UserStatus = user.status === "active" ? "disabled" : "active";

  function saveProfile() {
    patch.mutate(
      { displayName: displayName.trim(), githubLogin: githubLogin.trim() || null },
      { onSuccess: () => toast({ kind: "success", title: "プロフィールを更新しました" }) },
    );
  }

  function applyStatus() {
    if (!statusConfirm) return;
    const reactivating = statusConfirm === "active";
    patch.mutate(
      { status: statusConfirm },
      {
        onSuccess: () => toast({ kind: "success", title: reactivating ? "在籍に戻しました" : "利用停止にしました" }),
        onError: (err) => toast({ kind: "error", title: "変更に失敗しました", description: errorMessage(err) }),
      },
    );
    setStatusConfirm(null);
  }

  function runOffboardAction() {
    setOffboardConfirm(false);
    setOutcome(null);
    offboard.mutate(
      { id: user.id, email: user.email },
      { onSuccess: (res) => setOutcome(res) },
    );
  }

  const STEP_LABEL: Record<string, string> = {
    identity: "アカウント（セッション・ロール・利用停止）",
    "member-status": "運営メンバー在籍",
    "email-routing": "Email Routing アドレス",
  };
  const STATUS_MARK: Record<string, string> = { done: "完了", skipped: "対象なし", failed: "失敗" };

  return (
    <div style={sectionStyle} data-testid={`fe7-user-inline-${user.id}`}>
      <FormField label="表示名" htmlFor={`fe7-user-displayName-${user.id}`}>
        <TextField
          id={`fe7-user-displayName-${user.id}`}
          value={displayName}
          onChange={setDisplayName}
          disabled={!canAdmin}
          testId="fe7-user-displayName"
        />
      </FormField>
      <FormField label="GitHub Login" htmlFor={`fe7-user-github-${user.id}`}>
        <TextField
          id={`fe7-user-github-${user.id}`}
          value={githubLogin}
          onChange={setGithubLogin}
          disabled={!canAdmin}
          testId="fe7-user-github"
        />
      </FormField>
      <p style={metaStyle}>メール: {user.email}</p>

      {canAdmin ? (
        <div style={actionsStyle}>
          <Button variant="primary" onClick={saveProfile} disabled={patch.isPending} testId="fe7-user-save">
            保存
          </Button>
          <Button
            variant={nextStatus === "disabled" ? "danger" : "secondary"}
            onClick={() => setStatusConfirm(nextStatus)}
            testId="fe7-user-status-toggle"
          >
            {nextStatus === "disabled" ? "利用停止" : "在籍に戻す"}
          </Button>
          <Button
            variant="danger"
            onClick={() => setOffboardConfirm(true)}
            disabled={offboard.isPending}
            testId="fe7-user-offboard"
          >
            オフボード（退任）
          </Button>
        </div>
      ) : null}

      {outcome ? (
        <div
          style={{
            border: "1px solid var(--dub-color-border-default)",
            borderRadius: "var(--dub-radius-md)",
            padding: "var(--dub-space-3)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
          data-testid="fe7-user-offboard-result"
        >
          <strong style={{ fontSize: 13 }}>
            オフボード結果{outcome.ok ? "" : "（一部失敗）"}
          </strong>
          {outcome.steps.map((st) => (
            <div key={st.step} style={{ display: "flex", justifyContent: "space-between", gap: "var(--dub-space-2)", fontSize: 13 }} data-testid={`fe7-offboard-step-${st.step}`}>
              <span>{STEP_LABEL[st.step] ?? st.step}</span>
              <span style={{ color: st.status === "failed" ? "var(--dub-color-danger-600)" : "var(--dub-color-text-muted)" }}>
                {STATUS_MARK[st.status] ?? st.status}・{st.detail}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <Divider />

      <div style={rolesHeaderStyle}>
        <span style={rolesTitleStyle}>ロール割当</span>
        {canAdmin ? (
          <Button variant="secondary" onClick={() => setAssignOpen(true)} testId="fe7-user-assign-open">
            ロールを付与
          </Button>
        ) : null}
      </div>
      <RoleAssignmentList userId={user.id} />

      {canAdmin ? <UserPasswordSection user={user} /> : null}

      <RoleAssignDialog
        open={assignOpen}
        userId={user.id}
        grantedBy={currentUserId}
        events={events}
        onClose={() => setAssignOpen(false)}
      />
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
      <ConfirmDialog
        title="オフボード（退任）"
        message="このユーザーを1アクションで退任させます: 全セッション失効・全ロール剥奪・利用停止に加え、紐付く運営メンバーを退任状態に更新し、対応する Email Routing アドレスを削除します。最後の管理者はサーバ側で拒否されます。冪等なので再実行しても安全です。"
        open={offboardConfirm}
        danger
        confirmLabel="オフボードする"
        onConfirm={runOffboardAction}
        onCancel={() => setOffboardConfirm(false)}
        testId="fe7-user-offboard-confirm"
      />
    </div>
  );
}
