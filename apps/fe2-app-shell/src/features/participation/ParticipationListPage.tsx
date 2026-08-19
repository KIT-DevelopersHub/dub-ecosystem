// 参加届 回答一覧 (運営専用). Lists every submitted 参加届 (member-service GET
// /api/v1/members/participation, identity:read) in a DataTable, and opens a Drawer
// with the full detail of a row on click. 左端の「運営メンバー反映」列で、管理者が各
// 提出者を運営メンバーに「追加する / しない」を選べる。「追加する」時は招待中/検討中の
// 突合候補を提示し、同一人物なら結合(link=在籍へ昇格・重複なし)、候補が無ければ新規
// (create) を確認ダイアログで確定する。反映は組織図(体制図)にも重複なく反映される。
// Route gate = identity:read; 反映確定(resolve)はサーバで identity:admin (fail-close)。
import { useMemo, useState } from "react";
import { PageHeader, DataTable, Drawer, Badge, Button, Modal, ConfirmDialog, Spinner, EmptyState, SkeletonLoader, ErrorState } from "@dub/ui";
import type { ColumnDef, BadgeTone } from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useParticipationList, useParticipationTeams, useParticipationCandidates, useResolveParticipation } from "./hooks.ts";
import { ACTIVITY_LABEL, GRADE_LABEL, REVIEW_STATE_LABEL, type Participation, type ParticipationCandidate } from "./contracts.ts";
import styles from "./participation.module.css";

const MATCH_LABEL: Record<Participation["matchKind"], string> = {
  linked_existing: "既存に紐付け",
  created_new: "新規追加",
};
const REVIEW_TONE: Record<Participation["reviewState"], BadgeTone> = {
  pending: "warning",
  added: "success",
  skipped: "neutral",
};

/** 一覧「運営メンバー反映」列 / 詳細の表示ラベル (reviewState 主導。added の時だけ
 *  結合/新規の内訳を添える)。 */
function reviewLabel(p: Participation): string {
  if (p.reviewState === "added") return `追加済（${MATCH_LABEL[p.matchKind]}）`;
  return REVIEW_STATE_LABEL[p.reviewState];
}

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
  const resolveMut = useResolveParticipation();
  const [selected, setSelected] = useState<Participation | null>(null);
  // 「追加する」フロー対象 (候補ダイアログを開く) / 「対象外」確認対象。
  const [addTarget, setAddTarget] = useState<Participation | null>(null);
  const [skipTarget, setSkipTarget] = useState<Participation | null>(null);

  const teamName = useMemo(() => {
    const map = new Map((teamsQuery.data?.teams ?? []).map((t) => [t.id, t.name]));
    return (id: string | null): string => (id ? (map.get(id) ?? id) : "—");
  }, [teamsQuery.data]);

  const doResolve = (id: string, body: Parameters<typeof resolveMut.mutate>[0]["body"]): void => {
    resolveMut.mutate({ id, body });
    setAddTarget(null);
    setSkipTarget(null);
  };

  // 左端「運営メンバー反映」列。行クリック(Drawer)とは独立させるため stopPropagation。
  const reviewColumn: ColumnDef<Participation> = {
    key: "review",
    header: "運営メンバー反映",
    noWrap: true,
    minWidth: "13rem",
    hideable: false,
    cell: (p) => (
      <div className={styles.reviewCell} onClick={(e) => e.stopPropagation()} data-testid={`participation-review-${p.id}`}>
        <Badge tone={REVIEW_TONE[p.reviewState]} testId={`participation-reviewstate-${p.id}`}>
          {reviewLabel(p)}
        </Badge>
        {p.reviewState === "added" ? null : (
          <>
            <Button size="sm" variant="primary" onClick={() => setAddTarget(p)} testId={`participation-add-${p.id}`}>
              追加する
            </Button>
            {p.reviewState === "pending" ? (
              <Button size="sm" variant="ghost" onClick={() => setSkipTarget(p)} testId={`participation-skip-${p.id}`}>
                しない
              </Button>
            ) : null}
          </>
        )}
      </div>
    ),
  };

  const columns: ColumnDef<Participation>[] = [
    reviewColumn,
    { key: "name", header: "氏名", noWrap: true, minWidth: "8rem", cell: (p) => p.name },
    { key: "nameKana", header: "ふりがな", noWrap: true, minWidth: "8rem", cell: (p) => p.nameKana ?? "—" },
    { key: "nameRomaji", header: "ローマ字", noWrap: true, minWidth: "9rem", cell: (p) => p.nameRomaji ?? "—" },
    { key: "schoolEmail", header: "学校メール", noWrap: true, minWidth: "14rem", cell: (p) => p.schoolEmail },
    { key: "gmail", header: "Gmail", noWrap: true, minWidth: "14rem", cell: (p) => p.gmail },
    { key: "phone", header: "電話番号", noWrap: true, minWidth: "8rem", cell: (p) => p.phone ?? "—" },
    { key: "grade", header: "学年", noWrap: true, minWidth: "4rem", cell: (p) => (p.grade ? GRADE_LABEL[p.grade] : "—") },
    { key: "department", header: "学科", noWrap: true, minWidth: "8rem", cell: (p) => p.department ?? "—" },
    { key: "team", header: "希望チーム", noWrap: true, minWidth: "8rem", cell: (p) => teamName(p.desiredTeamId) },
    { key: "activity", header: "希望活動", noWrap: true, minWidth: "6rem", cell: (p) => (p.desiredActivity ? ACTIVITY_LABEL[p.desiredActivity] : "—") },
    { key: "submittedAt", header: "提出日時", noWrap: true, minWidth: "11rem", cell: (p) => fmtDateTime(p.submittedAt) },
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
        description="送信された参加届を確認できます（運営のみ）。左端で運営メンバーに追加するか選べます。行をクリックすると詳細が開きます。"
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

      {addTarget ? (
        <ResolveDialog
          participation={addTarget}
          pending={resolveMut.isPending}
          onCancel={() => setAddTarget(null)}
          onLink={(c) => doResolve(addTarget.id, { action: "link", memberId: c.memberId, expectedVersion: c.version })}
          onCreate={() => doResolve(addTarget.id, { action: "create" })}
        />
      ) : null}

      <ConfirmDialog
        open={skipTarget !== null}
        title="運営メンバーに追加しない"
        message={
          skipTarget
            ? `「${skipTarget.name}」を運営メンバーに追加せず、対象外にします。よろしいですか？（あとから追加もできます）`
            : ""
        }
        confirmLabel="対象外にする"
        cancelLabel="キャンセル"
        onConfirm={() => {
          if (skipTarget) doResolve(skipTarget.id, { action: "skip" });
        }}
        onCancel={() => setSkipTarget(null)}
        testId="participation-skip-confirm"
      />
    </div>
  );
}

/** 反映確定ダイアログ。招待中/検討中の突合候補があれば「同一人物か？」を確認して link、
 *  無ければ「新規メンバーとして追加してよいか？」を確認して create する。 */
function ResolveDialog({
  participation,
  pending,
  onCancel,
  onLink,
  onCreate,
}: {
  participation: Participation;
  pending: boolean;
  onCancel: () => void;
  onLink: (candidate: ParticipationCandidate) => void;
  onCreate: () => void;
}): JSX.Element {
  const candidatesQuery = useParticipationCandidates(participation.id);
  const candidates = candidatesQuery.data?.candidates ?? [];
  const loading = candidatesQuery.isLoading;
  const hasCandidates = !loading && !candidatesQuery.isError && candidates.length > 0;

  return (
    <Modal
      open
      onClose={onCancel}
      title="運営メンバーに追加"
      size="md"
      testId="participation-resolve-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} testId="participation-resolve-cancel">
            キャンセル
          </Button>
          {/* 候補が無い / 候補と別人 のときの新規追加。候補ありのときは下の一覧内にも出す。 */}
          {!hasCandidates ? (
            <Button variant="primary" loading={pending} onClick={onCreate} testId="participation-resolve-create">
              新規で追加
            </Button>
          ) : null}
        </>
      }
    >
      <div className={styles.resolveBody}>
        {loading ? (
          <div data-testid="participation-resolve-loading">
            <Spinner />
          </div>
        ) : hasCandidates ? (
          <>
            <p className={styles.resolveLead}>
              「{participation.name}」は、招待中のこの人と<strong>同一人物</strong>ですか？ 同一なら結びつけて在籍に昇格します（重複を作りません）。
            </p>
            <ul className={styles.candidateList} data-testid="participation-candidates">
              {candidates.map((c) => (
                <li className={styles.candidateRow} key={c.memberId}>
                  <div className={styles.candidateInfo}>
                    <span className={styles.candidateName}>
                      {c.name}
                      <Badge tone="info" testId={`participation-candidate-status-${c.memberId}`}>
                        {c.status === "invited" ? "招待中" : "検討中"}
                      </Badge>
                    </span>
                    <span className={styles.candidateMeta}>
                      {[c.schoolEmail, c.gmail].filter(Boolean).join(" / ") || "メール未登録"}
                      {c.matchedBy.includes("email") ? "・メール一致" : c.matchedBy.includes("name") ? "・氏名一致" : ""}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={pending}
                    onClick={() => onLink(c)}
                    testId={`participation-link-${c.memberId}`}
                  >
                    この人に結びつける
                  </Button>
                </li>
              ))}
            </ul>
            <div className={styles.resolveDivider}>または</div>
            <Button variant="secondary" loading={pending} onClick={onCreate} testId="participation-resolve-create-alt">
              どれとも別人・新規として追加
            </Button>
          </>
        ) : (
          <p className={styles.resolveLead} data-testid="participation-resolve-new">
            「{participation.name}」は招待中に該当者がいません。<strong>新規メンバー</strong>として運営に追加します。よろしいですか？
          </p>
        )}
      </div>
    </Modal>
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
    { label: "運営メンバー反映", value: reviewLabel(p) },
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
