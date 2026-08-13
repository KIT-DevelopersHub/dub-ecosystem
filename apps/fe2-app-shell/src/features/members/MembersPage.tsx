// 運営メンバー管理 top screen. Hosts the three views (一覧 / チーム別 / 組織図) behind
// Tabs, plus the toolbar (search, メンバー追加 / チーム追加 / 印刷) and the shared
// create/edit dialogs + destructive ConfirmDialog. Read = identity:read (route gate);
// write actions are re-authorized server-side (identity:admin).
import { useMemo, useState } from "react";
import {
  PageHeader,
  Button,
  Tabs,
  TextField,
  ConfirmDialog,
  SkeletonLoader,
  ErrorState,
} from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useMembersOverview, useDeleteMember, useDeleteTeam } from "./hooks.ts";
import { ListView } from "./ListView.tsx";
import { TeamsView } from "./TeamsView.tsx";
import { OrgChartView } from "./OrgChartView.tsx";
import { MemberFormDialog } from "./MemberFormDialog.tsx";
import { TeamFormDialog } from "./TeamFormDialog.tsx";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import styles from "./members.module.css";

type TabId = "list" | "teams" | "org";

export function MembersPage(): JSX.Element {
  const overview = useMembersOverview();
  const deleteMember = useDeleteMember();
  const deleteTeam = useDeleteTeam();

  const [tab, setTab] = useState<TabId>("list");
  const [search, setSearch] = useState("");
  const [memberDialog, setMemberDialog] = useState<{ open: boolean; editing: OrgMember | null }>({ open: false, editing: null });
  const [teamDialog, setTeamDialog] = useState<{ open: boolean; editing: MemberTeam | null }>({ open: false, editing: null });
  const [confirm, setConfirm] = useState<
    | { kind: "member"; target: OrgMember }
    | { kind: "team"; target: MemberTeam }
    | null
  >(null);

  const teams = overview.data?.teams ?? [];
  const members = overview.data?.members ?? [];
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) => m.name.toLowerCase().includes(q) || (m.roleTitle ?? "").toLowerCase().includes(q),
    );
  }, [members, search]);

  const openAddMember = () => setMemberDialog({ open: true, editing: null });
  const openEditMember = (m: OrgMember) => setMemberDialog({ open: true, editing: m });
  const openAddTeam = () => setTeamDialog({ open: true, editing: null });
  const openEditTeam = (t: MemberTeam) => setTeamDialog({ open: true, editing: t });

  const confirmDelete = () => {
    if (!confirm) return;
    if (confirm.kind === "member") deleteMember.mutate(confirm.target.id);
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
          actions={
            <span style={{ display: "inline-flex", gap: "var(--dub-space-2)" }}>
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
              { id: "list", label: "一覧" },
              { id: "teams", label: "チーム別" },
              { id: "org", label: "組織図" },
            ]}
            activeId={tab}
            onChange={(id) => setTab(id as TabId)}
            testId="members-tabs"
          />
          <div className={styles.toolbarSpacer} />
          {tab === "list" ? (
            <div className={styles.searchField}>
              <TextField id="members-search" value={search} onChange={setSearch} placeholder="氏名・役割で検索" testId="members-search" />
            </div>
          ) : null}
          {tab === "org" ? (
            <Button variant="secondary" onClick={() => window.print()} testId="members-print">
              印刷 / PNG
            </Button>
          ) : null}
        </div>
      </div>

      {tab === "list" ? (
        <ListView members={filteredMembers} teamsById={teamsById} onEdit={openEditMember} onDelete={(m) => setConfirm({ kind: "member", target: m })} />
      ) : null}
      {tab === "teams" ? (
        <TeamsView
          teams={teams}
          members={members}
          onEditMember={openEditMember}
          onDeleteMember={(m) => setConfirm({ kind: "member", target: m })}
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
            : `「${confirm?.target.name ?? ""}」を削除します。よろしいですか？`
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
