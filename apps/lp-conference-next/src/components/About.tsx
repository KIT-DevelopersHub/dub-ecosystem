import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { renderEmphasis } from "@/lib/markup";
import type { AboutConfig } from "@/config/types";

// About — reproduces goodpatch's 3-column "card row" skeleton (as used for the
// interview / activities blocks): a media top, an index, a headline, and a
// tag-style label per card, revealed with a staggered fade-up. Filled with the
// conference's 3 "とは？" points and original gradient media (no photos copied).
const TAGS = ["#次世代エンジニア", "#出会いの場", "#技術コミュニティ"];

export function About({ data, index }: { data: AboutConfig; index?: string }) {
  return (
    <section id="about" className="section cards">
      <div className="container">
        <SectionHead eyebrow="ABOUT" index={index} title={data.heading} />
        <ul className="cards-grid">
          {data.body.map((line, i) => (
            <Reveal as="li" className="info-card" key={i} variant="up" delay={110 * i}>
              <span className={`info-card-media info-card-media--${i + 1}`} aria-hidden="true">
                <span className="info-card-idx">{String(i + 1).padStart(2, "0")}</span>
              </span>
              <div className="info-card-body">
                <p className="info-card-headline">{renderEmphasis(line)}</p>
                {TAGS[i] && <span className="info-card-tag">{TAGS[i]}</span>}
              </div>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
