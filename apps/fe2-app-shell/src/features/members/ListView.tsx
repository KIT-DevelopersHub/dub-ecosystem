// 一覧ビュー: every member in one DataTable, with status badge + team chips + linked
// account + row actions. Search filters by name / role.
//
// 列が多い名簿なので、各列に minWidth + noWrap を与えてセルを 1 行に保つ。テーブルの
// 自然幅がコンテナを超えたら DataTable の overflow-x:auto で横スクロールになり（ページ本体は
// スクロールしない）、氏名やアカウント状態が 2〜3 行に折り返す崩れを防ぐ。長い値
// （メール・連絡先・氏名）は <Truncate> で省略（…）＋ title ツールチップにして幅を暴走させない。
//
// DataTable の「表示列」ピッカー(columnHiding)で列を隠せる。既定は全列 on。
// 人物プロフィール列(参加届と共通)も既定で全部出し、参加届の回答一覧と同じ項目が並ぶようにする。
// 選択は localStorage にユーザー単位で保存される。
//
// 編集: 行クリックで編集ダイアログを開く（操作列は右端で横スクロールしないと見えないため）。
// 行内のボタンは stopPropagation で行クリックと分ける。readOnly(閲覧のみ)では書き込み操作を無効化する。
import type { MouseEvent, ReactNode } from "react";
import { DataTable, Tag, Button, IconButton, EmptyState } from "@dub/ui";
import type { ColumnDef } from "@dub/ui";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { MemberStatusBadge } from "./MemberStatusBadge.tsx";
import { hasStatusBadge } from "./memberStatus.ts";
import { PROFILE_DISPLAY_COLUMNS } from "../../lib/personProfile.tsx";

/** 1 行に収めつつ長い値は省略（…）+ ホバーで全文（title）。max はセルの上限幅. */
function Truncate({ text, max = "16rem" }: { text: string; max?: string }): JSX.Element {
  const has = text.trim().length > 0 && text !== "—";
  return (
    <span
      title={has ? text : undefined}
      style={{
        display: "inline-block",
        maxWidth: max,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      {text}
    </span>
  );
}

/** 行内ボタンのクリックを行クリック(編集)に伝播させない. */
function StopRowClick({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span
      style={{ display: "inline-flex", gap: "var(--dub-space-1)", alignItems: "center" }}
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      {children}
    </span>
  );
}

export function ListView({
  members,
  teamsById,
  accountLabels,
  leaderNames,
  readOnly = false,
  onEdit,
  onDelete,
  onLink,
  onUnlink,
  onSendAccountMail,
}: {
  members: OrgMember[];
  teamsById: Map<string, MemberTeam>;
  /** identity userId -> display label (email/name) for the linked-account column. */
  accountLabels: Map<string, string>;
  /** member id -> 氏名: リーダー列で leaderId を氏名表示する。省略時は列を出さない。 */
  leaderNames?: Map<string, string>;
  /** 閲覧のみの権限 — 編集/削除/紐付けは押せず、行クリックでも編集を開かない. */
  readOnly?: boolean;
  onEdit: (m: OrgMember) => void;
  onDelete: (m: OrgMember) => void;
  onLink: (m: OrgMember) => void;
  onUnlink: (m: OrgMember) => void;
  /** アカウント発行メールの手動送信 (紐付け済み + Gmail ありの行だけ表示). */
  onSendAccountMail?: (m: OrgMember) => void;
}): JSX.Element {
  const columns: ColumnDef<OrgMember>[] = [
    { key: "name", header: "氏名", minWidth: "9rem", noWrap: true, cell: (m) => <Truncate text={m.name} max="12rem" /> },
    // 人物プロフィール列は参加届の回答一覧と共通 (PROFILE_DISPLAY_COLUMNS)。
    ...PROFILE_DISPLAY_COLUMNS.map(
      (c): ColumnDef<OrgMember> => ({
        key: c.id,
        header: c.header,
        minWidth: "7rem",
        noWrap: true,
        cell: (m) => <Truncate text={c.value(m) || "—"} max="14rem" />,
      }),
    ),
    { key: "role", header: "担当・役割", minWidth: "9rem", noWrap: true, cell: (m) => <Truncate text={m.roleTitle ?? "—"} max="12rem" /> },
    ...(leaderNames
      ? [
          {
            key: "leader",
            header: "リーダー",
            minWidth: "8rem",
            noWrap: true,
            cell: (m: OrgMember) => (
              <Truncate text={m.leaderId ? leaderNames.get(m.leaderId) ?? "—" : "—"} max="10rem" />
            ),
          } as ColumnDef<OrgMember>,
        ]
      : []),
    { key: "status", header: "ステータス", minWidth: "7rem", noWrap: true, cell: (m) => (hasStatusBadge(m.status) ? <MemberStatusBadge status={m.status} testId={`members-status-${m.id}`} /> : <span data-testid={`members-status-${m.id}`}>—</span>) },
    {
      key: "account",
      header: "developershub.jpメール",
      minWidth: "13rem",
      noWrap: true,
      cell: (m) =>
        m.identityUserId ? (
          <span style={{ display: "inline-flex", gap: "var(--dub-space-1)", alignItems: "center", maxWidth: "13rem" }} data-testid={`members-account-${m.id}`}>
            <Tag tone="success">
              <Truncate text={accountLabels.get(m.identityUserId) ?? m.identityUserId} max="9rem" />
            </Tag>
            <StopRowClick>
              <IconButton name="x" aria-label={`${m.name} のアカウント紐付けを解除`} disabled={readOnly} onClick={() => onUnlink(m)} testId={`members-unlink-${m.id}`} />
            </StopRowClick>
          </span>
        ) : (
          <StopRowClick>
            <Button variant="ghost" size="sm" disabled={readOnly} onClick={() => onLink(m)} testId={`members-link-${m.id}`}>
              未設定・紐付け
            </Button>
          </StopRowClick>
        ),
    },
    {
      key: "teams",
      header: "所属チーム",
      minWidth: "10rem",
      cell: (m) =>
        m.teamIds.length === 0 ? (
          "—"
        ) : (
          <span style={{ display: "inline-flex", gap: "var(--dub-space-1)", flexWrap: "wrap" }}>
            {m.teamIds.map((id) => (
              <Tag key={id} tone="brand">
                {teamsById.get(id)?.name ?? "?"}
              </Tag>
            ))}
          </span>
        ),
    },
    { key: "contact", header: "連絡先", minWidth: "9rem", noWrap: true, cell: (m) => <Truncate text={m.contact ?? "—"} max="12rem" /> },
    {
      key: "actions",
      header: "操作",
      align: "right",
      minWidth: "8rem",
      noWrap: true,
      hideable: false,
      cell: (m) => (
        <StopRowClick>
          {onSendAccountMail && m.identityUserId && m.gmail ? (
            <IconButton
              name="send"
              aria-label={`${m.name} にアカウント発行メールを送る`}
              disabled={readOnly}
              onClick={() => onSendAccountMail(m)}
              testId={`members-account-mail-${m.id}`}
            />
          ) : null}
          <IconButton name="edit" aria-label={`${m.name} を編集`} disabled={readOnly} onClick={() => onEdit(m)} testId={`members-edit-${m.id}`} />
          <IconButton
            name="trash"
            aria-label={`${m.name} を削除`}
            variant="danger"
            disabled={readOnly}
            onClick={() => onDelete(m)}
            testId={`members-delete-${m.id}`}
          />
        </StopRowClick>
      ),
    },
  ];

  return (
    <DataTable<OrgMember>
      columns={columns}
      rows={members}
      rowKey={(m) => m.id}
      onRowClick={readOnly ? undefined : onEdit}
      testId="members-table"
      columnHiding={{ storageKey: "dub.members.roster.columns.v2" }}
      emptyState={<EmptyState title="メンバーがいません" description="「メンバーを追加」から登録してください" icon="users" />}
    />
  );
}
