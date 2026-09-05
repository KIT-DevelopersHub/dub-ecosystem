import { Reveal } from "@/components/Reveal";
import { renderEmphasis } from "@/lib/markup";
import type { AboutConfig } from "@/config/types";

export function About({ data }: { data: AboutConfig }) {
  return (
    <section id="about" className="section about section-center">
      <div className="container">
        <Reveal as="h2" className="section-title">
          {data.heading}
        </Reveal>
        <ul className="about-lines">
          {data.body.map((line, i) => (
            <Reveal as="li" className="about-line" key={i} delay={0.09 * (i + 1)}>
              {renderEmphasis(line)}
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
