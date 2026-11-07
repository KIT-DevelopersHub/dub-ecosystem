// 面談可能な日程を登録するマス目。今日から 7 日 × 9:00〜21:00 を 30 分 (60 分に切り替え可) のマスで並べる。
//  1. 空いているマスをクリック / ドラッグで選ぶ (何度でも足せる。選んだマスをもう一度押すと外れる)
//  2. 「登録する」で選んだマスをまとめて登録する
// 自分の登録済みのマスを選ぶと「登録を外す」になる。予約済み・過去のマスは選べない。
// マウスもタッチも pointer イベントで扱う (指の下のマスは elementFromPoint で拾う)。キーボードは各マスのボタンで。
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
  jstDayOf,
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
const DAYS = 7;

interface Props {
  slots: readonly hrInterview.InterviewSlot[];
  meId: string;
  canWrite: boolean;
  onAdd: (slots: hrInterview.NewInterviewSlot[]) => void;
  onRemove: (ids: string[]) => void;
}

interface Drag {
  anchor: Cell;
  current: Cell;
}
interface Selection {
  mode: DragMode;
  keys: Set<string>;
}

const keyOf = (c: Cell) => `${c.day}:${c.row}`;
const cellOf = (key: string): Cell => {
  const [day, row] = key.split(":").map(Number) as [number, number];
  return { day, row };
};

function cellFromPoint(x: number, y: number): Cell | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cell]");
  return el?.dataset.cell ? cellOf(el.dataset.cell) : null;
}

export function InterviewSlotGrid({ slots, meId, canWrite, onAdd, onRemove }: Props): JSX.Element {
  const [start, setStart] = useState(() => jstDayOf(Date.now()));
  const [step, setStep] = useState<GridStep>(30);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const rows = rowCount(step);

  const rangeOf = (c: Cell) => cellRange(start, step, c);
  const states = useMemo(() => {
    const nowMs = Date.now();
    const m = new Map<string, CellState>();
    for (let day = 0; day < DAYS; day++) {
      for (let row = 0; row < rows; row++) m.set(`${day}:${row}`, cellState(slots, meId, cellRange(start, step, { day, row }), nowMs));
    }
    return m;
  }, [slots, meId, start, step, rows]);
  const stateOf = (c: Cell) => states.get(keyOf(c)) as CellState;

  // 選んだあとで別の人の操作などでマスの状態が変わったら、その分は選択から落とす。
  const live = useMemo(() => {
    if (!selection) return null;
    const keys = new Set([...selection.keys].filter((k) => modeFor(states.get(k) as CellState) === selection.mode));
    return keys.size > 0 ? { mode: selection.mode, keys } : null;
  }, [selection, states]);

  // ドラッグ中は、いまの選択に囲んでいる範囲を重ねて見せる。
  const dragKeys = useMemo(() => {
    if (!drag) return new Set<string>();
    return new Set(cellsBetween(drag.anchor, drag.current).map(keyOf));
  }, [drag]);
  const dragMode = drag ? modeFor(stateOf(drag.anchor)) : null;

  /** 囲んだマスを選択に足す。1 マスだけ押して、それが選択済みなら外す (押し直しで取り消せる)。 */
  const select = (cells: Cell[]) => {
    const mode = modeFor(stateOf(cells[0]!));
    if (!mode) return;
    const target = cells.filter((c) => modeFor(stateOf(c)) === mode).map(keyOf);
    const base = live && live.mode === mode ? new Set(live.keys) : new Set<string>();
    if (target.length === 1 && base.has(target[0]!)) base.delete(target[0]!);
    else for (const k of target) base.add(k);
    setSelection(base.size > 0 ? { mode, keys: base } : null);
  };

  const updateDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!canWrite || (e.pointerType === "mouse" && e.button !== 0)) return;
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (!cell || !modeFor(stateOf(cell))) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    updateDrag({ anchor: cell, current: cell });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (cell && (cell.day !== d.current.day || cell.row !== d.current.row)) updateDrag({ ...d, current: cell });
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    if (!d) return;
    updateDrag(null);
    select(cellsBetween(d.anchor, d.current));
  };

  const move = (next: number) => {
    setSelection(null);
    setStart(next);
  };

  const commit = () => {
    if (!live) return;
    const plan = planChange(live.mode, [...live.keys].map(cellOf), stateOf, rangeOf, step);
    if (plan.add.length > 0) onAdd(plan.add);
    if (plan.remove.length > 0) onRemove(plan.remove);
    setSelection(null);
  };

  const count = live?.keys.size ?? 0;
  const removeCount = live?.mode === "remove" ? planChange("remove", [...live.keys].map(cellOf), stateOf, rangeOf, step).remove.length : 0;
  return (
    <div className={styles.gridWrap}>
      {canWrite ? (
        <ol className={styles.steps}>
          <li>面談できる時間のマスを、クリックかドラッグで選びます（何度でも追加できます）。</li>
          <li>「登録する」を押すと、選んだマスが応募者の選べる候補になります。</li>
        </ol>
      ) : null}
      <div className={styles.gridToolbar}>
        <div className={styles.weekNav}>
          <Button size="sm" variant="secondary" testId="fe2-hr-grid-prev" onClick={() => move(addDays(start, -DAYS))}>
            前の 7 日
          </Button>
          <Button size="sm" variant="ghost" testId="fe2-hr-grid-today" onClick={() => move(jstDayOf(Date.now()))}>
            今日
          </Button>
          <Button size="sm" variant="secondary" testId="fe2-hr-grid-next" onClick={() => move(addDays(start, DAYS))}>
            次の 7 日
          </Button>
          <span className={styles.weekLabel} data-testid="fe2-hr-grid-week">
            {dayLabel(start)} 〜 {dayLabel(addDays(start, DAYS - 1))}
          </span>
        </div>
        <div className={styles.stepSelect}>
          <Select
            id="fe2-hr-grid-step"
            testId="fe2-hr-grid-step"
            value={String(step)}
            options={STEP_OPTIONS}
            onChange={(v) => {
              setSelection(null);
              setStep(Number(v) as GridStep);
            }}
          />
        </div>
      </div>
      <div className={styles.legend} aria-hidden="true">
        <span className={styles.legendItem} data-kind="selected">選択中</span>
        <span className={styles.legendItem} data-kind="mine">登録済み（自分）</span>
        <span className={styles.legendItem} data-kind="booked">予約が入った</span>
        <span className={styles.legendItem} data-kind="others">他の人が登録済み</span>
        <span className={styles.legendItem} data-kind="past">過去</span>
      </div>
      <div
        className={styles.grid}
        style={{ gridTemplateRows: `auto repeat(${rows}, var(--hr-grid-row))` }}
        data-testid="fe2-hr-slot-grid"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => updateDrag(null)}
      >
        <div className={styles.corner}>日本時間</div>
        {Array.from({ length: DAYS }, (_, day) => (
          <div key={`h${day}`} className={styles.dayHead}>
            {dayLabel(addDays(start, day))}
          </div>
        ))}
        {Array.from({ length: rows }, (_, row) => {
          const minutes = GRID_START_MIN + row * step;
          return (
            <Row
              key={row}
              row={row}
              label={timeLabel(minutes)}
              onHour={minutes % 60 === 0}
              stateOf={stateOf}
              isSelected={(k, s) =>
                (live?.keys.has(k) ?? false) ||
                (dragKeys.has(k) && dragMode !== null && modeFor(s) === dragMode)
              }
              selectedMode={drag ? dragMode : (live?.mode ?? null)}
              canWrite={canWrite}
              onKeyToggle={(c) => select([c])}
            />
          );
        })}
      </div>
      {canWrite ? (
        <div className={styles.actionBar} data-testid="fe2-hr-grid-actions" data-active={count > 0 || undefined}>
          <span data-testid="fe2-hr-grid-selected">
            {count === 0
              ? "マスが選ばれていません"
              : live?.mode === "add"
                ? `${count} マスを選んでいます`
                : `登録済みの ${removeCount} 件を選んでいます`}
          </span>
          <div className={styles.actionButtons}>
            <Button variant="ghost" testId="fe2-hr-grid-clear" disabled={count === 0} onClick={() => setSelection(null)}>
              選択を解除
            </Button>
            {live?.mode === "remove" ? (
              <Button variant="danger" testId="fe2-hr-grid-commit" onClick={commit}>
                登録を外す
              </Button>
            ) : (
              <Button testId="fe2-hr-grid-commit" disabled={count === 0} onClick={commit}>
                登録する
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  row,
  label,
  onHour,
  stateOf,
  isSelected,
  selectedMode,
  canWrite,
  onKeyToggle,
}: {
  row: number;
  label: string;
  onHour: boolean;
  stateOf: (c: Cell) => CellState;
  isSelected: (key: string, s: CellState) => boolean;
  selectedMode: DragMode | null;
  canWrite: boolean;
  onKeyToggle: (c: Cell) => void;
}): JSX.Element {
  return (
    <>
      <div className={styles.timeHead} data-hour={onHour || undefined}>
        {label}
      </div>
      {Array.from({ length: DAYS }, (_, day) => {
        const key = `${day}:${row}`;
        const s = stateOf({ day, row });
        const kind = s.kind === "free" && s.others > 0 ? "others" : s.kind;
        const text = s.kind === "booked" ? (s.slot.applicantName ?? "予約") : s.kind === "free" && s.others > 0 ? `他 ${s.others}` : "";
        const selected = isSelected(key, s) ? (selectedMode ?? undefined) : undefined;
        return (
          <button
            key={key}
            type="button"
            className={styles.cell}
            data-cell={key}
            data-kind={kind}
            data-hour={onHour || undefined}
            data-selected={selected}
            data-testid={`fe2-hr-cell-${key}`}
            aria-pressed={selected !== undefined}
            disabled={!canWrite || modeFor(s) === null}
            aria-label={`${label} ${s.kind === "mine" ? "登録済み" : s.kind === "booked" ? `予約済み ${text}` : s.kind === "past" ? "過去" : "空き"}`}
            // マウス/タッチは pointer で処理済み。キーボード (Enter/Space) の click だけ拾う。
            onClick={(e) => {
              if (e.detail === 0) onKeyToggle({ day, row });
            }}
          >
            {text}
          </button>
        );
      })}
    </>
  );
}
