"use client";

import { useEffect, useState } from "react";

// First-paint entrance curtain — now PURE CSS (framer-motion removed).
// A full-viewport brand curtain covers the page on hydration, holds a beat with
// the wordmark, then RECEDES (fade + scale + blur) while a shockwave ring
// expands from center. Combined with the Hero's own CSS burst, the page reads as
// content expanding out of a loading state rather than a static fade-in.
//
// SSG / no-JS: nothing renders (content is never trapped behind a curtain).
// prefers-reduced-motion: nothing renders — content is visible immediately.
// The curtain is decorative (aria-hidden) and removes itself from the DOM when
// its CSS animation finishes.
const TOTAL_MS = 1500;

export function Entrance() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // reduced-motion → no curtain
    }
    setShow(true);
    const t = window.setTimeout(() => setShow(false), TOTAL_MS);
    return () => window.clearTimeout(t);
  }, []);

  if (!show) return null;

  return (
    <div className="lp-entrance" aria-hidden="true">
      <span className="lp-entrance-wave" />
      <span className="lp-entrance-mark">HOKURIKU IT CONFERENCE</span>
    </div>
  );
}
