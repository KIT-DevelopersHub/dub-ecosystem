import type { ReactNode } from "react";
import type { SidebarItem, SidebarProps } from "../types";
import styles from "./Sidebar.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";
import { Badge } from "./Display";

/**
 * Router-free nav rail. `renderLink` lets FE2 inject a TanStack Router Link
 * without FE1 depending on any router (凍結案). `icon` is an IconName resolved
 * via FE1 Icon (凍結案 1-1-7).
 */
export function Sidebar({ items, activeId, renderLink, collapsed, testId }: SidebarProps) {
  const renderItem = (item: SidebarItem, depth: number): ReactNode => {
    const active = item.id === activeId;
    const inner = (
      <span className={cx(styles.itemInner)} style={{ paddingLeft: `${depth * 16}px` }}>
        {item.icon && <Icon name={item.icon} size="sm" />}
        {!collapsed && <span className={cx(styles.label)}>{item.label}</span>}
        {!collapsed && item.badgeCount != null && item.badgeCount > 0 && (
          <Badge tone="brand">{item.badgeCount}</Badge>
        )}
      </span>
    );

    const node = item.href ? (
      <a
        href={item.href}
        className={cx(styles.item, active && styles.active)}
        aria-current={active ? "page" : undefined}
      >
        {inner}
      </a>
    ) : (
      <div className={cx(styles.item, active && styles.active)} aria-current={active ? "page" : undefined}>
        {inner}
      </div>
    );

    return (
      <li key={item.id} data-testid={testId ? `${testId}-item-${item.id}` : undefined}>
        {renderLink ? renderLink(item, node) : node}
        {item.children && item.children.length > 0 && (
          <ul className={cx(styles.subList)}>{item.children.map((c) => renderItem(c, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <nav className={cx(styles.sidebar)} data-collapsed={collapsed || undefined} data-testid={testId} aria-label="サイドナビ">
      <ul className={cx(styles.list)}>{items.map((item) => renderItem(item, 0))}</ul>
    </nav>
  );
}
