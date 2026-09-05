import { Reveal } from "@/components/Reveal";
import type { CrowdfundingConfig } from "@/config/types";

export function Crowdfunding({ data }: { data: CrowdfundingConfig }) {
  return (
    <section id="crowdfunding" className="section crowdfunding section-center">
      <div className="container">
        <Reveal as="h2" className="section-title">
          {data.heading}
        </Reveal>
        <Reveal as="p" className="section-lead" delay={0.08}>
          {data.body}
        </Reveal>
        {data.cta && (
          <Reveal as="p" className="crowd-actions" delay={0.12}>
            <a className="btn-crowd" href={data.cta.href}>
              {data.cta.label}
            </a>
          </Reveal>
        )}
      </div>
    </section>
  );
}
