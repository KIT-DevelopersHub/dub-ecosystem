import { Reveal } from "@/components/Reveal";
import type { CrowdfundingConfig } from "@/config/types";

// Crowdfunding — a focused call-to-support panel with numbered eyebrow.
export function Crowdfunding({ data, index }: { data: CrowdfundingConfig; index?: string }) {
  return (
    <section id="crowdfunding" className="section crowdfunding">
      <div className="container">
        <div className="crowd-panel">
          <div className="section-head section-head--center">
            {index && (
              <Reveal as="span" className="section-index" variant="fade">
                {index}
              </Reveal>
            )}
            <Reveal as="h2" className="section-title" variant="up" delay={80}>
              {data.heading}
            </Reveal>
            <Reveal as="p" className="section-lead" variant="up" delay={160}>
              {data.body}
            </Reveal>
          </div>
          {data.cta && (
            <Reveal className="crowd-actions" variant="up" delay={220}>
              <a className="btn-crowd" href={data.cta.href}>
                {data.cta.label}
              </a>
            </Reveal>
          )}
        </div>
      </div>
    </section>
  );
}
