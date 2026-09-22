"use client";

import { createElement, useEffect, useRef, useState, type ReactNode } from "react";

// Reveal — scroll-in reveal engine for the goodpatch-style rebuild.
//
// Two families of motion, both SSG-safe and "default-visible / add-only":
//   • variant "up" | "fade" | "wipe" | "rise-lg"  — a clean ONE-SHOT reveal
//       (fade + lift, or a left→right clip wipe) fired once when the element
//       scrolls into view. This is the primary, editorial goodpatch feel:
//       generous, confident, staggered.
//   • variant "haze"  — the v3/v2.2 "蜃気楼" position-linked fade kept alive:
//       the element's live viewport position is written to --p every frame and
//       CSS softens opacity/translateY continuously so lower content stays
//       gently hazed and sharpens as it rises. Used sparingly where the drifting
//       quality suits the new layout.
//
// ★ 白画面事故の再発防止（最重要）:
//   1) SSG / hydrate 前 / prefers-reduced-motion / IO 非対応 → 素の要素（常に可視）。
//   2) client でも既定は可視。マウント時に「ビューポート下端より下（まだ見えていない）」
//      要素にだけ初期の隠し状態(.is-armed)を付ける。既に見えている物は絶対に触らない。
//   3) 安全網: 一定時間後は必ず可視化する（opacity:0 に固定され続ける構造を排除）。
//
// framer-motion は一切使わない（軽量・GPU 合成 = opacity/transform/clip-path のみ）。

type RevealTag =
  | "div" | "section" | "p" | "li" | "ul" | "h2" | "h3" | "span" | "a";
type Variant = "up" | "fade" | "wipe" | "rise-lg" | "haze";

export interface RevealProps {
  children: ReactNode;
  className?: string;
  /** 立ち上がりの遅延（グループ内で少しずつずらす）。ms。 */
  delay?: number;
  /** モーションの種類。既定は "up"（下からのクリーンなリフト）。 */
  variant?: Variant;
  as?: RevealTag;
  id?: string;
  role?: string;
  href?: string;
  "aria-label"?: string;
}

// これ以上「下」にある要素だけを最初に隠す（見えている物は隠さない）。
const BELOW_FOLD_RATIO = 0.86;
// 安全網: この時間を過ぎたら reveal の発火有無に関わらず必ず可視化。
const SAFETY_MS = 4200;

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduce;
}

export function Reveal({
  children,
  className,
  delay = 0,
  variant = "up",
  as = "div",
  ...rest
}: RevealProps) {
  const reduce = usePrefersReducedMotion();
  const ref = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (reduce) return;
    const el = ref.current;
    if (
      !el ||
      typeof IntersectionObserver === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      return; // 非対応 → 可視のまま
    }

    const rect = el.getBoundingClientRect();
    const belowFold = rect.top > window.innerHeight * BELOW_FOLD_RATIO;
    if (!belowFold) return; // すでに見えている / 画面内 → 触らない（チラつき無し）

    // ---- haze: 位置連動フェード ----
    if (variant === "haze") {
      const writeP = () => {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const center = r.top + r.height / 2;
        let p = 1 - center / vh; // vh(下端)→0, 0(上端)→1
        if (p < 0) p = 0;
        else if (p > 1) p = 1;
        el.style.setProperty("--p", p.toFixed(4));
      };
      writeP();
      el.classList.add("reveal--haze");

      let active = false;
      let raf = 0;
      let done = false;
      const compute = () => {
        raf = 0;
        writeP();
      };
      const onScroll = () => {
        if (raf || done) return;
        raf = window.requestAnimationFrame(compute);
      };
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (done) return;
            if (e.isIntersecting) {
              if (!active) {
                active = true;
                window.addEventListener("scroll", onScroll, { passive: true });
                window.addEventListener("resize", onScroll, { passive: true });
              }
              compute();
            } else if (active) {
              active = false;
              window.removeEventListener("scroll", onScroll);
              window.removeEventListener("resize", onScroll);
            }
          }
        },
        { threshold: 0 },
      );
      io.observe(el);
      const timer = window.setTimeout(() => {
        done = true;
        el.style.setProperty("--p", "1");
        if (raf) window.cancelAnimationFrame(raf);
        io.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
      }, SAFETY_MS);
      return () => {
        done = true;
        io.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
        if (raf) window.cancelAnimationFrame(raf);
        window.clearTimeout(timer);
      };
    }

    // ---- one-shot reveal (up / fade / wipe / rise-lg) ----
    // まず隠し初期状態を付与し、交差したら .is-in で最終状態へトランジション。
    el.classList.add("is-armed");
    let done = false;
    const reveal = () => {
      if (done) return;
      done = true;
      el.classList.add("is-in");
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            reveal();
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    // 安全網: 一定時間後は必ず可視化。
    const timer = window.setTimeout(() => {
      reveal();
      io.disconnect();
    }, SAFETY_MS);
    return () => {
      done = true;
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [reduce, variant]);

  // SSG / hydrate 前 / reduced-motion → 素の要素（常に可視）。
  if (!mounted || reduce) {
    return createElement(as, { className, ...rest }, children);
  }

  const cls = [className, "reveal", `reveal--${variant}`]
    .filter(Boolean)
    .join(" ");

  return createElement(
    as,
    {
      ref,
      className: cls,
      style: delay
        ? ({ ["--reveal-delay" as string]: `${delay}ms` } as Record<string, string>)
        : undefined,
      ...rest,
    },
    children,
  );
}
