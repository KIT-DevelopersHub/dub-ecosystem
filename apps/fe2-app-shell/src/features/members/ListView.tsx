// 一覧ビュー: every member in one DataTable, with status badge + team chips + linked
// account + row actions. Search filters by name / role.
//
// 列が多い名簿なので、各列に minWidth + noWrap を与えてセルを 1 行に保つ。テーブルの
// 自然幅がコンテナを超えたら DataTable の overflow-x:auto で横スクロールになり（ページ本体は
// スクロールしない）、氏名やアカウント状態が 2〜3 行に折り返す崩れを防ぐ。長い値
// （メール・連絡先・氏名）は <Truncate> で省略（…）＋ title ツールチップにして幅を暴走させない。
import { DataTable, Tag, Button, IconButton, EmptyState } from "@dub/ui";
import type { ColumnDef } from "@dub/ui";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { MemberStatusBadge } from "./MemberStatusBadge.tsx";

/** 氏名ローマ字を "Last First" で合成 (アルファベットのメール発行の確認用). */
function romajiName(m: OrgMember): string {
  const parts = [m.lastNameRomaji, m.firstNameRomaji].filter((x): x is string => !!x && x.trim().length > 0);
  return parts.length > 0 ? parts.join(" ") : "—";
}

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

export function ListView({
  members,
  teamsById,
  accountLabels,
  onEdit,
  onDelete,
  onLink,
  onUnlink,
}: {
  members: OrgMember[];
  teamsById: Map<string, MemberTeam>;
  /** identity userId -> display label (email/name) for the linked-account column. */
  accountLabels: Map<string, string>;
  onEdit: (m: OrgMember) => void;
  onDelete: (m: OrgMember) => void;
  onLink: (m: OrgMember) => void;
  onUnlink: (m: OrgMember) => void;
}): JSX.Element {
  const columns: ColumnDef<OrgMember>[] = [
    { key: "name", header: "氏名", minWidth: "9rem", noWrap: true, cell: (m) => <Truncate text={m.name} max="12rem" /> },
    { key: "nameRomaji", header: "氏名（ローマ字）", minWidth: "11rem", noWrap: true, cell: (m) => <Truncate text={romajiName(m)} max="14rem" /> },
    { key: "department", header: "学科", minWidth: "7rem", noWrap: true, cell: (m) => m.department ?? "—" },
    { key: "grade", header: "学年", minWidth: "5rem", noWrap: true, cell: (m) => m.grade ?? "—" },
    { key: "role", header: "担当・役割", minWidth: "9rem", noWrap: true, cell: (m) => <Truncate text={m.roleTitle ?? "—"} max="12rem" /> },
    { key: "status", header: "ステータス", minWidth: "7rem", noWrap: true, cell: (m) => <MemberStatusBadge status={m.status} testId={`members-status-${m.id}`} /> },
    {
      key: "account",
      header: "アカウント",
      minWidth: "12rem",
      noWrap: true,
      cell: (m) =>
        m.identityUserId ? (
          <span style={{ display: "inline-flex", gap: "var(--dub-space-1)", alignItems: "center", maxWidth: "13rem" }} data-testid={`members-account-${m.id}`}>
            <Tag tone="success">
              <Truncate text={accountLabels.get(m.identityUserId) ?? m.identityUserId} max="9rem" />
            </Tag>
            <IconButton name="x" aria-label={`${m.name} のアカウント紐付けを解除`} onClick={() => onUnlink(m)} testId={`members-unlink-${m.id}`} />
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onLink(m)} testId={`members-link-${m.id}`}>
            未リンク・紐付け
          </Button>
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
    { key: "schoolEmail", header: "学校メール", minWidth: "13rem", noWrap: true, cell: (m) => <Truncate text={m.schoolEmail ?? "—"} max="16rem" /> },
    { key: "gmail", header: "Gmail", minWidth: "13rem", noWrap: true, cell: (m) => <Truncate text={m.gmail ?? "—"} max="16rem" /> },
    {
      key: "actions",
      header: "操作",
      align: "right",
      minWidth: "6rem",
      noWrap: true,
      cell: (m) => (
        <span style={{ display: "inline-flex", gap: "var(--dub-space-1)", justifyContent: "flex-end" }}>
          <IconButton name="edit" aria-label={`${m.name} を編集`} onClick={() => onEdit(m)} testId={`members-edit-${m.id}`} />
          <IconButton
            name="trash"
            aria-label={`${m.name} を削除`}
            variant="danger"
            onClick={() => onDelete(m)}
            testId={`members-delete-${m.id}`}
          />
        </span>
      ),
    },
  ];

  return (
    <DataTable<OrgMember>
      columns={columns}
      rows={members}
      rowKey={(m) => m.id}
      testId="members-table"
      emptyState={<EmptyState title="メンバーがいません" description="「メンバーを追加」から登録してください" icon="users" />}
    />
  );
}
