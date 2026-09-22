import { Reveal } from "@/components/Reveal";
import type { CrowdfundingConfig } from "@/config/types";

// Crowdfunding — reproduces goodpatch's full-width colored "special / callout"
// band skeleton: a saturated brand-gradient band with floating decorative
// shapes, an eyebrow, a large statement, and a single CTA. Filled with the
// conference's crowdfunding copy; all shapes are original CSS (no goodpatch art).
export function Crowdfunding({ data, index }: { data: CrowdfundingConfig; index?: string }) {
  return (
    <section id="crowdfunding" className="support">
      <div className="support-band">
        <span className="support-shape support-shape--a" aria-hidden="true" />
        <span className="support-shape support-shape--b" aria-hidden="true" />
        <span className="support-shape support-shape--c" aria-hidden="true" />
        <div className="container support-inner">
          <Reveal as="span" className="section-eyebrow section-eyebrow--onDark" variant="fade">
            {index && <span className="section-eyebrow-idx">{index}</span>}
            SUPPORT
          </Reveal>
          <Reveal as="h2" className="support-title" variant="up" delay={80}>
            {data.heading}
          </Reveal>
          <Reveal as="p" className="support-body" variant="up" delay={150}>
            {data.body}
          </Reveal>
          {data.cta && (
            <Reveal className="support-actions" variant="up" delay={220}>
              <a className="btn-support" href={data.cta.href}>
                {data.cta.label}
                <span className="arrow" aria-hidden="true">→</span>
              </a>
            </Reveal>
          )}
        </div>
      </div>
    </section>
  );
}
