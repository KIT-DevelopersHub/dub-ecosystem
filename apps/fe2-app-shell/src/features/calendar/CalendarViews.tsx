// The four Google Calendar views (日/週 time grid, 月, スケジュール) and the sidebar
// mini calendar. Presentation only: layout math lives in calendar-model.ts and all
// state/mutations in CalendarScreen.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@dub/ui";
import {
  WEEKDAYS_JA,
  addMonthsDay,
  dateOfDay,
  dayIndexOf,
  dayKeyOf,
  formatHourLabel,
  formatTime,
  isBannerItem,
  itemsOnDay,
  layoutSpans,
  layoutTimedDay,
  minutesToHHMM,
  monthGridDays,
  startOfMonthDay,
  timedItemsOn,
  type CalendarItem,
} from "./calendar-model";
import { ItemButton, rectOf, type AnchorRect } from "./CalendarPanels.tsx";
import { statusVisual } from "./taskVisuals";
import styles from "./calendar.module.css";

const HOUR_PX = 48;
const ROW_PX = 22;
const SNAP_MIN = 15;

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

function ChevronLeft(): JSX.Element {
  return (
    <span className={styles.flip}>
      <Icon name="chevron-right" />
    </span>
  );
}

// ── mini calendar ───────────────────────────────────────────────────────────

export function MiniCalendar({
  selectedDay,
  today,
  onSelect,
}: {
  selectedDay: number;
  today: number;
  onSelect: (day: number) => void;
}): JSX.Element {
  const [month, setMonth] = useState(() => startOfMonthDay(selectedDay));
  // Follow the main view when it moves to another month.
  useEffect(() => setMonth(startOfMonthDay(selectedDay)), [selectedDay]);
  const m = dateOfDay(month);
  const days = monthGridDays(month);
  return (
    <div className={styles.mini} data-testid="calendar-mini">
      <div className={styles.miniHead}>
        <span>
          {m.getFullYear()}年 {m.getMonth() + 1}月
        </span>
        <span className={styles.miniNav}>
          <button type="button" className={styles.roundBtn} aria-label="前月" onClick={() => setMonth((x) => addMonthsDay(x, -1))}>
            <ChevronLeft />
          </button>
          <button type="button" className={styles.roundBtn} aria-label="翌月" onClick={() => setMonth((x) => addMonthsDay(x, 1))}>
            <Icon name="chevron-right" />
          </button>
        </span>
      </div>
      <div className={styles.miniGrid}>
        {WEEKDAYS_JA.map((w) => (
          <span key={w} className={styles.miniWeekday}>
            {w}
          </span>
        ))}
        {days.map((d) => {
          const date = dateOfDay(d);
          return (
            <button
              key={d}
              type="button"
              className={cx(
                styles.miniDay,
                date.getMonth() !== m.getMonth() && styles.miniOutside,
                d === selectedDay && styles.miniSelected,
                d === today && styles.miniToday,
              )}
              aria-label={`${date.getMonth() + 1}月${date.getDate()}日`}
              aria-current={d === today ? "date" : undefined}
              onClick={() => onSelect(d)}
              data-testid={`calendar-mini-${dayKeyOf(d)}`}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── 日 / 週: time grid ───────────────────────────────────────────────────────

export interface SlotGhost {
  day: number;
  startMin: number;
  endMin: number;
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function TimeGrid({
  days,
  today,
  items,
  ghost,
  canCreate,
  onCreateTimed,
  onCreateAllDay,
  onSelectItem,
  onOpenDay,
}: {
  days: number[];
  today: number;
  items: CalendarItem[];
  ghost: SlotGhost | null;
  canCreate: boolean;
  onCreateTimed: (day: number, startMin: number, endMin: number, anchor: AnchorRect) => void;
  onCreateAllDay: (day: number, anchor: AnchorRect) => void;
  onSelectItem: (it: CalendarItem, anchor: AnchorRect) => void;
  onOpenDay: (day: number) => void;
}): JSX.Element {
  const now = useNow();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ day: number; a: number; b: number; col: HTMLElement } | null>(null);
  const cols = `repeat(${days.length}, minmax(0, 1fr))`;
  const firstDay = days[0]!;

  const banners = useMemo(() => layoutSpans(items.filter(isBannerItem), firstDay, days.length), [items, firstDay, days.length]);
  const laneCount = banners.reduce((n, b) => Math.max(n, b.lane + 1), 0);

  // Open scrolled to the working day (or just above "now" when today is shown).
  const showsToday = days.includes(today);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = showsToday ? Math.max(0, (new Date().getHours() - 2) * HOUR_PX) : 7.5 * HOUR_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDay, days.length]);

  const minuteAt = (e: ReactPointerEvent, col: HTMLElement) => {
    const y = e.clientY - col.getBoundingClientRect().top;
    return Math.max(0, Math.min(24 * 60 - SNAP_MIN, Math.floor(((y / HOUR_PX) * 60) / SNAP_MIN) * SNAP_MIN));
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>, day: number) => {
    if (!canCreate || e.button !== 0) return;
    const col = e.currentTarget;
    const m = minuteAt(e, col);
    col.setPointerCapture?.(e.pointerId);
    setDrag({ day, a: m, b: m, col });
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const m = minuteAt(e, drag.col);
    if (m !== drag.b) setDrag({ ...drag, b: m });
  };
  const onUp = () => {
    if (!drag) return;
    const { day, a, b, col } = drag;
    setDrag(null);
    let startMin: number;
    let endMin: number;
    if (a === b) {
      // A click books an hour from the half-hour it landed in (Google's default).
      startMin = Math.floor(a / 30) * 30;
      endMin = Math.min(24 * 60, startMin + 60);
    } else {
      startMin = Math.min(a, b);
      endMin = Math.max(a, b) + SNAP_MIN;
    }
    const r = col.getBoundingClientRect();
    onCreateTimed(day, startMin, endMin, {
      left: r.left,
      right: r.right,
      top: r.top + (startMin / 60) * HOUR_PX,
      bottom: r.top + (endMin / 60) * HOUR_PX,
    });
  };

  const liveGhost: SlotGhost | null = drag
    ? { day: drag.day, startMin: Math.min(drag.a, drag.b), endMin: Math.max(drag.a, drag.b) + SNAP_MIN }
    : ghost;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowDay = dayIndexOf(now);

  return (
    <div className={styles.main} data-testid="calendar-timegrid">
      <div className={styles.tgHead}>
        <div className={styles.tgGutterHead}>{`GMT${formatOffset(now)}`}</div>
        <div className={styles.tgHeadCols}>
          <div className={styles.tgDayHeads} style={{ gridTemplateColumns: cols }}>
            {days.map((d) => {
              const date = dateOfDay(d);
              return (
                <div
                  key={d}
                  className={cx(styles.tgDayHead, d === today && styles.tgTodayHead)}
                  role="columnheader"
                  data-testid={`calendar-dayhead-${dayKeyOf(d)}`}
                >
                  <span className={styles.tgWeekday}>{WEEKDAYS_JA[date.getDay()]}</span>
                  <button
                    type="button"
                    className={styles.tgDateNum}
                    aria-label={`${date.getMonth() + 1}月${date.getDate()}日を表示`}
                    onClick={() => onOpenDay(d)}
                  >
                    {date.getDate()}
                  </button>
                </div>
              );
            })}
          </div>
          <div
            className={styles.tgAllDay}
            style={{ gridTemplateColumns: cols, height: Math.max(1, laneCount) * ROW_PX + 6 }}
            data-testid="calendar-allday"
          >
            {days.map((d) => (
              <div
                key={d}
                className={styles.tgAllDayCell}
                onClick={(e) => canCreate && onCreateAllDay(d, rectOf(e.currentTarget))}
                aria-label={`${dayKeyOf(d)} 終日`}
              />
            ))}
            {banners.map((b) => (
              <ItemButton
                key={b.item.task.id}
                item={b.item}
                onSelect={onSelectItem}
                className={cx(b.clipStart && styles.barClipStart, b.clipEnd && styles.barClipEnd)}
                style={{
                  top: 2 + b.lane * ROW_PX,
                  left: `calc(${(b.col / days.length) * 100}% + 2px)`,
                  width: `calc(${(b.span / days.length) * 100}% - 6px)`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className={styles.tgScroll} ref={scrollRef}>
        <div className={styles.tgGutter} aria-hidden="true">
          {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
            <span key={h} className={styles.tgHourLabel} style={{ top: h * HOUR_PX }}>
              {formatHourLabel(h)}
            </span>
          ))}
        </div>
        <div className={styles.tgCols} style={{ gridTemplateColumns: cols }}>
          {days.map((d) => (
            <div
              key={d}
              className={styles.tgCol}
              role="gridcell"
              aria-label={dayKeyOf(d)}
              data-testid={`calendar-col-${dayKeyOf(d)}`}
              onPointerDown={(e) => onDown(e, d)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag(null)}
            >
              {layoutTimedDay(items, d).map((p) => (
                <TimedBlock key={p.item.task.id} p={p} past={p.item.end!.getTime() < now.getTime()} onSelect={onSelectItem} />
              ))}
              {liveGhost && liveGhost.day === d && (
                <div
                  className={cx(styles.tgEvent, styles.tgGhost)}
                  style={{
                    top: (liveGhost.startMin / 60) * HOUR_PX,
                    height: Math.max(ROW_PX, ((liveGhost.endMin - liveGhost.startMin) / 60) * HOUR_PX - 2),
                    left: 0,
                    right: 8,
                    background: statusVisual("todo").color,
                  }}
                  data-testid="calendar-ghost"
                >
                  <div className={styles.tgEventTitle}>（タイトルなし）</div>
                  <div className={styles.tgEventTime}>
                    {minutesToHHMM(liveGhost.startMin).replace(/^0/, "")}～{minutesToHHMM(liveGhost.endMin).replace(/^0/, "")}
                  </div>
                </div>
              )}
              {d === nowDay && (
                <div className={styles.nowLine} style={{ top: (nowMin / 60) * HOUR_PX }} data-testid="calendar-now-line" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatOffset(d: Date): string {
  const off = -d.getTimezoneOffset() / 60;
  return off >= 0 ? `+${off}` : `${off}`;
}

function TimedBlock({
  p,
  past,
  onSelect,
}: {
  p: ReturnType<typeof layoutTimedDay>[number];
  past: boolean;
  onSelect: (it: CalendarItem, anchor: AnchorRect) => void;
}): JSX.Element {
  const it = p.item;
  const v = statusVisual(it.task.status);
  const heightPx = (p.height / 60) * HOUR_PX - 2;
  const compact = heightPx < 36;
  const title = it.task.title || "（タイトルなし）";
  const time = `${formatTime(it.start!)}～${formatTime(it.end!)}`;
  const widthPct = 100 / p.columns;
  return (
    <button
      type="button"
      className={cx(styles.tgEvent, it.task.status === "cancelled" && styles.cancelled, past && styles.past)}
      style={{
        top: (p.top / 60) * HOUR_PX,
        height: heightPx,
        left: `${p.column * widthPct}%`,
        width: `calc(${widthPct}% - ${p.column === p.columns - 1 ? 8 : 0}px)`,
        background: v.color,
      }}
      title={`${title}（${time}）`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => onSelect(it, rectOf(e.currentTarget))}
      data-testid={`calendar-item-${it.task.id}`}
    >
      {compact ? (
        <div className={styles.tgEventTitle}>
          {title}、{formatTime(it.start!)}
        </div>
      ) : (
        <>
          <div className={styles.tgEventTitle}>{title}</div>
          <div className={styles.tgEventTime}>{time}</div>
        </>
      )}
    </button>
  );
}

// ── 月 ──────────────────────────────────────────────────────────────────────

/** Rows (of ROW_PX) that fit under the date number in a week row of `h` px. */
function rowsThatFit(h: number): number {
  return Math.max(1, Math.floor((h - 32) / ROW_PX));
}

export function MonthGrid({
  anchorDay,
  today,
  items,
  canCreate,
  onCreateAllDay,
  onSelectItem,
  onMore,
  onOpenDay,
}: {
  anchorDay: number;
  today: number;
  items: CalendarItem[];
  canCreate: boolean;
  onCreateAllDay: (day: number, anchor: AnchorRect) => void;
  onSelectItem: (it: CalendarItem, anchor: AnchorRect) => void;
  onMore: (day: number, anchor: AnchorRect) => void;
  onOpenDay: (day: number) => void;
}): JSX.Element {
  const days = monthGridDays(anchorDay);
  const focusMonth = dateOfDay(anchorDay).getMonth();
  const weeks = Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7));

  // Fit as many rows as the week height allows, like Google (falls back to 4 in
  // environments without layout, e.g. jsdom).
  const gridRef = useRef<HTMLDivElement>(null);
  const [maxRows, setMaxRows] = useState(4);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const row = el.querySelector<HTMLElement>("[data-week-row]");
      if (row && row.offsetHeight > 0) setMaxRows(rowsThatFit(row.offsetHeight));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={cx(styles.main, styles.month)} ref={gridRef} data-testid="calendar-month">
      <div className={styles.monthHead}>
        {WEEKDAYS_JA.map((w) => (
          <div key={w} className={styles.monthWeekday} role="columnheader">
            {w}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <MonthWeek
          key={week[0]}
          week={week}
          focusMonth={focusMonth}
          today={today}
          items={items}
          maxRows={maxRows}
          canCreate={canCreate}
          onCreateAllDay={onCreateAllDay}
          onSelectItem={onSelectItem}
          onMore={onMore}
          onOpenDay={onOpenDay}
        />
      ))}
    </div>
  );
}

function MonthWeek({
  week,
  focusMonth,
  today,
  items,
  maxRows,
  canCreate,
  onCreateAllDay,
  onSelectItem,
  onMore,
  onOpenDay,
}: {
  week: number[];
  focusMonth: number;
  today: number;
  items: CalendarItem[];
  maxRows: number;
  canCreate: boolean;
  onCreateAllDay: (day: number, anchor: AnchorRect) => void;
  onSelectItem: (it: CalendarItem, anchor: AnchorRect) => void;
  onMore: (day: number, anchor: AnchorRect) => void;
  onOpenDay: (day: number) => void;
}): JSX.Element {
  const first = week[0]!;
  const spans = layoutSpans(items.filter(isBannerItem), first, 7);

  // Per day: how many rows its bars occupy, its timed items, and whether it overflows.
  const perDay = week.map((d, col) => {
    const covering = spans.filter((s) => s.col <= col && s.col + s.span - 1 >= col);
    const lanesUsed = covering.reduce((n, s) => Math.max(n, s.lane + 1), 0);
    const timed = timedItemsOn(items, d);
    const total = covering.length + timed.length;
    const overflow = lanesUsed + timed.length > maxRows;
    return { d, col, covering, lanesUsed, timed, total, overflow };
  });
  const rowLimit = (col: number) => (perDay[col]!.overflow ? maxRows - 1 : maxRows);

  const shownSpans = spans.filter((s) => {
    for (let c = s.col; c < s.col + s.span; c++) if (s.lane >= rowLimit(c)) return false;
    return true;
  });

  return (
    <div className={styles.monthWeek} data-week-row>
      {week.map((d) => {
        const date = dateOfDay(d);
        const firstOfMonth = date.getDate() === 1;
        return (
          <div
            key={d}
            className={cx(styles.monthCell, date.getMonth() !== focusMonth && styles.monthOutside, d === today && styles.monthToday)}
            role="gridcell"
            aria-label={dayKeyOf(d)}
            data-testid={`calendar-day-${dayKeyOf(d)}`}
            onClick={(e) => canCreate && onCreateAllDay(d, rectOf(e.currentTarget))}
          >
            <button
              type="button"
              className={styles.monthDateNum}
              onClick={(e) => {
                e.stopPropagation();
                onOpenDay(d);
              }}
            >
              {firstOfMonth ? `${date.getMonth() + 1}月${date.getDate()}日` : date.getDate()}
            </button>
          </div>
        );
      })}

      {shownSpans.map((s) => (
        <ItemButton
          key={s.item.task.id}
          item={s.item}
          onSelect={onSelectItem}
          className={cx(s.clipStart && styles.barClipStart, s.clipEnd && styles.barClipEnd)}
          style={{
            top: 32 + s.lane * ROW_PX,
            left: `calc(${(s.col / 7) * 100}% + 4px)`,
            width: `calc(${(s.span / 7) * 100}% - 10px)`,
          }}
        />
      ))}

      {perDay.map(({ d, col, timed, total, lanesUsed }) => {
        const limit = rowLimit(col);
        const shownTimed = timed.slice(0, Math.max(0, limit - lanesUsed));
        const shownBars = shownSpans.filter((s) => s.col <= col && s.col + s.span - 1 >= col).length;
        const hidden = total - shownBars - shownTimed.length;
        const left = `calc(${(col / 7) * 100}% + 4px)`;
        const width = `calc(${100 / 7}% - 10px)`;
        return (
          <div key={`items-${d}`} style={{ display: "contents" }}>
            {shownTimed.map((it, i) => (
              <ItemButton
                key={it.task.id}
                item={it}
                onSelect={onSelectItem}
                style={{ top: 32 + (lanesUsed + i) * ROW_PX, left, width }}
              />
            ))}
            {hidden > 0 && (
              <button
                type="button"
                className={styles.more}
                style={{ top: 32 + (limit === maxRows ? limit - 1 : limit) * ROW_PX, left, width }}
                onClick={(e) => {
                  e.stopPropagation();
                  onMore(d, rectOf(e.currentTarget));
                }}
                data-testid={`calendar-more-${dayKeyOf(d)}`}
              >
                他 {hidden} 件
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── スケジュール ─────────────────────────────────────────────────────────────

export function ScheduleList({
  days,
  today,
  items,
  onSelectItem,
  onOpenDay,
}: {
  days: number[];
  today: number;
  items: CalendarItem[];
  onSelectItem: (it: CalendarItem, anchor: AnchorRect) => void;
  onOpenDay: (day: number) => void;
}): JSX.Element {
  const rows = days.map((d) => ({ d, list: itemsOnDay(items, d) })).filter((r) => r.list.length > 0);
  return (
    <div className={cx(styles.main, styles.schedule)} data-testid="calendar-schedule">
      {rows.length === 0 && <p className={styles.schedEmpty}>この期間の予定はありません</p>}
      {rows.map(({ d, list }) => {
        const date = dateOfDay(d);
        return (
          <div key={d} className={cx(styles.schedRow, d === today && styles.schedToday)} data-testid={`calendar-sched-${dayKeyOf(d)}`}>
            <div className={styles.schedDate}>
              <button type="button" className={styles.schedDateNum} onClick={() => onOpenDay(d)}>
                {date.getDate()}
              </button>
              <span className={styles.schedDateMeta}>
                {date.getMonth() + 1}月、{WEEKDAYS_JA[date.getDay()]}
              </span>
            </div>
            <div className={styles.schedItems}>
              {list.map((it) => {
                const v = statusVisual(it.task.status);
                return (
                  <button
                    key={it.task.id}
                    type="button"
                    className={styles.schedItem}
                    onClick={(e) => onSelectItem(it, rectOf(e.currentTarget))}
                    data-testid={`calendar-item-${it.task.id}`}
                  >
                    <span className={styles.dot} style={{ background: v.color, width: 10, height: 10 }} />
                    <span className={styles.schedTime}>
                      {it.allDay || it.startDay !== it.endDay ? "終日" : `${formatTime(it.start!)}～${formatTime(it.end!)}`}
                    </span>
                    <span className={it.task.status === "cancelled" ? styles.cancelled : undefined}>
                      {it.task.title || "（タイトルなし）"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
