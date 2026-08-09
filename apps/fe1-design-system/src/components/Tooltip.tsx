import { useId, useState } from "react";
import type { PopoverProps, TooltipProps } from "../types";
import styles from "./Tooltip.module.css";
import { cx } from "../utils/cx";

export function Tooltip({ content, placement = "top", testId, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className={cx(styles.wrap)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      data-testid={testId}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      {open && (
        <span role="tooltip" id={id} className={cx(styles.bubble)} data-placement={placement}>
          {content}
        </span>
      )}
    </span>
  );
}

export function Popover({
  trigger,
  open: controlledOpen,
  onOpenChange,
  placement = "bottom",
  testId,
  children,
}: PopoverProps) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolled;
  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolled(next);
    onOpenChange?.(next);
  };
  return (
    <span className={cx(styles.wrap)} data-testid={testId}>
      <button
        type="button"
        className={cx(styles.trigger)}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div role="dialog" className={cx(styles.panel)} data-placement={placement}>
          {children}
        </div>
      )}
    </span>
  );
}
