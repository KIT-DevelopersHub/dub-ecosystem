import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { renderEmphasis } from "@/lib/markup";
import type { ProgramConfig, ProgramItem } from "@/config/types";

// Program — reproduces goodpatch's "Design Platform" skeleton: a bold full-bleed
// blue block with a giant heading, then a stacked list of big-name rows, each
// with an index, an oversized name + description, a circular masked medallion
// that slides in on hover, and a circle-arrow affordance. Filled with the
// conference's 聴く / 体験する / 出会う pillars and original inline-SVG art —
// no goodpatch assets/copy.
export function Program({ data, index }: { data: ProgramConfig; index?: string }) {
  return (
    <section id="program" className="section program-block block-arc block-arc--top">
      <div className="container">
        <SectionHead
          eyebrow="PROGRAM"
          index={index}
          title={data.heading}
          lead={renderEmphasis(data.note)}
          light
          ghost="PROGRAM"
        />

        <ul className="prow-list">
          {data.items.map((item, i) => (
            <Reveal as="li" className="prow" key={item.name ?? i} variant="up" delay={90 * i}>
              <span className="prow-idx" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
              <span className="prow-icon" aria-hidden="true">{pillarIcon(i)}</span>
              <span className="prow-copy">
                {item.name && <span className="prow-name">{item.name}</span>}
                {item.note && <span className="prow-note">{item.note}</span>}
              </span>
              <span className={`prow-medallion prow-medallion--${i + 1}`} aria-hidden="true">
                {pillarIcon(i)}
              </span>
              <span className="prow-arrow" aria-hidden="true">→</span>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}

// Line icons for the 聴く / 体験する / 出会う pillars (original art).
function pillarIcon(i: number) {
  const common = {
    width: 34,
    height: 34,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (i === 0) {
    return (
      <svg {...common}>
        <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
        <rect x="2.5" y="13.5" width="4" height="6.5" rx="1.6" />
        <rect x="17.5" y="13.5" width="4" height="6.5" rx="1.6" />
      </svg>
    );
  }
  if (i === 1) {
    return (
      <svg {...common}>
        <path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
        <circle cx="12" cy="12" r="3.2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8.5" cy="8" r="2.8" />
      <path d="M14.2 5.4a2.8 2.8 0 0 1 0 5.2" />
      <path d="M3.5 19.5c0-2.8 2.2-4.6 5-4.6s5 1.8 5 4.6" />
      <path d="M16 15.2c2.3.2 4.5 2 4.5 4.3" />
    </svg>
  );
}
