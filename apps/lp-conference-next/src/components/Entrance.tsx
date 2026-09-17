"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

// First-paint "ドワー" entrance curtain.
// A full-viewport brand-gradient curtain covers the page on hydration, holds a
// beat with a small pulsing brand mark, then RECEDES — it fades + scales up and
// out while a radial shockwave ring expands from the center. Combined with the
// Hero's own burst (which starts on the same beat), the page reads as content
// bursting/expanding out of a loading state rather than a static fade-in.
//
// Fully reduced-motion aware: under prefers-reduced-motion (or no JS) the
// curtain never shows — content is visible immediately. The curtain is purely
// decorative (aria-hidden) and removes itself from the DOM when done.
export function Entrance() {
  const reduce = useReducedMotion();
  // Starts hidden so SSR / no-JS output contains no curtain (content is never
  // trapped behind it). It's raised only after mount, then recedes.
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (reduce) return;
    setShow(true);
    // Hold the curtain briefly, then let it recede (the exit animation runs the
    // actual "open" reveal). Total on-screen time ~1.15s.
    const t = setTimeout(() => setShow(false), 620);
    return () => clearTimeout(t);
  }, [reduce]);

  if (reduce) return null;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="lp-entrance"
          aria-hidden="true"
          initial={{ opacity: 1 }}
          exit={{
            opacity: 0,
            scale: 1.12,
            filter: "blur(8px)",
            transition: { duration: 0.72, ease: [0.16, 1, 0.3, 1] },
          }}
        >
          {/* expanding shockwave ring — the visual "ドワー" pulse */}
          <motion.span
            className="lp-entrance-wave"
            initial={{ scale: 0, opacity: 0.55 }}
            animate={{ scale: 1, opacity: 0 }}
            transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
          />
          <motion.span
            className="lp-entrance-mark"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            HOKURIKU IT CONFERENCE
          </motion.span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
