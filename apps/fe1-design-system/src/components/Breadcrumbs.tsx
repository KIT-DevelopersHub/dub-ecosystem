import type { ReactNode } from "react";
import type { BreadcrumbItem, BreadcrumbsProps } from "../types";
import styles from "./Breadcrumbs.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";

/**
 * Router-free breadcrumb trail (P2-1). Restores the "現在地 / 戻る" wayfinding lost
 * when the persistent sidebar was dropped for the app-launcher model: deep screens
 * (イベント > アクション詳細 / ロール編集 / ユーザー詳細) show the path and each
 * ancestor is clickable to walk back up.
 *
 * FE1 stays router-free (凍結案): pass `onClick` for a plain handler, or `renderLink`
 * to inject a real router Link around each ancestor node. The LAST item is the
 * current page — it is never a link and carries `aria-current="page"`.
 */
export function Breadcrumbs({ items, renderLink, testId }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  const renderCrumb = (item: BreadcrumbItem, index: number): ReactNode => {
    const isLast = index === items.length - 1;
    const inner = (
      <span className={cx(styles.crumbInner)}>
        {item.icon && <Icon name={item.icon} size="sm" />}
        <span className={cx(styles.label)}>{item.label}</span>
      </span>
    );

    let node: ReactNode;
    if (isLast) {
      node = (
        <span className={cx(styles.current)} aria-current="page">
          {inner}
        </span>
      );
    } else if (renderLink) {
      node = renderLink(item, <span className={cx(styles.link)}>{inner}</span>);
    } else if (item.onClick) {
      node = (
        <button type="button" className={cx(styles.link, styles.linkButton)} onClick={item.onClick}>
          {inner}
        </button>
      );
    } else if (item.href) {
      node = (
        <a href={item.href} className={cx(styles.link)}>
          {inner}
        </a>
      );
    } else {
      node = <span className={cx(styles.link)}>{inner}</span>;
    }

    return (
      <li
        key={index}
        className={cx(styles.crumb)}
        data-testid={testId ? `${testId}-item-${index}` : undefined}
      >
        {node}
        {!isLast && (
          <Icon name="chevron-right" size="sm" className={cx(styles.separator)} />
        )}
      </li>
    );
  };

  return (
    <nav className={cx(styles.breadcrumbs)} aria-label="パンくずリスト" data-testid={testId}>
      <ol className={cx(styles.list)}>{items.map(renderCrumb)}</ol>
    </nav>
  );
}
