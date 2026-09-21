"use client";

import { createElement, useEffect, useRef, useState, type ReactNode } from "react";

// Reveal — 「下から立ち上がる」＋「蜃気楼(haze)」演出を SSG-safe かつ
//   「既定 visible・足すだけ」で足す。
//
// ★ framer-motion は使わず、素の要素＋IntersectionObserver＋rAF で実装（軽量・GPU 合成）。
//
// ★ 蜃気楼(v3 から移植): 一度切りのフェードではなく、要素の“ビューポート内位置”を
//   連続値 --p(0=画面下端 → 1=画面上端) として毎フレーム書き込む。CSS 側(.reveal--haze)が
//   --p に応じて opacity/translateY を連続変化させる。→ 画面下の方にある間は薄くかすみ、
//   せり上がるほど鮮明になる。動きは transform/opacity のみ。
//
// ★ 既知バグ回避（最重要 / Astro 版で About・クラファン・応募・お問い合わせが
//   opacity:0 のまま真っ白になった事故の再発防止）:
//   1) サーバー(SSG)・hydrate 前・reduced-motion では素の要素をそのまま描画（常に可視）。
//   2) client でも「既定は可視」。マウント時にビューポート下端より下にある要素だけを
//      haze 対象にして下からせり上げる（＝すでに見えている物は絶対に触らない）。
//   3) IntersectionObserver / rAF 非対応なら隠さない（可視のまま）。
//   4) 安全タイマー: 何があっても一定時間後に必ず可視化する（--p=1 に固定・永久に
//      opacity:0 で固定されることが構造上あり得ない）。
//   これにより「reveal 未発火でも必ず見える」を満たす。

type RevealTag = "div" | "section" | "p" | "li" | "ul" | "h2" | "h3" | "span";
// static = 素描画（すでに見えている / 非対応 / reduced-motion）。
// haze  = 位置連動の蜃気楼フェード対象（--p を毎フレーム更新）。
type Phase = "static" | "haze";

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
    if (
      !el ||
      typeof IntersectionObserver === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      return; // 非対応 → 可視のまま
    }

    const rect = el.getBoundingClientRect();
    const belowFold = rect.top > window.innerHeight * BELOW_FOLD_RATIO;
    if (!belowFold) return; // 既に見えている / 画面内 → 触らない（チラつき無し）

    // haze 化。まず現在位置の --p を即時反映してから class を付ける（下端付近なら --p≈0）。
    const writeP = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const center = r.top + r.height / 2;
      // center: vh(下端)→0, 0(上端)→1
      let p = 1 - center / vh;
      if (p < 0) p = 0;
      else if (p > 1) p = 1;
      el.style.setProperty("--p", p.toFixed(4));
    };
    writeP();
    setPhase("haze");

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
      { threshold: 0, rootMargin: "0px 0px 0px 0px" },
    );
    io.observe(el);

    // 安全網: 一定時間後は必ず可視化して以後 --p を固定（隠しっぱなし構造を排除）。
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
  }, [reduce]);

  // SSG / hydrate 前 / reduced-motion → 素の要素（常に可視）。
  if (!mounted || reduce) {
    return createElement(as, { className, ...rest }, children);
  }

  // client（通常モーション）→ 下端より下の要素だけ .reveal--haze を付け、
  // --p(位置) 連動で下からかすみ上がらせる。静止(既視)要素は素のまま可視。
  const cls = [className, "reveal", phase === "haze" ? "reveal--haze" : ""]
    .filter(Boolean)
    .join(" ");

  return createElement(
    as,
    {
      ref,
      className: cls,
      // delay はグループ内のずらし（--p のしきい値を少しずらす）。
      style:
        phase === "haze" && delay
          ? ({ ["--reveal-delay" as string]: delay } as Record<string, string | number>)
          : undefined,
      ...rest,
    },
    children,
  );
}
