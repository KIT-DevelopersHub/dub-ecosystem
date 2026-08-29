import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { SegmentedControlProps, SegmentedOption } from "../types";
import { Icon } from "./Icon";
import { cx } from "../utils/cx";
import styles from "./SegmentedControl.module.css";

// A segmented control: a row of mutually-exclusive options with a highlight pill
// that glides under the selected one. Renders as a WAI-ARIA `tablist` (each option
// is a `tab` reflecting `aria-selected`). The pill's geometry is measured at
// runtime (so options can wrap to a new row), while its look + easing live in the
// CSS module — one place to tune the motion. Respects `prefers-reduced-motion`
// (handled in CSS: the highlight stays, the glide is dropped).
//
// Controlled (`value` + `onChange`) or uncontrolled (`defaultValue`, else the
// first enabled option is auto-selected so the strip is never blank on mount).

type IndicatorBox = { x: number; y: number; w: number; h: number; show: boolean };

function firstEnabled<V extends string>(options: SegmentedOption<V>[]): V | null {
  return options.find((o) => !o.disabled)?.value ?? options[0]?.value ?? null;
}

export function SegmentedControl<V extends string = string>({
  options,
  value,
  defaultValue,
  onChange,
  caption,
  captionTestId,
  size = "md",
  testId,
  className,
  ...rest
}: SegmentedControlProps<V>) {
  const ariaLabel = rest["aria-label"];
  const isControlled = value !== undefined;

  // Uncontrolled selection: seed once from defaultValue or the first enabled option.
  const [internal, setInternal] = useState<V | null>(
    () => defaultValue ?? firstEnabled(options),
  );
  const selected = isControlled ? value ?? null : internal;

  const select = useCallback(
    (next: V) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  // Slide the pill under the selected option: measure that button's box inside the
  // strip and feed transform/width/height to the indicator (transition in CSS).
  const stripRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [indicator, setIndicator] = useState<IndicatorBox>({ x: 0, y: 0, w: 0, h: 0, show: false });

  useLayoutEffect(() => {
    const btn = selected != null ? btnRefs.current.get(selected) : null;
    if (!btn) {
      setIndicator((s) => (s.show ? { ...s, show: false } : s));
      return;
    }
    const measure = () =>
      setIndicator({ x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight, show: btn.offsetWidth > 0 });
    measure();
    // Re-measure when the strip resizes (options wrapping to a new row shift every box).
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && stripRef.current) ro.observe(stripRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [selected, options.length]);

  // Roving focus: Left/Right (and Up/Down) move focus across enabled options,
  // Home/End jump to the ends; click / Enter / Space (native button) selects.
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    // Roving focus across the enabled options only (disabled ones are skipped).
    const enabled = options.filter((o) => !o.disabled);
    const n = enabled.length;
    if (n === 0) return;
    const pos = enabled.findIndex((o) => o.value === options[idx]?.value);
    let next: SegmentedOption<V> | undefined;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = enabled[(pos + 1) % n];
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = enabled[(pos - 1 + n) % n];
        break;
      case "Home":
        next = enabled[0];
        break;
      case "End":
        next = enabled[n - 1];
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next) btnRefs.current.get(next.value)?.focus();
  };

  return (
    <div className={styles.root} data-size={size}>
      {caption != null ? (
        <div className={styles.caption} data-testid={captionTestId}>
          {caption}
        </div>
      ) : null}
      <div
        ref={stripRef}
        className={cx(styles.strip, className)}
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        data-testid={testId}
      >
        {/* Pill that glides under the selected option. Geometry is measured, so it
            stays inline; the surface/border/shadow + easing live in the CSS module. */}
        <div
          aria-hidden="true"
          className={styles.indicator}
          style={{
            transform: `translate(${indicator.x}px, ${indicator.y}px)`,
            width: indicator.w,
            height: indicator.h,
            opacity: indicator.show ? 1 : 0,
          }}
        />
        {options.map((opt, idx) => {
          const active = opt.value === selected;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              ref={(el) => {
                if (el) btnRefs.current.set(opt.value, el);
                else btnRefs.current.delete(opt.value);
              }}
              className={styles.segment}
              aria-selected={active}
              aria-controls={opt.controls}
              // Only reflect expanded when the segment declares a controlled panel.
              aria-expanded={opt.controls != null ? active : undefined}
              disabled={opt.disabled}
              tabIndex={active ? 0 : -1}
              onClick={() => !opt.disabled && select(opt.value)}
              onKeyDown={(e) => onKeyDown(e, idx)}
              data-testid={opt.testId}
            >
              {opt.icon ? <Icon name={opt.icon} size={size} /> : null}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
