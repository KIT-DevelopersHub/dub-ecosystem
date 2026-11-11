// 人事の共通部品: 権限フラグ・ステータスバッジ・応募者詳細ドロワー・押した値を即座に重ねる usePendingOverlay。
// ステータスは手で変えない (面談の予約で 面談確定、面談結果の登録で 採用 / 不採用)。
import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  ErrorState,
  FormField,
  IconButton,
  Select,
  SkeletonLoader,
  Textarea,
  type BadgeTone,
} from "@dub/ui";
import { hr, hrResult } from "@dub/types";
import { useAppCapability, usePermissions } from "../../auth/AuthProvider.tsx";
import {
  useAddNote,
  useApplicantDetail,
  useHrTeams,
  useJoinApplicant,
  useMoveStage,
  useRemoveApplicant,
  useUpdateApplicant,
} from "./hrHooks.ts";
import { ApplicantFormAnswers, ParticipationLinkButton } from "./ApplicantFormAnswers.tsx";
import styles from "./hr.module.css";

export const STAGE_LABELS = hr.APPLICANT_STAGE_LABELS;

const STAGE_TONES: Record<hr.ApplicantStage, BadgeTone> = {
  scheduling: "neutral",
  interview_set: "info",
  interviewed: "brand",
  hired: "success",
  rejected: "danger",
  onboarding: "warning",
  onboarded: "success",
  withdrawn: "neutral",
};

export function StageBadge({ stage }: { stage: hr.ApplicantStage }): JSX.Element {
  return (
    <Badge tone={STAGE_TONES[stage]} testId={`fe2-hr-stage-${stage}`}>
      {STAGE_LABELS[stage]}
    </Badge>
  );
}

/** 人事アプリでの操作可否。表 (member-service policy-table) と同じ組み合わせ。 */
export function useHrCapability(): { canWrite: boolean; canAdmin: boolean; canRegister: boolean } {
  const { canEdit } = useAppCapability("hr");
  const { can } = usePermissions();
  const canWrite = canEdit && can("hr:write");
  // 面談結果の登録 (gateway): hr:write + 合格のアカウント発行の鍵 members:onboard_mail。
  return { canWrite, canAdmin: canEdit && can("hr:admin"), canRegister: canWrite && can("members:onboard_mail") };
}

/**
 * 押した値をサーバ応答前から表示に重ねる。制御コンポーネント (checkbox/select) は onMutate が
 * 走るまでの一瞬だけ古い値に戻って見える (= チェックが一瞬外れる) ので、イベントハンドラ内で
 * ここに入れて同じ描画で反映させる。確定 (成功/失敗) したら clear する。
 */
export function usePendingOverlay<V>(): {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
  clear: (key: string) => void;
} {
  const [pending, setPending] = useState<Record<string, V>>({});
  const get = useCallback((key: string) => pending[key], [pending]);
  const set = useCallback((key: string, value: V) => setPending((p) => ({ ...p, [key]: value })), []);
  const clear = useCallback(
    (key: string) =>
      setPending((p) => {
        if (!(key in p)) return p;
        const next = { ...p };
        delete next[key];
        return next;
      }),
    [],
  );
  return { get, set, clear };
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** ISO → <input type="datetime-local"> の値 (ローカル時刻)。 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function eventLabel(e: hr.ApplicantEvent): string {
  switch (e.kind) {
    case "created":
      return "応募を登録";
    case "stage":
      return `${e.fromStage ? STAGE_LABELS[e.fromStage] : "—"} → ${e.toStage ? STAGE_LABELS[e.toStage] : "—"}`;
    case "joined":
      return "採用（名簿に追加）";
    case "note":
      return "メモ";
    case "deleted":
      return "応募を削除";
  }
}

/** 削除できるか: hr:admin で、採用〜オンボーディング完了でない人だけ (サーバも同じ判定で 409)。 */
export function canRemoveApplicant(a: hr.Applicant, canAdmin: boolean): boolean {
  return canAdmin && !hr.blocksRemoval(a.stage, a.memberId !== null);
}

/**
 * 応募の削除の確認。確定した瞬間にダイアログを閉じて一覧から消し (楽観的)、失敗したら戻る。
 * 履歴とフォーム回答はサーバに残る (論理削除)。
 */
export function RemoveApplicantDialog({
  applicant,
  onClose,
  onConfirmed,
}: {
  applicant: hr.Applicant | null;
  onClose: () => void;
  /** 確定の直後 (送信前) に呼ぶ。ドロワーを閉じるなど。 */
  onConfirmed?: () => void;
}): JSX.Element {
  const remove = useRemoveApplicant();
  return (
    <ConfirmDialog
      testId="fe2-hr-remove-confirm"
      open={applicant !== null}
      danger
      title="応募を削除しますか？"
      message={
        applicant
          ? `${applicant.name} さんの応募を一覧から削除します。面談の履歴と申し込みフォームの回答は記録として残ります。${
              applicant.memberId !== null ? "名簿の登録は解除されません。" : ""
            }`
          : ""
      }
      confirmLabel="削除する"
      onCancel={onClose}
      onConfirm={() => {
        if (!applicant) return;
        remove.mutate(applicant);
        onConfirmed?.();
        onClose();
      }}
    />
  );
}

/** 表の行の削除ボタン。行クリック (詳細を開く) には伝えない。 */
export function RemoveApplicantButton({
  applicant,
  onRequest,
}: {
  applicant: hr.Applicant;
  onRequest: (a: hr.Applicant) => void;
}): JSX.Element {
  const { canAdmin } = useHrCapability();
  const allowed = canRemoveApplicant(applicant, canAdmin);
  const label = !canAdmin
    ? "応募の削除は人事の管理者のみできます"
    : hr.blocksRemoval(applicant.stage, applicant.memberId !== null)
      ? "採用済み（名簿に追加済み）の人は削除できません"
      : `${applicant.name} さんの応募を削除`;
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <IconButton
        name="trash"
        size="sm"
        variant="ghost"
        aria-label={label}
        disabled={!allowed}
        testId={`fe2-hr-row-${applicant.id}-remove`}
        onClick={() => onRequest(applicant)}
      />
    </span>
  );
}

/** 応募者の詳細 + ステータス + 面談日 + メモ + 履歴。 */
export function ApplicantDrawer({
  applicantId,
  onClose,
  onRequestResult,
}: {
  applicantId: string | null;
  onClose: () => void;
  /** 面談確定・面談済みの人の「面談結果を登録」。 */
  onRequestResult?: (a: hr.Applicant) => void;
}): JSX.Element {
  const detail = useApplicantDetail(applicantId);
  const navigate = useNavigate();
  const teams = useHrTeams();
  const { canWrite, canAdmin, canRegister } = useHrCapability();
  const addNote = useAddNote();
  const update = useUpdateApplicant();
  const [note, setNote] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  let body: JSX.Element;
  if (detail.isLoading) {
    body = <SkeletonLoader lines={8} testId="fe2-hr-detail-loading" />;
  } else if (detail.isError || !detail.data) {
    body = (
      <ErrorState
        testId="fe2-hr-detail-error"
        error={{ code: "INTERNAL", message: "応募者を読み込めませんでした。" }}
        onRetry={() => void detail.refetch()}
      />
    );
  } else {
    const { applicant: a, events } = detail.data;
    const team = teams.data?.teams.find((t) => t.id === a.desiredTeamId);
    body = (
      <div className={styles.detail} data-testid="fe2-hr-detail">
        {/* ステータスは手で変えない: 予約で 面談確定、結果の登録で 採用 / 不採用 に進む。 */}
        <div className={styles.stageCell} data-testid="fe2-hr-detail-status">
          <StageBadge stage={a.stage} />
          {canRegister && onRequestResult && hrResult.RESULT_STAGES.includes(a.stage) ? (
            <Button size="sm" variant="primary" testId="fe2-hr-detail-result" onClick={() => onRequestResult(a)}>
              面談結果を登録
            </Button>
          ) : null}
        </div>
        {canWrite ? (
          <FormField label="面談日" htmlFor="hr-detail-interview">
            <input
              id="hr-detail-interview"
              data-testid="fe2-hr-detail-interview"
              type="datetime-local"
              className={styles.dateInput}
              defaultValue={toLocalInput(a.interviewAt)}
              key={`${a.id}-${a.interviewAt ?? ""}`}
              onBlur={(e) => {
                const v = e.target.value ? new Date(e.target.value).toISOString() : null;
                if (v !== a.interviewAt) update.mutate({ applicant: a, patch: { interviewAt: v } });
              }}
            />
          </FormField>
        ) : null}
        <dl className={styles.fields}>
          {!canWrite ? (
            <>
              <dt>面談日</dt>
              <dd>{formatDateTime(a.interviewAt)}</dd>
            </>
          ) : null}
          <dt>フリガナ</dt>
          <dd>{a.nameKana ?? "—"}</dd>
          <dt>メール</dt>
          <dd>{a.email ?? "—"}</dd>
          <dt>学科・学年</dt>
          <dd>{[a.department, a.grade].filter(Boolean).join(" / ") || "—"}</dd>
          <dt>希望チーム</dt>
          <dd>{team?.name ?? "未定"}</dd>
          <dt>応募経路</dt>
          <dd>{a.source ?? "—"}</dd>
          <dt>志望動機</dt>
          <dd>{a.motivation ?? "—"}</dd>
          {a.memberId ? (
            <>
              <dt>名簿</dt>
              <dd>
                <Button variant="ghost" size="sm" testId="fe2-hr-member-link" onClick={() => void navigate({ to: "/members" })}>
                  運営メンバー・名簿で見る →
                </Button>
              </dd>
            </>
          ) : null}
        </dl>

        <ApplicantFormAnswers applicantId={a.id} />

        <ParticipationLinkButton applicant={a} />

        {canWrite ? (
          <div>
            <FormField label="メモを追加" htmlFor="hr-note" help="面談の所感・連絡の記録など。履歴に残り、一覧の「メモ」列にも出ます。">
              <Textarea id="hr-note" testId="fe2-hr-note" rows={3} value={note} onChange={setNote} />
            </FormField>
            <div style={{ marginTop: "var(--dub-space-3)" }}>
              <Button
                variant="secondary"
                size="sm"
                testId="fe2-hr-note-submit"
                disabled={note.trim() === ""}
                loading={addNote.isPending}
                onClick={() => addNote.mutate({ id: a.id, body: note }, { onSuccess: () => setNote("") })}
              >
                メモを残す
              </Button>
            </div>
          </div>
        ) : null}

        <div>
          <div className={styles.sectionTitle}>履歴</div>
          <ol className={styles.history} data-testid="fe2-hr-history" style={{ marginTop: "var(--dub-space-3)" }}>
            {[...events].reverse().map((e) => (
              <li key={e.id} className={styles.historyItem}>
                <span className={styles.historyWhen}>{formatDateTime(e.createdAt)}</span>
                <span>{eventLabel(e)}</span>
                {e.body ? <span className={styles.historyBody}>{e.body}</span> : null}
              </li>
            ))}
          </ol>
        </div>

        {canRemoveApplicant(a, canAdmin) ? (
          <div>
            <Button variant="danger" size="sm" testId="fe2-hr-remove" onClick={() => setConfirmRemove(true)}>
              応募を削除
            </Button>
          </div>
        ) : null}

        <RemoveApplicantDialog
          applicant={confirmRemove ? a : null}
          onClose={() => setConfirmRemove(false)}
          onConfirmed={onClose}
        />
      </div>
    );
  }

  return (
    <Drawer testId="fe2-hr-drawer" open={applicantId !== null} onClose={onClose} title={detail.data?.applicant.name ?? "応募者"}>
      {body}
    </Drawer>
  );
}
