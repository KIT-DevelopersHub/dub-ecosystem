// 運営名簿 — 運営メンバー全員の情報をフラットな一覧（DataTable）で並べる名簿ビュー。
// 「運営メンバー」タブ(/members: チーム別/組織図) がチーム軸・組織図軸の見せ方なのに対し、
// こちらは 1 行 = 1 人で 氏名/ローマ字/学科/学年/役割/ステータス/紐付けアカウント/所属チーム/
// 連絡先/メール を横並びで見渡す「名簿」ビュー。データ源は member-service (useMembersOverview)
// ＋ identity-roster (useIdentityUsers, 紐付けアカウント列のラベル) で、/members と同じ Provider・
// 同じ overview キャッシュを共有する（additive・非破壊）。書き込み(追加/編集/削除/紐付け) は
// 既存ダイアログ・楽観的 mutation を再利用し、サーバ側で identity:admin を再認可する。
import { useMemo, useState } from "react";
import {
  PageHeader,
  Button,
  TextField,
  Select,
  FormField,
  ConfirmDialog,
  SkeletonLoader,
  ErrorState,
} from "@dub/ui";
import type { SelectOption } from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useMembersOverview, useDeleteMember, useIdentityUsers, useUnlinkIdentity } from "./hooks.ts";
import { ListView } from "./ListView.tsx";
import { MemberFormDialog } from "./MemberFormDialog.tsx";
import { LinkIdentityDialog } from "./LinkIdentityDialog.tsx";
import type { OrgMember } from "./contracts.ts";
import { ROSTER_FILTER_OPTIONS, matchesRosterFilter, type RosterStatusFilter } from "./memberStatus.ts";
import { orgChartOrder } from "./orgChartOrder.ts";
import styles from "./members.module.css";

export function MemberRosterPage(): JSX.Element {
  const overview = useMembersOverview();
  const deleteMember = useDeleteMember();
  const identityUsers = useIdentityUsers();
  const unlinkIdentity = useUnlinkIdentity();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RosterStatusFilter>("roster");
  const [memberDialog, setMemberDialog] = useState<{ open: boolean; editing: OrgMember | null }>({ open: false, editing: null });
  const [linkDialog, setLinkDialog] = useState<{ open: boolean; member: OrgMember | null }>({ open: false, member: null });
  const [confirm, setConfirm] = useState<OrgMember | null>(null);

  const teams = overview.data?.teams ?? [];
  const members = overview.data?.members ?? [];
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  // identity userId -> display label for the linked-account column, and the set of
  // accounts already linked to some member (disabled in the link picker; 1:1 link).
  const accountLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of identityUsers.data?.items ?? []) map.set(u.id, u.email || u.displayName);
    return map;
  }, [identityUsers.data]);
  const takenIds = useMemo(
    () => new Set(members.map((m) => m.identityUserId).filter((id): id is string => !!id)),
    [members],
  );

  // リーダー列の表示名解決(leaderId -> 氏名)。
  const leaderNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.id, m.name);
    return map;
  }, [members]);

  // 表示順 = 組織図順(オーガナイザー→各リーダー→配下→残り)。ステータスで絞ってから
  // 並べ替え、最後に検索で絞る(検索は順序を保つ)。既定は「在籍者(辞退以外)」。
  const filteredMembers = useMemo(() => {
    const byStatus = members.filter((m) => matchesRosterFilter(m.status, statusFilter));
    const ordered = orgChartOrder(byStatus);
    const q = search.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        `${m.lastNameKana ?? ""}${m.firstNameKana ?? ""}`.toLowerCase().includes(q) ||
        `${m.lastNameKana ?? ""} ${m.firstNameKana ?? ""}`.toLowerCase().includes(q) ||
        (m.roleTitle ?? "").toLowerCase().includes(q) ||
        (m.department ?? "").toLowerCase().includes(q) ||
        (m.grade ?? "").toLowerCase().includes(q),
    );
  }, [members, search, statusFilter]);

  const STATUS_FILTER_OPTIONS: SelectOption<RosterStatusFilter>[] = ROSTER_FILTER_OPTIONS;

  const openAddMember = () => setMemberDialog({ open: true, editing: null });
  const openEditMember = (m: OrgMember) => setMemberDialog({ open: true, editing: m });

  const confirmDelete = () => {
    if (!confirm) return;
    deleteMember.mutate(confirm.id);
    setConfirm(null);
  };

  if (overview.isLoading) return <SkeletonLoader testId="member-roster-loading" />;
  if (overview.isError) {
    const display = ApiError.isApiError(overview.error)
      ? toDisplayableError(overview.error)
      : { code: "UNKNOWN", message: "読み込みに失敗しました", retryable: true };
    return <ErrorState error={display} onRetry={() => void overview.refetch()} />;
  }

  return (
    <div data-testid="member-roster-page">
      <PageHeader
        title="運営名簿"
        description="運営メンバー全員の情報を一覧で表示します（氏名・役割・所属チーム・メール・紐付けアカウント）"
        actions={
          <Button variant="primary" iconLeft={<span aria-hidden>＋</span>} onClick={openAddMember} testId="member-roster-add-member">
            メンバーを追加
          </Button>
        }
      />

      <div className={styles.toolbar}>
        <div className={styles.searchField}>
          <TextField
            id="member-roster-search"
            value={search}
            onChange={setSearch}
            placeholder="氏名・フリガナ・役割・学科・学年で検索"
            testId="member-roster-search"
          />
        </div>
        <FormField label="状態" htmlFor="member-roster-status-filter">
          <Select<RosterStatusFilter>
            id="member-roster-status-filter"
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_FILTER_OPTIONS}
            testId="member-roster-status-filter"
          />
        </FormField>
      </div>

      <ListView
        members={filteredMembers}
        teamsById={teamsById}
        accountLabels={accountLabels}
        leaderNames={leaderNames}
        onEdit={openEditMember}
        onDelete={(m) => setConfirm(m)}
        onLink={(m) => setLinkDialog({ open: true, member: m })}
        onUnlink={(m) => unlinkIdentity.mutate({ id: m.id, version: m.version })}
      />

      <MemberFormDialog
        open={memberDialog.open}
        onClose={() => setMemberDialog({ open: false, editing: null })}
        teams={teams}
        editing={memberDialog.editing}
        members={members}
      />

      <LinkIdentityDialog
        open={linkDialog.open}
        onClose={() => setLinkDialog({ open: false, member: null })}
        member={linkDialog.member}
        takenIds={takenIds}
      />

      <ConfirmDialog
        open={confirm !== null}
        title="メンバーを削除"
        message={`「${confirm?.name ?? ""}」を削除します。よろしいですか？`}
        danger
        confirmLabel="削除"
        cancelLabel="キャンセル"
        onConfirm={confirmDelete}
        onCancel={() => setConfirm(null)}
        testId="member-roster-confirm-delete"
      />
    </div>
  );
}
