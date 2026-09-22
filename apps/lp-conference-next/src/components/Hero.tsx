import type { HeroConfig } from "@/config/types";

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
    <section id="top" className="hero">
      {/* original full-bleed motion background (decorative) */}
      <div className="hero-bg" aria-hidden="true">
        <span className="hero-bg-blob hero-bg-blob--a" />
        <span className="hero-bg-blob hero-bg-blob--b" />
        <span className="hero-bg-blob hero-bg-blob--c" />
        <div className="hero-net-wrap">
          <HeroNetwork />
        </div>
      </div>

      <div className="hero-body">
        <div className="hero-copy">
          <span className="hero-eyebrow">HOKURIKU IT CONFERENCE 2027</span>

          <h1 className="hero-title">
            <span className="hero-title-line">
              <span className="hero-title-jp">北陸</span>
              <span className="hero-title-it">IT</span>
            </span>
            <span className="hero-title-line hero-title-line--2">カンファレンス</span>
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

// Abstract "engineers connecting" network — pure SVG, brand gradient, gentle
// pulse on the nodes (paused under prefers-reduced-motion via CSS). Original art.
function HeroNetwork() {
  const nodes = [
    { cx: 60, cy: 70, r: 9 },
    { cx: 210, cy: 40, r: 7 },
    { cx: 330, cy: 110, r: 11 },
    { cx: 150, cy: 175, r: 8 },
    { cx: 285, cy: 220, r: 9 },
    { cx: 70, cy: 250, r: 7 },
    { cx: 360, cy: 300, r: 8 },
    { cx: 180, cy: 300, r: 10 },
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [0, 3], [3, 2], [3, 4], [2, 4],
    [3, 5], [4, 6], [4, 7], [5, 7], [7, 6],
  ];
  return (
    <svg className="hero-net" viewBox="0 0 420 360" role="presentation" focusable="false">
      <defs>
        <linearGradient id="netGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f61d6" />
          <stop offset="1" stopColor="#17b892" />
        </linearGradient>
        <radialGradient id="nodeGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#2f61d6" stopOpacity="0.25" />
          <stop offset="1" stopColor="#2f61d6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g stroke="url(#netGrad)" strokeWidth="1.6" strokeOpacity="0.5">
        {edges.map(([a, b], i) => (
          <line key={i} x1={nodes[a].cx} y1={nodes[a].cy} x2={nodes[b].cx} y2={nodes[b].cy} />
        ))}
      </g>
      <g>
        {nodes.map((n, i) => (
          <g key={i} className="hero-net-node" style={{ animationDelay: `${i * 0.4}s` }}>
            <circle cx={n.cx} cy={n.cy} r={n.r * 2.4} fill="url(#nodeGlow)" />
            <circle cx={n.cx} cy={n.cy} r={n.r} fill="url(#netGrad)" />
            <circle cx={n.cx} cy={n.cy} r={n.r} fill="#fff" fillOpacity="0.18" />
          </g>
        ))}
      </g>
    </svg>
  );
}
