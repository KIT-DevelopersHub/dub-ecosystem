import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import type { ApplyConfig } from "@/config/types";
import { JOIN_TICKETS_HREF, JOIN_TICKETS_LABEL } from "@/lib/join-tickets";

// Apply — reproduces goodpatch's "dual service cards" skeleton: equal-width
// cards side-by-side (参加者 / 登壇 / スポンサー), each with an icon (top), a heading, description, and a
// "View Details"-style arrow CTA. Filled with the conference's participant /
// speaker / sponsor copy and original inline-SVG icons (no goodpatch assets).
export function Apply({ data, index }: { data: ApplyConfig; index?: string }) {
  return (
    <section id="apply" className="section svc">
      <div className="container">
        <SectionHead eyebrow="JOIN" index={index} title={data.heading} />
        <div className={`svc-grid${data.sponsor ? " svc-grid--3" : ""}`}>
          {/* 受付未開始のカードは押せない disabled 状態で「準備中」を明示する。
              参加者だけはチケット販売の設定で購入リンクに切り替わる（lib/join-tickets.ts）。 */}
          <ServiceCard
            variant="participant"
            icon={<IconTicket />}
            title={data.participant.title}
            body={data.participant.body}
            cta={{ label: data.participant.cta.label, href: data.participant.cta.href }}
            disabled
            ticketsCta={{ label: JOIN_TICKETS_LABEL, href: JOIN_TICKETS_HREF }}
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
          {data.sponsor && (
            <ServiceCard
              variant="sponsor"
              icon={<IconHandshake />}
              title={data.sponsor.title}
              body={data.sponsor.body}
              cta={{ label: data.sponsor.cta.label, href: data.sponsor.cta.href }}
              disabled
              delay={240}
            />
          )}
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
  ticketsCta,
  delay,
}: {
  variant: "participant" | "speaker" | "sponsor";
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: { label: string; href: string };
  disabled?: boolean;
  /** 販売 on のとき disabled の代わりに見せるリンク（html[data-lp-join-tickets="on"] で CSS が切り替え）。 */
  ticketsCta?: { label: string; href: string };
  delay: number;
}) {
  const label = cta.label.replace(/\n/g, "");
  const inner = (off: boolean, ctaLabel: string) => (
    <>
      <span className={`svc-icon svc-icon--${variant}`} aria-hidden="true">
        {icon}
      </span>
      <h3 className="svc-card-title">{title}</h3>
      <p className="svc-card-body">{body}</p>
      {off ? (
        <span className="svc-card-cta svc-card-cta--disabled">
          <span className="svc-card-badge">準備中</span>
          <span className="svc-card-soon">受付開始までお待ちください</span>
        </span>
      ) : (
        <span className="svc-card-cta">
          {ctaLabel}
          <span className="arrow" aria-hidden="true">→</span>
        </span>
      )}
    </>
  );
  return (
    <Reveal className={`svc-card svc-card--${variant}`} variant="up" delay={delay}>
      {disabled ? (
        <div
          className={`svc-card-link is-disabled${ticketsCta ? " svc-card-alt--off" : ""}`}
          aria-disabled="true"
          aria-label={`${label}（準備中）`}
        >
          {inner(true, label)}
        </div>
      ) : (
        <a className="svc-card-link" href={cta.href} aria-label={label}>
          {inner(false, label)}
        </a>
      )}
      {disabled && ticketsCta && (
        <a className="svc-card-link svc-card-alt--on" href={ticketsCta.href} aria-label={ticketsCta.label}>
          {inner(false, ticketsCta.label)}
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
function IconHandshake() {
  return (
    <svg {...svgCommon}>
      <path d="m11 17 2 2a1 1 0 1 0 3-3" />
      <path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4" />
      <path d="m21 3 1 11h-2" />
      <path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3" />
      <path d="M3 4h8" />
    </svg>
  );
}
