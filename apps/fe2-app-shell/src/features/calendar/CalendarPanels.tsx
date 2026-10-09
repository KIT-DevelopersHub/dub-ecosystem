// Google Calendar-style floating panels: the anchored popover shell, the quick
// create/edit form, the event detail card and the 他N件 day list.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, isSubmitEnter } from "@dub/ui";
import {
  TIME_OPTIONS,
  WEEKDAYS_JA,
  dateOfDay,
  formatItemWhen,
  formatTime,
  validateDraft,
  type CalendarItem,
  type EventDraft,
} from "./calendar-model";
import { PRIORITY_LABEL, statusVisual } from "./taskVisuals";
import styles from "./calendar.module.css";

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const GAP = 8;
const MARGIN = 8;

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
    top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
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
  return (
    <button type="button" className={styles.roundBtn} aria-label={label} title={label} onClick={onClick} data-testid={testId}>
      <Icon name={icon} />
    </button>
  );
}

// ── create / edit form ──────────────────────────────────────────────────────

function timeOptions(current: string): string[] {
  return TIME_OPTIONS.includes(current) ? TIME_OPTIONS : [...TIME_OPTIONS, current].sort();
}

export function EventForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  saving,
  submitLabel = "保存",
  autoFocus = true,
  secondaryAction,
}: {
  draft: EventDraft;
  onChange: (d: EventDraft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  saving: boolean;
  submitLabel?: string;
  autoFocus?: boolean;
  /** Left-aligned footer action (e.g. その他のオプション). */
  secondaryAction?: ReactNode;
}): JSX.Element {
  const error = validateDraft(draft);
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<EventDraft>) => onChange({ ...draft, ...patch });
  const submit = () => {
    setTouched(true);
    if (!error && !saving) onSubmit();
  };

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="calendar-event-form"
    >
      <input
        className={styles.titleInput}
        placeholder="タイトルを追加"
        aria-label="タイトル"
        value={draft.title}
        autoFocus={autoFocus}
        onChange={(e) => set({ title: e.target.value })}
        onKeyDown={(e) => {
          // Own Enter handling so an IME 確定 Enter never submits the form.
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (isSubmitEnter(e)) submit();
        }}
        data-testid="calendar-form-title"
      />

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="clock" />
        </span>
        <div className={styles.form} style={{ gap: "var(--dub-space-2)" }}>
          <div className={styles.whenFields}>
            <input
              type="date"
              className={styles.field}
              aria-label="開始日"
              value={draft.startDate}
              onChange={(e) => {
                const v = e.target.value;
                // Keep a single-day item single-day when its date moves, like Google.
                set(draft.endDate === draft.startDate || draft.endDate < v ? { startDate: v, endDate: v } : { startDate: v });
              }}
              data-testid="calendar-form-start-date"
            />
            {!draft.allDay && (
              <>
                <select
                  className={styles.field}
                  aria-label="開始時刻"
                  value={draft.startTime}
                  onChange={(e) => set({ startTime: e.target.value })}
                  data-testid="calendar-form-start-time"
                >
                  {timeOptions(draft.startTime).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <span>–</span>
                <select
                  className={styles.field}
                  aria-label="終了時刻"
                  value={draft.endTime}
                  onChange={(e) => set({ endTime: e.target.value })}
                  data-testid="calendar-form-end-time"
                >
                  {timeOptions(draft.endTime).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </>
            )}
            {(draft.allDay || draft.endDate !== draft.startDate) && (
              <>
                <span>–</span>
                <input
                  type="date"
                  className={styles.field}
                  aria-label="終了日"
                  value={draft.endDate}
                  min={draft.startDate}
                  onChange={(e) => set({ endDate: e.target.value })}
                  data-testid="calendar-form-end-date"
                />
              </>
            )}
          </div>
          <label className={styles.allDayLabel}>
            <input
              type="checkbox"
              checked={draft.allDay}
              onChange={(e) => set({ allDay: e.target.checked })}
              data-testid="calendar-form-allday"
            />
            終日
          </label>
        </div>
      </div>

      <div className={styles.formRow}>
        <span className={styles.formRowIcon}>
          <Icon name="list" />
        </span>
        <textarea
          className={styles.descInput}
          placeholder="説明を追加"
          aria-label="説明"
          rows={2}
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          data-testid="calendar-form-description"
        />
      </div>

      {touched && error && (
        <p role="alert" className={styles.formError} data-testid="calendar-form-error">
          {error}
        </p>
      )}

      <div className={styles.formFooter}>
        {secondaryAction}
        <span className={styles.spacer} />
        {onCancel && (
          <button type="button" className={styles.textBtn} onClick={onCancel}>
            キャンセル
          </button>
        )}
        <button type="submit" className={styles.saveBtn} disabled={saving} data-testid="calendar-form-save">
          {saving ? "保存中…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Quick-create popover (the panel Google opens on a slot click). */
export function CreatePanel({
  anchor,
  draft,
  onChange,
  onSave,
  onClose,
  onMoreOptions,
  saving,
}: {
  anchor: AnchorRect | null;
  draft: EventDraft;
  onChange: (d: EventDraft) => void;
  onSave: () => void;
  onClose: () => void;
  onMoreOptions: () => void;
  saving: boolean;
}): JSX.Element {
  return (
    <Floating anchor={anchor} width={448} onClose={onClose} label="予定を作成" testId="calendar-create-panel">
      <div className={styles.panelBar}>
        <PanelButton icon="x" label="閉じる" onClick={onClose} />
      </div>
      <div className={styles.panelBody}>
        <EventForm
          draft={draft}
          onChange={onChange}
          onSubmit={onSave}
          saving={saving}
          secondaryAction={
            <button type="button" className={styles.textBtn} onClick={onMoreOptions} data-testid="calendar-more-options">
              その他のオプション
            </button>
          }
        />
      </div>
    </Floating>
  );
}

// ── event detail ────────────────────────────────────────────────────────────

export function DetailPanel({
  anchor,
  item,
  onClose,
  onEdit,
  onDelete,
  onOpenInTasks,
  canWrite,
  canDelete,
}: {
  anchor: AnchorRect | null;
  item: CalendarItem;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenInTasks: () => void;
  canWrite: boolean;
  canDelete: boolean;
}): JSX.Element {
  const t = item.task;
  const v = statusVisual(t.status);
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
            <Icon name="calendar" />
          </span>
          <span>
            {v.label}・優先度 {PRIORITY_LABEL[t.priority]}
          </span>
        </div>
        {t.description && (
          <div className={styles.detailRow} style={{ alignItems: "start" }}>
            <span className={styles.detailRowIcon}>
              <Icon name="list" />
            </span>
            <span className={styles.detailDesc}>{t.description}</span>
          </div>
        )}
        <div className={styles.detailLink}>
          <button type="button" className={styles.textBtn} onClick={onOpenInTasks} data-testid="calendar-open-in-tasks">
            マイタスクで開く
          </button>
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
  const v = statusVisual(item.task.status);
  const title = item.task.title || "（タイトルなし）";
  const cancelled = item.task.status === "cancelled" ? styles.cancelled : "";
  const banner = item.allDay || item.startDay !== item.endDay;
  return (
    <button
      type="button"
      className={`${banner ? styles.bar : styles.monthItem} ${cancelled} ${className ?? ""}`}
      style={banner ? { background: v.color, ...style } : style}
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
          {title}
        </>
      ) : (
        <>
          <span className={styles.dot} style={{ background: v.color }} />
          <span className={styles.monthItemTime}>{formatTime(item.start!)}</span>
          <span className={styles.monthItemTitle}>{title}</span>
        </>
      )}
    </button>
  );
}
