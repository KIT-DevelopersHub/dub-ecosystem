// Menu (dropdown). A trigger button that toggles a small panel of actions —
// the generic disclosure primitive behind header "設定" menus, kebab menus, etc.
// Fills the gap between Popover (bare panel, caller supplies everything) and
// AppLauncher (a fixed 3×3 app grid): here the caller passes a flat `items` list
// and Menu renders labelled `role="menuitem"` rows, closing on select.
//
// FE1 stays router-free: items carry `onSelect`; navigation/dialogs are the
// consumer's concern. Interaction (outside-click + Escape close) mirrors
// AppLauncher so every header dropdown behaves the same.
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MenuProps, MenuItem } from "../types";
import { Button } from "./Button";
import { Icon } from "./Icon";
import styles from "./Menu.module.css";
import { cx } from "../utils/cx";

export function Menu({
  label,
  items,
  icon,
  variant = "ghost",
  align = "end",
  menuLabel,
  iconOnly = false,
  testId,
}: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Close on outside click / Escape so the panel behaves like a menu (parity with
  // AppLauncher). Only wired while open to keep listeners off the idle path.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const select = (item: MenuItem): void => {
    if (item.disabled) return;
    setOpen(false);
    item.onSelect();
  };

  const triggerTestId = testId ? `${testId}-trigger` : undefined;

  return (
    <div className={cx(styles.root)} ref={rootRef} data-testid={testId}>
      {iconOnly ? (
        // 40px square icon control — same class as the AppLauncher/bell triggers,
        // so header controls read as one uniform row (no text, no chevron).
        <button
          type="button"
          className={cx(styles.iconTrigger)}
          aria-label={menuLabel ?? label}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid={triggerTestId}
          onClick={() => setOpen((v) => !v)}
        >
          {icon ? <Icon name={icon} /> : null}
        </button>
      ) : (
        <Button
          variant={variant}
          iconLeft={icon ? <Icon name={icon} /> : undefined}
          iconRight={<Icon name="chevron-down" size="sm" />}
          onClick={() => setOpen((v) => !v)}
          {...(triggerTestId ? { testId: triggerTestId } : {})}
        >
          {label}
        </Button>
      )}
      {open && (
        <div
          role="menu"
          aria-label={menuLabel ?? label}
          id={panelId}
          className={cx(styles.panel)}
          data-align={align}
        >
          {items.map((item): ReactNode => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={cx(styles.item)}
              disabled={item.disabled ?? false}
              aria-disabled={item.disabled ?? undefined}
              data-testid={item.testId}
              onClick={() => select(item)}
            >
              {item.icon ? (
                <span className={cx(styles.itemIcon)}>
                  <Icon name={item.icon} size="sm" />
                </span>
              ) : null}
              <span className={cx(styles.itemLabel)}>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
