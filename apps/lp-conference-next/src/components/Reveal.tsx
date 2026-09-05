"use client";

import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

// Reveal — 「下から立ち上がる」演出を SSG-safe かつ「既定 visible・足すだけ」で足す。
//
// ★ 既知バグ回避（最重要 / Astro 版で About・クラファン・応募・お問い合わせが
//   opacity:0 のまま真っ白になった事故の再発防止）:
//   1) サーバー(SSG)・hydrate 前・reduced-motion では素の要素をそのまま描画（常に可視）。
//   2) client でも「既定は可視」。マウント時にビューポート下端より下にある要素だけを
//      いったん隠して、スクロールで入ってきたら立ち上げる（＝見えている物は隠さない）。
//   3) IntersectionObserver 非対応なら隠さない（可視のまま）。
//   4) 安全タイマー: 何があっても一定時間後に必ず可視化する（永久に opacity:0 で
//      固定されることが構造上あり得ない）。
//   これにより「reveal 未発火でも必ず見える」を満たす。

type RevealTag = "div" | "section" | "p" | "li" | "ul" | "h2" | "h3" | "span";
type Phase = "static" | "hidden" | "shown";

export interface RevealProps {
  children: ReactNode;
  className?: string;
  /** 立ち上がりの遅延（グループ内で少しずつずらす）。 */
  delay?: number;
  /** レンダリングする要素タグ（意味づけ・CSS セレクタ維持のため）。 */
  as?: RevealTag;
  id?: string;
  role?: string;
  "aria-label"?: string;
}

// これ以上「下」にある要素だけを最初に隠す（見えている物は隠さない）。
const BELOW_FOLD_RATIO = 0.92;
// 安全網: この時間を過ぎたら reveal の発火有無に関わらず必ず可視化。
const SAFETY_MS = 4000;

export function Reveal({
  children,
  className,
  delay = 0,
  as = "div",
  ...rest
}: RevealProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("static");

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (reduce) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return; // 非対応 → 可視のまま

    const rect = el.getBoundingClientRect();
    const belowFold = rect.top > window.innerHeight * BELOW_FOLD_RATIO;
    if (!belowFold) return; // 既に見えている / 画面内 → 隠さない（チラつき無し）

    setPhase("hidden");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setPhase("shown");
            io.disconnect();
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);

    const timer = window.setTimeout(() => {
      setPhase("shown"); // 安全網: 絶対に隠しっぱなしにしない
      io.disconnect();
    }, SAFETY_MS);

    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [reduce]);

  // SSG / hydrate 前 / reduced-motion → 素の要素（常に可視）。
  if (!mounted || reduce) {
    return createElement(as, { className, ...rest }, children);
  }

  const MotionTag = motion[as];
  return (
    <MotionTag
      ref={ref as never}
      className={className}
      // initial={false}: マウント時は現在値（可視）から始めてチラつきを防ぐ。
      initial={false}
      animate={phase === "hidden" ? { opacity: 0, y: 18 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay }}
      {...rest}
    >
      {children}
    </MotionTag>
  );
}
