"use client";

import { Handshake } from "@/components/Handshake";
import { useScrollScene } from "@/lib/useScrollScene";
import type { ClosingConfig } from "@/config/types";

// CLOSING — 北陸の握手が波紋のように全国へ広がる終幕。参加の呼びかけ（CTA）で締める。
export function Closing({ data }: { data: ClosingConfig }) {
  const { ref, entered } = useScrollScene<HTMLElement>({ rest: 1 });
  const oneLine = (s: string) => s.replace(/\n/g, "");

  return (
    <section
      id="closing"
      ref={ref}
      className={["closing", entered ? "is-in" : ""].filter(Boolean).join(" ")}
    >
      <div className="closing-visual" aria-hidden="true">
        <Handshake variant="national" />
      </div>
      <div className="container closing-inner">
        <p className="closing-kicker">{data.kicker}</p>
        <h2 className="closing-title">{data.title}</h2>
        <p className="closing-lead">{data.lead}</p>
        <div className="closing-ctas hero-ctas">
          {data.primaryCta && (
            <a
              className="hero-cta hero-cta--participant"
              href={data.primaryCta.href}
              aria-label={oneLine(data.primaryCta.label)}
            >
              {data.primaryCta.label}
              <span className="hero-cta-arrow" aria-hidden="true">→</span>
            </a>
          )}
          {data.secondaryCta && (
            <a
              className="hero-cta hero-cta--speaker closing-cta--ghost"
              href={data.secondaryCta.href}
              aria-label={oneLine(data.secondaryCta.label)}
            >
              {data.secondaryCta.label}
              <span className="hero-cta-arrow" aria-hidden="true">→</span>
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
