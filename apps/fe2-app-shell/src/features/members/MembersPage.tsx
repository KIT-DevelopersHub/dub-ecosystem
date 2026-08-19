// 運営メンバー管理 top screen. Hosts the two views (チーム別 / 組織図) behind Tabs,
// plus the toolbar (メンバー追加 / チーム追加 / 印刷) and the shared create/edit dialogs
// + destructive ConfirmDialog. Read = identity:read (route gate); write actions are
// re-authorized server-side (identity:admin).
// NOTE: the flat 一覧 tab was removed — the per-person list (氏名/ロール/アドレス/ログイン
// 紐付け) is owned by the ユーザー名簿 side, which the members app is being merged into.
import { useMemo, useState } from "react";
import {
  PageHeader,
  Button,
  Tabs,
  ConfirmDialog,
  SkeletonLoader,
  ErrorState,
} from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useMembersOverview, useSoftDeleteMember, useRestoreMember, useDeleteTeam } from "./hooks.ts";
import { TeamsView } from "./TeamsView.tsx";
import { OrgChartView } from "./OrgChartView.tsx";
import { MemberFormDialog } from "./MemberFormDialog.tsx";
import { MemberDeleteDialog } from "./MemberDeleteDialog.tsx";
import { TeamFormDialog } from "./TeamFormDialog.tsx";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import styles from "./members.module.css";

type TabId = "teams" | "org";

export function MembersPage(): JSX.Element {
  const overview = useMembersOverview();
  const softDeleteMember = useSoftDeleteMember();
  const restoreMember = useRestoreMember();
  const deleteTeam = useDeleteTeam();

  const [tab, setTab] = useState<TabId>("teams");
  const [memberDialog, setMemberDialog] = useState<{ open: boolean; editing: OrgMember | null }>({ open: false, editing: null });
  const [teamDialog, setTeamDialog] = useState<{ open: boolean; editing: MemberTeam | null }>({ open: false, editing: null });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState<
    | { kind: "member"; target: OrgMember }
    | { kind: "team"; target: MemberTeam }
    | null
  >(null);

  const teams = overview.data?.teams ?? [];
  const members = overview.data?.members ?? [];

  const openAddMember = () => setMemberDialog({ open: true, editing: null });
  const openEditMember = (m: OrgMember) => setMemberDialog({ open: true, editing: m });
  const openAddTeam = () => setTeamDialog({ open: true, editing: null });
  const openEditTeam = (t: MemberTeam) => setTeamDialog({ open: true, editing: t });

  const confirmDelete = () => {
    if (!confirm) return;
    // メンバーは論理削除(削除済み)。チームは従来どおり削除。
    if (confirm.kind === "member") softDeleteMember.mutate({ id: confirm.target.id, version: confirm.target.version });
    else deleteTeam.mutate(confirm.target.id);
    setConfirm(null);
  };

  if (overview.isLoading) return <SkeletonLoader testId="members-loading" />;
  if (overview.isError) {
    const display = ApiError.isApiError(overview.error)
      ? toDisplayableError(overview.error)
      : { code: "UNKNOWN", message: "読み込みに失敗しました", retryable: true };
    return <ErrorState error={display} onRetry={() => void overview.refetch()} />;
  }

  return (
    <div data-testid="members-page">
      <div className={styles.noPrint}>
        <PageHeader
          title="運営メンバー"
          description="運営メンバーの招待状況と所属チームを管理します（組織図PDFの代替）"
          // 並び順は左→右で 破壊的→追加。右端(最も押しやすい)を「メンバーを追加」に。
          // 「メンバーを削除」は破壊的なので左端＋控えめ(secondary・危険色は出さない)。
          actions={
            <span style={{ display: "inline-flex", gap: "var(--dub-space-2)" }}>
              <Button variant="secondary" iconLeft={<span aria-hidden>🗑</span>} onClick={() => setDeleteDialogOpen(true)} testId="members-delete-open">
                メンバーを削除
              </Button>
              <Button variant="secondary" iconLeft={<span aria-hidden>👥</span>} onClick={openAddTeam} testId="members-add-team">
                チームを追加
              </Button>
              <Button variant="primary" iconLeft={<span aria-hidden>＋</span>} onClick={openAddMember} testId="members-add-member">
                メンバーを追加
              </Button>
            </span>
          }
        />

        <div className={styles.toolbar}>
          <Tabs
            items={[
              { id: "teams", label: "チーム別" },
              { id: "org", label: "組織図" },
            ]}
            activeId={tab}
            onChange={(id) => setTab(id as TabId)}
            testId="members-tabs"
          />
          <div className={styles.toolbarSpacer} />
          {tab === "org" ? (
            <Button variant="secondary" onClick={() => window.print()} testId="members-print">
              印刷 / PNG
            </Button>
          ) : null}
        </div>
      </div>

      {tab === "teams" ? (
        <TeamsView
          teams={teams}
          members={members}
          onEditMember={openEditMember}
          onDeleteMember={(m) => setConfirm({ kind: "member", target: m })}
          onRestoreMember={(m) => restoreMember.mutate({ id: m.id, version: m.version })}
          onEditTeam={openEditTeam}
          onDeleteTeam={(t) => setConfirm({ kind: "team", target: t })}
        />
      ) : null}
      {tab === "org" ? <OrgChartView teams={teams} members={members} /> : null}

      <MemberFormDialog
        open={memberDialog.open}
        onClose={() => setMemberDialog({ open: false, editing: null })}
        teams={teams}
        editing={memberDialog.editing}
      />
      <MemberDeleteDialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)} members={members} />
      <TeamFormDialog
        open={teamDialog.open}
        onClose={() => setTeamDialog({ open: false, editing: null })}
        editing={teamDialog.editing}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "team" ? "チームを削除" : "メンバーを削除"}
        message={
          confirm?.kind === "team"
            ? `「${confirm.target.name}」を削除します。メンバーはこのチームから外れます（メンバー自体は残ります）。`
            : `「${confirm?.target.name ?? ""}」を削除します（削除済みになり組織図から外れます）。名簿には残り、あとで在籍に戻せます。`
        }
        danger
        confirmLabel="削除"
        cancelLabel="キャンセル"
        onConfirm={confirmDelete}
        onCancel={() => setConfirm(null)}
        testId="members-confirm-delete"
      />
    </div>
  );
}
