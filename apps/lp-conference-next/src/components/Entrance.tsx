"use client";

import { useEffect, useState } from "react";

// First-paint entrance curtain — CSS のみ（framer-motion 撤去でクライアント JS を削減）。
// マウント後にフルビューポートのブランドカーテンを一拍見せ、CSS キーフレームで後退させる。
// アニメ終了後に DOM から自身を外す。prefers-reduced-motion / JS-off ではカーテンを
// 一切出さない（本文は常に即可視）。装飾のみ（aria-hidden）。
export function Entrance() {
  const [phase, setPhase] = useState<"idle" | "show" | "done">("idle");

  useEffect(() => {
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduce) {
      setPhase("done");
      return;
    }
    setPhase("show");
    // カーテン表示(0.62s) + 後退(0.72s) 相当で撤去。
    const t = setTimeout(() => setPhase("done"), 1360);
    return () => clearTimeout(t);
  }, []);

  if (phase !== "show") return null;

  return (
    <div className="lp-entrance is-receding" aria-hidden="true">
      <span className="lp-entrance-wave" />
      <span className="lp-entrance-mark">HOKURIKU IT CONFERENCE</span>
    </div>
  );
}
