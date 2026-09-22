import { Reveal } from "@/components/Reveal";
import type { ReactNode } from "react";

// Shared section header — goodpatch grammar: a GIANT English word dominates the
// head (like goodpatch's "Featured Work" / "Company"), with the Japanese heading
// as a strong subtitle beneath and an optional oversized ghost/outline word set
// behind for depth. Left-aligned by default; `center` mirrors goodpatch's
// centered heads (CTA bands); `light` flips the type white for dark/blue blocks.
export function SectionHead({
  eyebrow,
  index,
  title,
  lead,
  center,
  light,
  ghost,
}: {
  eyebrow: string;
  index?: string;
  title: ReactNode;
  lead?: ReactNode;
  center?: boolean;
  light?: boolean;
  /** oversized outline word set behind the head (defaults to `eyebrow`). */
  ghost?: string;
}) {
  const cls = [
    "section-head",
    center ? "section-head--center" : "",
    light ? "section-head--light" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const ghostWord = ghost ?? eyebrow;
  return (
    <div className={cls}>
      <div className="section-head-stack">
        {ghostWord && (
          <span className="section-ghost" aria-hidden="true">
            {ghostWord}
          </span>
        )}
        <Reveal as="h2" className="section-title" variant="up">
          <span className="section-title-en" data-line>
            {index && <span className="section-title-idx">{index}</span>}
            {eyebrow}
          </span>
          <span className="section-title-jp">{title}</span>
        </Reveal>
      </div>
      {lead && (
        <Reveal as="p" className="section-lead" variant="up" delay={150}>
          {lead}
        </Reveal>
      )}
    </div>
  );
}
