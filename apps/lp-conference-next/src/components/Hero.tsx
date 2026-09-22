import type { HeroConfig } from "@/config/types";
import { HeroScene } from "@/components/HeroScene";

// Hero — reproduces goodpatch's hero skeleton (centered massive headline + a
// medium centered subheading over a full-bleed motion background), filled with
// the conference's own text and an ORIGINAL animated background (brand-gradient
// aurora + abstract connection network drawn as inline SVG). No goodpatch
// asset/copy/video is used.
//
// All copy is real text (h1 / p / a) for select/copy/translate/SEO. Entrance
// motion is pure CSS (see globals.css hero-* keyframes); under
// prefers-reduced-motion it collapses to instant-visible. Server component.
export function Hero({ data, subheading }: { data: HeroConfig; subheading?: string }) {
  const oneLine = (s: string) => s.replace(/\n/g, "");

  return (
    <section id="top" className="hero hero--v31">
      {/* v3.1 full-bleed WebGL blob field (decorative). A dark-blue CSS gradient
          sits behind it (see .hero--v31) so there is never a white flash and a
          missing WebGL context degrades gracefully. Original art — no goodpatch
          asset/shape/copy. */}
      <div className="hero-bg" aria-hidden="true">
        <HeroScene />
      </div>

      <div className="hero-body">
        <div className="hero-copy">
          <span className="hero-eyebrow">HOKURIKU IT CONFERENCE 2027</span>

          <h1 className="hero-title">
            <span className="hero-title-line">
              <span className="hero-title-inner">
                <span className="hero-title-jp">北陸</span>
                <span className="hero-title-it">IT</span>
              </span>
            </span>
            <span className="hero-title-line hero-title-line--2">
              <span className="hero-title-inner">カンファレンス</span>
            </span>
          </h1>

          {subheading && <p className="hero-sub">{subheading}</p>}

          <div className="hero-meta">
            <p className="hero-meta-row">
              <span className="hero-meta-label">開催日時</span>
              <span className="hero-meta-value">{data.dateLabel}</span>
            </p>
            <p className="hero-meta-row">
              <span className="hero-meta-label">会場</span>
              <span className="hero-meta-value">{data.venueLabel}</span>
            </p>
          </div>

          <div className="hero-ctas">
            {data.primaryCta && (
              <a
                className="hero-cta hero-cta--participant"
                href={data.primaryCta.href}
                aria-label={oneLine(data.primaryCta.label)}
                data-magnetic
              >
                参加登録はこちら
                <span className="hero-cta-arrow" aria-hidden="true">→</span>
              </a>
            )}
            {data.secondaryCta && (
              <a
                className="hero-cta hero-cta--speaker"
                href={data.secondaryCta.href}
                aria-label={oneLine(data.secondaryCta.label)}
              >
                登壇に応募する
                <span className="hero-cta-arrow" aria-hidden="true">→</span>
              </a>
            )}
          </div>
        </div>
      </div>

      {/* scroll cue */}
      <a className="hero-scroll" href="#apply" aria-label="下へスクロール">
        <span className="hero-scroll-label">SCROLL</span>
        <span className="hero-scroll-line" aria-hidden="true" />
      </a>
    </section>
  );
}
