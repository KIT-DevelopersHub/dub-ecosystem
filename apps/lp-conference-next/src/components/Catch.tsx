import { Reveal } from "@/components/Reveal";
import type { CatchConfig } from "@/config/types";

// Catch band — the big statement bridging hero → sections. Oversized display
// type with a clean staggered reveal (goodpatch-style confident opener line).
export function Catch({ data }: { data: CatchConfig }) {
  return (
    <section className="catch">
      <div className="container">
        <Reveal as="p" className="catch-lead" variant="fade">
          {data.lead}
        </Reveal>
        {/* signature 蜃気楼(haze): the big statement stays gently hazed low in
            the viewport and sharpens as it rises — the v3 mirage, integrated at
            the hero→content seam of the new composition. */}
        <Reveal as="p" className="catch-heading" variant="haze">
          {data.heading}
        </Reveal>
      </div>
    </section>
  );
}
