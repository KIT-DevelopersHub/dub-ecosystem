import type { CSSProperties } from "react";
import type {
  SkeletonProps,
  SkeletonListProps,
  SkeletonTableProps,
  SkeletonCardProps,
} from "../types";
import styles from "./Skeleton.module.css";
import { cx } from "../utils/cx";

const dim = (v: string | number | undefined): string | undefined =>
  typeof v === "number" ? `${v}px` : v;

/**
 * Skeleton — a single placeholder block for content that is loading (FE1 §5).
 * Loading UIs MUST show a skeleton, never a bare blank, so the user can tell
 * "loading" apart from "empty". Purely presentational (aria-hidden); wrap groups
 * in a composite (SkeletonList / SkeletonTable / SkeletonCard) or a
 * role="status" region so screen readers announce the loading state once.
 */
export function Skeleton({
  variant = "text",
  width,
  height,
  radius,
  animation = "shimmer",
  testId,
}: SkeletonProps) {
  const style: CSSProperties = {
    width: dim(width),
    height: dim(height),
    ...(variant === "circle" && width && !height ? { height: dim(width) } : null),
    ...(radius ? { borderRadius: radius } : null),
  };
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={cx(
        styles.block,
        styles[variant],
        animation !== "none" && styles[animation],
      )}
      style={style}
    />
  );
}

/**
 * SkeletonList — placeholder for a list of rows while it loads (FE1 §5).
 * Announces "読み込み中" once via role="status" and renders `rows` line rows,
 * optionally with a leading avatar circle.
 */
export function SkeletonList({
  rows = 3,
  avatar = false,
  animation = "shimmer",
  testId,
}: SkeletonListProps) {
  return (
    <div
      className={cx(styles.stack)}
      role="status"
      aria-label="読み込み中"
      data-testid={testId}
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={cx(styles.row)}>
          {avatar && (
            <Skeleton variant="circle" width={40} animation={animation} />
          )}
          <div className={cx(styles.rowBody)}>
            <Skeleton variant="text" width="70%" animation={animation} />
            <Skeleton variant="text" width="45%" animation={animation} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * SkeletonTable — placeholder for a data table while it loads (FE1 §5).
 * Renders an optional header row plus `rows` × `columns` cells.
 */
export function SkeletonTable({
  rows = 5,
  columns = 4,
  header = true,
  animation = "shimmer",
  testId,
}: SkeletonTableProps) {
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${columns}, 1fr)`,
  };
  return (
    <div
      className={cx(styles.table)}
      role="status"
      aria-label="読み込み中"
      data-testid={testId}
    >
      {header && (
        <div className={cx(styles.tableRow, styles.tableHeader)} style={gridStyle}>
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} variant="text" width="60%" animation={animation} />
          ))}
        </div>
      )}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className={cx(styles.tableRow)} style={gridStyle}>
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} variant="text" animation={animation} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * SkeletonCard — placeholder for a card while it loads (FE1 §5).
 * Optional leading media block plus a title line and `lines` body lines.
 */
export function SkeletonCard({
  media = false,
  lines = 2,
  animation = "shimmer",
  testId,
}: SkeletonCardProps) {
  return (
    <div
      className={cx(styles.card)}
      role="status"
      aria-label="読み込み中"
      data-testid={testId}
    >
      {media && (
        <Skeleton variant="rect" width="100%" height={120} animation={animation} />
      )}
      <Skeleton variant="text" width="55%" height={18} animation={animation} />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          variant="text"
          width={i === lines - 1 ? "40%" : "90%"}
          animation={animation}
        />
      ))}
    </div>
  );
}
