import type { LoadMoreProps, PaginationProps } from "../types";
import styles from "./Pagination.module.css";
import { cx } from "../utils/cx";
import { Button } from "./Button";
import { Icon } from "./Icon";

/** offset paging — totalCount APIs only (凍結案 1-6-3). */
export function Pagination({ page, pageSize, totalCount, onPageChange, testId }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const clamped = Math.min(Math.max(1, page), totalPages);
  return (
    <nav className={cx(styles.nav)} data-testid={testId} aria-label="ページネーション">
      <button
        type="button"
        className={cx(styles.pageButton)}
        disabled={clamped <= 1}
        aria-label="前のページ"
        onClick={() => onPageChange(clamped - 1)}
      >
        <Icon name="chevron-right" size="sm" className={styles.flip} />
      </button>
      <span className={cx(styles.status)} aria-live="polite">
        {clamped} / {totalPages}
      </span>
      <button
        type="button"
        className={cx(styles.pageButton)}
        disabled={clamped >= totalPages}
        aria-label="次のページ"
        onClick={() => onPageChange(clamped + 1)}
      >
        <Icon name="chevron-right" size="sm" />
      </button>
    </nav>
  );
}

/** cursor "load more" (no auto-fire・凍結案 1-6-3). hasMore=false hides it. */
export function LoadMore({ hasMore, loading, onLoadMore, label = "さらに読み込む", testId }: LoadMoreProps) {
  if (!hasMore) return null;
  return (
    <div className={cx(styles.loadMore)}>
      <Button variant="secondary" loading={loading} onClick={onLoadMore} testId={testId}>
        {label}
      </Button>
    </div>
  );
}
