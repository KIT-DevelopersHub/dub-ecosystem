// The one ミーティング form: 作成 > ミーティング and ミーティングを編集 all
// render this inside the 作成 dialog's layout (icon rows, like EventForm). It registers a real
// meeting (Google Calendar + Meet + invites) through toMeetingRequest — the payload is unchanged.
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button, Checkbox, DatePicker, Icon, Select, TextField, Textarea, isSubmitEnter } from "@dub/ui";
import { ChipSelect, type ChipSelectOption } from "@dub/app-ui";
import { meeting as meetingValues, type meeting } from "@dub/types";
import {
  targetFromValue,
  targetValue,
  DURATION_OPTIONS,
  TIME_OPTIONS,
  toMeetingRequest,
  validateMeetingForm,
  type MeetingFormErrors,
  type MeetingFormValues,
} from "./meeting-form";
import { recurrenceLabel } from "./meeting-occurrences";
import styles from "./calendar.module.css";

const RECURRENCES = ["none", "weekly", "biweekly", "monthly_weekday"] as const;

function durationLabel(min: number): string {
  if (min < 60) return `${min}分`;
  return min % 60 === 0 ? `${min / 60}時間` : `${Math.floor(min / 60)}時間${min % 60}分`;
}

/** Chip / option for each target: 全体 and roles as groups (brand chip, people icon), members
 *  as single people (neutral chip, person icon). */
function targetOptions(targets: readonly meeting.MeetingTarget[], people: readonly meeting.MeetingPersonOption[]): ChipSelectOption[] {
  return [
    ...targets.map((t) => ({
      value: targetValue(t.id === "all" ? { kind: "all", id: t.id } : { kind: "role", id: t.id }),
      label: t.name,
      description: t.id === "all" ? `アクティブなメンバー全員・${t.memberCount}人` : `ロール・${t.memberCount}人`,
      icon: <Icon name="users" size="sm" />,
      tone: "brand" as const,
      kind: t.id === "all" ? "全体" : "ロール",
    })),
    ...people.map((p) => ({
      value: targetValue({ kind: "person", id: p.id }),
      label: p.name,
      description: "メンバー",
      icon: <Icon name="user" size="sm" />,
      tone: "neutral" as const,
      kind: "メンバー",
    })),
  ];
}

function FieldError({ text, testId }: { text: string | undefined; testId: string }): JSX.Element | null {
  return text ? (
    <p role="alert" className={styles.formError} data-testid={testId}>
      {text}
    </p>
  ) : null;
}

export function MeetingForm({
  form,
  onChange,
  editing,
  targets,
  people = [],
  targetsLoading = false,
  accountEmail,
  kindSwitch,
  saving = false,
  onSubmit,
  onCancel,
}: {
  form: MeetingFormValues;
  onChange: (f: MeetingFormValues) => void;
  /** null = create. */
  editing: meeting.Meeting | null;
  targets: readonly meeting.MeetingTarget[];
  /** Members that can be added one by one. */
  people?: readonly meeting.MeetingPersonOption[];
  /** The targets / people are still loading (the field shows skeleton rows). */
  targetsLoading?: boolean;
  accountEmail: string | null;
  /** The 作成 dialog's 種類 switch (absent when editing). */
  kindSwitch?: ReactNode;
  /** A meeting is still being registered: no second one meanwhile. */
  saving?: boolean;
  onSubmit: (body: meeting.CreateMeetingRequest) => void;
  onCancel: () => void;
}): JSX.Element {
  const id = useId();
  const tid = "calendar-meeting-form";
  const [errors, setErrors] = useState<MeetingFormErrors>({});

  const options = useMemo(() => targetOptions(targets, people), [targets, people]);
  // A target the list no longer has (deleted role / gone member) keeps its name from the meeting.
  const fallbackOption = useMemo(() => {
    const known = new Map((editing ? meetingValues.targetsOfMeeting(editing) : []).map((t) => [targetValue(t), t]));
    return (v: string): ChipSelectOption => {
      const t = known.get(v);
      const person = v.startsWith("person:");
      return { value: v, label: t?.name ?? (person ? "（無効なメンバー）" : "（削除されたロール）"), tone: person ? "neutral" : "brand", icon: <Icon name={person ? "user" : "users"} size="sm" /> };
    };
  }, [editing]);

  const set = <K extends keyof MeetingFormValues>(k: K, v: MeetingFormValues[K]) => {
    onChange({ ...form, [k]: v });
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = () => {
    const e = validateMeetingForm(form);
    setErrors(e);
    if (saving || Object.values(e).some(Boolean)) return;
    onSubmit(toMeetingRequest(form));
  };

  const anchor = form.date;
  const whenError = errors.date ?? errors.time ?? errors.durationMinutes;

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid={tid}
    >
      <label htmlFor={`${id}-title`} className={styles.srOnly}>
        タイトル
      </label>
      <span
        // Own Enter handling so an IME 確定 Enter never submits the form.
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (isSubmitEnter(e)) submit();
        }}
      >
        <TextField
          id={`${id}-title`}
          size="lg"
          placeholder="タイトルを追加（例: 全体定例）"
          value={form.title}
          onChange={(v) => set("title", v)}
          invalid={!!errors.title}
          testId={`${tid}-title`}
        />
      </span>
      <FieldError text={errors.title} testId={`${tid}-title-error`} />
      {kindSwitch}

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="clock" />
        </span>
        <div className={styles.whenBlock}>
          <div className={styles.whenFields}>
            <label htmlFor={`${id}-date`} className={styles.srOnly}>
              日付
            </label>
            <span className={styles.dateField}>
              <DatePicker id={`${id}-date`} value={form.date || null} onChange={(v) => set("date", v ?? "")} testId={`${tid}-date`} />
            </span>
            <label htmlFor={`${id}-time`} className={styles.srOnly}>
              開始時刻
            </label>
            <span className={styles.timeField}>
              <Select id={`${id}-time`} value={form.time || null} onChange={(v) => set("time", v)} options={TIME_OPTIONS.map((t) => ({ value: t, label: t }))} testId={`${tid}-time`} />
            </span>
            <label htmlFor={`${id}-duration`} className={styles.srOnly}>
              所要時間
            </label>
            <span className={styles.durationField}>
              <Select
                id={`${id}-duration`}
                value={String(form.durationMinutes)}
                onChange={(v) => set("durationMinutes", Number(v))}
                options={DURATION_OPTIONS.map((d) => ({ value: String(d), label: durationLabel(d) }))}
                testId={`${tid}-duration`}
              />
            </span>
          </div>
          <FieldError text={whenError} testId={`${tid}-when-error`} />
        </div>
      </div>

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="refresh" />
        </span>
        <div className={styles.repeatField}>
          <div className={styles.whenFields}>
            <label htmlFor={`${id}-recurrence`} className={styles.srOnly}>
              繰り返し
            </label>
            <span className={styles.repeatSelect}>
              <Select<meeting.MeetingRecurrence>
                id={`${id}-recurrence`}
                value={form.recurrence}
                onChange={(v) => set("recurrence", v)}
                options={RECURRENCES.map((r) => ({ value: r, label: recurrenceLabel(r, anchor) }))}
                testId={`${tid}-recurrence`}
              />
            </span>
            {form.recurrence !== "none" && (
              <>
                <label htmlFor={`${id}-until`} className={styles.whenDash}>
                  終了日
                </label>
                <span className={styles.dateField}>
                  <DatePicker id={`${id}-until`} value={form.until || null} min={form.date || undefined} onChange={(v) => set("until", v ?? "")} testId={`${tid}-until`} />
                </span>
              </>
            )}
          </div>
          {form.recurrence !== "none" && <p className={styles.rowNote}>終了日が空欄なら終了しません</p>}
          <FieldError text={errors.recurrence ?? errors.until} testId={`${tid}-until-error`} />
        </div>
      </div>

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="users" />
        </span>
        <div className={styles.repeatField}>
          <label htmlFor={`${id}-target`} className={styles.srOnly}>
            対象
          </label>
          <ChipSelect
            id={`${id}-target`}
            testId={`${tid}-target`}
            aria-label="対象を追加"
            value={form.targets.map(targetValue)}
            onChange={(vs) => set("targets", vs.map(targetFromValue).filter((t): t is meeting.MeetingTargetRef => t !== null))}
            options={options}
            fallbackOption={fallbackOption}
            loading={targetsLoading}
            invalid={!!errors.targets}
            placeholder="ロールやメンバーの名前を入力"
          />
          <p className={styles.rowNote}>全体・ロール・メンバーを追加できます（複数可）。どれかに含まれる人を全員招待します</p>
          <FieldError text={errors.targets} testId={`${tid}-target-error`} />
        </div>
      </div>

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="list" />
        </span>
        <div className={styles.repeatField}>
          <label htmlFor={`${id}-description`} className={styles.srOnly}>
            メモ
          </label>
          <Textarea id={`${id}-description`} placeholder="説明を追加" rows={2} value={form.description} onChange={(v) => set("description", v)} testId={`${tid}-description`} />
          <p className={styles.rowNote}>Google カレンダーの予定の説明欄に入ります</p>
        </div>
      </div>

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="check" />
        </span>
        <div className={styles.repeatField}>
          <Checkbox
            id={`${id}-track`}
            testId={`${tid}-track`}
            checked={form.trackAttendance}
            label={form.targets.some((t) => t.kind === "all") ? "全体定例として出席を取る" : "チーム定例として出席を取る"}
            onChange={(v) => set("trackAttendance", v)}
          />
          <p className={styles.rowNote}>Dub（ダッシュボードの「定例に参加」）から Meet に入った人を出席として記録します。出席は 人事 → 出席 で確認できます</p>
        </div>
      </div>

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="info" />
        </span>
        <p className={styles.rowNote} data-testid={`${tid}-hint`}>
          共有アカウント（{accountEmail ?? "未接続"}）で Google カレンダーに登録し、Meet を発行して対象のメンバーを招待します。メンバーが増減すると招待も自動で追従します。
        </p>
      </div>

      <div className={styles.formFooter}>
        <span className={styles.spacer} />
        <Button variant="ghost" onClick={onCancel} testId={`${tid}-cancel`}>
          キャンセル
        </Button>
        <Button type="submit" disabled={saving} loading={saving} testId={`${tid}-submit`}>
          {saving ? "作成中…" : editing ? "保存" : "登録"}
        </Button>
      </div>
    </form>
  );
}
