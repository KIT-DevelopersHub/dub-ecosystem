import { Reveal } from "@/components/Reveal";
import type { CatchConfig } from "@/config/types";

export function Catch({ data }: { data: CatchConfig }) {
  return (
    <section className="catch">
      <div className="container">
        <Reveal as="p" className="catch-lead">
          {data.lead}
        </Reveal>
        <Reveal as="p" className="catch-heading" delay={0.08}>
          {data.heading}
        </Reveal>
      </div>
    </section>
  );
}
