import type { TabsProps } from "../types";
import styles from "./Tabs.module.css";
import { cx } from "../utils/cx";

export function Tabs({ items, activeId, onChange, testId }: TabsProps) {
  return (
    <div className={cx(styles.tabs)} role="tablist" data-testid={testId}>
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            className={cx(styles.tab, active && styles.active)}
            data-testid={testId ? `${testId}-tab-${item.id}` : undefined}
            onClick={() => !item.disabled && onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
