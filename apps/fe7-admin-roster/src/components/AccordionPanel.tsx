import { useEffect, useRef, useState } from "react";
import styles from "./AccordionPanel.module.css";

// Exit delay must roughly match --dub-motion-normal (AccordionPanel.module.css)
// so content unmounts right as the closing transition finishes, never before or
// long after. Kept as a plain constant (not read from the CSS custom property)
// since CSS vars aren't reliably readable synchronously in JS across browsers.
const EXIT_MS = 200;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Height-animated open/close region shared by every fe7 accordion (permission
 * domain groups, per-app nested level selector). Content stays mounted for the
 * closing transition so it doesn't just pop away, then unmounts so a collapsed
 * group doesn't leave heavy hidden subtrees (matrix rows) sitting in the DOM.
 * `prefers-reduced-motion` skips the exit delay entirely (instant hide).
 */
export function AccordionPanel({
  open,
  id,
  testId,
  children,
}: {
  open: boolean;
  id?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const delay = prefersReducedMotion() ? 0 : EXIT_MS;
    timer.current = setTimeout(() => setMounted(false), delay);
    return () => clearTimeout(timer.current);
  }, [open]);

  return (
    <div id={id} data-testid={testId} className={styles.rows} data-open={open || undefined}>
      <div className={styles.clip}>{mounted ? children : null}</div>
    </div>
  );
}
