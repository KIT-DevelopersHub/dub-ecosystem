// 一覧ビュー: every member in one DataTable, with status badge + team chips + linked
// account + row actions. Search filters by name / role.
//
// 列が多い名簿なので、各列に minWidth + noWrap を与えてセルを 1 行に保つ。テーブルの
// 自然幅がコンテナを超えたら DataTable の overflow-x:auto で横スクロールになり（ページ本体は
// スクロールしない）、氏名やアカウント状態が 2〜3 行に折り返す崩れを防ぐ。長い値
// （メール・連絡先・氏名）は <Truncate> で省略（…）＋ title ツールチップにして幅を暴走させない。
//
// さらに横スクロールを抑えるため DataTable の「表示列」ピッカー(columnHiding)を有効化する。
// 既定 on = 主要列(氏名/担当・役割/ステータス/所属チーム/連絡先) と 操作列(hideable:false・常時表示)。
// 情報過多で幅の広い列(ローマ字/学科/学年/学校メール/Gmail)は defaultHidden で初期 off にし、
// 初期表示の横スクロールを最小化する。developershub.jpメール(紐付いたアカウント)は既定表示 ON。
// 選択は localStorage にユーザー単位で保存され、全部 on にすれば従来どおり全列表示。
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
    { key: "nameRomaji", header: "氏名（ローマ字）", minWidth: "11rem", noWrap: true, defaultHidden: true, cell: (m) => <Truncate text={romajiName(m)} max="14rem" /> },
    { key: "department", header: "学科", minWidth: "7rem", noWrap: true, defaultHidden: true, cell: (m) => m.department ?? "—" },
    { key: "grade", header: "学年", minWidth: "5rem", noWrap: true, defaultHidden: true, cell: (m) => m.grade ?? "—" },
    { key: "role", header: "担当・役割", minWidth: "9rem", noWrap: true, cell: (m) => <Truncate text={m.roleTitle ?? "—"} max="12rem" /> },
    { key: "status", header: "ステータス", minWidth: "7rem", noWrap: true, cell: (m) => <MemberStatusBadge status={m.status} testId={`members-status-${m.id}`} /> },
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
            <IconButton name="x" aria-label={`${m.name} のアカウント紐付けを解除`} onClick={() => onUnlink(m)} testId={`members-unlink-${m.id}`} />
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onLink(m)} testId={`members-link-${m.id}`}>
            未設定・紐付け
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
    { key: "schoolEmail", header: "学校メール", minWidth: "13rem", noWrap: true, defaultHidden: true, cell: (m) => <Truncate text={m.schoolEmail ?? "—"} max="16rem" /> },
    { key: "gmail", header: "Gmail", minWidth: "13rem", noWrap: true, defaultHidden: true, cell: (m) => <Truncate text={m.gmail ?? "—"} max="16rem" /> },
    {
      key: "actions",
      header: "操作",
      align: "right",
      minWidth: "6rem",
      noWrap: true,
      hideable: false,
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
      columnHiding={{ storageKey: "dub.members.roster.columns.v1" }}
      emptyState={<EmptyState title="メンバーがいません" description="「メンバーを追加」から登録してください" icon="users" />}
    />
  );
}
