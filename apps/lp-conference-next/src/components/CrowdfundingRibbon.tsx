import type { CrowdfundingBanner } from "@/config/types";

// Crowdfunding ribbon — a full-width "now running" band pinned above the header.
// Its bottom edge sags like hung cloth and a string of pennants hangs along the
// curve, both gently breathing/swaying. The whole band is one external link.
// Decoration is aria-hidden; all motion is CSS and stops under reduced-motion.
const PENNANTS = 9;

export function CrowdfundingRibbon({ data }: { data: CrowdfundingBanner }) {
  return (
    <a className="cf-ribbon" href={data.href} target="_blank" rel="noopener noreferrer">
      <span className="cf-ribbon-inner">
        <span className="cf-ribbon-live" aria-hidden="true">
          <span className="cf-ribbon-dot" />
          LIVE
        </span>
        <span className="cf-ribbon-text">
          <span className="cf-ribbon-text-full">{data.text}</span>
          <span className="cf-ribbon-text-short">{data.shortText ?? data.text}</span>
        </span>
        <span className="cf-ribbon-cta">
          {data.ctaLabel}
          <span className="arrow" aria-hidden="true">↗</span>
        </span>
      </span>

      <span className="cf-sag" aria-hidden="true">
        <svg className="cf-sag-cloth" viewBox="0 0 100 10" preserveAspectRatio="none">
          <defs>
            <linearGradient id="cf-sag-fill" x1="0" x2="100" y1="0" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#0f2f8f" />
              <stop offset="0.46" stopColor="#1e3fa8" />
              <stop offset="1" stopColor="#0e6f8f" />
            </linearGradient>
          </defs>
          <path d="M0 0 H100 Q50 20 0 0 Z" fill="url(#cf-sag-fill)" />
          <path className="cf-sag-string" d="M0 0 Q50 20 100 0" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="cf-garland">
          {Array.from({ length: PENNANTS }, (_, i) => {
            const x = (i + 1) / (PENNANTS + 1);
            const style = { left: `${x * 100}%`, "--k": 4 * x * (1 - x), "--i": i } as React.CSSProperties;
            return (
              <span key={i} className="cf-pennant" style={style}>
                <span className="cf-pennant-flag" />
              </span>
            );
          })}
        </span>
      </span>
    </a>
  );
}
