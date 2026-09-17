"use client";

import { useEffect, useRef, useState } from "react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion";
import type { HeroConfig, NavLink } from "@/config/types";

// Hero (TOP). All copy is real text (h1 / p / a) for select/copy/translate/SEO.
// The right-side visual is an original, on-brand abstract "connection network"
// (nodes = engineers meeting) drawn as inline SVG with the brand gradient — no
// stock photography / people, no third-party IP.
//
// Entrance motion — the "ドワー" burst (Framer Motion, reduced-motion aware):
// timed to begin the instant the <Entrance> curtain recedes, the whole hero
// stage EXPANDS into place — the stage scales up from ~0.9 while a strong
// staggered sequence (eyebrow → title → date/venue → CTA) rushes up from below
// with a scale-up + blur-clear, and the network visual bursts open from its
// center (nodes pop, edges draw). It's deliberately big/dynamic, not a subtle
// nudge. There is NO cursor-follow on the visual (removed — read as cheap);
// depth now comes only from a gentle CSS float + a scroll parallax as the hero
// scrolls out.
// SSG / JS-off / reduced-motion render every element visible from the start
// (no opacity:0 lock).

export function Hero({ data, nav }: { data: HeroConfig; nav: NavLink[] }) {
  const reduce = useReducedMotion();
  const [ready, setReady] = useState(false);
  const heroRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (reduce) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [reduce]);

  // Scroll parallax: as the hero scrolls out, the visual drifts down, scales up
  // and fades — a big, clearly-felt movement (not a subtle nudge) so the whole
  // hero reads as a moving stage rather than a static banner.
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  });
  const scrollY = useTransform(scrollYProgress, [0, 1], [0, 220]);
  const scrollScale = useTransform(scrollYProgress, [0, 1], [1, 1.22]);
  const scrollOpacity = useTransform(scrollYProgress, [0, 0.8], [1, 0.1]);
  // The copy block also drifts (slower than the visual) for a layered-depth feel.
  const copyY = useTransform(scrollYProgress, [0, 1], [0, -60]);
  const copyOpacity = useTransform(scrollYProgress, [0, 0.75], [1, 0.25]);

  const oneLine = (s: string) => s.replace(/\n/g, "");
  const animate = !reduce && ready;

  // Master timeline — everything is offset by BASE so the burst fires just as
  // the entrance curtain begins receding (curtain holds ~0.62s).
  const BASE = 0.55;
  const EASE = [0.16, 1, 0.3, 1] as const;

  // Whole-stage burst: the entire hero-body expands up + in as one unit. This
  // is the dominant "ドワー" motion; the per-element stagger layers on top.
  const stageMotion = animate
    ? {
        initial: { opacity: 0, scale: 0.9, y: 26 },
        animate: { opacity: 1, scale: 1, y: 0 },
        transition: { duration: 1.05, delay: BASE, ease: EASE },
      }
    : {};

  // Per-element stagger — each rushes up from below with a scale-up; the two
  // headline elements (title, visual) additionally blur-clear for the crisp
  // "snap into focus" finish.
  const eyebrowMotion = animate
    ? {
        initial: { opacity: 0, y: 34, scale: 0.86 },
        animate: { opacity: 1, y: 0, scale: 1 },
        transition: { duration: 0.6, delay: BASE + 0.1, ease: EASE },
      }
    : {};
  const titleMotion = animate
    ? {
        initial: { opacity: 0, y: 64, scale: 1.14, filter: "blur(16px)" },
        animate: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
        transition: { duration: 1.0, delay: BASE + 0.18, ease: EASE },
      }
    : {};
  const dateMotion = animate
    ? {
        initial: { opacity: 0, y: 40, scale: 0.9 },
        animate: { opacity: 1, y: 0, scale: 1 },
        transition: { duration: 0.7, delay: BASE + 0.42, ease: EASE },
      }
    : {};
  const ctaMotion = animate
    ? {
        initial: { opacity: 0, y: 44, scale: 0.9 },
        animate: { opacity: 1, y: 0, scale: 1 },
        transition: { duration: 0.7, delay: BASE + 0.58, ease: EASE },
      }
    : {};
  // Network visual: bursts open from its own center — a big scale-from-small +
  // rotate + blur-clear, springy so it "pops" rather than glides.
  const visualMotion = animate
    ? {
        initial: { opacity: 0, scale: 0.35, rotate: -14, filter: "blur(14px)" },
        animate: { opacity: 1, scale: 1, rotate: 0, filter: "blur(0px)" },
        transition: {
          duration: 1.1,
          delay: BASE + 0.12,
          type: "spring" as const,
          stiffness: 62,
          damping: 13,
        },
      }
    : {};

  return (
    <section id="top" className="hero" ref={heroRef}>
      {/* nav (real text links) */}
      <nav className="hero-nav" aria-label="グローバルナビ">
        <ul className="hero-nav-list">
          {nav.map((l) => (
            <li key={l.href}>
              <a href={l.href}>{l.label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <motion.div className="hero-body" {...stageMotion}>
        {/* right: original abstract connection graphic (decorative) */}
        <div className="hero-visual" aria-hidden="true">
          <motion.div
            className="hero-visual-scroll"
            style={
              reduce ? undefined : { y: scrollY, scale: scrollScale, opacity: scrollOpacity }
            }
          >
            <motion.div className="hero-visual-inner" {...visualMotion}>
              <HeroNetwork burst={animate} base={BASE + 0.35} />
            </motion.div>
          </motion.div>
        </div>

        {/* left: real-text copy — drifts (slower than the visual) + fades on
            scroll-out for a layered, depth-y parallax feel. */}
        <motion.div
          className="hero-copy"
          style={reduce ? undefined : { y: copyY, opacity: copyOpacity }}
        >
          <motion.span className="hero-eyebrow" {...eyebrowMotion}>
            HOKURIKU IT CONFERENCE 2027
          </motion.span>

          <motion.h1 className="hero-title" {...titleMotion}>
            <span className="hero-title-line">
              <span className="hero-title-jp">北陸</span>
              <span className="hero-title-it">IT</span>
            </span>
            <span className="hero-title-line hero-title-line--2">カンファレンス</span>
          </motion.h1>

          <motion.div className="hero-meta" {...dateMotion}>
            <p className="hero-meta-row">
              <span className="hero-meta-label">開催日時</span>
              <span className="hero-meta-value">{data.dateLabel}</span>
            </p>
            <p className="hero-meta-row">
              <span className="hero-meta-label">会場</span>
              <span className="hero-meta-value">{data.venueLabel}</span>
            </p>
          </motion.div>

          <motion.div className="hero-ctas" {...ctaMotion}>
            {data.primaryCta && (
              data.primaryCta.enabled === false ? (
                <span
                  className="hero-cta hero-cta--participant is-disabled"
                  aria-disabled="true"
                  aria-label={`${oneLine(data.primaryCta.label)}（準備中）`}
                >
                  参加登録はこちら
                  <span className="hero-cta-badge">準備中</span>
                </span>
              ) : (
                <a
                  className="hero-cta hero-cta--participant"
                  href={data.primaryCta.href}
                  aria-label={oneLine(data.primaryCta.label)}
                >
                  参加登録はこちら
                  <span className="hero-cta-arrow" aria-hidden="true">→</span>
                </a>
              )
            )}
            {data.secondaryCta && (
              data.secondaryCta.enabled === false ? (
                <span
                  className="hero-cta hero-cta--speaker is-disabled"
                  aria-disabled="true"
                  aria-label={`${oneLine(data.secondaryCta.label)}（準備中）`}
                >
                  登壇に応募する
                  <span className="hero-cta-badge">準備中</span>
                </span>
              ) : (
                <a
                  className="hero-cta hero-cta--speaker"
                  href={data.secondaryCta.href}
                  aria-label={oneLine(data.secondaryCta.label)}
                >
                  登壇に応募する
                  <span className="hero-cta-arrow" aria-hidden="true">→</span>
                </a>
              )
            )}
          </motion.div>
        </motion.div>
      </motion.div>
    </section>
  );
}

// Abstract "engineers connecting" network — pure SVG, brand gradient. On first
// paint it bursts open: edges draw in (pathLength) and nodes pop with a stagger,
// folding the visual into the hero entrance. Afterwards a gentle CSS pulse/float
// carries on (paused under prefers-reduced-motion via CSS).
function HeroNetwork({ burst, base }: { burst: boolean; base: number }) {
  const nodes = [
    { cx: 60, cy: 70, r: 9 },
    { cx: 210, cy: 40, r: 7 },
    { cx: 330, cy: 110, r: 11 },
    { cx: 150, cy: 175, r: 8 },
    { cx: 285, cy: 220, r: 9 },
    { cx: 70, cy: 250, r: 7 },
    { cx: 360, cy: 300, r: 8 },
    { cx: 180, cy: 300, r: 10 },
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [0, 3], [3, 2], [3, 4], [2, 4],
    [3, 5], [4, 6], [4, 7], [5, 7], [7, 6],
  ];
  const EASE = [0.16, 1, 0.3, 1] as const;
  return (
    <svg
      className="hero-net"
      viewBox="0 0 420 360"
      role="presentation"
      focusable="false"
    >
      <defs>
        <linearGradient id="netGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f61d6" />
          <stop offset="1" stopColor="#17b892" />
        </linearGradient>
        <radialGradient id="nodeGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#2f61d6" stopOpacity="0.25" />
          <stop offset="1" stopColor="#2f61d6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g stroke="url(#netGrad)" strokeWidth="1.6" strokeOpacity="0.5">
        {edges.map(([a, b], i) => (
          <motion.line
            key={i}
            x1={nodes[a].cx}
            y1={nodes[a].cy}
            x2={nodes[b].cx}
            y2={nodes[b].cy}
            initial={burst ? { pathLength: 0, opacity: 0 } : undefined}
            animate={burst ? { pathLength: 1, opacity: 1 } : undefined}
            transition={
              burst
                ? { duration: 0.6, delay: base + i * 0.045, ease: EASE }
                : undefined
            }
          />
        ))}
      </g>
      <g>
        {nodes.map((n, i) => (
          <motion.g
            key={i}
            className="hero-net-node"
            style={{ animationDelay: `${i * 0.4}s`, transformBox: "fill-box", transformOrigin: "center" }}
            initial={burst ? { scale: 0, opacity: 0 } : undefined}
            animate={burst ? { scale: 1, opacity: 1 } : undefined}
            transition={
              burst
                ? {
                    delay: base + 0.25 + i * 0.06,
                    type: "spring",
                    stiffness: 340,
                    damping: 16,
                  }
                : undefined
            }
          >
            <circle cx={n.cx} cy={n.cy} r={n.r * 2.4} fill="url(#nodeGlow)" />
            <circle cx={n.cx} cy={n.cy} r={n.r} fill="url(#netGrad)" />
            <circle cx={n.cx} cy={n.cy} r={n.r} fill="#fff" fillOpacity="0.18" />
          </motion.g>
        ))}
      </g>
    </svg>
  );
}
