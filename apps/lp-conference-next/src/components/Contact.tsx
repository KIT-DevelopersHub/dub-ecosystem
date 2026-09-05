import Image from "next/image";
import { Reveal } from "@/components/Reveal";
import type { ContactConfig } from "@/config/types";

export function Contact({ data }: { data: ContactConfig }) {
  return (
    <section id="contact" className="section contact section-center">
      <div className="container">
        <Reveal as="h2" className="section-title">
          {data.heading}
        </Reveal>
        <Reveal className="contact-row" delay={0.08}>
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
        <Reveal as="p" className="contact-note" delay={0.12}>
          {data.note}
        </Reveal>
      </div>
    </section>
  );
}
