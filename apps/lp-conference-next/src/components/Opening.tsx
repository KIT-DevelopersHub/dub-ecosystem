"use client";

import { Fragment } from "react";
import { Handshake } from "@/components/Handshake";
import { useScrollScene } from "@/lib/useScrollScene";
import type { OpeningConfig, NavLink } from "@/config/types";

// OPENING — 北陸の「今」を見せ、握手モチーフで幕を開ける。
// 左に実テキストのコピー（h1/サブ/タグライン/日時会場/CTA）、背面〜右に握手のハート SVG。
// スクロールで握手ハートが手前へ迫り上がる（--p 連動の parallax）。エントランス演出は
// CSS キーフレーム（globals.css の hero-*）。
export function Opening({
  data,
  nav,
}: {
  data: OpeningConfig;
  nav: NavLink[];
}) {
  const { ref } = useScrollScene<HTMLDivElement>({ rest: 0 });
  const oneLine = (s: string) => s.replace(/\n/g, "");
  const taglineLines = data.tagline.split("\n");

  return (
    <section id="top" className="op" ref={ref}>
      <nav className="hero-nav op-nav" aria-label="グローバルナビ">
        <ul className="hero-nav-list">
          {nav.map((l) => (
            <li key={l.href}>
              <a href={l.href}>{l.label}</a>
            </li>
          ))}
        </ul>
      </nav>

      {/* 背景: 金沢の街並みをさりげなく（抽象シルエット） */}
      <SkylineBackdrop />

      <div className="op-body">
        {/* 握手ハート（装飾） */}
        <div className="op-visual" aria-hidden="true">
          <div className="op-visual-inner">
            <Handshake variant="opening" />
          </div>
        </div>

        <div className="op-copy">
          <span className="op-eyebrow hero-eyebrow">{data.eyebrow}</span>

          <h1 className="op-title hero-title">
            <span className="hero-title-line">
              <span className="hero-title-jp">{data.titleJp}</span>
              <span className="hero-title-it">{data.titleIt}</span>
            </span>
            <span className="hero-title-line hero-title-line--2">
              {data.titleTail}
            </span>
          </h1>

          <p className="op-subtitle">{data.subtitle}</p>

          <p className="op-tagline">
            {taglineLines.map((ln, i) => (
              <Fragment key={i}>
                {i > 0 && <br />}
                <span className="op-tagline-line">{ln}</span>
              </Fragment>
            ))}
          </p>

          <p className="op-lead">{data.body}</p>

          <div className="op-meta hero-meta">
            <p className="hero-meta-row">
              <span className="hero-meta-label">開催日時</span>
              <span className="hero-meta-value">{data.dateLabel}</span>
            </p>
            <p className="hero-meta-row">
              <span className="hero-meta-label">会場</span>
              <span className="hero-meta-value">{data.venueLabel}</span>
            </p>
          </div>

          <div className="op-ctas hero-ctas">
            {data.primaryCta && (
              <a
                className="hero-cta hero-cta--participant"
                href={data.primaryCta.href}
                aria-label={oneLine(data.primaryCta.label)}
              >
                {data.primaryCta.label}
                <span className="hero-cta-arrow" aria-hidden="true">→</span>
              </a>
            )}
            {data.secondaryCta && (
              <a
                className="hero-cta hero-cta--speaker"
                href={data.secondaryCta.href}
                aria-label={oneLine(data.secondaryCta.label)}
              >
                {data.secondaryCta.label}
                <span className="hero-cta-arrow" aria-hidden="true">→</span>
              </a>
            )}
          </div>
        </div>
      </div>

      {/* スクロール誘導 */}
      <div className="op-scroll-hint" aria-hidden="true">
        <span>SCROLL</span>
        <span className="op-scroll-dot" />
      </div>
    </section>
  );
}

// 金沢の街並みをさりげなく象る抽象シルエット（山＋町家の屋根＋川のきらめき）。
// 実写を使わず軽量に、地元要素を“気づく人が気づく”密度で。
function SkylineBackdrop() {
  return (
    <svg
      className="op-skyline"
      viewBox="0 0 1440 320"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="skyFar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f61d6" stopOpacity="0.12" />
          <stop offset="1" stopColor="#2f61d6" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="skyNear" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e3fa8" stopOpacity="0.18" />
          <stop offset="1" stopColor="#1e3fa8" stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* 遠景の山（立山連峰のイメージ） */}
      <path
        fill="url(#skyFar)"
        d="M0 210 L150 150 L280 200 L430 120 L600 190 L760 130 L920 195 L1090 140 L1260 200 L1440 160 L1440 320 L0 320 Z"
      />
      {/* 近景の町家屋根（ひがし茶屋街のイメージ） */}
      <g fill="url(#skyNear)">
        <path d="M0 250 L60 250 L90 228 L120 250 L200 250 L235 224 L270 250 L360 250 L360 320 L0 320 Z" />
        <path d="M360 250 L440 250 L472 226 L504 250 L600 250 L636 222 L672 250 L760 250 L760 320 L360 320 Z" />
        <path d="M760 250 L850 250 L884 224 L918 250 L1010 250 L1046 226 L1082 250 L1180 250 L1180 320 L760 320 Z" />
        <path d="M1180 250 L1260 250 L1296 224 L1332 250 L1440 250 L1440 320 L1180 320 Z" />
      </g>
    </svg>
  );
}
