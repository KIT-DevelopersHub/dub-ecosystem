"use client";

import Image from "next/image";
import { useState } from "react";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { renderEmphasis } from "@/lib/markup";
import type { ProgramConfig, ProgramItem } from "@/config/types";

// Program — reproduces goodpatch's "Featured Work" skeleton: an eyebrow + heading,
// a horizontal filter-tab row (All + categories), then a responsive card grid
// whose tiles reveal on scroll and zoom on hover with an arrow affordance.
// Filled with the conference's 聴く / 体験する / 出会う program pillars and
// original inline-SVG icons — no goodpatch assets/copy.
export function Program({ data, index }: { data: ProgramConfig; index?: string }) {
  // Categories = each pillar's own name (All + the pillar names), mirroring
  // goodpatch's category filter interaction.
  const cats = ["すべて", ...data.items.map((it) => it.name).filter(Boolean) as string[]];
  const [active, setActive] = useState("すべて");
  const shown = active === "すべて" ? data.items : data.items.filter((it) => it.name === active);

  return (
    <section id="program" className="section work">
      <div className="container">
        <SectionHead
          eyebrow="PROGRAM"
          index={index}
          title={data.heading}
          lead={renderEmphasis(data.note)}
        />

        <Reveal className="work-tabs" variant="fade" role="tablist" aria-label="プログラム区分">
          {cats.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={active === c}
              className={`work-tab${active === c ? " is-active" : ""}`}
              onClick={() => setActive(c)}
            >
              {c}
            </button>
          ))}
        </Reveal>

        <div className="work-grid">
          {shown.map((item, i) => (
            <Reveal className="work-card-io" variant="up" delay={90 * i} key={item.name ?? i}>
              <WorkCard item={item} n={data.items.indexOf(item) + 1} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkCard({ item, n }: { item: ProgramItem; n: number }) {
  const idx = String(n).padStart(2, "0");
  return (
    <article className="work-card">
      <div className="work-card-media">
        {item.photo ? (
          <Image
            className="work-card-photo"
            src={item.photo}
            alt={item.name ?? ""}
            width={389}
            height={376}
            loading="lazy"
          />
        ) : (
          <span className="work-card-icon" aria-hidden="true">
            {pillarIcon(n - 1)}
          </span>
        )}
        <span className="work-card-idx" aria-hidden="true">{idx}</span>
      </div>
      <div className="work-card-body">
        {item.name && <h3 className="work-card-name">{item.name}</h3>}
        {item.note && <p className="work-card-note">{item.note}</p>}
        <span className="work-card-arrow" aria-hidden="true">→</span>
      </div>
    </article>
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
