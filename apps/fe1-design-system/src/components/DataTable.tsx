import type { DataTableProps, SortState } from "../types";
import styles from "./DataTable.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

function nextSort(current: SortState | undefined, key: string): SortState {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: "asc" };
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
  testId,
}: DataTableProps<Row>) {
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
      <div className={cx(styles.emptyWrap)} data-testid={testId}>
        {emptyState}
      </div>
    );
  }

  return (
    <div className={cx(styles.wrap)} data-testid={testId}>
      <table className={cx(styles.table)}>
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
            {columns.map((col) => {
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
              <td className={cx(styles.loadingCell)} colSpan={columns.length + (selection ? 1 : 0)}>
                <Spinner />
              </td>
            </tr>
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
                  {columns.map((col) => (
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
  );
}
