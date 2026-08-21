import { useLayoutEffect, useRef, useState } from "react";
import type { TabsProps } from "../types";
import styles from "./Tabs.module.css";
import { cx } from "../utils/cx";

export function Tabs({ items, activeId, onChange, testId }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // A03: sliding active-tab underline. We measure the active tab's box and move a
  // single indicator with transform/width so it glides between tabs instead of
  // the underline jumping instantly.
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.querySelector<HTMLElement>('[data-active="true"]');
    if (!activeEl) {
      setIndicator(null);
      return;
    }
    const update = () => setIndicator({ left: activeEl.offsetLeft, width: activeEl.offsetWidth });
    update();
    // Keep the indicator aligned when the tab strip reflows (resize / font load).
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(list);
    return () => ro?.disconnect();
  }, [activeId, items]);

  return (
    <div ref={listRef} className={cx(styles.tabs)} role="tablist" data-testid={testId}>
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-active={active ? "true" : undefined}
            disabled={item.disabled}
            className={cx(styles.tab, active && styles.active)}
            data-testid={testId ? `${testId}-tab-${item.id}` : undefined}
            onClick={() => !item.disabled && onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
      {indicator && (
        <span
          className={cx(styles.indicator)}
          aria-hidden="true"
          style={{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }}
        />
      )}
    </div>
  );
}
