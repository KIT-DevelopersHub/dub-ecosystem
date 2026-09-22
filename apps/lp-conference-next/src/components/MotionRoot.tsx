"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// MotionRoot — the single client-side motion orchestrator that reproduces
// goodpatch.com/ja's "dynamic" feel with the same library stack goodpatch ships
// (detected in their bundle: GSAP + ScrollTrigger + Lenis + @gsap/react).
//
// It wires four families of motion, ALL gated behind prefers-reduced-motion and
// all "add-only" (the page renders fully visible without JS — nothing here can
// trap content behind an opacity:0):
//
//   1. Lenis inertia smooth-scroll   — the biggest single feel change. Real-
//      scroll mode (sets scrollTop), so native anchors, IntersectionObserver
//      reveals and the ScrollProgress bar keep working. Driven by the GSAP
//      ticker and synced to ScrollTrigger (goodpatch's exact integration).
//   2. Scroll-scrubbed parallax      — every [data-parallax] element drifts at
//      its own speed as it crosses the viewport (depth). Written to the CSS
//      custom property --par-y and applied via `translate:` so it composes with
//      the elements' own CSS keyframe transforms (no transform clobbering).
//   3. Scroll-linked line draws      — [data-line] elements scrub a 0→1 draw
//      progress into --line (goodpatch's clip-path/scaleX progress reveal).
//   4. Magnetic CTAs + custom cursor — pointer-follow micro-interaction on
//      fine-pointer devices only (goodpatch's polished hover feel).
//
// Easing vocabulary mirrors the cubic-beziers found in goodpatch's CSS:
//   easeOutQuint  cubic-bezier(.22,1,.36,1)   — reveals / entrances
//   easeOutQuart  cubic-bezier(.25,1,.5,1)
//   easeInOutQuint cubic-bezier(.83,0,.17,1)
// Lenis uses easeOutExpo for the wheel glide.

function prefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function MotionRoot() {
  useEffect(() => {
    if (prefersReduced()) return;
    if (typeof window === "undefined") return;

    gsap.registerPlugin(ScrollTrigger);

    // ---------------------------------------------------------------
    // 1) Lenis inertia smooth-scroll, synced to GSAP + ScrollTrigger
    // ---------------------------------------------------------------
    const lenis = new Lenis({
      duration: 1.15, // glide length (s) — goodpatch-ish weighty inertia
      // easeOutExpo — the classic Lenis/goodpatch wheel glide
      easing: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
      wheelMultiplier: 1,
      touchMultiplier: 1.6,
      smoothWheel: true,
    });

    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    // Route in-page anchor clicks through Lenis for a smooth glide to targets.
    const onAnchorClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.(
        'a[href^="#"]',
      ) as HTMLAnchorElement | null;
      if (!a) return;
      const hash = a.getAttribute("href");
      if (!hash || hash === "#") return;
      const target = document.querySelector(hash);
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target as HTMLElement, { offset: -72, duration: 1.2 });
    };
    document.addEventListener("click", onAnchorClick);

    // Pause smooth-scroll while a modal dialog is open so wheel/touch input does
    // not scroll the page behind the backdrop (Program dispatches 'lp:dialog').
    const onDialogToggle = (e: Event) => {
      const openNow = (e as CustomEvent<{ open: boolean }>).detail?.open;
      if (openNow) lenis.stop();
      else lenis.start();
    };
    window.addEventListener("lp:dialog", onDialogToggle as EventListener);

    // ---------------------------------------------------------------
    // 2) Scroll-scrubbed parallax  ([data-parallax="<px amplitude>"])
    //    Positive amplitude → element lags (drifts down as you scroll down),
    //    reads as "further back". Applied to --par-y (see globals.css).
    // ---------------------------------------------------------------
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>("[data-parallax]").forEach((el) => {
        const amp = parseFloat(el.dataset.parallax || "60");
        gsap.fromTo(
          el,
          { "--par-y": amp },
          {
            "--par-y": -amp,
            ease: "none",
            scrollTrigger: {
              trigger: el,
              start: "top bottom",
              end: "bottom top",
              scrub: 0.6,
            },
          },
        );
      });

      // 3) Scroll-linked line/underline draw  ([data-line])
      gsap.utils.toArray<HTMLElement>("[data-line]").forEach((el) => {
        gsap.fromTo(
          el,
          { "--line": 0 },
          {
            "--line": 1,
            ease: "none",
            scrollTrigger: {
              trigger: el,
              start: "top 88%",
              end: "top 46%",
              scrub: 0.5,
            },
          },
        );
      });
    });

    // ScrollTrigger must re-measure once fonts/images settle.
    const refresh = () => ScrollTrigger.refresh();
    window.addEventListener("load", refresh);
    const refreshTimer = window.setTimeout(refresh, 600);

    // ---------------------------------------------------------------
    // 4) Magnetic CTAs + custom cursor (fine pointer only)
    // ---------------------------------------------------------------
    let cleanupPointer = () => {};
    if (window.matchMedia?.("(pointer: fine)").matches) {
      cleanupPointer = setupPointer();
    }

    return () => {
      document.removeEventListener("click", onAnchorClick);
      window.removeEventListener("lp:dialog", onDialogToggle as EventListener);
      window.removeEventListener("load", refresh);
      window.clearTimeout(refreshTimer);
      gsap.ticker.remove(tick);
      ctx.revert();
      lenis.destroy();
      cleanupPointer();
    };
  }, []);

  return null;
}

// Custom cursor (a soft dot + a lagging ring) plus magnetic pull on primary
// CTAs — goodpatch's fine-pointer polish. Purely decorative; native cursor is
// hidden only while this runs (removed on cleanup / touch).
function setupPointer(): () => void {
  const dot = document.createElement("div");
  dot.className = "lp-cursor-dot";
  const ring = document.createElement("div");
  ring.className = "lp-cursor-ring";
  document.body.append(dot, ring);
  document.body.classList.add("has-lp-cursor");

  let mx = window.innerWidth / 2;
  let my = window.innerHeight / 2;
  let rx = mx;
  let ry = my;
  let raf = 0;

  const quickDotX = gsap.quickSetter(dot, "x", "px");
  const quickDotY = gsap.quickSetter(dot, "y", "px");

  const loop = () => {
    // ring trails the dot with easing (lerp) → weighty follow
    rx += (mx - rx) * 0.18;
    ry += (my - ry) * 0.18;
    gsap.set(ring, { x: rx, y: ry });
    quickDotX(mx);
    quickDotY(my);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  const onMove = (e: MouseEvent) => {
    mx = e.clientX;
    my = e.clientY;
  };
  window.addEventListener("mousemove", onMove, { passive: true });

  // Grow the ring over interactive targets.
  const interactive = 'a, button, [role="tab"], .work-card, .info-card';
  const onOver = (e: MouseEvent) => {
    if ((e.target as HTMLElement)?.closest?.(interactive)) {
      document.body.classList.add("lp-cursor-hot");
    }
  };
  const onOut = (e: MouseEvent) => {
    if ((e.target as HTMLElement)?.closest?.(interactive)) {
      document.body.classList.remove("lp-cursor-hot");
    }
  };
  document.addEventListener("mouseover", onOver);
  document.addEventListener("mouseout", onOut);

  // Magnetic pull on the strong CTAs.
  const magnets = Array.from(
    document.querySelectorAll<HTMLElement>("[data-magnetic]"),
  );
  const magnetHandlers: Array<() => void> = [];
  magnets.forEach((m) => {
    const move = (e: MouseEvent) => {
      const r = m.getBoundingClientRect();
      const relX = e.clientX - (r.left + r.width / 2);
      const relY = e.clientY - (r.top + r.height / 2);
      gsap.to(m, {
        x: relX * 0.28,
        y: relY * 0.32,
        duration: 0.5,
        ease: "power3.out",
      });
    };
    const leave = () => {
      gsap.to(m, { x: 0, y: 0, duration: 0.6, ease: "elastic.out(1, 0.4)" });
    };
    m.addEventListener("mousemove", move);
    m.addEventListener("mouseleave", leave);
    magnetHandlers.push(() => {
      m.removeEventListener("mousemove", move);
      m.removeEventListener("mouseleave", leave);
    });
  });

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseover", onOver);
    document.removeEventListener("mouseout", onOut);
    magnetHandlers.forEach((fn) => fn());
    dot.remove();
    ring.remove();
    document.body.classList.remove("has-lp-cursor", "lp-cursor-hot");
  };
}
