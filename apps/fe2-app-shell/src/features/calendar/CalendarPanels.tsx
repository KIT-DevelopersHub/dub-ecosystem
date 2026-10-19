// Calendar panels: the create/edit dialog (@dub/ui Modal), plus Google-style
// anchored popovers for the event detail card and the 他N件 day list.
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { task } from "@dub/types";
import {
  Button,
  Checkbox,
  DatePicker,
  Icon,
  IconButton,
  Modal,
  SegmentedControl,
  Select,
  Spinner,
  TextField,
  Textarea,
  isSubmitEnter,
  type SegmentedOption,
} from "@dub/ui";
import {
  TIME_OPTIONS,
  VACATION_TITLE,
  WEEKDAYS_JA,
  dateOfDay,
  formatItemWhen,
  formatTime,
  ITEM_KINDS,
  isPendingMeetingTask,
  isScheduleTask,
  isVacationTask,
  kindOf,
  userDescription,
  validateDraft,
  withKind,
  type CalendarItem,
  type EventDraft,
  type ItemKind,
} from "./calendar-model";
import { KIND_ICON, KIND_VISUALS, PRIORITY_LABEL, UNTITLED_TITLE, itemVisual, type CalendarLabel } from "./taskVisuals";
import styles from "./calendar.module.css";

/** How an item's title reads on the grids ("<owner>：<title>"); the screen provides it. */
const ItemTitleCtx = createContext<(t: task.Task) => string>((t) => t.title || UNTITLED_TITLE);
export const ItemTitleProvider = ItemTitleCtx.Provider;
export function useItemTitle(): (t: task.Task) => string {
  return useContext(ItemTitleCtx);
}

/** Spinner + 「作成中…」 on a meeting the server has not confirmed yet. */
export function PendingMark({ task: t }: { task: task.Task }): JSX.Element | null {
  if (!isPendingMeetingTask(t)) return null;
  return (
    <span className={styles.pendingMark} data-feature="meet-create-pending" data-testid="calendar-item-pending">
      <Spinner size="sm" aria-label="作成中" />
      作成中…
    </span>
  );
}

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const GAP = 8;
const MARGIN = 8;
/** Keep clear of bottom-anchored chrome (demo banner / feedback button). */
const BOTTOM_MARGIN = 48;

/** Fixed panel placed beside `anchor` (right, else left, else centered), clamped
 *  to the viewport. Closes on Escape and on a pointer-down outside it. */
export function Floating({
  anchor,
  width,
  onClose,
  label,
  testId,
  children,
}: {
  anchor: AnchorRect | null;
  width: number;
  onClose: () => void;
  label: string;
  testId: string;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - MARGIN * 2);
    const h = el.offsetHeight;
    let left: number;
    let top: number;
    if (!anchor) {
      left = (vw - w) / 2;
      top = Math.max(MARGIN, (vh - h) / 3);
    } else {
      if (anchor.right + GAP + w <= vw - MARGIN) left = anchor.right + GAP;
      else if (anchor.left - GAP - w >= MARGIN) left = anchor.left - GAP - w;
      else left = (vw - w) / 2;
      top = anchor.top;
    }
    top = Math.max(MARGIN, Math.min(top, vh - h - BOTTOM_MARGIN));
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
    setPos({ left, top });
  }, [anchor, width]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-testid={testId}
      className={styles.floating}
      style={{
        width,
        maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>
  );
}

function PanelButton({
  icon,
  label,
  onClick,
  testId,
}: {
  icon: "edit" | "trash" | "x" | "external-link";
  label: string;
  onClick: () => void;
  testId?: string;
}): JSX.Element {
  return <IconButton name={icon} aria-label={label} onClick={onClick} testId={testId} />;
}

// ── create / edit form ──────────────────────────────────────────────────────

function timeOptions(current: string): { value: string; label: string }[] {
  const all = TIME_OPTIONS.includes(current) ? TIME_OPTIONS : [...TIME_OPTIONS, current].sort();
  return all.map((t) => ({ value: t, label: t }));
}

const KIND_OPTIONS: SegmentedOption<ItemKind>[] = ITEM_KINDS.map((k) => ({
  value: k,
  label: KIND_VISUALS[k].label,
  icon: KIND_ICON[k],
  testId: `calendar-kind-${k}`,
}));

/** Label choices; keeps a label whose role is gone (or not loaded yet) selectable. */
function labelOptions(labels: readonly CalendarLabel[], current: string): { value: string; label: string }[] {
  const opts = labels.map((l) => ({ value: l.key, label: l.name }));
  return opts.some((o) => o.value === current) ? opts : [...opts, { value: current, label: "（不明なロール）" }];
}

export function EventForm({
  draft,
  labels,
  onChange,
  onSubmit,
  onCancel,
  saving,
  submitLabel = "保存",
}: {
  draft: EventDraft;
  labels: readonly CalendarLabel[];
  onChange: (d: EventDraft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  saving: boolean;
  submitLabel?: string;
}): JSX.Element {
  const id = useId();
  const error = validateDraft(draft);
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<EventDraft>) => onChange({ ...draft, ...patch });
  const submit = () => {
    setTouched(true);
    if (!error && !saving) onSubmit();
  };
  const vacation = draft.kind === "vacation";

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="calendar-event-form"
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
          placeholder={vacation ? VACATION_TITLE : "タイトルを追加"}
          value={draft.title}
          onChange={(title) => set({ title })}
          testId="calendar-form-title"
        />
      </span>
      <SegmentedControl
        options={KIND_OPTIONS}
        value={draft.kind}
        onChange={(k) => onChange(withKind(draft, k))}
        size="sm"
        aria-label="種類"
        testId="calendar-kind-switch"
      />

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="clock" />
        </span>
        <div className={styles.whenBlock}>
          <div className={styles.whenFields}>
            <span className={styles.dateField}>
              <DatePicker
                id={`${id}-start-date`}
                value={draft.startDate}
                onChange={(v) => {
                  if (!v) return;
                  // Keep a single-day item single-day when its date moves, like Google.
                  set(draft.endDate === draft.startDate || draft.endDate < v ? { startDate: v, endDate: v } : { startDate: v });
                }}
                testId="calendar-form-start-date"
              />
            </span>
            {!draft.allDay && (
              <>
                <span className={styles.timeField}>
                  <Select
                    id={`${id}-start-time`}
                    value={draft.startTime}
                    onChange={(v) => set({ startTime: v })}
                    options={timeOptions(draft.startTime)}
                    testId="calendar-form-start-time"
                  />
                </span>
                <span className={styles.whenDash}>–</span>
                <span className={styles.timeField}>
                  <Select
                    id={`${id}-end-time`}
                    value={draft.endTime}
                    onChange={(v) => set({ endTime: v })}
                    options={timeOptions(draft.endTime)}
                    testId="calendar-form-end-time"
                  />
                </span>
              </>
            )}
            {(draft.allDay || draft.endDate !== draft.startDate) && (
              <>
                <span className={styles.whenDash}>–</span>
                <span className={styles.dateField}>
                  <DatePicker
                    id={`${id}-end-date`}
                    value={draft.endDate}
                    min={draft.startDate}
                    onChange={(v) => v && set({ endDate: v })}
                    testId="calendar-form-end-date"
                  />
                </span>
              </>
            )}
          </div>
          <Checkbox
            id={`${id}-allday`}
            checked={draft.allDay}
            onChange={(allDay) => set({ allDay })}
            label="終日"
            testId="calendar-form-allday"
          />
        </div>
      </div>

      {vacation && (
        <div className={styles.formRow}>
          <span className={styles.formRowIcon}>
            <Icon name="sun" />
          </span>
          <p className={styles.rowNote} data-testid="calendar-vacation-note">
            休暇中であることがカレンダーに表示されます
          </p>
        </div>
      )}

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="list" />
        </span>
        <Textarea
          id={`${id}-description`}
          placeholder={vacation ? "メッセージを追加" : "説明を追加"}
          rows={2}
          value={draft.description}
          onChange={(description) => set({ description })}
          testId="calendar-form-description"
        />
      </div>

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="users" />
        </span>
        <span className={styles.labelField}>
          <label htmlFor={`${id}-label`} className={styles.srOnly}>
            ラベル
          </label>
          <Select
            id={`${id}-label`}
            value={draft.label}
            onChange={(label) => set({ label })}
            options={labelOptions(labels, draft.label)}
            testId="calendar-form-label"
          />
        </span>
      </div>

      {touched && error && (
        <p role="alert" className={styles.formError} data-testid="calendar-form-error">
          {error}
        </p>
      )}

      <div className={styles.formFooter}>
        <span className={styles.spacer} />
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            キャンセル
          </Button>
        )}
        <Button type="submit" loading={saving} testId="calendar-form-save">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Create / edit dialog — the standard @dub/ui Modal (slot click, 作成, 編集). */
export function EventDialog({
  editing,
  draft,
  labels,
  onChange,
  onSave,
  onClose,
  saving,
}: {
  editing: boolean;
  draft: EventDraft;
  labels: readonly CalendarLabel[];
  onChange: (d: EventDraft) => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
}): JSX.Element {
  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? "予定を編集" : "予定を作成"}
      size="md"
      testId={editing ? "calendar-edit-dialog" : "calendar-create-panel"}
    >
      <EventForm draft={draft} labels={labels} onChange={onChange} onSubmit={onSave} onCancel={onClose} saving={saving} />
    </Modal>
  );
}

// ── event detail ────────────────────────────────────────────────────────────

export function DetailPanel({
  anchor,
  item,
  labelName,
  onClose,
  onEdit,
  onDelete,
  onOpenInTasks,
  canWrite,
  canDelete,
}: {
  anchor: AnchorRect | null;
  item: CalendarItem;
  labelName: string;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenInTasks: () => void;
  canWrite: boolean;
  canDelete: boolean;
}): JSX.Element {
  const t = item.task;
  const v = itemVisual(t);
  const kind = isScheduleTask(t) ? kindOf(t) : null;
  const desc = userDescription(t);
  return (
    <Floating anchor={anchor} width={448} onClose={onClose} label={t.title} testId="calendar-event-detail">
      <div className={`${styles.panelBar} ${styles.panelBarPlain}`}>
        {canWrite && <PanelButton icon="edit" label="予定を編集" onClick={onEdit} testId="calendar-detail-edit" />}
        {canDelete && <PanelButton icon="trash" label="予定を削除" onClick={onDelete} testId="calendar-detail-delete" />}
        <PanelButton icon="x" label="閉じる" onClick={onClose} />
      </div>
      <div className={styles.panelBody}>
        <div className={styles.detailHead}>
          <span className={styles.colorSquare} style={{ background: v.color }} />
          <div>
            <h2 className={`${styles.detailTitle} ${t.status === "cancelled" ? styles.cancelled : ""}`}>
              {t.title || "（タイトルなし）"}
            </h2>
            <div className={styles.detailWhen} data-testid="calendar-detail-when">
              {formatItemWhen(item)}
            </div>
          </div>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailRowIcon}>
            <Icon name={kind ? KIND_ICON[kind] : "task"} />
          </span>
          <span data-testid="calendar-detail-kind">
            {kind ? `予定・${KIND_VISUALS[kind].label}` : `タスク・${v.label}・優先度 ${PRIORITY_LABEL[t.priority]}`}
          </span>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailRowIcon}>
            <Icon name="users" />
          </span>
          <span data-testid="calendar-detail-label">{labelName}</span>
        </div>
        {desc && (
          <div className={styles.detailRow} style={{ alignItems: "start" }}>
            <span className={styles.detailRowIcon}>
              <Icon name="list" />
            </span>
            <span className={styles.detailDesc}>{desc}</span>
          </div>
        )}
        <div className={styles.detailLink}>
          <Button variant="ghost" size="sm" onClick={onOpenInTasks} testId="calendar-open-in-tasks">
            マイタスクで開く
          </Button>
        </div>
      </div>
    </Floating>
  );
}

// ── 他N件: every item of one day ─────────────────────────────────────────────

export function DayListPanel({
  anchor,
  day,
  items,
  onClose,
  onSelect,
  onOpenDay,
}: {
  anchor: AnchorRect | null;
  day: number;
  items: CalendarItem[];
  onClose: () => void;
  onSelect: (it: CalendarItem, anchor: AnchorRect) => void;
  onOpenDay: () => void;
}): JSX.Element {
  const d = dateOfDay(day);
  return (
    <Floating anchor={anchor} width={240} onClose={onClose} label={`${d.getMonth() + 1}月${d.getDate()}日の予定`} testId="calendar-day-list">
      <div className={`${styles.panelBar} ${styles.panelBarPlain}`}>
        <PanelButton icon="x" label="閉じる" onClick={onClose} />
      </div>
      <div className={styles.panelBody} style={{ paddingLeft: "var(--dub-space-3)", paddingRight: "var(--dub-space-3)" }}>
        <div className={styles.dayListHead}>
          <div className={styles.dayListWeekday}>{WEEKDAYS_JA[d.getDay()]}</div>
          <button type="button" className={`${styles.tgDateNum} ${styles.dayListNum}`} onClick={onOpenDay}>
            {d.getDate()}
          </button>
        </div>
        <div className={styles.dayListItems}>
          {items.map((it) => (
            <ItemButton key={it.task.id} item={it} onSelect={onSelect} />
          ))}
        </div>
      </div>
    </Floating>
  );
}

export function rectOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** A month-style item: a solid bar for 終日, a dot + time row for timed. */
export function ItemButton({
  item,
  onSelect,
  className,
  style,
}: {
  item: CalendarItem;
  onSelect: (it: CalendarItem, anchor: AnchorRect) => void;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  const v = itemVisual(item.task);
  const title = useItemTitle()(item.task);
  const cancelled = item.task.status === "cancelled" ? styles.cancelled : "";
  const banner = item.allDay || item.startDay !== item.endDay;
  const vacation = banner && isVacationTask(item.task) ? styles.vacation : "";
  return (
    <button
      type="button"
      className={`${banner ? styles.bar : styles.monthItem} ${cancelled} ${vacation} ${className ?? ""}`}
      style={banner ? { backgroundColor: v.color, ...style } : style}
      title={`${title}（${formatItemWhen(item)}）`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(item, rectOf(e.currentTarget));
      }}
      data-testid={`calendar-item-${item.task.id}`}
    >
      {banner ? (
        <>
          {!item.allDay && `${formatTime(item.start!)} `}
          <PendingMark task={item.task} />
          {title}
        </>
      ) : (
        <>
          <span className={styles.dot} style={{ background: v.color }} />
          <span className={styles.monthItemTime}>{formatTime(item.start!)}</span>
          <span className={styles.monthItemTitle}>
            <PendingMark task={item.task} />
            {title}
          </span>
        </>
      )}
    </button>
  );
}
