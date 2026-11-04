import { Reveal } from "@/components/Reveal";
import type { CrowdfundingConfig, CrowdfundingSupporters, CtaLink } from "@/config/types";

// Crowdfunding — reproduces goodpatch's full-width colored "special / callout"
// band skeleton: a saturated brand-gradient band with floating decorative
// shapes, an eyebrow, a large statement, and a single CTA. Filled with the
// conference's crowdfunding copy; all shapes are original CSS (no goodpatch art).
//
// パターン（LP管理の公開設定 crowdfunding.options.pattern）: 「現状のページ」（帯）と「支援者情報」を
// 同じ <section id="crowdfunding"> の中に両方描き、<html> の data-lp-o-crowdfunding-pattern で片方だけ見せる。
// 支援者情報のデータが無い版では帯だけを描く（パターンを切り替えても消えない）。
export function Crowdfunding({ data, index }: { data: CrowdfundingConfig; index?: string }) {
  const supporters = data.supporters;
  return (
    <section id="crowdfunding" className="support">
      <div
        className="support-band"
        {...(supporters ? { "data-lp-opt": "crowdfunding-pattern", "data-lp-opt-value": "current" } : {})}
      >
        <span className="support-shape support-shape--a" aria-hidden="true" data-parallax="90" />
        <span className="support-shape support-shape--b" aria-hidden="true" data-parallax="-110" />
        <span className="support-shape support-shape--c" aria-hidden="true" data-parallax="60" />
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
              <SupportCta cta={data.cta} />
            </Reveal>
          )}
        </div>
      </div>
      {supporters && <Supporters data={supporters} cta={data.cta} index={index} />}
    </section>
  );
}

function SupportCta({ cta, className = "btn-support" }: { cta: CtaLink; className?: string }) {
  const external = /^https?:\/\//.test(cta.href);
  return (
    <a
      className={className}
      href={cta.href}
      data-magnetic
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {cta.label}
      <span className="arrow" aria-hidden="true">{external ? "↗" : "→"}</span>
    </a>
  );
}

/** 「支援者情報」パターン: 支援してくださった方のお名前を並べる。 */
function Supporters({ data, cta, index }: { data: CrowdfundingSupporters; cta?: CtaLink; index?: string }) {
  return (
    <div className="supporters" data-lp-opt="crowdfunding-pattern" data-lp-opt-value="supporters">
      <div className="container supporters-inner">
        <Reveal as="span" className="section-eyebrow" variant="fade">
          {index && <span className="section-eyebrow-idx">{index}</span>}
          SUPPORTERS
        </Reveal>
        <Reveal as="h2" className="supporters-title" variant="up" delay={80}>
          {data.heading}
        </Reveal>
        <Reveal as="p" className="supporters-body" variant="up" delay={150}>
          {data.body}
        </Reveal>
        <Reveal variant="up" delay={200}>
          {data.names.length > 0 ? (
            <ul className="supporters-names">
              {data.names.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          ) : (
            <p className="supporters-empty">{data.emptyNote}</p>
          )}
        </Reveal>
        {cta && (
          <Reveal className="supporters-actions" variant="up" delay={240}>
            <SupportCta cta={cta} className="btn-support btn-support--onLight" />
          </Reveal>
        )}
      </div>
    </div>
  );
}
