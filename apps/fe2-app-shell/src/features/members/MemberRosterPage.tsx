// 運営名簿 — 運営メンバー全員の情報をフラットな一覧（DataTable）で並べる名簿ビュー。
// 「運営メンバー」タブ(/members: チーム別/組織図) がチーム軸・組織図軸の見せ方なのに対し、
// こちらは 1 行 = 1 人で 氏名/ローマ字/学科/学年/役割/ステータス/紐付けアカウント/所属チーム/
// 連絡先/メール を横並びで見渡す「名簿」ビュー。データ源は member-service (useMembersOverview)
// ＋ identity-roster (useIdentityUsers, 紐付けアカウント列のラベル) で、/members と同じ Provider・
// 同じ overview キャッシュを共有する（additive・非破壊）。書き込み(追加/編集/削除/紐付け) は
// 既存ダイアログ・楽観的 mutation を再利用し、サーバ側で identity:admin を再認可する。
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  PageHeader,
  Button,
  TextField,
  Select,
  FormField,
  ConfirmDialog,
  SkeletonLoader,
  ErrorState,
  Menu,
  useToast,
} from "@dub/ui";
import type { SelectOption } from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useAppCapability } from "../../auth/AuthProvider.tsx";
import { AppReadOnlyNotice } from "../../auth/AppReadOnlyNotice.tsx";
import { useMembersOverview, useDeleteMember, useIdentityUsers, useUnlinkIdentity } from "./hooks.ts";
import { useMembersApi } from "./MembersProvider.tsx";
import { AccountMailPrompt, accountMailTarget, type AccountMailTarget } from "../../lib/accountMail.tsx";
import { ListView } from "./ListView.tsx";
import { MemberFormDialog } from "./MemberFormDialog.tsx";
import { LinkIdentityDialog } from "./LinkIdentityDialog.tsx";
import type { OrgMember } from "./contracts.ts";
import { ROSTER_FILTER_OPTIONS, canRemind, hasMissingProfile, matchesRosterFilter, type RosterStatusFilter } from "./memberStatus.ts";
import { orgChartOrder } from "./orgChartOrder.ts";
import { buildRosterTable, exportRoster, type RosterExportFormat } from "./rosterExport.ts";
import { PROFILE_DISPLAY_COLUMNS } from "../../lib/personProfile.tsx";
import styles from "./members.module.css";

type ProfileFilter = "all" | "missing";
const PROFILE_FILTER_OPTIONS: SelectOption<ProfileFilter>[] = [
  { value: "all", label: "すべて" },
  { value: "missing", label: "未入力あり" },
];
const REMIND_CONCURRENCY = 4;

function remindMessage(targets: OrgMember[]): string {
  const who = targets.length === 1 ? `「${targets[0]?.name ?? ""}」さん` : `${targets.length}人`;
  return `${who}に、未入力の項目を入力するよう通知を送ります。同じ人への通知は1日1回までです。`;
}

export function MemberRosterPage(): JSX.Element {
  // 書き込みは運営メンバータブと同じ要件 (app:members:edit)。閲覧のみなら操作を無効化する。
  const { canEdit } = useAppCapability("members");
  const overview = useMembersOverview();
  const deleteMember = useDeleteMember();
  const identityUsers = useIdentityUsers();
  const unlinkIdentity = useUnlinkIdentity();
  const membersApi = useMembersApi();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RosterStatusFilter>("roster");
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>("all");
  const [remindTargets, setRemindTargets] = useState<OrgMember[]>([]);
  const [memberDialog, setMemberDialog] = useState<{ open: boolean; editing: OrgMember | null }>({ open: false, editing: null });
  const [linkDialog, setLinkDialog] = useState<{ open: boolean; member: OrgMember | null }>({ open: false, member: null });
  const [confirm, setConfirm] = useState<OrgMember | null>(null);
  // アカウント発行メール: opened after a link (only when the member has a Gmail) or from the row.
  const [mailTarget, setMailTarget] = useState<AccountMailTarget | null>(null);

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
  const accountEmails = useMemo(
    () => new Map((identityUsers.data?.items ?? []).map((u) => [u.id, u.email])),
    [identityUsers.data],
  );
  const mailTargetOf = (m: OrgMember) =>
    accountMailTarget(m.identityUserId, m.name, m.gmail, m.identityUserId ? accountEmails.get(m.identityUserId) : null);
  const openAccountMail = (m: OrgMember) => setMailTarget(mailTargetOf(m));
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
    const byStatus = members.filter(
      (m) => matchesRosterFilter(m.status, statusFilter) && (profileFilter === "all" || hasMissingProfile(m)),
    );
    const ordered = orgChartOrder(byStatus);
    const q = search.trim().toLowerCase();
    if (!q) return ordered;
    // 一覧に出る値 (人物プロフィール列は表示ラベル: 学年は「3年」) をそのまま検索対象にする。
    return ordered.filter((m) =>
      [
        m.name,
        m.roleTitle ?? "",
        `${m.lastNameKana ?? ""}${m.firstNameKana ?? ""}`,
        ...PROFILE_DISPLAY_COLUMNS.map((c) => c.value(m)),
      ].some((v) => v.toLowerCase().includes(q)),
    );
  }, [members, search, statusFilter, profileFilter]);

  const STATUS_FILTER_OPTIONS: SelectOption<RosterStatusFilter>[] = ROSTER_FILTER_OPTIONS;

  const openAddMember = () => setMemberDialog({ open: true, editing: null });
  const openEditMember = (m: OrgMember) => setMemberDialog({ open: true, editing: m });

  // 画面に出ている行(状態フィルタ・検索・並び順を反映)をそのまま書き出す。
  const toast = useToast();
  const download = (format: RosterExportFormat) => {
    try {
      exportRoster(buildRosterTable(filteredMembers, { teamsById, accountLabels, leaderNames }), format);
    } catch {
      toast.show({ kind: "error", title: "ダウンロードに失敗しました" });
    }
  };

  // 催促は画面に出ている人が対象。通知はログインへ届くので、未紐付けの人は件数で知らせる。
  const missingMembers = filteredMembers.filter(hasMissingProfile);
  const remindable = missingMembers.filter(canRemind);
  const unlinkedCount = missingMembers.length - remindable.length;
  const remind = useMutation({
    mutationFn: async (targets: OrgMember[]) => {
      const results: PromiseSettledResult<{ deduplicated: boolean }>[] = [];
      for (let i = 0; i < targets.length; i += REMIND_CONCURRENCY) {
        const batch = targets.slice(i, i + REMIND_CONCURRENCY);
        results.push(...(await Promise.allSettled(batch.map((m) => membersApi.sendProfileReminder(m.id)))));
      }
      return results;
    },
    onSuccess: (results) => {
      const count = (match: (r: PromiseSettledResult<{ deduplicated: boolean }>) => boolean) => results.filter(match).length;
      const failed = count((r) => r.status === "rejected");
      const skipped = count((r) => r.status === "fulfilled" && r.value.deduplicated);
      const sent = results.length - failed - skipped;
      if (failed > 0) toast.show({ kind: "error", title: `${results.length}人中 ${failed}人に送れませんでした` });
      else if (sent === 0) toast.show({ kind: "info", title: "今日はすでに催促を送っています" });
      else toast.show({ kind: "success", title: `${sent}人に入力の催促を送りました${skipped > 0 ? `（${skipped}人は本日送信済み）` : ""}` });
    },
  });
  const confirmRemind = () => {
    remind.mutate(remindTargets);
    setRemindTargets([]);
  };

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
      <AppReadOnlyNotice appId="members" testId="member-roster-readonly-notice" />
      <PageHeader
        title="運営名簿"
        description={
          canEdit
            ? "運営メンバー全員の情報を一覧で表示します。行をクリックすると情報を編集できます"
            : "運営メンバー全員の情報を一覧で表示します（氏名・役割・所属チーム・メール・紐付けアカウント）"
        }
        actions={
          <>
            <Menu
              label="ダウンロード"
              icon="file"
              variant="secondary"
              menuLabel="運営名簿をダウンロード"
              testId="member-roster-export"
              items={[
                { id: "xlsx", label: "Excel（.xlsx）", onSelect: () => download("xlsx"), testId: "member-roster-export-xlsx" },
                { id: "csv", label: "CSV（.csv）", onSelect: () => download("csv"), testId: "member-roster-export-csv" },
                { id: "pdf", label: "PDF（.pdf）", onSelect: () => download("pdf"), testId: "member-roster-export-pdf" },
              ]}
            />
            <Button
              variant="secondary"
              disabled={!canEdit || remindable.length === 0 || remind.isPending}
              onClick={() => setRemindTargets(remindable)}
              testId="member-roster-remind"
            >
              {`未入力を催促（${remindable.length}人）`}
            </Button>
            <Button variant="primary" iconLeft={<span aria-hidden>＋</span>} disabled={!canEdit} onClick={openAddMember} testId="member-roster-add-member">
              メンバーを追加
            </Button>
          </>
        }
      />

      <div className={styles.toolbar}>
        <div className={styles.searchField}>
          <TextField
            id="member-roster-search"
            value={search}
            onChange={setSearch}
            placeholder="氏名・ふりがな・学籍番号・名列番号・役割・学科・学年などで検索"
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
        <FormField label="未入力" htmlFor="member-roster-profile-filter">
          <Select<ProfileFilter>
            id="member-roster-profile-filter"
            value={profileFilter}
            onChange={setProfileFilter}
            options={PROFILE_FILTER_OPTIONS}
            testId="member-roster-profile-filter"
          />
        </FormField>
      </div>

      {unlinkedCount > 0 ? (
        <p className={styles.rosterHint} data-testid="member-roster-unlinked-hint">
          未入力があってもアカウント未紐付けの{unlinkedCount}人には催促を送れません。
        </p>
      ) : null}

      <ListView
        members={filteredMembers}
        teamsById={teamsById}
        accountLabels={accountLabels}
        leaderNames={leaderNames}
        readOnly={!canEdit}
        onEdit={openEditMember}
        onDelete={(m) => setConfirm(m)}
        onLink={(m) => setLinkDialog({ open: true, member: m })}
        onUnlink={(m) => unlinkIdentity.mutate({ id: m.id, version: m.version })}
        onSendAccountMail={openAccountMail}
        canSendAccountMail={(m) => mailTargetOf(m) !== null}
        {...(remind.isPending ? {} : { onRemind: (m: OrgMember) => setRemindTargets([m]) })}
      />

      <MemberFormDialog
        open={memberDialog.open}
        onClose={() => setMemberDialog({ open: false, editing: null })}
        teams={teams}
        editing={memberDialog.editing}
        members={members}
        onUpdated={(saved, before) => {
          // 紐付け済みの人に Gmail が後から入った時も「3つが揃った瞬間」なので聞く。
          if (!(before.gmail ?? "").trim()) openAccountMail(saved);
        }}
      />

      <LinkIdentityDialog
        open={linkDialog.open}
        onClose={() => setLinkDialog({ open: false, member: null })}
        member={linkDialog.member}
        takenIds={takenIds}
        onLinked={(m, user) => setMailTarget(accountMailTarget(user.id, m.name, m.gmail, user.email))}
      />

      <AccountMailPrompt target={mailTarget} send={membersApi.sendAccountMail} onClose={() => setMailTarget(null)} />

      <ConfirmDialog
        open={remindTargets.length > 0}
        title="情報の入力を催促"
        message={remindMessage(remindTargets)}
        confirmLabel="催促を送る"
        cancelLabel="キャンセル"
        onConfirm={confirmRemind}
        onCancel={() => setRemindTargets([])}
        testId="member-roster-confirm-remind"
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
