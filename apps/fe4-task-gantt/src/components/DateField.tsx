import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "../styles/app.module.css";

export interface DateFieldProps {
  id?: string;
  /** value in yyyy-mm-dd (plain date), or null. */
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  testId?: string;
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];

function parse(v: string | null): { y: number; m: number; d: number } | null {
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function toValue(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}
function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function formatLabel(v: string | null): string {
  const p = parse(v);
  if (!p) return "日付を選択";
  return `${p.y}/${pad(p.m)}/${pad(p.d)} (${WD[weekdayOf(p.y, p.m, p.d)]})`;
}

/**
 * Notion-tone styled date field. Shows a formatted label + a self-drawn calendar
 * popover (no native date UI, no heavy lib). A visually-hidden native input keeps
 * the value form-associated and test-addressable (testId).
 */
export function DateField({ id, value, onChange, disabled, testId }: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const today = new Date();
  const init = parse(value) ?? { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
  const [view, setView] = useState({ y: init.y, m: init.m });
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const sel = parse(value);
    if (sel) setView({ y: sel.y, m: sel.m });
  }, [value]);

  // position the portal popover under the trigger, flipping up if no room
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    const POP_H = 320;
    const below = window.innerHeight - r.bottom > POP_H + 12;
    setPos({ left: r.left, top: below ? r.bottom + 6 : Math.max(8, r.top - POP_H - 6) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        const pop = document.getElementById("fe4-datefield-pop");
        if (pop && pop.contains(e.target as Node)) return;
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const sel = parse(value);
  const t = { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };

  const move = (delta: number) => {
    setView((v) => {
      const idx = v.y * 12 + (v.m - 1) + delta;
      return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
    });
  };

  const pick = (d: number) => {
    onChange(toValue(view.y, view.m, d));
    setOpen(false);
  };

  const firstDow = weekdayOf(view.y, view.m, 1);
  const total = daysInMonth(view.y, view.m);
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <span className={styles.df} ref={wrapRef}>
      {/* hidden native input keeps value form-associated + test-addressable */}
      <input
        id={id}
        type="date"
        data-testid={testId}
        className={styles.dfNative}
        value={value ?? ""}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      />
      <button
        type="button"
        className={styles.dfTrigger}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid={testId ? `${testId}-trigger` : undefined}
      >
        <CalendarIcon />
        <span className={sel ? styles.dfValue : styles.dfPlaceholder}>{formatLabel(value)}</span>
        {sel && !disabled && (
          <span
            className={styles.dfClear}
            role="button"
            aria-label="日付をクリア"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          >
            ×
          </span>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div id="fe4-datefield-pop" className={styles.dfPop} style={{ left: pos.left, top: pos.top }} role="dialog" data-testid={testId ? `${testId}-pop` : undefined}>
            <div className={styles.dfPopHead}>
              <button type="button" className={styles.dfNav} onClick={() => move(-1)} aria-label="前の月">
                ‹
              </button>
              <span className={styles.dfMonth}>
                {view.y}年{view.m}月
              </span>
              <button type="button" className={styles.dfNav} onClick={() => move(1)} aria-label="次の月">
                ›
              </button>
            </div>
            <div className={styles.dfGrid}>
              {WD.map((w, i) => (
                <span key={w} className={`${styles.dfWd} ${i === 0 || i === 6 ? styles.dfWdWeekend : ""}`}>
                  {w}
                </span>
              ))}
              {cells.map((d, i) => {
                if (d === null) return <span key={`e${i}`} className={styles.dfCellEmpty} />;
                const isToday = d === t.d && view.m === t.m && view.y === t.y;
                const isSel = sel && d === sel.d && view.m === sel.m && view.y === sel.y;
                const dow = i % 7;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`${styles.dfCell} ${isSel ? styles.dfCellSel : ""} ${isToday ? styles.dfCellToday : ""} ${
                      dow === 0 || dow === 6 ? styles.dfCellWeekend : ""
                    }`}
                    onClick={() => pick(d)}
                    data-testid={testId ? `${testId}-day-${d}` : undefined}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <div className={styles.dfPopFoot}>
              <button
                type="button"
                className={styles.dfTodayBtn}
                onClick={() => {
                  onChange(toValue(t.y, t.m, t.d));
                  setOpen(false);
                }}
              >
                今日
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

function CalendarIcon() {
  return (
    <svg className={styles.dfIcon} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 6h12M5.5 2v2M10.5 2v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
