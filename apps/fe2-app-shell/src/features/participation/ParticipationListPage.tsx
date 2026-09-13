// 参加届 回答一覧 (運営専用). Lists every submitted 参加届 (member-service GET
// /api/v1/members/participation, identity:read) in a DataTable, and opens a Drawer
// with the full detail of a row on click. 左端の「運営メンバー反映」列で、管理者が各
// 提出者を運営メンバーに「追加する / しない」を選べる。「追加する」時は招待中/検討中の
// 突合候補を提示し、同一人物なら結合(link=在籍へ昇格・重複なし)、候補が無ければ新規
// (create) を確認ダイアログで確定する。反映は組織図(体制図)にも重複なく反映される。
// Route gate = identity:read; 反映確定(resolve)はサーバで identity:admin (fail-close)。
import { useMemo, useState } from "react";
import { PageHeader, DataTable, Drawer, Badge, Button, Modal, ConfirmDialog, Spinner, TextField, EmptyState, SkeletonLoader, ErrorState } from "@dub/ui";
import type { ColumnDef, BadgeTone } from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useParticipationList, useParticipationTeams, useParticipationCandidates, useParticipationRosterMembers, useResolveParticipation } from "./hooks.ts";
import { ACTIVITY_LABEL, GRADE_LABEL, REVIEW_STATE_LABEL, type MemberStatus, type Participation, type ParticipationCandidate, type RosterMember } from "./contracts.ts";
import styles from "./participation.module.css";

/** リンク先メンバーの最小情報（自動候補・名簿手動選択の共通形）。 */
type LinkTarget = { memberId: string; version: number };

const STATUS_LABEL: Partial<Record<MemberStatus, string>> = {
  invited: "招待中",
  considering: "検討中",
  added: "在籍",
  declined: "辞退",
};
const STATUS_TONE: Partial<Record<MemberStatus, BadgeTone>> = {
  invited: "info",
  considering: "warning",
  added: "success",
  declined: "neutral",
};

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
  // 「追加する」フロー対象 (候補ダイアログを開く) / 「対象外」確認対象 / 「紐付け取消」確認対象。
  const [addTarget, setAddTarget] = useState<Participation | null>(null);
  const [skipTarget, setSkipTarget] = useState<Participation | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<Participation | null>(null);

  const teamName = useMemo(() => {
    const map = new Map((teamsQuery.data?.teams ?? []).map((t) => [t.id, t.name]));
    return (id: string | null): string => (id ? (map.get(id) ?? id) : "—");
  }, [teamsQuery.data]);

  const doResolve = (id: string, body: Parameters<typeof resolveMut.mutate>[0]["body"]): void => {
    resolveMut.mutate({ id, body });
    setAddTarget(null);
    setSkipTarget(null);
    setUnlinkTarget(null);
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
        {p.reviewState === "added" ? (
          // 紐付け(link/create)を取り消して紐付け前へ戻す導線。スナップショットを持つ行だけ。
          p.canUnlink ? (
            <Button size="sm" variant="ghost" onClick={() => setUnlinkTarget(p)} testId={`participation-unlink-${p.id}`}>
              紐付けを取り消す
            </Button>
          ) : null
        ) : (
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
          onLink={(t) => doResolve(addTarget.id, { action: "link", memberId: t.memberId, expectedVersion: t.version })}
          onCreate={() => doResolve(addTarget.id, { action: "create" })}
          onSkip={() => doResolve(addTarget.id, { action: "skip" })}
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

      <ConfirmDialog
        open={unlinkTarget !== null}
        title="運営メンバーへの紐付けを取り消す"
        message={
          unlinkTarget
            ? `「${unlinkTarget.name}」の運営メンバーへの紐付けを取り消し、紐付け前の状態に戻します。参加届の内容で足した情報（メール・電話・所属チームなど）も撤回されます。よろしいですか？`
            : ""
        }
        confirmLabel="紐付けを取り消す"
        cancelLabel="キャンセル"
        onConfirm={() => {
          if (unlinkTarget) doResolve(unlinkTarget.id, { action: "unlink" });
        }}
        onCancel={() => setUnlinkTarget(null)}
        testId="participation-unlink-confirm"
      />
    </div>
  );
}

/** 反映確定ダイアログ。招待中/検討中の突合候補があれば「同一人物か？」を確認して link、
 *  無ければ『新規で追加 / 名簿から手動で紐付け / 対象外』の3択。手動モードでは名簿全体を
 *  氏名/メールでインクリメンタル検索し、自動一致に載らない相手(漢字違い等)にも link できる。 */
function ResolveDialog({
  participation,
  pending,
  onCancel,
  onLink,
  onCreate,
  onSkip,
}: {
  participation: Participation;
  pending: boolean;
  onCancel: () => void;
  onLink: (target: LinkTarget) => void;
  onCreate: () => void;
  onSkip: () => void;
}): JSX.Element {
  const [manual, setManual] = useState(false);
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
        <Button variant="ghost" onClick={onCancel} testId="participation-resolve-cancel">
          キャンセル
        </Button>
      }
    >
      <div className={styles.resolveBody}>
        {manual ? (
          <ManualLinkPanel
            participation={participation}
            pending={pending}
            onLink={onLink}
            onBack={() => setManual(false)}
          />
        ) : loading ? (
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
                <CandidateRow key={c.memberId} c={c} pending={pending} onLink={onLink} />
              ))}
            </ul>
            <div className={styles.resolveDivider}>または</div>
            <div className={styles.resolveActions}>
              <Button variant="secondary" loading={pending} onClick={() => setManual(true)} testId="participation-resolve-manual">
                名簿から手動で選ぶ
              </Button>
              <Button variant="secondary" loading={pending} onClick={onCreate} testId="participation-resolve-create-alt">
                どれとも別人・新規として追加
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.resolveLead} data-testid="participation-resolve-new">
              「{participation.name}」は招待中に自動で見つかる該当者がいません。どう反映しますか？
            </p>
            <div className={styles.resolveActions}>
              <Button variant="primary" loading={pending} onClick={onCreate} testId="participation-resolve-create">
                新規で追加
              </Button>
              <Button variant="secondary" loading={pending} onClick={() => setManual(true)} testId="participation-resolve-manual">
                名簿から手動で紐付け
              </Button>
              <Button variant="ghost" loading={pending} onClick={onSkip} testId="participation-resolve-skip">
                対象外にする
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function CandidateRow({ c, pending, onLink }: { c: ParticipationCandidate; pending: boolean; onLink: (t: LinkTarget) => void }): JSX.Element {
  return (
    <li className={styles.candidateRow}>
      <div className={styles.candidateInfo}>
        <span className={styles.candidateName}>
          {c.name}
          <Badge tone={STATUS_TONE[c.status] ?? "neutral"} testId={`participation-candidate-status-${c.memberId}`}>
            {STATUS_LABEL[c.status] ?? c.status}
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
        onClick={() => onLink({ memberId: c.memberId, version: c.version })}
        testId={`participation-link-${c.memberId}`}
      >
        この人に結びつける
      </Button>
    </li>
  );
}

/** 名簿から手動で紐付ける相手を選ぶパネル。氏名/メールでインクリメンタル検索し、
 *  招待中/検討中/在籍を1人選んで link する（辞退・退任は除外）。既に他の参加届に反映済み
 *  の在籍者へ紐付けるとサーバが 409 で弾く（二重紐付け防止）。 */
function ManualLinkPanel({
  participation,
  pending,
  onLink,
  onBack,
}: {
  participation: Participation;
  pending: boolean;
  onLink: (target: LinkTarget) => void;
  onBack: () => void;
}): JSX.Element {
  const [q, setQ] = useState("");
  const membersQuery = useParticipationRosterMembers(true);
  const all = membersQuery.data?.members ?? [];
  const needle = q.trim().toLowerCase();
  const results = useMemo(() => {
    const linkable = all.filter((m) => m.status !== "declined");
    const filtered = needle
      ? linkable.filter((m) =>
          [m.name, m.schoolEmail, m.gmail, m.contact]
            .filter((v): v is string => !!v)
            .some((v) => v.toLowerCase().includes(needle)),
        )
      : linkable;
    return filtered.slice(0, 20);
  }, [all, needle]);

  return (
    <div data-testid="participation-manual-panel">
      <p className={styles.resolveLead}>
        「{participation.name}」を名簿の誰に紐付けますか？ 氏名やメールで検索して選んでください（招待中の人は在籍に昇格します）。
      </p>
      <TextField
        id="participation-manual-search"
        value={q}
        onChange={setQ}
        placeholder="氏名・メールで検索"
        testId="participation-manual-search"
      />
      {membersQuery.isLoading ? (
        <div className={styles.manualLoading}>
          <Spinner />
        </div>
      ) : results.length === 0 ? (
        <p className={styles.candidateMeta} data-testid="participation-manual-empty">
          該当する名簿メンバーがいません。
        </p>
      ) : (
        <ul className={styles.candidateList} data-testid="participation-manual-results">
          {results.map((m: RosterMember) => (
            <li className={styles.candidateRow} key={m.id}>
              <div className={styles.candidateInfo}>
                <span className={styles.candidateName}>
                  {m.name}
                  <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{STATUS_LABEL[m.status] ?? m.status}</Badge>
                </span>
                <span className={styles.candidateMeta}>
                  {[m.schoolEmail, m.gmail].filter(Boolean).join(" / ") || "メール未登録"}
                </span>
              </div>
              <Button
                size="sm"
                variant="primary"
                loading={pending}
                onClick={() => onLink({ memberId: m.id, version: m.version })}
                testId={`participation-manual-link-${m.id}`}
              >
                この人に紐付ける
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.resolveDivider}>または</div>
      <Button variant="ghost" onClick={onBack} testId="participation-manual-back">
        自動候補に戻る
      </Button>
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
