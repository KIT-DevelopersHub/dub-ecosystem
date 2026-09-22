import type { FooterConfig, NavLink } from "@/config/types";

// Footer — reproduces goodpatch's multi-part footer skeleton: a top area with the
// brand block on the left and link groups on the right, then a bottom bar with
// copyright. Filled with the conference's own org / nav / official link; the
// wordmark is an original mark (no goodpatch logo/mascot/social art).
export function Footer({ data, nav }: { data: FooterConfig; nav?: NavLink[] }) {
  const year = new Date().getFullYear();
  const pageLinks = (nav ?? []).filter((l) => l.href.startsWith("#"));
  return (
    <footer className="site-footer">
      <div className="container footer-top">
        <div className="footer-brand">
          <a className="brand brand--footer" href="#top" aria-label="北陸ITカンファレンス トップへ">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">
              <span className="brand-name-en">HOKURIKU IT CONFERENCE</span>
              <span className="brand-name-yr">2027</span>
            </span>
          </a>
          <p className="footer-org">{data.org}</p>
        </div>

        <div className="footer-cols">
          {pageLinks.length > 0 && (
            <nav className="footer-col" aria-label="ページ内リンク">
              <span className="footer-col-head">MENU</span>
              <ul>
                {pageLinks.map((l) => (
                  <li key={l.href}>
                    <a href={l.href}>{l.label}</a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {data.links.length > 0 && (
            <nav className="footer-col" aria-label="関連リンク">
              <span className="footer-col-head">LINKS</span>
              <ul>
                {data.links.map((l) => (
                  <li key={l.href + l.label}>
                    <a href={l.href}>
                      {l.label}
                      <span className="ext" aria-hidden="true"> ↗</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </div>

      <div className="footer-bottom">
        <div className="container footer-bottom-inner">
          <span className="footer-copy">
            {data.copyright} {year}
          </span>
        </div>
      </div>
    </footer>
  );
}
