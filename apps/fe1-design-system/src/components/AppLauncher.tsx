// AppLauncher (凍結案 1-4-3). A Chrome-waffle-style app switcher for the top bar:
// a 3×3 grid "waffle" button that opens a popover of tool tiles. Replaces the
// persistent left rail so feature surfaces (mail/chat) get the full canvas.
//
// IP note: the waffle glyph is a plain self-drawn 3×3 dot grid (no Google mark or
// asset). FE1 stays router-free — the consumer maps `href` to navigation via
// `onSelect`. Tool visibility (role/permission filtering) is decided upstream by
// whoever builds `items`; this component only renders and dispatches.
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppLauncherProps, AppLauncherItem } from "../types";
import { Icon } from "./Icon";
import { Badge } from "./Display";
import styles from "./AppLauncher.module.css";
import { cx } from "../utils/cx";

/** Self-drawn 3×3 dot grid (waffle). Not Google's asset — nine plain circles. */
function WaffleGlyph(): JSX.Element {
  const cells = [4, 12, 20];
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {cells.flatMap((cy) =>
        cells.map((cx2) => <circle key={`${cx2}-${cy}`} cx={cx2 + 2} cy={cy + 2} r={2.2} fill="currentColor" />),
      )}
    </svg>
  );
}

export function AppLauncher({
  items,
  onSelect,
  label = "アプリ",
  title = "アプリ",
  testId,
}: AppLauncherProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Close on outside click / Escape so the popover behaves like a menu.
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

  const select = (item: AppLauncherItem): void => {
    setOpen(false);
    onSelect?.(item);
  };

  return (
    <div className={cx(styles.root)} ref={rootRef} data-testid={testId}>
      <button
        type="button"
        className={cx(styles.trigger)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid={testId ? `${testId}-trigger` : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <WaffleGlyph />
      </button>
      {open && (
        <div role="dialog" aria-label={title} id={panelId} className={cx(styles.panel)}>
          <div className={cx(styles.panelTitle)}>{title}</div>
          <div className={cx(styles.grid)} role="menu">
            {items.map((item): ReactNode => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={cx(styles.tile)}
                data-testid={testId ? `${testId}-item-${item.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}` : undefined}
                // Release-gated tiles stay in the grid (消さない) but are greyed +
                // non-interactive; the reason surfaces as a native tooltip.
                disabled={item.disabled ?? false}
                aria-disabled={item.disabled ?? undefined}
                title={item.disabled ? item.disabledReason : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  select(item);
                }}
              >
                <span className={cx(styles.tileIcon)}>
                  {item.icon ? <Icon name={item.icon} size="md" /> : null}
                  {typeof item.badgeCount === "number" && item.badgeCount > 0 ? (
                    <span className={cx(styles.tileBadge)}>
                      <Badge tone="danger">{item.badgeCount > 99 ? "99+" : item.badgeCount}</Badge>
                    </span>
                  ) : null}
                </span>
                <span className={cx(styles.tileLabel)}>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
