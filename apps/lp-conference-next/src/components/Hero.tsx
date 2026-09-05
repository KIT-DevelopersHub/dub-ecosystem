"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { HeroConfig, NavLink } from "@/config/types";

// Hero (TOP). モックアップのイラストをそのまま実画像 (/img/hero.png) として配置し、
// ナビ6項目と2つの円ボタンを「透明ホットスポット」で重ねてクリック可能にする。
// 登場アニメは Framer Motion: (1)右のイラスト帯フェード → (2)タイトルが左→右にワイプ
// → (3)開催日時/会場フェードアップ → (4)CTA フェードアップ。右は緩やか Ken Burns。
//
// ★ base 画像 (.hero-img) は常に可視で、ready(=client かつ motion 許可) の時だけ
//   0 にフェードして重ねたレイヤーへ渡す。JS 不動作 / reduced-motion では base が
//   そのまま pixel-perfect に見える（真っ白にならない）。

// ナビ ホットスポット（実測 L/W%・アンカー先は nav 設定に対応）
const navSpots = [
  { href: "#top", label: "TOP", left: 40.5, width: 3.2 },
  { href: "#about", label: "北陸ITカンファレンスとは？", left: 44.7, width: 18.0 },
  { href: "#program", label: "プログラム内容", left: 63.9, width: 10.0 },
  { href: "#crowdfunding", label: "クラファン情報", left: 75.0, width: 10.0 },
  { href: "#apply", label: "応募", left: 86.0, width: 3.2 },
  { href: "#contact", label: "お問い合わせ", left: 90.3, width: 8.7 },
];
const NAV_TOP = 1.0;
const NAV_HEIGHT = 6.6;
const HERO_SRC = "/img/hero.png";

export function Hero({ data, nav }: { data: HeroConfig; nav: NavLink[] }) {
  const reduce = useReducedMotion();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (reduce) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [reduce]);

  const oneLine = (s: string) => s.replace(/\n/g, "");

  return (
    <section id="top" className="hero">
      <h1 className="sr-only">
        {data.heading} — {data.dateLabel} {data.venueLabel}
      </h1>
      <nav className="sr-only" aria-label="グローバルナビ">
        {nav.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
      </nav>

      <div className="hero-frame">
        {/* base: 常に可視。ready の時だけ 0 へフェード。 */}
        <motion.img
          className="hero-img"
          src={HERO_SRC}
          width={1440}
          height={678}
          alt={`${data.heading}｜${data.dateLabel}・${data.venueLabel}`}
          fetchPriority="high"
          decoding="async"
          animate={{ opacity: ready ? 0 : 1 }}
          transition={{ duration: 0.4, delay: ready ? 0.15 : 0 }}
        />

        {/* 登場アニメ用の複製レイヤー（同一画像を clip-path で領域分割し順に表示）。装飾。 */}
        <motion.img
          className="hero-layer hero-layer--right"
          src={HERO_SRC}
          width={1440}
          height={678}
          alt=""
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={ready ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
        <motion.img
          className="hero-layer hero-layer--title"
          src={HERO_SRC}
          width={1440}
          height={678}
          alt=""
          aria-hidden="true"
          initial={{ opacity: 0, clipPath: "inset(0% 100% 53.5% 0%)" }}
          animate={
            ready
              ? { opacity: 1, clipPath: "inset(0% 46% 53.5% 0%)" }
              : { opacity: 0, clipPath: "inset(0% 100% 53.5% 0%)" }
          }
          transition={{ duration: 0.75, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
        />
        <motion.img
          className="hero-layer hero-layer--date"
          src={HERO_SRC}
          width={1440}
          height={678}
          alt=""
          aria-hidden="true"
          initial={{ opacity: 0, y: 16 }}
          animate={ready ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
          transition={{ duration: 0.55, delay: 0.95, ease: "easeOut" }}
        />
        <motion.img
          className="hero-layer hero-layer--cta"
          src={HERO_SRC}
          width={1440}
          height={678}
          alt=""
          aria-hidden="true"
          initial={{ opacity: 0, y: 16 }}
          animate={ready ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
          transition={{ duration: 0.6, delay: 1.3, ease: [0.22, 1, 0.36, 1] }}
        />

        {/* Ken Burns: 右のイラスト領域だけを緩やかにズーム。 */}
        <motion.div
          className="hero-kb"
          aria-hidden="true"
          animate={{ opacity: ready ? 1 : 0 }}
          transition={{ duration: 0.8, delay: 0.5 }}
        >
          <motion.img
            className="hero-kb-img"
            src={HERO_SRC}
            width={1440}
            height={678}
            alt=""
            animate={ready ? { scale: [1, 1.055] } : { scale: 1 }}
            transition={{
              duration: 22,
              delay: 1.9,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "easeInOut",
            }}
          />
        </motion.div>

        {/* クリック可能な透明ホットスポット（ナビ + CTA）。 */}
        {navSpots.map((s) => (
          <a
            key={s.href + s.label}
            className="hero-hotspot"
            href={s.href}
            aria-label={s.label}
            style={{
              left: `${s.left}%`,
              top: `${NAV_TOP}%`,
              width: `${s.width}%`,
              height: `${NAV_HEIGHT}%`,
            }}
          >
            {s.label}
          </a>
        ))}
        {data.primaryCta && (
          <a
            className="hero-hotspot hero-cta"
            href={data.primaryCta.href}
            aria-label={oneLine(data.primaryCta.label)}
            style={{ left: "2.7%", top: "69.0%", width: "12.8%", height: "26.6%" }}
          >
            {oneLine(data.primaryCta.label)}
          </a>
        )}
        {data.secondaryCta && (
          <a
            className="hero-hotspot hero-cta"
            href={data.secondaryCta.href}
            aria-label={oneLine(data.secondaryCta.label)}
            style={{ left: "17.9%", top: "69.0%", width: "12.8%", height: "26.6%" }}
          >
            {oneLine(data.secondaryCta.label)}
          </a>
        )}
      </div>
    </section>
  );
}
