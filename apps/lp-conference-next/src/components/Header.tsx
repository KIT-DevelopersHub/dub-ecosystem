"use client";

import { useEffect, useState } from "react";
import type { NavLink } from "@/config/types";

// Sticky site header (goodpatch-style): brand wordmark left, anchor nav +
// primary CTA right. Gains a solid glassy background + tighter padding once the
// page is scrolled past the hero fold (transform/opacity/bg only). On mobile the
// nav collapses behind a menu button that toggles a full-width dropdown.
//
// All links are real anchors into the existing sections — no copy changes.
// SSG/no-JS: renders as a plain visible header (the `is-scrolled` polish and the
// mobile toggle are progressive enhancements).
export function Header({ nav, cta }: { nav: NavLink[]; cta?: { label: string; href: string } }) {
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
            {nav
              .filter((l) => l.href !== "#top")
              .map((l) => (
                <li key={l.href}>
                  <a href={l.href} onClick={() => setOpen(false)}>
                    {l.label}
                  </a>
                </li>
              ))}
          </ul>
          {cta && (
            <a className="site-head-cta" href={cta.href} onClick={() => setOpen(false)}>
              {cta.label}
              <span className="arrow" aria-hidden="true">→</span>
            </a>
          )}
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
