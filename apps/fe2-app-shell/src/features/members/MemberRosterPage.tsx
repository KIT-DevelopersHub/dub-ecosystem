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
  ConfirmDialog,
  SkeletonLoader,
  ErrorState,
} from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useMembersOverview, useDeleteMember, useIdentityUsers, useUnlinkIdentity } from "./hooks.ts";
import { ListView } from "./ListView.tsx";
import { MemberFormDialog } from "./MemberFormDialog.tsx";
import { LinkIdentityDialog } from "./LinkIdentityDialog.tsx";
import type { OrgMember } from "./contracts.ts";
import styles from "./members.module.css";

export function MemberRosterPage(): JSX.Element {
  const overview = useMembersOverview();
  const deleteMember = useDeleteMember();
  const identityUsers = useIdentityUsers();
  const unlinkIdentity = useUnlinkIdentity();

  const [search, setSearch] = useState("");
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

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.roleTitle ?? "").toLowerCase().includes(q) ||
        (m.department ?? "").toLowerCase().includes(q) ||
        (m.grade ?? "").toLowerCase().includes(q),
    );
  }, [members, search]);

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
            placeholder="氏名・役割・学科・学年で検索"
            testId="member-roster-search"
          />
        </div>
      </div>

      <ListView
        members={filteredMembers}
        teamsById={teamsById}
        accountLabels={accountLabels}
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
