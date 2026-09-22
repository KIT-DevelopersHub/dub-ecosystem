import { Reveal } from "@/components/Reveal";

// Vision — reproduces goodpatch's "Company Vision" skeleton: a large left-aligned
// statement over a decorative repeating-circle background. Filled with the
// conference's catch statement; the signature 蜃気楼(haze) reveal is applied to
// the statement so it stays gently hazed low in the viewport and sharpens as it
// rises. All background art is original CSS.
export function Vision({
  eyebrow,
  statement,
  index,
}: {
  eyebrow: string;
  statement: string;
  index?: string;
}) {
  return (
    <section className="vision">
      <div className="vision-rings" aria-hidden="true" data-parallax="-70" />
      <div className="container vision-inner">
        <Reveal as="span" className="section-eyebrow" variant="fade">
          {index && <span className="section-eyebrow-idx">{index}</span>}
          {eyebrow}
        </Reveal>
        <Reveal as="p" className="vision-statement" variant="haze">
          {statement}
        </Reveal>
      </div>
    </section>
  );
}
