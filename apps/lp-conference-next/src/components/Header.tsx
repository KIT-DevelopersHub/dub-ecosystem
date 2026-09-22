"use client";

import { useEffect, useState } from "react";
import type { NavLink } from "@/config/types";

// Sticky site header — reproduces goodpatch's header skeleton (functional layout
// only, no copied assets): brand wordmark left · centered anchor nav · right-side
// text link + primary CTA. Thin & transparent over the hero, gains a solid white
// glassy background on scroll. Mobile collapses the nav behind a hamburger.
//
// All labels are the conference's own nav text; the wordmark is an original mark.
export function Header({
  nav,
  cta,
  contactHref = "#contact",
}: {
  nav: NavLink[];
  cta?: { label: string; href: string };
  contactHref?: string;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      setScrolled(window.scrollY > 24);
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const centerNav = nav.filter((l) => l.href !== "#top" && l.href !== contactHref);

  return (
    <header className={`site-head${scrolled ? " is-scrolled" : ""}${open ? " is-open" : ""}`}>
      <div className="site-head-inner">
        <a className="brand" href="#top" aria-label="北陸ITカンファレンス トップへ">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">
            <span className="brand-name-en">HOKURIKU IT CONFERENCE</span>
            <span className="brand-name-yr">2027</span>
          </span>
        </a>

        <nav className="site-nav" aria-label="グローバルナビ">
          <ul className="site-nav-list">
            {centerNav.map((l) => (
              <li key={l.href}>
                <a href={l.href} onClick={() => setOpen(false)}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="site-head-actions">
            <a className="site-head-link" href={contactHref} onClick={() => setOpen(false)}>
              お問い合わせ
            </a>
            {cta && (
              /* 受付未開始 — 参加登録はまだ開いていないため disabled 表示 */
              <button
                type="button"
                className="site-head-cta is-disabled"
                disabled
                aria-disabled="true"
                aria-label={`${cta.label}（準備中）`}
              >
                {cta.label}
                <span className="site-head-cta-badge">準備中</span>
              </button>
            )}
          </div>
        </nav>

        <button
          type="button"
          className="site-nav-toggle"
          aria-expanded={open}
          aria-label={open ? "メニューを閉じる" : "メニューを開く"}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
