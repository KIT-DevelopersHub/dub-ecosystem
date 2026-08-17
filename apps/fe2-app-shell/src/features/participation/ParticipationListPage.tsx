// 参加届 回答一覧 (運営専用). Lists every submitted 参加届 (member-service GET
// /api/v1/members/participation, identity:read) in a DataTable, and opens a Drawer
// with the full detail of a row on click. Read-only: this surface exists so 運営 can
// review who filed a 届 (学校メール / Gmail / 氏名 / 所属 / 希望) — write reflection onto
// the roster already happened at submit time. Route gate = identity:read (module.tsx).
import { useMemo, useState } from "react";
import { PageHeader, DataTable, Drawer, Badge, EmptyState, SkeletonLoader, ErrorState } from "@dub/ui";
import type { ColumnDef, BadgeTone } from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useParticipationList, useParticipationTeams } from "./hooks.ts";
import { ACTIVITY_LABEL, GRADE_LABEL, type Participation } from "./contracts.ts";
import styles from "./participation.module.css";

const MATCH_LABEL: Record<Participation["matchKind"], string> = {
  linked_existing: "既存に紐付け",
  created_new: "新規追加",
};
const MATCH_TONE: Record<Participation["matchKind"], BadgeTone> = {
  linked_existing: "info",
  created_new: "success",
};

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** アルファベットのメールアドレス素案 (first.last@…) を romaji から作る (表示専用)。
 *  実際の発行フローには繋がず、運営が候補として確認できるようにするだけ。 */
function emailCandidate(p: Participation): string | null {
  const clean = (v: string | null): string => (v ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  const first = clean(p.firstNameRomaji);
  const last = clean(p.lastNameRomaji);
  if (first && last) return `${first}.${last}`;
  const single = first || last;
  return single ? single : null;
}

export function ParticipationListPage(): JSX.Element {
  const list = useParticipationList();
  const teamsQuery = useParticipationTeams();
  const [selected, setSelected] = useState<Participation | null>(null);

  const teamName = useMemo(() => {
    const map = new Map((teamsQuery.data?.teams ?? []).map((t) => [t.id, t.name]));
    return (id: string | null): string => (id ? (map.get(id) ?? id) : "—");
  }, [teamsQuery.data]);

  const columns: ColumnDef<Participation>[] = [
    { key: "name", header: "氏名", cell: (p) => p.name },
    { key: "nameKana", header: "ふりがな", cell: (p) => p.nameKana ?? "—" },
    { key: "nameRomaji", header: "ローマ字", cell: (p) => p.nameRomaji ?? "—" },
    { key: "schoolEmail", header: "学校メール", cell: (p) => p.schoolEmail },
    { key: "gmail", header: "Gmail", cell: (p) => p.gmail },
    { key: "phone", header: "電話番号", cell: (p) => p.phone ?? "—" },
    { key: "grade", header: "学年", cell: (p) => (p.grade ? GRADE_LABEL[p.grade] : "—") },
    { key: "department", header: "学科", cell: (p) => p.department ?? "—" },
    { key: "team", header: "希望チーム", cell: (p) => teamName(p.desiredTeamId) },
    { key: "activity", header: "希望活動", cell: (p) => (p.desiredActivity ? ACTIVITY_LABEL[p.desiredActivity] : "—") },
    {
      key: "matchKind",
      header: "反映",
      cell: (p) => (
        <Badge tone={MATCH_TONE[p.matchKind]} testId={`participation-match-${p.id}`}>
          {MATCH_LABEL[p.matchKind]}
        </Badge>
      ),
    },
    { key: "submittedAt", header: "提出日時", cell: (p) => fmtDateTime(p.submittedAt) },
  ];

  if (list.isLoading) return <SkeletonLoader testId="participation-list-loading" />;
  if (list.isError) {
    const display = ApiError.isApiError(list.error)
      ? toDisplayableError(list.error)
      : { code: "UNKNOWN", message: "読み込みに失敗しました", retryable: true };
    return <ErrorState error={display} onRetry={() => void list.refetch()} />;
  }

  const rows = list.data?.participations ?? [];

  return (
    <div data-testid="participation-list-page">
      <PageHeader
        title="参加届の回答一覧"
        description="送信された参加届を確認できます（運営のみ・閲覧専用）。行をクリックすると詳細が開きます。"
      />
      <DataTable<Participation>
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id}
        onRowClick={(p) => setSelected(p)}
        testId="participation-list-table"
        emptyState={<EmptyState title="まだ参加届はありません" description="公開フォームから送信された参加届がここに表示されます" icon="check-square" />}
      />

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="参加届の詳細"
        testId="participation-detail"
      >
        {selected ? <DetailBody p={selected} teamName={teamName} /> : null}
      </Drawer>
    </div>
  );
}

function DetailBody({ p, teamName }: { p: Participation; teamName: (id: string | null) => string }): JSX.Element {
  const rows: { label: string; value: string }[] = [
    { label: "氏名", value: p.name },
    { label: "ふりがな", value: p.nameKana ?? "—" },
    { label: "氏名（ローマ字）", value: p.nameRomaji ?? "—" },
    { label: "メールアドレス素案", value: (() => { const c = emailCandidate(p); return c ? `${c}@…` : "—"; })() },
    { label: "学校メールアドレス", value: p.schoolEmail },
    { label: "Gmail アドレス", value: p.gmail },
    { label: "電話番号", value: p.phone ?? "—" },
    { label: "学年", value: p.grade ? GRADE_LABEL[p.grade] : "—" },
    { label: "学科", value: p.department ?? "—" },
    { label: "希望チーム", value: teamName(p.desiredTeamId) },
    { label: "希望する活動", value: p.desiredActivity ? ACTIVITY_LABEL[p.desiredActivity] : "—" },
    { label: "反映", value: MATCH_LABEL[p.matchKind] },
    { label: "その他", value: p.note ?? "—" },
    { label: "提出日時", value: fmtDateTime(p.submittedAt) },
  ];
  return (
    <dl className={styles.detailList}>
      {rows.map((r) => (
        <div className={styles.detailRow} key={r.label}>
          <dt className={styles.detailLabel}>{r.label}</dt>
          <dd className={styles.detailValue}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
