// 面談タブのコマ表。1 週間 × 30 分 (60 分に切り替え可) のコマを並べ、ドラッグで囲んだ範囲をまとめて登録する。
// 自分の枠から囲み始めると、囲んだ自分の枠をまとめて外す。予約済み・過去のコマは触れない。
// マウスもタッチも同じ pointer イベントで扱う (タッチは指の下のコマを elementFromPoint で拾う)。
// キーボードは各コマのボタンで 1 コマずつ切り替える。
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Select } from "@dub/ui";
import type { hrInterview } from "@dub/types";
import {
  addDays,
  cellRange,
  cellsBetween,
  cellState,
  dayLabel,
  GRID_START_MIN,
  GRID_STEPS,
  jstWeekStart,
  modeFor,
  planChange,
  rowCount,
  timeLabel,
  type Cell,
  type CellState,
  type DragMode,
  type GridStep,
} from "./interviewGrid.ts";
import styles from "./interviews.module.css";

const STEP_OPTIONS = GRID_STEPS.map((m) => ({ value: String(m), label: `${m} 分ごと` }));

interface Props {
  slots: readonly hrInterview.InterviewSlot[];
  meId: string;
  canWrite: boolean;
  onAdd: (slots: hrInterview.NewInterviewSlot[]) => void;
  onRemove: (ids: string[]) => void;
}

interface Drag {
  mode: DragMode;
  anchor: Cell;
  current: Cell;
}

function cellFromPoint(x: number, y: number): Cell | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cell]");
  if (!el?.dataset.cell) return null;
  const [day, row] = el.dataset.cell.split(":").map(Number) as [number, number];
  return { day, row };
}

export function InterviewSlotGrid({ slots, meId, canWrite, onAdd, onRemove }: Props): JSX.Element {
  const [week, setWeek] = useState(() => jstWeekStart(Date.now()));
  const [step, setStep] = useState<GridStep>(30);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const nowMs = Date.now();
  const rows = rowCount(step);

  const rangeOf = (c: Cell) => cellRange(week, step, c);
  const states = useMemo(() => {
    const m = new Map<string, CellState>();
    for (let day = 0; day < 7; day++) {
      for (let row = 0; row < rows; row++) m.set(`${day}:${row}`, cellState(slots, meId, cellRange(week, step, { day, row }), nowMs));
    }
    return m;
    // nowMs は描画ごとに変わるが、過去かどうかの判定に分単位の精度は要らない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, meId, week, step, rows]);
  const stateOf = (c: Cell) => states.get(`${c.day}:${c.row}`) as CellState;

  const selected = useMemo(() => {
    if (!drag) return new Set<string>();
    return new Set(cellsBetween(drag.anchor, drag.current).map((c) => `${c.day}:${c.row}`));
  }, [drag]);

  const apply = (mode: DragMode, cells: Cell[]) => {
    const plan = planChange(mode, cells, stateOf, rangeOf, step);
    if (plan.add.length > 0) onAdd(plan.add);
    if (plan.remove.length > 0) onRemove(plan.remove);
  };

  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!canWrite || (e.pointerType === "mouse" && e.button !== 0)) return;
    const cell = cellFromPoint(e.clientX, e.clientY);
    const mode = cell ? modeFor(stateOf(cell)) : null;
    if (!cell || !mode) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    update({ mode, anchor: cell, current: cell });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (cell && (cell.day !== d.current.day || cell.row !== d.current.row)) update({ ...d, current: cell });
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    if (!d) return;
    update(null);
    apply(d.mode, cellsBetween(d.anchor, d.current));
  };

  const weekEnd = addDays(week, 6);
  return (
    <div className={styles.gridWrap}>
      <div className={styles.gridToolbar}>
        <div className={styles.weekNav}>
          <Button size="sm" variant="secondary" testId="fe2-hr-grid-prev" onClick={() => setWeek(addDays(week, -7))}>
            前の週
          </Button>
          <Button size="sm" variant="ghost" testId="fe2-hr-grid-today" onClick={() => setWeek(jstWeekStart(Date.now()))}>
            今週
          </Button>
          <Button size="sm" variant="secondary" testId="fe2-hr-grid-next" onClick={() => setWeek(addDays(week, 7))}>
            次の週
          </Button>
          <span className={styles.weekLabel} data-testid="fe2-hr-grid-week">
            {dayLabel(week)} 〜 {dayLabel(weekEnd)}
          </span>
        </div>
        <div className={styles.stepSelect}>
          <Select
            id="fe2-hr-grid-step"
            testId="fe2-hr-grid-step"
            value={String(step)}
            options={STEP_OPTIONS}
            onChange={(v) => setStep(Number(v) as GridStep)}
          />
        </div>
      </div>
      {canWrite ? (
        <p className={styles.muted}>
          空いているコマをドラッグすると、囲んだ時間をまとめて登録できます。自分の枠からドラッグすると、まとめて外せます。時刻は日本時間です。
        </p>
      ) : null}
      <div className={styles.legend} aria-hidden="true">
        <span className={styles.legendItem} data-kind="mine">自分の空き</span>
        <span className={styles.legendItem} data-kind="booked">予約済み</span>
        <span className={styles.legendItem} data-kind="others">他の人の空きあり</span>
      </div>
      <div
        className={styles.grid}
        style={{ gridTemplateRows: `auto repeat(${rows}, var(--hr-grid-row))` }}
        data-testid="fe2-hr-slot-grid"
        data-dragging={drag ? drag.mode : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => update(null)}
      >
        <div className={styles.corner} />
        {Array.from({ length: 7 }, (_, day) => (
          <div key={`h${day}`} className={styles.dayHead}>
            {dayLabel(addDays(week, day))}
          </div>
        ))}
        {Array.from({ length: rows }, (_, row) => (
          <Row
            key={row}
            row={row}
            label={timeLabel(GRID_START_MIN + row * step)}
            stateOf={stateOf}
            selected={selected}
            dragMode={drag?.mode ?? null}
            canWrite={canWrite}
            onToggle={(c) => {
              const mode = modeFor(stateOf(c));
              if (mode) apply(mode, [c]);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Row({
  row,
  label,
  stateOf,
  selected,
  dragMode,
  canWrite,
  onToggle,
}: {
  row: number;
  label: string;
  stateOf: (c: Cell) => CellState;
  selected: Set<string>;
  dragMode: DragMode | null;
  canWrite: boolean;
  onToggle: (c: Cell) => void;
}): JSX.Element {
  return (
    <>
      <div className={styles.timeHead}>{row % 2 === 0 || label.endsWith(":00") ? label : ""}</div>
      {Array.from({ length: 7 }, (_, day) => {
        const key = `${day}:${row}`;
        const s = stateOf({ day, row });
        const kind = s.kind === "free" && s.others > 0 ? "others" : s.kind;
        const text = s.kind === "booked" ? (s.slot.applicantName ?? "予約") : s.kind === "free" && s.others > 0 ? `他 ${s.others}` : "";
        const preview = selected.has(key) && dragMode !== null && modeFor(s) === dragMode ? dragMode : undefined;
        return (
          <button
            key={key}
            type="button"
            className={styles.cell}
            data-cell={key}
            data-kind={kind}
            data-preview={preview}
            data-testid={`fe2-hr-cell-${key}`}
            disabled={!canWrite || modeFor(s) === null}
            aria-label={`${label} ${s.kind === "mine" ? "自分の空き (押すと外す)" : s.kind === "booked" ? `予約済み ${text}` : s.kind === "past" ? "過去" : "空き (押すと登録)"}`}
            // マウス/タッチは pointer で処理済み。キーボード (Enter/Space) の click だけ拾う。
            onClick={(e) => {
              if (e.detail === 0) onToggle({ day, row });
            }}
          >
            {text}
          </button>
        );
      })}
    </>
  );
}
