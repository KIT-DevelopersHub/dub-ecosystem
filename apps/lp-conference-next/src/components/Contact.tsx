import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import type { ContactConfig } from "@/config/types";

// Contact — reproduces goodpatch's "Get In Touch" CTA-band skeleton: a centered
// eyebrow + large heading over a light band, then a horizontal row of equal
// button CTAs, with a closing note. Filled with the conference's contact copy;
// buttons route to the conference's own mail / apply / official site.
export function Contact({
  data,
  index,
  siteUrl,
}: {
  data: ContactConfig;
  index?: string;
  applyHref?: string;
  siteUrl?: string;
}) {
  const instagramUrl = "https://www.instagram.com/developershub.conference/";
  const xUrl = "https://x.com/cda_kit";
  return (
    <section id="contact" className="section getintouch">
      <div className="container">
        <SectionHead eyebrow="CONTACT" index={index} title={data.heading} center />

        <Reveal as="p" className="git-org" variant="fade" delay={60}>
          {data.org}
        </Reveal>

        <Reveal className="git-actions" variant="up" delay={120}>
          {/* 受付未開始 — 参加登録はまだ開いていないため disabled 表示 */}
          <div className="git-btn git-btn--primary is-disabled" aria-disabled="true">
            <span className="git-btn-en">JOIN</span>
            <span className="git-btn-jp">参加登録はこちら</span>
            <span className="git-btn-badge">準備中</span>
          </div>
          {siteUrl && (
            <a className="git-btn" href={siteUrl} target="_blank" rel="noopener noreferrer">
              <span className="git-btn-en">SITE</span>
              <span className="git-btn-jp">公式サイト</span>
              <span className="arrow" aria-hidden="true">↗</span>
            </a>
          )}
        </Reveal>

        {/* メール / Instagram / X — アイコンボタン群（クリックで各リンクへ遷移） */}
        <Reveal className="git-social" variant="up" delay={180}>
          <a
            className="git-social-btn"
            href={`mailto:${data.email}`}
            aria-label="メールで問い合わせ"
            title="メールで問い合わせ"
          >
            <IconMail />
          </a>
          <a
            className="git-social-btn"
            href={instagramUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Instagram（新しいタブで開く）"
            title="Instagram"
          >
            <IconInstagram />
          </a>
          <a
            className="git-social-btn"
            href={xUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X（旧Twitter・新しいタブで開く）"
            title="X"
          >
            <IconX />
          </a>
        </Reveal>

        <Reveal as="p" className="git-note" variant="fade" delay={200}>
          {data.note}
        </Reveal>
      </div>
    </section>
  );
}

// Icons for the contact buttons (original inline SVG — no external assets).
function IconMail() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}
function IconInstagram() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconX() {
  return (
    <svg width={19} height={19} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}
