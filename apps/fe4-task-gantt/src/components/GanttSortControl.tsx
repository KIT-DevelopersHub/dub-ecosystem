// 多段（複数キー）ソートのビルダー UI. A Popover whose panel lets the user compose an
// ordered list of sort conditions — e.g. チーム順 → 重要度順 → 時期が早い順 — where the
// first condition is primary and each subsequent one breaks the previous's ties. Each
// condition has its own 昇順/降順. "手動（ドラッグ）" is a distinct top-level mode that
// hands ordering back to the drag overlay. All state lives in the parent (per-event,
// localStorage) via GanttSortActions; this component is presentational.
import { Button, Popover, SegmentedControl, Select } from "@dub/ui";
import type { SegmentedOption, SelectOption } from "@dub/ui";
import type { SortDirection, SortKey } from "../domain/row-sort";
import {
  SORT_DIRECTION_OPTIONS,
  SORT_KEY_OPTIONS,
  availableKeys,
  summarizeSort,
  type GanttSortActions,
  type GanttSortState,
} from "../domain/gantt-sort-pref";
import styles from "../styles/gantt-sort.module.css";

type ModeValue = "manual" | "auto";
const MODE_OPTIONS: SegmentedOption<ModeValue>[] = [
  { value: "auto", label: "多段ソート" },
  { value: "manual", label: "手動（ドラッグ）" },
];

const DIR_OPTIONS = SORT_DIRECTION_OPTIONS as SegmentedOption<SortDirection>[];

export interface GanttSortControlProps {
  state: GanttSortState;
  actions: GanttSortActions;
  testId?: string;
}

/** Small inline glyphs so we don't depend on icons missing from the registry. */
function Glyph({ d }: { d: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <path d={d} stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const UP = "M6 15l6-6 6 6";
const DOWN = "M6 9l6 6 6-6";
const CLOSE = "M6 6l12 12M18 6L6 18";

export function GanttSortControl({ state, actions, testId }: GanttSortControlProps) {
  const auto = !state.manual;
  const free = availableKeys(state);
  const usedByOthers = (index: number) =>
    new Set(state.keys.filter((_, i) => i !== index).map((s) => s.key));

  const panel = (
    <div className={styles.panel} data-testid="fe4-gantt-sort-panel">
      <SegmentedControl<ModeValue>
        options={MODE_OPTIONS}
        value={state.manual ? "manual" : "auto"}
        onChange={(v) => actions.setManual(v === "manual")}
        size="sm"
        aria-label="並び替えの方式"
        className={styles.modeStrip}
      />

      {auto ? (
        <>
          <p className={styles.hint}>
            上から順に適用します（第1条件が同値なら第2条件で並べます）。
          </p>
          <ol className={styles.list}>
            {state.keys.map((spec, i) => {
              const others = usedByOthers(i);
              const keyOptions = SORT_KEY_OPTIONS.filter(
                (o) => o.value === spec.key || !others.has(o.value),
              ) as SelectOption<SortKey>[];
              return (
                <li key={`${spec.key}-${i}`} className={styles.row} data-testid={`fe4-gantt-sort-cond-${i}`}>
                  <span className={styles.rank} aria-hidden>
                    {i + 1}
                  </span>
                  <Select<SortKey>
                    id={`fe4-gantt-sort-key-${i}`}
                    value={spec.key}
                    onChange={(v) => actions.setKey(i, v)}
                    options={keyOptions}
                    aria-label={`第${i + 1}条件のキー`}
                    testId={`fe4-gantt-sort-key-${i}`}
                  />
                  <SegmentedControl<SortDirection>
                    options={DIR_OPTIONS}
                    value={spec.dir}
                    onChange={(v) => actions.setDir(i, v)}
                    size="sm"
                    aria-label={`第${i + 1}条件の昇順/降順`}
                    className={styles.dirStrip}
                  />
                  <span className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => actions.moveKey(i, -1)}
                      disabled={i === 0}
                      aria-label={`第${i + 1}条件を上へ`}
                      title="優先順位を上げる"
                    >
                      <Glyph d={UP} />
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => actions.moveKey(i, 1)}
                      disabled={i === state.keys.length - 1}
                      aria-label={`第${i + 1}条件を下へ`}
                      title="優先順位を下げる"
                    >
                      <Glyph d={DOWN} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() => actions.removeKey(i)}
                      aria-label={`第${i + 1}条件を削除`}
                      title="この条件を削除"
                      data-testid={`fe4-gantt-sort-remove-${i}`}
                    >
                      <Glyph d={CLOSE} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className={styles.footer}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => actions.addKey()}
              disabled={free.length === 0}
              testId="fe4-gantt-sort-add"
            >
              ＋ 条件を追加
            </Button>
            {free.length === 0 && <span className={styles.footerNote}>すべてのキーを使用中</span>}
          </div>
        </>
      ) : (
        <p className={styles.hint}>ドラッグで手動に並べた順で表示します。</p>
      )}
    </div>
  );

  return (
    <Popover
      testId={testId ?? "fe4-gantt-sort"}
      trigger={
        // Popover renders its own <button>, so the trigger is plain inline content
        // (nesting a real <button> here would be invalid HTML).
        <span className={styles.trigger}>
          <span className={styles.triggerLabel}>並び替え</span>
          <span className={styles.triggerValue}>{summarizeSort(state)}</span>
          <Glyph d={DOWN} />
        </span>
      }
      placement="bottom"
    >
      {panel}
    </Popover>
  );
}
