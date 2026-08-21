import { useLayoutEffect, useRef, useState } from "react";
import type { TabsProps } from "../types";
import styles from "./Tabs.module.css";
import { cx } from "../utils/cx";

type Geom = { left: number; width: number };

// Remembers the last indicator geometry per Tabs instance (keyed by testId). Some
// callers remount the whole Tabs on every switch — e.g. the 運営メンバー・名簿 sub-nav
// wraps each ROUTE separately, so navigating between tabs unmounts the old Tabs and
// mounts a fresh one. Without this, the sliding underline is recreated at the new
// tab's position each time and never visibly glides. By seeding a remounted Tabs
// with the previous tab's box and moving to the new one on the next frame, the
// underline slides through the intermediate space even across remounts.
const lastGeom = new Map<string, Geom>();

function sameGeom(a: Geom | null, b: Geom | null): boolean {
  return !!a && !!b && a.left === b.left && a.width === b.width;
}

export function Tabs({ items, activeId, onChange, testId }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const key = testId ?? "";
  // A03: sliding active-tab underline. Seed from the remembered geometry so the first
  // paint after a remount shows the underline at its PREVIOUS position; a rAF then
  // moves it to the new active tab, which triggers the CSS transition -> visible slide.
  const [indicator, setIndicator] = useState<Geom | null>(() => (key ? lastGeom.get(key) ?? null : null));

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.querySelector<HTMLElement>('[data-active="true"]');
    if (!activeEl) {
      setIndicator(null);
      return;
    }
    const measure = (): Geom => ({ left: activeEl.offsetLeft, width: activeEl.offsetWidth });
    const apply = (): void => {
      const g = measure();
      if (key) lastGeom.set(key, g);
      setIndicator(g);
    };
    // If a previous (seeded) position exists and differs from the target, defer the
    // move to the next frame so the browser paints the old position first and the
    // transition actually runs. Otherwise place it immediately (first-ever mount or
    // no movement) — appearing in place must not slide from nowhere.
    const seeded = key ? lastGeom.get(key) ?? null : null;
    const target = measure();
    let raf = 0;
    if (seeded && !sameGeom(seeded, target) && typeof requestAnimationFrame !== "undefined") {
      raf = requestAnimationFrame(apply);
    } else {
      apply();
    }
    // Keep the indicator aligned when the tab strip reflows (resize / font load).
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(list);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [activeId, items, key]);

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
