import { useCallback, useRef, useState } from "react";
import type { ColumnDef, DataTableProps, SortState } from "../types";
import { useVirtualRows } from "./useVirtualRows";
import styles from "./DataTable.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { Popover } from "./Tooltip";
import { Button } from "./Button";
import { Checkbox } from "./Inputs";

function nextSort(current: SortState | undefined, key: string): SortState {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: "asc" };
}

/** Plain-text label for a column in the「表示列」picker. */
function pickerLabelOf<Row>(col: ColumnDef<Row>): string {
  if (col.pickerLabel) return col.pickerLabel;
  if (typeof col.header === "string") return col.header;
  return col.key;
}

function loadOverrides(storageKey: string): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, boolean>;
  } catch {
    /* corrupt / unavailable storage — fall back to defaults */
  }
  return {};
}

/**
 * Per-user column visibility with optimistic (即時) state + localStorage persistence.
 * `overrides[key]` (if set) wins over the column's `defaultHidden`; non-hideable
 * columns are never stored. Storage failures (private mode / quota) degrade to
 * in-memory-only, never throwing.
 */
function useColumnVisibility<Row>(columns: ColumnDef<Row>[], storageKey: string | undefined) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() =>
    storageKey ? loadOverrides(storageKey) : {},
  );

  const persist = useCallback(
    (next: Record<string, boolean>) => {
      if (!storageKey || typeof window === "undefined") return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore write failures (private mode / quota) */
      }
    },
    [storageKey],
  );

  const apply = useCallback(
    (next: Record<string, boolean>) => {
      setOverrides(next);
      persist(next);
    },
    [persist],
  );

  const isVisible = useCallback(
    (col: ColumnDef<Row>) => {
      if (col.hideable === false) return true;
      return overrides[col.key] ?? !col.defaultHidden;
    },
    [overrides],
  );

  const toggle = useCallback(
    (col: ColumnDef<Row>) => {
      const current = overrides[col.key] ?? !col.defaultHidden;
      apply({ ...overrides, [col.key]: !current });
    },
    [overrides, apply],
  );

  const showAll = useCallback(() => {
    const next: Record<string, boolean> = { ...overrides };
    for (const col of columns) {
      if (col.hideable !== false) next[col.key] = true;
    }
    apply(next);
  }, [columns, overrides, apply]);

  const reset = useCallback(() => {
    setOverrides({});
    if (storageKey && typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    }
  }, [storageKey]);

  return { isVisible, toggle, showAll, reset };
}

function ColumnPicker<Row>({
  columns,
  isVisible,
  onToggle,
  onShowAll,
  onReset,
  label,
  testId,
}: {
  columns: ColumnDef<Row>[];
  isVisible: (col: ColumnDef<Row>) => boolean;
  onToggle: (col: ColumnDef<Row>) => void;
  onShowAll: () => void;
  onReset: () => void;
  label?: string;
  testId?: string;
}): JSX.Element {
  const toggleable = columns.filter((col) => col.hideable !== false);
  const shownCount = toggleable.filter(isVisible).length;
  return (
    <div className={cx(styles.toolbar)}>
      <Popover
        placement="bottom"
        testId={testId ? `${testId}-column-picker` : undefined}
        trigger={
          <span className={cx(styles.pickerTrigger)}>
            <Icon name="check-square" size="sm" />
            {label ?? "表示列"}
            <span className={cx(styles.pickerCount)}>
              {shownCount}/{toggleable.length}
            </span>
            <Icon name="chevron-down" size="sm" />
          </span>
        }
      >
        <div className={cx(styles.pickerPanel)}>
          <p className={cx(styles.pickerHeading)}>表示する列</p>
          <div className={cx(styles.pickerList)}>
            {toggleable.map((col) => (
              <Checkbox
                key={col.key}
                id={`${testId ?? "dt"}-colvis-${col.key}`}
                checked={isVisible(col)}
                onChange={() => onToggle(col)}
                label={pickerLabelOf(col)}
                testId={testId ? `${testId}-colvis-${col.key}` : undefined}
              />
            ))}
          </div>
          <div className={cx(styles.pickerFooter)}>
            <Button variant="ghost" size="sm" onClick={onShowAll} testId={testId ? `${testId}-colvis-show-all` : undefined}>
              すべて表示
            </Button>
            <Button variant="ghost" size="sm" onClick={onReset} testId={testId ? `${testId}-colvis-reset` : undefined}>
              既定に戻す
            </Button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  loading,
  emptyState,
  sort,
  onSortChange,
  onRowClick,
  selection,
  columnHiding,
  virtualize,
  testId,
}: DataTableProps<Row>) {
  const { isVisible, toggle, showAll, reset } = useColumnVisibility(columns, columnHiding?.storageKey);
  const visibleColumns = columnHiding ? columns.filter(isVisible) : columns;

  // ── Row windowing (opt-in via `virtualize`) ──────────────────────────────
  // Only kicks in past `threshold` rows; below it the table renders exactly as
  // before (no scroll container). The hook self-disables where the viewport can't
  // be measured (SSR/tests) → every row renders, so nothing becomes untestable.
  const scrollRef = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const vThreshold = virtualize?.threshold ?? 100;
  const estimateRowHeight = virtualize?.estimateRowHeight ?? 48;
  const maxHeight = virtualize?.maxHeight ?? 560;
  // Window once the row count REACHES the threshold (>=), not strictly exceeds it.
  // The roster's first page is exactly DEFAULT_LIMIT rows, so a strict `>` at
  // threshold:50 could never engage on a 50-row page (50 > 50 is false); `>=` makes
  // a full 50-row page window as intended.
  const wantVirtual = !!virtualize && !loading && rows.length >= vThreshold;
  const virtual = useVirtualRows({
    count: rows.length,
    estimateRowHeight,
    overscan: virtualize?.overscan ?? 8,
    getScrollElement,
    enabled: wantVirtual,
    initialViewport: maxHeight,
  });
  const windowed = wantVirtual && virtual.active;
  const colSpan = visibleColumns.length + (selection ? 1 : 0);

  const renderRow = (row: Row, index: number) => {
    const key = rowKey(row);
    return (
      <tr
        key={key}
        ref={windowed ? (el) => virtual.measureElement(index, el) : undefined}
        className={cx(styles.tr, onRowClick && styles.clickable)}
        onClick={onRowClick ? () => onRowClick(row) : undefined}
      >
        {selection && (
          <td className={cx(styles.checkCell)} onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              aria-label="行を選択"
              checked={selection.selectedKeys.includes(key)}
              onChange={() => toggleOne(key)}
            />
          </td>
        )}
        {visibleColumns.map((col) => (
          <td
            key={col.key}
            className={cx(styles.td, col.noWrap && styles.noWrap)}
            style={{ minWidth: col.minWidth, textAlign: col.align ?? "left" }}
          >
            {col.cell(row)}
          </td>
        ))}
      </tr>
    );
  };

  const picker = columnHiding ? (
    <ColumnPicker
      columns={columns}
      isVisible={isVisible}
      onToggle={toggle}
      onShowAll={showAll}
      onReset={reset}
      label={columnHiding.label}
      testId={testId}
    />
  ) : null;

  const allKeys = rows.map(rowKey);
  const allSelected = selection != null && allKeys.length > 0 && allKeys.every((k) => selection.selectedKeys.includes(k));

  const toggleAll = () => {
    if (!selection) return;
    selection.onChange(allSelected ? [] : allKeys);
  };
  const toggleOne = (key: string) => {
    if (!selection) return;
    const set = new Set(selection.selectedKeys);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    selection.onChange([...set]);
  };

  if (!loading && rows.length === 0 && emptyState) {
    return (
      <>
        {picker}
        <div className={cx(styles.emptyWrap)} data-testid={testId}>
          {emptyState}
        </div>
      </>
    );
  }

  return (
    <>
      {picker}
      <div
        ref={scrollRef}
        className={cx(styles.wrap, wantVirtual && styles.scroll)}
        style={wantVirtual ? { maxHeight } : undefined}
        data-testid={testId}
      >
        <table className={cx(styles.table)}>
          <thead className={cx(wantVirtual && styles.stickyHead)}>
            <tr>
              {selection && (
                <th className={cx(styles.checkCell)}>
                  <input
                    type="checkbox"
                    aria-label="全選択"
                    checked={allSelected}
                    onChange={toggleAll}
                    data-testid={testId ? `${testId}-select-all` : undefined}
                  />
                </th>
              )}
              {visibleColumns.map((col) => {
                const active = sort?.key === col.key;
                return (
                  <th
                    key={col.key}
                    className={cx(styles.th)}
                    style={{ width: col.width, minWidth: col.minWidth, textAlign: col.align ?? "left" }}
                    aria-sort={active ? (sort?.direction === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {col.sortable && onSortChange ? (
                      <button
                        type="button"
                        className={cx(styles.sortButton)}
                        onClick={() => onSortChange(nextSort(sort, col.key))}
                      >
                        {col.header}
                        {active && (
                          <Icon name={sort?.direction === "asc" ? "chevron-down" : "chevron-right"} size="sm" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className={cx(styles.loadingCell)} colSpan={colSpan}>
                  <Spinner />
                </td>
              </tr>
            ) : windowed ? (
              <>
                {virtual.paddingTop > 0 && (
                  <tr aria-hidden="true" style={{ height: virtual.paddingTop }}>
                    <td colSpan={colSpan} style={{ padding: 0, border: 0 }} />
                  </tr>
                )}
                {rows
                  .slice(virtual.startIndex, virtual.endIndex + 1)
                  .map((row, i) => renderRow(row, virtual.startIndex + i))}
                {virtual.paddingBottom > 0 && (
                  <tr aria-hidden="true" style={{ height: virtual.paddingBottom }}>
                    <td colSpan={colSpan} style={{ padding: 0, border: 0 }} />
                  </tr>
                )}
              </>
            ) : (
              rows.map((row, index) => renderRow(row, index))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
