import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import type { ApplyConfig } from "@/config/types";

// Apply — reproduces goodpatch's "dual service cards" skeleton: two equal-width
// cards side-by-side, each with an icon (top), a heading, description, and a
// "View Details"-style arrow CTA. Filled with the conference's participant /
// speaker copy and original inline-SVG icons (no goodpatch assets).
export function Apply({ data, index }: { data: ApplyConfig; index?: string }) {
  return (
    <section id="apply" className="section svc">
      <div className="container">
        <SectionHead eyebrow="JOIN" index={index} title={data.heading} />
        <div className="svc-grid">
          {/* 受付未開始 — 参加登録 / 登壇応募のフォームはまだ公開していないため、
              両カードとも押せない disabled 状態で「準備中」を明示する。 */}
          <ServiceCard
            variant="participant"
            icon={<IconTicket />}
            title={data.participant.title}
            body={data.participant.body}
            cta={{ label: data.participant.cta.label, href: data.participant.cta.href }}
            disabled
            delay={0}
          />
          <ServiceCard
            variant="speaker"
            icon={<IconMic />}
            title={data.speaker.title}
            body={data.speaker.body}
            cta={{ label: data.speaker.cta.label, href: data.speaker.cta.href }}
            disabled
            delay={120}
          />
        </div>
      </div>
    </section>
  );
}

function ServiceCard({
  variant,
  icon,
  title,
  body,
  cta,
  disabled = false,
  delay,
}: {
  variant: "participant" | "speaker";
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: { label: string; href: string };
  disabled?: boolean;
  delay: number;
}) {
  const label = cta.label.replace(/\n/g, "");
  const inner = (
    <>
      <span className={`svc-icon svc-icon--${variant}`} aria-hidden="true">
        {icon}
      </span>
      <h3 className="svc-card-title">{title}</h3>
      <p className="svc-card-body">{body}</p>
      {disabled ? (
        <span className="svc-card-cta svc-card-cta--disabled">
          <span className="svc-card-badge">準備中</span>
          <span className="svc-card-soon">受付開始までお待ちください</span>
        </span>
      ) : (
        <span className="svc-card-cta">
          {label}
          <span className="arrow" aria-hidden="true">→</span>
        </span>
      )}
    </>
  );
  return (
    <Reveal className={`svc-card svc-card--${variant}`} variant="up" delay={delay}>
      {disabled ? (
        <div className="svc-card-link is-disabled" aria-disabled="true" aria-label={`${label}（準備中）`}>
          {inner}
        </div>
      ) : (
        <a className="svc-card-link" href={cta.href} aria-label={label}>
          {inner}
        </a>
      )}
    </Reveal>
  );
}

const svgCommon = {
  width: 26,
  height: 26,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function IconTicket() {
  return (
    <svg {...svgCommon}>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h15A1.5 1.5 0 0 1 21 8.5v2a2 2 0 0 0 0 4v2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-2a2 2 0 0 0 0-4v-2Z" />
      <path d="M14 7v10" strokeDasharray="1.5 2.4" />
    </svg>
  );
}
function IconMic() {
  return (
    <svg {...svgCommon}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </svg>
  );
}
