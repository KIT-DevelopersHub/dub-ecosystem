import { useCallback, useState } from "react";
import type { ColumnDef, DataTableProps, SortState } from "../types";
import styles from "./DataTable.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";
import { Skeleton } from "./Skeleton";
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
  testId,
}: DataTableProps<Row>) {
  const { isVisible, toggle, showAll, reset } = useColumnVisibility(columns, columnHiding?.storageKey);
  const visibleColumns = columnHiding ? columns.filter(isVisible) : columns;

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
      <div className={cx(styles.wrap)} data-testid={testId}>
        <table className={cx(styles.table)} aria-busy={loading || undefined}>
          <thead>
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
              // Loading placeholder rows reuse the SAME <tr>/<td> structure (and per-column
              // widths/alignment) as loaded rows, so the skeleton lines up 1:1 with real data
              // — no vertical shift when it resolves (FE1 §5 loading principle).
              Array.from({ length: 6 }).map((_, r) => (
                <tr key={`dt-skeleton-${r}`} className={cx(styles.tr)} aria-hidden="true">
                  {selection && (
                    <td className={cx(styles.checkCell)}>
                      <Skeleton variant="rect" width={16} height={16} />
                    </td>
                  )}
                  {visibleColumns.map((col) => (
                    <td
                      key={col.key}
                      className={cx(styles.td, col.noWrap && styles.noWrap)}
                      style={{ minWidth: col.minWidth, textAlign: col.align ?? "left" }}
                    >
                      <Skeleton
                        variant="text"
                        width={col.align === "right" ? "3rem" : "70%"}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              rows.map((row) => {
                const key = rowKey(row);
                return (
                  <tr
                    key={key}
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
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
