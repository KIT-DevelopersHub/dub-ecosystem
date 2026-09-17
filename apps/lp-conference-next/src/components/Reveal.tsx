"use client";

import { createElement, useEffect, useRef, useState, type ReactNode } from "react";

// Reveal — 「下から立ち上がる」演出を SSG-safe かつ「既定 visible・足すだけ」で足す。
//
// ★ framer-motion を廃し、素の要素＋IntersectionObserver＋CSS transition で実装。
//   これで framer-motion ランタイム(~124KB チャンク)をクライアントバンドルから外し、
//   演出(opacity/transform の 0.6s トランジション)は従来と同一に保つ(GPU 合成)。
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

// prefers-reduced-motion を JS で検出（framer-motion の useReducedMotion 代替）。
// SSR/初回は false（＝素描画は下の !mounted 分岐が担保）、マウント後に実値を反映。
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
  as = "div",
  ...rest
}: RevealProps) {
  const reduce = usePrefersReducedMotion();
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

  // client（通常モーション）→ .reveal に CSS transition を持たせ、
  // 下端より下の要素だけ hidden(opacity:0, y18) → shown へ遷移させる。
  const cls = [className, "reveal", phase === "hidden" ? "reveal--hidden" : "reveal--shown"]
    .filter(Boolean)
    .join(" ");

  return createElement(
    as,
    {
      ref,
      className: cls,
      // delay はグループ内のずらし（framer の transition.delay 相当）。
      style: delay ? { transitionDelay: `${delay}s` } : undefined,
      ...rest,
    },
    children,
  );
}
