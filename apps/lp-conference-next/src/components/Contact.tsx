import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import type { ContactConfig } from "@/config/types";

// Contact — reproduces goodpatch's "Get In Touch" CTA-band skeleton: a centered
// eyebrow + large heading over a light band, then a horizontal row of equal
// button CTAs, with a closing note. Filled with the conference's contact copy;
// buttons route to the conference's own mail / apply / official site.
export function Contact({
  data,
  index,
  applyHref = "#apply",
  siteUrl,
}: {
  data: ContactConfig;
  index?: string;
  applyHref?: string;
  siteUrl?: string;
}) {
  return (
    <section id="contact" className="section getintouch">
      <div className="container">
        <SectionHead eyebrow="CONTACT" index={index} title={data.heading} center />

        <Reveal as="p" className="git-org" variant="fade" delay={60}>
          {data.org}
        </Reveal>

        <Reveal className="git-actions" variant="up" delay={120}>
          <a className="git-btn git-btn--primary" href={applyHref}>
            <span className="git-btn-en">JOIN</span>
            <span className="git-btn-jp">参加登録はこちら</span>
            <span className="arrow" aria-hidden="true">→</span>
          </a>
          <a className="git-btn" href={`mailto:${data.email}`}>
            <span className="git-btn-en">MAIL</span>
            <span className="git-btn-jp">{data.email}</span>
            <span className="arrow" aria-hidden="true">→</span>
          </a>
          {siteUrl && (
            <a className="git-btn" href={siteUrl}>
              <span className="git-btn-en">SITE</span>
              <span className="git-btn-jp">公式サイト</span>
              <span className="arrow" aria-hidden="true">↗</span>
            </a>
          )}
        </Reveal>

        <Reveal as="p" className="git-note" variant="fade" delay={200}>
          {data.note}
        </Reveal>
      </div>
    </section>
  );
}
