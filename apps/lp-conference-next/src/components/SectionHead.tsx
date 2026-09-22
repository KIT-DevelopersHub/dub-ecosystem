import { Reveal } from "@/components/Reveal";
import type { ReactNode } from "react";

// Shared section header — reproduces goodpatch's section-head grammar:
// an English eyebrow label (optionally prefixed with a numeric index) above a
// large heading, with an optional lead paragraph. Left-aligned by default;
// `center` mirrors goodpatch's centered heads (vision / CTA bands).
export function SectionHead({
  eyebrow,
  index,
  title,
  lead,
  center,
  light,
}: {
  eyebrow: string;
  index?: string;
  title: ReactNode;
  lead?: ReactNode;
  center?: boolean;
  light?: boolean;
}) {
  const cls = [
    "section-head",
    center ? "section-head--center" : "",
    light ? "section-head--light" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <Reveal as="span" className="section-eyebrow section-eyebrow--line" variant="fade" data-line>
        {index && <span className="section-eyebrow-idx">{index}</span>}
        {eyebrow}
      </Reveal>
      <Reveal as="h2" className="section-title" variant="up" delay={80}>
        {title}
      </Reveal>
      {lead && (
        <Reveal as="p" className="section-lead" variant="up" delay={150}>
          {lead}
        </Reveal>
      )}
    </div>
  );
}
