// 一覧ビュー: every member in one DataTable, with status badge + team chips + linked
// account + row actions. Search filters by name / role.
import { DataTable, Tag, Button, IconButton, EmptyState } from "@dub/ui";
import type { ColumnDef } from "@dub/ui";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { MemberStatusBadge } from "./MemberStatusBadge.tsx";

/** 氏名ローマ字を "Last First" で合成 (アルファベットのメール発行の確認用). */
function romajiName(m: OrgMember): string {
  const parts = [m.lastNameRomaji, m.firstNameRomaji].filter((x): x is string => !!x && x.trim().length > 0);
  return parts.length > 0 ? parts.join(" ") : "—";
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
    { key: "name", header: "氏名", cell: (m) => m.name },
    { key: "nameRomaji", header: "氏名（ローマ字）", cell: (m) => romajiName(m) },
    { key: "department", header: "学科", cell: (m) => m.department ?? "—" },
    { key: "grade", header: "学年", cell: (m) => m.grade ?? "—" },
    { key: "role", header: "担当・役割", cell: (m) => m.roleTitle ?? "—" },
    { key: "status", header: "ステータス", cell: (m) => <MemberStatusBadge status={m.status} testId={`members-status-${m.id}`} /> },
    {
      key: "account",
      header: "アカウント",
      cell: (m) =>
        m.identityUserId ? (
          <span style={{ display: "inline-flex", gap: "var(--dub-space-1)", alignItems: "center" }} data-testid={`members-account-${m.id}`}>
            <Tag tone="success">{accountLabels.get(m.identityUserId) ?? m.identityUserId}</Tag>
            <IconButton name="x" aria-label={`${m.name} のアカウント紐付けを解除`} onClick={() => onUnlink(m)} testId={`members-unlink-${m.id}`} />
          </span>
        ) : (
          <Button variant="ghost" onClick={() => onLink(m)} testId={`members-link-${m.id}`}>
            未リンク・紐付け
          </Button>
        ),
    },
    {
      key: "teams",
      header: "所属チーム",
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
    { key: "contact", header: "連絡先", cell: (m) => m.contact ?? "—" },
    { key: "schoolEmail", header: "学校メール", cell: (m) => m.schoolEmail ?? "—" },
    { key: "gmail", header: "Gmail", cell: (m) => m.gmail ?? "—" },
    {
      key: "actions",
      header: "操作",
      align: "right",
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
