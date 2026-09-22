import Image from "next/image";
import { Reveal } from "@/components/Reveal";
import type { ContactConfig } from "@/config/types";

// Contact — closing section: numbered eyebrow + logo/org card + a warm note.
export function Contact({ data, index }: { data: ContactConfig; index?: string }) {
  return (
    <section id="contact" className="section contact">
      <div className="container">
        <div className="section-head section-head--center">
          {index && (
            <Reveal as="span" className="section-index" variant="fade">
              {index}
            </Reveal>
          )}
          <Reveal as="h2" className="section-title" variant="up" delay={80}>
            {data.heading}
          </Reveal>
        </div>
        <Reveal className="contact-row" variant="up" delay={120}>
          <Image
            className="contact-logo"
            src="/img/contact-logo.png"
            alt="DevelopersHub ロゴ"
            width={262}
            height={228}
            loading="lazy"
          />
          <div className="contact-text">
            <p className="contact-org">{data.org}</p>
            <p className="contact-email">
              お問い合わせ：<a href={`mailto:${data.email}`}>{data.email}</a>
            </p>
          </div>
        </Reveal>
        <Reveal as="p" className="contact-note" variant="fade" delay={200}>
          {data.note}
        </Reveal>
      </div>
    </section>
  );
}
