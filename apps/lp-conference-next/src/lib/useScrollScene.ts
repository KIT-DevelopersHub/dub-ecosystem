"use client";

import { useEffect, useRef, useState } from "react";

// useScrollScene — スクロール連動アニメの土台。
//
// 設計方針（Lighthouse / 非力端末配慮）:
//  • 重いライブラリ（GSAP / framer-motion）を使わず、rAF + IntersectionObserver のみ。
//  • 要素が画面に入っている間だけ rAF ループを回す（画面外はリスナ休止＝CPU 節約）。
//  • 進捗は CSS カスタムプロパティ `--p`（0→1）として要素に書き込むだけ。
//    実際の動きは CSS 側で transform / opacity（GPU 合成）だけを使って表現する。
//  • prefers-reduced-motion では進捗を静止値（rest, 既定 1）に固定し rAF を回さない。
//
// 進捗の定義:
//   要素の中心が「画面下端」に来た時 0、「画面上端」に来た時 1。
//   画面中央に来た時がおよそ 0.5。→ セクションを縦断する“通過度”になる。

export interface ScrollSceneOptions {
  /** reduced-motion / 非対応時に固定する進捗（既定 1 = 完成状態）。 */
  rest?: number;
}

export function useScrollScene<T extends HTMLElement = HTMLDivElement>(
  opts: ScrollSceneOptions = {},
) {
  const { rest = 1 } = opts;
  const ref = useRef<T | null>(null);
  // 「画面内に一度でも入ったか」= 見出し等のフェードイン制御に使う。
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const prefersReduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // reduced-motion: 静止値を焼き込み、以降は何も動かさない。
    if (prefersReduce) {
      el.style.setProperty("--p", String(rest));
      setEntered(true);
      return;
    }

    let active = false;
    let raf = 0;

    const compute = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const center = rect.top + rect.height / 2;
      // center: vh(下端) → 0, 0(上端) → 1
      let p = 1 - center / vh;
      if (p < 0) p = 0;
      else if (p > 1) p = 1;
      el.style.setProperty("--p", p.toFixed(4));
    };

    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(compute);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            if (!active) {
              active = true;
              window.addEventListener("scroll", onScroll, { passive: true });
              window.addEventListener("resize", onScroll, { passive: true });
            }
            setEntered(true);
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
    compute();

    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [rest]);

  return { ref, entered };
}
