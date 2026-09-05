import type { FooterConfig } from "@/config/types";

export function Footer({ data }: { data: FooterConfig }) {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <span className="footer-org">{data.org}</span>
        {data.links.length > 0 && (
          <nav className="footer-links" aria-label="フッターリンク">
            {data.links.map((l) => (
              <a key={l.href + l.label} href={l.href}>
                {l.label}
              </a>
            ))}
          </nav>
        )}
        <span className="footer-copy">
          {data.copyright} {year}
        </span>
      </div>
    </footer>
  );
}
