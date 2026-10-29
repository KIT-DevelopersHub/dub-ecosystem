// 人事の共通部品: 権限フラグ・段階バッジ・新規登録モーダル・応募者詳細ドロワー。
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  ErrorState,
  FormField,
  Modal,
  Select,
  SkeletonLoader,
  TextField,
  Textarea,
  type BadgeTone,
} from "@dub/ui";
import { hr } from "@dub/types";
import { useAppCapability, usePermissions } from "../../auth/AuthProvider.tsx";
import {
  useAddNote,
  useApplicantDetail,
  useCreateApplicant,
  useHrTeams,
  useJoinApplicant,
  useMoveStage,
  useRemoveApplicant,
} from "./hrHooks.ts";
import styles from "./hr.module.css";

export const STAGE_LABELS = hr.APPLICANT_STAGE_LABELS;

const STAGE_TONES: Record<hr.ApplicantStage, BadgeTone> = {
  applied: "neutral",
  screening: "info",
  interview: "brand",
  offered: "warning",
  joined: "success",
  rejected: "danger",
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
export function useHrCapability(): { canWrite: boolean; canAdmin: boolean } {
  const { canEdit } = useAppCapability("hr");
  const { can } = usePermissions();
  return { canWrite: canEdit && can("hr:write"), canAdmin: canEdit && can("hr:admin") };
}

/** パイプライン上の「次へ」(offered の次は参加確定なので null)。 */
export function nextStage(stage: hr.ApplicantStage): hr.ApplicantStage | null {
  const order: hr.ApplicantStage[] = ["applied", "screening", "interview", "offered"];
  const i = order.indexOf(stage);
  return i >= 0 && i < order.length - 1 ? order[i + 1]! : null;
}

export function prevStage(stage: hr.ApplicantStage): hr.ApplicantStage | null {
  const order: hr.ApplicantStage[] = ["applied", "screening", "interview", "offered"];
  const i = order.indexOf(stage);
  return i > 0 ? order[i - 1]! : null;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const EMPTY_FORM = { name: "", nameKana: "", email: "", department: "", grade: "", desiredTeamId: "", source: "", motivation: "" };

export function NewApplicantModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [form, setForm] = useState(EMPTY_FORM);
  const [touched, setTouched] = useState(false);
  const create = useCreateApplicant();
  const teams = useHrTeams();
  const set = (k: keyof typeof EMPTY_FORM) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const nameError = touched && form.name.trim() === "" ? "氏名を入力してください" : undefined;

  const submit = () => {
    setTouched(true);
    if (form.name.trim() === "") return;
    create.mutate(
      {
        name: form.name,
        nameKana: form.nameKana || null,
        email: form.email || null,
        department: form.department || null,
        grade: form.grade || null,
        desiredTeamId: form.desiredTeamId || null,
        source: form.source || null,
        motivation: form.motivation || null,
      },
      {
        onSuccess: () => {
          setForm(EMPTY_FORM);
          setTouched(false);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      testId="fe2-hr-new-modal"
      open={open}
      onClose={onClose}
      title="応募者を登録"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            キャンセル
          </Button>
          <Button testId="fe2-hr-new-submit" loading={create.isPending} onClick={submit}>
            登録する
          </Button>
        </>
      }
    >
      <div className={styles.formGrid}>
        <FormField label="氏名" htmlFor="hr-name" required error={nameError}>
          <TextField id="hr-name" testId="fe2-hr-new-name" value={form.name} onChange={set("name")} invalid={!!nameError} />
        </FormField>
        <FormField label="フリガナ" htmlFor="hr-kana">
          <TextField id="hr-kana" value={form.nameKana} onChange={set("nameKana")} />
        </FormField>
        <FormField label="メールアドレス" htmlFor="hr-email">
          <TextField id="hr-email" type="email" value={form.email} onChange={set("email")} />
        </FormField>
        <FormField label="学科" htmlFor="hr-dept">
          <TextField id="hr-dept" value={form.department} onChange={set("department")} />
        </FormField>
        <FormField label="学年" htmlFor="hr-grade">
          <TextField id="hr-grade" value={form.grade} onChange={set("grade")} placeholder="例: 2年" />
        </FormField>
        <FormField label="希望チーム" htmlFor="hr-team">
          <Select
            id="hr-team"
            value={form.desiredTeamId || null}
            onChange={set("desiredTeamId")}
            placeholder="未定"
            options={(teams.data?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))}
          />
        </FormField>
        <FormField label="応募経路" htmlFor="hr-source">
          <TextField id="hr-source" value={form.source} onChange={set("source")} placeholder="例: 公開フォーム / 紹介" />
        </FormField>
      </div>
      <div style={{ marginTop: "var(--dub-space-4)" }}>
        <FormField label="志望動機・メモ" htmlFor="hr-motivation">
          <Textarea id="hr-motivation" rows={3} value={form.motivation} onChange={set("motivation")} />
        </FormField>
      </div>
    </Modal>
  );
}

function eventLabel(e: hr.ApplicantEvent): string {
  switch (e.kind) {
    case "created":
      return "応募を登録";
    case "stage":
      return `${e.fromStage ? STAGE_LABELS[e.fromStage] : "—"} → ${e.toStage ? STAGE_LABELS[e.toStage] : "—"}`;
    case "joined":
      return "参加確定（名簿に追加）";
    case "note":
      return "メモ";
  }
}

/** 応募者の詳細 + 段階変更 + メモ + 履歴 + 参加確定。 */
export function ApplicantDrawer({ applicantId, onClose }: { applicantId: string | null; onClose: () => void }): JSX.Element {
  const detail = useApplicantDetail(applicantId);
  const navigate = useNavigate();
  const teams = useHrTeams();
  const { canWrite, canAdmin } = useHrCapability();
  const move = useMoveStage();
  const addNote = useAddNote();
  const join = useJoinApplicant();
  const remove = useRemoveApplicant();
  const [note, setNote] = useState("");
  const [confirmJoin, setConfirmJoin] = useState(false);
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
    const options = hr.STAGE_TRANSITIONS[a.stage].map((s) => ({ value: s, label: STAGE_LABELS[s] }));
    body = (
      <div className={styles.detail} data-testid="fe2-hr-detail">
        <div className={styles.toolbar}>
          <StageBadge stage={a.stage} />
          {a.stage === "offered" && canAdmin ? (
            <Button testId="fe2-hr-join" onClick={() => setConfirmJoin(true)}>
              参加を確定する
            </Button>
          ) : null}
        </div>
        <dl className={styles.fields}>
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

        {canWrite && options.length > 0 ? (
          <FormField label="段階を変更" htmlFor="hr-stage">
            <Select
              id="hr-stage"
              testId="fe2-hr-stage-select"
              value={null}
              placeholder={`${STAGE_LABELS[a.stage]} から…`}
              options={options}
              onChange={(stage) => move.mutate({ applicant: a, stage })}
            />
          </FormField>
        ) : null}

        {canWrite ? (
          <div>
            <FormField label="メモを追加" htmlFor="hr-note" help="面談の所感・連絡の記録など。履歴に残ります。">
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

        {canAdmin && a.stage !== "joined" ? (
          <div>
            <Button variant="danger" size="sm" testId="fe2-hr-remove" onClick={() => setConfirmRemove(true)}>
              応募を削除
            </Button>
          </div>
        ) : null}

        <ConfirmDialog
          testId="fe2-hr-join-confirm"
          open={confirmJoin}
          title="参加を確定しますか？"
          message={`${a.name} さんを在籍メンバーとして運営メンバー・名簿に追加します。${team ? `希望チーム（${team.name}）にも所属します。` : ""}`}
          confirmLabel="名簿に追加する"
          onCancel={() => setConfirmJoin(false)}
          onConfirm={async () => {
            await join.mutateAsync({ applicant: a }).catch(() => undefined);
            setConfirmJoin(false);
          }}
        />
        <ConfirmDialog
          testId="fe2-hr-remove-confirm"
          open={confirmRemove}
          danger
          title="応募を削除しますか？"
          message={`${a.name} さんの応募を一覧から削除します。`}
          confirmLabel="削除する"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={async () => {
            await remove.mutateAsync(a).then(onClose).catch(() => undefined);
            setConfirmRemove(false);
          }}
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
