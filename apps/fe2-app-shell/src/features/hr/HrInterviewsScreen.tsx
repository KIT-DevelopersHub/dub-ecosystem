// 人事 → 面談。人事が面談できる日程を登録し、応募者はメールの URL からその候補を選ぶ。
//  - 案内メール: 選べる候補の数と、メールを送り始める候補数の設定。足りない間は保留する。
//  - 面談できる日程: 枠の追加・削除・予約の取り消し。
//  - 応募者への案内: メールの状況。保留中でも人事の判断で「今すぐ送る」ことができる。
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Select,
  SkeletonCard,
  SkeletonTable,
  Stack,
  TextField,
  type BadgeTone,
  type ColumnDef,
} from "@dub/ui";
import { hrInterview } from "@dub/types";
import { HrFrame } from "./HrApplicantsScreen.tsx";
import { useHrCapability } from "./HrShared.tsx";
import { formatDateTime } from "./ApplicantFormAnswers.tsx";
import {
  useAddSlot,
  useInterviewOverview,
  useReleaseBooking,
  useRemoveSlot,
  useSaveInterviewSettings,
  useSendInvite,
} from "./interviewsApi.tsx";
import styles from "./interviews.module.css";

type Overview = hrInterview.InterviewOverview;

const INVITE_TONES: Record<hrInterview.InterviewInviteStatus, BadgeTone> = { held: "warning", sent: "info", booked: "success" };
const DURATION_OPTIONS = hrInterview.SLOT_DURATIONS_MINUTES.map((m) => ({ value: String(m), label: `${m} 分` }));

export function HrInterviewsScreen(): JSX.Element {
  const overview = useInterviewOverview();
  const { canWrite } = useHrCapability();

  let body: JSX.Element;
  if (overview.isLoading) {
    body = (
      <Stack gap={6}>
        <SkeletonCard testId="fe2-hr-interviews-loading" />
        <SkeletonTable rows={4} columns={4} />
      </Stack>
    );
  } else if (overview.isError || !overview.data) {
    body = (
      <ErrorState
        testId="fe2-hr-interviews-error"
        error={{ code: "INTERNAL", message: "面談の情報を読み込めませんでした。" }}
        onRetry={() => void overview.refetch()}
      />
    );
  } else {
    body = (
      <Stack gap={6}>
        <MailStatusCard data={overview.data} canWrite={canWrite} />
        <SlotsCard data={overview.data} canWrite={canWrite} />
        <InvitesCard data={overview.data} canWrite={canWrite} />
      </Stack>
    );
  }
  return <HrFrame active="interviews">{body}</HrFrame>;
}

function statusMessage({ settings, openSlotCount, heldCount, invites }: Overview): string {
  const short = settings.minOpenSlots - openSlotCount;
  const waiting = invites.filter((i) => i.status === "sent").length;
  if (openSlotCount === 0 && waiting > 0) {
    return `メールを受け取った ${waiting} 人が、選べる候補がなく待っています。日程を追加してから、下の「再送」でお知らせできます。`;
  }
  if (short <= 0) {
    return heldCount > 0
      ? `候補は揃っていますが、${heldCount} 人にまだ送れていません。下の「今すぐ送る」で送るか、次の申し込みや日程の追加を待つと自動で送ります。`
      : "候補が揃っています。申し込みがあると、すぐに案内メールを送ります。";
  }
  const more = `あと ${short} 候補を登録すると、自動で送ります。`;
  return heldCount > 0 ? `候補が足りないため、${heldCount} 人への案内メールを保留しています。${more}` : `候補が揃うまで、案内メールは保留します。${more}`;
}

function MailStatusCard({ data, canWrite }: { data: Overview; canWrite: boolean }): JSX.Element {
  const save = useSaveInterviewSettings();
  const saved = String(data.settings.minOpenSlots);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const valid = hrInterview.isValidMinOpenSlots(Number(value));
  const { min, max } = hrInterview.MIN_OPEN_SLOTS_LIMIT;
  const ready = data.openSlotCount >= data.settings.minOpenSlots;
  return (
    <Card testId="fe2-hr-interviews-status" header={<h2 className={styles.cardTitle}>案内メール</h2>}>
      <div className={styles.statusRow}>
        <div>
          <p className={styles.count}>
            <strong data-testid="fe2-hr-interviews-open-count">{data.openSlotCount}</strong>
            <span className={styles.muted}> / {data.settings.minOpenSlots} 候補</span>
            <span className={styles.statusBadge}>
              <Badge tone={ready ? "success" : "warning"}>{ready ? "送信できます" : "保留中"}</Badge>
            </span>
          </p>
          <p className={styles.muted} data-testid="fe2-hr-interviews-status-message">
            {statusMessage(data)}
          </p>
        </div>
        {canWrite ? (
          <form
            className={styles.settingsForm}
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              setDraft(null);
              if (value !== saved) save.mutate(Number(value));
            }}
          >
            <FormField
              label="メールを送り始める候補数"
              htmlFor="fe2-hr-interviews-min"
              {...(valid ? {} : { error: `${min}〜${max} で入力してください` })}
            >
              <TextField
                id="fe2-hr-interviews-min"
                testId="fe2-hr-interviews-min"
                type="number"
                value={value}
                invalid={!valid}
                onChange={setDraft}
              />
            </FormField>
            <Button type="submit" variant="secondary" testId="fe2-hr-interviews-min-save" disabled={!valid || value === saved}>
              保存
            </Button>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

function SlotsCard({ data, canWrite }: { data: Overview; canWrite: boolean }): JSX.Element {
  const remove = useRemoveSlot();
  const release = useReleaseBooking();
  const [releasing, setReleasing] = useState<hrInterview.InterviewSlot | null>(null);

  const columns: ColumnDef<hrInterview.InterviewSlot>[] = useMemo(
    () => [
      { key: "at", header: "日時（日本時間）", noWrap: true, cell: (s) => hrInterview.formatSlotJst(s) },
      { key: "who", header: "担当", noWrap: true, cell: (s) => s.interviewerName || "—" },
      {
        key: "state",
        header: "状態",
        cell: (s) =>
          s.applicantId ? <Badge tone="success">予約: {s.applicantName ?? "削除済みの応募者"}</Badge> : <Badge tone="neutral">空き</Badge>,
      },
      {
        key: "actions",
        header: "",
        noWrap: true,
        cell: (s) => {
          if (!canWrite || s.id.startsWith("pending_")) return null;
          return s.applicantId ? (
            <Button size="sm" variant="secondary" testId={`fe2-hr-slot-release-${s.id}`} onClick={() => setReleasing(s)}>
              予約を取り消す
            </Button>
          ) : (
            <Button size="sm" variant="ghost" testId={`fe2-hr-slot-remove-${s.id}`} onClick={() => remove.mutate(s.id)}>
              削除
            </Button>
          );
        },
      },
    ],
    [canWrite, remove],
  );

  return (
    <Card testId="fe2-hr-interviews-slots" header={<h2 className={styles.cardTitle}>面談できる日程</h2>}>
      <Stack gap={4}>
        {canWrite ? <AddSlotForm /> : null}
        {data.slots.length === 0 ? (
          <EmptyState
            testId="fe2-hr-interviews-slots-empty"
            icon="clock"
            title="まだ日程がありません"
            description="面談できる日時を追加すると、応募者が選べる候補になります。"
          />
        ) : (
          <DataTable<hrInterview.InterviewSlot> testId="fe2-hr-interviews-slot-table" columns={columns} rows={data.slots} rowKey={(s) => s.id} />
        )}
      </Stack>
      <ConfirmDialog
        testId="fe2-hr-slot-release-confirm"
        open={releasing !== null}
        title="予約を取り消しますか？"
        message={`${releasing?.applicantName ?? "応募者"}さんの予約を取り消し、面談日程調整中に戻します。応募者は同じ URL から選び直せます。取り消したことは本人に自動では届かないので、別途ご連絡ください。`}
        confirmLabel="取り消す"
        danger
        onCancel={() => setReleasing(null)}
        onConfirm={() => {
          if (releasing) release.mutate(releasing.id);
          setReleasing(null);
        }}
      />
    </Card>
  );
}

function AddSlotForm(): JSX.Element {
  const add = useAddSlot();
  const [startAt, setStartAt] = useState("");
  const [duration, setDuration] = useState(String(hrInterview.DEFAULT_SLOT_DURATION_MINUTES));
  return (
    <form
      className={styles.addForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (!startAt) return;
        add.mutate({ startAt: new Date(startAt).toISOString(), durationMinutes: Number(duration) });
        setStartAt("");
      }}
    >
      <FormField label="開始日時" htmlFor="fe2-hr-slot-start">
        <input
          id="fe2-hr-slot-start"
          data-testid="fe2-hr-slot-start"
          type="datetime-local"
          step={300}
          className={styles.dateInput}
          value={startAt}
          onChange={(e) => setStartAt(e.target.value)}
        />
      </FormField>
      <FormField label="長さ" htmlFor="fe2-hr-slot-duration">
        <Select id="fe2-hr-slot-duration" testId="fe2-hr-slot-duration" value={duration} options={DURATION_OPTIONS} onChange={setDuration} />
      </FormField>
      <Button type="submit" testId="fe2-hr-slot-add" disabled={!startAt}>
        日程を追加
      </Button>
    </form>
  );
}

function InvitesCard({ data, canWrite }: { data: Overview; canWrite: boolean }): JSX.Element {
  const send = useSendInvite();
  const columns: ColumnDef<hrInterview.InterviewInvite>[] = useMemo(
    () => [
      { key: "name", header: "氏名", noWrap: true, cell: (i) => i.applicantName },
      { key: "email", header: "メール", cell: (i) => i.email ?? "—" },
      {
        key: "status",
        header: "状況",
        noWrap: true,
        cell: (i) => (
          <span data-testid={`fe2-hr-invite-status-${i.id}`}>
            <Badge tone={INVITE_TONES[i.status]}>{hrInterview.INVITE_STATUS_LABELS[i.status]}</Badge>
            {i.lastError && i.status === "held" ? <span className={styles.failed}>送信に失敗</span> : null}
          </span>
        ),
      },
      { key: "applied", header: "申し込み", noWrap: true, cell: (i) => formatDateTime(i.createdAt) },
      { key: "sent", header: "メール送信", noWrap: true, cell: (i) => (i.sentAt ? formatDateTime(i.sentAt) : "—") },
      {
        key: "actions",
        header: "",
        noWrap: true,
        cell: (i) =>
          canWrite && i.status !== "booked" && i.email ? (
            <Button
              size="sm"
              variant="secondary"
              testId={`fe2-hr-invite-send-${i.id}`}
              loading={send.isPending && send.variables === i.id}
              onClick={() => send.mutate(i.id)}
            >
              {i.status === "held" ? "今すぐ送る" : "再送"}
            </Button>
          ) : null,
      },
    ],
    [canWrite, send],
  );
  return (
    <Card testId="fe2-hr-interviews-invites" header={<h2 className={styles.cardTitle}>応募者への案内</h2>}>
      {data.invites.length === 0 ? (
        <EmptyState
          testId="fe2-hr-interviews-invites-empty"
          icon="inbox"
          title="まだ案内はありません"
          description="面談申し込みフォームに回答があると、ここに表示されます。"
        />
      ) : (
        <DataTable<hrInterview.InterviewInvite> testId="fe2-hr-interviews-invite-table" columns={columns} rows={data.invites} rowKey={(i) => i.id} />
      )}
    </Card>
  );
}
