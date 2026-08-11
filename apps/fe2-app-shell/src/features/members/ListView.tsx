// 一覧ビュー: every member in one DataTable, with status badge + team chips + row
// actions. Search filters by name / role.
import { DataTable, Tag, IconButton, EmptyState } from "@dub/ui";
import type { ColumnDef } from "@dub/ui";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { MemberStatusBadge } from "./MemberStatusBadge.tsx";

export function ListView({
  members,
  teamsById,
  onEdit,
  onDelete,
}: {
  members: OrgMember[];
  teamsById: Map<string, MemberTeam>;
  onEdit: (m: OrgMember) => void;
  onDelete: (m: OrgMember) => void;
}): JSX.Element {
  const columns: ColumnDef<OrgMember>[] = [
    { key: "name", header: "氏名", cell: (m) => m.name },
    { key: "role", header: "担当・役割", cell: (m) => m.roleTitle ?? "—" },
    { key: "status", header: "ステータス", cell: (m) => <MemberStatusBadge status={m.status} testId={`members-status-${m.id}`} /> },
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
