import { Reveal } from "@/components/Reveal";
import { renderEmphasis } from "@/lib/markup";
import type { AboutConfig } from "@/config/types";

// About (〜とは？) — editorial section: numbered eyebrow + large title, then a
// 3-up feature grid built from the snapshot's body lines. Cards reveal in a
// staggered rise as they enter the viewport (goodpatch-style).
export function About({ data, index }: { data: AboutConfig; index?: string }) {
  return (
    <section id="about" className="section about">
      <div className="container">
        <div className="section-head">
          {index && (
            <Reveal as="span" className="section-index" variant="fade">
              {index}
            </Reveal>
          )}
          <Reveal as="h2" className="section-title" variant="up" delay={80}>
            {data.heading}
          </Reveal>
        </div>
        <ul className="about-lines">
          {data.body.map((line, i) => (
            <Reveal as="li" className="about-line" key={i} variant="up" delay={120 * i}>
              {renderEmphasis(line)}
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
