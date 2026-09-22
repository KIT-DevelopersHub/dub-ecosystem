import type { HeroConfig } from "@/config/types";

// Hero (TOP) — full-height editorial opener. All copy is real text (h1 / p / a)
// for select/copy/translate/SEO. The ambient right/back visual is an original,
// on-brand abstract "connection network" (nodes = engineers meeting) drawn as
// inline SVG with the brand gradient — no stock photography / people, no
// third-party IP.
//
// Entrance motion is PURE CSS (see globals.css `hero-rise` / `hero-wipe` /
// `hero-pop` keyframes): eyebrow → title wipe → date/venue chips → CTA buttons →
// visual fade → scroll cue. No animation JS ships. Under prefers-reduced-motion
// the global reduce block collapses it to instant-visible (no opacity:0 lock).
// With no hooks, Hero is a server component.
export function Hero({ data }: { data: HeroConfig }) {
  const oneLine = (s: string) => s.replace(/\n/g, "");

  return (
    <section id="top" className="hero">
      {/* ambient original connection graphic (decorative, sits behind copy) */}
      <div className="hero-visual" aria-hidden="true">
        <HeroNetwork />
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
      <a className="hero-scroll" href="#about" aria-label="下へスクロール">
        <span className="hero-scroll-label">SCROLL</span>
        <span className="hero-scroll-line" aria-hidden="true" />
      </a>
    </section>
  );
}

// Abstract "engineers connecting" network — pure SVG, brand gradient, gentle
// pulse on the nodes (paused under prefers-reduced-motion via CSS).
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
