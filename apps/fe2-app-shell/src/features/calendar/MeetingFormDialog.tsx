// 定例ミーティングを設定 / 編集 dialog. Renders inside the @dub/ui Modal portal, so only
// global @dub/tokens variables are used for colors (feature CSS variables do not reach it).
import { useEffect, useState } from "react";
import { Button, DatePicker, FormField, Modal, Select, TextField, Textarea } from "@dub/ui";
import type { meeting } from "@dub/types";
import {
  DURATION_OPTIONS,
  TIME_OPTIONS,
  emptyMeetingForm,
  meetingToForm,
  toMeetingRequest,
  validateMeetingForm,
  type MeetingFormErrors,
  type MeetingFormValues,
} from "./meeting-form";
import { recurrenceLabel } from "./meeting-occurrences";
import styles from "./calendar.module.css";

const hintStyle = {
  margin: 0,
  padding: "var(--dub-space-3) var(--dub-space-4)",
  borderRadius: "var(--dub-radius-md)",
  background: "var(--dub-color-info-50, #eff8ff)",
  color: "var(--dub-color-text-secondary)",
  fontSize: "var(--dub-font-size-sm)",
  lineHeight: 1.6,
} as const;

function durationLabel(min: number): string {
  if (min < 60) return `${min}分`;
  return min % 60 === 0 ? `${min / 60}時間` : `${Math.floor(min / 60)}時間${min % 60}分`;
}

export function MeetingFormDialog({
  open,
  editing,
  targets,
  accountEmail,
  onClose,
  onSubmit,
}: {
  open: boolean;
  /** null = create. */
  editing: meeting.Meeting | null;
  targets: readonly meeting.MeetingTarget[];
  accountEmail: string | null;
  onClose: () => void;
  onSubmit: (body: meeting.CreateMeetingRequest) => void;
}): JSX.Element | null {
  const [form, setForm] = useState<MeetingFormValues>(() => (editing ? meetingToForm(editing) : emptyMeetingForm()));
  const [errors, setErrors] = useState<MeetingFormErrors>({});

  useEffect(() => {
    if (!open) return;
    setForm(editing ? meetingToForm(editing) : emptyMeetingForm());
    setErrors({});
  }, [open, editing]);

  if (!open) return null;

  const set = <K extends keyof MeetingFormValues>(k: K, v: MeetingFormValues[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = () => {
    const e = validateMeetingForm(form);
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    onSubmit(toMeetingRequest(form));
  };

  const anchor = form.date || emptyMeetingForm().date;
  const recurrenceOptions: { value: meeting.MeetingRecurrence; label: string }[] = (
    ["none", "weekly", "biweekly", "monthly_weekday"] as const
  ).map((r) => ({ value: r, label: recurrenceLabel(r, anchor) }));
  const targetOptions = targets.map((t) => ({ value: t.id, label: `${t.name}（${t.memberCount}人）` }));
  const tid = "calendar-meeting-form";

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? "ミーティングを編集" : "定例ミーティングを設定"}
      size="md"
      testId={tid}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--dub-space-3)" }}>
          <Button variant="ghost" onClick={onClose} testId={`${tid}-cancel`}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={submit} testId={`${tid}-submit`}>
            {editing ? "保存" : "登録"}
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--dub-space-5)" }}>
        <p style={hintStyle} data-testid={`${tid}-hint`}>
          共有アカウント（{accountEmail ?? "未接続"}）で Google カレンダーに登録し、Meet を発行して対象のメンバーを招待します。メンバーが増減すると招待も自動で追従します。
        </p>

        <FormField label="タイトル" htmlFor={`${tid}-title`} required error={errors.title}>
          <TextField id={`${tid}-title`} value={form.title} onChange={(v) => set("title", v)} placeholder="例: 全体定例" testId={`${tid}-title`} />
        </FormField>

        <FormField label="対象" htmlFor={`${tid}-target`} required error={errors.targetId} help="対象のメンバー全員を招待します">
          <Select id={`${tid}-target`} value={form.targetId || null} onChange={(v) => set("targetId", v)} options={targetOptions} placeholder="選択してください" testId={`${tid}-target`} />
        </FormField>

        <div className={styles.formRow}>
          <div className={styles.dateField}>
            <FormField label="日付" htmlFor={`${tid}-date`} required error={errors.date}>
              <DatePicker id={`${tid}-date`} value={form.date || null} onChange={(v) => set("date", v ?? "")} testId={`${tid}-date`} />
            </FormField>
          </div>
          <FormField label="開始時刻" htmlFor={`${tid}-time`} required error={errors.time}>
            <Select id={`${tid}-time`} value={form.time || null} onChange={(v) => set("time", v)} options={TIME_OPTIONS.map((t) => ({ value: t, label: t }))} testId={`${tid}-time`} />
          </FormField>
          <FormField label="所要時間" htmlFor={`${tid}-duration`} required error={errors.durationMinutes}>
            <Select
              id={`${tid}-duration`}
              value={String(form.durationMinutes)}
              onChange={(v) => set("durationMinutes", Number(v))}
              options={DURATION_OPTIONS.map((d) => ({ value: String(d), label: durationLabel(d) }))}
              testId={`${tid}-duration`}
            />
          </FormField>
        </div>

        <div className={styles.formRow}>
          <FormField label="繰り返し" htmlFor={`${tid}-recurrence`} error={errors.recurrence}>
            <Select<meeting.MeetingRecurrence>
              id={`${tid}-recurrence`}
              value={form.recurrence}
              onChange={(v) => set("recurrence", v)}
              options={recurrenceOptions}
              testId={`${tid}-recurrence`}
            />
          </FormField>
          {form.recurrence !== "none" ? (
            <div className={styles.dateField}>
              <FormField label="終了日（任意）" htmlFor={`${tid}-until`} error={errors.until} help="空欄なら終了しません">
                <DatePicker id={`${tid}-until`} value={form.until || null} min={form.date || undefined} onChange={(v) => set("until", v ?? "")} testId={`${tid}-until`} />
              </FormField>
            </div>
          ) : null}
        </div>

        <FormField label="メモ" htmlFor={`${tid}-description`} help="Google カレンダーの予定の説明欄に入ります">
          <Textarea id={`${tid}-description`} value={form.description} onChange={(v) => set("description", v)} rows={3} testId={`${tid}-description`} />
        </FormField>
      </div>
    </Modal>
  );
}
